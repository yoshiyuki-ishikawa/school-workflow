import { Migration } from './migrator';
import { Database } from 'better-sqlite3';

/**
 * Migration 009: 山口県勤務条例第15条「介護休暇」および指定期間管理基盤の導入
 * 
 * 1. care_cases テーブル新設 (要介護対象者・介護ケース - 機微情報分離領域)
 * 2. care_periods テーブル新設 (指定期間: 条例第15条)
 * 3. application_types に LEAVE_CARE を登録
 * 4. permissions および role_permissions に care.* パーミッションを登録
 */
export const migration009: Migration = {
  version: 9,
  name: 'care_leave_support',
  up: (db: Database) => {
    // 1. care_cases テーブル作成
    db.exec(`
      CREATE TABLE IF NOT EXISTS care_cases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        recipient_relation TEXT NOT NULL,
        recipient_name TEXT NOT NULL,
        condition_summary TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'ENDED')),
        created_by_user_id INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
        updated_at TEXT NOT NULL DEFAULT (DATETIME('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_care_cases_user ON care_cases(user_id);
    `);

    // 2. care_periods テーブル作成 (指定期間)
    db.exec(`
      CREATE TABLE IF NOT EXISTS care_periods (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        care_case_id INTEGER NOT NULL REFERENCES care_cases(id) ON DELETE RESTRICT,
        period_number INTEGER NOT NULL DEFAULT 1,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'APPROVED' CHECK(status IN ('DRAFT', 'APPROVED', 'ACTIVE', 'EXPIRED', 'CANCELLED')),
        approved_by_user_id INTEGER REFERENCES users(id),
        approved_at TEXT,
        memo TEXT,
        created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
        updated_at TEXT NOT NULL DEFAULT (DATETIME('now')),
        CHECK (start_date <= end_date)
      );

      CREATE INDEX IF NOT EXISTS idx_care_periods_case ON care_periods(care_case_id);
    `);

    // 3. application_types に LEAVE_CARE を登録
    const existingType = db.prepare("SELECT id FROM application_types WHERE id = 'LEAVE_CARE'").get();
    if (!existingType) {
      // 既存 approval_routes から標準休暇ルート (id: 1) を取得
      const route = db.prepare("SELECT id FROM approval_routes WHERE id = 1").get() as { id: number } | undefined;
      const defaultRouteId = route ? route.id : 1;

      db.prepare(`
        INSERT INTO application_types (id, name, description, default_route_id)
        VALUES ('LEAVE_CARE', '介護休暇 (条例第15条)', '要介護状態にある家族を介護するための休暇 (日/半日/1時間単位)', ?)
      `).run(defaultRouteId);
    }

    // 4. パーミッション登録
    const carePermissions = [
      { id: 'care.case.read.self', desc: '自らの介護ケース・指定期間の閲覧' },
      { id: 'care.case.read.managed', desc: '管理下職員の介護ケース・指定期間の閲覧 (機微情報含む)' },
      { id: 'care.case.manage', desc: '介護ケース・指定期間の登録・編集・管理' },
    ];

    const insertPerm = db.prepare('INSERT OR IGNORE INTO permissions (id, description) VALUES (?, ?)');
    for (const p of carePermissions) {
      insertPerm.run(p.id, p.desc);
    }

    // ロールとパーミッションの紐付け
    const insertRolePerm = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)');
    // 一般教員: 自データ閲覧
    insertRolePerm.run('TEACHER', 'care.case.read.self');
    // 教頭: 管理下閲覧・管理
    insertRolePerm.run('VICE_PRINCIPAL', 'care.case.read.self');
    insertRolePerm.run('VICE_PRINCIPAL', 'care.case.read.managed');
    insertRolePerm.run('VICE_PRINCIPAL', 'care.case.manage');
    // 校長: 管理下閲覧・管理
    insertRolePerm.run('PRINCIPAL', 'care.case.read.self');
    insertRolePerm.run('PRINCIPAL', 'care.case.read.managed');
    insertRolePerm.run('PRINCIPAL', 'care.case.manage');
    // 事務室: 管理下閲覧・管理
    insertRolePerm.run('OFFICE', 'care.case.read.self');
    insertRolePerm.run('OFFICE', 'care.case.read.managed');
    insertRolePerm.run('OFFICE', 'care.case.manage');
    // システム管理者: システム管理 (機微閲覧は遮断)
  }
};
