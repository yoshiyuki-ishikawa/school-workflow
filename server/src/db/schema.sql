-- ====================================================================
-- 学校業務ワークフロー基盤 データベーススキーマ (SQLite 3)
-- ====================================================================

-- 1. ユーザーマスタ
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    department TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);

-- 2. ロールマスタ
CREATE TABLE IF NOT EXISTS roles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
);

-- 3. ユーザー・ロール紐付け
CREATE TABLE IF NOT EXISTS user_roles (
    user_id INTEGER NOT NULL,
    role_id TEXT NOT NULL,
    PRIMARY KEY (user_id, role_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
);

-- 4. 承認ルートマスタ
CREATE TABLE IF NOT EXISTS approval_routes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT
);

-- 5. 承認ルートステップマスタ
CREATE TABLE IF NOT EXISTS approval_route_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_id INTEGER NOT NULL,
    step_order INTEGER NOT NULL,
    step_name TEXT NOT NULL,
    required_role_id TEXT NOT NULL,
    assigned_user_id INTEGER,
    FOREIGN KEY (route_id) REFERENCES approval_routes(id) ON DELETE CASCADE,
    FOREIGN KEY (required_role_id) REFERENCES roles(id),
    FOREIGN KEY (assigned_user_id) REFERENCES users(id)
);

-- 6. 申請種別マスタ
CREATE TABLE IF NOT EXISTS application_types (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    default_route_id INTEGER NOT NULL,
    FOREIGN KEY (default_route_id) REFERENCES approval_routes(id)
);

-- 7. 申請トランザクション
CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type_id TEXT NOT NULL,
    applicant_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    form_data TEXT NOT NULL, -- JSON
    current_status TEXT NOT NULL, -- DRAFT, SUBMITTED, FIRST_APPROVED, FINAL_APPROVED, RETURNED, REJECTED, WITHDRAWN
    current_step_order INTEGER NOT NULL DEFAULT 1,
    version INTEGER NOT NULL DEFAULT 1, -- Optimistic Locking
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (type_id) REFERENCES application_types(id),
    FOREIGN KEY (applicant_id) REFERENCES users(id)
);

-- 8. 申請承認ステップ（スナップショット）
CREATE TABLE IF NOT EXISTS application_approval_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL,
    step_order INTEGER NOT NULL,
    step_name TEXT NOT NULL,
    required_role_id TEXT NOT NULL,
    assigned_user_id INTEGER,
    status TEXT NOT NULL DEFAULT 'WAITING', -- WAITING, PENDING, APPROVED, RETURNED, REJECTED
    action_by_user_id INTEGER,
    comment TEXT,
    acted_at TEXT,
    FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE,
    FOREIGN KEY (required_role_id) REFERENCES roles(id),
    FOREIGN KEY (assigned_user_id) REFERENCES users(id),
    FOREIGN KEY (action_by_user_id) REFERENCES users(id)
);

-- 9. 監査ログ（不変ログ・トランザクション分離永続化）
CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    user_id INTEGER,
    username TEXT NOT NULL,
    role_snapshot TEXT,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    before_state TEXT,
    after_state TEXT,
    comment TEXT,
    ip_address TEXT NOT NULL,
    user_agent TEXT,
    is_success INTEGER NOT NULL DEFAULT 1
);

-- 10. セッションストア
CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expired INTEGER NOT NULL
);

-- インデックス作成
CREATE INDEX IF NOT EXISTS idx_applications_applicant ON applications(applicant_id);
CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(current_status);
CREATE INDEX IF NOT EXISTS idx_app_steps_application ON application_approval_steps(application_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired);
