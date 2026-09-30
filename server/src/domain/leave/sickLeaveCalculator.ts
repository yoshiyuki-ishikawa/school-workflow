import {
  DiseaseContinuityDecision,
  SickLeaveCalculationInput,
  SickLeaveCalculationResult,
  DailyOverlayBreakdown,
  DayType
} from '../../types/sickLeaveDomain';
import { WorkingObligationResolver } from '../../services/attendance/workingObligationResolver';

/**
 * 2つの日付間の連続する暦日リスト(YYYY-MM-DD)を生成する
 */
export function getCalendarDateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const curr = new Date(startDate);
  const end = new Date(endDate);
  
  if (curr > end) {
    throw new Error(`startDate (${startDate}) must not be after endDate (${endDate})`);
  }

  while (curr <= end) {
    const y = curr.getFullYear();
    const m = String(curr.getMonth() + 1).padStart(2, '0');
    const d = String(curr.getDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${d}`);
    curr.setDate(curr.getDate() + 1);
  }
  return dates;
}

/**
 * 2つの日付間の暦日数を計算する（両端含む）
 */
export function calculateCalendarSpanDays(startDate: string, endDate: string): number {
  return getCalendarDateRange(startDate, endDate).length;
}

/**
 * 区間リストのUnion（重複をマージしたユニーク暦日集合）のサイズを計算する
 */
export function calculateIntervalUnionCalendarDays(
  intervals: Array<{ startDate: string; endDate: string }>
): number {
  const dateSet = new Set<string>();
  for (const interval of intervals) {
    const dates = getCalendarDateRange(interval.startDate, interval.endDate);
    for (const d of dates) {
      dateSet.add(d);
    }
  }
  return dateSet.size;
}

/**
 * 直前承認病休との連続性（Consecutive Sick Leave Span）を解決する
 * 
 * 制度Invariant:
 * - DiseaseContinuityDecision には依存しない（Case A）。
 * - 暦日上の連続性（直前病休の endDate の翌日が startDate、または重複）を判定。
 */
export function resolveConsecutiveSickLeaveSpanDays(
  currentStartDate: string,
  currentEndDate: string,
  approvedIntervals: Array<{ startDate: string; endDate: string; status: string }>
): number {
  // 有効な（APPROVED）直前区間のみを対象
  const validIntervals = approvedIntervals.filter((i) => i.status === 'APPROVED');
  
  let mergedStart = currentStartDate;
  let mergedEnd = currentEndDate;
  
  let changed = true;
  while (changed) {
    changed = false;
    for (const interval of validIntervals) {
      const iStart = interval.startDate;
      const iEnd = interval.endDate;
      
      const prevOfMergedStart = new Date(mergedStart);
      prevOfMergedStart.setDate(prevOfMergedStart.getDate() - 1);
      const prevDateStr = prevOfMergedStart.toISOString().slice(0, 10);
      
      const nextOfMergedEnd = new Date(mergedEnd);
      nextOfMergedEnd.setDate(nextOfMergedEnd.getDate() + 1);
      const nextDateStr = nextOfMergedEnd.toISOString().slice(0, 10);

      // interval が merged 範囲と接続または重複しているか
      const isConnected =
        (iStart <= mergedEnd && iEnd >= mergedStart) || // 重複
        (iEnd === prevDateStr) ||                       // 直前接続
        (iStart === nextDateStr);                       // 直後接続

      if (isConnected) {
        const newStart = iStart < mergedStart ? iStart : mergedStart;
        const newEnd = iEnd > mergedEnd ? iEnd : mergedEnd;
        if (newStart !== mergedStart || newEnd !== mergedEnd) {
          mergedStart = newStart;
          mergedEnd = newEnd;
          changed = true;
        }
      }
    }
  }

  return calculateCalendarSpanDays(mergedStart, mergedEnd);
}

/**
 * SickLeaveCalculator (Domain Core)
 */
export class SickLeaveCalculator {
  static calculate(input: SickLeaveCalculationInput): SickLeaveCalculationResult {
    const {
      userId,
      startDate,
      endDate,
      medicalCertificateAttached,
      diseaseContinuityDecision = 'UNRESOLVED',
      existingApprovedIntervals = []
    } = input;

    // 1. 基本日付バリデーション
    if (!startDate || !endDate || startDate > endDate) {
      return {
        isFailClosed: true,
        failReason: `不正な期間指定です: ${startDate} 〜 ${endDate}`
      };
    }

    // 2. Fact 1: applicationCalendarSpanDays の算出
    const applicationCalendarSpanDays = calculateCalendarSpanDays(startDate, endDate);

    // 3. Fact 2: consecutiveSickLeaveSpanDays の解決 (DiseaseDecision 非依存)
    const consecutiveSickLeaveSpanDays = resolveConsecutiveSickLeaveSpanDays(
      startDate,
      endDate,
      existingApprovedIntervals
    );

    const isConsecutive6Days = consecutiveSickLeaveSpanDays >= 6;
    const medicalCertificateRequired = isConsecutive6Days;

    // 診断書バリデーション
    if (medicalCertificateRequired && !medicalCertificateAttached) {
      return {
        isFailClosed: true,
        failReason: `引き続き6日以上の病気休暇（連続${consecutiveSickLeaveSpanDays}日間）には医師の診断書の提出が必要です`
      };
    }

    // 4. Fact 3: accumulatedSameDiseaseCalendarDays の解決 (Interval Union)
    // 過去1年以内の APPROVED かつ SAME_DISEASE の区間を抽出
    const oneYearAgoDate = new Date(startDate);
    oneYearAgoDate.setFullYear(oneYearAgoDate.getFullYear() - 1);
    const oneYearAgoStr = oneYearAgoDate.toISOString().slice(0, 10);

    const sameDiseasePriorIntervals = existingApprovedIntervals.filter((i) => {
      return (
        i.status === 'APPROVED' &&
        i.diseaseContinuityDecision === 'SAME_DISEASE' &&
        i.endDate >= oneYearAgoStr &&
        i.startDate <= endDate
      );
    });

    let accumulatedBefore: number | null = null;
    let accumulatedAfter: number | null = null;

    if (diseaseContinuityDecision === 'UNRESOLVED') {
      // 過去に病休履歴がある場合、未確定は Fail-Closed
      if (existingApprovedIntervals.filter((i) => i.status === 'APPROVED').length > 0) {
        return {
          isFailClosed: true,
          failReason: '同一疾病かどうかの行政判断 (diseaseContinuityDecision) が未確定のため計算を完了できません'
        };
      }
      // 過去履歴が全くない初回申請の場合は SEPARATE_DISEASE 相当として初期化
      accumulatedBefore = 0;
      accumulatedAfter = applicationCalendarSpanDays;
    } else if (diseaseContinuityDecision === 'SEPARATE_DISEASE') {
      // 別疾病認定: 過去分を通算せず、今回区間のみを起算
      accumulatedBefore = 0;
      accumulatedAfter = applicationCalendarSpanDays;
    } else if (diseaseContinuityDecision === 'SAME_DISEASE') {
      // 同一疾病認定: 過去区間と今回区間の Union
      accumulatedBefore = calculateIntervalUnionCalendarDays(sameDiseasePriorIntervals);
      accumulatedAfter = calculateIntervalUnionCalendarDays([
        ...sameDiseasePriorIntervals,
        { startDate, endDate }
      ]);
    }

    const isExceeding90Days = (accumulatedAfter !== null && accumulatedAfter > 90);

    // 5. 4層 Attendance Overlay & Duty Exemption の計算 (Working Obligation SSOT 接続)
    const dates = getCalendarDateRange(startDate, endDate);
    const dailyBreakdown: DailyOverlayBreakdown[] = [];
    let totalDutyExemptionMinutes = 0;
    let totalDutyExemptionDays = 0;

    for (const date of dates) {
      const obligation = WorkingObligationResolver.resolve(userId, date);

      if (obligation.status === 'UNRESOLVED' || obligation.isFailClosed) {
        return {
          isFailClosed: true,
          failReason: `対象日 ${date} の勤務義務を解決できません: ${obligation.failReason}`
        };
      }

      let dayType: DayType = 'WORKDAY';
      if (obligation.sourceType === 'NATIONAL_HOLIDAY' || obligation.sourceType === 'CUSTOM_HOLIDAY') {
        dayType = 'HOLIDAY';
      } else if (obligation.status === 'NON_WORKING') {
        dayType = 'WEEKLY_OFF';
      }

      if (obligation.status === 'WORKING') {
        const workMinutes = obligation.workSchedule?.scheduledWorkMinutes ?? 0;
        if (workMinutes <= 0) {
          return {
            isFailClosed: true,
            failReason: `対象日 ${date} は勤務日ですが勤務時間が0分です`
          };
        }
        dailyBreakdown.push({
          date,
          dayType: 'WORKDAY',
          obligation: 'WORKING',
          obligationMinutes: workMinutes,
          dutyExemptionMinutes: workMinutes,
          dutyExemptionDays: 1.0,
          overlayTags: ['LEAVE_SICK']
        });
        totalDutyExemptionMinutes += workMinutes;
        totalDutyExemptionDays += 1.0;
      } else {
        // NON_WORKING (週休日・祝日など)
        dailyBreakdown.push({
          date,
          dayType,
          obligation: 'NON_WORKING',
          obligationMinutes: 0,
          dutyExemptionMinutes: 0,
          dutyExemptionDays: 0.0,
          overlayTags: [dayType, 'IN_SICK_LEAVE_PERIOD'] // 並印 Fact
        });
      }
    }

    const snapshot = {
      applicationCalendarSpanDays,
      consecutiveSickLeaveSpanDays,
      accumulatedSameDiseaseCalendarDaysBefore: accumulatedBefore,
      accumulatedSameDiseaseCalendarDaysAfter: accumulatedAfter,
      diseaseContinuityDecision,
      totalDutyExemptionDays,
      totalDutyExemptionMinutes,
      isConsecutive6Days,
      medicalCertificateRequired,
      isExceeding90Days,
      dailyBreakdown,
      policyVersion: '2026.1',
      calculationVersion: '1.2',
      calculatedAt: new Date().toISOString()
    };

    return {
      isFailClosed: false,
      snapshot
    };
  }
}
