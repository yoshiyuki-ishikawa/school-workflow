import { getDb } from '../../db/database';
import { resolveAuthoritativeWorkSchedule, ResolvedWorkSchedule, timeToMinutes } from '../attendance/workPatternResolver';

export type PatternUniformity = 'UNIFORM' | 'NON_UNIFORM';

export type DayConversionBasis =
  | { status: 'APPLICABLE'; minutesPerDay: number }
  | { status: 'NOT_APPLICABLE' }
  | { status: 'UNRESOLVED'; failReason: string };

export type HalfDayEligibilityStatus = 'ELIGIBLE' | 'NOT_ELIGIBLE';

export interface AnnualLeavePolicyContext {
  userId: number;
  targetDate: string;
  isFailClosed: boolean;
  failReason?: string;
  
  workingPatternId: number;
  workingPatternVersion: string;
  patternName: string;
  patternType: 'FULLTIME_STANDARD' | 'REAPPOINTED_UNIFORM' | 'REAPPOINTED_NON_UNIFORM' | 'PART_TIME_HOURLY';
  patternUniformity: PatternUniformity;
  
  grantBasis: 'DAY_BASED';
  allowedAcquisitionUnits: Array<'DAY' | 'HALF_DAY_AM' | 'HALF_DAY_PM' | 'TIME'>;
  dayConversion: DayConversionBasis;
  halfDayEligibility: HalfDayEligibilityStatus;
  halfDayEligibilityDetails?: string;
  
  policyCode: string;
  policyVersion: string;
  workSchedule?: ResolvedWorkSchedule;
}

/**
 * AnnualLeavePolicyContextResolver (SSOT)
 * 
 * 職員 (userId) × 対象日 (targetDate) から、適用される年休制度コンテキストを決定論的に解決する。
 * 
 * 制度Invariant:
 * 1. FULLTIME_STANDARD:
 *    - 均一性: UNIFORM
 *    - 取得単位: DAY, HALF_DAY_AM, HALF_DAY_PM, TIME (半日適格時のみHALF許可)
 *    - dayConversion: APPLICABLE (minutesPerDay = 465分)
 *    - 半日適格性: 7h超8h以下 かつ 休憩前後差1h以内
 * 
 * 2. REAPPOINTED_UNIFORM (再任用短時間・同一型):
 *    - 均一性: UNIFORM
 *    - 取得単位: DAY, TIME (半日 HALF は不許可・Fail-Closed)
 *    - dayConversion: APPLICABLE (所定分数)
 *    - 半日適格性: NOT_ELIGIBLE (制度上対象外)
 * 
 * 3. REAPPOINTED_NON_UNIFORM (再任用短時間・非同一型):
 *    - 均一性: NON_UNIFORM
 *    - 取得単位: TIME のみ (DAY, HALF は不許可・Fail-Closed)
 *    - dayConversion: NOT_APPLICABLE (単一 minutesPerDay を人工生成しない)
 *    - 付与Basis: DAY_BASED (日数付与を維持)
 *    - 半日適格性: NOT_ELIGIBLE
 */
