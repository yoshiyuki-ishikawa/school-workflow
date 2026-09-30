import { getDb } from '../db/database';
import {
  AttendanceDisplayPolicy,
  AttendanceAggregationPolicy,
  DisasterRecognitionStatus,
  SickLeaveDurationType
} from '../types/sickLeave';

export interface ResolvedSickLeaveDisplay {
  isFailClosed: boolean;
  failReason?: 'MISSING_POLICY' | 'UNDEFINED_MAPPING' | 'INVALID_JSON' | 'POLICY_REQUIRED_UNSET';
  displayText?: string;
  symbol?: string;
  code?: string;
}

export interface ResolvedSickLeaveAggregation {
  isFailClosed: boolean;
  failReason?: 'MISSING_POLICY' | 'UNDEFINED_AGGREGATION' | 'INVALID_JSON';
  aggregationCategory?: string;
  fullDayConversionRule?: string;
  timeAggregationRule?: string;
  roundingRule?: string;
  payrollCode?: string;
}

export class SickLeavePolicyService {
  /**
   * 出勤簿表示Policyの解決 (Fail-Closed)
   * 
   * 1. targetDate時点で有効なPolicyを取得
   * 2. SICK_LEAVE -> 取得単位 -> 災害認定状態 のマッピングを解決
   * 3. 未設定値 (__POLICY_REQUIRED__) や未定義時は推測せず Fail-Closed として処理停止
   */
  static resolveDisplayPolicy(
    targetDate: string,
    durationType: SickLeaveDurationType,
    disasterStatus: DisasterRecognitionStatus = 'NONE',
    calculatedMinutes: number = 0,
    policySpecificCode?: string,
    policyId: string = 'DEFAULT_MUNICIPALITY'
  ): ResolvedSickLeaveDisplay {
    const db = getDb();
    const row = db.prepare(`
      SELECT * FROM attendance_display_policies
      WHERE policy_id = ? AND effective_from <= ? AND effective_to >= ?
      ORDER BY effective_from DESC LIMIT 1
    `).get(policyId, targetDate, targetDate) as any;

    if (!row) {
      return { isFailClosed: true, failReason: 'MISSING_POLICY' };
    }

    let policy: AttendanceDisplayPolicy;
    try {
      policy = {
        policyId: row.policy_id,
        policyVersion: row.policy_version,
        effectiveFrom: row.effective_from,
        effectiveTo: row.effective_to,
        rules: JSON.parse(row.rules_json)
      };
    } catch {
      return { isFailClosed: true, failReason: 'INVALID_JSON' };
    }

    const sickRules = policy.rules.SICK_LEAVE;
    if (!sickRules) {
      return { isFailClosed: true, failReason: 'UNDEFINED_MAPPING' };
    }

    // 自治体独自拡張単位の解決
    if (policySpecificCode) {
      const customRule = sickRules.policySpecificDurations?.[policySpecificCode];
      if (!customRule || customRule.displayText === '__POLICY_REQUIRED__') {
        return { isFailClosed: true, failReason: 'POLICY_REQUIRED_UNSET' };
      }
      return {
        isFailClosed: false,
        displayText: customRule.displayText,
        symbol: customRule.symbol || '病'
      };
    }

    if (durationType === 'FULL_DAY') {
      const fullRule = sickRules.FULL_DAY?.[disasterStatus];
      if (!fullRule || !fullRule.displayText) {
        return { isFailClosed: true, failReason: 'UNDEFINED_MAPPING' };
      }
      if (fullRule.displayText === '__POLICY_REQUIRED__') {
        return { isFailClosed: true, failReason: 'POLICY_REQUIRED_UNSET' };
      }
      return {
        isFailClosed: false,
        displayText: fullRule.displayText,
        symbol: fullRule.symbol || '病',
        code: fullRule.code
      };
    }

    if (durationType === 'TIME') {
      const timeRule = sickRules.TIME?.[disasterStatus];
      if (!timeRule || !timeRule.template) {
        return { isFailClosed: true, failReason: 'UNDEFINED_MAPPING' };
      }
      if (timeRule.template === '__POLICY_REQUIRED__') {
        return { isFailClosed: true, failReason: 'POLICY_REQUIRED_UNSET' };
      }

      const hours = Math.ceil(calculatedMinutes / 60);
      const text = timeRule.template
        .replace('{hours}', String(hours))
        .replace('{minutes}', String(calculatedMinutes));

      return {
        isFailClosed: false,
        displayText: text,
        symbol: '病'
      };
    }

    return { isFailClosed: true, failReason: 'UNDEFINED_MAPPING' };
  }

  /**
   * 集計Policyの解決 (Fail-Closed)
   */
  static resolveAggregationPolicy(
    targetDate: string,
    disasterStatus: DisasterRecognitionStatus = 'NONE',
    policyId: string = 'DEFAULT_MUNICIPALITY'
  ): ResolvedSickLeaveAggregation {
    const db = getDb();
    const row = db.prepare(`
      SELECT * FROM attendance_aggregation_policies
      WHERE policy_id = ? AND effective_from <= ? AND effective_to >= ?
      ORDER BY effective_from DESC LIMIT 1
    `).get(policyId, targetDate, targetDate) as any;

    if (!row) {
      return { isFailClosed: true, failReason: 'MISSING_POLICY' };
    }

    let policy: AttendanceAggregationPolicy;
    try {
      policy = {
        policyId: row.policy_id,
        policyVersion: row.policy_version,
        effectiveFrom: row.effective_from,
        effectiveTo: row.effective_to,
        rules: JSON.parse(row.rules_json)
      };
    } catch {
      return { isFailClosed: true, failReason: 'INVALID_JSON' };
    }

    const rules = policy.rules;
    if (!rules.aggregationCategory || rules.aggregationCategory === '__POLICY_REQUIRED__') {
      return { isFailClosed: true, failReason: 'UNDEFINED_AGGREGATION' };
    }

    let aggCategory = rules.aggregationCategory;
    if (rules.disasterRecognitionAggregationRule?.[disasterStatus]) {
      aggCategory = rules.disasterRecognitionAggregationRule[disasterStatus]!;
    }

    return {
      isFailClosed: false,
      aggregationCategory: aggCategory,
      fullDayConversionRule: rules.fullDayConversionRule,
      timeAggregationRule: rules.timeAggregationRule,
      roundingRule: rules.roundingRule,
      payrollCode: rules.payrollIntegrationCode
    };
  }
}
