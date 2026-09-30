import { getDb } from '../db/database';
import { getServerIsoString } from './serverTime';
import { AnnualLeaveService } from '../services/annualLeaveService';

export const WORK_DAY_MINUTES = 7 * 60 + 45; // 7時間45分 = 465分 (デフォルトフルタイム)
export const ANNUAL_LEAVE_INITIAL_DAYS = 20; // デフォルト年休付与日数

/**
 * システム設定から1日の標準勤務時間（分）を取得
 */
export function getWorkDayMinutes(): number {
  try {
    const db = getDb();
    const setting = db.prepare("SELECT value FROM system_settings WHERE key = 'work_day_minutes'").get() as { value: string } | undefined;
    if (setting && setting.value) {
      const val = parseInt(setting.value, 10);
      if (!isNaN(val) && val > 0) return val;
    }
  } catch {
    // テーブルが存在しない初期化前などはデフォルト値を返す
  }
  return WORK_DAY_MINUTES;
}

export interface LeaveSummaryItem {
  days: number;
  hours: number;
  minutes: number;
  totalMinutes: number;
  formatted: string; // 例: "1日 3時間 15分"
}

export interface UserLeaveSummary {
  annualLeave: {
    initialDays: number;
    grantedDays: number;
    adjustedDays: number;
    used: LeaveSummaryItem;
    remaining: LeaveSummaryItem;
    formattedRemainingDays?: string;
    formattedHourlyUsage?: string;
  };
  sickLeave: LeaveSummaryItem;
  specialLeave: LeaveSummaryItem;
  dutyExempt: LeaveSummaryItem;
  careLeave?: LeaveSummaryItem;
  careTime?: LeaveSummaryItem;
}

/**
 * 分数を「○日 ○時間 ○分」に変換（標準勤務時間 = 1日換算）
 */
export function minutesToLeaveUnits(totalMinutes: number, workDayMins = getWorkDayMinutes()): LeaveSummaryItem {
  const days = Math.floor(totalMinutes / workDayMins);
  const remMinutes = totalMinutes % workDayMins;
  const hours = Math.floor(remMinutes / 60);
  const minutes = remMinutes % 60;

  let formatted = '';
  if (days > 0) formatted += `${days}日 `;
  if (hours > 0 || days > 0) formatted += `${hours}時間 `;
  formatted += `${minutes}分`;

  return {
    days,
    hours,
    minutes,
    totalMinutes,
    formatted: formatted.trim() || '0分',
  };
}

/**
 * 開始時刻と終了時刻 (HH:mm) から取得分数（休憩控除なし/または標準勤務時間内）を計算
 */
export function calculateTimeLeaveMinutes(startTime: string, endTime: string): number {
  if (!startTime || !endTime) return 0;
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);

  const startTotal = sh * 60 + sm;
  const endTotal = eh * 60 + em;

  const diff = endTotal - startTotal;
  return diff > 0 ? diff : 0;
}

/**
 * ユーザーの年休付与（Leave Grant / Entitlement）を新規登録
 */
