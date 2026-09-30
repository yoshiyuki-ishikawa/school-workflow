import { getDb } from '../db/database';
import { getWorkDayMinutes, minutesToLeaveUnits, LeaveSummaryItem } from './leaveCalculator';

// 1. カレンダー法的属性
export type CalendarLegalType =
  | 'REGULAR_DAY'           // 通常の平日
  | 'WEEKLY_HOLIDAY'       // 法定週休日 (土・日)
  | 'NATIONAL_HOLIDAY'     // 国民の祝日 (法改正・特例含む)
  | 'SCHOOL_HOLIDAY'       // 学校独自休日 (開校記念日等)
  | 'MUNICIPALITY_HOLIDAY'; // 自治体指定休日 (都民・県民の日等)

// 2. 勤務義務
export type DutyRequirement =
  | 'WORK_REQUIRED'        // 勤務義務あり
  | 'NO_WORK_REQUIRED';    // 勤務義務なし (週休・休日・振替等)

// 3. 実際の服務状態
export type ServiceStatus =
  | 'NORMAL_WORK'          // 通常勤務 (実出勤)
  | 'BUSINESS_TRIP'        // 出張 (旅行命令決裁済)
  | 'ANNUAL_LEAVE'         // 年次有給休暇
  | 'SICK_LEAVE'           // 病気休暇
  | 'SPECIAL_LEAVE'        // 特別休暇 (忌引・夏季・産休等)
  | 'DUTY_EXEMPT'          // 職務専念義務免除 (職免)
  | 'WEEK_OFF'             // 定例週休等による非勤務日
  | 'TRANSFER_WEEK_OFF'    // 週休振替による非勤務日
  | 'SUBSTITUTE_HOLIDAY'   // 代休による非勤務日
  | 'DESIGNATED_OFF'       // 根拠ある勤務免除日
  | 'NONE';                // 勤務義務なし日の通常状態

// 4. 帳票・公文書上の排他的日区分 (1日につき必ず1つ)
export type PrimaryDayClassification =
  | 'WORKDAY'              // 勤務日
  | 'WEEKLY_OFF'          // 週休日 (定例週休および週休振替日)
  | 'HOLIDAY'             // 休日 (国民の祝日および学校独自休日)
  | 'SUBSTITUTE_HOLIDAY'  // 代休日
  | 'OTHER_NON_WORKDAY'   // その他非勤務日
  | 'UNKNOWN_PATTERN';    // 勤務パターン未確定エラー

// 多軸属性 (上書きせず完全保持)
export interface CalendarAttributes {
  isNationalHoliday: boolean;
  holidayName?: string;
  isSchoolHoliday: boolean;
  schoolHolidayName?: string;
  isMunicipalityHoliday: boolean;
  isWeekend: boolean; // 日曜または土曜
}

export interface WorkScheduleAttributes {
  patternId?: number;
  patternName?: string;
  isScheduledWorkDay: boolean; // 割振り勤務日か
  isWeeklyOff: boolean;        // 定例週休日か (平日週休含む)
  scheduledWorkMinutes: number;// 割振り勤務分数 (通常465 / 週休0)
}

// 5. 日単位の多軸確定状態 (Server-Authoritative)
export interface FinalDailyStatus {
  day: number;
  date: string; // YYYY-MM-DD
  dayOfWeek: string; // 日, 月, 火, 水, 木, 金, 土

  // A. 多軸属性 (上書きせず完全保持)
  calendarAttributes: CalendarAttributes;
  workScheduleAttributes: WorkScheduleAttributes;

  // B. 帳票・公文書上の排他的日区分 (1日につき必ず1つ)
  primaryDayClassification: PrimaryDayClassification;

  // カレンダー上の法的属性 (祝日勤務でも NATIONAL_HOLIDAY は維持)
  calendarLegalType: CalendarLegalType;
  holidayName?: string;
  isHoliday: boolean;

  // 勤務義務
  dutyRequirement: DutyRequirement;
  isWorkRequired: boolean;
  isWorkPatternResolved: boolean; // 勤務パターンが正常に解決されたか

  // 勤務義務決定の調整根拠 (振替・例外)
  adjustment?: {
    id: number;
    adjustmentCode: string;
    adjustmentType: string;
    reasonCode: string;
    eventName: string;
    reason: string;
    authorityBasis?: string;
    sourceDate?: string;
    targetDate?: string;
    scopeType: 'ALL' | 'USER';
  };

