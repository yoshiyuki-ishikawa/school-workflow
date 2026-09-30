import { Migration } from './migrator';
import { Database } from 'better-sqlite3';

/**
 * Migration 023: Original Wave 2B (GAP-06: 病気休暇) Canonical 4層 Overlay & 90日通算基盤
 * 
 * 1. sick_leave_applications テーブルに Canonical カラムを追加 (Append-Only)
 *    - application_calendar_span_days: 今回申請の暦日数
 *    - consecutive_sick_leave_span_days: 連続療養期間の暦日数 (診断書判定用)
 *    - accumulated_same_disease_calendar_days: 1年以内同一疾病通算暦日数 (90日通算用)
 *    - disease_continuity_decision: 同一疾病行政判断 ('SAME_DISEASE' | 'SEPARATE_DISEASE' | 'UNRESOLVED')
 *    - final_calculation_snapshot: 承認時確定スナップショット (JSON)
 * 2. 既存 Migration 011 は完全 FROZEN (未変更)
 */
export const migration023: Migration = {
  version: 23,
  name: 'sick_leave_canonical_overlay_and_accumulation',
  up: (db: Database) => {
    const cols = db.prepare('PRAGMA table_info(sick_leave_applications)').all() as { name: string }[];
    const colNames = new Set(cols.map((c) => c.name));

    if (!colNames.has('application_calendar_span_days')) {
      db.exec('ALTER TABLE sick_leave_applications ADD COLUMN application_calendar_span_days INTEGER;');
    }
    if (!colNames.has('consecutive_sick_leave_span_days')) {
      db.exec('ALTER TABLE sick_leave_applications ADD COLUMN consecutive_sick_leave_span_days INTEGER;');
    }
    if (!colNames.has('accumulated_same_disease_calendar_days')) {
      db.exec('ALTER TABLE sick_leave_applications ADD COLUMN accumulated_same_disease_calendar_days INTEGER;');
    }
    if (!colNames.has('disease_continuity_decision')) {
      db.exec(`
        ALTER TABLE sick_leave_applications
        ADD COLUMN disease_continuity_decision TEXT NOT NULL DEFAULT 'UNRESOLVED'
        CHECK (disease_continuity_decision IN ('SAME_DISEASE', 'SEPARATE_DISEASE', 'UNRESOLVED'));
      `);
    }
    if (!colNames.has('final_calculation_snapshot')) {
      db.exec('ALTER TABLE sick_leave_applications ADD COLUMN final_calculation_snapshot TEXT;');
    }
  }
};
