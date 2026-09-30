import { Database as DatabaseType } from 'better-sqlite3';
import { Migration } from './migrator';

export const migration032: Migration = {
  version: 32,
  name: '032_daily_work_schedule_production_contract',
  up: (db: DatabaseType) => {
    // 1. 日付個別オーバーライド用カラム追加 (Pilot P0)
    const calCols = db.prepare('PRAGMA table_info(calendar_adjustments)').all() as { name: string }[];
    const calColNames = new Set(calCols.map((c) => c.name));
    if (!calColNames.has('schedule_override_json')) {
      db.exec(`
        ALTER TABLE calendar_adjustments
        ADD COLUMN schedule_override_json TEXT;
      `);
    }

    // 2. 育児短時間勤務等の法令承認コード用カラム追加 (Policy/Audit Fact)
    const uwpCols = db.prepare('PRAGMA table_info(user_work_patterns)').all() as { name: string }[];
    const uwpColNames = new Set(uwpCols.map((c) => c.name));
    if (!uwpColNames.has('statutory_pattern_code')) {
      db.exec(`
        ALTER TABLE user_work_patterns
        ADD COLUMN statutory_pattern_code TEXT CHECK(
          statutory_pattern_code IS NULL OR 
          statutory_pattern_code IN ('CST_01', 'CST_02', 'CST_03', 'CST_04')
        );
      `);
    }
  }
};
