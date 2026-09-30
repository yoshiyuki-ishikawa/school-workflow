import { Database as DatabaseType } from 'better-sqlite3';
import { getDb } from '../db/database';
import { DiseaseContinuityDecision, SickLeaveCalculationSnapshot } from '../types/sickLeaveDomain';

export interface ApprovedSickLeaveInterval {
  startDate: string;
  endDate: string;
  diseaseContinuityDecision: DiseaseContinuityDecision;
  status: string;
  applicationId?: string;
}

export class SickLeaveRepository {
  /**
   * 過去の承認済病気休暇区間リストを取得する (Transaction Handle 透過)
   */
  static getApprovedIntervals(userId: number, txDb?: DatabaseType): ApprovedSickLeaveInterval[] {
    const db = txDb || getDb();
    const rows = db.prepare(`
      SELECT 
        target_date,
        application_calendar_span_days,
        disease_continuity_decision,
        application_status,
        final_calculation_snapshot,
        id
      FROM sick_leave_applications
      WHERE user_id = ?
        AND application_status = 'APPROVED'
      ORDER BY target_date ASC
    `).all(userId) as any[];

    const intervals: ApprovedSickLeaveInterval[] = [];

    for (const row of rows) {
      if (row.final_calculation_snapshot) {
        try {
          const snap = JSON.parse(row.final_calculation_snapshot) as SickLeaveCalculationSnapshot;
          if (snap.dailyBreakdown && snap.dailyBreakdown.length > 0) {
            const start = snap.dailyBreakdown[0].date;
            const end = snap.dailyBreakdown[snap.dailyBreakdown.length - 1].date;
            intervals.push({
              startDate: start,
              endDate: end,
              diseaseContinuityDecision: row.disease_continuity_decision || snap.diseaseContinuityDecision || 'UNRESOLVED',
              status: row.application_status,
              applicationId: row.id
            });
            continue;
          }
        } catch {
          // fallback to target_date
        }
      }

      // 単日レコードの場合のフォールバック
      intervals.push({
        startDate: row.target_date,
        endDate: row.target_date,
        diseaseContinuityDecision: row.disease_continuity_decision || 'UNRESOLVED',
        status: row.application_status,
        applicationId: row.id
      });
    }

    return intervals;
  }
}
