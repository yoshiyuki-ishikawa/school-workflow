import { getDb } from '../db/database';
import { getServerIsoString } from '../utils/serverTime';
import { logAudit } from '../utils/auditLogger';
import {
  SickLeaveApplicationRecord,
  SickLeaveDurationType,
  DisasterRecognitionStatus,
  SickLeaveApplicationStatus,
  AttendanceReevaluationStatus
} from '../types/sickLeave';
import { calculateWorkIntersectionMinutes } from './attendance/resolvers';
import { resolveAuthoritativeWorkSchedule } from './attendance/workPatternResolver';
import { SickLeavePolicyService } from './sickLeavePolicyService';

export interface SickLeaveUserContext {
  id: number;
  username: string;
  displayName: string;
  roles: string[];
  ipAddress: string;
  userAgent?: string;
}

export class SickLeaveService {
  /**
   * 病気休暇の新規申請 (Server-Authoritative な時間計算)
   */
  static applySickLeave(
    actor: SickLeaveUserContext,
    params: {
      targetDate: string;
      durationType: SickLeaveDurationType;
      startAt?: string;
      endAt?: string;
      policySpecificDurationCode?: string;
      reason?: string;
      evidenceRequired?: boolean;
    }
  ) {
    const db = getDb();
    const now = getServerIsoString();
    const applicationId = `SICK_${actor.id}_${params.targetDate.replace(/-/g, '')}_${Date.now()}`;

    // 1. 勤務割振りと交差時間の計算 (Server-Authoritative)
    let calculatedMinutes = 0;
    if (params.durationType === 'FULL_DAY') {
      const authoritativeSchedule = resolveAuthoritativeWorkSchedule(actor.id, params.targetDate);
      if (
        authoritativeSchedule.isFailClosed ||
        !authoritativeSchedule.isWorkDay ||
        !authoritativeSchedule.scheduledWorkMinutes ||
        authoritativeSchedule.scheduledWorkMinutes <= 0
      ) {
        throw new Error(
          `指定日は勤務日ではないか、勤務スケジュールが確定していません (${authoritativeSchedule.failReason || '非勤務日または所定時間不正'})`
        );
      }
      calculatedMinutes = authoritativeSchedule.scheduledWorkMinutes;
    } else if (params.durationType === 'TIME') {
      if (!params.startAt || !params.endAt) {
        throw new Error('時間単位病休には開始時刻と終了時刻が必要です');
      }
      if (params.startAt >= params.endAt) {
        throw new Error('開始時刻は終了時刻より前である必要があります');
      }

      // 勤務パターン取得 (Canonical SSOT: resolveAuthoritativeWorkSchedule)
      const authoritativeSchedule = resolveAuthoritativeWorkSchedule(actor.id, params.targetDate);
      if (authoritativeSchedule.isFailClosed || !authoritativeSchedule.isWorkDay) {
        throw new Error(`指定日は勤務日ではないか、勤務スケジュールが確定していません (${authoritativeSchedule.failReason || '非勤務日'})`);
      }

      const workSchedule = {
        isWorkDay: authoritativeSchedule.isWorkDay,
        patternType: authoritativeSchedule.patternType || 'STANDARD_FULLTIME',
        workMinutes: authoritativeSchedule.scheduledWorkMinutes || 0,
        schedule: authoritativeSchedule.schedule || null
      };

      calculatedMinutes = calculateWorkIntersectionMinutes(params.startAt, params.endAt, workSchedule);
      if (calculatedMinutes <= 0) {
        throw new Error('勤務時間帯と重複する病休時間が存在しません (0分)');
      }
    }

    // 2. DBへ保存
    db.prepare(`
      INSERT INTO sick_leave_applications (
        id, user_id, target_date, duration_type, policy_specific_duration_code,
        start_at, end_at, calculated_minutes, legal_basis_id, applied_policy_version,
        application_status, disaster_recognition_status, reevaluation_status,
        evidence_requirement, evidence_status, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'YAMAGUCHI_WORK_ORDINANCE_ART13', '2026.1', 'SUBMITTED', 'NONE', 'NOT_REQUIRED', ?, 'NOT_SUBMITTED', 1, ?, ?)
    `).run(
      applicationId,
      actor.id,
      params.targetDate,
      params.durationType,
      params.policySpecificDurationCode || null,
      params.startAt || null,
      params.endAt || null,
      calculatedMinutes,
      params.evidenceRequired ? 'REQUIRED' : 'NOT_REQUIRED',
      now,
      now
    );

    logAudit({
      actorUserId: actor.id,
      actorUsername: actor.username,
      subjectUserId: actor.id,
      roleSnapshot: actor.roles.join(','),
      action: 'APPLICATION_CREATED',
      entityType: 'SICK_LEAVE',
      entityId: applicationId,
      afterState: 'SUBMITTED',
      comment: `病気休暇申請提出 (日付: ${params.targetDate}, 単位: ${params.durationType}, 分数: ${calculatedMinutes}分)`,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    });

    return { id: applicationId, calculatedMinutes };
  }

