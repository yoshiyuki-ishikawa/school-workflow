import { getDb } from '../../db/database';
import {
  AttendanceResolutionContext,
  CanonicalDailyAttendance,
  CanonicalMonthlyAttendance
} from './types';
import {
  resolveCalendarLayer,
  resolveWorkPatternLayer,
  resolveCalendarAdjustmentLayer,
  resolvePersonnelStatusLayer,
  resolveAbsenceLayer,
  resolveDailyEventLayer,
  resolveHourlyEventLayer
} from './resolvers';
import { minutesToLeaveUnits, getWorkDayMinutes } from '../../utils/leaveCalculator';
import { config } from '../../config';
import { ProductionShadowRunner } from '../canonical/shadow';

const DAY_OF_WEEK_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

export class AttendanceEngine {
  /**
   * 1日の出勤状態を Layer 1〜8 で完全決定論的合成
   */
  static resolveDay(ctx: AttendanceResolutionContext): CanonicalDailyAttendance {
    const explanations: Array<{ layer: number; ruleApplied: string; timeRange?: string }> = [];
    const dt = new Date(ctx.date);
    const day = dt.getDate();
    const dayOfWeek = DAY_OF_WEEK_NAMES[dt.getDay()];

    // 1. Layer 1: Calendar Layer (祝日・学校行事・独自休日・年末年始)
    const cal = resolveCalendarLayer(ctx);

    // 2. Layer 2: Work Pattern Layer (通常・育短・平日週休・所定時間)
    const wp = resolveWorkPatternLayer(ctx);

    // Fail-Closed: 勤務パターンが未設定の場合は安全停止
    if (wp.hasUnknownPattern) {
      return {
        day,
        date: ctx.date,
        dayOfWeek,
        isWorkDay: false,
        dutyRequirement: 'NO_WORK_REQUIRED',
        scheduledWorkMinutes: 0,
        actualWorkMinutes: 0,
        deductionMinutes: 0,
        displaySymbol: '不明',
        displayName: '勤務パターン未設定',
        stampColor: 'slate',
        stampText: '不明',
        primaryDayClassification: 'UNKNOWN_PATTERN',
        serviceStatus: 'UNKNOWN',
        aggregationCategory: 'UNKNOWN',
        isPersonnelStatusOverridden: false,
        explanations: [{ layer: 0, ruleApplied: 'FAIL_CLOSED: 勤務パターン欠落のため計算停止' }]
      };
    }

    explanations.push({
      layer: 2,
      ruleApplied: `勤務形態: ${wp.patternName} (${wp.dutyStatus}, 所定${wp.workMinutes}分)`,
      timeRange: wp.schedule ? `${wp.schedule.startTime || ''}-${wp.schedule.endTime || ''}` : undefined
    });

    // 3. Layer 3: Calendar Adjustment Layer (週休振替・代休・単日勤務日化・指定休日)
    const adj = resolveCalendarAdjustmentLayer(ctx);
    let isWorkRequired = wp.isWorkDay && !cal.isHoliday;
    let scheduledWorkMinutes = wp.workMinutes;

    if (adj) {
      isWorkRequired = adj.dutyStatus === 'WORK_REQUIRED';
      explanations.push({
        layer: 3,
        ruleApplied: `服務調整: ${adj.eventName} (${adj.adjustmentType} -> ${adj.dutyStatus})`
      });
      if (isWorkRequired && scheduledWorkMinutes === 0) {
        scheduledWorkMinutes = wp.patternType === 'SHORT_TIME' ? 240 : 465;
      } else if (!isWorkRequired) {
        scheduledWorkMinutes = 0;
      }
    }

    const calendarAttributes = {
      isNationalHoliday: cal.isNationalHoliday,
      holidayName: cal.holidayName,
      isSchoolHoliday: cal.isSchoolHoliday,
      isMunicipalityHoliday: cal.isMunicipalityHoliday,
      isWeekend: dt.getDay() === 0 || dt.getDay() === 6,
    };

    const workScheduleAttributes = {
      patternId: wp.patternId,
      patternName: wp.patternName,
      isScheduledWorkDay: wp.isWorkDay,
      isWeeklyOff: !wp.isWorkDay,
      scheduledWorkMinutes: wp.workMinutes,
    };

    // 4. Layer 4: Personnel Status Layer (育休・分限休職・専従休職・停職 ※最優先オーバーライド)
    const ps = resolvePersonnelStatusLayer(ctx);
    if (ps) {
      explanations.push({
        layer: 4,
        ruleApplied: `人事身分状態オーバーライド: ${ps.displayName} (${ps.statusCode})`
      });

      return {
        day,
        date: ctx.date,
        dayOfWeek,
        isWorkDay: false,
        isWorkRequired: false,
        dutyRequirement: 'NO_WORK_REQUIRED',
        scheduledWorkMinutes: 0,
        actualWorkMinutes: 0,
        deductionMinutes: 0,
        displaySymbol: ps.symbol,
        displayName: ps.displayName,
        stampColor: 'slate',
        stampText: ps.symbol,
        stampSubText: ps.displayName,
        primaryDayClassification: 'OTHER_NON_WORKDAY',
        serviceStatus: ps.statusCode,
        aggregationCategory: ps.aggregationCategory,
        isPersonnelStatusOverridden: true,
        personnelStatusCode: ps.statusCode,
        isHoliday: cal.isHoliday,
        holidayName: cal.holidayName,
        calendarAttributes,
        workScheduleAttributes,
        explanations
      };
    }

    // 5. Layer 5: Absence Layer (全日欠勤 ※CONFIRMED状態)
    if (isWorkRequired) {
      const absenceFull = resolveAbsenceLayer(ctx, scheduledWorkMinutes);
      if (absenceFull) {
        explanations.push({
          layer: 5,
          ruleApplied: `全日欠勤: 理由=${absenceFull.details?.reason || '機密'}`
        });

        return {
          day,
          date: ctx.date,
          dayOfWeek,
          isWorkDay: false,
          isWorkRequired: true,
          dutyRequirement: 'WORK_REQUIRED',
          scheduledWorkMinutes,
          actualWorkMinutes: 0,
          deductionMinutes: scheduledWorkMinutes,
          displaySymbol: '欠',
          displayName: '全日欠勤',
          stampColor: 'rose',
          stampText: '欠',
          stampSubText: '全日欠勤',
          primaryDayClassification: 'WORKDAY',
          serviceStatus: 'ABSENCE_FULL_DAY',
          aggregationCategory: 'ABSENCE',
          isPersonnelStatusOverridden: false,
          calendarAttributes,
          workScheduleAttributes,
          absenceInfo: {
            absenceId: absenceFull.details?.absenceId,
            absenceType: 'FULL_DAY',
            status: absenceFull.details?.status,
            durationMinutes: scheduledWorkMinutes,
            reason: absenceFull.details?.reason // includeRestricted 時のみ保持
          },
          isWorkday: true,
          explanations
        };
      }
    }

    // 6. Layer 6: Daily Event Layer (公務旅行・終日年休・病休・特休・職免)
    const de = isWorkRequired ? resolveDailyEventLayer(ctx, scheduledWorkMinutes) : null;
    if (de) {
      explanations.push({
        layer: 6,
        ruleApplied: `終日服務イベント: ${de.displayName} (${de.symbol})`
      });

      let stampColor = 'blue';
      if (de.statusCode === 'LEAVE_SICK') stampColor = 'rose';
      else if (de.statusCode === 'LEAVE_SPECIAL') stampColor = 'amber';
      else if (de.statusCode === 'LEAVE_DUTY_EXEMPT') stampColor = 'emerald';
      else if (de.statusCode === 'BUSINESS_TRIP') stampColor = 'indigo';
      else if (de.statusCode === 'LEAVE_CARE') stampColor = 'purple';
      else if (de.statusCode === 'TRAINING_SPECIAL_ACT_22_2' || de.statusCode === 'TRAINING_SPECIAL_ACT_22_3') stampColor = 'teal';
      else if (de.statusCode === 'UNKNOWN_PATTERN') stampColor = 'slate';

      let stampText = de.symbol;
      if (de.statusCode === 'LEAVE_ANNUAL') stampText = '年休';
      else if (de.statusCode === 'BUSINESS_TRIP') stampText = '出張';
      else if (de.statusCode === 'LEAVE_SICK') stampText = '病休';
      else if (de.statusCode === 'LEAVE_SPECIAL') stampText = de.symbol === '産休' ? '産休' : '特休';
      else if (de.statusCode === 'LEAVE_DUTY_EXEMPT') stampText = '職免';
      else if (de.statusCode === 'LEAVE_CARE') stampText = '介護';
      else if (de.statusCode === 'TRAINING_SPECIAL_ACT_22_2' || de.statusCode === 'TRAINING_SPECIAL_ACT_22_3') stampText = de.symbol || '研修';

      let stampSubText = de.details?.destination ? `(${de.details.destination})` : undefined;
      if (de.details?.stampSubText) {
        stampSubText = de.details.stampSubText;
      } else if (de.statusCode === 'LEAVE_CARE' && de.details?.unitType === 'HALF_DAY') {
        stampSubText = '半日';
      }

      const isUnknown = de.statusCode === 'UNKNOWN_PATTERN';

      return {
        day,
        date: ctx.date,
        dayOfWeek,
        isWorkDay: isUnknown ? false : de.isWorkDay,
        isWorkRequired: isUnknown ? false : true,
        dutyRequirement: isUnknown ? 'NO_WORK_REQUIRED' : 'WORK_REQUIRED',
        scheduledWorkMinutes,
        actualWorkMinutes: de.actualMinutes,
        deductionMinutes: de.deductionMinutes || 0,
        displaySymbol: de.symbol,
        displayName: de.displayName,
        stampColor,
        stampText,
        stampSubText,
        primaryDayClassification: isUnknown ? 'UNKNOWN_PATTERN' : 'WORKDAY',
        serviceStatus: de.statusCode,
        aggregationCategory: de.aggregationCategory,
        isPersonnelStatusOverridden: false,
        dailyEventCode: de.statusCode,
        applicationId: de.details?.applicationId,
        applicationTitle: de.details?.title,
        isWorkday: isUnknown ? false : true,
        applicationInfo: {
          id: de.details?.applicationId,
          typeId: de.statusCode,
          typeName: de.displayName,
          title: de.details?.title,
          unitType: de.details?.unitType || 'DAY',
          calculatedMinutes: de.deductionMinutes || scheduledWorkMinutes,
        },
        explanations
      };
    }

    // 7. Layer 7: Hourly Event Layer (時間年休・育児部分休業・時間欠勤)
    if (isWorkRequired) {
      const hourlyEvents = resolveHourlyEventLayer(ctx, { ...wp, isWorkDay: isWorkRequired, workMinutes: scheduledWorkMinutes });
      if (hourlyEvents.length > 0) {
        let totalDeductionMinutes = 0;
        const symbols: string[] = [];
        let hourlyAbsenceInfo: any = undefined;

        for (const he of hourlyEvents) {
          explanations.push({
            layer: 7,
            ruleApplied: `時間単位イベント: ${he.displayName} (${he.details?.startTime}-${he.details?.endTime}, 控除${he.deductionMinutes}分)`
          });
          totalDeductionMinutes += (he.deductionMinutes || 0);
          symbols.push(he.symbol);

          if (he.details?.sourceType === 'ABSENCE') {
            hourlyAbsenceInfo = {
              absenceId: he.details.absenceId,
              absenceType: 'HOURLY',
              status: 'CONFIRMED',
              durationMinutes: he.deductionMinutes || 0,
              reason: he.details.reason
            };
          }
        }

        const hasUnknown = hourlyEvents.some(h => h.statusCode === 'UNKNOWN_PATTERN');
        const actual = Math.max(0, scheduledWorkMinutes - totalDeductionMinutes);
        const symbolStr = Array.from(new Set(symbols)).join('・');
        const primaryHourly = hourlyEvents[0];
        let stampText = symbolStr;
        if (primaryHourly.statusCode === 'LEAVE_ANNUAL') stampText = '年休';
        else if (primaryHourly.statusCode === 'LEAVE_CARE') stampText = '介護';
        else if (primaryHourly.statusCode === 'LEAVE_CARE_TIME') stampText = '介時';
        else if (primaryHourly.statusCode === 'TRAINING_SPECIAL_ACT_22_2' || primaryHourly.statusCode === 'TRAINING_SPECIAL_ACT_22_3') stampText = '研修';

        return {
          day,
          date: ctx.date,
          dayOfWeek,
          isWorkDay: hasUnknown ? false : true,
          isWorkRequired: hasUnknown ? false : true,
          dutyRequirement: hasUnknown ? 'NO_WORK_REQUIRED' : 'WORK_REQUIRED',
          scheduledWorkMinutes,
          actualWorkMinutes: hasUnknown ? 0 : actual,
          deductionMinutes: totalDeductionMinutes,
          displaySymbol: symbolStr,
          displayName: hasUnknown ? 'ポリシー未設定のため判定停止' : (wp.patternType === 'SHORT_TIME' ? '育短勤務' : '通常勤務'),
          stampColor: hasUnknown ? 'slate' : (symbols.includes('欠') ? 'rose' : (symbols.includes('介護') || symbols.includes('介時')) ? 'purple' : symbols.includes('部') ? 'amber' : symbols.includes('研修') ? 'teal' : 'blue'),
          stampText,
          stampSubText: `${Math.floor(totalDeductionMinutes / 60)}h${totalDeductionMinutes % 60 > 0 ? (totalDeductionMinutes % 60) + 'm' : ''}`,
          primaryDayClassification: hasUnknown ? 'UNKNOWN_PATTERN' : 'WORKDAY',
          serviceStatus: hasUnknown ? 'UNKNOWN_PATTERN' : 'WORKED_WITH_PARTIAL_LEAVE',
          aggregationCategory: hasUnknown ? 'UNKNOWN' : 'WORKED_WITH_PARTIAL_LEAVE',
          isPersonnelStatusOverridden: false,
          absenceInfo: hourlyAbsenceInfo,
          applicationInfo: primaryHourly.details?.applicationId ? {
            id: primaryHourly.details.applicationId,
            typeId: primaryHourly.statusCode,
            typeName: primaryHourly.displayName,
            title: primaryHourly.displayName,
            unitType: 'TIME',
            calculatedMinutes: totalDeductionMinutes,
          } : undefined,
          hourlyEvents: hourlyEvents.map(h => ({
            typeId: h.statusCode,
            startTime: h.details?.startTime,
            endTime: h.details?.endTime,
            durationMinutes: h.details?.durationMinutes ?? h.deductionMinutes ?? 0,
            sourceId: h.details?.applicationId || h.details?.absenceId,
            sourceType: h.details?.sourceType || 'APPLICATION'
          })),
          isWorkday: true,
          explanations
        };
      }
    }

    // 8. Layer 8: Default Presentation (通常勤務 / 週休日 / 休日 / 代休)
    let symbol = '出';
    let name = wp.patternType === 'SHORT_TIME' ? '育短勤務' : '通常勤務';
    let classification: CanonicalDailyAttendance['primaryDayClassification'] = 'WORKDAY';
    let serviceStatus = 'NORMAL_WORK';
    let stampColor = 'teal';
    let stampText: string | undefined = undefined;
    let stampSubText: string | undefined = undefined;

    if (adj) {
      if (adj.adjustmentType === 'SUBSTITUTE_HOLIDAY') {
        if (!isWorkRequired) {
          symbol = '代休';
          name = '休日の代休日';
          classification = 'SUBSTITUTE_HOLIDAY';
          serviceStatus = 'SUBSTITUTE_HOLIDAY';
          stampColor = 'purple';
          stampText = '代休';
          stampSubText = adj.eventName ? `${adj.eventName}代休` : undefined;
        } else {
          symbol = '勤務日';
          name = '振替勤務日';
          stampText = '勤務日';
          stampSubText = adj.eventName;
          classification = 'WORKDAY';
        }
      } else if (adj.adjustmentType === 'WEEK_OFF_TRANSFER') {
        if (!isWorkRequired) {
          symbol = '週休';
          name = '週休振替日';
          classification = 'WEEKLY_OFF';
          serviceStatus = 'TRANSFER_WEEK_OFF';
          stampColor = 'slate';
          stampText = '週休';
          stampSubText = adj.eventName ? `${adj.eventName}` : undefined;
        } else {
          symbol = '勤務日';
          name = '振替勤務日';
          stampText = '勤務日';
          stampSubText = adj.eventName;
          classification = 'WORKDAY';
        }
      } else if (adj.adjustmentType === 'SINGLE_WORKDAY_OVERRIDE') {
        symbol = '勤務日';
        name = '振替勤務日';
        stampText = '勤務日';
        stampSubText = adj.eventName;
        classification = 'WORKDAY';
      } else if (adj.adjustmentType === 'DESIGNATED_NON_WORKDAY') {
        symbol = '週休';
        name = '指定休日';
        classification = 'WEEKLY_OFF';
        stampText = '週休';
        stampSubText = adj.eventName;
      }
    } else {
      if (!isWorkRequired) {
        if (!wp.isWorkDay) {
          // 定例週休日は祝日と重なっても週休日を優先
          symbol = '休';
          name = '週休日';
          classification = 'WEEKLY_OFF';
          serviceStatus = 'WEEK_OFF';
          stampColor = 'slate';
          stampText = '週休';
          stampSubText = cal.holidayName || undefined;
        } else if (cal.isHoliday) {
          symbol = '祝';
          name = cal.holidayName || '祝日';
          classification = 'HOLIDAY';
          serviceStatus = 'HOLIDAY';
          stampColor = 'rose';
          stampText = '休日';
          stampSubText = cal.holidayName;
        } else {
          symbol = '休';
          name = '週休日';
          classification = 'WEEKLY_OFF';
          serviceStatus = 'WEEK_OFF';
          stampColor = 'slate';
          stampText = '週休';
        }
      }
    }

    return {
      day,
      date: ctx.date,
      dayOfWeek,
      isWorkDay: isWorkRequired,
      isWorkRequired,
      dutyRequirement: isWorkRequired ? 'WORK_REQUIRED' : 'NO_WORK_REQUIRED',
      scheduledWorkMinutes: isWorkRequired ? scheduledWorkMinutes : 0,
      actualWorkMinutes: isWorkRequired ? scheduledWorkMinutes : 0,
      deductionMinutes: 0,
      displaySymbol: symbol,
      displayName: name,
      stampColor: (stampText || symbol !== '出') ? stampColor : undefined,
      stampText: (!adj && isWorkRequired && !cal.isHoliday) ? undefined : stampText,
      stampSubText,
      primaryDayClassification: classification,
      serviceStatus,
      aggregationCategory: isWorkRequired ? 'WORKED' : (classification === 'WEEKLY_OFF' ? 'WEEKLY_OFF' : 'HOLIDAY'),
      isPersonnelStatusOverridden: false,
      isWeekend: dt.getDay() === 0 || dt.getDay() === 6,
      isWorkday: isWorkRequired,
      isWeekOff: classification === 'WEEKLY_OFF',
      isSubstituteHoliday: classification === 'SUBSTITUTE_HOLIDAY',
      isHoliday: cal.isHoliday,
      holidayName: cal.holidayName,
      calendarAttributes,
      workScheduleAttributes,
      adjustment: adj ? {
        id: adj.adjustment?.id,
        adjustmentCode: adj.adjustment?.adjustment_code,
        adjustmentType: adj.adjustment?.adjustment_type,
        reasonCode: adj.adjustment?.reason_code,
        eventName: adj.adjustment?.event_name,
        reason: adj.adjustment?.reason,
        sourceDate: adj.adjustment?.source_date,
        targetDate: adj.adjustment?.target_date,
        scopeType: adj.adjustment?.scope_type,
      } : undefined,
      explanations
    };
  }

