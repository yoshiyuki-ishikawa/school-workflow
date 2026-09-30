import { getDb } from '../db/database';
import { getServerIsoString } from '../utils/serverTime';
import { logAudit } from '../utils/auditLogger';
import {
  resolveAuthoritativeWorkSchedule,
  calculateScheduleIntersectionMinutes
} from './attendance/workPatternResolver';

export interface CreateAbsenceParams {
  userId: number;
  absenceType: 'FULL_DAY' | 'HOURLY';
  targetDate: string;
  startTime?: string;
  endTime?: string;
  reason: string;
  status?: 'DRAFT' | 'CONFIRMED';
  actor: { id: number; username: string; displayName: string; ipAddress: string; userAgent?: string };
}

export interface UpdateAbsenceParams {
  id: number;
  absenceType?: 'FULL_DAY' | 'HOURLY';
  startTime?: string;
  endTime?: string;
  reason?: string;
  actor: { id: number; username: string; displayName: string; ipAddress: string; userAgent?: string };
}

export interface CorrectAbsenceParams {
  id: number;
  correctionTargetType: 'LEAVE_ANNUAL' | 'LEAVE_SICK' | 'LEAVE_SPECIAL' | 'LEAVE_DUTY_EXEMPT' | 'OTHER';
  correctedApplicationId?: number;
  correctionReason: string;
  actor: { id: number; username: string; displayName: string; ipAddress: string; userAgent?: string };
}

