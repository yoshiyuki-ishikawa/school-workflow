import { Migration } from './migrator';
import { Database } from 'better-sqlite3';

/**
 * Migration 017: 大規模校向け多段階承認・可変長ステップ駆動ワークフロー基盤
 * 
 * 1. positions テーブル新設 (役職・職階)
 * 2. user_positions テーブル新設 (ユーザー所属役職・期間)
 * 3. approval_route_steps に selector_type, selector_value を追加
 * 4. application_approval_steps に完全スナップショットカラムを追加
 *    (step_key, step_label_snapshot, selector_type_snapshot, selector_value_snapshot,
 *     approver_user_id_snapshot, approver_name_snapshot, approver_position_code_snapshot, approver_position_name_snapshot)
 * 5. 標準Positionマスタおよび大規模校用4段階ルート (id: 3) のシード投入
 */
export const migration017: Migration = {
  version: 17,
  name: 'position_and_flexible_approval_route_support',
  up: (db: Database) => {
    // 1. positions テーブル新設
    db.exec(`
      CREATE TABLE IF NOT EXISTS positions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        rank_order INTEGER NOT NULL,
        description TEXT
      );
    `);

    // 2. user_positions テーブル新設
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        position_id TEXT NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
        is_primary INTEGER NOT NULL DEFAULT 1,
        effective_from TEXT NOT NULL,
        effective_to TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
        updated_at TEXT NOT NULL DEFAULT (DATETIME('now')),
        UNIQUE(user_id, position_id, effective_from)
      );
    `);

    // 3. approval_route_steps の改修
    const routeStepCols = db.prepare('PRAGMA table_info(approval_route_steps)').all() as { name: string }[];
    const routeStepColNames = new Set(routeStepCols.map((c) => c.name));

    if (!routeStepColNames.has('selector_type')) {
      db.exec("ALTER TABLE approval_route_steps ADD COLUMN selector_type TEXT NOT NULL DEFAULT 'ROLE'");
    }
    if (!routeStepColNames.has('selector_value')) {
      db.exec("ALTER TABLE approval_route_steps ADD COLUMN selector_value TEXT NOT NULL DEFAULT ''");
    }
    if (!routeStepColNames.has('step_key')) {
      db.exec("ALTER TABLE approval_route_steps ADD COLUMN step_key TEXT NOT NULL DEFAULT ''");
    }

    // 既存データの selector_type / selector_value 補完
    db.exec(`
      UPDATE approval_route_steps
      SET selector_type = 'ROLE', selector_value = required_role_id
      WHERE selector_value = '' OR selector_value IS NULL;
    `);

    // 4. application_approval_steps の完全スナップショットカラム追加
    const appStepCols = db.prepare('PRAGMA table_info(application_approval_steps)').all() as { name: string }[];
    const appStepColNames = new Set(appStepCols.map((c) => c.name));

    if (!appStepColNames.has('step_key')) {
      db.exec("ALTER TABLE application_approval_steps ADD COLUMN step_key TEXT");
    }
    if (!appStepColNames.has('step_label_snapshot')) {
      db.exec("ALTER TABLE application_approval_steps ADD COLUMN step_label_snapshot TEXT NOT NULL DEFAULT ''");
    }
    if (!appStepColNames.has('selector_type_snapshot')) {
      db.exec("ALTER TABLE application_approval_steps ADD COLUMN selector_type_snapshot TEXT NOT NULL DEFAULT 'ROLE'");
    }
    if (!appStepColNames.has('selector_value_snapshot')) {
      db.exec("ALTER TABLE application_approval_steps ADD COLUMN selector_value_snapshot TEXT NOT NULL DEFAULT ''");
    }
    if (!appStepColNames.has('approver_user_id_snapshot')) {
      db.exec("ALTER TABLE application_approval_steps ADD COLUMN approver_user_id_snapshot INTEGER REFERENCES users(id)");
    }
    if (!appStepColNames.has('approver_name_snapshot')) {
      db.exec("ALTER TABLE application_approval_steps ADD COLUMN approver_name_snapshot TEXT NOT NULL DEFAULT ''");
    }
    if (!appStepColNames.has('approver_position_code_snapshot')) {
      db.exec("ALTER TABLE application_approval_steps ADD COLUMN approver_position_code_snapshot TEXT");
    }
    if (!appStepColNames.has('approver_position_name_snapshot')) {
      db.exec("ALTER TABLE application_approval_steps ADD COLUMN approver_position_name_snapshot TEXT");
    }

    // 既存レコードの Snapshot 補完
    db.exec(`
      UPDATE application_approval_steps
      SET step_label_snapshot = step_name,
          selector_type_snapshot = 'ROLE',
          selector_value_snapshot = required_role_id,
          approver_user_id_snapshot = COALESCE(assigned_user_id, action_by_user_id),
          approver_name_snapshot = COALESCE(action_user_display_name, '')
      WHERE step_label_snapshot = '' OR step_label_snapshot IS NULL;
    `);

    // 5. 標準Positionマスタ投入
    const insertPos = db.prepare('INSERT OR IGNORE INTO positions (id, name, rank_order, description) VALUES (?, ?, ?, ?)');
    insertPos.run('CHIEF_TEACHER', '教務主任', 40, '校務分掌統括・教務管理');
    insertPos.run('VICE_PRINCIPAL_1', '第1教頭', 20, '主幹教頭・学校運営統括補佐');
    insertPos.run('VICE_PRINCIPAL_2', '第2教頭', 25, '副教頭・教務・生徒指導統括補佐');
    insertPos.run('PRINCIPAL', '校長', 10, '学校代表・最終決裁者');
    insertPos.run('OFFICE_HEAD', '事務主幹', 30, '事務室統括・財務服務管理');

    // 6. 大規模校用4段階承認ルート (id: 3) の追加
    const existingRoute3 = db.prepare('SELECT id FROM approval_routes WHERE id = 3').get();
    if (!existingRoute3) {
      db.prepare('INSERT INTO approval_routes (id, name, description) VALUES (?, ?, ?)').run(
        3,
        '大規模校用4段階決裁ルート (教務主任 → 第1教頭 → 第2教頭 → 校長)',
        '大規模校における標準4段階決裁フロー'
      );
    }
    db.prepare('DELETE FROM approval_route_steps WHERE route_id = 3').run();
    const insertStep3 = db.prepare(`
      INSERT INTO approval_route_steps (route_id, step_order, step_name, step_key, required_role_id, selector_type, selector_value)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertStep3.run(3, 1, '教務主任確認', 'CHIEF_TEACHER_STEP', 'TEACHER', 'POSITION', 'CHIEF_TEACHER');
    insertStep3.run(3, 2, '第1教頭確認', 'VICE_PRINCIPAL_1_STEP', 'VICE_PRINCIPAL', 'POSITION', 'VICE_PRINCIPAL_1');
    insertStep3.run(3, 3, '第2教頭確認', 'VICE_PRINCIPAL_2_STEP', 'VICE_PRINCIPAL', 'POSITION', 'VICE_PRINCIPAL_2');
    insertStep3.run(3, 4, '校長最終決裁', 'PRINCIPAL_STEP', 'PRINCIPAL', 'POSITION', 'PRINCIPAL');
  }
};
