import { Database as DatabaseType } from 'better-sqlite3';
import { SnapshotInvalidationService } from './snapshotInvalidationService';
import { logAudit } from '../utils/auditLogger';
import { getServerIsoString } from '../utils/serverTime';

export class ActivationService {
  /**
   * 承認されたApplicationからWorkPatternまたはPersonnelStatusへ発効変換 (Transaction内・冪等)
   */
  static activateApplication(db: DatabaseType, applicationId: number, actorUserId: number): { success: boolean; generatedType?: string; id?: number } {
    const now = getServerIsoString();
    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(applicationId) as any;
    if (!app) {
      throw new Error(`Application #${applicationId} not found`);
    }

    const formData = JSON.parse(app.form_data);

    // 1. 育児休業 (LEAVE_CHILDCARE) の場合 -> personnel_statuses 生成
    if (app.type_id === 'LEAVE_CHILDCARE') {
      // 冪等性チェック: 既に source_application_id で登録済みか
      const existing = db.prepare('SELECT id FROM personnel_statuses WHERE source_application_id = ?').get(applicationId) as { id: number } | undefined;
      if (existing) {
        return { success: true, generatedType: 'PERSONNEL_STATUS', id: existing.id };
      }

      const policy = db.prepare('SELECT id FROM policy_rules WHERE policy_code = ? AND is_active = 1 LIMIT 1').get('CHILDCARE_LEAVE') as { id: number } | undefined;

      const result = db.prepare(`
        INSERT INTO personnel_statuses (
          user_id, status_type, policy_rule_id, source_application_id, document_reference_no,
          issued_at, effective_from, effective_to, status, authority_basis, order_authority_snapshot,
          reason_code, registered_by_user_id, confirmed_by_user_id, created_at, updated_at
        ) VALUES (?, 'CHILDCARE_LEAVE', ?, ?, ?, ?, ?, ?, 'CONFIRMED', 'OFFICIAL_NOTICE', '山口県教育委員会', ?, ?, ?, ?, ?)
      `).run(
        app.subject_user_id,
        policy ? policy.id : null,
        applicationId,
        formData.documentReferenceNo || `APP-AUTOGEN-${applicationId}`,
        formData.issuedAt || formData.startDate,
        formData.startDate,
        formData.endDate,
        formData.reasonCode || 'CHILDCARE_LEAVE_STANDARD',
        actorUserId,
        actorUserId,
        now,
        now
      );

      const statusId = Number(result.lastInsertRowid);

      // PersonnelAction 記録
      db.prepare(`
        INSERT INTO personnel_actions (
          personnel_status_id, action_type, action_date, actor_user_id, comment, created_at
        ) VALUES (?, 'CREATE_FROM_APPLICATION', ?, ?, ?, ?)
      `).run(statusId, formData.startDate, actorUserId, `申請 #${applicationId} 承認による自動発効`, now);

      // Snapshot Invalidation チェック
      SnapshotInvalidationService.checkAndInvalidate(db, {
        sourceType: 'PERSONNEL_STATUS',
        userId: app.subject_user_id,
        dateRange: { start: formData.startDate, end: formData.endDate },
        actorUserId,
        reasonCode: '育児休業承認発効'
      });

      return { success: true, generatedType: 'PERSONNEL_STATUS', id: statusId };
    }

    // 2. 育児短時間勤務 (WORK_PATTERN_CHILDCARE) の場合 -> user_work_patterns 生成/更新
    if (app.type_id === 'WORK_PATTERN_CHILDCARE') {
      const scheduleJson = JSON.stringify(formData.scheduleDetails || {
        "0": { "isWorkDay": false, "workMinutes": 0 },
        "1": { "isWorkDay": true,  "workMinutes": 235, "startTime": "08:30", "endTime": "12:30" },
        "2": { "isWorkDay": true,  "workMinutes": 235, "startTime": "08:30", "endTime": "12:30" },
        "3": { "isWorkDay": false, "workMinutes": 0 },
        "4": { "isWorkDay": true,  "workMinutes": 235, "startTime": "08:30", "endTime": "12:30" },
        "5": { "isWorkDay": true,  "workMinutes": 235, "startTime": "08:30", "endTime": "12:30" },
        "6": { "isWorkDay": false, "workMinutes": 0 }
      });

      const weeklyMinutes = formData.weeklyTotalMinutes || 1175;
      const weeklyOffDays = formData.weeklyOffDays || '0,3,6';

      const result = db.prepare(`
        INSERT INTO user_work_patterns (
          user_id, pattern_name, pattern_type, effective_from, effective_to,
          weekly_off_days, schedule_details_json, weekly_total_minutes,
          memo, record_origin, created_by_user_id, created_at, updated_by_user_id, updated_at, schedule_source
        ) VALUES (?, '育児短時間勤務 (申請承認)', 'SHORT_TIME', ?, ?, ?, ?, ?, ?, 'ADMIN_CONFIGURED', ?, ?, ?, ?, 'INDIVIDUAL')
      `).run(
        app.subject_user_id,
        formData.startDate,
        formData.endDate,
        weeklyOffDays,
        scheduleJson,
        weeklyMinutes,
        `申請 #${applicationId} 承認による自動反映`,
        actorUserId,
        now,
        actorUserId,
        now
      );

      const patternId = Number(result.lastInsertRowid);

      SnapshotInvalidationService.checkAndInvalidate(db, {
        sourceType: 'WORK_PATTERN',
        userId: app.subject_user_id,
        dateRange: { start: formData.startDate, end: formData.endDate },
        actorUserId,
        reasonCode: '育児短時間勤務承認発効'
      });

      return { success: true, generatedType: 'WORK_PATTERN', id: patternId };
    }

    return { success: true };
  }
}
