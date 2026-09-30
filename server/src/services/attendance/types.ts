export interface AttendanceResolutionContext {
  userId: number;
  date: string;
  authorityId?: string;
  includeRestricted?: boolean;
}

export interface AttendanceLayerResult {
  layer: number;
  layerName: string;
  dutyStatus: 'WORK_REQUIRED' | 'NO_WORK_REQUIRED' | 'EXEMPT';
  statusCode: string;
  symbol: string;
  displayName: string;
  aggregationCategory: string;
  isWorkDay: boolean;
  scheduledMinutes: number;
  actualMinutes: number;
  deductionMinutes?: number;
  details?: any;
}

export interface AttendanceStamp {
  status: string; // CanonicalServiceStatus | string
  symbol: string; // '出' | '年' | '張' | '研' | '病' | '特' | '休' | '代休' | '週休' 等
  text: string;   // '出張' | '年休' | '研修' | '病休' | '特休' | '週休' | '代休' 等
  subText?: string; // '09:00〜12:00' | '2h' | '午前' 等
  color: 'indigo' | 'emerald' | 'teal' | 'purple' | 'blue' | 'amber' | 'rose' | 'slate';
  startTime?: string;
  endTime?: string;
  isCalendarStatus?: boolean; // 週休日・休日・代休日等のカレンダー基本属性フラグ
  sourceFactId?: string; // 発生根拠 Fact ID (トレーサビリティ)
}

export interface CanonicalDailyAttendance {
  day: number;
  date: string; // YYYY-MM-DD
  dayOfWeek: string; // '日' | '月' | '火' | '水' | '木' | '金' | '土'

  // 基礎属性
  isWorkDay: boolean;
  dutyRequirement: 'WORK_REQUIRED' | 'NO_WORK_REQUIRED';
  scheduledWorkMinutes: number; // 育短なら240分、通常なら465分、週休なら0分
  actualWorkMinutes: number;    // 控除後の実働時間
  deductionMinutes: number;     // 休暇・欠勤等による控除分数

  // 正式出勤簿マルチスタンプ（SSOT）
  stamps?: AttendanceStamp[];

  // 正式出勤簿表示（第1層: Primary Stamp 互換プロパティ）
  displaySymbol: string;        // '出' | '年' | '時年' | '病' | '特' | '育' | '休' | '停' | '欠' | '週休' | '代休' | '祝' | '不明'
  displayName: string;
  stampColor?: string;
  stampSubText?: string;

  // 内部ドメイン状態（第2層）
  primaryDayClassification: 'WORKDAY' | 'WEEKLY_OFF' | 'HOLIDAY' | 'SUBSTITUTE_HOLIDAY' | 'OTHER_NON_WORKDAY' | 'UNKNOWN_PATTERN';
  serviceStatus: string;
  aggregationCategory: string;

  // レガシー・テスト互換プロパティ
  isWorkRequired?: boolean;
  isWorkday?: boolean;
  isWeekOff?: boolean;
  isSubstituteHoliday?: boolean;
  isHoliday?: boolean;
  isWeekend?: boolean;
  holidayName?: string;
  stampText?: string;
  applicationId?: number;
  applicationTitle?: string;
  applicationInfo?: any;
  calendarAttributes?: any;
  workScheduleAttributes?: any;
  adjustment?: any;
  overrideReason?: string;
  applicationType?: string;
  details?: string;

  // 発生根拠・詳細（第3層）
  isPersonnelStatusOverridden: boolean;
  personnelStatusCode?: string;
  dailyEventCode?: string;
  hourlyEvents?: Array<{
    typeId: string;
    startTime: string;
    endTime: string;
    durationMinutes: number;
    sourceId: number;
    sourceType: 'APPLICATION' | 'ABSENCE';
  }>;
  absenceInfo?: {
    absenceId: number;
    absenceType: 'FULL_DAY' | 'HOURLY';
    status: 'DRAFT' | 'CONFIRMED' | 'CANCELLED' | 'CORRECTED';
    durationMinutes: number;
    reason?: string; // 機微情報: restricted権限時のみ保持
  };
  adjustmentInfo?: any;

  // 説明可能性・監査用
  explanations: Array<{ layer: number; ruleApplied: string; timeRange?: string }>;
}

export interface CanonicalMonthlyAttendance {
  userId: number;
  userName: string;
  userJobTitle?: string; // 職名 (例: '校長', '教諭', '主査')
  jobTitleAuthority?: 'CANONICAL_SSOT' | 'LEGACY_PROJECTION' | 'UNFINALIZED'; // 職名の出所分離 (Historical Provenance Separation)
  officialJobTitleSnapshot?: {
    jobTitleId: string;
    jobTitleCode: string;
    displayNameSnapshot: string;
    effectiveFromSnapshot: string;
    effectiveToSnapshot: string;
    snapshottedAt: string;
  };
  userDepartment: string;
  yearMonth: string; // YYYY-MM
  canonicalVersion: '2026.1';

  // 日次明細（1日〜末日）
  days: CanonicalDailyAttendance[];

  // 出勤簿 公文書マッピング集計
  summary: {
    workdayCount: number;          // 実働勤務日数 (実勤務 + 出張)
    scheduledWorkdayCount: number; // 勤務義務日数
    actualWorkedDayCount: number;  // 通常実勤務日数
    weekOffCount: number;          // 週休日数
    holidayCount: number;          // 休日・代休日数
    annualLeave: { days: number; hours: number; minutes: number; formatted: string };
    sickLeave: { days: number; hours: number; minutes: number; formatted: string };
    specialLeave: { days: number; hours: number; minutes: number; formatted: string };
    dutyExempt: { days: number; hours: number; minutes: number; formatted: string };
    careLeave: { fullDays: number; halfDays: number; hours: number; minutes: number; totalMinutes: number; formatted: string }; // 介護休暇集計
    absence: { fullDays: number; totalMinutes: number; formatted: string }; // 欠勤集計
    subTotalLeave: { days: number; hours: number; minutes: number; formatted: string };
    businessTripCount: number;
    businessTripDays: number;
  };

  // ドメイン集計
  domainSummary: {
    scheduledWorkdayCount: number;
    actualWorkedDayCount: number;
    businessTripDayCount: number;
    annualLeaveMinutes: number;
    sickLeaveDays: number;
    specialLeaveDays: number;
    dutyExemptDays: number;
    careLeaveDays: number;
    careLeaveMinutes: number;
    salaryDeductionTargetMinutes: number; // 給与減額対象総分数
    absenceDays: number;
    absenceMinutes: number;
    weekOffCount: number;
    holidayCount: number;
    substituteHolidayCount: number;
    totalScheduledMinutes: number;
    totalActualMinutes: number;
    totalDeductionMinutes: number;
    exclusiveCounts: {
      workdayCount: number;
      weeklyOffCount: number;
      holidayCount: number;
      substituteHolidayCount: number;
      otherNonWorkdayCount: number;
      unknownPatternCount: number;
      totalDays: number;
    };
  };

  // 状態フラグ・警告
  hasUnknownPattern: boolean;
  unresolvedDays: Array<{ date: string; reason: string }>;
  warnings: string[];

  // 確定状態
  approval: {
    status: 'OPEN' | 'CONFIRMED' | 'UNLOCKED_FOR_CORRECTION';
    snapshotId?: number;
    confirmedByUserName?: string;
    confirmedUserStampName?: string;
    confirmedAt?: string;
    comment?: string;
    unlockedReason?: string;
    unlockedAt?: string;
  };
}
