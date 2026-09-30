import crypto from 'crypto';
import { Database as DatabaseType } from 'better-sqlite3';
import { Migration } from './migrator';

export const migration002: Migration = {
  version: 2,
  name: 'step1_school_service_engine',
  up: (db: DatabaseType) => {
    // -------------------------------------------------------------
    // 1. users テーブルの拡張 (family_name, given_name, stamp_name)
    // -------------------------------------------------------------
    const userCols = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
    const userColNames = new Set(userCols.map((c) => c.name));

    if (!userColNames.has('family_name')) {
      db.exec(`ALTER TABLE users ADD COLUMN family_name TEXT NOT NULL DEFAULT ''`);
    }
    if (!userColNames.has('given_name')) {
      db.exec(`ALTER TABLE users ADD COLUMN given_name TEXT NOT NULL DEFAULT ''`);
    }
    if (!userColNames.has('stamp_name')) {
      db.exec(`ALTER TABLE users ADD COLUMN stamp_name TEXT NOT NULL DEFAULT ''`);
    }

    // 既存ユーザーの氏名・印影名の自動補完
    const existingUsers = db.prepare('SELECT id, display_name, stamp_name FROM users').all() as {
      id: number;
      display_name: string;
      stamp_name: string;
    }[];

    const updateUserStamp = db.prepare(`
      UPDATE users
      SET family_name = ?, given_name = ?, stamp_name = ?
      WHERE id = ?
    `);

    for (const u of existingUsers) {
      if (!u.stamp_name || u.stamp_name.trim() === '') {
        // 例: "山田 太郎 (教員A)" -> clean "山田 太郎"
        const cleanName = u.display_name.replace(/\s*\(.*?\)\s*/g, '').trim();
        const parts = cleanName.split(/[\s　]+/);
        let family = '';
        let given = '';
        let stamp = '';

        if (parts.length >= 2) {
          family = parts[0];
          given = parts.slice(1).join(' ');
          stamp = family;
        } else if (parts.length === 1 && parts[0].length > 0) {
          family = parts[0];
          stamp = parts[0].slice(0, 4); // 最大4文字
        } else {
          family = u.display_name.slice(0, 4);
          stamp = family;
        }

        updateUserStamp.run(family, given, stamp, u.id);
      }
    }

    // -------------------------------------------------------------
    // 2. trip_events テーブル作成 (出張共通イベント Source of Truth)
    // -------------------------------------------------------------
    db.exec(`
      CREATE TABLE IF NOT EXISTS trip_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        purpose TEXT NOT NULL,
        destination TEXT NOT NULL,
        start_at TEXT NOT NULL,
        end_at TEXT NOT NULL,
        transport TEXT NOT NULL DEFAULT '',
        notes TEXT,
        created_by_user_id INTEGER NOT NULL REFERENCES users(id),
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    // -------------------------------------------------------------
    // 3. trip_event_members テーブル作成 (出張イベント参加者マッピング)
    // -------------------------------------------------------------
    db.exec(`
      CREATE TABLE IF NOT EXISTS trip_event_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trip_event_id INTEGER NOT NULL REFERENCES trip_events(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id),
        application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL,
        participation_status TEXT NOT NULL DEFAULT 'JOINED',
        individual_notes TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(trip_event_id, user_id)
      );
    `);

    // -------------------------------------------------------------
    // 4. official_form_templates テーブル作成 (自治体・任命権者別テンプレート)
    // -------------------------------------------------------------
    db.exec(`
      CREATE TABLE IF NOT EXISTS official_form_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        authority_id TEXT NOT NULL DEFAULT 'DEFAULT_MUNICIPALITY',
        form_code TEXT NOT NULL,
        form_name TEXT NOT NULL,
        form_type TEXT NOT NULL,
        version TEXT NOT NULL DEFAULT '1.0',
        effective_from TEXT NOT NULL,
        effective_to TEXT,
        paper_size TEXT NOT NULL DEFAULT 'A4',
        orientation TEXT NOT NULL DEFAULT 'PORTRAIT',
        template_definition TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        UNIQUE(authority_id, form_code, version)
      );
    `);

    // -------------------------------------------------------------
    // 5. applications テーブルの拡張 (Actor/Subject 2軸分離 + Snapshot)
    // -------------------------------------------------------------
    const appCols = db.prepare('PRAGMA table_info(applications)').all() as { name: string }[];
    const appColNames = new Set(appCols.map((c) => c.name));

    if (!appColNames.has('subject_user_id')) {
      db.exec(`ALTER TABLE applications ADD COLUMN subject_user_id INTEGER REFERENCES users(id)`);
    }
    if (!appColNames.has('submitted_by_user_id')) {
      db.exec(`ALTER TABLE applications ADD COLUMN submitted_by_user_id INTEGER REFERENCES users(id)`);
    }
    if (!appColNames.has('submission_actor_type')) {
      db.exec(`ALTER TABLE applications ADD COLUMN submission_actor_type TEXT NOT NULL DEFAULT 'SELF'`);
    }
    if (!appColNames.has('submission_mode')) {
      db.exec(`ALTER TABLE applications ADD COLUMN submission_mode TEXT NOT NULL DEFAULT 'SINGLE'`);
    }
    if (!appColNames.has('trip_event_id')) {
      db.exec(`ALTER TABLE applications ADD COLUMN trip_event_id INTEGER REFERENCES trip_events(id)`);
    }

    // 既存 applications レコードのデータ補完（applicant_id からの安全な移行）
    if (appColNames.has('applicant_id')) {
      db.exec(`
        UPDATE applications
        SET
          subject_user_id = COALESCE(subject_user_id, applicant_id),
          submitted_by_user_id = COALESCE(submitted_by_user_id, applicant_id),
          submission_actor_type = COALESCE(submission_actor_type, 'SELF'),
          submission_mode = COALESCE(submission_mode, 'SINGLE')
        WHERE subject_user_id IS NULL OR submitted_by_user_id IS NULL;
      `);
    }

    // -------------------------------------------------------------
    // 6. audit_logs テーブルの拡張 (改ざん検知ハッシュ + 2軸属性)
    // -------------------------------------------------------------
    const auditCols = db.prepare('PRAGMA table_info(audit_logs)').all() as { name: string }[];
    const auditColNames = new Set(auditCols.map((c) => c.name));

    if (!auditColNames.has('event_id')) {
      db.exec(`ALTER TABLE audit_logs ADD COLUMN event_id TEXT`);
    }
    if (!auditColNames.has('server_timestamp')) {
      db.exec(`ALTER TABLE audit_logs ADD COLUMN server_timestamp TEXT`);
    }
    if (!auditColNames.has('actor_user_id')) {
      db.exec(`ALTER TABLE audit_logs ADD COLUMN actor_user_id INTEGER`);
    }
    if (!auditColNames.has('actor_username')) {
      db.exec(`ALTER TABLE audit_logs ADD COLUMN actor_username TEXT`);
    }
    if (!auditColNames.has('subject_user_id')) {
      db.exec(`ALTER TABLE audit_logs ADD COLUMN subject_user_id INTEGER`);
    }
    if (!auditColNames.has('submission_actor_type')) {
      db.exec(`ALTER TABLE audit_logs ADD COLUMN submission_actor_type TEXT`);
    }
    if (!auditColNames.has('submission_mode')) {
      db.exec(`ALTER TABLE audit_logs ADD COLUMN submission_mode TEXT`);
    }
    if (!auditColNames.has('entity_type')) {
      db.exec(`ALTER TABLE audit_logs ADD COLUMN entity_type TEXT`);
    }
    if (!auditColNames.has('entity_id')) {
      db.exec(`ALTER TABLE audit_logs ADD COLUMN entity_id TEXT`);
    }
    if (!auditColNames.has('entity_version')) {
      db.exec(`ALTER TABLE audit_logs ADD COLUMN entity_version INTEGER`);
    }
    if (!auditColNames.has('request_id')) {
      db.exec(`ALTER TABLE audit_logs ADD COLUMN request_id TEXT`);
    }
    if (!auditColNames.has('metadata')) {
      db.exec(`ALTER TABLE audit_logs ADD COLUMN metadata TEXT`);
    }
    if (!auditColNames.has('prev_hash')) {
      db.exec(`ALTER TABLE audit_logs ADD COLUMN prev_hash TEXT`);
    }
    if (!auditColNames.has('event_hash')) {
      db.exec(`ALTER TABLE audit_logs ADD COLUMN event_hash TEXT`);
    }

    // 既存ログの補完 (旧スキーマの user_id カラムが存在する場合のみ取得)
    if (auditColNames.has('user_id')) {
      const timestampCol = auditColNames.has('timestamp') ? 'timestamp' : 'server_timestamp';
      const existingLogs = db.prepare(`SELECT id, ${timestampCol} as timestamp, user_id, action, target_type, target_id FROM audit_logs WHERE event_id IS NULL`).all() as any[];

      const updateLog = db.prepare(`
        UPDATE audit_logs
        SET
          event_id = ?,
          actor_user_id = ?,
          subject_user_id = ?,
          entity_type = ?,
          entity_id = ?,
          submission_actor_type = 'SELF',
          submission_mode = 'SINGLE',
          event_hash = ?
        WHERE id = ?
      `);

      for (const log of existingLogs) {
        const eventId = crypto.randomUUID();
        const entityType = log.target_type || 'APPLICATION';
        const entityId = log.target_id || '';
        const actorId = log.user_id || 0;
        const hashPayload = `${eventId}:${log.timestamp}:${actorId}:${log.action}:${entityType}:${entityId}`;
        const eventHash = crypto.createHash('sha256').update(hashPayload).digest('hex');

        updateLog.run(eventId, actorId, actorId, entityType, entityId, eventHash, log.id);
      }
    }
  },
};