export class AbsenceService {
  /**
   * 欠勤新規登録 (管理職・事務限定)
   */
  static createAbsence(params: CreateAbsenceParams): number {
    const db = getDb();
    const now = getServerIsoString();
    const status = params.status || 'CONFIRMED';

    if (!params.userId || !params.absenceType || !params.targetDate || !params.reason) {
      throw new Error('必須項目が不足しています');
    }

    const workSchedule = resolveAuthoritativeWorkSchedule(params.userId, params.targetDate);
    if (workSchedule.isFailClosed || !workSchedule.isWorkDay) {
      throw new Error(`欠勤を登録できません: ${workSchedule.failReason || '非勤務日です'}`);
    }

    let durationMinutes = 0;

    if (params.absenceType === 'FULL_DAY') {
      durationMinutes = workSchedule.scheduledWorkMinutes || 0;
      if (durationMinutes <= 0) {
        throw new Error('所定勤務時間が0分の日は終日欠勤を登録できません');
      }
    } else {
      if (!params.startTime || !params.endTime) {
        throw new Error('時間欠勤には開始時刻と終了時刻が必要です');
      }
      durationMinutes = calculateScheduleIntersectionMinutes(params.startTime, params.endTime, workSchedule);
      if (durationMinutes <= 0) {
        throw new Error('指定された時間帯は勤務予定区間外です（欠勤時間が0分になります）');
      }
    }

    const confirmedBy = status === 'CONFIRMED' ? params.actor.id : null;

    const result = db.prepare(`
      INSERT INTO absences (
        user_id, absence_type, target_date, start_time, end_time, duration_minutes,
        reason, status, registered_by_user_id, confirmed_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.userId,
      params.absenceType,
      params.targetDate,
      params.startTime || null,
      params.endTime || null,
      durationMinutes,
      params.reason,
      status,
      params.actor.id,
      confirmedBy,
      now,
      now
    );

    const newId = Number(result.lastInsertRowid);

    logAudit({
      actorUserId: params.actor.id,
      actorUsername: params.actor.username,
      subjectUserId: params.userId,
      action: 'ABSENCE_CREATED',
      entityType: 'ABSENCE',
      entityId: String(newId),
      afterState: status,
      comment: `欠勤登録 [${params.absenceType}] 日付: ${params.targetDate} (${durationMinutes}分): ${params.reason}`,
      ipAddress: params.actor.ipAddress,
      userAgent: params.actor.userAgent,
    });

    return newId;
  }

  /**
   * 欠勤の更新
   */
  static updateAbsence(params: UpdateAbsenceParams): void {
    const db = getDb();
    const now = getServerIsoString();
    const current = db.prepare('SELECT * FROM absences WHERE id = ?').get(params.id) as any;
    if (!current) {
      throw new Error('対象の欠勤レコードが見つかりません');
    }

    if (current.status === 'CANCELLED' || current.status === 'CORRECTED') {
      throw new Error('取消済みまたは訂正済みの欠勤レコードは編集できません');
    }

    const absenceType = params.absenceType || current.absence_type;
    const startTime = params.startTime !== undefined ? params.startTime : current.start_time;
    const endTime = params.endTime !== undefined ? params.endTime : current.end_time;
    const reason = params.reason !== undefined ? params.reason : current.reason;

    const workSchedule = resolveAuthoritativeWorkSchedule(current.user_id, current.target_date);
    if (workSchedule.isFailClosed || !workSchedule.isWorkDay) {
      throw new Error(`欠勤を更新できません: ${workSchedule.failReason || '非勤務日です'}`);
    }
    let durationMinutes = 0;

    if (absenceType === 'FULL_DAY') {
      durationMinutes = workSchedule.scheduledWorkMinutes || 0;
      if (durationMinutes <= 0) {
        throw new Error('所定勤務時間が0分の日は終日欠勤を登録できません');
      }
    } else {
      durationMinutes = calculateScheduleIntersectionMinutes(startTime, endTime, workSchedule);
      if (durationMinutes <= 0) {
        throw new Error('指定された時間帯は勤務予定区間外です');
      }
    }

    db.prepare(`
      UPDATE absences
      SET absence_type = ?, start_time = ?, end_time = ?, duration_minutes = ?, reason = ?, updated_at = ?
      WHERE id = ?
    `).run(absenceType, startTime || null, endTime || null, durationMinutes, reason, now, params.id);

    logAudit({
      actorUserId: params.actor.id,
      actorUsername: params.actor.username,
      subjectUserId: current.user_id,
      action: 'ABSENCE_UPDATED',
      entityType: 'ABSENCE',
      entityId: String(params.id),
      beforeState: current.status,
      afterState: current.status,
      comment: `欠勤更新 [ID: ${params.id}] 理由: ${reason}`,
      ipAddress: params.actor.ipAddress,
      userAgent: params.actor.userAgent,
    });
  }

  /**
   * 欠勤の取消 (論理解除)
   */
  static cancelAbsence(id: number, cancelReason: string, actor: { id: number; username: string; displayName: string; ipAddress: string; userAgent?: string }): void {
    const db = getDb();
    const now = getServerIsoString();
    const current = db.prepare('SELECT * FROM absences WHERE id = ?').get(id) as any;
    if (!current) {
      throw new Error('対象の欠勤レコードが見つかりません');
    }

    if (current.status === 'CANCELLED') {
      throw new Error('既に取消されています');
    }

    db.prepare(`
      UPDATE absences
      SET status = 'CANCELLED', cancelled_by_user_id = ?, cancelled_at = ?, cancel_reason = ?, updated_at = ?
      WHERE id = ?
    `).run(actor.id, now, cancelReason || '管理職による解除', now, id);

    logAudit({
      actorUserId: actor.id,
      actorUsername: actor.username,
      subjectUserId: current.user_id,
      action: 'ABSENCE_CANCELLED',
      entityType: 'ABSENCE',
      entityId: String(id),
      beforeState: current.status,
      afterState: 'CANCELLED',
      comment: `欠勤取消 [ID: ${id}] 理由: ${cancelReason}`,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
  }

  /**
   * 欠勤から年休・病休等への事後訂正
   */
  static correctToLeave(params: CorrectAbsenceParams): void {
    const db = getDb();
    const now = getServerIsoString();
    const current = db.prepare('SELECT * FROM absences WHERE id = ?').get(params.id) as any;
    if (!current) {
      throw new Error('対象の欠勤レコードが見つかりません');
    }

    if (current.status !== 'CONFIRMED') {
      throw new Error('確定済みの欠勤レコードのみ事後訂正が可能です');
    }

    if (!params.correctionReason) {
      throw new Error('事後訂正の理由は必須です');
    }

    db.prepare(`
      UPDATE absences
      SET status = 'CORRECTED',
          correction_target_type = ?,
          corrected_application_id = ?,
          correction_reason = ?,
          corrected_by_user_id = ?,
          corrected_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      params.correctionTargetType,
      params.correctedApplicationId || null,
      params.correctionReason,
      params.actor.id,
      now,
      now,
      params.id
    );

    logAudit({
      actorUserId: params.actor.id,
      actorUsername: params.actor.username,
      subjectUserId: current.user_id,
      action: 'ABSENCE_CORRECTED_TO_LEAVE',
      entityType: 'ABSENCE',
      entityId: String(params.id),
      beforeState: 'CONFIRMED',
      afterState: 'CORRECTED',
      comment: `欠勤から事後訂正 [ID: ${params.id}] 訂正先: ${params.correctionTargetType} (申請ID: ${params.correctedApplicationId || 'なし'}): ${params.correctionReason}`,
      ipAddress: params.actor.ipAddress,
      userAgent: params.actor.userAgent,
    });
  }
}
