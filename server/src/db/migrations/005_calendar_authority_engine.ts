import { Database as DatabaseType } from 'better-sqlite3';
import { Migration } from './migrator';
import { getServerIsoString } from '../../utils/serverTime';

export const migration005: Migration = {
  version: 5,
  name: '005_calendar_authority_engine',
  up: (db: DatabaseType) => {
    const now = getServerIsoString();

    // 1. calendar_adjustments テーブルの作成
    db.exec(`
      CREATE TABLE IF NOT EXISTS calendar_adjustments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        adjustment_code TEXT NOT NULL UNIQUE,
        scope_type TEXT NOT NULL CHECK(scope_type IN ('ALL', 'USER')),
        user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
        
        adjustment_type TEXT NOT NULL CHECK(adjustment_type IN (
          'WEEK_OFF_TRANSFER',
          'SUBSTITUTE_HOLIDAY',
          'SINGLE_WORKDAY_OVERRIDE',
          'DESIGNATED_NON_WORKDAY'
        )),
        
        reason_code TEXT NOT NULL CHECK(reason_code IN (
          'SCHOOL_EVENT',
          'CLUB_ACTIVITY',
          'OFFICIAL_DUTY',
          'SCHOOL_DESIGNATED_HOLIDAY',
          'OTHER_AUTHORIZED'
        )),
        
        authority_basis TEXT,
        
        source_date TEXT NOT NULL,
        source_duty_status TEXT NOT NULL CHECK(source_duty_status IN ('WORK_REQUIRED', 'NO_WORK_REQUIRED')),
        
        target_date TEXT,
        target_duty_status TEXT CHECK(target_duty_status IN ('WORK_REQUIRED', 'NO_WORK_REQUIRED')),
        
        related_adjustment_id INTEGER REFERENCES calendar_adjustments(id),
        
        event_name TEXT NOT NULL,
        reason TEXT NOT NULL,
        
        status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'CANCELLED')),
        created_by_user_id INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        updated_by_user_id INTEGER REFERENCES users(id),
        updated_at TEXT NOT NULL,
        cancelled_by_user_id INTEGER REFERENCES users(id),
        cancelled_at TEXT,
        cancel_reason TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_cal_adj_lookup ON calendar_adjustments(source_date, target_date, status);
      CREATE INDEX IF NOT EXISTS idx_cal_adj_user_scope ON calendar_adjustments(scope_type, user_id, status);
    `);

    // 2. custom_holidays テーブルの作成
    db.exec(`
      CREATE TABLE IF NOT EXISTS custom_holidays (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        holiday_date TEXT NOT NULL,
        name TEXT NOT NULL,
        holiday_type TEXT NOT NULL CHECK(holiday_type IN ('NATIONAL_LEGAL_OVERRIDE', 'SCHOOL_HOLIDAY', 'MUNICIPALITY_HOLIDAY')),
        source TEXT NOT NULL CHECK(source IN ('SYSTEM_CALCULATION_OVERRIDE', 'CUSTOM')),
        is_active INTEGER NOT NULL DEFAULT 1,
        note TEXT,
        created_by_user_id INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(holiday_date, holiday_type)
      );

      CREATE INDEX IF NOT EXISTS idx_custom_holidays_date ON custom_holidays(holiday_date, is_active);
    `);

    // 3. 既存の calendar_overrides データがあれば calendar_adjustments へ安全移行
    try {
      const oldOverrides = db.prepare("SELECT * FROM calendar_overrides").all() as any[];
      if (oldOverrides && oldOverrides.length > 0) {
        const adminUser = db.prepare("SELECT id FROM users ORDER BY id ASC LIMIT 1").get() as any;
        const fallbackUserId = adminUser ? adminUser.id : 1;

        let seq = 1;
        for (const old of oldOverrides) {
          const adjCode = `ADJ-MIGRATED-${seq.toString().padStart(4, '0')}`;
          seq++;

          let adjType = 'SINGLE_WORKDAY_OVERRIDE';
          let reasonCode = 'SCHOOL_EVENT';
          let sourceDutyStatus = 'WORK_REQUIRED';

          if (old.override_type === 'WORKDAY') {
            adjType = 'SINGLE_WORKDAY_OVERRIDE';
            reasonCode = 'SCHOOL_EVENT';
            sourceDutyStatus = 'WORK_REQUIRED';
          } else if (old.override_type === 'WEEK_OFF') {
            adjType = 'DESIGNATED_NON_WORKDAY';
            reasonCode = 'SCHOOL_DESIGNATED_HOLIDAY';
            sourceDutyStatus = 'NO_WORK_REQUIRED';
          } else if (old.override_type === 'SUBSTITUTE_HOLIDAY') {
            adjType = 'DESIGNATED_NON_WORKDAY';
            reasonCode = 'OTHER_AUTHORIZED';
            sourceDutyStatus = 'NO_WORK_REQUIRED';
          } else if (old.override_type === 'HOLIDAY') {
            adjType = 'DESIGNATED_NON_WORKDAY';
            reasonCode = 'SCHOOL_DESIGNATED_HOLIDAY';
            sourceDutyStatus = 'NO_WORK_REQUIRED';
          }

          db.prepare(`
            INSERT INTO calendar_adjustments (
              adjustment_code, scope_type, user_id, adjustment_type, reason_code,
              source_date, source_duty_status, event_name, reason,
              status, created_by_user_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)
          `).run(
            adjCode,
            old.scope || 'ALL',
            old.scope === 'USER' ? old.user_id : null,
            adjType,
            reasonCode,
            old.date,
            sourceDutyStatus,
            old.reason || '旧設定移行',
            old.reason || '旧設定移行',
            fallbackUserId,
            old.created_at || now,
            now
          );
        }
      }
    } catch {
      // calendar_overrides が存在しない場合はスキップ
    }
  },
};
