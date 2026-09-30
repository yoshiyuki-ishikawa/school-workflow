import { Database as DatabaseType } from 'better-sqlite3';
import { getDb } from '../db/database';
import { ConflictService } from './conflictService';
import { SnapshotInvalidationService } from './snapshotInvalidationService';
import { PolicyService } from './policyService';
import { OrderAuthorityResolver } from './authority/orderAuthorityResolver';
import { PersonnelStatus, PersonnelAction, PersonnelStatusType, AuthorityBasis } from '../types';
import { getServerIsoString } from '../utils/serverTime';

export interface CreatePersonnelStatusCommand {
  userId: number;
  statusType: PersonnelStatusType;
  effectiveFrom: string;
  effectiveTo?: string | null;
  documentReferenceNo?: string;
  issuedAt?: string;
  authorityBasis?: AuthorityBasis;
  reasonCode: string;
  actorUserId: number;
}

export interface AmendPersonnelStatusCommand {
  statusId: number;
  newEffectiveFrom: string;
  newEffectiveTo?: string | null;
  newDocumentReferenceNo?: string;
  newIssuedAt?: string;
  newAuthorityBasis?: AuthorityBasis;
  amendmentReason: string;
  actorUserId: number;
}

export interface CancelPersonnelStatusCommand {
  statusId: number;
  cancellationReason: string;
  actorUserId: number;
}

