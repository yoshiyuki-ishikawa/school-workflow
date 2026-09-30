import {
  CanonicalServiceFact,
  CanonicalServiceStatus,
  AttendanceDomainResult,
  ConflictArchitectureAction
} from './types';
import { CanonicalFactDeduplicationRegistry } from './deduplication';

const DAY_OF_WEEK_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

export interface EvaluationContext {
  userId: number;
  date: string;
  scheduledWorkMinutes?: number; // デフォルト465分
  isWorkDay?: boolean;
}

/**
 * Phase B & C: Canonical Pipeline PoC
 * 
 * 責務:
 * 1. CanonicalServiceFact[] の Deduplication 検証
 * 2. 決定論的 Conflict Architecture 評価 (インメモリ)
 * 3. AttendanceDomainResult の生成
 */
export class CanonicalPipelinePoC {
  /**
   * 1日分の出勤簿ドメイン結果を評価・生成
   */
  static evaluateDay(
    ctx: EvaluationContext,
    facts: CanonicalServiceFact[]
  ): AttendanceDomainResult {
    const explanations: Array<{ layer: number; ruleApplied: string }> = [];
    const dt = new Date(ctx.date);
    const dayOfWeek = DAY_OF_WEEK_NAMES[dt.getDay()];

    // 1. Deduplication 検証 (重複Factが存在する場合は Fail-Closed)
    const registry = new CanonicalFactDeduplicationRegistry();
    registry.registerAll(facts);
    const validFacts = registry.getFacts();

    const contributingFactIds: string[] = validFacts.map(f => f.factId);

    // 2. 基底所定時間・勤務日判定 (Authoritative Context から厳格に受領)
    let scheduledWorkMinutes = ctx.scheduledWorkMinutes !== undefined ? ctx.scheduledWorkMinutes : 465;
    let isScheduledWorkDay = ctx.isWorkDay !== undefined ? ctx.isWorkDay : (dt.getDay() !== 0 && dt.getDay() !== 6);
    let dutyStatus: 'WORK_REQUIRED' | 'NO_WORK_REQUIRED' | 'EXEMPT' = isScheduledWorkDay ? 'WORK_REQUIRED' : 'NO_WORK_REQUIRED';

    // 3. Layer 1: Calendar & Work Schedule Fact 評価
    const calFact = validFacts.find(f => f.canonicalStatus === 'HOLIDAY');
    const weekOffFact = validFacts.find(f => f.canonicalStatus === 'WEEKLY_OFF');
    const subHolidayFact = validFacts.find(f => f.canonicalStatus === 'SUBSTITUTE_HOLIDAY');
    const shortTimeFact = validFacts.find(f => f.canonicalStatus === 'CHILDCARE_SHORT_TIME');

    if (shortTimeFact) {
      if (shortTimeFact.details?.scheduledWorkMinutes !== undefined) {
        scheduledWorkMinutes = shortTimeFact.details.scheduledWorkMinutes;
      }
      explanations.push({ layer: 2, ruleApplied: `短時間勤務パターン適用 (所定${scheduledWorkMinutes}分)` });
    }

    if (calFact || weekOffFact || subHolidayFact) {
      isScheduledWorkDay = false;
      dutyStatus = 'NO_WORK_REQUIRED';
      scheduledWorkMinutes = 0;
      const primaryStatus = subHolidayFact?.canonicalStatus || calFact?.canonicalStatus || weekOffFact?.canonicalStatus || 'WEEKLY_OFF';
      explanations.push({
        layer: 1,
        ruleApplied: `非勤務日適用: ${primaryStatus}`
      });

      // 休日出張等がない場合の即時リターンは Layer 4 で行うか、または tripFact がない場合
      const hasTripFact = validFacts.some(f => f.canonicalStatus === 'OFFICIAL_BUSINESS_TRIP');
      if (!hasTripFact) {
        return {
          userId: ctx.userId,
          date: ctx.date,
          dayOfWeek,
          isScheduledWorkDay: false,
          dutyStatus: 'NO_WORK_REQUIRED',
          scheduledWorkMinutes: 0,
          countedWorkMinutes: 0,
          deductionMinutes: 0,
          effectiveWorkMinutes: 0,
          primaryCanonicalStatus: primaryStatus,
          secondaryCanonicalStatuses: [],
          appliedConflictAction: 'OVERRIDE_ALL',
          aggregationCategory: primaryStatus,
          contributingFactIds,
          isPersonnelStatusOverridden: false,
          explanations
        };
      }
    }

    // 4. Layer 2: Period Status (人事身分・最優先オーバーライド) 評価
    const periodStatusFact = validFacts.find(f =>
      [
        'DISCIPLINARY_SUSPENSION',
        'ADMINISTRATIVE_LEAVE_SUSPENSION',
        'UNION_FULL_TIME_SUSPENSION',
        'CHILDCARE_LEAVE',
        'SELF_DEVELOPMENT_LEAVE',
        'SPOUSAL_ACCOMPANIMENT_LEAVE',
        'DISPATCH',
        'FOREIGN_DISPATCH'
      ].includes(f.canonicalStatus)
    );

    if (periodStatusFact) {
      explanations.push({
        layer: 4,
        ruleApplied: `人事身分状態 OVERRIDE_ALL: ${periodStatusFact.canonicalStatus}`
      });

      return {
        userId: ctx.userId,
        date: ctx.date,
        dayOfWeek,
        isScheduledWorkDay: false,
        dutyStatus: 'NO_WORK_REQUIRED',
        scheduledWorkMinutes: 0,
        countedWorkMinutes: 0,
        deductionMinutes: 0,
        effectiveWorkMinutes: 0,
        primaryCanonicalStatus: periodStatusFact.canonicalStatus,
        secondaryCanonicalStatuses: [],
        appliedConflictAction: 'OVERRIDE_ALL',
        aggregationCategory: 'NON_WORK',
        contributingFactIds,
        isPersonnelStatusOverridden: true,
        explanations
      };
    }

    // 5. Layer 3: Absence Fact (全日欠勤) 評価
    const fullAbsenceFact = validFacts.find(f => f.canonicalStatus === 'ABSENCE' && f.factType === 'DAY_EVENT');
    if (fullAbsenceFact && dutyStatus === 'WORK_REQUIRED') {
      explanations.push({ layer: 5, ruleApplied: '全日欠勤適用 (所定時間全額控除)' });
      return {
        userId: ctx.userId,
        date: ctx.date,
        dayOfWeek,
        isScheduledWorkDay: true,
        dutyStatus: 'WORK_REQUIRED',
        scheduledWorkMinutes,
        countedWorkMinutes: 0,
        deductionMinutes: scheduledWorkMinutes,
        effectiveWorkMinutes: 0,
        primaryCanonicalStatus: 'ABSENCE',
        secondaryCanonicalStatuses: [],
        appliedConflictAction: 'OVERRIDE_ALL',
        aggregationCategory: 'ABSENCE',
        contributingFactIds,
        isPersonnelStatusOverridden: false,
        explanations
      };
    }

    // 6. Layer 4: Daily Events (終日年休・特休・病休・出張・研修) 評価
    const dailyFacts = validFacts.filter(f => f.factType === 'DAY_EVENT' && f.canonicalStatus !== 'ABSENCE');
    const workCountedFact = dailyFacts.find(f => f.canonicalStatus === 'OFFICIAL_BUSINESS_TRIP' || f.canonicalStatus === 'TRAINING');
    const leaveDailyFact = dailyFacts.find(f => f.canonicalStatus !== 'OFFICIAL_BUSINESS_TRIP' && f.canonicalStatus !== 'TRAINING');

    // 休日/週休日 + 出張/研修 の Coexist & Accumulate
    if (workCountedFact && !isScheduledWorkDay) {
      explanations.push({ layer: 6, ruleApplied: `休日/週休日 ${workCountedFact.canonicalStatus} COEXIST_AND_ACCUMULATE (実働算入)` });
      return {
        userId: ctx.userId,
        date: ctx.date,
        dayOfWeek,
        isScheduledWorkDay: false,
        dutyStatus: 'WORK_REQUIRED',
        scheduledWorkMinutes: 0,
        countedWorkMinutes: 465,
        deductionMinutes: 0,
        effectiveWorkMinutes: 465,
        primaryCanonicalStatus: workCountedFact.canonicalStatus,
        secondaryCanonicalStatuses: calFact ? ['HOLIDAY'] : weekOffFact ? ['WEEKLY_OFF'] : [],
        appliedConflictAction: 'COEXIST_AND_ACCUMULATE',
        aggregationCategory: workCountedFact.canonicalStatus === 'TRAINING' ? 'TRAINING' : 'BUSINESS_TRIP',
        contributingFactIds,
        isPersonnelStatusOverridden: false,
        explanations
      };
    }

    if (leaveDailyFact) {
      explanations.push({ layer: 6, ruleApplied: `終日服務イベント適用: ${leaveDailyFact.canonicalStatus}` });
      return {
        userId: ctx.userId,
        date: ctx.date,
        dayOfWeek,
        isScheduledWorkDay: true,
        dutyStatus: 'WORK_REQUIRED',
        scheduledWorkMinutes,
        countedWorkMinutes: 0,
        deductionMinutes: scheduledWorkMinutes,
        effectiveWorkMinutes: 0,
        primaryCanonicalStatus: leaveDailyFact.canonicalStatus,
        secondaryCanonicalStatuses: [],
        appliedConflictAction: 'OVERRIDE_ALL',
        aggregationCategory: leaveDailyFact.canonicalStatus,
        contributingFactIds,
        isPersonnelStatusOverridden: false,
        explanations
      };
    }

    if (workCountedFact) {
      explanations.push({ layer: 6, ruleApplied: `${workCountedFact.canonicalStatus}適用 (実働算入)` });
      return {
        userId: ctx.userId,
        date: ctx.date,
        dayOfWeek,
        isScheduledWorkDay: true,
        dutyStatus: 'WORK_REQUIRED',
        scheduledWorkMinutes,
        countedWorkMinutes: scheduledWorkMinutes,
        deductionMinutes: 0,
        effectiveWorkMinutes: scheduledWorkMinutes,
        primaryCanonicalStatus: workCountedFact.canonicalStatus,
        secondaryCanonicalStatuses: [],
        appliedConflictAction: 'OVERRIDE_ALL',
        aggregationCategory: workCountedFact.canonicalStatus === 'TRAINING' ? 'TRAINING' : 'BUSINESS_TRIP',
        contributingFactIds,
        isPersonnelStatusOverridden: false,
        explanations
      };
    }

    // 7. Layer 5: Time Events (時間単位年休・介護時間・部分休業等)
    const timeFacts = validFacts.filter(f => f.factType === 'TIME_EVENT');
    if (timeFacts.length > 0 && isScheduledWorkDay) {
      let totalDeduction = 0;
      const statuses: CanonicalServiceStatus[] = [];

      for (const tf of timeFacts) {
        // 時間交差計算 (quantityUnits または 60分)
        const deduction = tf.quantityUnits || 60;
        totalDeduction += deduction;
        statuses.push(tf.canonicalStatus);
        explanations.push({
          layer: 7,
          ruleApplied: `時間単位事象 COEXIST_AND_DEDUCT: ${tf.canonicalStatus} (${deduction}分控除)`
        });
      }

      const effective = Math.max(0, scheduledWorkMinutes - totalDeduction);

      return {
        userId: ctx.userId,
        date: ctx.date,
        dayOfWeek,
        isScheduledWorkDay: true,
        dutyStatus: 'WORK_REQUIRED',
        scheduledWorkMinutes,
        countedWorkMinutes: effective,
        deductionMinutes: totalDeduction,
        effectiveWorkMinutes: effective,
        primaryCanonicalStatus: statuses[0],
        secondaryCanonicalStatuses: statuses.slice(1),
        appliedConflictAction: 'COEXIST_AND_DEDUCT',
        aggregationCategory: statuses[0],
        contributingFactIds,
        isPersonnelStatusOverridden: false,
        explanations
      };
    }

    // 8. 通常勤務日 / 非勤務日 (Default Normal Work / Off Day)
    return {
      userId: ctx.userId,
      date: ctx.date,
      dayOfWeek,
      isScheduledWorkDay,
      dutyStatus,
      scheduledWorkMinutes: isScheduledWorkDay ? scheduledWorkMinutes : 0,
      countedWorkMinutes: isScheduledWorkDay ? scheduledWorkMinutes : 0,
      deductionMinutes: 0,
      effectiveWorkMinutes: isScheduledWorkDay ? scheduledWorkMinutes : 0,
      primaryCanonicalStatus: isScheduledWorkDay ? 'WORKED' as any : (weekOffFact?.canonicalStatus || (calFact?.canonicalStatus) || 'WEEKLY_OFF'),
      secondaryCanonicalStatuses: [],
      appliedConflictAction: 'DISPLAY_PRECEDENCE',
      aggregationCategory: isScheduledWorkDay ? 'WORKED' : 'WEEKLY_OFF',
      contributingFactIds,
      isPersonnelStatusOverridden: false,
      explanations: [{ layer: 0, ruleApplied: isScheduledWorkDay ? '通常勤務' : '所定週休' }]
    };
  }
}
