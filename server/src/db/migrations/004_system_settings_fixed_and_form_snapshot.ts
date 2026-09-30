import { Database as DatabaseType } from 'better-sqlite3';
import { Migration } from './migrator';
import { getServerIsoString } from '../../utils/serverTime';

export const migration004: Migration = {
  version: 4,
  name: 'system_settings_fixed_and_form_snapshot',
  up: (db: DatabaseType) => {
    // -------------------------------------------------------------
    // 1. 旧 system_settings テーブルのマイグレーション
    // -------------------------------------------------------------
    // 既存の key-value 型テーブルが存在する場合はバックアップして置き換え
    const tableInfo = db.prepare("PRAGMA table_info('system_settings')").all() as { name: string }[];
    const colNames = new Set(tableInfo.map((c) => c.name));

    const isOldKeyValue = colNames.has('key') && !colNames.has('school_name');
    if (isOldKeyValue) {
      db.exec(`DROP TABLE IF EXISTS system_settings`);
    }

    // 型安全な固定カラム system_settings テーブル作成 (Singleton: id=1固定)
    db.exec(`
      CREATE TABLE IF NOT EXISTS system_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        school_name TEXT NOT NULL,
        municipality_name TEXT NOT NULL,
        board_of_education_name TEXT NOT NULL,
        app_title TEXT NOT NULL,
        leave_regulation_name TEXT NOT NULL,
        travel_regulation_name TEXT NOT NULL,
        attendance_regulation_name TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        updated_by_user_id INTEGER REFERENCES users(id)
      );
    `);

    // 初期レコードの投入 (未存在時のみ)
    const existing = db.prepare('SELECT id FROM system_settings WHERE id = 1').get();
    if (!existing) {
      const now = getServerIsoString();
      db.prepare(`
        INSERT INTO system_settings (
          id, school_name, municipality_name, board_of_education_name,
          app_title, leave_regulation_name, travel_regulation_name, attendance_regulation_name,
          version, updated_at
        ) VALUES (
          1, '公立小学校', '〇〇市', '〇〇市教育委員会',
          '学校業務ワークフローシステム', '学校職員服務規程第15条', '学校職員旅費規程', '学校職員勤務時間及び服務規程',
          1, ?
        )
      `).run(now);
    }

    // -------------------------------------------------------------
    // 2. applications テーブルへの organization_snapshot カラム追加
    // -------------------------------------------------------------
    const appCols = db.prepare("PRAGMA table_info('applications')").all() as { name: string }[];
    const appColNames = new Set(appCols.map((c) => c.name));
    if (!appColNames.has('organization_snapshot')) {
      db.exec(`ALTER TABLE applications ADD COLUMN organization_snapshot TEXT`);
    }

    // -------------------------------------------------------------
    // 3. monthly_attendance_approvals テーブルへの organization_snapshot カラム追加
    // -------------------------------------------------------------
    const monthlyCols = db.prepare("PRAGMA table_info('monthly_attendance_approvals')").all() as { name: string }[];
    const monthlyColNames = new Set(monthlyCols.map((c) => c.name));
    if (!monthlyColNames.has('organization_snapshot')) {
      db.exec(`ALTER TABLE monthly_attendance_approvals ADD COLUMN organization_snapshot TEXT`);
    }
  },
};
