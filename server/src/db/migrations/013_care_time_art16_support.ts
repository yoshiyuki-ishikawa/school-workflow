import { Migration } from './migrator';
import { Database } from 'better-sqlite3';

/**
 * Migration 013: 山口県勤務条例第16条「介護時間」および第15条「介護休暇」完全準拠対応
 * 
 * 1. application_types に LEAVE_CARE_TIME を登録 (デフォルトルート: 標準休暇ルート 1)
 * 2. policy_rules に確定 ACTIVE Policy を登録:
 *    - LEAVE_CARE (介護休暇: 施行日 1995-04-01 / allowed: ["DAY", "HALF_DAY", "TIME"] / 無給減額)
 *    - LEAVE_CARE_TIME (介護時間: 施行日 2017-01-01 / allowed: ["TIME"] / 30分単位 / 1日最大2h / 無給減額)
 * 3. care_cases テーブルに連続3年追跡用カラムを追加 (care_start_date, care_end_date)
 */
export const migration013: Migration = {
  version: 13,
  name: 'care_time_art16_support',
  up: (db: Database) => {
    // 1. application_types に LEAVE_CARE_TIME を登録
    const existingType = db.prepare("SELECT id FROM application_types WHERE id = 'LEAVE_CARE_TIME'").get();
    if (!existingType) {
      const route = db.prepare("SELECT id FROM approval_routes WHERE id = 1").get() as { id: number } | undefined;
      const defaultRouteId = route ? route.id : 1;

      db.prepare(`
        INSERT INTO application_types (id, name, description, default_route_id)
        VALUES ('LEAVE_CARE_TIME', '介護時間 (条例第16条)', '要介護状態にある家族を介護するための時間 (30分単位 / 1日最大2時間)', ?)
      `).run(defaultRouteId);
    }

    // 2. care_cases にカラム追加 (連続3年管理用)
    try {
      db.exec(`
        ALTER TABLE care_cases ADD COLUMN care_start_date TEXT;
        ALTER TABLE care_cases ADD COLUMN care_end_date TEXT;
      `);
    } catch {
      // 既に存在する場合はスキップ
    }

    // 3. policy_rules に確定 Policy を登録
    const insertPolicy = db.prepare(`
      INSERT OR IGNORE INTO policy_rules (
        policy_code, authority_id, version, official_name, display_code,
        aggregation_category, max_minutes_per_day, effective_from, effective_to,
        rule_definition_json, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);

    // 介護休暇 (条例第15条)
    insertPolicy.run(
      'LEAVE_CARE',
      'DEFAULT_MUNICIPALITY',
      '1995.1',
      '介護休暇 (条例第15条)',
      '介護',
      'CARE_LEAVE',
      240, // 時間単位は1日最大4時間 (240分)
      '1995-04-01',
      '9999-12-31',
      JSON.stringify({
        legalBasis: 'YAMAGUCHI_WORK_ORDINANCE_ART15',
        status: 'ACTIVE',
        isPaid: false,
        salaryDeduction: true,
        allowedDurationUnits: ['DAY', 'HALF_DAY', 'TIME'],
        timeStepMinutes: 60,
        maxTimeMinutesPerDay: 240,
        maxTotalMonths: 6,
        maxPeriods: 3,
        initialMinDays: 14,
        dailyDisplayRule: '介護',
        halfDayDisplayRule: '介護',
        hourlyDisplayRule: '介護',
        halfDayStampSubText: '半日',
        workTimeTreatment: 'DEDUCT_UNPAID',
        deductionRule: 'DEDUCT_INTERSECTION',
        monthlyAggregationRule: 'CONFIRMED',
        stampText: '介護',
        aggregationCategory: 'CARE_LEAVE'
      })
    );

    // 介護時間 (条例第16条)
    insertPolicy.run(
      'LEAVE_CARE_TIME',
      'DEFAULT_MUNICIPALITY',
      '2017.1',
      '介護時間 (条例第16条)',
      '介時',
      'HOURLY_CARE_TIME',
      120, // 1日最大2時間 (120分)
      '2017-01-01',
      '9999-12-31',
      JSON.stringify({
        legalBasis: 'YAMAGUCHI_WORK_ORDINANCE_ART16',
        status: 'ACTIVE',
        isPaid: false,
        salaryDeduction: true,
        allowedDurationUnits: ['TIME'],
        timeStepMinutes: 30,
        maxMinutesPerDay: 120,
        maxYears: 3,
        combinedMaxMinutesWithChildcare: 120, // 育児部分休業・子育て部分休暇との合算上限
        hourlyDisplayRule: '介時',
        workTimeTreatment: 'DEDUCT_UNPAID',
        deductionRule: 'DEDUCT_INTERSECTION',
        monthlyAggregationRule: 'CONFIRMED',
        stampText: '介時',
        aggregationCategory: 'HOURLY_CARE_TIME'
      })
    );
  }
};