  // 実際の服務状態
  serviceStatus: ServiceStatus;
  applicationInfo?: {
    id: number;
    typeId: string;
    typeName: string;
    title: string;
    unitType?: 'DAY' | 'TIME';
    calculatedMinutes?: number;
  };

  // 互換性フラグ (UI・レガシープロパティ)
  isWeekend: boolean;
  isWorkday: boolean; // isWorkRequired
  isWeekOff: boolean; // dutyRequirement === 'NO_WORK_REQUIRED' かつ 週休
  isSubstituteHoliday: boolean; // dutyRequirement === 'NO_WORK_REQUIRED' かつ 代休
  overrideReason?: string;
  applicationId?: number;
  applicationTitle?: string;
  applicationType?: string;
  details?: string;

  // 帳票・画面表示用プロパティ
  stampText?: string;
  stampSubText?: string;
  stampColor?: string; // 'teal' | 'slate' | 'purple' | 'rose' | 'blue' | 'indigo' | 'amber' | 'emerald'
}

// レガシー別名互換
export type AttendanceDayCell = FinalDailyStatus;

// 6. 排他的日区分カウント (Exclusive Attendance Counts)
export interface ExclusiveAttendanceCounts {
  workdayCount: number;           // WORKDAY 日数
  weeklyOffCount: number;         // WEEKLY_OFF 日数
  holidayCount: number;           // HOLIDAY 日数
  substituteHolidayCount: number; // SUBSTITUTE_HOLIDAY 日数
  otherNonWorkdayCount: number;   // OTHER_NON_WORKDAY 日数
  unknownPatternCount: number;    // UNKNOWN_PATTERN 日数
  totalDays: number;              // 月間総日数 (28〜31)
}

// 7. 内部ドメイン集計 (Domain Aggregation)
export interface DomainAttendanceSummary {
  scheduledWorkdayCount: number;  // 勤務義務日数 (dutyRequirement === 'WORK_REQUIRED')
  actualWorkedDayCount: number;   // 実勤務日数 (WORK_REQUIRED かつ serviceStatus === 'NORMAL_WORK')
  businessTripDayCount: number;   // 出張日数 (serviceStatus === 'BUSINESS_TRIP')
  annualLeaveMinutes: number;     // 年休取得総分数 (時間休+日全休)
  sickLeaveDays: number;          // 病休取得日数
  specialLeaveDays: number;       // 特休取得日数
  dutyExemptDays: number;         // 職免取得日数
  weekOffCount: number;           // 週休日数 (法定週休 + 週休振替日)
  holidayCount: number;           // 休日・学校独自休日数
  substituteHolidayCount: number; // 代休日数
  exclusiveCounts: ExclusiveAttendanceCounts; // 排他日区分集計
}

// 8. 出勤簿公文書マッピング集計 (Form Mapping)
export interface MonthlyAttendanceSummary {
  workdayCount: number;           // 実働勤務日数 (実勤務 + 出張)
  scheduledWorkdayCount: number;  // 勤務義務日数
  actualWorkedDayCount: number;   // 実勤務日数
  weekOffCount: number;           // 週休日数
  holidayCount: number;           // 休日・代休日数
  annualLeave: LeaveSummaryItem;  // 年休
  sickLeave: LeaveSummaryItem;    // 病休
  specialLeave: LeaveSummaryItem; // 特休
  dutyExempt: LeaveSummaryItem;   // 職専免
  subTotalLeave: LeaveSummaryItem;// 休暇小計
  businessTripCount: number;      // 出張回数
  businessTripDays: number;       // 出張日数
}

export interface MonthlyAttendanceData {
  userId: number;
  userName: string;
  userDepartment: string;
  yearMonth: string; // YYYY-MM
  days: FinalDailyStatus[];
  domainSummary: DomainAttendanceSummary;
  summary: MonthlyAttendanceSummary;
  hasUnknownPattern: boolean; // 勤務パターン未確定日が1日でも存在するか
  approval: {
    status: 'OPEN' | 'CONFIRMED' | 'UNLOCKED_FOR_CORRECTION';
    confirmedByUserName?: string;
    confirmedUserStampName?: string;
    confirmedAt?: string;
    comment?: string;
    unlockedReason?: string;
    unlockedAt?: string;
  };
}

/**
 * 日本の主要祝日自動算出 (固定祝日 ＋ ハッピーマンデー ＋ 春分秋分 ＋ 振替休日簡易判定)
/**
 * 国民の祝日判定 (祝日法第2条 基本祝日のみを判定)
 */
