/**
 * Wave 3B-1: School Default Daily Schedule Payload Projection (Pure Function)
 *
 * 【責務】
 * 学校標準日課の UI / Form State を、Server Authoritative Contract に厳格に合致する
 * Canonical API Payload ({ scheduleName, effectiveFrom, weeklyOffDays, scheduleDetails }) へ
 * 純粋・非破壊・決定論的に投射する。
 *
 * 【不変条件 (Invariants)】
 * - INV-W3B-04: Client Validation は早期フィードバック (UX Guard) であり、最終権威は Server API とする。
 * - INV-W3B-05: React State, DOM, API呼出, DB知識を持たない純粋関数とする。
 * - INV-W3B-06: 週総実働時間は厳格に 2,325分 (38時間45分) 一致を要求し、7曜日の Canonical Structure を欠損なく生成する。
 */

export class SchoolScheduleProjectionError extends Error {
  constructor(public errorCode: string, message: string) {
    super(message);
    this.name = 'SchoolScheduleProjectionError';
  }
}

export interface BreakIntervalInput {
  startTime: string;
  endTime: string;
}

export interface DayScheduleDetail {
  isWorkDay: boolean;
  workMinutes?: number;
  startTime?: string | null;
  endTime?: string | null;
  intervals?: Array<{ startTime: string; endTime: string }>;
  workIntervals?: Array<{ start: number; end: number }>;
}

export type CanonicalScheduleDetails = Record<string, DayScheduleDetail>;

export interface SchoolWorkScheduleFormState {
  scheduleName: string;
  effectiveFrom: string;
  weeklyOffDays?: string | number[]; // default: '0,6'
  startTime: string;                 // 例: "08:15"
  endTime: string;                   // 例: "16:45"
  breakIntervals?: BreakIntervalInput[]; // 例: [{ startTime: "12:00", endTime: "12:45" }]
}

export interface SchoolWorkScheduleApiPayload {
  scheduleName: string;
  effectiveFrom: string;
  weeklyOffDays: string;
  scheduleDetails: CanonicalScheduleDetails;
}

/**
 * 時刻文字列 (HH:MM) を分数 (0〜1439) に変換
 */
export function timeToMinutes(timeStr: string): number {
  if (!timeStr || typeof timeStr !== 'string') {
    throw new SchoolScheduleProjectionError('INVALID_TIME_FORMAT', `時刻が指定されていません: ${timeStr}`);
  }
  const parts = timeStr.split(':').map(Number);
  if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1]) || parts[0] < 0 || parts[0] > 23 || parts[1] < 0 || parts[1] > 59) {
    throw new SchoolScheduleProjectionError('INVALID_TIME_FORMAT', `不正な時刻フォーマットです: ${timeStr}`);
  }
  return parts[0] * 60 + parts[1];
}

/**
 * 分数を時刻文字列 (HH:MM) に変換
 */
export function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * 1日の実働時間（分）を計算
 */
export function calculateDayWorkMinutes(
  startTime: string,
  endTime: string,
  breakIntervals: BreakIntervalInput[] = []
): number {
  const startMins = timeToMinutes(startTime);
  const endMins = timeToMinutes(endTime);
  if (endMins <= startMins) {
    throw new SchoolScheduleProjectionError('INVALID_TIME_RANGE', '終了時刻は開始時刻より後に設定してください');
  }

  let totalBreakMins = 0;
  const sortedBreaks = [...breakIntervals].sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
  let cur = startMins;

  for (const brk of sortedBreaks) {
    const bStart = timeToMinutes(brk.startTime);
    const bEnd = timeToMinutes(brk.endTime);

    if (bEnd <= bStart) {
      throw new SchoolScheduleProjectionError('INVALID_BREAK_RANGE', '休憩の終了時刻は開始時刻より後に設定してください');
    }
    if (bStart < startMins || bEnd > endMins) {
      throw new SchoolScheduleProjectionError('BREAK_OUTSIDE_WORK_HOURS', '休憩時間は勤務時間帯の内部に設定してください');
    }
    if (bStart < cur) {
      throw new SchoolScheduleProjectionError('OVERLAPPING_BREAKS', '休憩時間帯が重複または順序不正です');
    }

    totalBreakMins += (bEnd - bStart);
    cur = bEnd;
  }

  return (endMins - startMins) - totalBreakMins;
}

/**
 * 週の総実働時間（分）を計算（デフォルト: 週5日勤務）
 */
export function calculateWeeklyTotalMinutes(
  startTime: string,
  endTime: string,
  breakIntervals: BreakIntervalInput[] = [],
  weeklyOffDays: string | number[] = '0,6'
): number {
  const offDaysArr = Array.isArray(weeklyOffDays)
    ? weeklyOffDays.map(Number)
    : String(weeklyOffDays)
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => !isNaN(n));

  const workDaysCount = 7 - offDaysArr.length;
  const dayMins = calculateDayWorkMinutes(startTime, endTime, breakIntervals);
  return dayMins * workDaysCount;
}

