import { getDb } from '../../db/database';
import { AttendanceResolutionContext, AttendanceLayerResult } from './types';
import { getSystemJapaneseHolidayName, getSystemYearEndNewYearHolidayName } from '../../utils/attendanceEngine';
import { WorkTimeInterval, timeToMinutes, minutesToTime } from './workPatternResolver';
export { WorkTimeInterval, timeToMinutes, minutesToTime };

/**
 * 勤務パターンから指定日の有効勤務区間リストを取得 (休憩時間を除外)
 */
export function getEffectiveWorkIntervals(workSchedule: any): WorkTimeInterval[] {
  if (!workSchedule || !workSchedule.isWorkDay) return [];

  if (workSchedule.schedule?.intervals && Array.isArray(workSchedule.schedule.intervals)) {
    return workSchedule.schedule.intervals.map((inv: any) => ({
      start: timeToMinutes(inv.startTime),
      end: timeToMinutes(inv.endTime)
    }));
  }

  // デフォルト短時間
  if (workSchedule.patternType === 'SHORT_TIME' || (workSchedule.workMinutes > 0 && workSchedule.workMinutes < 465)) {
    const start = workSchedule.schedule?.startTime ? timeToMinutes(workSchedule.schedule.startTime) : timeToMinutes('08:30');
    const end = workSchedule.schedule?.endTime ? timeToMinutes(workSchedule.schedule.endTime) : (start + workSchedule.workMinutes);
    return [{ start, end }];
  }

  // デフォルトフルタイム (8:10〜16:40、休憩 12:00〜12:45)
  return [
    { start: timeToMinutes('08:10'), end: timeToMinutes('12:00') }, // 230分
    { start: timeToMinutes('12:45'), end: timeToMinutes('16:40') }  // 235分 (合計465分)
  ];
}

/**
 * 指定時間帯と実勤務予定区間の交差時間 (分数) を Server-Authoritative に厳密算出
 */
export function calculateWorkIntersectionMinutes(
  startTime: string,
  endTime: string,
  workSchedule: any
): number {
  if (!startTime || !endTime || !workSchedule || !workSchedule.isWorkDay) return 0;

  const eventStart = timeToMinutes(startTime);
  const eventEnd = timeToMinutes(endTime);
  if (eventEnd <= eventStart) return 0;

  const intervals = getEffectiveWorkIntervals(workSchedule);
  let totalIntersection = 0;

  for (const interval of intervals) {
    const overlapStart = Math.max(eventStart, interval.start);
    const overlapEnd = Math.min(eventEnd, interval.end);
    if (overlapEnd > overlapStart) {
      totalIntersection += (overlapEnd - overlapStart);
    }
  }

  return totalIntersection;
}

/**
 * 制度ポリシー解決結果インターフェース
 */
export interface ResolvedAttendancePolicy {
  isFailClosed: boolean;
  failReason?: 'MISSING' | 'INVALID' | 'UNCONFIRMED' | 'DISALLOWED';
  legalBasis?: string;
  displaySymbol?: string;
  displayName?: string;
  stampSubText?: string;
  aggregationCategory?: string;
  workTimeTreatment?: string;
  deductionRule?: string;
  hourlyDisplayRule?: string;
  travelOrderRequirement?: string;
  deductionMinutes?: number;
}

/**
 * policy_rules から確定済み設定を決定論的に解決 (推測禁止・Fail-Closed)
 */
