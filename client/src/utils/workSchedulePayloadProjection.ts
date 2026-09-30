/**
 * Wave 3A-1: Work Schedule Payload Projection (Pure Function)
 *
 * 【責務】
 * UI / Form State を、Frozen Server Contract に厳格に合致する Canonical API Payload へ安全に投射する。
 *
 * 【不変条件 (Invariants)】
 * - INV-W3-08: patternType から scheduleSource を推測しない (No patternType Inference)。
 * - INV-W3-09: NULL / undefined / 空文字 / 未知値を別値へ暗黙補完しない (No Source Fallback)。
 * - INV-W3-10: scheduleDetailsDirty === false の場合、既存 Canonical scheduleDetails の Semantic Fact を完全保全する (Lossless Schedule Preservation)。
 * - INV-W3-11: API呼び出し、DOM、React State 更新等の副作用を持たない純粋関数とする (Pure Payload Projection)。
 * - INV-W3-12: SCHOOL_DEFAULT 選択時は古い Individual scheduleDetails を Payload から完全除去し、INDIVIDUAL 選択時は有効な日課がなければ Fail-Closed とする (Source Switch Cleanliness)。
 */

export type CanonicalScheduleSource = 'SCHOOL_DEFAULT' | 'INDIVIDUAL';

export class PayloadProjectionError extends Error {
  constructor(public errorCode: string, message: string) {
    super(message);
    this.name = 'PayloadProjectionError';
  }
}