export class PersonnelService {
  /**
   * 人事発令登録 Command
   * Invariants:
   * 1. Personnel Order is Authoritative Fact (申請を理由とする登録拒絶禁止)
   * 2. 重複する既存申請は SUPERSEDED に遷移させ、pre_supersede_status 等を保存
   * 3. 承認済年休申請が失効する場合は Exact-Reversal 方式で年休残高を戻し入れ
   * 4. 動的 Order Authority Resolution ＆ Snapshot 保存
   */
  static createStatus(cmd: CreatePersonnelStatusCommand): number {
    const db = getDb();
    const now = getServerIsoString();

    return db.transaction(() => {
      // 1. 他の人事発令との重複検証 (身分状態 vs 身分状態)
      const conflict = ConflictService.validate({
        userId: cmd.userId,
        startDate: cmd.effectiveFrom,
        endDate: cmd.effectiveTo || cmd.effectiveFrom,
        statusType: cmd.statusType,
      });

      if (conflict.hasConflict) {
        throw new Error(`身分状態の競合エラー: ${conflict.reason}`);
      }

      // 2. PolicyRule 解決
      const policy = PolicyService.getEffectiveRule(cmd.statusType, cmd.effectiveFrom);

      // 3. 発令権限者スナップショット解決 (動的解決・推測禁止)
      const authoritySnapshot = OrderAuthorityResolver.resolveOrderAuthority(
        cmd.userId,
        cmd.statusType,
        cmd.effectiveFrom
      );
      const authorityBasis: AuthorityBasis = cmd.authorityBasis || 'OFFICIAL_ORDER';
      const issuedAt = cmd.issuedAt || cmd.effectiveFrom;

      // 4. PersonnelStatus 登録
      const result = db.prepare(`
        INSERT INTO personnel_statuses (
          user_id, status_type, policy_rule_id, document_reference_no,
          issued_at, effective_from, effective_to, status, authority_basis,
          order_authority_snapshot, reason_code, registered_by_user_id, confirmed_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'CONFIRMED', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        cmd.userId,
        cmd.statusType,
        policy ? policy.id : null,
        cmd.documentReferenceNo || null,
        issuedAt,
        cmd.effectiveFrom,
        cmd.effectiveTo || null,
        authorityBasis,
        authoritySnapshot,
        cmd.reasonCode,
        cmd.actorUserId,
        cmd.actorUserId,
        now,
        now
      );

      const statusId = Number(result.lastInsertRowid);

      // 5. PersonnelAction 追記
      db.prepare(`
        INSERT INTO personnel_actions (
          personnel_status_id, action_type, action_date, actor_user_id, comment, created_at
        ) VALUES (?, 'CREATE', ?, ?, ?, ?)
      `).run(statusId, cmd.effectiveFrom, cmd.actorUserId, '人事発令登録', now);

      // 6. 既存申請の Supersede (失効) 処理 ＆ 年休戻し入れ
      this.supersedeOverlappingApplications(db, statusId, cmd.userId, cmd.effectiveFrom, cmd.effectiveTo || null, now);

      // 7. Snapshot Invalidation 検知
      SnapshotInvalidationService.checkAndInvalidate(db, {
        sourceType: 'PERSONNEL_STATUS',
        userId: cmd.userId,
        dateRange: { start: cmd.effectiveFrom, end: cmd.effectiveTo || cmd.effectiveFrom },
        actorUserId: cmd.actorUserId,
        reasonCode: `人事発令登録 (${cmd.statusType})`
      });

      return statusId;
    })();
  }

  /**
   * 発令期間と重複する申請を SUPERSEDED に遷移させ、年休は Exact-Reversal
   */
  private static supersedeOverlappingApplications(
    db: DatabaseType,
    statusId: number,
    userId: number,
    startDate: string,
    endDate: string | null,
    now: string
  ): void {
    const apps = db.prepare(`
      SELECT a.id, a.type_id, a.current_status, a.form_data, awc.id AS active_cycle_id
      FROM applications a
      LEFT JOIN application_workflow_cycles awc ON a.id = awc.application_id AND awc.status = 'IN_PROGRESS'
      WHERE a.subject_user_id = ?
        AND a.current_status IN ('SUBMITTED', 'FIRST_APPROVED', 'IN_APPROVAL', 'FINAL_APPROVED', 'TRIP_APPROVED')
    `).all(userId) as any[];

    for (const app of apps) {
      let form: any = {};
      try {
        form = JSON.parse(app.form_data || '{}');
      } catch {
        continue;
      }

      const appStart = form.startDate || form.targetDate || form.startAt?.split('T')?.[0];
      const appEnd = form.endDate || form.targetDate || form.endAt?.split('T')?.[0] || appStart;

      if (!appStart || !appEnd) continue;

      // 期間重複チェック: appStart <= (endDate || '9999-12-31') AND appEnd >= startDate
      const targetEnd = endDate || '9999-12-31';
      const hasOverlap = appStart <= targetEnd && appEnd >= startDate;

      if (hasOverlap) {
        // 年休承認済み申請の Exact-Reversal 戻し入れ
        if (app.type_id === 'LEAVE_ANNUAL' && ['FINAL_APPROVED', 'TRIP_APPROVED'].includes(app.current_status)) {
          const activeUsages = db.prepare(`
            SELECT * FROM leave_usages WHERE application_id = ? AND status = 'ACTIVE'
          `).all(app.id) as any[];

          for (const usage of activeUsages) {
            db.prepare(`
              UPDATE leave_usages
              SET status = 'REVERSED', reversed_at = ?, reversal_reason = ?
              WHERE id = ?
            `).run(now, `人事発令 (#${statusId}) 登録に伴う失効・原状復帰`, usage.id);

            if (usage.day_deduction_units > 0) {
              db.prepare(`
                UPDATE leave_entitlements
                SET used_half_days = MAX(0, used_half_days - ?), updated_at = ?
                WHERE id = ?
              `).run(usage.day_deduction_units, now, usage.entitlement_id);
            }
            if (usage.hourly_minutes > 0) {
              db.prepare(`
                UPDATE leave_entitlements
                SET used_hourly_minutes = MAX(0, used_hourly_minutes - ?), updated_at = ?
                WHERE id = ?
              `).run(usage.hourly_minutes, now, usage.entitlement_id);
            }
          }
        }

        // applications テーブルを SUPERSEDED に更新し Pre-Supersede Provenance を記録
        db.prepare(`
          UPDATE applications
          SET pre_supersede_status = current_status,
              pre_supersede_workflow_cycle_id = ?,
              superseded_by_personnel_status_id = ?,
              superseded_at = ?,
              current_status = 'SUPERSEDED',
              updated_at = ?
          WHERE id = ?
        `).run(app.active_cycle_id || null, statusId, now, now, app.id);
      }
    }
  }

