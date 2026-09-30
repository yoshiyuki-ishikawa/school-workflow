import { Migration } from './migrator';
import { Database } from 'better-sqlite3';

/**
 * Migration 024: Original Wave 3 (GAP-03: 公務旅行・旅行命令／復命) Canonical Snapshots & Oral Order 基盤
 * 
 * 1. trip_events テーブルに NULL-Safe な口頭発令・経路カラムを追加
 *    - is_oral_order: 口頭発令区分 (1=ORAL_ORDER, 0=NORMAL_ADVANCE_ORDER, NULL=LEGACY_UNKNOWN)
 *    - oral_order_issued_at: 事前口頭発令年月日 (TEXT, YYYY-MM-DD)
 *    - departure_place: 計画出発地 (TEXT, NULL許容 / Legacy Unknown保持)
 *    - arrival_place: 計画帰着地 (TEXT, NULL許容 / Legacy Unknown保持)
 * 2. travel_order_snapshots テーブル新設 (旅行命令発令時 不変スナップショット)
 * 3. post_trip_report_snapshots テーブル新設 (復命決裁時 不変スナップショット ＆ 構造化実績情報)
 */
export const migration024: Migration = {
  version: 24,
  name: 'trip_canonical_snapshots_and_oral_order',
  up: (db: Database) => {
    const tripCols = db.prepare('PRAGMA table_info(trip_events)').all() as { name: string }[];
    const colNames = new Set(tripCols.map((c) => c.name));

    if (!colNames.has('is_oral_order')) {
      db.exec('ALTER TABLE trip_events ADD COLUMN is_oral_order INTEGER CHECK(is_oral_order IN (0, 1));');
    }
    if (!colNames.has('oral_order_issued_at')) {
      db.exec('ALTER TABLE trip_events ADD COLUMN oral_order_issued_at TEXT;');
    }
    if (!colNames.has('departure_place')) {
      db.exec('ALTER TABLE trip_events ADD COLUMN departure_place TEXT;');
    }
    if (!colNames.has('arrival_place')) {
      db.exec('ALTER TABLE trip_events ADD COLUMN arrival_place TEXT;');
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS travel_order_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        workflow_cycle_id INTEGER REFERENCES application_workflow_cycles(id),
        trip_event_id INTEGER NOT NULL REFERENCES trip_events(id) ON DELETE CASCADE,
        travel_order_issued_at TEXT NOT NULL,
        school_name_snapshot TEXT NOT NULL,
        traveler_user_id_snapshot INTEGER NOT NULL REFERENCES users(id),
        traveler_name_snapshot TEXT NOT NULL,
        traveler_position_snapshot TEXT NOT NULL,
        trip_plan_facts_json TEXT NOT NULL,
        approval_history_snapshots_json TEXT NOT NULL,
        finalized_at TEXT NOT NULL,
        finalized_by_user_id INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
        UNIQUE(application_id, workflow_cycle_id)
      );
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS post_trip_report_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        workflow_cycle_id INTEGER REFERENCES application_workflow_cycles(id),
        report_date TEXT NOT NULL,
        result_summary TEXT NOT NULL,
        remarks TEXT NOT NULL DEFAULT '',
        travel_actual_facts_json TEXT NOT NULL DEFAULT '{}',
        author_user_id_snapshot INTEGER NOT NULL REFERENCES users(id),
        author_name_snapshot TEXT NOT NULL,
        report_approval_snapshots_json TEXT NOT NULL,
        finalized_at TEXT NOT NULL,
        finalized_by_user_id INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
        UNIQUE(application_id, workflow_cycle_id)
      );
    `);
  }
};