export function resolveAttendancePolicy(
  policyCode: string,
  authorityId: string = 'DEFAULT_MUNICIPALITY',
  unitType: 'DAY' | 'HALF_DAY' | 'TIME' | 'MULTI_DAY' = 'DAY',
  details?: any
): ResolvedAttendancePolicy {
  const db = getDb();
  const rule = db.prepare(`
    SELECT * FROM policy_rules
    WHERE policy_code = ? AND authority_id = ? AND is_active = 1
    ORDER BY id DESC LIMIT 1
  `).get(policyCode, authorityId) as any;

  if (!rule) {
    return { isFailClosed: true, failReason: 'MISSING' };
  }

  let def: any = {};
  try {
    def = JSON.parse(rule.rule_definition_json || '{}');
  } catch {
    return { isFailClosed: true, failReason: 'INVALID' };
  }

  if (def.status === 'UNCONFIRMED' || rule.display_code === 'UNCONFIRMED') {
    return { isFailClosed: true, failReason: 'UNCONFIRMED' };
  }

  // 単位ごとの可否チェック
  if (Array.isArray(def.allowedDurationUnits)) {
    if (!def.allowedDurationUnits.includes(unitType)) {
      return { isFailClosed: true, failReason: 'DISALLOWED' };
    }
  } else {
    if (unitType === 'TIME') {
      if (def.hourlyAllowed !== 'CONFIRMED' && def.hourlyAllowed !== true) {
        return { isFailClosed: true, failReason: def.hourlyAllowed === 'UNCONFIRMED' ? 'UNCONFIRMED' : 'DISALLOWED' };
      }
    } else if (unitType === 'HALF_DAY') {
      if (def.halfDayAllowed !== 'CONFIRMED' && def.halfDayAllowed !== true) {
        return { isFailClosed: true, failReason: def.halfDayAllowed === 'UNCONFIRMED' ? 'UNCONFIRMED' : 'DISALLOWED' };
      }
    }
  }

  // 表示記号の解決
  let displaySymbol = rule.display_code;
  if (unitType === 'DAY' || unitType === 'MULTI_DAY') {
    if (def.dailyDisplayRule === 'UNCONFIRMED' || !displaySymbol || displaySymbol === 'UNCONFIRMED') {
      return { isFailClosed: true, failReason: 'UNCONFIRMED' };
    }
  } else if (unitType === 'HALF_DAY') {
    if (def.halfDayDisplayRule === 'UNCONFIRMED') {
      return { isFailClosed: true, failReason: 'UNCONFIRMED' };
    }
  } else if (unitType === 'TIME') {
    if (def.hourlyDisplayRule === 'UNCONFIRMED') {
      return { isFailClosed: true, failReason: 'UNCONFIRMED' };
    }
  }

  // 勤務時間取扱い
  if (def.workTimeTreatment === 'UNCONFIRMED' || def.deductionRule === 'UNCONFIRMED') {
    return { isFailClosed: true, failReason: 'UNCONFIRMED' };
  }

  // 集計区分
  let agg = rule.aggregation_category;
  if (def.monthlyAggregationRule === 'UNCONFIRMED' || !agg || agg === 'UNCONFIRMED') {
    return { isFailClosed: true, failReason: 'UNCONFIRMED' };
  }

  const stampSubText = unitType === 'HALF_DAY' ? (def.halfDayStampSubText || '半日') : undefined;

  return {
    isFailClosed: false,
    legalBasis: def.legalBasis,
    displaySymbol,
    displayName: rule.official_name || def.officialName,
    stampSubText,
    aggregationCategory: agg,
    workTimeTreatment: def.workTimeTreatment || 'COUNT_AS_WORK',
    deductionRule: def.deductionRule || 'NONE',
    hourlyDisplayRule: def.hourlyDisplayRule,
    travelOrderRequirement: def.travelOrderRequirement
  };
}

/**
 * Layer 1: Calendar Resolver (祝日・学校行事・独自休日・年末年始)
 */