/**
 * 学校標準日課の Form State から Canonical API Payload を生成する純粋射影関数
 */
export function projectSchoolWorkSchedulePayload(
  state: SchoolWorkScheduleFormState
): SchoolWorkScheduleApiPayload {
  // 1. 日課名の検証
  if (!state.scheduleName || typeof state.scheduleName !== 'string' || !state.scheduleName.trim()) {
    throw new SchoolScheduleProjectionError('MISSING_REQUIRED_FIELDS', '日課名を入力してください');
  }

  // 2. 有効開始日の検証 (GT-W3B-07: YYYY-MM-DD 形式厳格チェック)
  if (!state.effectiveFrom || typeof state.effectiveFrom !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(state.effectiveFrom)) {
    throw new SchoolScheduleProjectionError('INVALID_EFFECTIVE_FROM', '有効開始日 (YYYY-MM-DD) を正しく入力してください');
  }

  // 3. 勤務時刻の検証
  if (!state.startTime || !state.endTime) {
    throw new SchoolScheduleProjectionError('MISSING_REQUIRED_FIELDS', '勤務開始時刻および終了時刻を入力してください');
  }

  const startMins = timeToMinutes(state.startTime);
  const endMins = timeToMinutes(state.endTime);
  if (endMins <= startMins) {
    throw new SchoolScheduleProjectionError('INVALID_TIME_RANGE', '終了時刻は開始時刻より後に設定してください');
  }

  // 4. 定例週休日のパース
  const rawOffDays = state.weeklyOffDays !== undefined ? state.weeklyOffDays : '0,6';
  const offDaysArr = Array.isArray(rawOffDays)
    ? rawOffDays.map(Number)
    : String(rawOffDays)
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => !isNaN(n));

  // 5. 休憩時間帯の検証と勤務区間 (intervals) 生成
  const breakIntervals = state.breakIntervals || [];
  const sortedBreaks = [...breakIntervals].sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
  const intervals: Array<{ startTime: string; endTime: string }> = [];
  let cur = startMins;

  for (const brk of sortedBreaks) {
    const bStart = timeToMinutes(brk.startTime);
    const bEnd = timeToMinutes(brk.endTime);

    if (bEnd <= bStart) {
      throw new SchoolScheduleProjectionError('INVALID_BREAK_RANGE', '休憩の終了時刻は開始時刻より後に設定してください');
    }
    if (bStart < startMins || bEnd > endMins) {
      throw new SchoolScheduleProjectionError('BREAK_OUTSIDE_WORK_HOURS', '休憩時間は勤務時間帯の内部に設定してください');
    }
    if (bStart < cur) {
      throw new SchoolScheduleProjectionError('OVERLAPPING_BREAKS', '休憩時間帯が重複または順序不正です');
    }

    if (bStart > cur) {
      intervals.push({ startTime: minutesToTime(cur), endTime: minutesToTime(bStart) });
    }
    cur = bEnd;
  }

  if (cur < endMins) {
    intervals.push({ startTime: minutesToTime(cur), endTime: minutesToTime(endMins) });
  }

  const workIntervals = intervals.map((inv) => ({
    start: timeToMinutes(inv.startTime),
    end: timeToMinutes(inv.endTime),
  }));

  const dayMins = workIntervals.reduce((sum, inv) => sum + (inv.end - inv.start), 0);
  const workDaysCount = 7 - offDaysArr.length;
  const weeklyTotal = dayMins * workDaysCount;

  // 6. 週総実働時間の厳格検証 (INV-W3B-06: 2,325分 = 38時間45分)
  if (weeklyTotal !== 2325) {
    throw new SchoolScheduleProjectionError(
      'INVALID_WEEKLY_TOTAL_MINUTES',
      `学校標準日課の週勤務時間は厳格に2,325分（38時間45分）でなければなりません (現在: ${weeklyTotal}分)`
    );
  }

  // 7. Canonical 7曜日 scheduleDetails の構築
  const scheduleDetails: CanonicalScheduleDetails = {};
  for (let d = 0; d < 7; d++) {
    const dayKey = String(d);
    const isOff = offDaysArr.includes(d);

    if (isOff) {
      scheduleDetails[dayKey] = {
        isWorkDay: false,
        workMinutes: 0,
        startTime: null,
        endTime: null,
        intervals: [],
        workIntervals: [],
      };
    } else {
      scheduleDetails[dayKey] = {
        isWorkDay: true,
        workMinutes: dayMins,
        startTime: state.startTime,
        endTime: state.endTime,
        intervals: intervals.map((i) => ({ startTime: i.startTime, endTime: i.endTime })),
        workIntervals: workIntervals.map((i) => ({ start: i.start, end: i.end })),
      };
    }
  }

  return {
    scheduleName: state.scheduleName.trim(),
    effectiveFrom: state.effectiveFrom,
    weeklyOffDays: offDaysArr.join(','),
    scheduleDetails,
  };
}