export class AnnualLeavePolicyContextResolver {
  static resolve(userId: number, targetDate: string): AnnualLeavePolicyContext {
    const workSchedule = resolveAuthoritativeWorkSchedule(userId, targetDate);

    if (workSchedule.isFailClosed) {
      return {
        userId,
        targetDate,
        isFailClosed: true,
        failReason: workSchedule.failReason || '勤務パターン未登録または曖昧です',
        workingPatternId: 0,
        workingPatternVersion: 'UNKNOWN',
        patternName: 'UNKNOWN',
        patternType: 'FULLTIME_STANDARD',
        patternUniformity: 'UNIFORM',
        grantBasis: 'DAY_BASED',
        allowedAcquisitionUnits: [],
        dayConversion: { status: 'UNRESOLVED', failReason: '勤務パターン未解決' },
        halfDayEligibility: 'NOT_ELIGIBLE',
        policyCode: 'ANNUAL_LEAVE_YAMAGUCHI_2026',
        policyVersion: '2026.1',
        workSchedule
      };
    }

    const patternName = workSchedule.patternName || '';
    const rawPatternType = workSchedule.patternType;
    const scheduleDetails = workSchedule.schedule;
    const workMinutes = workSchedule.scheduledWorkMinutes || 0;

    // 1. 勤務パターンの分類 (Classification)
    let patternType: 'FULLTIME_STANDARD' | 'REAPPOINTED_UNIFORM' | 'REAPPOINTED_NON_UNIFORM' | 'PART_TIME_HOURLY' = 'FULLTIME_STANDARD';
    let patternUniformity: PatternUniformity = 'UNIFORM';

    if (patternName.includes('非同一型') || patternName.includes('2週5日')) {
      patternType = 'REAPPOINTED_NON_UNIFORM';
      patternUniformity = 'NON_UNIFORM';
    } else if (patternName.includes('再任用') || patternName.includes('同一型') || patternName.includes('週4日') || patternName.includes('週3日') || rawPatternType === 'SHORT_TIME') {
      patternType = 'REAPPOINTED_UNIFORM';
      patternUniformity = 'UNIFORM';
    } else if (patternName.includes('非常勤') || patternName.includes('パート')) {
      patternType = 'PART_TIME_HOURLY';
      patternUniformity = 'NON_UNIFORM';
    } else {
      patternType = 'FULLTIME_STANDARD';
      patternUniformity = 'UNIFORM';
    }

    // 2. DayConversionBasis の決定
    let dayConversion: DayConversionBasis;
    if (patternUniformity === 'NON_UNIFORM') {
      dayConversion = { status: 'NOT_APPLICABLE' };
    } else {
      const standardMinutes = workMinutes > 0 ? workMinutes : 465;
      dayConversion = { status: 'APPLICABLE', minutesPerDay: standardMinutes };
    }

    // 3. 半日年休適格性 (Half-Day Eligibility) の厳格判定 (人事委員会通知準拠)
    let halfDayEligibility: HalfDayEligibilityStatus = 'NOT_ELIGIBLE';
    let halfDayEligibilityDetails = '半日年休要件を満たしません';

    if (patternType === 'FULLTIME_STANDARD' && workSchedule.isWorkDay && workMinutes > 420 && workMinutes <= 480) {
      const intervals = workSchedule.effectiveIntervals || [];
      if (intervals.length >= 2) {
        const amInterval = intervals[0];
        const pmInterval = intervals[intervals.length - 1];
        const amMinutes = amInterval.end - amInterval.start;
        const pmMinutes = pmInterval.end - pmInterval.start;
        const diff = Math.abs(amMinutes - pmMinutes);

        if (diff <= 60) {
          halfDayEligibility = 'ELIGIBLE';
          halfDayEligibilityDetails = `半日年休適格 (所定 ${workMinutes}分, 午前 ${amMinutes}分, 午後 ${pmMinutes}分, 差 ${diff}分 <= 60分)`;
        } else {
          halfDayEligibilityDetails = `休憩前後の勤務時間差が1時間を超過しています (午前 ${amMinutes}分, 午後 ${pmMinutes}分, 差 ${diff}分 > 60分)`;
        }
      } else {
        halfDayEligibilityDetails = '勤務時間帯に明示的な休憩時間区間が設定されていません';
      }
    } else if (patternType !== 'FULLTIME_STANDARD') {
      halfDayEligibilityDetails = `短時間勤務・再任用勤務形態 (${patternType}) では半日年休は制度上対象外です`;
    }

    // 4. 取得可能単位 (Allowed Acquisition Units) の決定
    const allowedUnits: Array<'DAY' | 'HALF_DAY_AM' | 'HALF_DAY_PM' | 'TIME'> = [];
    if (patternType === 'FULLTIME_STANDARD') {
      allowedUnits.push('DAY');
      if (halfDayEligibility === 'ELIGIBLE') {
        allowedUnits.push('HALF_DAY_AM', 'HALF_DAY_PM');
      }
      allowedUnits.push('TIME');
    } else if (patternType === 'REAPPOINTED_UNIFORM') {
      allowedUnits.push('DAY', 'TIME');
    } else if (patternType === 'REAPPOINTED_NON_UNIFORM' || patternType === 'PART_TIME_HOURLY') {
      allowedUnits.push('TIME');
    }

    return {
      userId,
      targetDate,
      isFailClosed: false,
      workingPatternId: workSchedule.patternId || 0,
      workingPatternVersion: '2026.1',
      patternName: workSchedule.patternName || '通常フルタイム',
      patternType,
      patternUniformity,
      grantBasis: 'DAY_BASED',
      allowedAcquisitionUnits: allowedUnits,
      dayConversion,
      halfDayEligibility,
      halfDayEligibilityDetails,
      policyCode: 'ANNUAL_LEAVE_YAMAGUCHI_2026',
      policyVersion: '2026.1',
      workSchedule
    };
  }
}
