import { Migration } from './migrator';
import { Database } from 'better-sqlite3';

/**
 * Migration 012: 山口県勤務条例第14条「特別休暇（産前産後・一般特休）」基盤の導入
 * 
 * 1. policy_rules に確定 ACTIVE Policy を登録:
 *    - SPECIAL_MATERNITY_PRE (産前特別休暇: 施行日 1971-12-24, allowed: ["DAY"])
 *    - SPECIAL_MATERNITY_POST (産後特別休暇: 施行日 1971-12-24, allowed: ["DAY"])
 *    - SPECIAL_BEREAVEMENT (忌引等特別休暇: 施行日 1971-12-24, allowed: ["DAY", "HALF_DAY", "TIME"])
 *    - SPECIAL_SUMMER (夏季特別休暇: 施行日 1971-12-24, allowed: ["DAY", "HALF_DAY", "TIME"])
 *    - SPECIAL_MARRIAGE (結婚特別休暇: 施行日 1971-12-24, allowed: ["DAY", "HALF_DAY", "TIME"])
 */
export const migration012: Migration = {
  version: 12,
  name: 'special_leave_art14_support',
  up: (db: Database) => {
    const insertPolicy = db.prepare(`
      INSERT OR IGNORE INTO policy_rules (
        policy_code, authority_id, version, official_name, display_code,
        aggregation_category, max_minutes_per_day, effective_from, effective_to,
        rule_definition_json, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);

    // 1. 産前特別休暇 (施行: 1971-12-24 / 取得単位: 1日のみ)
    insertPolicy.run(
      'SPECIAL_MATERNITY_PRE',
      'DEFAULT_MUNICIPALITY',
      '1971.1',
      '産前特別休暇 (条例第14条)',
      '産休',
      'MATERNITY_LEAVE',
      0,
      '1971-12-24',
      '9999-12-31',
      JSON.stringify({
        legalBasis: 'YAMAGUCHI_WORK_ORDINANCE_ART14_PRE_NATAL',
        status: 'ACTIVE',
        allowedDurationUnits: ['DAY'],
        dailyDisplayRule: '産休',
        workTimeTreatment: 'COUNT_AS_WORK',
        deductionRule: 'DEDUCT_FULL',
        monthlyAggregationRule: 'CONFIRMED',
        stampText: '産休',
        aggregationCategory: 'MATERNITY_LEAVE'
      })
    );

    // 2. 産後特別休暇 (施行: 1971-12-24 / 取得単位: 1日のみ)
    insertPolicy.run(
      'SPECIAL_MATERNITY_POST',
      'DEFAULT_MUNICIPALITY',
      '1971.1',
      '産後特別休暇 (条例第14条)',
      '産休',
      'MATERNITY_LEAVE',
      0,
      '1971-12-24',
      '9999-12-31',
      JSON.stringify({
        legalBasis: 'YAMAGUCHI_WORK_ORDINANCE_ART14_POST_NATAL',
        status: 'ACTIVE',
        allowedDurationUnits: ['DAY'],
        dailyDisplayRule: '産休',
        workTimeTreatment: 'COUNT_AS_WORK',
        deductionRule: 'DEDUCT_FULL',
        monthlyAggregationRule: 'CONFIRMED',
        stampText: '産休',
        aggregationCategory: 'MATERNITY_LEAVE'
      })
    );

    // 3. 忌引特別休暇 (取得単位: 1日, 半日, 時間)
    insertPolicy.run(
      'SPECIAL_BEREAVEMENT',
      'DEFAULT_MUNICIPALITY',
      '1971.1',
      '忌引特別休暇 (条例第14条)',
      '特',
      'SPECIAL_LEAVE',
      0,
      '1971-12-24',
      '9999-12-31',
      JSON.stringify({
        legalBasis: 'YAMAGUCHI_WORK_ORDINANCE_ART14_BEREAVEMENT',
        status: 'ACTIVE',
        allowedDurationUnits: ['DAY', 'HALF_DAY', 'TIME'],
        dailyDisplayRule: '特',
        halfDayDisplayRule: '特',
        hourlyDisplayRule: '特',
        halfDayStampSubText: '半日',
        workTimeTreatment: 'COUNT_AS_WORK',
        deductionRule: 'DEDUCT_INTERSECTION',
        monthlyAggregationRule: 'CONFIRMED',
        stampText: '特休',
        aggregationCategory: 'SPECIAL_LEAVE'
      })
    );

    // 4. 夏季特別休暇 (取得単位: 1日, 半日, 時間)
    insertPolicy.run(
      'SPECIAL_SUMMER',
      'DEFAULT_MUNICIPALITY',
      '1971.1',
      '夏季特別休暇 (条例第14条)',
      '特',
      'SPECIAL_LEAVE',
      0,
      '1971-12-24',
      '9999-12-31',
      JSON.stringify({
        legalBasis: 'YAMAGUCHI_WORK_ORDINANCE_ART14_SUMMER',
        status: 'ACTIVE',
        allowedDurationUnits: ['DAY', 'HALF_DAY', 'TIME'],
        dailyDisplayRule: '特',
        halfDayDisplayRule: '特',
        hourlyDisplayRule: '特',
        halfDayStampSubText: '半日',
        workTimeTreatment: 'COUNT_AS_WORK',
        deductionRule: 'DEDUCT_INTERSECTION',
        monthlyAggregationRule: 'CONFIRMED',
        stampText: '特休',
        aggregationCategory: 'SPECIAL_LEAVE'
      })
    );

    // 5. 結婚特別休暇 (取得単位: 1日, 半日, 時間)
    insertPolicy.run(
      'SPECIAL_MARRIAGE',
      'DEFAULT_MUNICIPALITY',
      '1971.1',
      '結婚特別休暇 (条例第14条)',
      '特',
      'SPECIAL_LEAVE',
      0,
      '1971-12-24',
      '9999-12-31',
      JSON.stringify({
        legalBasis: 'YAMAGUCHI_WORK_ORDINANCE_ART14_MARRIAGE',
        status: 'ACTIVE',
        allowedDurationUnits: ['DAY', 'HALF_DAY', 'TIME'],
        dailyDisplayRule: '特',
        halfDayDisplayRule: '特',
        hourlyDisplayRule: '特',
        halfDayStampSubText: '半日',
        workTimeTreatment: 'COUNT_AS_WORK',
        deductionRule: 'DEDUCT_INTERSECTION',
        monthlyAggregationRule: 'CONFIRMED',
        stampText: '特休',
        aggregationCategory: 'SPECIAL_LEAVE'
      })
    );
  }
};