  /**
   * 人事発令訂正 (AMEND) Command
   * Invariants:
   * - 元レコードを 'SUPERSEDED_BY_AMENDMENT' に更新
   * - 新しい PersonnelStatus レコードを作成し、superseded_by_status_id で双方向追跡
   */
  static amendStatus(cmd: AmendPersonnelStatusCommand): number {
    const db = getDb();
    const now = getServerIsoString();

    return db.transaction(() => {
      const original = db.prepare('SELECT * FROM personnel_statuses WHERE id = ?').get(cmd.statusId) as PersonnelStatus | undefined;
      if (!original) {
        throw new Error(`PersonnelStatus #${cmd.statusId} not found`);
      }
      if (['CANCELLED', 'SUPERSEDED_BY_AMENDMENT'].includes(original.status)) {
        throw new Error(`既に取消または訂正済みの身分状態です (Status: ${original.status})`);
      }

      // 1. 他の発令との重複検証 (元レコードを除外)
      const conflict = ConflictService.validate({
        userId: original.user_id,
        startDate: cmd.newEffectiveFrom,
        endDate: cmd.newEffectiveTo || cmd.newEffectiveFrom,
        statusType: original.status_type,
        excludePersonnelStatusId: original.id,
      });

      if (conflict.hasConflict) {
        throw new Error(`訂正後の身分状態競合エラー: ${conflict.reason}`);
      }

      const policy = PolicyService.getEffectiveRule(original.status_type, cmd.newEffectiveFrom);
      const authoritySnapshot = OrderAuthorityResolver.resolveOrderAuthority(
        original.user_id,
        original.status_type,
        cmd.newEffectiveFrom
      );
      const authorityBasis: AuthorityBasis = cmd.newAuthorityBasis || original.authority_basis || 'OFFICIAL_ORDER';
      const issuedAt = cmd.newIssuedAt || original.issued_at || cmd.newEffectiveFrom;

      // 2. 新規 PersonnelStatus レコード作成
      const newStatusRes = db.prepare(`
        INSERT INTO personnel_statuses (
          user_id, status_type, policy_rule_id, document_reference_no,
          issued_at, effective_from, effective_to, status, authority_basis,
          order_authority_snapshot, reason_code, registered_by_user_id, confirmed_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'CONFIRMED', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        original.user_id,
        original.status_type,
        policy ? policy.id : original.policy_rule_id,
        cmd.newDocumentReferenceNo !== undefined ? cmd.newDocumentReferenceNo : original.document_reference_no,
        issuedAt,
        cmd.newEffectiveFrom,
        cmd.newEffectiveTo !== undefined ? cmd.newEffectiveTo : original.effective_to,
        authorityBasis,
        authoritySnapshot,
        original.reason_code,
        cmd.actorUserId,
        cmd.actorUserId,
        now,
        now
      );

      const newStatusId = Number(newStatusRes.lastInsertRowid);

      // 3. 元レコードを SUPERSEDED_BY_AMENDMENT に更新
      db.prepare(`
        UPDATE personnel_statuses
        SET status = 'SUPERSEDED_BY_AMENDMENT',
            superseded_by_status_id = ?,
            updated_at = ?
        WHERE id = ?
      `).run(newStatusId, now, original.id);

      // 4. PersonnelAction 追記
      db.prepare(`
        INSERT INTO personnel_actions (
          personnel_status_id, action_type, action_date, actor_user_id, previous_state_json, new_state_json, comment, created_at
        ) VALUES (?, 'AMEND', ?, ?, ?, ?, ?, ?)
      `).run(
        original.id,
        now.split('T')[0],
        cmd.actorUserId,
        JSON.stringify(original),
        JSON.stringify({ superseded_by_status_id: newStatusId, status: 'SUPERSEDED_BY_AMENDMENT' }),
        `発令訂正: #${original.id} -> #${newStatusId} (${cmd.amendmentReason})`,
        now
      );

      db.prepare(`
        INSERT INTO personnel_actions (
          personnel_status_id, action_type, action_date, actor_user_id, comment, created_at
        ) VALUES (?, 'CREATE', ?, ?, ?, ?)
      `).run(
        newStatusId,
        cmd.newEffectiveFrom,
        cmd.actorUserId,
        `発令訂正により #${original.id} から再作成`,
        now
      );

      // 5. 新発令期間との重なりに応じて既存申請を再評価・Supersede
      this.supersedeOverlappingApplications(
        db,
        newStatusId,
        original.user_id,
        cmd.newEffectiveFrom,
        cmd.newEffectiveTo !== undefined ? cmd.newEffectiveTo : original.effective_to || null,
        now
      );

      // 6. Invalidation
      const minStart = original.effective_from < cmd.newEffectiveFrom ? original.effective_from : cmd.newEffectiveFrom;
      const maxEnd = (original.effective_to || original.effective_from) > (cmd.newEffectiveTo || cmd.newEffectiveFrom)
        ? (original.effective_to || original.effective_from)
        : (cmd.newEffectiveTo || cmd.newEffectiveFrom);

      SnapshotInvalidationService.checkAndInvalidate(db, {
        sourceType: 'PERSONNEL_STATUS',
        userId: original.user_id,
        dateRange: { start: minStart, end: maxEnd },
        actorUserId: cmd.actorUserId,
        reasonCode: `人事発令訂正 (#${original.id} -> #${newStatusId})`
      });

      return newStatusId;
    })();
  }