export function resolveCalendarLayer(ctx: AttendanceResolutionContext): {
  isHoliday: boolean;
  holidayName?: string;
  isNationalHoliday: boolean;
  isSchoolHoliday: boolean;
  isMunicipalityHoliday: boolean;
} {
  const db = getDb();
  const custom = db.prepare('SELECT * FROM custom_holidays WHERE holiday_date = ?').get(ctx.date) as any;

  if (custom) {
    if (custom.is_active === 0) {
      return { isHoliday: false, isNationalHoliday: false, isSchoolHoliday: false, isMunicipalityHoliday: false };
    }
    return {
      isHoliday: true,
      holidayName: custom.name,
      isNationalHoliday: custom.holiday_type === 'NATIONAL_LEGAL_OVERRIDE',
      isSchoolHoliday: custom.holiday_type === 'SCHOOL_HOLIDAY',
      isMunicipalityHoliday: custom.holiday_type === 'MUNICIPALITY_HOLIDAY'
    };
  }

  const systemHoliday = getSystemJapaneseHolidayName(ctx.date);
  if (systemHoliday) {
    return { isHoliday: true, holidayName: systemHoliday, isNationalHoliday: true, isSchoolHoliday: false, isMunicipalityHoliday: false };
  }

  const yearEndHoliday = getSystemYearEndNewYearHolidayName(ctx.date);
  if (yearEndHoliday) {
    return { isHoliday: true, holidayName: yearEndHoliday, isNationalHoliday: false, isSchoolHoliday: false, isMunicipalityHoliday: true };
  }

  return { isHoliday: false, isNationalHoliday: false, isSchoolHoliday: false, isMunicipalityHoliday: false };
}

/**
 * Layer 2: Work Pattern Resolver (基本割振り・育児短時間・平日週休)
 */
export function resolveWorkPatternLayer(ctx: AttendanceResolutionContext) {
  const db = getDb();
  const pattern = db.prepare(`
    SELECT * FROM user_work_patterns
    WHERE user_id = ? AND effective_from <= ? AND effective_to >= ?
    ORDER BY effective_from DESC LIMIT 1
  `).get(ctx.userId, ctx.date, ctx.date) as any;

  if (!pattern) {
    return {
      hasUnknownPattern: true,
      patternName: 'UNKNOWN',
      patternType: 'CUSTOM',
      isWorkDay: false,
      dutyStatus: 'NO_WORK_REQUIRED' as const,
      workMinutes: 0,
      schedule: null,
      weeklyOffDays: []
    };
  }

  const dt = new Date(ctx.date);
  const dayOfWeek = dt.getDay();
  const offDays = pattern.weekly_off_days.split(',').map((s: string) => parseInt(s.trim(), 10));
  const isWeeklyOff = offDays.includes(dayOfWeek);

  let workMinutes = 0;
  let scheduleDetails: any = null;
  if (pattern.schedule_details_json) {
    try {
      const details = JSON.parse(pattern.schedule_details_json);
      if (details[dayOfWeek]) {
        scheduleDetails = details[dayOfWeek];
        if (typeof scheduleDetails.workMinutes === 'number') {
          workMinutes = scheduleDetails.workMinutes;
        }
      }
    } catch {}
  }

  if (workMinutes === 0 && !isWeeklyOff) {
    workMinutes = pattern.pattern_type === 'SHORT_TIME' ? 240 : 465;
  }

  return {
    hasUnknownPattern: false,
    patternId: pattern.id,
    patternName: pattern.pattern_name,
    patternType: pattern.pattern_type,
    isWorkDay: !isWeeklyOff,
    dutyStatus: !isWeeklyOff ? ('WORK_REQUIRED' as const) : ('NO_WORK_REQUIRED' as const),
    workMinutes: isWeeklyOff ? 0 : workMinutes,
    schedule: scheduleDetails,
    weeklyOffDays: offDays
  };
}

/**
 * Layer 3: Calendar Adjustment Resolver (週休振替・代休・単日勤務日化・指定休日)
 */
