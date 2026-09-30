import { getDb } from '../db/database';
import { resolveAuthoritativeWorkSchedule, minutesToTime } from './attendance/workPatternResolver';

export interface ConflictCheckParams {
  userId: number;
  startDate: string;
  endDate: string;
  statusType?: string;
  applicationTypeId?: string;
  unitType?: 'DAY' | 'HALF_DAY' | 'TIME' | 'MULTI_DAY';
  startTime?: string;
  endTime?: string;
  halfDayType?: 'MORNING' | 'AFTERNOON';
  excludePersonnelStatusId?: number;
  excludeApplicationId?: number;
  forFinalApproval?: boolean; // 決裁時再検証フラグ (FINAL_APPROVED / TRIP_APPROVED のみと照合)
}

export interface ConflictValidationResult {
  hasConflict: boolean;
  conflictType?: 'STATUS_CONFLICT' | 'TIME_CONFLICT' | 'SERVICE_PERIOD_CONFLICT' | 'TRANSITION_CONFLICT';
  reason?: string;
  conflictingEntity?: any;
}

/**
 * 勤務時間認定される終日・複数日服務申請種別 (Work-Counted Daily Service Types)
 * 出張、特例法第22条研修等。時間単位申請との同日併存が業務上合目的（Wave 2 W2-B: COEXIST_AND_DEDUCT）。
 */
const WORK_COUNTED_DAILY_SERVICE_TYPES = new Set([
  'BUSINESS_TRIP',
  'TRAINING_SPECIAL_ACT_22_2',
  'TRAINING_SPECIAL_ACT_22_3',
]);

/**
 * 勤務を完全に免除・離脱する終日・複数日休暇申請種別 (Leave-Exclusive Daily Service Types)
 * 年休、病気休暇、特別休暇、職免、介護休暇等。終日休暇と時間単位申請の同日併存は業務上矛盾するため排他遮断。
 */
const LEAVE_EXCLUSIVE_DAILY_SERVICE_TYPES = new Set([
  'LEAVE_ANNUAL',
  'LEAVE_SICK',
  'LEAVE_SPECIAL',
  'LEAVE_DUTY_EXEMPT',
  'LEAVE_CARE',
]);

/**
 * 終日・複数日単位で互いに排他となる服務申請種別 (Exclusive Full/Multi-day Service Types)
 * Block A (DAY_EVENT × DAY_EVENT) で使用
 */
const EXCLUSIVE_DAILY_SERVICE_TYPES = new Set([
  ...WORK_COUNTED_DAILY_SERVICE_TYPES,
  ...LEAVE_EXCLUSIVE_DAILY_SERVICE_TYPES,
]);

function isPartialBusinessTrip(typeId: string | undefined, startTime: string | undefined, endTime: string | undefined, date: string | undefined, userId: number | undefined): boolean {
  if (typeId !== 'BUSINESS_TRIP') return false;
  if (!startTime || !endTime || !date || !userId) return false;
  const schedule = resolveAuthoritativeWorkSchedule(userId, date);
  if (schedule.status === 'RESOLVED' && schedule.schedule?.startTime && schedule.schedule?.endTime) {
    if (startTime <= schedule.schedule.startTime && endTime >= schedule.schedule.endTime) {
      return false; // 終日出張 (Full-Day)
    }
    return true; // 部分出張 (Partial)
  }
  return false;
}

