import { Database as DatabaseType } from 'better-sqlite3';
import { Migration } from './migrator';
import { getServerIsoString } from '../../utils/serverTime';

export const migration006: Migration = {
  version: 6,
  name: '006_user_work_patterns',
  up: (db: DatabaseType) => {
    const now = getServerIsoString();

    // 1. user_work_patterns テーブルの作成
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_work_patterns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        pattern_name TEXT NOT NULL,
        pattern_type TEXT NOT NULL CHECK(pattern_type IN ('STANDARD_FULLTIME', 'SHORT_TIME', 'CUSTOM')),
        
        effective_from TEXT NOT NULL,
        effective_to TEXT NOT NULL,
        
        weekly_off_days TEXT NOT NULL,
        schedule_details_json TEXT,
        weekly_total_minutes INTEGER NOT NULL DEFAULT 2325,
        
        memo TEXT,
        record_origin TEXT NOT NULL DEFAULT 'ADMIN_CONFIGURED' CHECK(record_origin IN ('MIGRATION_INITIAL', 'ADMIN_CONFIGURED', 'IMPORT')),
        
        created_by_user_id INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        updated_by_user_id INTEGER REFERENCES users(id),
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_uwp_user_period ON user_work_patterns(user_id, effective_from, effective_to);
    `);

    // 2. 既存教職員全員への安全な初期勤務パターン投入 (本システム稼働年度 2026-04-01 基準)
    const users = db.prepare('SELECT id, display_name FROM users').all() as { id: number; display_name: string }[];
    const adminUser = db.prepare(`SELECT u.id FROM users u JOIN user_roles ur ON u.id = ur.user_id WHERE ur.role_id = 'ADMIN' LIMIT 1`).get() as { id: number } | undefined;
    const adminId = adminUser ? adminUser.id : (users.length > 0 ? users[0].id : 1);

    const defaultScheduleJson = JSON.stringify({
      "0": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null },
      "1": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:15", "endTime": "16:45" },
      "2": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:15", "endTime": "16:45" },
      "3": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:15", "endTime": "16:45" },
      "4": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:15", "endTime": "16:45" },
      "5": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:15", "endTime": "16:45" },
      "6": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null }
    });

    const insertPattern = db.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, schedule_details_json, weekly_total_minutes,
        memo, record_origin, created_by_user_id, created_at, updated_by_user_id, updated_at
      ) VALUES (?, '通常フルタイム (週5日・土日週休)', 'STANDARD_FULLTIME', '2026-04-01', '9999-12-31', '0,6', ?, 2325, 'システム導入初期マイグレーション自動生成', 'MIGRATION_INITIAL', ?, ?, ?, ?)
    `);

    for (const u of users) {
      insertPattern.run(u.id, defaultScheduleJson, adminId, now, adminId, now);
    }
  },
};
