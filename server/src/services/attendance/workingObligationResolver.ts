import { getDb } from '../../db/database';
import {
  resolveAuthoritativeWorkSchedule,
  ResolvedWorkSchedule,
  WorkTimeInterval,
  validateWorkIntervals,
  deriveBreakIntervals,
  timeToMinutes,
  minutesToTime,
} from './workPatternResolver';
import { getSystemJapaneseHolidayName, getSystemYearEndNewYearHolidayName } from '../../utils/attendanceEngine';

export type WorkingObligationStatus = 'WORKING' | 'NON_WORKING' | 'UNRESOLVED';

export interface WorkingObligationResult {
  status: WorkingObligationStatus;
  isWorkDay: boolean;
  isFailClosed: boolean;
  failReason?: string;
  userId: number;
  targetDate: string;
  sourceType: 'CALENDAR_ADJUSTMENT' | 'CUSTOM_HOLIDAY' | 'NATIONAL_HOLIDAY' | 'WORKING_PATTERN' | 'UNKNOWN';
  sourceDetails?: string;
  workSchedule?: ResolvedWorkSchedule;
}

/**
 * WorkingObligationResolver (SSOT)
 * 
 * 職員 (userId) × 対象日 (targetDate) から、その日に勤務義務が存在するかを決定論的に解決する。
 * 
 * 解決優先順序:
 * 1. calendar_adjustments (個別または全校の代休・週休振替・勤務日設定)
 * 2. custom_holidays (学校指定休日・自治体休日・祝日オーバーライド)
 * 3. 国民の祝日・年末年始 (法令祝日)
 * 4. 個人別 Working Pattern (user_work_patterns: weekly_off_days, schedule_details_json)
 * 
 * 厳格なルール:
 * - 曜日（土日）のみによるハードコード判定は完全禁止。
 * - 勤務パターン未登録・重複・JSON破損時は 'UNRESOLVED' (isFailClosed = true) を返却。
 */