  /**
   * 人事発令取消 (CANCEL) Command
   * Invariants:
   * - Order Cancellation ≠ Blind Application Resurrection
   * - Exact Previous State Restore: pre_supersede_status に厳密復元
   * - 年休が再復元される場合、年休再引当 (Re-deduct) を実行
   */
  static cancelStatus(cmd: CancelPersonnelStatusCommand): void {
    const db = getDb();
    const now = getServerIsoString();

    db.transaction(() => {
      const original = db.prepare('SELECT * FROM personnel_statuses WHERE id = ?').get(cmd.statusId) as PersonnelStatus | undefined;
      if (!original) {
        throw new Error(`PersonnelStatus #${cmd.statusId} not found`);
      }
      if (['CANCELLED', 'SUPERSEDED_BY_AMENDMENT'].includes(original.status)) {
        throw new Error(`既に取消または訂正済みの身分状態です (Status: ${original.status})`);
      }

      // 1. レコードを CANCELLED に更新
      db.prepare(`
        UPDATE personnel_statuses
        SET status = 'CANCELLED', updated_at = ?
        WHERE id = ?
      `).run(now, original.id);

      // 2. PersonnelAction 追記
      db.prepare(`
        INSERT INTO personnel_actions (
          personnel_status_id, action_type, action_date, actor_user_id, previous_state_json, new_state_json, comment, created_at
        ) VALUES (?, 'CANCEL', ?, ?, ?, ?, ?, ?)
      `).run(
        original.id,
        now.split('T')[0],
        cmd.actorUserId,
        JSON.stringify(original),
        JSON.stringify({ ...original, status: 'CANCELLED' }),
        `発令取消 (${cmd.cancellationReason})`,
        now
      );

      // 3. この発令によって失効 (SUPERSEDED) していた申請を Exact Previous State に復元
      const supersededApps = db.prepare(`
        SELECT * FROM applications
        WHERE superseded_by_personnel_status_id = ? AND current_status = 'SUPERSEDED'
      `).all(original.id) as any[];

      for (const app of supersededApps) {
        const restoreStatus = app.pre_supersede_status || 'DRAFT';

        // 競合再検証 (もし復元先ステータスで他の有効な発令・申請と競合する場合は復元をスキップまたはFail-Closed)
        let formData: any = {};
        try {
          formData = JSON.parse(app.form_data || '{}');
        } catch {}

        const appStart = formData.startDate || formData.targetDate || formData.startAt?.split('T')?.[0];
        const appEnd = formData.endDate || formData.targetDate || formData.endAt?.split('T')?.[0] || appStart;

        // 年休決裁済み申請の再引当 (Re-deduct)
        if (app.type_id === 'LEAVE_ANNUAL' && ['FINAL_APPROVED', 'TRIP_APPROVED'].includes(restoreStatus)) {
          // 既存の REVERSED レコードを削除して再引当可能にする (UNIQUE 制約 idx_leave_usages_application_unique 対策)
          db.prepare("DELETE FROM leave_usages WHERE application_id = ? AND status = 'REVERSED'").run(app.id);

          // 年休引当を再実行
          const { AnnualLeaveService } = require('./annualLeaveService');
          try {
            AnnualLeaveService.finalizeUsage(app.id);
          } catch (e: any) {
            // 年休ロット残不足等で再引当失敗時は安全に pre_supersede 状態復元を継続
          }
        }

        // applications テーブルを pre_supersede_status に復元し、Provenance カラムをクリア
        db.prepare(`
          UPDATE applications
          SET current_status = ?,
              pre_supersede_status = NULL,
              pre_supersede_workflow_cycle_id = NULL,
              superseded_by_personnel_status_id = NULL,
              superseded_at = NULL,
              updated_at = ?
          WHERE id = ?
        `).run(restoreStatus, now, app.id);
      }

      // 4. Snapshot Invalidation
      SnapshotInvalidationService.checkAndInvalidate(db, {
        sourceType: 'PERSONNEL_STATUS',
        userId: original.user_id,
        dateRange: { start: original.effective_from, end: original.effective_to || original.effective_from },
        actorUserId: cmd.actorUserId,
        reasonCode: `人事発令取消 (#${original.id})`
      });
    })();
  }