function getSystemBaseJapaneseHolidayName(dateStr: string): string | null {
  const [y, m, d] = dateStr.split('-').map(Number);
  const monthDay = `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  // 固定祝日 (第2条)
  const fixedHolidays: Record<string, string> = {
    '01-01': '元日',
    '02-11': '建国記念の日',
    '02-23': '天皇誕生日',
    '04-29': '昭和の日',
    '05-03': '憲法記念日',
    '05-04': 'みどりの日',
    '05-05': 'こどもの日',
    '08-11': '山の日',
    '11-03': '文化の日',
    '11-23': '勤労感謝の日',
  };
  if (fixedHolidays[monthDay]) return fixedHolidays[monthDay];

  // ハッピーマンデー (第2条)
  const dt = new Date(y, m - 1, d);
  const dayOfWeek = dt.getDay(); // 1 = 月曜
  const weekOfMonth = Math.ceil(d / 7);

  if (m === 1 && dayOfWeek === 1 && weekOfMonth === 2) return '成人の日';
  if (m === 7 && dayOfWeek === 1 && weekOfMonth === 3) return '海の日';
  if (m === 9 && dayOfWeek === 1 && weekOfMonth === 3) return '敬老の日';
  if (m === 10 && dayOfWeek === 1 && weekOfMonth === 2) return 'スポーツの日';

  // 春分・秋分 (天文計算)
  if (m === 3) {
    const vernalEquinoxDay = Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
    if (d === vernalEquinoxDay) return '春分の日';
  }
  if (m === 9) {
    const autumnEquinoxDay = Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
    if (d === autumnEquinoxDay) return '秋分の日';
  }

  return null;
}

/**
 * 日本の祝日・振替休日・国民の休日 完全判定 (祝日法第2条・第3条第2項・第3条第3項)
 */
export function getSystemJapaneseHolidayName(dateStr: string): string | null {
  // 1. 第2条: 基本祝日
  const baseHoliday = getSystemBaseJapaneseHolidayName(dateStr);
  if (baseHoliday) return baseHoliday;

  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const dayOfWeek = dt.getDay(); // 0 = 日曜, 1 = 月曜, ..., 6 = 土曜

  // 2. 第3条第3項: 国民の休日 (その前日及び翌日が「国民の祝日」である日、日曜・祝日を除く)
  // 例: 2026-09-22 (前日: 敬老の日、翌日: 秋分の日)
  if (dayOfWeek !== 0) {
    const prevDate = new Date(y, m - 1, d - 1);
    const nextDate = new Date(y, m - 1, d + 1);
    const prevStr = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}-${String(prevDate.getDate()).padStart(2, '0')}`;
    const nextStr = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, '0')}-${String(nextDate.getDate()).padStart(2, '0')}`;

    const prevBase = getSystemBaseJapaneseHolidayName(prevStr);
    const nextBase = getSystemBaseJapaneseHolidayName(nextStr);
    if (prevBase && nextBase) {
      return '国民の休日';
    }
  }

  // 3. 第3条第2項: 振替休日 (「国民の祝日」が日曜日に当たるときは、その日後においてその日に最も近い「国民の祝日」でない日を休日とする)
  // 例: 5月3日(日)が祝日の場合、5月6日(水)が振替休日になる連鎖対応
  if (dayOfWeek !== 0) {
    let checkDate = new Date(y, m - 1, d - 1);
    while (checkDate.getFullYear() >= y - 1) {
      const checkStr = `${checkDate.getFullYear()}-${String(checkDate.getMonth() + 1).padStart(2, '0')}-${String(checkDate.getDate()).padStart(2, '0')}`;
      const checkBase = getSystemBaseJapaneseHolidayName(checkStr);
      if (!checkBase) {
        // 連続する祝日列が途切れた（日曜日に届く前に非祝日があった）ので振替対象ではない
        break;
      }
      if (checkDate.getDay() === 0) {
        // 祝日の連続列の起点が日曜日だったため、直後の平日（本日）が振替休日となる
        return '振替休日';
      }
      checkDate = new Date(checkDate.getFullYear(), checkDate.getMonth(), checkDate.getDate() - 1);
    }
  }

  return null;
}

/**
 * 公務員の年末年始休日自動判定 (12月29日〜翌年1月3日、祝日法による元日を除く)
 * 条例・勤務時間法規に基づく公休日
 */
export function getSystemYearEndNewYearHolidayName(dateStr: string): string | null {
  const [, m, d] = dateStr.split('-').map(Number);
  // 12月29日〜12月31日
  if (m === 12 && d >= 29 && d <= 31) {
    return '年末年始の休日';
  }
  // 1月2日〜1月3日 (1月1日は国民の祝日「元日」)
  if (m === 1 && (d === 2 || d === 3)) {
    return '年末年始の休日';
  }
  return null;
}

/**
 * 祝日・学校独自休日マスタと照合して法的カレンダー属性を決定 (Layer 2)
 */
export function resolveLegalCalendarAttribute(
  dateStr: string,
  customHolidaysMap: Map<string, any>
): { legalType: CalendarLegalType; holidayName?: string; calendarAttributes: CalendarAttributes } {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const dayOfWeekIdx = dt.getDay();
  const isWeekend = dayOfWeekIdx === 0 || dayOfWeekIdx === 6;

  let isNationalHoliday = false;
  let nationalHolidayName: string | undefined = undefined;
  let isSchoolHoliday = false;
  let schoolHolidayName: string | undefined = undefined;
  let isMunicipalityHoliday = false;
  let municipalityHolidayName: string | undefined = undefined;

  // 1. カスタム祝日・学校休日マスタのチェック
  const custom = customHolidaysMap.get(dateStr);
  if (custom) {
    if ((custom.holiday_type === 'NATIONAL_LEGAL_OVERRIDE' || custom.holiday_type === 'MUNICIPALITY_HOLIDAY' || custom.holiday_type === 'SCHOOL_HOLIDAY') && custom.is_active === 0) {
      // 祝日法改正等または休日無効化指定 (平日化)
      return {
        legalType: isWeekend ? 'WEEKLY_HOLIDAY' : 'REGULAR_DAY',
        calendarAttributes: {
          isNationalHoliday: false,
          isSchoolHoliday: false,
          isMunicipalityHoliday: false,
          isWeekend,
        },
      };
    }
    if (custom.is_active === 1) {
      if (custom.holiday_type === 'SCHOOL_HOLIDAY') {
        isSchoolHoliday = true;
        schoolHolidayName = custom.name;
      } else if (custom.holiday_type === 'MUNICIPALITY_HOLIDAY') {
        isMunicipalityHoliday = true;
        municipalityHolidayName = custom.name;
      } else if (custom.holiday_type === 'NATIONAL_LEGAL_OVERRIDE') {
        isNationalHoliday = true;
        nationalHolidayName = custom.name;
      }
    }
  }

  // 2. 内蔵SYSTEM祝日判定 (国民の祝日)
  if (!isNationalHoliday && !isSchoolHoliday && !isMunicipalityHoliday) {
    const systemHolidayName = getSystemJapaneseHolidayName(dateStr);
    if (systemHolidayName) {
      isNationalHoliday = true;
      nationalHolidayName = systemHolidayName;
    }
  }

  // 3. 内蔵公務員年末年始休日判定 (12/29〜1/3)
  if (!isNationalHoliday && !isSchoolHoliday && !isMunicipalityHoliday) {
    const yearEndNewYearHoliday = getSystemYearEndNewYearHolidayName(dateStr);
    if (yearEndNewYearHoliday) {
      isMunicipalityHoliday = true;
      municipalityHolidayName = yearEndNewYearHoliday;
    }
  }

  const calendarAttributes: CalendarAttributes = {
    isNationalHoliday,
    holidayName: nationalHolidayName,
    isSchoolHoliday,
    schoolHolidayName,
    isMunicipalityHoliday,
    isWeekend,
  };

  if (isNationalHoliday) {
    return { legalType: 'NATIONAL_HOLIDAY', holidayName: nationalHolidayName, calendarAttributes };
  }
  if (isSchoolHoliday) {
    return { legalType: 'SCHOOL_HOLIDAY', holidayName: schoolHolidayName, calendarAttributes };
  }
  if (isMunicipalityHoliday) {
    return { legalType: 'MUNICIPALITY_HOLIDAY', holidayName: municipalityHolidayName || custom?.name || '年末年始の休日', calendarAttributes };
  }
  if (isWeekend) {
    return { legalType: 'WEEKLY_HOLIDAY', calendarAttributes };
  }

  return { legalType: 'REGULAR_DAY', calendarAttributes };
}

/**
 * @deprecated 互換性のためのラッパー。直接 services/attendance/attendanceEngine の AttendanceEngine.getMonthlyAttendanceData を使用してください。
 */
export function getMonthlyAttendanceData(userId: number, yearMonth: string): any {
  const { AttendanceEngine } = require('../services/attendance/attendanceEngine');
  return AttendanceEngine.getMonthlyAttendanceData(userId, yearMonth, true);
}

