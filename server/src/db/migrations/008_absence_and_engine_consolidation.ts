import { Database as DatabaseType } from 'better-sqlite3';
import { Migration } from './migrator';
import { getServerIsoString } from '../../utils/serverTime';

export const migration008: Migration = {
  version: 8,
  name: '008_absence_and_engine_consolidation',
  up: (db: DatabaseType) => {
    // 1. absences テーブル作成
    db.exec(`
      CREATE TABLE IF NOT EXISTS absences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        absence_type TEXT NOT NULL CHECK(absence_type IN ('FULL_DAY', 'HOURLY')),
        target_date TEXT NOT NULL,
        start_time TEXT,
        end_time TEXT,
        duration_minutes INTEGER NOT NULL DEFAULT 0,
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK(status IN ('DRAFT', 'CONFIRMED', 'CANCELLED', 'CORRECTED')),
        
        -- 事後訂正情報
        correction_target_type TEXT CHECK(correction_target_type IN ('LEAVE_ANNUAL', 'LEAVE_SICK', 'LEAVE_SPECIAL', 'LEAVE_DUTY_EXEMPT', 'OTHER')),
        corrected_application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL,
        correction_reason TEXT,
        corrected_by_user_id INTEGER REFERENCES users(id),
        corrected_at TEXT,
        
        -- 登録・確定者
        registered_by_user_id INTEGER NOT NULL REFERENCES users(id),
        confirmed_by_user_id INTEGER REFERENCES users(id),
        cancelled_by_user_id INTEGER REFERENCES users(id),
        cancelled_at TEXT,
        cancel_reason TEXT,
        
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        
        CHECK (
          (status = 'DRAFT' AND confirmed_by_user_id IS NULL) OR
          (status IN ('CONFIRMED', 'CANCELLED', 'CORRECTED') AND confirmed_by_user_id IS NOT NULL)
        ),
        CHECK (
          absence_type = 'FULL_DAY' OR
          (start_time IS NOT NULL AND end_time IS NOT NULL AND start_time < end_time)
        )
      );

      CREATE INDEX IF NOT EXISTS idx_absences_user_date ON absences(user_id, target_date);
      CREATE INDEX IF NOT EXISTS idx_absences_status ON absences(status);
    `);

    // 2. 欠勤関連 Scope パーミッションの登録
    const insertPerm = db.prepare('INSERT OR IGNORE INTO permissions (id, description) VALUES (?, ?)');
    insertPerm.run('absence.read.self', '自分自身の欠勤結果の閲覧 (出勤簿上の表示・集計)');
    insertPerm.run('absence.read.managed', '管理対象職員の欠勤一覧・理由・訂正履歴の完全閲覧');
    insertPerm.run('absence.manage', '欠勤の新規登録・確定・編集・取消');
    insertPerm.run('absence.correct', '欠勤から承認済休暇への事後訂正');

    // 3. ロールへのパーミッション付与
    const insertRolePerm = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)');
    
    // 校長 (PRINCIPAL)
    insertRolePerm.run('PRINCIPAL', 'absence.read.self');
    insertRolePerm.run('PRINCIPAL', 'absence.read.managed');
    insertRolePerm.run('PRINCIPAL', 'absence.manage');
    insertRolePerm.run('PRINCIPAL', 'absence.correct');

    // 教頭 (VICE_PRINCIPAL)
    insertRolePerm.run('VICE_PRINCIPAL', 'absence.read.self');
    insertRolePerm.run('VICE_PRINCIPAL', 'absence.read.managed');
    insertRolePerm.run('VICE_PRINCIPAL', 'absence.manage');
    insertRolePerm.run('VICE_PRINCIPAL', 'absence.correct');

    // 事務室 (OFFICE)
    insertRolePerm.run('OFFICE', 'absence.read.self');
    insertRolePerm.run('OFFICE', 'absence.read.managed');
    insertRolePerm.run('OFFICE', 'absence.manage');
    insertRolePerm.run('OFFICE', 'absence.correct');

    // 一般教員 (TEACHER)
    insertRolePerm.run('TEACHER', 'absence.read.self');

    // 管理者 (ADMIN)
    insertRolePerm.run('ADMIN', 'absence.read.self');
    insertRolePerm.run('ADMIN', 'absence.read.managed');
    insertRolePerm.run('ADMIN', 'absence.manage');
    insertRolePerm.run('ADMIN', 'absence.correct');
  }
};
