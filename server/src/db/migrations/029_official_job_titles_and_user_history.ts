import { Migration } from './migrator';
import { Database } from 'better-sqlite3';

/**
 * Migration 029: Extensible Official Job Title SSOT & Historical Snapshot Architecture
 * 
 * 1. official_job_titles: 完全Data-Drivenな正式職名マスタテーブル (物理削除禁止・使用済Semantic Mutation禁止)
 * 2. user_job_titles: 教職員の有効期間付き職名発令履歴テーブル (Temporal Integrity & Overlap Protection)
 * 3. 権限マスタ追加:
 *    - job_title.master.manage (ADMINのみ)
 *    - job_title.assignment.manage (ADMINのみ)
 * 4. 山口県公立学校向け初期デフォルト14職名の投入 (Initial Seed / Closed Enumではない)
 */
export const migration029: Migration = {
  version: 29,
  name: 'official_job_titles_and_user_history',
  up: (db: Database) => {
    // 1. official_job_titles
    db.exec(`
      CREATE TABLE IF NOT EXISTS official_job_titles (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 100,
        is_active INTEGER NOT NULL DEFAULT 1,
        description TEXT,
        created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
        updated_at TEXT NOT NULL DEFAULT (DATETIME('now'))
      );
    `);

    // 2. user_job_titles
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_job_titles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        job_title_id TEXT NOT NULL REFERENCES official_job_titles(id) ON DELETE RESTRICT,
        effective_from TEXT NOT NULL,
        effective_to TEXT NOT NULL,
        order_reference_no TEXT,
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
        updated_at TEXT NOT NULL DEFAULT (DATETIME('now')),
        CHECK (effective_from <= effective_to)
      );

      CREATE INDEX IF NOT EXISTS idx_user_job_titles_lookup 
      ON user_job_titles (user_id, effective_from, effective_to);
    `);

    // 3. Permissions & Role Permissions
    const insertPerm = db.prepare('INSERT OR IGNORE INTO permissions (id, description) VALUES (?, ?)');
    insertPerm.run('job_title.master.manage', '正式職名マスタの作成・更新・新規割当停止の管理権限');
    insertPerm.run('job_title.assignment.manage', '教職員への正式職名発令・履歴登録・訂正権限');

    const insertRolePerm = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)');
    insertRolePerm.run('ADMIN', 'job_title.master.manage');
    insertRolePerm.run('ADMIN', 'job_title.assignment.manage');
    // OFFICE には自動付与しない (PINPOINT-05)

    // 4. Initial Seed (Yamaguchi 14 Job Titles)
    const insertJobTitle = db.prepare(`
      INSERT OR IGNORE INTO official_job_titles (id, code, display_name, sort_order, description)
      VALUES (?, ?, ?, ?, ?)
    `);

    const initialTitles = [
      { id: 'JOB_TITLE_PRINCIPAL', code: 'PRINCIPAL', name: '校長', sort: 10, desc: '学校の校務をつかさどる' },
      { id: 'JOB_TITLE_VICE_PRINCIPAL', code: 'VICE_PRINCIPAL', name: '教頭', sort: 20, desc: '校長を助け、校務を整理し、及び必要に応じ授業をつかさどる' },
      { id: 'JOB_TITLE_TEACHER', code: 'TEACHER', name: '教諭', sort: 30, desc: '児童生徒の教育をつかさどる' },
      { id: 'JOB_TITLE_ASSISTANT_TEACHER', code: 'ASSISTANT_TEACHER', name: '助教諭', sort: 40, desc: '教諭の職務を助ける' },
      { id: 'JOB_TITLE_LECTURER', code: 'LECTURER', name: '講師', sort: 50, desc: '教諭又は助教諭に準ずる職務に従事する' },
      { id: 'JOB_TITLE_NURSE_TEACHER', code: 'NURSE_TEACHER', name: '養護教諭', sort: 60, desc: '児童生徒の養護をつかさどる' },
      { id: 'JOB_TITLE_ASSISTANT_NURSE_TEACHER', code: 'ASSISTANT_NURSE_TEACHER', name: '養護助教諭', sort: 70, desc: '養護教諭の職務を助ける' },
      { id: 'JOB_TITLE_NUTRITION_TEACHER', code: 'NUTRITION_TEACHER', name: '栄養教諭', sort: 80, desc: '児童生徒の栄養の指導及び学校給食の管理をつかさどる' },
      { id: 'JOB_TITLE_NUTRITIONIST', code: 'NUTRITIONIST', name: '学校栄養職員', sort: 90, desc: '学校給食に関する栄養管理等の専門的事務をつかさどる' },
      { id: 'JOB_TITLE_OFFICE_DIRECTOR', code: 'OFFICE_DIRECTOR', name: '事務長', sort: 100, desc: '学校事務を総括し、事務職員その他の職員を指揮監督する' },
      { id: 'JOB_TITLE_HEAD_CLERK', code: 'HEAD_CLERK', name: '主査', sort: 110, desc: '高度の専門的知識及び経験を必要とする学校事務をつかさどる' },
      { id: 'JOB_TITLE_CLERK_DIRECTOR', code: 'CLERK_DIRECTOR', name: '事務主任', sort: 120, desc: '特定の学校事務をつかさどり、事務を整理する' },
      { id: 'JOB_TITLE_SENIOR_CLERK', code: 'SENIOR_CLERK', name: '主任主事', sort: 130, desc: '専門的知識及び経験を必要とする学校事務をつかさどる' },
      { id: 'JOB_TITLE_CLERK', code: 'CLERK', name: '主事', sort: 140, desc: '学校事務をつかさどる' },
    ];

    for (const t of initialTitles) {
      insertJobTitle.run(t.id, t.code, t.name, t.sort, t.desc);
    }
  },
};
