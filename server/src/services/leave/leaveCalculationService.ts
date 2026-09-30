import { getDb } from '../../db/database';
import { getServerIsoString } from '../../utils/serverTime';
import { WorkingObligationResolver, WorkingObligationResult } from '../attendance/workingObligationResolver';
import { AnnualLeavePolicyContextResolver, AnnualLeavePolicyContext } from './annualLeavePolicyContextResolver';
import { AnnualLeaveService } from '../annualLeaveService';

export interface CalculationSnapshot {
  engineVersion: string;
  calculatedAt: string;
  policyRuleId: number | null;
  policyCode: string;
  policyVersion: string;
  policyEffectiveFrom: string;
  workPatternId: number;
  workPatternName: string;
  workPatternEffectiveFrom: string;
  scheduledWorkMinutes: number;
  workIntervalsSnapshot: { start: number; end: number }[];
  unitType: 'DAY' | 'HALF_DAY' | 'TIME';
  halfDayType?: 'MORNING' | 'AFTERNOON';
  requestedStart?: string;
  requestedEnd?: string;
  netWorkMinutes: number;
  breakOverlapMinutes: number;
  roundingRule: string;
  roundingAddedMinutes: number;
  chargedMinutes: number;
  chargedHours: number;
  chargedDays: number;
  deductionUnits: number;
  attendanceDeductionMinutes: number;
  // Multi-day range & conversion context
  isMultiDayRange?: boolean;
  startDate?: string;
  endDate?: string;
  chargeableDaysCount?: number;
  skippedNonWorkingDaysCount?: number;
}

export interface AnnualLeaveEntitlementDeduction {
  deductionHalfUnits: number;     // 1日=2, 半日=1, 時間休=0 (ロット日数残高から減算)
  chargedHourlyMinutes: number;   // 時間休減算分数 (時間休取得時のみ>0)
  sourceWorkingMinutes: number;   // 勤務義務免除の実分数
  roundedLeaveMinutes: number;    // 制度免除分数 (切上後)
  policyVersion: string;
}

export interface PerDayCalculationResult {
  targetDate: string;
  obligationStatus: 'WORKING' | 'NON_WORKING';
  workPatternId: number;
  scheduledWorkMinutes: number;
  chargedDays: number;
  chargedHalfUnits: number;
  chargedMinutes: number;
  detailsText: string;
}

export interface LeaveCalculationResult {
  isValid: boolean;
  errorCode?: string;
  message?: string;
  snapshot?: CalculationSnapshot;
  detailsText?: string;
  canUpgradeToHalfDay?: boolean;
  currentRemainingDays?: number;
  simulatedRemainingText?: string;
  
  // Canonical Charge Model
  totalChargedDays?: number;
  totalChargedHours?: number;
  totalChargedMinutes?: number;
  entitlementDeduction?: AnnualLeaveEntitlementDeduction;
  chargeableDaysCount?: number;
  skippedNonWorkingDaysCount?: number;
  perDayResults?: PerDayCalculationResult[];
}

export const CALCULATION_ENGINE_VERSION = '2026.2-LEAVE-CALC-CANONICAL';

export class LeaveCalculationService {
  static timeToMinutes(timeStr: string): number {
    if (!timeStr) return 0;
    const [h, m] = timeStr.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  }