export interface WorkTimeInterval {
  start?: number;
  end?: number;
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

export interface CommonDailyScheduleInput {
  startTime: string;
  endTime: string;
  breakIntervals?: Array<{ startTime: string; endTime: string }>;
}

export interface WorkPatternFormState {
  patternName: string;
  patternType: 'STANDARD_FULLTIME' | 'SHORT_TIME' | 'CUSTOM';
  scheduleSource: string | null | undefined;
  effectiveFrom: string;
  effectiveTo: string;
  weeklyOffDays: string | number[];
  memo?: string;
  weeklyTotalMinutes?: number;
  statutoryPatternCode?: 'CST_01' | 'CST_02' | 'CST_03' | 'CST_04' | null;
  // Lossless Round-Trip 用 Snapshot & State
  scheduleDetailsDirty?: boolean;
  originalScheduleDetails?: CanonicalScheduleDetails | null;
  workingScheduleDetails?: CanonicalScheduleDetails | null;
  commonDailySchedule?: CommonDailyScheduleInput | null;
}

export interface WorkPatternApiPayload {
  patternName: string;
  patternType: 'STANDARD_FULLTIME' | 'SHORT_TIME' | 'CUSTOM';
  scheduleSource: CanonicalScheduleSource;
  effectiveFrom: string;
  effectiveTo: string;
  weeklyOffDays: string | number[];
  memo?: string;
  weeklyTotalMinutes?: number;
  statutoryPatternCode?: 'CST_01' | 'CST_02' | 'CST_03' | 'CST_04' | null;
  scheduleDetails?: CanonicalScheduleDetails;
}

/**
 * 時刻文字列 (HH:MM) を分数 (0〜1439) に変換
 */
export function timeToMinutes(timeStr: string): number {
  const parts = timeStr.split(':').map(Number);
  if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) {
    throw new PayloadProjectionError('INVALID_TIME_FORMAT', `不正な時刻フォーマットです: ${timeStr}`);
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
 * 既存の schedule_details_json 文字列を CanonicalScheduleDetails オブジェクトに安全にパース
 */
export function parseExistingScheduleDetails(rawJson: string | null | undefined): CanonicalScheduleDetails | null {
  if (!rawJson || typeof rawJson !== 'string' || !rawJson.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(rawJson);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    return parsed as CanonicalScheduleDetails;
  } catch (err: any) {
    throw new PayloadProjectionError('CORRUPTED_SCHEDULE_DETAILS_JSON', `既存日課JSONの解析に失敗しました: ${err.message}`);
  }
}

/**
 * 既存レコードの schedule_source を厳格に検証 (Fail-Closed ガード)
 * INV-W3-09: NULL / undefined / unknown の暗黙補完を拒絶
 */
export function validateExistingRecordSource(source: any): CanonicalScheduleSource {
  if (source === 'SCHOOL_DEFAULT' || source === 'INDIVIDUAL') {
    return source;
  }
  throw new PayloadProjectionError(
    'CORRUPTED_RECORD_SOURCE',
    `既存レコードの勤務時間ソースが不正または破損しています: ${String(source)} (Fail-Closed)`
  );
}

/**
 * 共通日課入力から 7 曜日分の CanonicalScheduleDetails を生成
 */
export function buildScheduleDetailsFromCommon(
  common: CommonDailyScheduleInput,
  weeklyOffDays: string | number[]
): CanonicalScheduleDetails {
  if (!common.startTime || !common.endTime) {
    throw new PayloadProjectionError('MISSING_COMMON_TIMES', '開始時刻と終了時刻を入力してください');
  }

  const startMins = timeToMinutes(common.startTime);
  const endMins = timeToMinutes(common.endTime);
  if (endMins <= startMins) {
    throw new PayloadProjectionError('INVALID_TIME_RANGE', '終了時刻は開始時刻より後に設定してください');
  }

  const offDaysArr = Array.isArray(weeklyOffDays)
    ? weeklyOffDays.map(Number)
    : String(weeklyOffDays)
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => !isNaN(n));

  // 休憩時間帯のバリデーションと interval 生成
  const intervals: Array<{ startTime: string; endTime: string }> = [];
  const breakIntervals = common.breakIntervals || [];

  if (breakIntervals.length === 0) {
    intervals.push({ startTime: common.startTime, endTime: common.endTime });
  } else {
    // 休憩区間をソート
    const sortedBreaks = [...breakIntervals].sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
    let cur = startMins;

    for (const brk of sortedBreaks) {
      const bStart = timeToMinutes(brk.startTime);
      const bEnd = timeToMinutes(brk.endTime);

      if (bEnd <= bStart) {
        throw new PayloadProjectionError('INVALID_BREAK_RANGE', '休憩の終了時刻は開始時刻より後に設定してください');
      }
      if (bStart < startMins || bEnd > endMins) {
        throw new PayloadProjectionError('BREAK_OUTSIDE_WORK_HOURS', '休憩時間は勤務時間帯の内部に設定してください');
      }
      if (bStart < cur) {
        throw new PayloadProjectionError('OVERLAPPING_BREAKS', '休憩時間帯が重複または時系列順でありません');
      }

      if (bStart > cur) {
        intervals.push({ startTime: minutesToTime(cur), endTime: minutesToTime(bStart) });
      }
      cur = bEnd;
    }

    if (cur < endMins) {
      intervals.push({ startTime: minutesToTime(cur), endTime: minutesToTime(endMins) });
    }
  }

  const workIntervals = intervals.map((inv) => ({
    start: timeToMinutes(inv.startTime),
    end: timeToMinutes(inv.endTime),
  }));
  const dayMins = workIntervals.reduce((sum, inv) => sum + (inv.end - inv.start), 0);

  const result: CanonicalScheduleDetails = {};
  for (let d = 0; d < 7; d++) {
    const isOff = offDaysArr.includes(d);
    if (isOff) {
      result[String(d)] = {
        isWorkDay: false,
        workMinutes: 0,
        startTime: null,
        endTime: null,
        intervals: [],
        workIntervals: [],
      };
    } else {
      result[String(d)] = {
        isWorkDay: true,
        workMinutes: dayMins,
        startTime: common.startTime,
        endTime: common.endTime,
        intervals: intervals.map((i) => ({ startTime: i.startTime, endTime: i.endTime })),
        workIntervals: workIntervals.map((i) => ({ start: i.start, end: i.end })),
      };
    }
  }

  return result;
}

/**
 * UI / Form State から Canonical API Payload を生成する純粋関数 (Pure Projection Function)
 *
 * 副作用なし、推測なし、フォールバックなし。
 */
export function projectWorkPatternPayload(state: WorkPatternFormState): WorkPatternApiPayload {
  // 1. 共通必須項目の検証
  if (!state.patternName || typeof state.patternName !== 'string' || !state.patternName.trim()) {
    throw new PayloadProjectionError('MISSING_PATTERN_NAME', 'パターン名を入力してください');
  }
  if (!state.patternType || !['STANDARD_FULLTIME', 'SHORT_TIME', 'CUSTOM'].includes(state.patternType)) {
    throw new PayloadProjectionError('INVALID_PATTERN_TYPE', `無効なパターン種別です: ${state.patternType}`);
  }
  if (!state.effectiveFrom || !/^\d{4}-\d{2}-\d{2}$/.test(state.effectiveFrom)) {
    throw new PayloadProjectionError('INVALID_EFFECTIVE_FROM', '有効開始日 (YYYY-MM-DD) を正しく入力してください');
  }
  if (!state.effectiveTo || !/^\d{4}-\d{2}-\d{2}$/.test(state.effectiveTo)) {
    throw new PayloadProjectionError('INVALID_EFFECTIVE_TO', '有効終了日 (YYYY-MM-DD) を正しく入力してください');
  }
  if (state.effectiveFrom > state.effectiveTo) {
    throw new PayloadProjectionError('INVALID_DATE_RANGE', '有効終了日は有効開始日以降の日付を指定してください');
  }
  if (state.weeklyOffDays === undefined || state.weeklyOffDays === null) {
    throw new PayloadProjectionError('MISSING_WEEKLY_OFF_DAYS', '定例週休日を指定してください');
  }

  // 2. scheduleSource の厳格検証 (INV-W3-08, INV-W3-09)
  // UNSELECTED, null, undefined, '', 未知文字列は即座に Fail-Closed
  if (
    state.scheduleSource === 'UNSELECTED' ||
    state.scheduleSource === null ||
    state.scheduleSource === undefined ||
    state.scheduleSource === ''
  ) {
    throw new PayloadProjectionError(
      'MISSING_SCHEDULE_SOURCE',
      '勤務時間の適用方式（学校標準または個別日課）の明示選択は必須です (Fail-Closed)'
    );
  }

  if (state.scheduleSource !== 'SCHOOL_DEFAULT' && state.scheduleSource !== 'INDIVIDUAL') {
    throw new PayloadProjectionError(
      'INVALID_SCHEDULE_SOURCE',
      `無効な勤務日課ソースです: ${state.scheduleSource}（'SCHOOL_DEFAULT' または 'INDIVIDUAL' のみ許可されています）`
    );
  }

  const canonicalSource: CanonicalScheduleSource = state.scheduleSource;

  // 基本ペイロードオブジェクトの組み立て
  const basePayload: WorkPatternApiPayload = {
    patternName: state.patternName.trim(),
    patternType: state.patternType,
    scheduleSource: canonicalSource,
    effectiveFrom: state.effectiveFrom,
    effectiveTo: state.effectiveTo,
    weeklyOffDays: state.weeklyOffDays,
  };

  if (state.memo !== undefined) {
    basePayload.memo = state.memo;
  }
  if (state.statutoryPatternCode !== undefined) {
    basePayload.statutoryPatternCode = state.statutoryPatternCode;
  }

  // 3. scheduleSource ごとの投射処理
  if (canonicalSource === 'SCHOOL_DEFAULT') {
    // INV-W3-12 (Source Switch Cleanliness):
    // SCHOOL_DEFAULT の場合、Individual 用 scheduleDetails は Payload に含めない (omitted)
    if (state.weeklyTotalMinutes !== undefined && state.weeklyTotalMinutes !== null) {
      basePayload.weeklyTotalMinutes = state.weeklyTotalMinutes;
    }
    return basePayload;
  }

  // canonicalSource === 'INDIVIDUAL' の場合
  let finalDetails: CanonicalScheduleDetails | null = null;

  // INV-W3-10: Lossless Schedule Preservation
  // scheduleDetailsDirty === false かつ originalScheduleDetails が存在する場合は Semantic Fact を完全保持
  if (state.scheduleDetailsDirty === false && state.originalScheduleDetails) {
    // ディープコピーで原盤保持
    finalDetails = JSON.parse(JSON.stringify(state.originalScheduleDetails));
  } else if (state.workingScheduleDetails) {
    // 曜日別詳細が直接編集されている場合
    finalDetails = JSON.parse(JSON.stringify(state.workingScheduleDetails));
  } else if (state.commonDailySchedule) {
    // 共通入力から生成
    finalDetails = buildScheduleDetailsFromCommon(state.commonDailySchedule, state.weeklyOffDays);
  } else if (state.originalScheduleDetails) {
    // dirty フラグが明示されていないが原盤がある場合も原盤保持
    finalDetails = JSON.parse(JSON.stringify(state.originalScheduleDetails));
  }

  if (!finalDetails || typeof finalDetails !== 'object' || Object.keys(finalDetails).length === 0) {
    throw new PayloadProjectionError(
      'MISSING_SCHEDULE_DETAILS',
      '個別勤務パターンの登録には日課詳細（scheduleDetails）が必須です (Fail-Closed)'
    );
  }

  // 7 曜日の Canonical Structure 検証
  let calculatedWeeklyTotal = 0;
  for (let d = 0; d < 7; d++) {
    const dayKey = String(d);
    const dayData = finalDetails[dayKey];
    if (!dayData) {
      throw new PayloadProjectionError('INVALID_SCHEDULE_DETAILS', `曜日（${d}）の日課データが存在しません`);
    }

    if (dayData.isWorkDay) {
      const intervals = dayData.intervals || [];
      const workIntervals = dayData.workIntervals || [];
      if (intervals.length === 0 && workIntervals.length === 0) {
        throw new PayloadProjectionError('INVALID_SCHEDULE_INTERVALS', `勤務日（曜日=${d}）に勤務時間区間が設定されていません`);
      }

      let dayMins = dayData.workMinutes;
      if (dayMins === undefined || dayMins === null) {
        if (workIntervals.length > 0) {
          dayMins = workIntervals.reduce((sum, inv) => sum + (inv.end - inv.start), 0);
        } else {
          dayMins = intervals.reduce((sum, inv) => sum + (timeToMinutes(inv.endTime) - timeToMinutes(inv.startTime)), 0);
        }
      }
      calculatedWeeklyTotal += dayMins;
    }
  }

  basePayload.scheduleDetails = finalDetails;
  basePayload.weeklyTotalMinutes = state.weeklyTotalMinutes !== undefined ? state.weeklyTotalMinutes : calculatedWeeklyTotal;

  return basePayload;
}
