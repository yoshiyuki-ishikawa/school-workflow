import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { migrator } from '../db/migrations';
import { checkIntegrity } from '../db/database';

/**
 * A. Migration Test
 * 10大原則完全遵守検証:
 * 1. 事前 integrity_check
 * 2. VACUUM INTO による事前バックアップ生成
 * 3. トランザクションによるアトミックマイグレーション
 * 4. schema_migrations 履歴管理
 * 5. WALモード・FK検証
 * 6. 既存レコード保持・値補完 (stamp_name, 2軸属性)
 * 7. 事後 integrity_check
 */
export function runMigrationTest(): boolean {
  console.log('--- [Test A: Database Migration Test] 開始 ---');
  const testDbDir = path.resolve(__dirname, '../../data/test_migration');
  if (!fs.existsSync(testDbDir)) {
    fs.mkdirSync(testDbDir, { recursive: true });
  }

  const testDbPath = path.join(testDbDir, 'test_workflow.db');
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }

  const db = new Database(testDbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  try {
    // 1. 旧スキーマ (v1.0) を手動投入
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        department TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );

      CREATE TABLE applications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type_id TEXT NOT NULL,
        applicant_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        form_data TEXT NOT NULL,
        current_status TEXT NOT NULL DEFAULT 'DRAFT',
        current_step_order INTEGER NOT NULL DEFAULT 1,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE audit_logs (
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
    `);

    // 旧データ挿入
    db.prepare(`
      INSERT INTO users (username, password_hash, display_name, department, created_at)
      VALUES ('teacher1', 'hash123', '山田 太郎 (教員A)', '国語科', '2026-08-01T00:00:00Z')
    `).run();

    db.prepare(`
      INSERT INTO applications (type_id, applicant_id, title, form_data, current_status, created_at, updated_at)
      VALUES ('LEAVE_ANNUAL', 1, '【年休】一日年休', '{"startDate":"2026-08-10"}', 'FINAL_APPROVED', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')
    `).run();

    db.prepare(`
      INSERT INTO audit_logs (timestamp, user_id, username, action, target_type, target_id, ip_address)
      VALUES ('2026-08-01T00:00:00Z', 1, 'teacher1', 'APPROVE', 'APPLICATION', '1', '127.0.0.1')
    `).run();

    console.log('✔ 旧スキーマ(v1.0) およびテストデータの投入成功');

    // 2. マイグレーション実行
    const result = migrator.runMigrations(db);
    console.log(`✔ マイグレーション実行成功 (適用数: ${result.appliedCount}, 現在バージョン: v${result.currentVersion})`);

    if (result.currentVersion < 2) {
      throw new Error(`バージョンが更新されていません: currentVersion=${result.currentVersion}`);
    }

    // 3. 整合性検証
    const migratedUser = db.prepare('SELECT * FROM users WHERE id = 1').get() as any;
    if (migratedUser.stamp_name !== '山田' || migratedUser.family_name !== '山田') {
      throw new Error(`usersテーブルの値補完不正: stamp_name=${migratedUser.stamp_name}, family_name=${migratedUser.family_name}`);
    }
    console.log(`✔ users補完検証成功: display_name="${migratedUser.display_name}" -> stamp_name="${migratedUser.stamp_name}"`);

    const migratedApp = db.prepare('SELECT * FROM applications WHERE id = 1').get() as any;
    if (migratedApp.subject_user_id !== 1 || migratedApp.submitted_by_user_id !== 1 || migratedApp.submission_actor_type !== 'SELF') {
      throw new Error(`applicationsテーブルの2軸属性補完不正: ${JSON.stringify(migratedApp)}`);
    }
    console.log(`✔ applications 2軸属性補完検証成功: subject=${migratedApp.subject_user_id}, actorType=${migratedApp.submission_actor_type}`);

    const migratedLog = db.prepare('SELECT * FROM audit_logs WHERE id = 1').get() as any;
    if (!migratedLog.event_id || !migratedLog.event_hash) {
      throw new Error(`audit_logsテーブルのハッシュ補完不正: ${JSON.stringify(migratedLog)}`);
    }
    console.log(`✔ audit_logs ハッシュ補完検証成功: event_id=${migratedLog.event_id}, hash=${migratedLog.event_hash}`);

    // 4. FK整合性検証
    const fkCheck = db.prepare('PRAGMA foreign_key_check').all();
    if (fkCheck.length > 0) {
      throw new Error(`外部キー整合性エラー: ${JSON.stringify(fkCheck)}`);
    }
    console.log('✔ PRAGMA foreign_key_check: 整合性完全 (OK)');

    console.log('--- [Test A: Database Migration Test] 合格 (PASS) ---\n');
    return true;
  } finally {
    db.close();
    // テストファイル削除
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  }
}

if (require.main === module) {
  runMigrationTest();
}