export function addLeaveGrant(params: {
  userId: number;
  leaveType: string;
  grantedAmount: number;
  grantDate: string;
  effectiveFrom: string;
  expiresAt: string;
  carryoverSourceGrantId?: number;
  reason: string;
}): number {
  const db = getDb();
  const now = getServerIsoString();

  // 1. 旧 leave_grants 互換挿入
  try {
    db.prepare(`
      INSERT INTO leave_grants (
        user_id, leave_type, granted_amount, grant_date, effective_from, expires_at, carryover_source_grant_id, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.userId,
      params.leaveType,
      params.grantedAmount,
      params.grantDate,
      params.effectiveFrom,
      params.expiresAt,
      params.carryoverSourceGrantId || null,
      params.reason,
      now
    );
  } catch {}

  // 2. 新 leave_entitlements への登録
  const grantYear = parseInt(params.grantDate.split('-')[0], 10) || 2026;
  return AnnualLeaveService.grantEntitlement({
    userId: params.userId,
    entitlementType: params.carryoverSourceGrantId ? 'CARRYOVER' : 'REGULAR_GRANT',
    fiscalYear: grantYear,
    grantedDays: Math.round(params.grantedAmount),
    grantDate: params.grantDate,
    effectiveFrom: params.effectiveFrom,
    expiresAt: params.expiresAt,
    carryoverFromId: params.carryoverSourceGrantId,
    reason: params.reason
  });
}

/**
 * ユーザーの年休手動調整（Leave Adjustment）を新規登録
 */
export function addLeaveAdjustment(params: {
  userId: number;
  leaveType: string;
  adjustedAmount: number;
  adjustedByUserId: number;
  reason: string;
}): number {
  const db = getDb();
  const now = getServerIsoString();
  const res = db.prepare(`
    INSERT INTO leave_adjustments (
      user_id, leave_type, adjusted_amount, adjusted_by_user_id, reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    params.userId,
    params.leaveType,
    params.adjustedAmount,
    params.adjustedByUserId,
    params.reason,
    now
  );
  return Number(res.lastInsertRowid);
}

/**
 * ユーザーの年休残高・休暇累計を算出 (LeaveBalanceProjection 統合)
 */
export function getUserLeaveSummary(userId: number, asOfDate?: string): UserLeaveSummary {
  const db = getDb();
  const workDayMins = getWorkDayMinutes();
  const today = asOfDate || new Date().toISOString().split('T')[0];

  // 1. 年次有給休暇 Projection の取得
  let projection = {
    totalGrantedDays: ANNUAL_LEAVE_INITIAL_DAYS,
    remainingDays: ANNUAL_LEAVE_INITIAL_DAYS,
    remainingHalfDayUnits: ANNUAL_LEAVE_INITIAL_DAYS * 2,
    hourlyUsedMinutesInYear: 0,
    hourlyLimitMinutesInYear: 2325,
    hourlyRemainingMinutesInYear: 2325,
    formattedRemaining: `${ANNUAL_LEAVE_INITIAL_DAYS}日`,
    formattedHourlyUsage: '0時間0分 (上限: 38時間45分)'
  };

  try {
    projection = AnnualLeaveService.getLeaveBalanceProjection(userId, today);
  } catch {}

  // 2. 他の休暇の累計計算 (病休・特休・職免・介護等)
  const approvedApps = db.prepare(`
    SELECT type_id, form_data
    FROM applications
    WHERE subject_user_id = ?
      AND current_status = 'FINAL_APPROVED'
  `).all(userId) as { type_id: string; form_data: string }[];

  let sickMinutes = 0;
  let specialMinutes = 0;
  let dutyExemptMinutes = 0;
  let careLeaveMinutes = 0;
  let careTimeMinutes = 0;

  for (const app of approvedApps) {
    if (app.type_id === 'LEAVE_ANNUAL') continue;
    const data = JSON.parse(app.form_data || '{}');
    let minutes = 0;

    if (data.unitType === 'TIME') {
      minutes = data.calculatedMinutes !== undefined ? data.calculatedMinutes : calculateTimeLeaveMinutes(data.startTime, data.endTime);
    } else if (data.unitType === 'HALF_DAY') {
      minutes = data.calculatedMinutes || 230;
    } else {
      const days = data.calculatedDays || 1;
      minutes = days * workDayMins;
    }

    switch (app.type_id) {
      case 'LEAVE_SICK':
        sickMinutes += minutes;
        break;
      case 'LEAVE_SPECIAL':
        specialMinutes += minutes;
        break;
      case 'LEAVE_DUTY_EXEMPT':
        dutyExemptMinutes += minutes;
        break;
      case 'LEAVE_CARE':
        careLeaveMinutes += minutes;
        break;
      case 'LEAVE_CARE_TIME':
        careTimeMinutes += minutes;
        break;
    }
  }

  // 年休の消化サマリー (日・時間)
  // ロットから日・半日消化数と時間休消化数を直接集計
  const entitlements = db.prepare(`
    SELECT * FROM leave_entitlements
    WHERE user_id = ? AND status = 'ACTIVE' AND effective_from <= ? AND expires_at >= ?
  `).all(userId, today, today) as any[];

  let usedHalfUnits = 0;
  let usedHourlyMinutes = 0;
  for (const ent of entitlements) {
    usedHalfUnits += ent.used_half_days || 0;
    usedHourlyMinutes += ent.used_hourly_minutes || 0;
  }

  const usedDays = usedHalfUnits / 2;
  const remainingDays = projection.totalGrantedDays - usedDays;
  const annualUsedFormatted = `${Math.floor(usedDays)}日${(usedDays % 1 !== 0) ? ' 半日' : ''}${usedHourlyMinutes > 0 ? ' ' + Math.floor(usedHourlyMinutes / 60) + '時間' + (usedHourlyMinutes % 60 > 0 ? (usedHourlyMinutes % 60) + '分' : '') : ''}`;

  return {
    annualLeave: {
      initialDays: projection.totalGrantedDays,
      grantedDays: projection.totalGrantedDays,
      adjustedDays: 0,
      used: {
        days: Math.floor(usedDays),
        hours: Math.floor(usedHourlyMinutes / 60),
        minutes: usedHourlyMinutes % 60,
        totalMinutes: usedHourlyMinutes,
        formatted: annualUsedFormatted.trim() || '0日',
      },
      remaining: {
        days: Math.floor(remainingDays),
        hours: Math.floor(projection.hourlyRemainingMinutesInYear / 60),
        minutes: projection.hourlyRemainingMinutesInYear % 60,
        totalMinutes: projection.hourlyRemainingMinutesInYear,
        formatted: projection.formattedRemaining,
      },
      formattedRemainingDays: `${remainingDays}日`,
      formattedHourlyUsage: projection.formattedHourlyUsage
    },
    sickLeave: minutesToLeaveUnits(sickMinutes, workDayMins),
    specialLeave: minutesToLeaveUnits(specialMinutes, workDayMins),
    dutyExempt: minutesToLeaveUnits(dutyExemptMinutes, workDayMins),
    careLeave: minutesToLeaveUnits(careLeaveMinutes, workDayMins),
    careTime: minutesToLeaveUnits(careTimeMinutes, workDayMins),
  };
}
