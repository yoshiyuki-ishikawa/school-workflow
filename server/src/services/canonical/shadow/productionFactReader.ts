/**
 * Read-Only Deterministic Production Fact Reader
 * Canonical Service Fact Architecture — Phase D
 * 
 * Invariant INV-D-06: Same Input Contract
 * Invariant INV-D-08: Fingerprint = Evidence Only
 * 
 * 指定された userId, yearMonth に対して、同一の SQLite Read Snapshot / Database Connection から
 * 既存 Adapter を用いて CanonicalServiceFact[] を決定論的に抽出・集約する。
 */

import crypto from 'crypto';
import { Database as DatabaseType } from 'better-sqlite3';
import { CanonicalServiceFact } from '../types';
import {
  normalizeApplicationToFacts,
  normalizePersonnelStatusToFact,
  normalizeAbsenceToFact,
  normalizeCalendarToFact,
  normalizeCalendarAdjustmentToFact,
  normalizeWorkScheduleToFact,
  CustomHolidayRecord,
  CalendarAdjustmentRecord,
  UserWorkPatternRecord,
  PersonnelStatusRecord,
  AbsenceRecord
} from '../adapters';

export interface ProductionSourceDataset {
  userId: number;
  yearMonth: string;
  startDate: string;
  endDate: string;
  applications: any[];
  personnelStatuses: PersonnelStatusRecord[];
  absences: AbsenceRecord[];
  calendarAdjustments: CalendarAdjustmentRecord[];
  workPatterns: UserWorkPatternRecord[];
  customHolidays: CustomHolidayRecord[];
}

export interface ExtractedFactResult {
  facts: CanonicalServiceFact[];
  datasetFingerprint: string;
  extractedCount: number;
}

export class ProductionFactReader {
  /**
   * 同一 DB 接続から指定月の SSOT レコードを Read-Only で一括抽出し、Input Dataset Fingerprint を生成
   */
  static extractMonthlyFacts(
    db: DatabaseType,
    userId: number,
    yearMonth: string
  ): ExtractedFactResult {
    const [y, m] = yearMonth.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const startDate = `${yearMonth}-01`;
    const endDate = `${yearMonth}-${String(daysInMonth).padStart(2, '0')}`;

    // 1. Applications (決裁完了または出張承認済み)
    const applications = db.prepare(`
      SELECT id, type_id, subject_user_id, submitted_by_user_id, title, form_data, final_calculation_snapshot, current_status, version
      FROM applications
      WHERE subject_user_id = ?
        AND current_status IN ('FINAL_APPROVED', 'TRIP_APPROVED')
      ORDER BY id ASC
    `).all(userId) as any[];

    // 2. Personnel Statuses (身分発令)
    const personnelStatuses = db.prepare(`
      SELECT id, user_id, status_type, document_reference_no, effective_from, effective_to, status, reason_code
      FROM personnel_statuses
      WHERE user_id = ?
        AND status IN ('CONFIRMED', 'EFFECTIVE')
        AND effective_from <= ? AND effective_to >= ?
      ORDER BY id ASC
    `).all(userId, endDate, startDate) as PersonnelStatusRecord[];

    // 3. Absences (欠勤)
    const absences = db.prepare(`
      SELECT id, user_id, absence_type, target_date, start_time, end_time, duration_minutes, reason, status
      FROM absences
      WHERE user_id = ?
        AND target_date BETWEEN ? AND ?
        AND status = 'CONFIRMED'
      ORDER BY id ASC
    `).all(userId, startDate, endDate) as AbsenceRecord[];

    // 4. Calendar Adjustments (服務振替・代休)
    const calendarAdjustments = db.prepare(`
      SELECT id, adjustment_code, scope_type, user_id, adjustment_type, reason_code, source_date, source_duty_status, target_date, target_duty_status, event_name, reason, status
      FROM calendar_adjustments
      WHERE status = 'ACTIVE'
        AND (scope_type = 'ALL' OR user_id = ?)
        AND (
          (source_date BETWEEN ? AND ?) OR
          (target_date IS NOT NULL AND target_date BETWEEN ? AND ?)
        )
      ORDER BY id ASC
    `).all(userId, startDate, endDate, startDate, endDate) as CalendarAdjustmentRecord[];

    // 5. Work Patterns (勤務パターン)
    const workPatterns = db.prepare(`
      SELECT id, user_id, pattern_name, pattern_type, effective_from, effective_to, weekly_off_days, schedule_details_json, weekly_total_minutes
      FROM user_work_patterns
      WHERE user_id = ?
        AND effective_from <= ? AND effective_to >= ?
      ORDER BY id ASC
    `).all(userId, endDate, startDate) as UserWorkPatternRecord[];

    // 6. Custom Holidays (学校独自休日)
    const customHolidays = db.prepare(`
      SELECT id, holiday_date, name, holiday_type, is_active
      FROM custom_holidays
      WHERE holiday_date BETWEEN ? AND ?
        AND is_active = 1
      ORDER BY id ASC
    `).all(startDate, endDate) as CustomHolidayRecord[];

    // 7. Same Input Dataset Fingerprint の生成 (Evidence Only)
    const datasetPayload = {
      userId,
      yearMonth,
      applications,
      personnelStatuses,
      absences,
      calendarAdjustments,
      workPatterns,
      customHolidays
    };
    const datasetFingerprint = crypto
      .createHash('sha256')
      .update(JSON.stringify(datasetPayload))
      .digest('hex');

    // 8. 各 Adapter を介して CanonicalServiceFact[] を決定論的生成
    const facts: CanonicalServiceFact[] = [];

    // Applications -> Facts
    for (const app of applications) {
      const appFacts = normalizeApplicationToFacts(app);
      // 当月期間内の Fact のみ抽出
      for (const f of appFacts) {
        if (f.targetDate >= startDate && f.targetDate <= endDate) {
          facts.push(f);
        }
      }
    }

    // 日次ごとの Calendar, Adjustment, WorkPattern, PersonnelStatus, Absence Fact を走査
    for (let day = 1; day <= daysInMonth; day++) {
      const targetDate = `${yearMonth}-${String(day).padStart(2, '0')}`;

      // Calendar Fact
      const calFact = normalizeCalendarToFact(userId, targetDate, customHolidays);
      if (calFact) {
        facts.push(calFact);
      }

      // Work Pattern Fact (週休 or 育短)
      for (const wp of workPatterns) {
        const wpFact = normalizeWorkScheduleToFact(wp, targetDate);
        if (wpFact) {
          facts.push(wpFact);
        }
      }

      // Calendar Adjustment Fact
      for (const adj of calendarAdjustments) {
        const adjFact = normalizeCalendarAdjustmentToFact(adj, userId, targetDate);
        if (adjFact) {
          facts.push(adjFact);
        }
      }

      // Personnel Status Fact
      for (const ps of personnelStatuses) {
        const psFact = normalizePersonnelStatusToFact(ps, targetDate);
        if (psFact) {
          facts.push(psFact);
        }
      }

      // Absence Fact
      for (const abs of absences) {
        const absFact = normalizeAbsenceToFact(abs, targetDate);
        if (absFact) {
          facts.push(absFact);
        }
      }
    }

    return {
      facts,
      datasetFingerprint,
      extractedCount: facts.length
    };
  }
}
