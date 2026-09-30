import { Migration } from './migrator';
import { Database } from 'better-sqlite3';

/**
 * Migration 010: 教育公務員特例法第22条（研修・長期研修）基盤の導入
 * 
 * 1. application_types に TRAINING_SPECIAL_ACT_22_2, TRAINING_SPECIAL_ACT_22_3 を登録
 * 2. policy_rules に SPECIAL_ACT_22_2, SPECIAL_ACT_22_3 の UNCONFIRMED skeleton を登録
 *    （自治体制度値を推測した確定値は投入しない）
 */
export const migration010: Migration = {
  version: 10,
  name: 'training_support',
  up: (db: Database) => {
    // 1. application_types に登録
    const insertType = db.prepare(`
      INSERT OR IGNORE INTO application_types (id, name, description, default_route_id)
      VALUES (?, ?, ?, ?)
    `);

    // 標準休暇・承認ルート (route_id: 1)
    insertType.run(
      'TRAINING_SPECIAL_ACT_22_2',
      '教育公務員特例法第22条第2項研修',
      '勤務場所を離れて行う研修（本属長承認）',
      1
    );

    insertType.run(
      'TRAINING_SPECIAL_ACT_22_3',
      '教育公務員特例法第22条第3項長期研修',
      '任命権者の定めるところにより現職のままで受ける長期研修',
      1
    );

    // 2. policy_rules に UNCONFIRMED skeleton を登録 (確定値は投入しない)
    const insertPolicy = db.prepare(`
      INSERT OR IGNORE INTO policy_rules (
        policy_code, authority_id, version, official_name, display_code, aggregation_category, max_minutes_per_day, effective_from, effective_to, rule_definition_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const skeleton22_2 = JSON.stringify({
      legalBasis: 'EDUCATIONAL_SPECIAL_ACT_22_2',
      status: 'UNCONFIRMED',
      hourlyAllowed: 'UNCONFIRMED',
      halfDayAllowed: 'UNCONFIRMED',
      dailyDisplayRule: 'UNCONFIRMED',
      halfDayDisplayRule: 'UNCONFIRMED',
      hourlyDisplayRule: 'UNCONFIRMED',
      travelOrderRequirement: 'UNCONFIRMED',
      workTimeTreatment: 'UNCONFIRMED',
      deductionRule: 'UNCONFIRMED',
      monthlyAggregationRule: 'UNCONFIRMED',
      annualAggregationRule: 'UNCONFIRMED',
    });

    const skeleton22_3 = JSON.stringify({
      legalBasis: 'EDUCATIONAL_SPECIAL_ACT_22_3',
      status: 'UNCONFIRMED',
      dailyDisplayRule: 'UNCONFIRMED',
      travelOrderRequirement: 'UNCONFIRMED',
      workTimeTreatment: 'UNCONFIRMED',
      deductionRule: 'UNCONFIRMED',
      monthlyAggregationRule: 'UNCONFIRMED',
      annualAggregationRule: 'UNCONFIRMED',
    });

    insertPolicy.run(
      'SPECIAL_ACT_22_2',
      'DEFAULT_MUNICIPALITY',
      '2026.1',
      '教育公務員特例法第22条第2項研修',
      'UNCONFIRMED',
      'UNCONFIRMED',
      0,
      '2026-04-01',
      '9999-12-31',
      skeleton22_2
    );

    insertPolicy.run(
      'SPECIAL_ACT_22_3',
      'DEFAULT_MUNICIPALITY',
      '2026.1',
      '教育公務員特例法第22条第3項長期研修',
      'UNCONFIRMED',
      'UNCONFIRMED',
      0,
      '2026-04-01',
      '9999-12-31',
      skeleton22_3
    );
  }
};
