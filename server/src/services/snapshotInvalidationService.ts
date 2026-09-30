import { Database as DatabaseType } from 'better-sqlite3';
import { logAudit } from '../utils/auditLogger';

export interface InvalidationTrigger {
  sourceType: 'PERSONNEL_STATUS' | 'WORK_PATTERN' | 'CALENDAR' | 'APPLICATION' | 'POLICY_RULE';
  userId?: number;
  dateRange: { start: string; end: string };
  actorUserId: number;
  reasonCode: string;
}

export class SnapshotInvalidationService {
  /**
   * 元データ変更時に影響する確定済みSnapshotを検知し、NEEDS_RECONFIRMATIONへ遷移させる
   */
  static checkAndInvalidate(db: DatabaseType, trigger: InvalidationTrigger): number[] {
    const affectedMonths = this.calculateAffectedYearMonths(trigger.dateRange.start, trigger.dateRange.end);
    const affectedSnapshotIds: number[] = [];

    for (const ym of affectedMonths) {
      let query = "SELECT id, user_id, version FROM monthly_attendance_snapshots WHERE year_month = ? AND status = 'LOCKED'";
      const params: any[] = [ym];

      if (trigger.userId) {
        query += ' AND user_id = ?';
        params.push(trigger.userId);
      }

      const lockedSnapshots = db.prepare(query).all(...params) as { id: number; user_id: number; version: number }[];

      for (const snap of lockedSnapshots) {
        db.prepare(`
          UPDATE monthly_attendance_snapshots
          SET status = 'NEEDS_RECONFIRMATION',
              reconfirmation_reason = ?
          WHERE id = ?
        `).run(`元データ変更検知 (${trigger.sourceType}): ${trigger.reasonCode}`, snap.id);

        affectedSnapshotIds.push(snap.id);

        const actor = db.prepare('SELECT username FROM users WHERE id = ?').get(trigger.actorUserId) as { username: string } | undefined;
        logAudit({
          actorUserId: trigger.actorUserId,
          actorUsername: actor ? actor.username : 'SYSTEM',
          action: 'SNAPSHOT_INVALIDATED',
          entityType: 'MONTHLY_SNAPSHOT',
          entityId: snap.id.toString(),
          comment: `確定出勤簿が要再確定に変更されました (User: ${snap.user_id}, Month: ${ym}, Reason: ${trigger.reasonCode})`,
          ipAddress: '127.0.0.1',
        });
      }
    }

    return affectedSnapshotIds;
  }

  static calculateAffectedYearMonths(start: string, end: string): string[] {
    const s = new Date(start);
    const e = new Date(end);
    const months = new Set<string>();
    const curr = new Date(s.getFullYear(), s.getMonth(), 1);
    while (curr <= e) {
      months.add(`${curr.getFullYear()}-${String(curr.getMonth() + 1).padStart(2, '0')}`);
      curr.setMonth(curr.getMonth() + 1);
    }
    return Array.from(months);
  }
}