export function resolveCalendarAdjustmentLayer(ctx: AttendanceResolutionContext): {
  hasAdjustment: boolean;
  adjustment?: any;
  dutyStatus: 'WORK_REQUIRED' | 'NO_WORK_REQUIRED';
  adjustmentType?: string;
  eventName?: string;
  reason?: string;
} | null {
  const db = getDb();
  const adj = db.prepare(`
    SELECT * FROM calendar_adjustments
    WHERE (scope_type = 'ALL' OR (scope_type = 'USER' AND user_id = ?))
      AND status = 'ACTIVE'
      AND (source_date = ? OR target_date = ?)
    ORDER BY (CASE WHEN scope_type = 'USER' THEN 1 ELSE 2 END) ASC, id DESC
    LIMIT 1
  `).get(ctx.userId, ctx.date, ctx.date) as any;

  if (!adj) {
    // レガシー calendar_overrides からのフォールバック
    try {
      const lo = db.prepare(`
        SELECT * FROM calendar_overrides
        WHERE (scope = 'ALL' OR (scope = 'USER' AND user_id = ?))
          AND date = ?
        ORDER BY id DESC LIMIT 1
      `).get(ctx.userId, ctx.date) as any;

      if (lo) {
        let adjType = 'SINGLE_WORKDAY_OVERRIDE';
        let dutyStatus: 'WORK_REQUIRED' | 'NO_WORK_REQUIRED' = 'WORK_REQUIRED';
        if (lo.override_type === 'WORKDAY') {
          adjType = 'SINGLE_WORKDAY_OVERRIDE';
          dutyStatus = 'WORK_REQUIRED';
        } else if (lo.override_type === 'WEEK_OFF') {
          adjType = 'WEEK_OFF_TRANSFER';
          dutyStatus = 'NO_WORK_REQUIRED';
        } else if (lo.override_type === 'SUBSTITUTE_HOLIDAY') {
          adjType = 'SUBSTITUTE_HOLIDAY';
          dutyStatus = 'NO_WORK_REQUIRED';
        } else if (lo.override_type === 'HOLIDAY') {
          adjType = 'DESIGNATED_NON_WORKDAY';
          dutyStatus = 'NO_WORK_REQUIRED';
        }

        return {
          hasAdjustment: true,
          adjustment: {
            id: lo.id,
            adjustment_code: `LEGACY-${lo.id}`,
            adjustment_type: adjType,
            event_name: lo.reason || '行事設定',
            reason: lo.reason || '行事設定',
            source_date: lo.date,
            scope_type: lo.scope || 'ALL',
          },
          dutyStatus,
          adjustmentType: adjType,
          eventName: lo.reason || '行事設定',
          reason: lo.reason || '行事設定'
        };
      }
    } catch {}
    return null;
  }

  const isSource = adj.source_date === ctx.date;
  const appliedDuty = isSource ? adj.source_duty_status : adj.target_duty_status;

  return {
    hasAdjustment: true,
    adjustment: adj,
    dutyStatus: appliedDuty === 'WORK_REQUIRED' ? 'WORK_REQUIRED' : 'NO_WORK_REQUIRED',
    adjustmentType: adj.adjustment_type,
    eventName: adj.event_name,
    reason: adj.reason
  };
}

/**
 * Layer 4: Personnel Status Resolver (育休・分限休職・専従休職・停職)
 */
export function resolvePersonnelStatusLayer(ctx: AttendanceResolutionContext): AttendanceLayerResult | null {
  const db = getDb();
  const status = db.prepare(`
    SELECT ps.*, pr.official_name, pr.display_code, pr.aggregation_category
    FROM personnel_statuses ps
    LEFT JOIN policy_rules pr ON ps.policy_rule_id = pr.id
    WHERE ps.user_id = ?
      AND ps.status IN ('CONFIRMED', 'EFFECTIVE')
      AND ps.effective_from <= ?
      AND (ps.effective_to IS NULL OR ps.effective_to >= ?)
    ORDER BY ps.id DESC LIMIT 1
  `).get(ctx.userId, ctx.date, ctx.date) as any;

  if (!status) return null;

  const isRestricted = ['DISCIPLINARY_SUSPENSION', 'SUSPENSION'].includes(status.status_type);
  const showDetail = ctx.includeRestricted || !isRestricted;

  let symbol = status.display_code || '休';
  if (status.status_type === 'CHILDCARE_LEAVE') symbol = '育';
  else if (status.status_type === 'SUSPENSION') symbol = '休';
  else if (status.status_type === 'DISCIPLINARY_SUSPENSION') symbol = '停';
  else if (status.status_type === 'UNION_FULL_TIME_RELEASE') symbol = '専';
  else if (status.status_type === 'GRADUATE_STUDY_LEAVE') symbol = '修';
  else if (status.status_type === 'SELF_DEVELOPMENT_LEAVE') symbol = '自';
  else if (status.status_type === 'SPOUSAL_ACCOMPANIMENT_LEAVE') symbol = '配';
  else if (status.status_type === 'DISPATCH') symbol = '派';

  return {
    layer: 4,
    layerName: 'PERSONNEL_STATUS',
    dutyStatus: 'NO_WORK_REQUIRED',
    statusCode: status.status_type,
    symbol: showDetail ? symbol : '-',
    displayName: showDetail ? (status.official_name || status.status_type) : '***',
    aggregationCategory: status.aggregation_category || 'NON_WORK',
    isWorkDay: false,
    scheduledMinutes: 0,
    actualMinutes: 0,
    details: {
      statusId: status.id,
      effectiveFrom: status.effective_from,
      effectiveTo: status.effective_to,
      documentRefNo: showDetail ? status.document_reference_no : undefined,
      isRestricted
    }
  };
}

