import { Database as DatabaseType } from 'better-sqlite3';
import { Migration } from './migrator';

export const migration003: Migration = {
  version: 3,
  name: 'leave_grant_and_report_status',
  up: (db: DatabaseType) => {
    // -------------------------------------------------------------
    // 1. system_settings テーブル作成 (制度設定・システム設定の分離)
    // -------------------------------------------------------------
    db.exec(`
      CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        description TEXT
      );
    `);

    // 初期システム設定の投入
    const insertSetting = db.prepare(`
      INSERT OR IGNORE INTO system_settings (key, value, description)
      VALUES (?, ?, ?)
    `);
    insertSetting.run('work_day_minutes', '465', '1日の標準勤務時間（分単位: 7時間45分=465分）');
    insertSetting.run('default_annual_grant_days', '20.0', '新年度デフォルト年次有給休暇付与日数');
    insertSetting.run('standard_start_time', '08:10', '標準勤務開始時刻');
    insertSetting.run('standard_end_time', '16:40', '標準勤務終了時刻');

    // -------------------------------------------------------------
    // 2. user_leave_settings テーブル作成 (年休基準日管理)
    // -------------------------------------------------------------
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_leave_settings (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        annual_base_date TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    // -------------------------------------------------------------
    // 3. leave_grants テーブル作成 (休暇付与イベント履歴)
    // -------------------------------------------------------------
    db.exec(`
      CREATE TABLE IF NOT EXISTS leave_grants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        leave_type TEXT NOT NULL,
        granted_amount REAL NOT NULL,
        grant_date TEXT NOT NULL,
        effective_from TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        carryover_source_grant_id INTEGER REFERENCES leave_grants(id) ON DELETE SET NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_leave_grants_user_date ON leave_grants(user_id, expires_at);
    `);

    // -------------------------------------------------------------
    // 4. leave_adjustments テーブル作成 (手動調整履歴)
    // -------------------------------------------------------------
    db.exec(`
      CREATE TABLE IF NOT EXISTS leave_adjustments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        leave_type TEXT NOT NULL,
        adjusted_amount REAL NOT NULL,
        adjusted_by_user_id INTEGER NOT NULL REFERENCES users(id),
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    // -------------------------------------------------------------
    // 5. applications テーブルへの report_status 追加 (ALTER TABLE)
    // -------------------------------------------------------------
    const appCols = db.prepare('PRAGMA table_info(applications)').all() as { name: string }[];
    const appColNames = new Set(appCols.map((c) => c.name));

    if (!appColNames.has('report_status')) {
      db.exec(`ALTER TABLE applications ADD COLUMN report_status TEXT NOT NULL DEFAULT 'UNSUBMITTED'`);
    }

    // -------------------------------------------------------------
    // 6. monthly_attendance_approvals テーブルへのカラム追加 (ALTER TABLE)
    // -------------------------------------------------------------
    const monthlyCols = db.prepare('PRAGMA table_info(monthly_attendance_approvals)').all() as { name: string }[];
    const monthlyColNames = new Set(monthlyCols.map((c) => c.name));

    if (!monthlyColNames.has('version')) {
      db.exec(`ALTER TABLE monthly_attendance_approvals ADD COLUMN version INTEGER NOT NULL DEFAULT 1`);
    }
    if (!monthlyColNames.has('unlocked_reason')) {
      db.exec(`ALTER TABLE monthly_attendance_approvals ADD COLUMN unlocked_reason TEXT`);
    }
    if (!monthlyColNames.has('unlocked_by_user_id')) {
      db.exec(`ALTER TABLE monthly_attendance_approvals ADD COLUMN unlocked_by_user_id INTEGER REFERENCES users(id)`);
    }
    if (!monthlyColNames.has('unlocked_at')) {
      db.exec(`ALTER TABLE monthly_attendance_approvals ADD COLUMN unlocked_at TEXT`);
    }
    if (!monthlyColNames.has('confirmed_user_display_name')) {
      db.exec(`ALTER TABLE monthly_attendance_approvals ADD COLUMN confirmed_user_display_name TEXT`);
    }
    if (!monthlyColNames.has('confirmed_user_stamp_name')) {
      db.exec(`ALTER TABLE monthly_attendance_approvals ADD COLUMN confirmed_user_stamp_name TEXT`);
    }

    // -------------------------------------------------------------
    // 7. application_approval_steps テーブルへのスナップショットカラム追加
    // -------------------------------------------------------------
    const stepCols = db.prepare('PRAGMA table_info(application_approval_steps)').all() as { name: string }[];
    const stepColNames = new Set(stepCols.map((c) => c.name));

    if (!stepColNames.has('action_user_display_name')) {
      db.exec(`ALTER TABLE application_approval_steps ADD COLUMN action_user_display_name TEXT`);
    }
    if (!stepColNames.has('action_user_stamp_name')) {
      db.exec(`ALTER TABLE application_approval_steps ADD COLUMN action_user_stamp_name TEXT`);
    }
    if (!stepColNames.has('action_user_role_name')) {
      db.exec(`ALTER TABLE application_approval_steps ADD COLUMN action_user_role_name TEXT`);
    }

    // -------------------------------------------------------------
    // 8. 既存データの安全な移行 (Migration Strategy)
    // -------------------------------------------------------------
    // 8.1 既存ユーザーへの年休初期付与 (20.0日) & 基準日作成
    const users = db.prepare('SELECT id, created_at FROM users WHERE is_active = 1').all() as {
      id: number;
      created_at: string;
    }[];

    const insertBaseSetting = db.prepare(`
      INSERT OR IGNORE INTO user_leave_settings (user_id, annual_base_date, updated_at)
      VALUES (?, ?, ?)
    `);

    const insertGrant = db.prepare(`
      INSERT INTO leave_grants (
        user_id, leave_type, granted_amount, grant_date, effective_from, expires_at, reason, created_at
      ) VALUES (?, 'ANNUAL', 20.0, ?, ?, ?, '初期移行付与', ?)
    `);

    for (const u of users) {
      const grantDate = u.created_at ? u.created_at.split('T')[0] : '2026-04-01';
      const effectiveFrom = grantDate;
      const parts = grantDate.split('-');
      const expiresYear = parseInt(parts[0], 10) + 1;
      const expiresAt = `${expiresYear}-${parts[1] || '04'}-${parts[2] || '01'}`;

      insertBaseSetting.run(u.id, grantDate, u.created_at || new Date().toISOString());
      insertGrant.run(u.id, grantDate, effectiveFrom, expiresAt, u.created_at || new Date().toISOString());
    }

    // 8.2 過去の出張申請で復命書が決裁済みのデータの report_status 移行
    db.exec(`
      UPDATE applications
      SET report_status = 'REPORT_FINAL_APPROVED'
      WHERE type_id = 'BUSINESS_TRIP' AND current_status = 'FINAL_APPROVED'
    `);
    db.exec(`
      UPDATE applications
      SET current_status = 'TRIP_APPROVED'
      WHERE type_id = 'BUSINESS_TRIP' AND current_status = 'FINAL_APPROVED'
    `);

    // 8.3 過去の出張申請で復命書が提出済み・承認途中のデータの移行
    db.exec(`
      UPDATE applications
      SET report_status = 'REPORT_SUBMITTED', current_status = 'TRIP_APPROVED'
      WHERE type_id = 'BUSINESS_TRIP' AND current_status = 'REPORT_SUBMITTED'
    `);
    db.exec(`
      UPDATE applications
      SET report_status = 'REPORT_FIRST_APPROVED', current_status = 'TRIP_APPROVED'
      WHERE type_id = 'BUSINESS_TRIP' AND current_status = 'REPORT_FIRST_APPROVED'
    `);
    db.exec(`
      UPDATE applications
      SET report_status = 'REPORT_SECOND_APPROVED', current_status = 'TRIP_APPROVED'
      WHERE type_id = 'BUSINESS_TRIP' AND current_status = 'REPORT_SECOND_APPROVED'
    `);
  },
};
