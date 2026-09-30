import { Migration } from './migrator';
import { Database } from 'better-sqlite3';

/**
 * Migration 028: Password Lifecycle Architecture (AD-PW-01 ~ AD-PW-05)
 * 
 * 1. users テーブルへの Password Lifecycle 管理カラム追加:
 *    - must_change_password INTEGER NOT NULL DEFAULT 0
 *    - auth_version INTEGER NOT NULL DEFAULT 1
 *    - password_changed_at TEXT
 * 2. user.credential.reset パーミッションの追加と ADMIN ロールへの割当
 */
export const migration028: Migration = {
  version: 28,
  name: 'password_lifecycle_and_permission',
  up: (db: Database) => {
    // 1. users テーブルカラム存在チェックと追加
    const userCols = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
    const userColNames = new Set(userCols.map((c) => c.name));

    if (!userColNames.has('must_change_password')) {
      db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;');
    }
    if (!userColNames.has('auth_version')) {
      db.exec('ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1;');
    }
    if (!userColNames.has('password_changed_at')) {
      db.exec('ALTER TABLE users ADD COLUMN password_changed_at TEXT;');
    }

    // 2. permissions & role_permissions
    const insertPerm = db.prepare('INSERT OR IGNORE INTO permissions (id, description) VALUES (?, ?)');
    insertPerm.run('user.credential.reset', '教職員アカウントのパスワード初期化・一時パスワード発行権限');

    const insertRolePerm = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)');
    insertRolePerm.run('ADMIN', 'user.credential.reset');
  },
};