/**
 * Layer 5: Absence Layer (全日欠勤)
 */
export function resolveAbsenceLayer(ctx: AttendanceResolutionContext, scheduledMinutes: number): AttendanceLayerResult | null {
  const db = getDb();
  const abs = db.prepare(`
    SELECT * FROM absences
    WHERE user_id = ? AND target_date = ? AND absence_type = 'FULL_DAY' AND status = 'CONFIRMED'
    ORDER BY id DESC LIMIT 1
  `).get(ctx.userId, ctx.date) as any;

  if (!abs) return null;

  return {
    layer: 5,
    layerName: 'FULL_DAY_ABSENCE',
    dutyStatus: 'WORK_REQUIRED',
    statusCode: 'ABSENCE_FULL_DAY',
    symbol: '欠',
    displayName: '全日欠勤',
    aggregationCategory: 'ABSENCE',
    isWorkDay: false,
    scheduledMinutes,
    actualMinutes: 0,
    deductionMinutes: scheduledMinutes,
    details: {
      absenceId: abs.id,
      status: abs.status,
      reason: ctx.includeRestricted ? abs.reason : undefined
    }
  };
}

/**
 * Layer 6: Daily Event Resolver (公務旅行・終日年休・病休・特休・職専免・特例法22条研修)
 */