export class WorkingObligationResolver {
  static resolve(userId: number, targetDate: string): WorkingObligationResult {
    const db = getDb();

    if (!targetDate || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
      return {
        status: 'UNRESOLVED',
        isWorkDay: false,
        isFailClosed: true,
        failReason: `不正な対象日付形式です: ${targetDate}`,
        userId,
        targetDate,
        sourceType: 'UNKNOWN'
      };
    }

    // 1. calendar_adjustments テーブルの照合 (振替・代休・単日勤務日指定)
    const adjustments = db.prepare(`
      SELECT * FROM calendar_adjustments
      WHERE status = 'ACTIVE'
        AND ((scope_type = 'ALL') OR (scope_type = 'USER' AND user_id = ?))
        AND (source_date = ? OR target_date = ?)
      ORDER BY scope_type DESC, id DESC
    `).all(userId, targetDate, targetDate) as any[];

    if (adjustments && adjustments.length > 0) {
      // ユーザー固有設定を全体設定より優先
      const adj = adjustments[0];
      const isSource = adj.source_date === targetDate;
      const dutyStatus = isSource ? adj.source_duty_status : adj.target_duty_status;

      if (dutyStatus === 'NO_WORK_REQUIRED') {
        return {
          status: 'NON_WORKING',
          isWorkDay: false,
          isFailClosed: false,
          userId,
          targetDate,
          sourceType: 'CALENDAR_ADJUSTMENT',
          sourceDetails: `${adj.adjustment_type}: ${adj.event_name} (${adj.reason})`
        };
      } else if (dutyStatus === 'WORK_REQUIRED') {
        // 1. 日付個別オーバーライド (Pilot P0: schedule_override_json) の検証
        if (adj.schedule_override_json) {
          try {
            const parsedOverride = JSON.parse(adj.schedule_override_json);
            let intervals: WorkTimeInterval[] = [];
            if (parsedOverride.workIntervals && Array.isArray(parsedOverride.workIntervals)) {
              intervals = parsedOverride.workIntervals.map((inv: any) => ({ start: Number(inv.start), end: Number(inv.end) }));
            } else if (parsedOverride.intervals && Array.isArray(parsedOverride.intervals)) {
              intervals = parsedOverride.intervals.map((inv: any) => ({
                start: timeToMinutes(inv.startTime),
                end: timeToMinutes(inv.endTime),
              }));
            }

            const valRes = validateWorkIntervals(intervals);
            if (!valRes.isValid) {
              return {
                status: 'UNRESOLVED',
                isWorkDay: false,
                isFailClosed: true,
                failReason: `日付個別オーバーライドの日課区間が不正です: ${valRes.error}`,
                userId,
                targetDate,
                sourceType: 'CALENDAR_ADJUSTMENT',
              };
            }

            const scheduledMins = intervals.reduce((sum, inv) => sum + (inv.end - inv.start), 0);
            const startTimeStr = intervals.length > 0 ? minutesToTime(intervals[0].start) : null;
            const endTimeStr = intervals.length > 0 ? minutesToTime(intervals[intervals.length - 1].end) : null;
            const { breakIntervals, breakMinutes } = deriveBreakIntervals(intervals);

            const overrideSchedule: ResolvedWorkSchedule = {
              status: 'RESOLVED',
              isFailClosed: false,
              userId,
              date: targetDate,
              isWorkDay: true,
              dutyStatus: 'WORK_REQUIRED',
              scheduledWorkMinutes: scheduledMins,
              schedule: {
                isWorkDay: true,
                workMinutes: scheduledMins,
                startTime: startTimeStr,
                endTime: endTimeStr,
                workIntervals: intervals,
                intervals: intervals.map(inv => ({ startTime: minutesToTime(inv.start), endTime: minutesToTime(inv.end) }))
              },
              effectiveIntervals: intervals,
              breakIntervals,
              breakMinutes,
              overrideSource: 'CALENDAR_ADJUSTMENT',
            };

            return {
              status: 'WORKING',
              isWorkDay: true,
              isFailClosed: false,
              userId,
              targetDate,
              sourceType: 'CALENDAR_ADJUSTMENT',
              sourceDetails: `日付個別指定勤務日: ${adj.event_name}`,
              workSchedule: overrideSchedule
            };
          } catch (e: any) {
            return {
              status: 'UNRESOLVED',
              isWorkDay: false,
              isFailClosed: true,
              failReason: `日付個別オーバーライドのJSONパースに失敗しました: ${e.message}`,
              userId,
              targetDate,
              sourceType: 'CALENDAR_ADJUSTMENT',
            };
          }
        }

        // 2. schedule_override_json が存在しない場合
        // 通常の Working Pattern を照合
        const baseSchedule = resolveAuthoritativeWorkSchedule(userId, targetDate);
        if (baseSchedule.isFailClosed) {
          return {
            status: 'UNRESOLVED',
            isWorkDay: false,
            isFailClosed: true,
            failReason: `勤務日指定ですが勤務パターンを解決できません: ${baseSchedule.failReason}`,
            userId,
            targetDate,
            sourceType: 'CALENDAR_ADJUSTMENT',
            workSchedule: baseSchedule
          };
        }

        // FROZEN-09 / INV-DWS-WORK-REQUIRED:
        // 通常パターンにおいて非勤務日（週休等）である場合、平日日課の自動コピーを禁止し FAIL-CLOSED とする
        if (!baseSchedule.isWorkDay || (baseSchedule.scheduledWorkMinutes ?? 0) <= 0) {
          return {
            status: 'UNRESOLVED',
            isWorkDay: false,
            isFailClosed: true,
            failReason: `非勤務日に対するWORK_REQUIRED指定ですが、個別日課（schedule_override_json）が未定義です (INV-DWS-WORK-REQUIRED Fail-Closed)`,
            userId,
            targetDate,
            sourceType: 'CALENDAR_ADJUSTMENT',
            workSchedule: baseSchedule
          };
        }

        return {
          status: 'WORKING',
          isWorkDay: true,
          isFailClosed: false,
          userId,
          targetDate,
          sourceType: 'CALENDAR_ADJUSTMENT',
          sourceDetails: `振替等による勤務日指定: ${adj.event_name}`,
          workSchedule: baseSchedule
        };
      }
    }

    // 2. custom_holidays テーブルの照合 (学校指定休日・自治体独自休日等)
    const customHoliday = db.prepare(`
      SELECT * FROM custom_holidays
      WHERE holiday_date = ? AND is_active = 1
      LIMIT 1
    `).get(targetDate) as any;

    if (customHoliday) {
      return {
        status: 'NON_WORKING',
        isWorkDay: false,
        isFailClosed: false,
        userId,
        targetDate,
        sourceType: 'CUSTOM_HOLIDAY',
        sourceDetails: `${customHoliday.holiday_type}: ${customHoliday.name}`
      };
    }

    // 3. 国民の祝日・年末年始の照合
    const natHoliday = getSystemJapaneseHolidayName(targetDate);
    if (natHoliday) {
      return {
        status: 'NON_WORKING',
        isWorkDay: false,
        isFailClosed: false,
        userId,
        targetDate,
        sourceType: 'NATIONAL_HOLIDAY',
        sourceDetails: `国民の祝日: ${natHoliday}`
      };
    }

    const yearEndHoliday = getSystemYearEndNewYearHolidayName(targetDate);
    if (yearEndHoliday) {
      return {
        status: 'NON_WORKING',
        isWorkDay: false,
        isFailClosed: false,
        userId,
        targetDate,
        sourceType: 'NATIONAL_HOLIDAY',
        sourceDetails: `年末年始休暇: ${yearEndHoliday}`
      };
    }

    // 4. 個人別 Working Pattern の解決 (Authoritative Working Pattern Resolver)
    const workSchedule = resolveAuthoritativeWorkSchedule(userId, targetDate);
    if (workSchedule.isFailClosed) {
      return {
        status: 'UNRESOLVED',
        isWorkDay: false,
        isFailClosed: true,
        failReason: workSchedule.failReason || '勤務パターン解決エラー',
        userId,
        targetDate,
        sourceType: 'WORKING_PATTERN',
        workSchedule
      };
    }

    if (!workSchedule.isWorkDay || workSchedule.dutyStatus === 'NO_WORK_REQUIRED' || (workSchedule.scheduledWorkMinutes ?? 0) <= 0) {
      return {
        status: 'NON_WORKING',
        isWorkDay: false,
        isFailClosed: false,
        userId,
        targetDate,
        sourceType: 'WORKING_PATTERN',
        sourceDetails: `定例週休日または所定勤務0分 (${workSchedule.patternName || '未割当'})`,
        workSchedule
      };
    }

    return {
      status: 'WORKING',
      isWorkDay: true,
      isFailClosed: false,
      userId,
      targetDate,
      sourceType: 'WORKING_PATTERN',
      sourceDetails: `通常勤務日 (${workSchedule.patternName}, 所定 ${workSchedule.scheduledWorkMinutes}分)`,
      workSchedule
    };
  }
}