export class ConflictService {
  /**
   * 3大競合 (Status, Service Period, Time) を総合検証 (Single Source of Truth)
   */
  static validate(params: ConflictCheckParams): ConflictValidationResult {
    const db = getDb();
    const startDate = params.startDate;
    const endDate = params.endDate || params.startDate;

    // 1. Status Conflict 検証
    // 該当期間内に有効な PersonnelStatus (停職, 分限休職, 育休等) が存在するか
    const existingStatuses = db.prepare(`
      SELECT * FROM personnel_statuses
      WHERE user_id = ?
        AND status IN ('CONFIRMED', 'EFFECTIVE')
        AND effective_from <= ?
        AND (effective_to IS NULL OR effective_to >= ?)
        AND (? IS NULL OR id != ?)
    `).all(
      params.userId,
      endDate,
      startDate,
      params.excludePersonnelStatusId || null,
      params.excludePersonnelStatusId || null
    ) as any[];

    // 停職 または 分限休職 または 育休 中に 年休・特休・病休・出張 を申請しようとした場合
    if (params.applicationTypeId) {
      for (const st of existingStatuses) {
        if (st.status_type === 'DISCIPLINARY_SUSPENSION') {
          return {
            hasConflict: true,
            conflictType: 'STATUS_CONFLICT',
            reason: `停職期間中 (${st.effective_from}〜${st.effective_to}) のため服務申請は行えません`,
            conflictingEntity: st,
          };
        }
        if (st.status_type === 'SUSPENSION') {
          return {
            hasConflict: true,
            conflictType: 'STATUS_CONFLICT',
            reason: `分限休職期間中 (${st.effective_from}〜${st.effective_to}) のため服務申請は行えません`,
            conflictingEntity: st,
          };
        }
        if (st.status_type === 'CHILDCARE_LEAVE') {
          return {
            hasConflict: true,
            conflictType: 'STATUS_CONFLICT',
            reason: `育児休業期間中 (${st.effective_from}〜${st.effective_to}) のため服務申請は行えません`,
            conflictingEntity: st,
          };
        }
      }
    }

    // 新規 PersonnelStatus 登録時に既存の PersonnelStatus と重複していないか
    if (params.statusType) {
      if (existingStatuses.length > 0) {
        const st = existingStatuses[0];
        return {
          hasConflict: true,
          conflictType: 'STATUS_CONFLICT',
          reason: `既に身分状態 (${st.status_type}: ${st.effective_from}〜${st.effective_to}) が登録されています`,
          conflictingEntity: st,
        };
      }
    }

    // 2. 申請 vs 申請 (Service Period & Time Conflict) 検証
    if (params.applicationTypeId || (params.startTime && params.endTime) || params.unitType === 'HALF_DAY') {
      const isNewUnitHalf = params.unitType === 'HALF_DAY';
      let effectiveNewStartTime = params.startTime;
      let effectiveNewEndTime = params.endTime;
      const isNewPartialTrip = isPartialBusinessTrip(params.applicationTypeId, effectiveNewStartTime, effectiveNewEndTime, startDate, params.userId);
      let isNewUnitTime = params.unitType === 'TIME' || isNewPartialTrip || (!!effectiveNewStartTime && !!effectiveNewEndTime && !isNewUnitHalf && params.applicationTypeId !== 'BUSINESS_TRIP');

      if (isNewUnitHalf) {
        if (!effectiveNewStartTime || !effectiveNewEndTime) {
          if (!params.halfDayType || (params.halfDayType !== 'MORNING' && params.halfDayType !== 'AFTERNOON')) {
            return {
              hasConflict: true,
              conflictType: 'SERVICE_PERIOD_CONFLICT',
              reason: '半日区分 (halfDayType) が不正または未設定のため競合判定できません',
            };
          }
          const schedule = resolveAuthoritativeWorkSchedule(params.userId, startDate);
          if (schedule.status !== 'RESOLVED' || schedule.isFailClosed) {
            return {
              hasConflict: true,
              conflictType: 'SERVICE_PERIOD_CONFLICT',
              reason: `勤務スケジュール解決失敗のため競合判定できません: ${schedule.failReason || 'UNRESOLVED'}`,
            };
          }
          const intervals = schedule.effectiveIntervals;
          if (!Array.isArray(intervals) || intervals.length < 2) {
            return {
              hasConflict: true,
              conflictType: 'SERVICE_PERIOD_CONFLICT',
              reason: '勤務区間が不足しているため半日休暇を解決できません (Fail-Closed)',
            };
          }
          const targetInterval = params.halfDayType === 'MORNING' ? intervals[0] : intervals[intervals.length - 1];
          if (!targetInterval || typeof targetInterval.start !== 'number' || typeof targetInterval.end !== 'number' || targetInterval.start >= targetInterval.end) {
            return {
              hasConflict: true,
              conflictType: 'SERVICE_PERIOD_CONFLICT',
              reason: '対象半日区間が不正です (Fail-Closed)',
            };
          }
          effectiveNewStartTime = minutesToTime(targetInterval.start);
          effectiveNewEndTime = minutesToTime(targetInterval.end);
        }
        isNewUnitTime = true;
      }

      const isNewUnitFull = !isNewUnitTime && !isNewUnitHalf; // DAY or MULTI_DAY

      // 照合対象ステータス:
      // - 決裁時 (forFinalApproval = true): 既に決裁済みの申請 ('FINAL_APPROVED', 'TRIP_APPROVED') のみ
      // - 申請時 (forFinalApproval = false): 進行中および決裁済みの申請 ('SUBMITTED', 'FIRST_APPROVED', 'IN_APPROVAL', 'FINAL_APPROVED', 'TRIP_APPROVED')
      const targetStatuses = params.forFinalApproval
        ? ['FINAL_APPROVED', 'TRIP_APPROVED']
        : ['SUBMITTED', 'FIRST_APPROVED', 'IN_APPROVAL', 'FINAL_APPROVED', 'TRIP_APPROVED'];

      const placeholders = targetStatuses.map(() => '?').join(',');
      const apps = db.prepare(`
        SELECT id, type_id, current_status, form_data FROM applications
        WHERE subject_user_id = ?
          AND current_status IN (${placeholders})
          AND (? IS NULL OR id != ?)
      `).all(
        params.userId,
        ...targetStatuses,
        params.excludeApplicationId || null,
        params.excludeApplicationId || null
      ) as any[];

      for (const a of apps) {
        let form: any = {};
        try {
          form = JSON.parse(a.form_data || '{}');
        } catch {
          continue;
        }

        const existingStart = form.startDate || form.targetDate || form.startAt?.split('T')?.[0];
        const existingEnd = form.endDate || form.targetDate || form.endAt?.split('T')?.[0] || existingStart;

        if (!existingStart || !existingEnd) continue;

        // 期間重複チェック: new_start <= existing_end AND new_end >= existing_start
        const hasDateOverlap = startDate <= existingEnd && endDate >= existingStart;
        if (!hasDateOverlap) continue;

        const existStartAtTime = form.startAt ? form.startAt.split('T')?.[1]?.substring(0, 5) : undefined;
        const existEndAtTime = form.endAt ? form.endAt.split('T')?.[1]?.substring(0, 5) : undefined;
        let effectiveExistStartTime = form.startTime || existStartAtTime;
        let effectiveExistEndTime = form.endTime || existEndAtTime;
        const isExistingUnitHalf = form.unitType === 'HALF_DAY' || form.unitType === 'HALF_DAY_AM' || form.unitType === 'HALF_DAY_PM';
        const isExistingPartialTrip = isPartialBusinessTrip(a.type_id, effectiveExistStartTime, effectiveExistEndTime, existingStart, params.userId);
        let isExistingUnitTime = form.unitType === 'TIME' || isExistingPartialTrip || (!!effectiveExistStartTime && !!effectiveExistEndTime && !isExistingUnitHalf && a.type_id !== 'BUSINESS_TRIP');

        if (isExistingUnitHalf) {
          if (!effectiveExistStartTime || !effectiveExistEndTime) {
            const hType = form.halfDayType || (form.unitType === 'HALF_DAY_PM' ? 'AFTERNOON' : (form.unitType === 'HALF_DAY_AM' ? 'MORNING' : undefined));
            if (hType === 'MORNING' || hType === 'AFTERNOON') {
              const schedule = resolveAuthoritativeWorkSchedule(params.userId, existingStart);
              if (schedule.status === 'RESOLVED' && !schedule.isFailClosed && Array.isArray(schedule.effectiveIntervals) && schedule.effectiveIntervals.length >= 2) {
                const targetInterval = hType === 'MORNING' ? schedule.effectiveIntervals[0] : schedule.effectiveIntervals[schedule.effectiveIntervals.length - 1];
                if (targetInterval && typeof targetInterval.start === 'number' && typeof targetInterval.end === 'number' && targetInterval.start < targetInterval.end) {
                  effectiveExistStartTime = minutesToTime(targetInterval.start);
                  effectiveExistEndTime = minutesToTime(targetInterval.end);
                }
              }
            }
          }
          if (effectiveExistStartTime && effectiveExistEndTime) {
            isExistingUnitTime = true;
          }
        }

        const isExistingUnitFull = !isExistingUnitTime && !isExistingUnitHalf;

        const isNewExclusive = params.applicationTypeId ? EXCLUSIVE_DAILY_SERVICE_TYPES.has(params.applicationTypeId) : false;
        const isExistingExclusive = a.type_id ? EXCLUSIVE_DAILY_SERVICE_TYPES.has(a.type_id) : false;
        const isNewLeaveExclusive = params.applicationTypeId ? LEAVE_EXCLUSIVE_DAILY_SERVICE_TYPES.has(params.applicationTypeId) : false;
        const isExistingLeaveExclusive = a.type_id ? LEAVE_EXCLUSIVE_DAILY_SERVICE_TYPES.has(a.type_id) : false;

        // A. 終日/複数日 vs 終日/複数日 (両方が排他服務の場合)
        // ただし出張同士 (BUSINESS_TRIP × BUSINESS_TRIP) の同日併存は業務上許容 (COEXIST_BY_POLICY)
        const isBothBusinessTrip = params.applicationTypeId === 'BUSINESS_TRIP' && a.type_id === 'BUSINESS_TRIP';
        if (isNewUnitFull && isExistingUnitFull && isNewExclusive && isExistingExclusive && !isBothBusinessTrip) {
          return {
            hasConflict: true,
            conflictType: 'SERVICE_PERIOD_CONFLICT',
            reason: `指定期間 (${startDate}${endDate !== startDate ? '〜' + endDate : ''}) は既に別の服務申請 (#${a.id}: ${existingStart}${existingEnd !== existingStart ? '〜' + existingEnd : ''}) が登録されています`,
            conflictingEntity: a,
          };
        }

        // B. 終日/複数日 vs 時間単位/半日単位申請
        // 終日側が LEAVE_EXCLUSIVE (終日年休・病休等の休暇排他型) の場合、時間単位・半日単位申請を遮断。
        // 出張・研修 (WORK_COUNTED) と時間単位・半日単位申請の同日併存は業務上合目的のため双方向で許可 (COEXIST_AND_DEDUCT)。
        if (isNewUnitFull && isExistingUnitTime) {
          if (isNewLeaveExclusive) {
            return {
              hasConflict: true,
              conflictType: 'SERVICE_PERIOD_CONFLICT',
              reason: `指定期間 (${startDate}〜${endDate}) には既に${isExistingUnitHalf ? '半日' : '時間単位'}の申請 (#${a.id}: ${form.targetDate || existingStart} ${effectiveExistStartTime || form.startTime || ''}〜${effectiveExistEndTime || form.endTime || ''}) が存在します`,
              conflictingEntity: a,
            };
          }
        }

        if (isNewUnitTime && isExistingUnitFull) {
          if (isExistingLeaveExclusive) {
            return {
              hasConflict: true,
              conflictType: 'SERVICE_PERIOD_CONFLICT',
              reason: `対象日 (${startDate}) は既に終日・複数日の服務申請 (#${a.id}: ${existingStart}〜${existingEnd}) が登録されています`,
              conflictingEntity: a,
            };
          }
        }

        // C. 時間単位 vs 時間単位 (同一日における時間帯重複)
        if (isNewUnitTime && isExistingUnitTime && startDate === existingStart) {
          const newStart = effectiveNewStartTime;
          const newEnd = effectiveNewEndTime;
          const existStart = effectiveExistStartTime;
          const existEnd = effectiveExistEndTime;

          if (newStart && newEnd && existStart && existEnd) {
            // 重複条件: existStart < newEnd AND newStart < existEnd (境界接触は非重複)
            if (existStart < newEnd && newStart < existEnd) {
              return {
                hasConflict: true,
                conflictType: 'TIME_CONFLICT',
                reason: `同一時間帯 (${existStart}〜${existEnd}) に既に別の申請 (#${a.id}) が存在します`,
                conflictingEntity: a,
              };
            }
          }
        }
      }
    }

    return { hasConflict: false };
  }
}
