import { Database as DatabaseType } from 'better-sqlite3';
import { Migration } from './migrator';
import { getServerIsoString } from '../../utils/serverTime';

export const migration007: Migration = {
  version: 7,
  name: '007_status_and_snapshot_v3',
  up: (db: DatabaseType) => {
    const now = getServerIsoString();

    // 1. roles 保証 (未シードDB対策)
    const insertRole = db.prepare('INSERT OR IGNORE INTO roles (id, name) VALUES (?, ?)');
    insertRole.run('TEACHER', '一般教職員');
    insertRole.run('VICE_PRINCIPAL', '教頭 (一次承認者)');
    insertRole.run('PRINCIPAL', '校長 (最終決裁者)');
    insertRole.run('OFFICE', '事務室 (出張・旅費・服務事務係)');
    insertRole.run('ADMIN', 'システム管理者 (IT運用・セキュリティ保守)');

    // approval_routes (id: 1) 保証
    const insertRoute = db.prepare('INSERT OR IGNORE INTO approval_routes (id, name, description) VALUES (?, ?, ?)');
    insertRoute.run(1, '標準決裁ルート', '標準2段階決裁フロー');

    // 2. 本人申請型 application_types の追加 (育休・育短・部分休業)
    const insertAppType = db.prepare('INSERT OR IGNORE INTO application_types (id, name, description, default_route_id) VALUES (?, ?, ?, ?)');
    insertAppType.run('LEAVE_CHILDCARE', '育児休業請求', '育児休業の請求 (発令連携・出勤簿非勤務)', 1);
    insertAppType.run('WORK_PATTERN_CHILDCARE', '育児短時間勤務請求', '育児短時間勤務パターンの割振り請求', 1);
    insertAppType.run('LEAVE_CHILDCARE_PARTIAL', '育児部分休業請求', '1日最大2時間等の部分休業請求 (時間単位)', 1);

    // 3. permissions & role_permissions
    db.exec(`
      CREATE TABLE IF NOT EXISTS permissions (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (DATETIME('now'))
      );

      CREATE TABLE IF NOT EXISTS role_permissions (
        role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
        PRIMARY KEY (role_id, permission_id)
      );

      -- 4. policy_rules (制度ルールマスタ - 原則Immutable)
      CREATE TABLE IF NOT EXISTS policy_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        policy_code TEXT NOT NULL,
        authority_id TEXT NOT NULL DEFAULT 'DEFAULT_MUNICIPALITY',
        version TEXT NOT NULL DEFAULT '2026.1',
        official_name TEXT NOT NULL,
        display_code TEXT NOT NULL,
        aggregation_category TEXT NOT NULL,
        max_minutes_per_day INTEGER DEFAULT 0,
        effective_from TEXT NOT NULL,
        effective_to TEXT NOT NULL,
        rule_definition_json TEXT NOT NULL DEFAULT '{}',
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
        UNIQUE(policy_code, authority_id, version)
      );

      -- 5. personnel_statuses (人事身分状態 - 期間の正本)
      CREATE TABLE IF NOT EXISTS personnel_statuses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        status_type TEXT NOT NULL,
        policy_rule_id INTEGER REFERENCES policy_rules(id),
        source_application_id INTEGER UNIQUE REFERENCES applications(id) ON DELETE SET NULL,
        document_reference_no TEXT,
        effective_from TEXT NOT NULL,
        effective_to TEXT NOT NULL,
        ended_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('REGISTERED', 'CONFIRMED', 'EFFECTIVE', 'ENDED', 'CANCELLED')),
        reason_code TEXT NOT NULL,
        registered_by_user_id INTEGER NOT NULL REFERENCES users(id),
        confirmed_by_user_id INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
        updated_at TEXT NOT NULL DEFAULT (DATETIME('now')),
        CHECK (effective_from <= effective_to)
      );

      -- 6. personnel_actions (人事変更履歴・出来事)
      CREATE TABLE IF NOT EXISTS personnel_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        personnel_status_id INTEGER NOT NULL REFERENCES personnel_statuses(id) ON DELETE CASCADE,
        action_type TEXT NOT NULL,
        action_date TEXT NOT NULL,
        actor_user_id INTEGER NOT NULL REFERENCES users(id),
        previous_state_json TEXT,
        new_state_json TEXT,
        comment TEXT,
        created_at TEXT NOT NULL DEFAULT (DATETIME('now'))
      );

      -- 7. monthly_attendance_snapshots (親: 月次確定出勤簿)
      CREATE TABLE IF NOT EXISTS monthly_attendance_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        year_month TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL CHECK (status IN ('LOCKED', 'NEEDS_RECONFIRMATION', 'SUPERSEDED')),
        confirmed_at TEXT NOT NULL,
        confirmed_by_user_id INTEGER NOT NULL REFERENCES users(id),
        confirmed_by_user_name TEXT NOT NULL,
        confirmed_user_stamp_name TEXT NOT NULL,
        monthly_summary_json TEXT NOT NULL,
        policy_rule_versions_json TEXT NOT NULL DEFAULT '{}',
        work_pattern_snapshot_json TEXT NOT NULL DEFAULT '{}',
        calendar_version TEXT NOT NULL DEFAULT '1.0',
        checksum TEXT NOT NULL,
        reconfirmation_reason TEXT,
        supersedes_snapshot_id INTEGER REFERENCES monthly_attendance_snapshots(id),
        created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
        UNIQUE (user_id, year_month, version)
      );

      -- 8. monthly_attendance_snapshot_days (子: 日次確定明細)
      CREATE TABLE IF NOT EXISTS monthly_attendance_snapshot_days (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id INTEGER NOT NULL REFERENCES monthly_attendance_snapshots(id) ON DELETE CASCADE,
        date TEXT NOT NULL,
        day_of_month INTEGER NOT NULL,
        is_required_work_day INTEGER NOT NULL,
        scheduled_work_minutes INTEGER NOT NULL,
        actual_work_minutes INTEGER NOT NULL,
        personnel_status_code TEXT NOT NULL,
        daily_event_code TEXT,
        display_symbol TEXT NOT NULL,
        display_name TEXT NOT NULL,
        aggregation_category TEXT NOT NULL,
        resolution_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
        UNIQUE (snapshot_id, date)
      );

      CREATE INDEX IF NOT EXISTS idx_ps_user_period ON personnel_statuses(user_id, effective_from, effective_to);
      CREATE INDEX IF NOT EXISTS idx_snap_user_ym ON monthly_attendance_snapshots(user_id, year_month);
      CREATE INDEX IF NOT EXISTS idx_snap_days_date ON monthly_attendance_snapshot_days(date);
    `);

    // 必須パーミッションの保証 (Migration内で確実にシード)
    const insertPerm = db.prepare('INSERT OR IGNORE INTO permissions (id, description) VALUES (?, ?)');
    insertPerm.run('personnel.status.read.basic', '基本的な身分状態（出勤対象か否か）の閲覧');
    insertPerm.run('personnel.status.read.restricted', 'センシティブな人事身分詳細（休職・停職・発令番号等）の閲覧');
    insertPerm.run('personnel.status.manage', '人事身分状態の登録・更新・復職コマンド実行');
    insertPerm.run('workpattern.manage', '勤務形態・育児短時間スケジュールの管理');
    insertPerm.run('attendance.read', '出勤簿データの閲覧');
    insertPerm.run('attendance.finalize', '出勤簿の月次確定・公印決裁 (Snapshot作成)');
    insertPerm.run('attendance.reconfirm', '出勤簿の再確定決裁');
    insertPerm.run('policy.read', '制度ルールマスタの参照');
    insertPerm.run('policy.manage', '制度ルールマスタの管理');
    insertPerm.run('audit.read', 'セキュリティ監査ログの閲覧');
    insertPerm.run('system.manage', 'システム保守・バックアップ管理');

    const insertRolePerm = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)');
    // PRINCIPAL (校長)
    insertRolePerm.run('PRINCIPAL', 'personnel.status.read.basic');
    insertRolePerm.run('PRINCIPAL', 'personnel.status.read.restricted');
    insertRolePerm.run('PRINCIPAL', 'personnel.status.manage');
    insertRolePerm.run('PRINCIPAL', 'workpattern.manage');
    insertRolePerm.run('PRINCIPAL', 'attendance.read');
    insertRolePerm.run('PRINCIPAL', 'attendance.finalize');
    insertRolePerm.run('PRINCIPAL', 'attendance.reconfirm');
    insertRolePerm.run('PRINCIPAL', 'policy.read');
    insertRolePerm.run('PRINCIPAL', 'policy.manage');
    insertRolePerm.run('PRINCIPAL', 'audit.read');

    // VICE_PRINCIPAL (教頭)
    insertRolePerm.run('VICE_PRINCIPAL', 'personnel.status.read.basic');
    insertRolePerm.run('VICE_PRINCIPAL', 'personnel.status.read.restricted');
    insertRolePerm.run('VICE_PRINCIPAL', 'personnel.status.manage');
    insertRolePerm.run('VICE_PRINCIPAL', 'workpattern.manage');
    insertRolePerm.run('VICE_PRINCIPAL', 'attendance.read');
    insertRolePerm.run('VICE_PRINCIPAL', 'policy.read');

    // OFFICE (事務)
    insertRolePerm.run('OFFICE', 'personnel.status.read.basic');
    insertRolePerm.run('OFFICE', 'personnel.status.manage');
    insertRolePerm.run('OFFICE', 'workpattern.manage');
    insertRolePerm.run('OFFICE', 'attendance.read');
    insertRolePerm.run('OFFICE', 'policy.read');

    // TEACHER (一般教員)
    insertRolePerm.run('TEACHER', 'personnel.status.read.basic');
    insertRolePerm.run('TEACHER', 'attendance.read');
    insertRolePerm.run('TEACHER', 'policy.read');

    // ADMIN (システム管理者: 人事機密 restricted は意図的に付与しない)
    insertRolePerm.run('ADMIN', 'system.manage');
    insertRolePerm.run('ADMIN', 'audit.read');
    insertRolePerm.run('ADMIN', 'policy.manage');
    insertRolePerm.run('ADMIN', 'policy.read');

    // 必須 PolicyRules の初期マスタ保証
    const insertPolicy = db.prepare(`
      INSERT OR IGNORE INTO policy_rules (
        policy_code, authority_id, version, official_name, display_code, aggregation_category, max_minutes_per_day, effective_from, effective_to, rule_definition_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertPolicy.run('CHILDCARE_LEAVE', 'DEFAULT_MUNICIPALITY', '2026.1', '育児休業', '育', 'CHILDCARE_LEAVE', 0, '2026-04-01', '9999-12-31', JSON.stringify({ isFullExempt: true }));
    insertPolicy.run('CHILDCARE_SHORT_TIME', 'DEFAULT_MUNICIPALITY', '2026.1', '育児短時間勤務', '育短', 'WORKED', 0, '2026-04-01', '9999-12-31', JSON.stringify({ isWorkPattern: true }));
    insertPolicy.run('PARTIAL_CHILDCARE_LEAVE', 'DEFAULT_MUNICIPALITY', '2026.1', '育児部分休業', '部', 'PARTIAL_NON_WORK', 120, '2026-04-01', '9999-12-31', JSON.stringify({ maxMinutesPerDay: 120 }));
    insertPolicy.run('SUSPENSION', 'DEFAULT_MUNICIPALITY', '2026.1', '分限休職', '休', 'SUSPENSION_NON_WORK', 0, '2026-04-01', '9999-12-31', JSON.stringify({ isFullExempt: true }));
    insertPolicy.run('DISCIPLINARY_SUSPENSION', 'DEFAULT_MUNICIPALITY', '2026.1', '停職', '停', 'DISCIPLINARY_SUSPENSION', 0, '2026-04-01', '9999-12-31', JSON.stringify({ isFullExempt: true }));
  }
};