  /**
   * 月間出勤簿データの多層合成取得 (日次リスト)
   */
  static resolveMonth(userId: number, yearMonth: string, includeRestricted = false): CanonicalDailyAttendance[] {
    const [y, m] = yearMonth.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const resolutions: CanonicalDailyAttendance[] = [];

    for (let day = 1; day <= daysInMonth; day++) {
      const date = `${yearMonth}-${String(day).padStart(2, '0')}`;
      resolutions.push(this.resolveDay({ userId, date, includeRestricted }));
    }

    return resolutions;
  }

  /**
   * Canonical Monthly Attendance DTO の単一・完全生成 (Single Source of Truth)
   */
  static getMonthlyAttendanceData(userId: number, yearMonth: string, includeRestricted = false): CanonicalMonthlyAttendance {
    const db = getDb();
    const user = db.prepare('SELECT id, display_name, department FROM users WHERE id = ?').get(userId) as any;
    if (!user) {
      throw new Error('ユーザーが存在しません');
    }

    const days = this.resolveMonth(userId, yearMonth, includeRestricted);
    const workDayMinutes = getWorkDayMinutes();

    // 1. 集計カウント初期化
    let scheduledWorkdayCount = 0;
    let actualWorkedDayCount = 0;
    let businessTripDayCount = 0;
    let businessTripCount = 0;
    let annualLeaveMinutes = 0;
    let sickLeaveDays = 0;
    let specialLeaveDays = 0;
    let dutyExemptDays = 0;
    let careLeaveFullDays = 0;
    let careLeaveHalfDays = 0;
    let careLeaveHourlyMinutes = 0;
    let careLeaveTotalMinutes = 0;
    let absenceFullDays = 0;
    let absenceHourlyMinutes = 0;
    let weekOffCount = 0;
    let holidayCount = 0;
    let substituteHolidayCount = 0;

    let exWorkdayCount = 0;
    let exWeeklyOffCount = 0;
    let exHolidayCount = 0;
    let exSubstituteHolidayCount = 0;
    let exOtherNonWorkdayCount = 0;
    let exUnknownPatternCount = 0;

    let totalScheduledMinutes = 0;
    let totalActualMinutes = 0;
    let totalDeductionMinutes = 0;

    let hasUnknownPattern = false;
    const unresolvedDays: Array<{ date: string; reason: string }> = [];
    const warnings: string[] = [];

    // 2. 日次結果の走査と集計
    for (const d of days) {
      totalScheduledMinutes += d.scheduledWorkMinutes;
      totalActualMinutes += d.actualWorkMinutes;
      totalDeductionMinutes += d.deductionMinutes;

      if (d.primaryDayClassification === 'UNKNOWN_PATTERN') {
        hasUnknownPattern = true;
        exUnknownPatternCount++;
        unresolvedDays.push({ date: d.date, reason: '勤務パターン未設定' });
      } else if (d.primaryDayClassification === 'WORKDAY') {
        exWorkdayCount++;
      } else if (d.primaryDayClassification === 'WEEKLY_OFF') {
        exWeeklyOffCount++;
      } else if (d.primaryDayClassification === 'HOLIDAY') {
        exHolidayCount++;
      } else if (d.primaryDayClassification === 'SUBSTITUTE_HOLIDAY') {
        exSubstituteHolidayCount++;
      } else {
        exOtherNonWorkdayCount++;
      }

      if (d.dutyRequirement === 'WORK_REQUIRED') {
        scheduledWorkdayCount++;

        if (d.serviceStatus === 'BUSINESS_TRIP') {
          businessTripDayCount++;
          businessTripCount++;
        } else if (d.serviceStatus === 'ABSENCE_FULL_DAY') {
          absenceFullDays++;
        } else if (d.serviceStatus === 'LEAVE_SICK') {
          sickLeaveDays++;
        } else if (d.serviceStatus === 'LEAVE_SPECIAL') {
          specialLeaveDays++;
        } else if (d.serviceStatus === 'LEAVE_DUTY_EXEMPT') {
          dutyExemptDays++;
        } else if (d.serviceStatus === 'LEAVE_CARE') {
          if (d.applicationInfo?.unitType === 'HALF_DAY') {
            careLeaveHalfDays++;
            careLeaveTotalMinutes += d.deductionMinutes;
          } else {
            careLeaveFullDays++;
            careLeaveTotalMinutes += (d.deductionMinutes || d.scheduledWorkMinutes);
          }
        } else if (d.serviceStatus === 'LEAVE_ANNUAL') {
          annualLeaveMinutes += (d.deductionMinutes || d.scheduledWorkMinutes);
        } else {
          // 通常実勤務または時間単位休暇付き勤務
          if (d.actualWorkMinutes > 0) {
            actualWorkedDayCount++;
          }
        }

        // 時間単位イベントの集計
        if (d.hourlyEvents) {
          for (const he of d.hourlyEvents) {
            if (he.typeId === 'LEAVE_ANNUAL') {
              annualLeaveMinutes += he.durationMinutes;
            } else if (he.typeId === 'LEAVE_CARE') {
              careLeaveHourlyMinutes += he.durationMinutes;
              careLeaveTotalMinutes += he.durationMinutes;
            } else if (he.typeId === 'ABSENCE_HOURLY' || he.sourceType === 'ABSENCE') {
              absenceHourlyMinutes += he.durationMinutes;
            }
          }
        }
      } else {
        if (d.primaryDayClassification === 'WEEKLY_OFF') {
          weekOffCount++;
        } else if (d.primaryDayClassification === 'SUBSTITUTE_HOLIDAY') {
          substituteHolidayCount++;
        } else if (d.primaryDayClassification === 'HOLIDAY') {
          holidayCount++;
        }
      }
    }

    if (hasUnknownPattern) {
      warnings.push(`当月に勤務パターン未設定日が ${exUnknownPatternCount} 日存在します。管理設定で勤務パターンを割り当ててください。`);
    }

    // 3. 出勤簿 公文書集計 DTO
    const totalAbsenceMinutes = (absenceFullDays * workDayMinutes) + absenceHourlyMinutes;
    const workdayCountForForm = actualWorkedDayCount + businessTripDayCount;
    const totalSubLeaveMinutes = (sickLeaveDays + specialLeaveDays + dutyExemptDays) * workDayMinutes + annualLeaveMinutes;
    const salaryDeductionTargetMinutes = totalAbsenceMinutes + careLeaveTotalMinutes;

    const summary = {
      workdayCount: workdayCountForForm,
      scheduledWorkdayCount,
      actualWorkedDayCount,
      weekOffCount: exWeeklyOffCount,
      holidayCount: exHolidayCount + exSubstituteHolidayCount,
      annualLeave: minutesToLeaveUnits(annualLeaveMinutes, workDayMinutes),
      sickLeave: minutesToLeaveUnits(sickLeaveDays * workDayMinutes, workDayMinutes),
      specialLeave: minutesToLeaveUnits(specialLeaveDays * workDayMinutes, workDayMinutes),
      dutyExempt: minutesToLeaveUnits(dutyExemptDays * workDayMinutes, workDayMinutes),
      careLeave: {
        fullDays: careLeaveFullDays,
        halfDays: careLeaveHalfDays,
        hours: Math.floor(careLeaveHourlyMinutes / 60),
        minutes: careLeaveHourlyMinutes % 60,
        totalMinutes: careLeaveTotalMinutes,
        formatted: `${careLeaveFullDays > 0 ? careLeaveFullDays + '日 ' : ''}${careLeaveHalfDays > 0 ? careLeaveHalfDays + '半日 ' : ''}${careLeaveHourlyMinutes > 0 ? Math.floor(careLeaveHourlyMinutes / 60) + '時間 ' : ''}`.trim() || '0日'
      },
      absence: {
        fullDays: absenceFullDays,
        totalMinutes: totalAbsenceMinutes,
        formatted: totalAbsenceMinutes > 0 ? minutesToLeaveUnits(totalAbsenceMinutes, workDayMinutes).formatted : '0日'
      },
      subTotalLeave: minutesToLeaveUnits(totalSubLeaveMinutes, workDayMinutes),
      businessTripCount,
      businessTripDays: businessTripDayCount
    };

    // 4. ドメイン集計 DTO
    const domainSummary = {
      scheduledWorkdayCount,
      actualWorkedDayCount,
      businessTripDayCount,
      annualLeaveMinutes,
      sickLeaveDays,
      specialLeaveDays,
      dutyExemptDays,
      careLeaveDays: careLeaveFullDays + (careLeaveHalfDays * 0.5),
      careLeaveMinutes: careLeaveTotalMinutes,
      salaryDeductionTargetMinutes,
      absenceDays: absenceFullDays,
      absenceMinutes: totalAbsenceMinutes,
      weekOffCount: exWeeklyOffCount,
      holidayCount: exHolidayCount,
      substituteHolidayCount: exSubstituteHolidayCount,
      totalScheduledMinutes,
      totalActualMinutes,
      totalDeductionMinutes,
      exclusiveCounts: {
        workdayCount: exWorkdayCount,
        weeklyOffCount: exWeeklyOffCount,
        holidayCount: exHolidayCount,
        substituteHolidayCount: exSubstituteHolidayCount,
        otherNonWorkdayCount: exOtherNonWorkdayCount,
        unknownPatternCount: exUnknownPatternCount,
        totalDays: days.length
      }
    };

    // 5. 校長月次確定状態の取得
    const approval = db.prepare(`
      SELECT a.*, u.display_name as confirmed_user_name, s.id as snapshot_id
      FROM monthly_attendance_approvals a
      LEFT JOIN users u ON a.confirmed_by_user_id = u.id
      LEFT JOIN monthly_attendance_snapshots s ON a.user_id = s.user_id AND a.year_month = s.year_month AND s.status = 'LOCKED'
      WHERE a.user_id = ? AND a.year_month = ?
    `).get(userId, yearMonth) as any;

    const legacyResult: CanonicalMonthlyAttendance = {
      userId: user.id,
      userName: user.display_name,
      userDepartment: user.department,
      yearMonth,
      canonicalVersion: '2026.1',
      days,
      summary,
      domainSummary,
      hasUnknownPattern,
      unresolvedDays,
      warnings,
      approval: {
        status: approval ? approval.status : 'OPEN',
        snapshotId: approval?.snapshot_id,
        confirmedByUserName: approval ? (approval.confirmed_user_display_name || approval.confirmed_user_name) : undefined,
        confirmedUserStampName: approval ? approval.confirmed_user_stamp_name : undefined,
        confirmedAt: approval ? approval.confirmed_at : undefined,
        comment: approval ? approval.comment : undefined,
        unlockedReason: approval ? approval.unlocked_reason : undefined,
        unlockedAt: approval ? approval.unlocked_at : undefined,
      }
    };

    // Phase D: Non-invasive Isolated Shadow Dual Run Hook
    // Invariants: Legacy Sole Authority / Zero Canonical Leakage / Strict Default-OFF
    if (config.CANONICAL_SHADOW_MODE) {
      ProductionShadowRunner.runMonthlyShadowSafe({
        userId,
        yearMonth,
        legacyResult,
        db
      });
    }

    // Return 100% Legacy Authoritative Result
    return legacyResult;
  }
}