  static minutesToTime(mins: number): string {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  /**
   * 日付範囲 [startDate, endDate] に含まれる全 YYYY-MM-DD 文字列配列を展開
   */
  static expandDateRange(startDate: string, endDate: string): string[] {
    const dates: string[] = [];
    const cur = new Date(startDate);
    const end = new Date(endDate);
    while (cur <= end) {
      dates.push(cur.toISOString().split('T')[0]);
      cur.setDate(cur.getDate() + 1);
    }
    return dates;
  }

  /**
   * 休暇・服務計算の Server-Authoritative 確定算出
   */
  static calculate(params: {
    subjectUserId: number;
    typeId: string;
    targetDate?: string;
    startDate?: string;
    endDate?: string;
    unitType: 'DAY' | 'HALF_DAY' | 'TIME';
    halfDayType?: 'MORNING' | 'AFTERNOON';
    startTime?: string;
    endTime?: string;
    calculatedDays?: number;
    reasonCode?: string;
  }): LeaveCalculationResult {
    const db = getDb();
    const now = getServerIsoString();
    const { subjectUserId, typeId, unitType, halfDayType, startTime, endTime, reasonCode } = params;

    const startDate = params.startDate || params.targetDate;
    const endDate = params.endDate || params.startDate || params.targetDate;

    if (!startDate) {
      return { isValid: false, errorCode: 'INVALID_TARGET_DATE', message: '対象日を指定してください' };
    }

    const isRange = startDate !== endDate;

    // Invariant: RANGE + HALF / RANGE + TIME は一律拒絶 (Fail-Closed)
    if (isRange && unitType !== 'DAY') {
      return {
        isValid: false,
        errorCode: 'UNSUPPORTED_RANGE_UNIT',
        message: '複数日にまたがる期間申請で指定できる単位は「1日」のみです。半日休・時間休は単日指定で申請してください。'
      };
    }

    // 1. 日付配列の展開
    const targetDates = this.expandDateRange(startDate, endDate || startDate);

    // 2. 年休の場合の Policy Context 解決
    let primaryPolicyContext: AnnualLeavePolicyContext | null = null;
    if (typeId === 'LEAVE_ANNUAL') {
      primaryPolicyContext = AnnualLeavePolicyContextResolver.resolve(subjectUserId, startDate);
      if (primaryPolicyContext.isFailClosed) {
        return {
          isValid: false,
          errorCode: 'CONTEXT_RESOLUTION_FAILED',
          message: primaryPolicyContext.failReason || '年休制度ポリシーの解決に失敗しました'
        };
      }
    }

    // 取得可能単位の検証 (Policy Context 照合)
    if (typeId === 'LEAVE_ANNUAL' && primaryPolicyContext) {
      let reqUnitKey: 'DAY' | 'HALF_DAY_AM' | 'HALF_DAY_PM' | 'TIME' = 'DAY';
      if (unitType === 'HALF_DAY') {
        reqUnitKey = halfDayType === 'AFTERNOON' ? 'HALF_DAY_PM' : 'HALF_DAY_AM';
      } else if (unitType === 'TIME') {
        reqUnitKey = 'TIME';
      }

      if (!primaryPolicyContext.allowedAcquisitionUnits.includes(reqUnitKey)) {
        return {
          isValid: false,
          errorCode: 'UNSUPPORTED_UNIT',
          message: `当該勤務形態（${primaryPolicyContext.patternName}）では、指定された単位（${reqUnitKey}）の取得は許可されていません`
        };
      }
    }

    // 3. 各対象日ごとの勤務義務判定 ＆ 計算ループ
    let totalChargedDays = 0;
    let totalChargedHalfUnits = 0;
    let totalChargedMinutes = 0;
    let totalNetWorkMinutes = 0;
    let totalBreakOverlapMinutes = 0;
    let totalRoundingAddedMinutes = 0;
    let chargeableDaysCount = 0;
    let skippedNonWorkingDaysCount = 0;
    const perDayResults: PerDayCalculationResult[] = [];

    let firstDaySchedule: any = null;

    for (const dt of targetDates) {
      const oblResult: WorkingObligationResult = WorkingObligationResolver.resolve(subjectUserId, dt);

      if (oblResult.isFailClosed || oblResult.status === 'UNRESOLVED') {
        return {
          isValid: false,
          errorCode: 'WORKING_OBLIGATION_UNRESOLVED',
          message: `対象日（${dt}）の勤務義務状態を解決できません: ${oblResult.failReason}`
        };
      }

      if (oblResult.status === 'NON_WORKING') {
        skippedNonWorkingDaysCount++;
        perDayResults.push({
          targetDate: dt,
          obligationStatus: 'NON_WORKING',
          workPatternId: oblResult.workSchedule?.patternId || 0,
          scheduledWorkMinutes: 0,
          chargedDays: 0,
          chargedHalfUnits: 0,
          chargedMinutes: 0,
          detailsText: `非勤務日 (週休日・祝日等: ${oblResult.sourceDetails || ''})`
        });
        continue;
      }

      // 勤務日 (WORKING) の計算
      chargeableDaysCount++;
      const schedule = oblResult.workSchedule!;
      if (!firstDaySchedule) firstDaySchedule = schedule;
      if (!schedule.scheduledWorkMinutes || schedule.scheduledWorkMinutes <= 0) {
        return {
          isValid: false,
          errorCode: 'INVALID_SCHEDULED_MINUTES',
          message: `対象日（${dt}）の所定勤務時間が無効または0以下です`
        };
      }
      const scheduledMinutes = schedule.scheduledWorkMinutes;
      const intervals = schedule.effectiveIntervals || [];

      if (unitType === 'DAY') {
        totalChargedDays += 1;
        totalChargedHalfUnits += 2;
        totalNetWorkMinutes += scheduledMinutes;
        totalChargedMinutes += scheduledMinutes;
        perDayResults.push({
          targetDate: dt,
          obligationStatus: 'WORKING',
          workPatternId: schedule.patternId || 0,
          scheduledWorkMinutes: scheduledMinutes,
          chargedDays: 1,
          chargedHalfUnits: 2,
          chargedMinutes: scheduledMinutes,
          detailsText: `1日${typeId === 'LEAVE_ANNUAL' ? '年休' : '休暇'} (所定 ${scheduledMinutes}分)`
        });
      } else if (unitType === 'HALF_DAY') {
        // 半日適格性の確認 (年休の場合のみ Policy Context を照合)
        if (typeId === 'LEAVE_ANNUAL') {
          if (!primaryPolicyContext || primaryPolicyContext.halfDayEligibility !== 'ELIGIBLE') {
            return {
              isValid: false,
              errorCode: 'UNSUPPORTED_HALF_DAY',
              message: primaryPolicyContext?.halfDayEligibilityDetails || '半日年休の取得要件を満たしていません'
            };
          }
        }

        const isMorning = halfDayType === 'MORNING';
        let halfMinutes = 0;
        if (intervals.length >= 2) {
          halfMinutes = isMorning ? (intervals[0].end - intervals[0].start) : (intervals[intervals.length - 1].end - intervals[intervals.length - 1].start);
        } else {
          // P1-01: 単一区間の半日休は推測(/2)を廃止し、Fail-Closed
          return {
            isValid: false,
            errorCode: 'SINGLE_INTERVAL_HALF_DAY_UNSUPPORTED',
            message: '勤務時間帯に休憩による午前・午後の明確な区分が存在しないため、半日休暇を算出できません (Fail-Closed)'
          };
        }

        totalChargedDays += 0.5;
        totalChargedHalfUnits += 1;
        totalNetWorkMinutes += halfMinutes;
        totalChargedMinutes += halfMinutes;
        perDayResults.push({
          targetDate: dt,
          obligationStatus: 'WORKING',
          workPatternId: schedule.patternId || 0,
          scheduledWorkMinutes: scheduledMinutes,
          chargedDays: 0.5,
          chargedHalfUnits: 1,
          chargedMinutes: halfMinutes,
          detailsText: `${isMorning ? '午前' : '午後'}半日${typeId === 'LEAVE_ANNUAL' ? '年休' : '休暇'} (免除: ${halfMinutes}分)`
        });
      } else if (unitType === 'TIME') {
        if (!startTime || !endTime) {
          return { isValid: false, errorCode: 'TIME_REQUIRED', message: '開始時刻と終了時刻を指定してください' };
        }
        const reqStart = this.timeToMinutes(startTime);
        const reqEnd = this.timeToMinutes(endTime);
        if (reqEnd <= reqStart) {
          return { isValid: false, errorCode: 'INVALID_TIME_RANGE', message: '終了時刻は開始時刻より後に設定してください' };
        }

        // Net Intersection 計算
        let totalIntersection = 0;
        for (const inv of intervals) {
          const overlapStart = Math.max(reqStart, inv.start);
          const overlapEnd = Math.min(reqEnd, inv.end);
          if (overlapEnd > overlapStart) {
            totalIntersection += (overlapEnd - overlapStart);
          }
        }

        if (totalIntersection <= 0) {
          return {
            isValid: false,
            errorCode: 'NO_WORK_INTERSECTION',
            message: '指定された時間帯は勤務義務時間外（休憩中または勤務時間外）です'
          };
        }

        const totalSpan = reqEnd - reqStart;
        const breakOverlap = Math.max(0, totalSpan - totalIntersection);
        totalBreakOverlapMinutes += breakOverlap;
        totalNetWorkMinutes += totalIntersection;

        // CEIL_60 (単日取得ごとの1時間未満切上: 年休のみ適用、非年休は正味交差分数)
        let chargedMins = totalIntersection;
        let roundAdd = 0;
        if (typeId === 'LEAVE_ANNUAL') {
          const rem = totalIntersection % 60;
          roundAdd = rem > 0 ? (60 - rem) : 0;
          chargedMins = totalIntersection + roundAdd;
          totalRoundingAddedMinutes += roundAdd;
        }
        totalChargedMinutes += chargedMins;

        perDayResults.push({
          targetDate: dt,
          obligationStatus: 'WORKING',
          workPatternId: schedule.patternId || 0,
          scheduledWorkMinutes: scheduledMinutes,
          chargedDays: 0,
          chargedHalfUnits: 0,
          chargedMinutes: chargedMins,
          detailsText: typeId === 'LEAVE_ANNUAL'
            ? `時間休: ${chargedMins / 60}時間 (実不在: ${totalIntersection}分, 切上: ${roundAdd}分)`
            : `時間休: 実免除 ${chargedMins}分`
        });
      }
    }

    if (chargeableDaysCount === 0) {
      return {
        isValid: false,
        errorCode: 'NO_CHARGEABLE_DAYS',
        message: '指定された申請期間には勤務義務日が存在しません（全日週休日または祝日です）'
      };
    }

    const totalChargedHours = unitType === 'TIME' ? (totalChargedMinutes / 60) : 0;

    // 4. Canonical Entitlement Deduction Model の生成
    const entitlementDeduction: AnnualLeaveEntitlementDeduction = {
      deductionHalfUnits: totalChargedHalfUnits,
      chargedHourlyMinutes: unitType === 'TIME' ? totalChargedMinutes : 0,
      sourceWorkingMinutes: totalNetWorkMinutes,
      roundedLeaveMinutes: totalChargedMinutes,
      policyVersion: '2026.1'
    };

    // 5. 残高検証 (年休の場合)
    let currentRemainingDays = 20;
    let simulatedRemainingText = '';
    if (typeId === 'LEAVE_ANNUAL' && primaryPolicyContext) {
      const balance = AnnualLeaveService.getLeaveBalance(subjectUserId, startDate);
      currentRemainingDays = balance.remainingDays;

      if (unitType === 'DAY' || unitType === 'HALF_DAY') {
        const requiredHalfUnits = totalChargedHalfUnits;
        const availableHalfUnits = (balance.remainingDays * 2) + (balance.remainingMinutes >= (primaryPolicyContext.dayConversion.status === 'APPLICABLE' ? Math.floor(primaryPolicyContext.dayConversion.minutesPerDay / 2) : 232) ? 1 : 0);
        if (balance.remainingDays < totalChargedDays) {
          return {
            isValid: false,
            errorCode: 'INSUFFICIENT_BALANCE',
            message: `年次有給休暇の残日数が不足しています（現在残数: ${balance.formattedBalanceText}）`
          };
        }
      } else if (unitType === 'TIME') {
        const totalAvailMins = (balance.remainingDays * (primaryPolicyContext.dayConversion.status === 'APPLICABLE' ? primaryPolicyContext.dayConversion.minutesPerDay : 465)) + balance.remainingMinutes;
        if (totalAvailMins < totalChargedMinutes) {
          return {
            isValid: false,
            errorCode: 'INSUFFICIENT_BALANCE',
            message: `年次有給休暇の残時間が不足しています（現在残数: ${balance.formattedBalanceText}）`
          };
        }
      }
    }

    // 6. 不変 CalculationSnapshot の構築
    const snapshot: CalculationSnapshot = {
      engineVersion: CALCULATION_ENGINE_VERSION,
      calculatedAt: now,
      policyRuleId: 1,
      policyCode: primaryPolicyContext?.policyCode || (typeId === 'LEAVE_SICK' ? 'SICK_LEAVE' : typeId === 'LEAVE_SPECIAL' ? 'SPECIAL_LEAVE' : 'DUTY_EXEMPT'),
      policyVersion: primaryPolicyContext?.policyVersion || '2026.1',
      policyEffectiveFrom: '1971-12-24',
      workPatternId: firstDaySchedule?.patternId || 0,
      workPatternName: firstDaySchedule?.patternName || '未割当',
      workPatternEffectiveFrom: '2026-04-01',
      scheduledWorkMinutes: firstDaySchedule?.scheduledWorkMinutes || 0,
      workIntervalsSnapshot: firstDaySchedule?.effectiveIntervals || [],
      unitType,
      halfDayType: unitType === 'HALF_DAY' ? halfDayType : undefined,
      requestedStart: unitType === 'TIME' ? startTime : undefined,
      requestedEnd: unitType === 'TIME' ? endTime : undefined,
      netWorkMinutes: totalNetWorkMinutes,
      breakOverlapMinutes: totalBreakOverlapMinutes,
      roundingRule: typeId === 'LEAVE_ANNUAL' ? 'CEIL_60' : 'NONE',
      roundingAddedMinutes: totalRoundingAddedMinutes,
      chargedMinutes: totalChargedMinutes,
      chargedHours: totalChargedHours,
      chargedDays: totalChargedDays,
      deductionUnits: totalChargedHalfUnits,
      attendanceDeductionMinutes: totalChargedMinutes,
      isMultiDayRange: isRange,
      startDate,
      endDate,
      chargeableDaysCount,
      skippedNonWorkingDaysCount
    };

    let detailsText = '';
    const leaveName = typeId === 'LEAVE_ANNUAL' ? '年休' : '休暇';
    if (isRange) {
      detailsText = `期間申請: ${startDate}〜${endDate} (全${targetDates.length}日中 勤務義務${chargeableDaysCount}日) ➔ ${leaveName}消費: ${totalChargedDays}日`;
    } else if (unitType === 'DAY') {
      detailsText = `1日${leaveName} (終日勤務免除: ${totalChargedMinutes}分)`;
    } else if (unitType === 'HALF_DAY') {
      detailsText = `${halfDayType === 'MORNING' ? '午前' : '午後'}半日${leaveName} (0.5日免除: ${totalChargedMinutes}分)`;
    } else if (unitType === 'TIME') {
      detailsText = typeId === 'LEAVE_ANNUAL'
        ? `時間休: ${totalChargedHours}時間 (実不在 ${Math.floor(totalNetWorkMinutes / 60)}時間${totalNetWorkMinutes % 60}分 ＋ 端数切上 ${totalRoundingAddedMinutes}分)`
        : `時間休: 実免除 ${totalChargedMinutes}分`;
    }

    return {
      isValid: true,
      snapshot,
      detailsText,
      currentRemainingDays,
      simulatedRemainingText,
      totalChargedDays,
      totalChargedHours,
      totalChargedMinutes,
      entitlementDeduction,
      chargeableDaysCount,
      skippedNonWorkingDaysCount,
      perDayResults
    };
  }
}