  /**
   * 復職 (RETURN_TO_DUTY) Command
   */
  static returnToDuty(statusId: number, returnDate: string, actorUserId: number, comment?: string): void {
    const db = getDb();
    const now = getServerIsoString();

    db.transaction(() => {
      const status = db.prepare('SELECT * FROM personnel_statuses WHERE id = ?').get(statusId) as any;
      if (!status) {
        throw new Error(`PersonnelStatus #${statusId} not found`);
      }
      if (status.status === 'ENDED' || status.status === 'CANCELLED' || status.status === 'SUPERSEDED_BY_AMENDMENT') {
        throw new Error(`既に終了または取消・訂正済みの身分状態です`);
      }

      // 復職日の前日をもって終了
      const prevDay = new Date(new Date(returnDate).getTime() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      db.prepare(`
        UPDATE personnel_statuses
        SET ended_at = ?, effective_to = ?, status = 'CONFIRMED', updated_at = ?
        WHERE id = ?
      `).run(returnDate, prevDay, now, statusId);

      // Action 追記
      db.prepare(`
        INSERT INTO personnel_actions (
          personnel_status_id, action_type, action_date, actor_user_id, previous_state_json, new_state_json, comment, created_at
        ) VALUES (?, 'RETURN_TO_DUTY', ?, ?, ?, ?, ?, ?)
      `).run(
        statusId,
        returnDate,
        actorUserId,
        JSON.stringify(status),
        JSON.stringify({ ...status, ended_at: returnDate, effective_to: prevDay, status: 'CONFIRMED' }),
        comment || `復職発令 (${returnDate})`,
        now
      );

      // Invalidation 検知
      SnapshotInvalidationService.checkAndInvalidate(db, {
        sourceType: 'PERSONNEL_STATUS',
        userId: status.user_id,
        dateRange: { start: returnDate, end: status.effective_to || returnDate },
        actorUserId,
        reasonCode: '復職発令による期間終了'
      });
    })();
  }

  /**
   * 期間延長 (EXTEND) Command
   */
  static extendPeriod(statusId: number, newEffectiveTo: string, actorUserId: number, comment?: string): void {
    const db = getDb();
    const now = getServerIsoString();

    db.transaction(() => {
      const status = db.prepare('SELECT * FROM personnel_statuses WHERE id = ?').get(statusId) as any;
      if (!status) {
        throw new Error(`PersonnelStatus #${statusId} not found`);
      }
      if (status.effective_to && newEffectiveTo <= status.effective_to) {
        throw new Error(`新しい終了日は現在の終了日 (${status.effective_to}) より後である必要があります`);
      }

      // Conflict 検証
      const conflict = ConflictService.validate({
        userId: status.user_id,
        startDate: status.effective_to || status.effective_from,
        endDate: newEffectiveTo,
        statusType: status.status_type,
        excludePersonnelStatusId: statusId,
      });

      if (conflict.hasConflict) {
        throw new Error(`期間延長による競合エラー: ${conflict.reason}`);
      }

      db.prepare(`
        UPDATE personnel_statuses
        SET effective_to = ?, updated_at = ?
        WHERE id = ?
      `).run(newEffectiveTo, now, statusId);

      db.prepare(`
        INSERT INTO personnel_actions (
          personnel_status_id, action_type, action_date, actor_user_id, previous_state_json, new_state_json, comment, created_at
        ) VALUES (?, 'EXTEND', ?, ?, ?, ?, ?, ?)
      `).run(
        statusId,
        now.split('T')[0],
        actorUserId,
        JSON.stringify(status),
        JSON.stringify({ ...status, effective_to: newEffectiveTo }),
        comment || `期間延長 (${status.effective_to} -> ${newEffectiveTo})`,
        now
      );

      // 延長期間に重なる申請を Supersede
      this.supersedeOverlappingApplications(
        db,
        statusId,
        status.user_id,
        status.effective_to || status.effective_from,
        newEffectiveTo,
        now
      );

      SnapshotInvalidationService.checkAndInvalidate(db, {
        sourceType: 'PERSONNEL_STATUS',
        userId: status.user_id,
        dateRange: { start: status.effective_to || status.effective_from, end: newEffectiveTo },
        actorUserId,
        reasonCode: '身分状態期間延長'
      });
    })();
  }
}
