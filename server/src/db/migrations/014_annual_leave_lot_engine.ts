import { Migration } from './migrator';
import { Database } from 'better-sqlite3';

/**
 * Migration 014: 年次有給休暇 ロット管理エンジン (Entitlement / Usage / Policy Driven)
 * 
 * 1. policy_rules に山口県条例・規則準拠の確定Policyを登録 (ANNUAL_LEAVE_YAMAGUCHI_2026)
 * 2. テーブル作成:
 *    - leave_entitlements (法的日数権利・ロット管理)
 *    - leave_usages (確定行使履歴・出勤簿実免除時間記録)
 * 3. 既存データの安全な移行 (推測換算完全禁止・復元不能データは LEGACY_UNVERIFIED 隔離)
 */
export const migration014: Migration = {
  version: 14,
  name: 'annual_leave_lot_engine',
  up: (db: Database) => {
    // 1. policy_rules に公式ポリシー投入
    const insertPolicy = db.prepare(`
      INSERT OR IGNORE INTO policy_rules (
        policy_code, authority_id, version, official_name, display_code,
        aggregation_category, max_minutes_per_day, effective_from, effective_to,
        rule_definition_json, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);

    insertPolicy.run(
      'ANNUAL_LEAVE_YAMAGUCHI_2026',
      'DEFAULT_MUNICIPALITY',
      '2026.1',
      '年次有給休暇 (条例第12条・規則第8条の2〜第11条)',
      '年休',
      'ANNUAL_LEAVE',
      0,
      '1971-12-24',
      '9999-12-31',
      JSON.stringify({
        legalBasis: 'YAMAGUCHI_WORK_ORDINANCE_ART12',
        status: 'ACTIVE',
        allowedDurationUnits: ['FULL_DAY', 'HALF_DAY_AM', 'HALF_DAY_PM', 'HOURLY'],
        dailyDisplayRule: '年休',
        workTimeTreatment: 'COUNT_AS_WORK',
        deductionRule: 'DEDUCT_WORK_SEGMENT',
        monthlyAggregationRule: 'CONFIRMED',
        stampText: '年休',
        aggregationCategory: 'ANNUAL_LEAVE',
        rules: {
          regularGrantDays: 20,
          maxCarryoverDays: 20,
          maxHoldingDays: 40,
          validityYears: 2,
          hourlyLeave: {
            minUnitMinutes: 60,
            limitMode: 'DAYS_EQUIVALENT',
            maxDaysEquivalent: 5,
            standardAnnualMinutes: 2325
          },
          halfDayLeave: {
            mode: 'WORK_SEGMENT_BOUNDED',
            amSegment: 'MORNING_INTERVAL',
            pmSegment: 'AFTERNOON_INTERVAL'
          },
          tables: {
            table1_mid_career: {
              '1': 20, '2': 18, '3': 17, '4': 15, '5': 13, '6': 12,
              '7': 10, '8': 8, '9': 7, '10': 5, '11': 3, '12': 2
            },
            table2_temporary: {
              '1': 2, '2': 4, '3': 5, '4': 7, '5': 9, '6': 10,
              '7': 12, '8': 14, '9': 15, '10': 17, '11': 19, '12': 20
            }
          }
        }
      })
    );

    // 2. テーブル作成 (CASCADE DELETE を適用してテストクリーンアップ時の外部キー制約安全性を保証)
    db.exec(`
      CREATE TABLE IF NOT EXISTS leave_entitlements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        entitlement_code TEXT NOT NULL UNIQUE,
        entitlement_type TEXT NOT NULL CHECK(entitlement_type IN ('REGULAR_GRANT', 'MID_CAREER_GRANT', 'TEMPORARY_GRANT', 'CARRYOVER', 'MANUAL_ADJUSTMENT')),
        fiscal_year INTEGER NOT NULL,
        granted_days INTEGER NOT NULL,
        used_half_days INTEGER NOT NULL DEFAULT 0,
        used_hourly_minutes INTEGER NOT NULL DEFAULT 0,
        grant_date TEXT NOT NULL,
        effective_from TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        source_policy_id INTEGER REFERENCES policy_rules(id),
        carryover_from_id INTEGER REFERENCES leave_entitlements(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'EXHAUSTED', 'EXPIRED', 'CANCELLED', 'LEGACY_UNVERIFIED')),
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
        updated_at TEXT NOT NULL DEFAULT (DATETIME('now')),
        CHECK (effective_from <= expires_at)
      );

      CREATE INDEX IF NOT EXISTS idx_entitlements_user_active 
        ON leave_entitlements(user_id, status, effective_from, expires_at);

      CREATE TABLE IF NOT EXISTS leave_usages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entitlement_id INTEGER NOT NULL REFERENCES leave_entitlements(id) ON DELETE CASCADE,
        application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        target_date TEXT NOT NULL,
        unit_type TEXT NOT NULL CHECK(unit_type IN ('FULL_DAY', 'HALF_DAY_AM', 'HALF_DAY_PM', 'HOURLY')),
        day_deduction_units INTEGER NOT NULL DEFAULT 0,
        hourly_minutes INTEGER NOT NULL DEFAULT 0,
        attendance_deduction_minutes INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (DATETIME('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_leave_usages_app ON leave_usages(application_id);
      CREATE INDEX IF NOT EXISTS idx_leave_usages_user_date ON leave_usages(user_id, target_date);
    `);

    // 3. 既存データの安全なBackfill (推測換算完全禁止)
    const policyRow = db.prepare("SELECT id FROM policy_rules WHERE policy_code = 'ANNUAL_LEAVE_YAMAGUCHI_2026' ORDER BY id DESC LIMIT 1").get() as any;
    const policyId = policyRow ? policyRow.id : null;

    let existingGrants: any[] = [];
    try {
      existingGrants = db.prepare("SELECT * FROM leave_grants WHERE leave_type = 'ANNUAL' ORDER BY id ASC").all();
    } catch {}

    const insertEntitlement = db.prepare(`
      INSERT INTO leave_entitlements (
        user_id, entitlement_code, entitlement_type, fiscal_year, granted_days,
        used_half_days, used_hourly_minutes, grant_date, effective_from, expires_at,
        source_policy_id, status, reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const g of existingGrants) {
      const grantYear = parseInt(g.grant_date.split('-')[0], 10) || 2026;
      const days = Math.round(g.granted_amount);
      const isExactDays = Math.abs(g.granted_amount - days) < 0.001;

      const code = `ENT-MIGRATED-${g.id}-${g.user_id}`;
      const status = isExactDays ? 'ACTIVE' : 'LEGACY_UNVERIFIED';

      insertEntitlement.run(
        g.user_id,
        code,
        'REGULAR_GRANT',
        grantYear,
        days,
        g.grant_date,
        g.effective_from,
        g.expires_at,
        policyId,
        status,
        g.reason || 'マイグレーション移行データ',
        g.created_at || new Date().toISOString(),
        new Date().toISOString()
      );
    }
  }
};
