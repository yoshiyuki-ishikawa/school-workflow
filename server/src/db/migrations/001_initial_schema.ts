import { Database as DatabaseType } from 'better-sqlite3';
import { Migration } from './migrator';

export const migration001: Migration = {
  version: 1,
  name: 'initial_schema_v1_4',
  up: (db: DatabaseType) => {
    db.exec(`
      -- 1. users
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        department TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );

      -- 2. roles
      CREATE TABLE IF NOT EXISTS roles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );

      -- 3. user_roles
      CREATE TABLE IF NOT EXISTS user_roles (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, role_id)
      );

      -- 4. approval_routes
      CREATE TABLE IF NOT EXISTS approval_routes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT
      );

      -- 5. approval_route_steps
      CREATE TABLE IF NOT EXISTS approval_route_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        route_id INTEGER NOT NULL REFERENCES approval_routes(id) ON DELETE CASCADE,
        step_order INTEGER NOT NULL,
        step_name TEXT NOT NULL,
        required_role_id TEXT NOT NULL REFERENCES roles(id),
        assigned_user_id INTEGER REFERENCES users(id)
      );

      -- 6. application_types
      CREATE TABLE IF NOT EXISTS application_types (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        default_route_id INTEGER NOT NULL REFERENCES approval_routes(id)
      );

      -- 7. applications
      CREATE TABLE IF NOT EXISTS applications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type_id TEXT NOT NULL REFERENCES application_types(id),
        applicant_id INTEGER NOT NULL REFERENCES users(id),
        title TEXT NOT NULL,
        form_data TEXT NOT NULL,
        current_status TEXT NOT NULL DEFAULT 'DRAFT',
        current_step_order INTEGER NOT NULL DEFAULT 1,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- 8. application_approval_steps
      CREATE TABLE IF NOT EXISTS application_approval_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        step_order INTEGER NOT NULL,
        step_name TEXT NOT NULL,
        required_role_id TEXT NOT NULL REFERENCES roles(id),
        assigned_user_id INTEGER REFERENCES users(id),
        status TEXT NOT NULL DEFAULT 'WAITING',
        action_by_user_id INTEGER REFERENCES users(id),
        comment TEXT,
        acted_at TEXT
      );

      -- 9. audit_logs
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT,
        timestamp TEXT NOT NULL,
        server_timestamp TEXT,
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

      -- 10. sessions
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expired INTEGER NOT NULL
      );

      -- 11. calendar_overrides
      CREATE TABLE IF NOT EXISTS calendar_overrides (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'ALL',
        user_id INTEGER REFERENCES users(id),
        override_type TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      -- 12. monthly_attendance_approvals
      CREATE TABLE IF NOT EXISTS monthly_attendance_approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        year_month TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'OPEN',
        confirmed_by_user_id INTEGER REFERENCES users(id),
        confirmed_at TEXT,
        comment TEXT,
        UNIQUE(user_id, year_month)
      );
    `);
  },
};
