import { getDb } from '../../db/database';

export interface WorkTimeInterval {
  start: number; // 分 (0:00からの通算, 0 <= start < 1440)
  end: number;   // 分 (0:00からの通算, 0 < end <= 1440)
}

export type StatutoryPatternCode = 'CST_01' | 'CST_02' | 'CST_03' | 'CST_04';
export type ScheduleSource = 'SCHOOL_DEFAULT' | 'INDIVIDUAL';

export interface DayScheduleDetail {
  isWorkDay: boolean;
  workMinutes: number;
  startTime: string | null;
  endTime: string | null;
  intervals?: Array<{ startTime: string; endTime: string }>;
  workIntervals?: WorkTimeInterval[];
}

export type ScheduleDetailsJson = Record<string, DayScheduleDetail>;

export function timeToMinutes(timeStr: string): number {
  if (!timeStr) return 0;
  const [h, m] = timeStr.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function minutesToTime(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export type WorkPatternResolutionStatus =
  | 'RESOLVED'
  | 'RESOLVED_LEGACY_COMPATIBLE'
  | 'UNKNOWN_PATTERN'
  | 'AMBIGUOUS_PATTERN'
  | 'INVALID_SCHEDULE';

export interface ResolvedWorkSchedule {
  status: WorkPatternResolutionStatus;
  isFailClosed: boolean;
  failReason?: string;
  userId: number;
  date: string;
  patternId?: number;
  patternName?: string;
  patternType?: 'STANDARD_FULLTIME' | 'SHORT_TIME' | 'CUSTOM';
  statutoryPatternCode?: StatutoryPatternCode | null;
  scheduleSource?: ScheduleSource;
  schoolScheduleId?: number;
  isWorkDay?: boolean;
  dutyStatus?: 'WORK_REQUIRED' | 'NO_WORK_REQUIRED';
  scheduledWorkMinutes?: number; // 正常解決時のみ設定 (非勤務日なら0、勤務日なら>0)
  schedule?: DayScheduleDetail | null;
  effectiveIntervals?: WorkTimeInterval[];
  breakIntervals?: WorkTimeInterval[];
  breakMinutes?: number;
  weeklyOffDays?: number[];
  overrideSource?: 'CALENDAR_ADJUSTMENT' | 'WORK_PATTERN';
}

/**
 * インターバル配列の厳格バリデーション (Fail-Closed)
 * - 0 <= start < 1440
 * - 0 < end <= 1440
 * - start < end
 * - 前の区間と重複なし (prev.end <= curr.start)
 */
export function validateWorkIntervals(intervals: WorkTimeInterval[]): { isValid: boolean; error?: string } {
  if (!Array.isArray(intervals)) {
    return { isValid: false, error: 'intervals must be an array' };
  }

  for (let i = 0; i < intervals.length; i++) {
    const inv = intervals[i];
    if (typeof inv.start !== 'number' || typeof inv.end !== 'number') {
      return { isValid: false, error: `Interval at index ${i} has non-numeric start or end` };
    }
    if (inv.start < 0 || inv.start >= 1440) {
      return { isValid: false, error: `Interval start (${inv.start}) out of bounds [0, 1440)` };
    }
    if (inv.end <= 0 || inv.end > 1440) {
      return { isValid: false, error: `Interval end (${inv.end}) out of bounds (0, 1440]` };
    }
    if (inv.start >= inv.end) {
      return { isValid: false, error: `Interval start (${inv.start}) >= end (${inv.end})` };
    }
    if (i > 0) {
      const prev = intervals[i - 1];
      if (inv.start < prev.end) {
        return { isValid: false, error: `Overlapping intervals detected: [${prev.start}, ${prev.end}] and [${inv.start}, ${inv.end}]` };
      }
    }
  }

  return { isValid: true };
}

/**
 * 勤務区間から休憩区間を導出
 */
export function deriveBreakIntervals(effectiveIntervals: WorkTimeInterval[]): { breakIntervals: WorkTimeInterval[]; breakMinutes: number } {
  if (effectiveIntervals.length <= 1) {
    return { breakIntervals: [], breakMinutes: 0 };
  }

  const breakIntervals: WorkTimeInterval[] = [];
  let breakMinutes = 0;

  for (let i = 0; i < effectiveIntervals.length - 1; i++) {
    const curr = effectiveIntervals[i];
    const next = effectiveIntervals[i + 1];
    if (next.start > curr.end) {
      breakIntervals.push({ start: curr.end, end: next.start });
      breakMinutes += (next.start - curr.end);
    }
  }

  return { breakIntervals, breakMinutes };
}

/**
 * 指定時間帯と実勤務予定区間の交差時間 (分数) を厳密算出
 */
export function calculateScheduleIntersectionMinutes(
  startTime: string,
  endTime: string,
  schedule: ResolvedWorkSchedule
): number {
  if (!startTime || !endTime || !schedule || !schedule.isWorkDay || !schedule.effectiveIntervals) return 0;

  const eventStart = timeToMinutes(startTime);
  const eventEnd = timeToMinutes(endTime);
  if (eventEnd <= eventStart) return 0;

  let totalIntersection = 0;
  for (const interval of schedule.effectiveIntervals) {
    const overlapStart = Math.max(eventStart, interval.start);
    const overlapEnd = Math.min(eventEnd, interval.end);
    if (overlapEnd > overlapStart) {
      totalIntersection += (overlapEnd - overlapStart);
    }
  }

  return totalIntersection;
}

/**
 * 既知レガシー移行データ（Migration 006）の決定論的判定
 */
export function isKnownLegacyMigration006Data(
  pattern: any,
  rawDetail: any
): boolean {
  if (pattern.record_origin !== 'MIGRATION_INITIAL') return false;
  if (pattern.pattern_type !== 'STANDARD_FULLTIME') return false;
  if (!rawDetail || rawDetail.isWorkDay !== true) return false;
  if ((rawDetail.workMinutes ?? rawDetail.minutes) !== 465) return false;
  const start = rawDetail.startTime ?? rawDetail.start;
  const end = rawDetail.endTime ?? rawDetail.end;
  if (start !== '08:15' || end !== '16:45') return false;
  // intervals または workIntervals が存在しないこと
  if (rawDetail.intervals && Array.isArray(rawDetail.intervals) && rawDetail.intervals.length > 0) return false;
  if (rawDetail.workIntervals && Array.isArray(rawDetail.workIntervals) && rawDetail.workIntervals.length > 0) return false;

  return true;
}

/**
 * Authoritative Working Pattern Resolver (SSOT)
 */
export function resolveAuthoritativeWorkSchedule(
  userId: number,
  targetDate: string
): ResolvedWorkSchedule {
  const db = getDb();
  const dt = new Date(targetDate);
  const dayOfWeek = dt.getDay();

  // 1. 有効期間内のマッチする全パターンを取得 (Cardinality 判定)
  const patterns = db.prepare(`
    SELECT * FROM user_work_patterns
    WHERE user_id = ? AND effective_from <= ? AND effective_to >= ?
    ORDER BY effective_from DESC
  `).all(userId, targetDate, targetDate) as any[];

  // Case A: 0件マッチ -> UNKNOWN_PATTERN (Fail-Closed)
  if (!patterns || patterns.length === 0) {
    return {
      status: 'UNKNOWN_PATTERN',
      isFailClosed: true,
      failReason: `対象日（${targetDate}）に有効な勤務パターンが存在しません (userId=${userId})`,
      userId,
      date: targetDate
    };
  }

  // Case C: 2件以上マッチ -> AMBIGUOUS_PATTERN (Fail-Closed)
  if (patterns.length > 1) {
    return {
      status: 'AMBIGUOUS_PATTERN',
      isFailClosed: true,
      failReason: `対象日（${targetDate}）に複数の有効な勤務パターンが重複しています (userId=${userId}, count=${patterns.length})`,
      userId,
      date: targetDate
    };
  }

  // Case B: 1件マッチ -> 詳細スケジュールの解析
  const pattern = patterns[0];

  // Explicit 2-Value Invariant: schedule_source は 'SCHOOL_DEFAULT' または 'INDIVIDUAL' のみ許可 (Fail-Closed)
  if (pattern.schedule_source !== 'SCHOOL_DEFAULT' && pattern.schedule_source !== 'INDIVIDUAL') {
    return {
      status: 'INVALID_SCHEDULE',
      isFailClosed: true,
      failReason: `勤務パターン（ID=${pattern.id}）の schedule_source が不正または未設定です (value=${pattern.schedule_source ?? 'NULL'})`,
      userId,
      date: targetDate,
      patternId: pattern.id,
      patternName: pattern.pattern_name,
    };
  }
  const scheduleSource: ScheduleSource = pattern.schedule_source;
  let schoolScheduleId: number | undefined = undefined;
  let rawJson = pattern.schedule_details_json;
  let offDays = (pattern.weekly_off_days || '').split(',').map((s: string) => parseInt(s.trim(), 10)).filter((n: number) => !isNaN(n));

  // schedule_source = SCHOOL_DEFAULT の場合、有効な学校標準日課から日課定義を取得
  if (scheduleSource === 'SCHOOL_DEFAULT') {
    const schoolSchedules = db.prepare(`
      SELECT * FROM school_work_schedules
      WHERE effective_from <= ? AND effective_to >= ? AND is_active = 1
      ORDER BY effective_from DESC
    `).all(targetDate, targetDate) as any[];

    if (!schoolSchedules || schoolSchedules.length === 0) {
      return {
        status: 'INVALID_SCHEDULE',
        isFailClosed: true,
        failReason: `対象日（${targetDate}）に有効な学校標準日課が登録されていません (SCHOOL_DEFAULT未設定)`,
        userId,
        date: targetDate,
        patternId: pattern.id,
        patternName: pattern.pattern_name,
        scheduleSource: 'SCHOOL_DEFAULT'
      };
    }
    if (schoolSchedules.length > 1) {
      return {
        status: 'AMBIGUOUS_PATTERN',
        isFailClosed: true,
        failReason: `対象日（${targetDate}）に複数の有効な学校標準日課が重複しています (count=${schoolSchedules.length})`,
        userId,
        date: targetDate,
        patternId: pattern.id,
        patternName: pattern.pattern_name,
        scheduleSource: 'SCHOOL_DEFAULT'
      };
    }
    const schoolSched = schoolSchedules[0];
    rawJson = schoolSched.schedule_details_json;
    schoolScheduleId = schoolSched.id;
    if (offDays.length === 0 && schoolSched.weekly_off_days) {
      offDays = (schoolSched.weekly_off_days || '').split(',').map((s: string) => parseInt(s.trim(), 10)).filter((n: number) => !isNaN(n));
    }
  }

  const isWeeklyOff = offDays.includes(dayOfWeek);

  // schedule_details_json が存在しない場合は Fail-Closed (Generic NULL Fallback は完全削除)
  if (!rawJson) {
    return {
      status: 'INVALID_SCHEDULE',
      isFailClosed: true,
      failReason: scheduleSource === 'SCHOOL_DEFAULT'
        ? `学校標準日課（ID=${schoolScheduleId}）に schedule_details_json が存在しません`
        : `勤務パターン（ID=${pattern.id}）に schedule_details_json が存在しません (Generic NULL Fallback 排除)`,
      userId,
      date: targetDate,
      patternId: pattern.id,
      patternName: pattern.pattern_name,
      scheduleSource,
      schoolScheduleId
    };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(rawJson);
    if (typeof parsed !== 'object' || parsed === null) {
      return {
        status: 'INVALID_SCHEDULE',
        isFailClosed: true,
        failReason: scheduleSource === 'SCHOOL_DEFAULT'
          ? `学校標準日課（ID=${schoolScheduleId}）の schedule_details_json が不正なオブジェクトです`
          : `勤務パターン（ID=${pattern.id}）の schedule_details_json が不正なオブジェクトです`,
        userId,
        date: targetDate,
        patternId: pattern.id,
        patternName: pattern.pattern_name,
        scheduleSource,
        schoolScheduleId
      };
    }
  } catch (e: any) {
    return {
      status: 'INVALID_SCHEDULE',
      isFailClosed: true,
      failReason: scheduleSource === 'SCHOOL_DEFAULT'
        ? `学校標準日課（ID=${schoolScheduleId}）の schedule_details_json のJSONパースに失敗しました: ${e.message}`
        : `勤務パターン（ID=${pattern.id}）の schedule_details_json のJSONパースに失敗しました: ${e.message}`,
      userId,
      date: targetDate,
      patternId: pattern.id,
      patternName: pattern.pattern_name,
      scheduleSource,
      schoolScheduleId
    };
  }

  const dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const rawDetail = parsed[dayOfWeek] || parsed[dayKeys[dayOfWeek]] || parsed[String(dayOfWeek)];

  if (!rawDetail) {
    // 該当曜日の定義が欠落している場合
    if (isWeeklyOff) {
      return {
        status: 'RESOLVED',
        isFailClosed: false,
        userId,
        date: targetDate,
        patternId: pattern.id,
        patternName: pattern.pattern_name,
        patternType: pattern.pattern_type,
        statutoryPatternCode: pattern.statutory_pattern_code || null,
        scheduleSource,
        schoolScheduleId,
        isWorkDay: false,
        dutyStatus: 'NO_WORK_REQUIRED',
        scheduledWorkMinutes: 0,
        schedule: { isWorkDay: false, workMinutes: 0, startTime: null, endTime: null, workIntervals: [] },
        effectiveIntervals: [],
        breakIntervals: [],
        breakMinutes: 0,
        weeklyOffDays: offDays
      };
    } else {
      return {
        status: 'INVALID_SCHEDULE',
        isFailClosed: true,
        failReason: scheduleSource === 'SCHOOL_DEFAULT'
          ? `学校標準日課（ID=${schoolScheduleId}）の曜日（${dayOfWeek}）の日課定義が存在しません`
          : `勤務パターン（ID=${pattern.id}）の曜日（${dayOfWeek}）の日課定義が存在しません`,
        userId,
        date: targetDate,
        patternId: pattern.id,
        patternName: pattern.pattern_name,
        scheduleSource,
        schoolScheduleId
      };
    }
  }

  // 非勤務日の場合
  if (rawDetail.isWorkDay === false) {
    // 非勤務日なのに intervals が定義されている場合は不正
    if (rawDetail.workIntervals && rawDetail.workIntervals.length > 0) {
      return {
        status: 'INVALID_SCHEDULE',
        isFailClosed: true,
        failReason: `非勤務日（曜日=${dayOfWeek}）に実働インターバルが設定されています (Off-Day Emptiness 違反)`,
        userId,
        date: targetDate,
        patternId: pattern.id,
        patternName: pattern.pattern_name,
        scheduleSource,
        schoolScheduleId
      };
    }

    return {
      status: 'RESOLVED',
      isFailClosed: false,
      userId,
      date: targetDate,
      patternId: pattern.id,
      patternName: pattern.pattern_name,
      patternType: pattern.pattern_type,
      statutoryPatternCode: pattern.statutory_pattern_code || null,
      scheduleSource,
      schoolScheduleId,
      isWorkDay: false,
      dutyStatus: 'NO_WORK_REQUIRED',
      scheduledWorkMinutes: 0,
      schedule: {
        isWorkDay: false,
        workMinutes: 0,
        startTime: null,
        endTime: null,
        workIntervals: []
      },
      effectiveIntervals: [],
      breakIntervals: [],
      breakMinutes: 0,
      weeklyOffDays: offDays
    };
  }

  // 勤務日の場合: intervals の解決
  let intervals: WorkTimeInterval[] = [];
  let isLegacyMapped = false;

  if (rawDetail.workIntervals && Array.isArray(rawDetail.workIntervals) && rawDetail.workIntervals.length > 0) {
    intervals = rawDetail.workIntervals.map((inv: any) => ({ start: Number(inv.start), end: Number(inv.end) }));
  } else if (rawDetail.intervals && Array.isArray(rawDetail.intervals) && rawDetail.intervals.length > 0) {
    intervals = rawDetail.intervals.map((inv: any) => ({
      start: timeToMinutes(inv.startTime),
      end: timeToMinutes(inv.endTime)
    }));
  } else if (isKnownLegacyMigration006Data(pattern, rawDetail)) {
    // 確定済みレガシー移行データ（08:15〜16:45, 465分）の決定論的マッピング
    intervals = [
      { start: 495, end: 735 },  // 08:15 - 12:15 (240分)
      { start: 780, end: 1005 } // 13:00 - 16:45 (225分)
    ];
    isLegacyMapped = true;
  } else {
    // それ以外の intervals 欠損は推測せず FAIL-CLOSED
    return {
      status: 'INVALID_SCHEDULE',
      isFailClosed: true,
      failReason: `勤務日（曜日=${dayOfWeek}）の明示的実働インターバル（workIntervals）が存在しません (No Guessing 違反)`,
      userId,
      date: targetDate,
      patternId: pattern.id,
      patternName: pattern.pattern_name,
      scheduleSource,
      schoolScheduleId
    };
  }

  // インターバル整合性検証
  const valRes = validateWorkIntervals(intervals);
  if (!valRes.isValid) {
    return {
      status: 'INVALID_SCHEDULE',
      isFailClosed: true,
      failReason: `曜日（${dayOfWeek}）の実働インターバルが不正です: ${valRes.error}`,
      userId,
      date: targetDate,
      patternId: pattern.id,
      patternName: pattern.pattern_name,
      scheduleSource,
      schoolScheduleId
    };
  }

  // 導出事実の計算
  const scheduledWorkMinutes = intervals.reduce((sum, inv) => sum + (inv.end - inv.start), 0);
  if (scheduledWorkMinutes <= 0) {
    return {
      status: 'INVALID_SCHEDULE',
      isFailClosed: true,
      failReason: `勤務日（曜日=${dayOfWeek}）の実働合計分数が 0分以下です`,
      userId,
      date: targetDate,
      patternId: pattern.id,
      patternName: pattern.pattern_name,
      scheduleSource,
      schoolScheduleId
    };
  }

  const startTime = minutesToTime(intervals[0].start);
  const endTime = minutesToTime(intervals[intervals.length - 1].end);
  const { breakIntervals, breakMinutes } = deriveBreakIntervals(intervals);

  const finalScheduleDetail: DayScheduleDetail = {
    isWorkDay: true,
    workMinutes: scheduledWorkMinutes,
    startTime,
    endTime,
    workIntervals: intervals,
    intervals: intervals.map(inv => ({ startTime: minutesToTime(inv.start), endTime: minutesToTime(inv.end) }))
  };

  return {
    status: isLegacyMapped ? 'RESOLVED_LEGACY_COMPATIBLE' : 'RESOLVED',
    isFailClosed: false,
    userId,
    date: targetDate,
    patternId: pattern.id,
    patternName: pattern.pattern_name,
    patternType: pattern.pattern_type,
    statutoryPatternCode: pattern.statutory_pattern_code || null,
    scheduleSource,
    schoolScheduleId,
    isWorkDay: true,
    dutyStatus: 'WORK_REQUIRED',
    scheduledWorkMinutes,
    schedule: finalScheduleDetail,
    effectiveIntervals: intervals,
    breakIntervals,
    breakMinutes,
    weeklyOffDays: offDays
  };
}