export function resolveDailyEventLayer(ctx: AttendanceResolutionContext, scheduledMinutes: number): AttendanceLayerResult | null {
  const db = getDb();
  const apps = db.prepare(`
    SELECT a.id, a.type_id, a.form_data, t.name as type_name
    FROM applications a
    JOIN application_types t ON a.type_id = t.id
    WHERE a.subject_user_id = ?
      AND a.current_status IN ('FINAL_APPROVED', 'TRIP_APPROVED')
  `).all(ctx.userId) as any[];

  for (const app of apps) {
    try {
      const data = JSON.parse(app.form_data);
      const isMatch = (data.startDate && data.endDate && ctx.date >= data.startDate && ctx.date <= data.endDate) ||
                      (data.targetDate === ctx.date);
      if (isMatch && (!data.startTime || !data.endTime || data.unitType === 'DAY' || data.unitType === 'HALF_DAY')) {
        const isHalfDay = data.unitType === 'HALF_DAY';
        const uType = isHalfDay ? 'HALF_DAY' : 'DAY';

        // 特例法22条研修の場合 -> policy_rules から決定論的解決
        if (app.type_id === 'TRAINING_SPECIAL_ACT_22_2' || app.type_id === 'TRAINING_SPECIAL_ACT_22_3') {
          const policyCode = app.type_id === 'TRAINING_SPECIAL_ACT_22_2' ? 'SPECIAL_ACT_22_2' : 'SPECIAL_ACT_22_3';
          const pol = resolveAttendancePolicy(policyCode, ctx.authorityId || 'DEFAULT_MUNICIPALITY', uType, data);

          if (pol.isFailClosed) {
            return {
              layer: 6,
              layerName: 'FAIL_CLOSED_POLICY',
              dutyStatus: 'NO_WORK_REQUIRED',
              statusCode: 'UNKNOWN_PATTERN',
              symbol: '不明',
              displayName: 'ポリシー未設定のため判定停止',
              aggregationCategory: 'UNKNOWN',
              isWorkDay: false,
              scheduledMinutes,
              actualMinutes: 0,
              deductionMinutes: 0,
              details: { failReason: pol.failReason }
            };
          }

          const deductionMinutes = pol.deductionRule === 'NONE' ? 0 : (isHalfDay ? Math.floor(scheduledMinutes / 2) : scheduledMinutes);
          const actualMinutes = scheduledMinutes - deductionMinutes;

          return {
            layer: 6,
            layerName: 'DAILY_EVENT',
            dutyStatus: 'WORK_REQUIRED',
            statusCode: app.type_id,
            symbol: pol.displaySymbol || '研修',
            displayName: pol.displayName || app.type_name,
            aggregationCategory: pol.aggregationCategory || 'TRAINING',
            isWorkDay: true,
            scheduledMinutes,
            actualMinutes,
            deductionMinutes,
            details: {
              applicationId: app.id,
              title: data.purpose || data.reason || app.type_name,
              destination: data.destination,
              unitType: data.unitType || 'DAY',
              halfDayType: data.halfDayType,
              stampSubText: pol.stampSubText,
              legalBasis: pol.legalBasis,
              travelOrderRequirement: pol.travelOrderRequirement
            }
          };
        }

        let symbol = '年';
        let agg = 'ANNUAL_LEAVE';
        let displayName = app.type_name;
        let stampSubText: string | undefined = undefined;

        if (app.type_id === 'LEAVE_SICK') { symbol = '病'; agg = 'SICK_LEAVE'; }
        else if (app.type_id === 'LEAVE_SPECIAL') {
          const reasonCode = data.reasonCode || (data.specialLeaveType?.includes('産前産後') ? 'SPECIAL_MATERNITY_POST' : 'SPECIAL_BEREAVEMENT');
          const pol = resolveAttendancePolicy(reasonCode, ctx.authorityId || 'DEFAULT_MUNICIPALITY', uType, data);
          if (pol.isFailClosed) {
            return {
              layer: 6,
              layerName: 'FAIL_CLOSED_POLICY',
              dutyStatus: 'NO_WORK_REQUIRED',
              statusCode: 'UNKNOWN_PATTERN',
              symbol: '不明',
              displayName: 'ポリシー未設定のため判定停止',
              aggregationCategory: 'UNKNOWN',
              isWorkDay: false,
              scheduledMinutes,
              actualMinutes: 0,
              deductionMinutes: 0,
              details: { failReason: pol.failReason }
            };
          }
          symbol = pol.displaySymbol || '特';
          agg = pol.aggregationCategory || 'SPECIAL_LEAVE';
          displayName = pol.displayName || app.type_name;
          stampSubText = isHalfDay ? '半日' : undefined;
        }
        else if (app.type_id === 'LEAVE_DUTY_EXEMPT') { symbol = '免'; agg = 'DUTY_EXEMPT'; }
        else if (app.type_id === 'BUSINESS_TRIP') { symbol = '出張'; agg = 'BUSINESS_TRIP'; }
        else if (app.type_id === 'LEAVE_CARE') {
          symbol = '介護';
          agg = 'CARE_LEAVE';
          if (data.unitType === 'HALF_DAY') {
            displayName = '介護休暇 (半日)';
          }
        }

        const isTrip = app.type_id === 'BUSINESS_TRIP';
        let deductionMinutes = 0;
        if (isTrip) {
          deductionMinutes = 0;
        } else if (isHalfDay || data.unitType === 'HALF_DAY_AM' || data.unitType === 'HALF_DAY_PM') {
          // 実勤務区間から午前/午後の免除時間を算出 (均等分割 floor(scheduledMinutes/2) の完全廃止)
          const workPattern = resolveWorkPatternLayer(ctx);
          const intervals = getEffectiveWorkIntervals(workPattern);
          const isMorning = data.unitType === 'HALF_DAY_AM' || data.halfDayType === 'MORNING';
          if (intervals.length > 0) {
            if (isMorning) {
              const am = intervals[0];
              deductionMinutes = am ? (am.end - am.start) : 230;
            } else {
              const pm = intervals.length > 1 ? intervals[1] : intervals[0];
              deductionMinutes = pm ? (pm.end - pm.start) : 235;
            }
          } else {
            deductionMinutes = isMorning ? 230 : 235;
          }
        } else {
          deductionMinutes = scheduledMinutes;
        }
        const actualMinutes = isTrip ? scheduledMinutes : Math.max(0, scheduledMinutes - deductionMinutes);


        return {
          layer: 6,
          layerName: 'DAILY_EVENT',
          dutyStatus: isTrip ? 'WORK_REQUIRED' : (isHalfDay ? 'WORK_REQUIRED' : 'NO_WORK_REQUIRED'),
          statusCode: app.type_id,
          symbol,
          displayName,
          aggregationCategory: agg,
          isWorkDay: isTrip || isHalfDay,
          scheduledMinutes,
          actualMinutes,
          deductionMinutes,
          details: {
            applicationId: app.id,
            title: data.purpose || data.reason || app.type_name,
            destination: data.destination,
            unitType: data.unitType || 'DAY',
            halfDayType: data.halfDayType,
            reasonCode: data.reasonCode,
            stampSubText
          }
        };
      }
    } catch {}
  }
  return null;
}