  /**
   * 決裁承認＆出勤簿レコード確定 (Idempotency保証)
   */
  static approveSickLeave(
    actor: SickLeaveUserContext,
    sickLeaveId: string
  ) {
    const db = getDb();
    const now = getServerIsoString();

    const runTx = db.transaction(() => {
      const row = db.prepare('SELECT * FROM sick_leave_applications WHERE id = ?').get(sickLeaveId) as any;
      if (!row) {
        throw new Error('対象の病気休暇申請が存在しません');
      }

      // 権限確認: 管理職のみ
      const canApprove = actor.roles.some((r) => ['VICE_PRINCIPAL', 'PRINCIPAL', 'ADMIN'].includes(r));
      if (!canApprove) {
        throw new Error('病気休暇の承認権限がありません');
      }

      // 1. 申請ステータスを APPROVED へ更新
      db.prepare(`
        UPDATE sick_leave_applications
        SET application_status = 'APPROVED', updated_at = ?, version = version + 1
        WHERE id = ?
      `).run(now, sickLeaveId);

      // 2. 出勤簿レコードの確定生成 (Display Policy 解決 - Fail-Closed)
      const display = SickLeavePolicyService.resolveDisplayPolicy(
        row.target_date,
        row.duration_type,
        row.disaster_recognition_status,
        row.calculated_minutes,
        row.policy_specific_duration_code
      );

      if (display.isFailClosed) {
        throw new Error(`出勤簿表示Policy未定義のため確定できません (Fail-Closed: ${display.failReason})`);
      }

      const attRecordId = `ATT_${row.user_id}_${row.target_date.replace(/-/g, '')}_SICK`;

      // 冪等性保証: INSERT OR REPLACE
      db.prepare(`
        INSERT OR REPLACE INTO attendance_records (
          id, user_id, target_date, source_application_id,
          service_status_type, display_text, effective_minutes,
          policy_version_applied, is_locked, updated_at
        ) VALUES (?, ?, ?, ?, 'SICK_LEAVE', ?, ?, '2026.1', 0, ?)
      `).run(
        attRecordId,
        row.user_id,
        row.target_date,
        row.application_id || null,
        display.displayText,
        row.calculated_minutes,
        now
      );

      return { userId: row.user_id, targetDate: row.target_date, displayText: display.displayText };
    });

    const result = runTx();

    logAudit({
      actorUserId: actor.id,
      actorUsername: actor.username,
      subjectUserId: result.userId,
      roleSnapshot: actor.roles.join(','),
      action: 'APPLICATION_APPROVED',
      entityType: 'SICK_LEAVE',
      entityId: sickLeaveId,
      afterState: 'APPROVED',
      comment: `病気休暇決裁承認 ＆ 出勤簿確定 (印字: ${result.displayText})`,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    });

    return result;
  }

  /**
   * 後日公務災害・通勤災害認定ステータス更新 ＆ 出勤簿再評価
   */
  static updateDisasterRecognition(
    actor: SickLeaveUserContext,
    params: {
      sickLeaveId: string;
      newStatus: DisasterRecognitionStatus;
      authority?: string;
      reference?: string;
    }
  ) {
    const db = getDb();
    const now = getServerIsoString();

    const runTx = db.transaction(() => {
      const row = db.prepare('SELECT * FROM sick_leave_applications WHERE id = ?').get(params.sickLeaveId) as any;
      if (!row) {
        throw new Error('対象の病気休暇申請が存在しません');
      }

      // 権限確認: PRINCIPAL, OFFICE, ADMIN
      const canUpdate = actor.roles.some((r) => ['PRINCIPAL', 'OFFICE', 'ADMIN'].includes(r));
      if (!canUpdate) {
        throw new Error('災害認定ステータスの更新権限がありません');
      }

      // 1. 災害認定ステータス更新 & 再評価ステータスを PENDING に
      db.prepare(`
        UPDATE sick_leave_applications
        SET disaster_recognition_status = ?,
            disaster_recognized_at = ?,
            disaster_recognition_authority = ?,
            disaster_recognition_reference = ?,
            disaster_recognition_updated_at = ?,
            reevaluation_status = 'PENDING',
            updated_at = ?,
            version = version + 1
        WHERE id = ?
      `).run(
        params.newStatus,
        params.newStatus.includes('RECOGNIZED') ? now : null,
        params.authority || null,
        params.reference || null,
        now,
        now,
        params.sickLeaveId
      );

      // 2. 申請が APPROVED 済みであれば出勤簿レコードを再評価
      if (row.application_status === 'APPROVED') {
        const display = SickLeavePolicyService.resolveDisplayPolicy(
          row.target_date,
          row.duration_type,
          params.newStatus,
          row.calculated_minutes,
          row.policy_specific_duration_code
        );

        if (display.isFailClosed) {
          db.prepare("UPDATE sick_leave_applications SET reevaluation_status = 'FAILED' WHERE id = ?").run(params.sickLeaveId);
          throw new Error(`出勤簿再評価時Policy未定義のため停止 (Fail-Closed: ${display.failReason})`);
        }

        const attRecordId = `ATT_${row.user_id}_${row.target_date.replace(/-/g, '')}_SICK`;

        db.prepare(`
          INSERT OR REPLACE INTO attendance_records (
            id, user_id, target_date, source_application_id,
            service_status_type, display_text, effective_minutes,
            policy_version_applied, is_locked, updated_at
          ) VALUES (?, ?, ?, ?, 'SICK_LEAVE', ?, ?, '2026.1', 0, ?)
        `).run(
          attRecordId,
          row.user_id,
          row.target_date,
          row.application_id || null,
          display.displayText,
          row.calculated_minutes,
          now
        );

        db.prepare("UPDATE sick_leave_applications SET reevaluation_status = 'COMPLETED' WHERE id = ?").run(params.sickLeaveId);

        return { userId: row.user_id, reevaluated: true, displayText: display.displayText };
      }

      return { userId: row.user_id, reevaluated: false };
    });

    const res = runTx();

    logAudit({
      actorUserId: actor.id,
      actorUsername: actor.username,
      subjectUserId: res.userId,
      roleSnapshot: actor.roles.join(','),
      action: 'DISASTER_RECOGNITION_UPDATED',
      entityType: 'SICK_LEAVE',
      entityId: params.sickLeaveId,
      afterState: params.newStatus,
      comment: `公務災害認定状態更新: ${params.newStatus} (出勤簿再評価: ${res.reevaluated ? '完了' : '不要'})`,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    });

    return res;
  }