/**
 * Layer 7: Hourly Event Resolver (時間年休・育児部分休業・時間欠勤・時間介護休暇・時間特例法22条研修)
 */
export function resolveHourlyEventLayer(
  ctx: AttendanceResolutionContext,
  workSchedule: any
): AttendanceLayerResult[] {
  const db = getDb();
  const results: AttendanceLayerResult[] = [];

  // 1. 時間単位服務申請 (時間年休・部分休業・時間介護・時間研修等)
  const apps = db.prepare(`
    SELECT a.id, a.type_id, a.form_data, t.name as type_name
    FROM applications a
    JOIN application_types t ON a.type_id = t.id
    WHERE a.subject_user_id = ?
      AND a.current_status = 'FINAL_APPROVED'
  `).all(ctx.userId) as any[];

  for (const app of apps) {
    try {
      const data = JSON.parse(app.form_data);
      const isTarget = (data.targetDate === ctx.date) || (data.startDate === ctx.date && data.endDate === ctx.date);
      const isHourly = data.unitType === 'TIME' || (!data.unitType && data.startTime && data.endTime);

      if (isTarget && isHourly && data.startTime && data.endTime) {
        const intersection = calculateWorkIntersectionMinutes(data.startTime, data.endTime, workSchedule);
        if (intersection > 0) {
          if (app.type_id === 'TRAINING_SPECIAL_ACT_22_2' || app.type_id === 'TRAINING_SPECIAL_ACT_22_3') {
            const policyCode = app.type_id === 'TRAINING_SPECIAL_ACT_22_2' ? 'SPECIAL_ACT_22_2' : 'SPECIAL_ACT_22_3';
            const pol = resolveAttendancePolicy(policyCode, ctx.authorityId || 'DEFAULT_MUNICIPALITY', 'TIME', data);

            if (pol.isFailClosed) {
              results.push({
                layer: 7,
                layerName: 'FAIL_CLOSED_POLICY',
                dutyStatus: 'EXEMPT',
                statusCode: 'UNKNOWN_PATTERN',
                symbol: '不明',
                displayName: 'ポリシー未設定のため判定停止',
                aggregationCategory: 'UNKNOWN',
                isWorkDay: true,
                scheduledMinutes: workSchedule.workMinutes,
                actualMinutes: 0,
                deductionMinutes: 0,
                details: { failReason: pol.failReason }
              });
              continue;
            }

            const deductionMinutes = pol.deductionRule === 'NONE' ? 0 : intersection;

            results.push({
              layer: 7,
              layerName: 'HOURLY_APPLICATION',
              dutyStatus: 'EXEMPT',
              statusCode: app.type_id,
              symbol: pol.displaySymbol || '研修',
              displayName: pol.displayName || app.type_name,
              aggregationCategory: pol.aggregationCategory || 'HOURLY_TRAINING',
              isWorkDay: true,
              scheduledMinutes: workSchedule.workMinutes,
              actualMinutes: 0,
              deductionMinutes,
              details: {
                applicationId: app.id,
                startTime: data.startTime,
                endTime: data.endTime,
                durationMinutes: intersection,
                legalBasis: pol.legalBasis,
                hourlyDisplayRule: pol.hourlyDisplayRule,
                sourceType: 'APPLICATION'
              }
            });
            continue;
          }

          let symbol = '時年';
          let agg = 'HOURLY_ANNUAL_LEAVE';
          let displayName = app.type_name;

          if (app.type_id === 'LEAVE_SPECIAL') {
            const reasonCode = data.reasonCode || 'SPECIAL_BEREAVEMENT';
            const pol = resolveAttendancePolicy(reasonCode, ctx.authorityId || 'DEFAULT_MUNICIPALITY', 'TIME', data);
            if (pol.isFailClosed) {
              results.push({
                layer: 7,
                layerName: 'FAIL_CLOSED_POLICY',
                dutyStatus: 'EXEMPT',
                statusCode: 'UNKNOWN_PATTERN',
                symbol: '不明',
                displayName: 'ポリシー未設定のため判定停止',
                aggregationCategory: 'UNKNOWN',
                isWorkDay: true,
                scheduledMinutes: workSchedule.workMinutes,
                actualMinutes: 0,
                deductionMinutes: 0,
                details: { failReason: pol.failReason }
              });
              continue;
            }
            symbol = pol.displaySymbol || '特';
            agg = pol.aggregationCategory || 'SPECIAL_LEAVE';
            displayName = pol.displayName || app.type_name;
          } else if (app.type_id === 'LEAVE_CHILDCARE_PARTIAL') {
            symbol = '部';
            agg = 'PARTIAL_CHILDCARE';
          } else if (app.type_id === 'LEAVE_CARE') {
            symbol = '介護';
            agg = 'HOURLY_CARE_LEAVE';
          } else if (app.type_id === 'LEAVE_CARE_TIME') {
            symbol = '介時';
            agg = 'HOURLY_CARE_TIME';
          }

          results.push({
            layer: 7,
            layerName: 'HOURLY_APPLICATION',
            dutyStatus: 'EXEMPT',
            statusCode: app.type_id,
            symbol,
            displayName: app.type_name,
            aggregationCategory: agg,
            isWorkDay: true,
            scheduledMinutes: workSchedule.workMinutes,
            actualMinutes: 0,
            deductionMinutes: intersection,
            details: {
              applicationId: app.id,
              startTime: data.startTime,
              endTime: data.endTime,
              durationMinutes: intersection,
              sourceType: 'APPLICATION'
            }
          });
        }
      }
    } catch {}
  }

  // 2. 時間欠勤 (CONFIRMED)
  const hourlyAbsences = db.prepare(`
    SELECT * FROM absences
    WHERE user_id = ? AND target_date = ? AND absence_type = 'HOURLY' AND status = 'CONFIRMED'
    ORDER BY id ASC
  `).all(ctx.userId, ctx.date) as any[];

  for (const abs of hourlyAbsences) {
    const intersection = calculateWorkIntersectionMinutes(abs.start_time, abs.end_time, workSchedule);
    if (intersection > 0) {
      results.push({
        layer: 7,
        layerName: 'HOURLY_ABSENCE',
        dutyStatus: 'EXEMPT',
        statusCode: 'ABSENCE_HOURLY',
        symbol: '欠',
        displayName: '時間欠勤',
        aggregationCategory: 'HOURLY_ABSENCE',
        isWorkDay: true,
        scheduledMinutes: workSchedule.workMinutes,
        actualMinutes: 0,
        deductionMinutes: intersection,
        details: {
          absenceId: abs.id,
          startTime: abs.start_time,
          endTime: abs.end_time,
          durationMinutes: intersection,
          reason: ctx.includeRestricted ? abs.reason : undefined,
          sourceType: 'ABSENCE'
        }
      });
    }
  }

  return results;
}