  /**
   * 【Original Wave 2B】病気休暇の決裁完了時 Canonical Finalization & Guarded Write-Once Snapshot 永続化
   */
  static finalizeSickLeaveApplication(applicationId: number, txDb?: any): void {
    const db = txDb || getDb();
    const now = getServerIsoString();

    // 1. applications レコード取得
    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(applicationId) as any;
    if (!app) {
      throw new Error(`対象の申請が存在しません (ID=${applicationId})`);
    }

    // 2. sick_leave_applications レコード取得 (存在する場合)
    const existingSickRow = db.prepare('SELECT * FROM sick_leave_applications WHERE application_id = ?').get(applicationId) as any;

    const appSnapRaw = app.final_calculation_snapshot;
    const sickSnapRaw = existingSickRow?.final_calculation_snapshot;

    // 3. HARD CONDITION: Snapshot Pair Consistency / Fail-Closed チェック
    if (appSnapRaw && sickSnapRaw) {
      // CASE B or CASE D: 両方存在
      try {
        const parsedApp = JSON.parse(appSnapRaw);
        const parsedSick = JSON.parse(sickSnapRaw);

        // Canonical Structured Comparison
        const isMatch =
          parsedApp.applicationCalendarSpanDays === parsedSick.applicationCalendarSpanDays &&
          parsedApp.consecutiveSickLeaveSpanDays === parsedSick.consecutiveSickLeaveSpanDays &&
          parsedApp.accumulatedSameDiseaseCalendarDaysAfter === parsedSick.accumulatedSameDiseaseCalendarDaysAfter &&
          parsedApp.diseaseContinuityDecision === parsedSick.diseaseContinuityDecision &&
          parsedApp.totalDutyExemptionMinutes === parsedSick.totalDutyExemptionMinutes;

        if (isMatch) {
          // CASE B: 同一確定内容 ➔ 冪等成功 (Write-Once: 上書きせず復帰)
          return;
        } else {
          // CASE D: 内容不一致 ➔ Fail-Closed (DATA_INCONSISTENCY)
          throw new Error(`[DATA_INCONSISTENCY] applications と sick_leave_applications のスナップショット内容が不一致です (applicationId=${applicationId})`);
        }
      } catch (e: any) {
        if (e.message?.includes('[DATA_INCONSISTENCY]')) throw e;
        throw new Error(`[DATA_INCONSISTENCY] スナップショットJSONのパースに失敗しました: ${e.message}`);
      }
    } else if (appSnapRaw && !sickSnapRaw) {
      // CASE C: 片方のみ存在 ➔ Fail-Closed
      throw new Error(`[DATA_INCONSISTENCY] applications にのみスナップショットが存在し、sick_leave_applications に存在しません (applicationId=${applicationId})`);
    } else if (!appSnapRaw && sickSnapRaw) {
      // CASE C: 片方のみ存在 ➔ Fail-Closed
      throw new Error(`[DATA_INCONSISTENCY] sick_leave_applications にのみスナップショットが存在し、applications に存在しません (applicationId=${applicationId})`);
    }

    // CASE A: 両方とも Snapshot なし ➔ 正常な初回 Finalization 実行
    // 4. form_data からパラメータ抽出 (Server-Authoritative)
    const formData = JSON.parse(app.form_data || '{}');
    const startDate = formData.startDate || formData.targetDate;
    const endDate = formData.endDate || startDate;
    if (!startDate || !endDate) {
      throw new Error(`病気休暇申請 (ID=${applicationId}) に開始日または終了日が指定されていません`);
    }

    const medicalCertificateAttached = Boolean(formData.medicalCertificateAttached);
    const diseaseContinuityDecision = formData.diseaseContinuityDecision || 'UNRESOLVED';

    // 5. 過去の有効承認区間取得 (CANCELLED は自動除外)
    const { SickLeaveRepository } = require('../repositories/sickLeaveRepository');
    const existingIntervals = SickLeaveRepository.getApprovedIntervals(app.subject_user_id, db);

    // 6. Server-Authoritative 再計算
    const { SickLeaveCalculator } = require('../domain/leave/sickLeaveCalculator');
    const calcResult = SickLeaveCalculator.calculate({
      userId: app.subject_user_id,
      startDate,
      endDate,
      medicalCertificateAttached,
      diseaseContinuityDecision,
      existingApprovedIntervals: existingIntervals
    });

    if (calcResult.isFailClosed || !calcResult.snapshot) {
      throw new Error(`病気休暇決裁計算エラー: ${calcResult.failReason || '計算に失敗しました'}`);
    }

    const snapshot = calcResult.snapshot;
    const snapshotJson = JSON.stringify(snapshot);

    // 7. applications テーブルへの Snapshot 永続化 (Write-Once)
    db.prepare(`
      UPDATE applications
      SET final_calculation_snapshot = ?, updated_at = ?
      WHERE id = ?
    `).run(snapshotJson, now, applicationId);

    // 8. sick_leave_applications テーブルへの Canonical カラム & Snapshot 永続化
    if (existingSickRow) {
      db.prepare(`
        UPDATE sick_leave_applications
        SET application_calendar_span_days = ?,
            consecutive_sick_leave_span_days = ?,
            accumulated_same_disease_calendar_days = ?,
            disease_continuity_decision = ?,
            final_calculation_snapshot = ?,
            application_status = 'APPROVED',
            calculated_minutes = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        snapshot.applicationCalendarSpanDays,
        snapshot.consecutiveSickLeaveSpanDays,
        snapshot.accumulatedSameDiseaseCalendarDaysAfter,
        snapshot.diseaseContinuityDecision,
        snapshotJson,
        snapshot.totalDutyExemptionMinutes,
        now,
        existingSickRow.id
      );
    } else {
      const sickId = `SICK_${app.subject_user_id}_${startDate.replace(/-/g, '')}_${Date.now()}`;
      db.prepare(`
        INSERT INTO sick_leave_applications (
          id, application_id, user_id, target_date, duration_type,
          calculated_minutes, legal_basis_id, applied_policy_version,
          application_status, application_calendar_span_days,
          consecutive_sick_leave_span_days, accumulated_same_disease_calendar_days,
          disease_continuity_decision, final_calculation_snapshot,
          created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, 'FULL_DAY',
          ?, 'YAMAGUCHI_WORK_ORDINANCE_ART13', '2026.1',
          'APPROVED', ?,
          ?, ?,
          ?, ?,
          ?, ?
        )
      `).run(
        sickId,
        applicationId,
        app.subject_user_id,
        startDate,
        snapshot.totalDutyExemptionMinutes,
        snapshot.applicationCalendarSpanDays,
        snapshot.consecutiveSickLeaveSpanDays,
        snapshot.accumulatedSameDiseaseCalendarDaysAfter,
        snapshot.diseaseContinuityDecision,
        snapshotJson,
        now,
        now
      );
    }
  }
}

