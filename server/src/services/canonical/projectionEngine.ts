/**
 * Canonical Attendance Projection Engine
 * Canonical Service Fact Architecture — Phase E Production Boundary
 * 
 * 責務:
 * 1. 月間出勤簿データの決定論的集約 (getMonthlyProjection)
 * 2. 帳票用公文書 DTO の生成 (getDocumentProjection)
 * 3. 月次確定保存用 Snapshot DTO の生成 (getSnapshotProjection)
 * 4. 閲覧権限マスキング (VisibilityProjection: HD-PE-02)
 * 5. 公文書様式・テンプレート解決 (DocumentProjection: HD-PE-03)
 */

import crypto from "crypto";
import { getDb } from "../../db/database";
import { ProductionFactReader } from "./shadow/productionFactReader";
import { CanonicalAttendanceEvaluator } from "./evaluator";
import { CanonicalDailyAttendance, CanonicalMonthlyAttendance } from "../attendance/types";
import { resolveAuthoritativeWorkSchedule } from "../attendance/workPatternResolver";
import { getSystemJapaneseHolidayName, getSystemYearEndNewYearHolidayName } from "../../utils/attendanceEngine";
import { minutesToLeaveUnits } from "../../utils/leaveCalculator";
import { AttendanceDomainResult, CanonicalServiceFact } from "./types";
import { OfficialJobTitleResolver } from "../../domain/jobTitle/officialJobTitleResolver";

export interface ProjectionOptions {
  includeRestricted?: boolean;
}


export interface DocumentProjectionResult {
  template: any;
  user: any;
  yearMonth: string;
  attendanceData: CanonicalMonthlyAttendance;
  monthlyApproval: any;
  organizationSettings: any;
}

export interface SnapshotProjectionResult {
  userId: number;
  yearMonth: string;
  hasUnknownPattern: boolean;
  unresolvedDays: Array<{ date: string; reason: string }>;
  days: CanonicalDailyAttendance[];
  summaryJson: string;
  checksum: string;
}

function resolveOrganizationSettings(db: any, snapshotJson?: string | null): any {
  if (snapshotJson) {
    try {
      return JSON.parse(snapshotJson);
    } catch {}
  }
  try {
    const current = db.prepare("SELECT * FROM system_settings WHERE id = 1").get() as any;
    if (current) {
      return {
        schoolName: current.school_name,
        municipalityName: current.municipality_name,
        boardOfEducationName: current.board_of_education_name,
        appTitle: current.app_title,
        version: current.version,
      };
    }
  } catch {}
  return {
    schoolName: "公立小学校",
    municipalityName: "〇〇市",
    boardOfEducationName: "〇〇市教育委員会",
    appTitle: "学校業務ワークフローシステム",
    version: 1,
  };
}

/**
 * 正式職名の動的解決 (PO FINAL DECISION: HD-JT-01 CLOSED)
 * 出勤簿ヘッダー職名は、対象年月の末日時点で有効な正式職名を official_job_titles / user_job_titles から解決。
 * 未設定時は '（職名未設定）' を返却（下書き・プレビュー用）。'教諭'等の暗黙フォールバックは完全排除。
 */
function resolveUserJobTitle(db: any, userId: number, yearMonth: string): string {
  try {
    const [y, m] = yearMonth.split("-").map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const endOfMonth = `${yearMonth}-${String(lastDay).padStart(2, "0")}`;

    const resolved = OfficialJobTitleResolver.resolveAtDate(db, userId, endOfMonth, { strict: false });
    return resolved.displayName;
  } catch {
    return "（職名未設定）";
  }
}

/**
 * 単一FactからStampへの射影マッピング
 */
function mapFactToStamp(f: CanonicalServiceFact): {
  status: string;
  symbol: string;
  text: string;
  subText?: string;
  color: 'indigo' | 'emerald' | 'teal' | 'purple' | 'blue' | 'amber' | 'rose' | 'slate';
  startTime?: string;
  endTime?: string;
  isCalendarStatus: boolean;
  sourceFactId: string;
} {
  const status = String(f.canonicalStatus);
  let symbol = "出";
  let text = "出勤";
  let subText: string | undefined = undefined;
  let color: 'indigo' | 'emerald' | 'teal' | 'purple' | 'blue' | 'amber' | 'rose' | 'slate' = "teal";
  let isCalendarStatus = false;

  switch (f.canonicalStatus) {
    case "OFFICIAL_BUSINESS_TRIP":
      symbol = "張";
      text = "出張";
      color = "indigo";
      if (f.factType === "TIME_EVENT" && f.startTime && f.endTime) {
        subText = `${f.startTime}-${f.endTime}`;
      }
      break;
    case "TRAINING":
      symbol = "研";
      text = "研修";
      color = "teal";
      if (f.factType === "TIME_EVENT" && f.startTime && f.endTime) {
        subText = `${f.startTime}-${f.endTime}`;
      }
      break;
    case "ANNUAL_LEAVE":
      symbol = "年";
      text = "年休";
      color = "blue";
      if (f.factType === "TIME_EVENT" && f.quantityUnits) {
        subText = `${Math.floor(f.quantityUnits / 60)}h`;
      }
      break;
    case "SICK_LEAVE":
      symbol = "病";
      text = "病休";
      color = "rose";
      break;
    case "SPECIAL_MATERNITY_LEAVE":
      symbol = "産休";
      text = "産休";
      color = "amber";
      break;
    case "SPECIAL_LEAVE_GENERAL":
      symbol = "特";
      text = "特休";
      color = "amber";
      break;
    case "DUTY_EXEMPTION":
      symbol = "免";
      text = "職免";
      color = "emerald";
      break;
    case "CARE_LEAVE":
      symbol = "介護";
      text = "介護";
      color = "purple";
      break;
    case "CARE_TIME":
      symbol = "介時";
      text = "介時";
      color = "purple";
      if (f.quantityUnits) {
        subText = `${Math.floor(f.quantityUnits / 60)}h${f.quantityUnits % 60 > 0 ? (f.quantityUnits % 60) + "m" : ""}`;
      }
      break;
    case "CHILDCARE_PARTIAL_LEAVE":
    case "CHILDCARE_SUPPORT_PARTIAL_LEAVE":
    case "STUDY_PARTIAL_LEAVE":
      symbol = "部";
      text = "部休";
      color = "amber";
      if (f.quantityUnits) {
        subText = `${Math.floor(f.quantityUnits / 60)}h`;
      }
      break;
    case "ABSENCE":
      symbol = "欠";
      text = "欠";
      subText = f.factType === "TIME_EVENT" ? `${Math.floor((f.quantityUnits || 60) / 60)}h欠` : "全日欠勤";
      color = "rose";
      break;
    case "SUBSTITUTE_HOLIDAY":
      symbol = "代休";
      text = "代休";
      color = "purple";
      isCalendarStatus = true;
      break;
    case "HOLIDAY":
      symbol = "祝";
      text = "祝日";
      color = "rose";
      isCalendarStatus = true;
      break;
    case "WEEKLY_OFF":
      symbol = "休";
      text = "週休";
      color = "slate";
      isCalendarStatus = true;
      break;
    case "DISCIPLINARY_SUSPENSION":
      symbol = "停";
      text = "停職";
      color = "purple";
      break;
    case "UNION_FULL_TIME_SUSPENSION":
      symbol = "専";
      text = "専従";
      color = "purple";
      break;
    case "ADMINISTRATIVE_LEAVE_SUSPENSION":
      symbol = "休";
      text = "休職";
      color = "purple";
      break;
    case "CHILDCARE_LEAVE":
      symbol = "育休";
      text = "育休";
      color = "purple";
      break;
    case "SELF_DEVELOPMENT_LEAVE":
      symbol = "自啓";
      text = "自啓";
      color = "purple";
      break;
    case "SPOUSAL_ACCOMPANIMENT_LEAVE":
      symbol = "配同";
      text = "配同";
      color = "purple";
      break;
    case "DISPATCH":
    case "FOREIGN_DISPATCH":
      symbol = "派遣";
      text = "派遣";
      color = "purple";
      break;
    default:
      symbol = "出";
      text = "出勤";
      color = "teal";
      break;
  }

  return {
    status,
    symbol,
    text,
    subText,
    color,
    startTime: f.startTime,
    endTime: f.endTime,
    isCalendarStatus,
    sourceFactId: f.factId
  };
}

/**
 * 優先順位カテゴリ数値 (小さいほど高優先度)
 */
function getCategoryPriority(status: string, isCalendarStatus: boolean): number {
  if (status === "OFFICIAL_BUSINESS_TRIP" || status === "TRAINING") return 10;
  if (status === "ANNUAL_LEAVE" || status === "SICK_LEAVE" || status === "SPECIAL_MATERNITY_LEAVE" ||
      status === "SPECIAL_LEAVE_GENERAL" || status === "DUTY_EXEMPTION" || status === "CARE_LEAVE" ||
      status === "CARE_TIME" || status === "CHILDCARE_PARTIAL_LEAVE" || status === "CHILDCARE_SUPPORT_PARTIAL_LEAVE" ||
      status === "STUDY_PARTIAL_LEAVE") return 20;
  if (status === "ABSENCE") return 30;
  if (!isCalendarStatus && (status === "DISCIPLINARY_SUSPENSION" || status === "UNION_FULL_TIME_SUSPENSION" ||
      status === "ADMINISTRATIVE_LEAVE_SUSPENSION" || status === "CHILDCARE_LEAVE" ||
      status === "SELF_DEVELOPMENT_LEAVE" || status === "SPOUSAL_ACCOMPANIMENT_LEAVE" ||
      status === "DISPATCH" || status === "FOREIGN_DISPATCH")) return 40;
  if (isCalendarStatus) return 50;
  return 60;
}

/**
 * 同一日複数服務の DTO Contract (stamps: AttendanceStamp[]) 構築
 */
function buildDayStamps(
  dayFacts: CanonicalServiceFact[],
  domainResult: AttendanceDomainResult,
  fallback: { symbol: string; text?: string; subText?: string; color: 'indigo' | 'emerald' | 'teal' | 'purple' | 'blue' | 'amber' | 'rose' | 'slate'; serviceStatus: string }
): import("../attendance/types").AttendanceStamp[] {
  if (!dayFacts || dayFacts.length === 0) {
    if (fallback.text) {
      return [{
        status: fallback.serviceStatus,
        symbol: fallback.symbol,
        text: fallback.text,
        subText: fallback.subText,
        color: fallback.color,
        isCalendarStatus: domainResult.dutyStatus === "NO_WORK_REQUIRED",
        sourceFactId: "fallback"
      }];
    }
    return [];
  }

  const rawStamps = dayFacts.map(f => mapFactToStamp(f));

  // 決定論的ソート
  // 1. startTime 昇順 (時間指定イベント優先)
  // 2. カテゴリ優先度 (出張/研修(10) < 休暇/職免(20) < 欠勤(30) < 身分(40) < カレンダー(50))
  // 3. sourceFactId 辞書順
  rawStamps.sort((a, b) => {
    if (a.startTime && b.startTime) {
      const cmp = a.startTime.localeCompare(b.startTime);
      if (cmp !== 0) return cmp;
    } else if (a.startTime && !b.startTime) {
      return -1;
    } else if (!a.startTime && b.startTime) {
      return 1;
    }

    const prioA = getCategoryPriority(a.status, a.isCalendarStatus);
    const prioB = getCategoryPriority(b.status, b.isCalendarStatus);
    if (prioA !== prioB) return prioA - prioB;

    return a.sourceFactId.localeCompare(b.sourceFactId);
  });

  return rawStamps;
}

export class CanonicalAttendanceProjectionEngine {
  /**
   * 1. 月間出勤簿 Projection の決定論的生成
   */
  static getMonthlyProjection(
    userId: number,
    yearMonth: string,
    options: ProjectionOptions = {}
  ): CanonicalMonthlyAttendance {
    const db = getDb();
    const includeRestricted = options.includeRestricted ?? false;

    // 1. LOCKED Snapshot の確認 (INV-CUT-09: 確定済み月は Immutable Snapshot を Single Source of Truth として返却)
    const lockedSnapshot = db.prepare(`
      SELECT * FROM monthly_attendance_snapshots
      WHERE user_id = ? AND year_month = ? AND status != 'SUPERSEDED'
      ORDER BY version DESC LIMIT 1
    `).get(userId, yearMonth) as any;

    const approvalRecord = db.prepare(`
      SELECT * FROM monthly_attendance_approvals
      WHERE user_id = ? AND year_month = ?
    `).get(userId, yearMonth) as any;

    if (lockedSnapshot && lockedSnapshot.status === "LOCKED" && (!approvalRecord || approvalRecord.status === "CONFIRMED")) {
      const snapshotDays = db.prepare(`
        SELECT * FROM monthly_attendance_snapshot_days
        WHERE snapshot_id = ?
        ORDER BY date ASC
      `).all(lockedSnapshot.id) as any[];

      const parsedSummary = JSON.parse(lockedSnapshot.monthly_summary_json || "{}");
      const restoredDays: CanonicalDailyAttendance[] = snapshotDays.map(sd => {
        let parsedResolution: any = {};
        try {
          parsedResolution = JSON.parse(sd.resolution_json || "{}");
        } catch {}

        // VisibilityProjection: センシティブ情報のマスキング (HD-PE-02)
        if (!includeRestricted && parsedResolution.absenceInfo?.reason) {
          parsedResolution.absenceInfo.reason = "非公開";
        }

        const fallbackStamp: import("../attendance/types").AttendanceStamp = {
          status: sd.display_name || "UNKNOWN",
          symbol: sd.display_symbol,
          text: sd.display_name,
          color: "teal",
          isCalendarStatus: sd.is_required_work_day !== 1,
          sourceFactId: "snapshot"
        };

        return {
          ...parsedResolution,
          day: parseInt(sd.date.split("-")[2], 10),
          date: sd.date,
          displaySymbol: sd.display_symbol,
          displayName: sd.display_name,
          scheduledWorkMinutes: sd.scheduled_work_minutes,
          actualWorkMinutes: sd.actual_work_minutes,
          isWorkDay: sd.is_required_work_day === 1,
          stamps: parsedResolution.stamps && parsedResolution.stamps.length > 0 ? parsedResolution.stamps : (sd.display_symbol ? [fallbackStamp] : [])
        };
      });

      const user = db.prepare("SELECT id, display_name, department FROM users WHERE id = ?").get(userId) as any;
      const officialSnapshot = parsedSummary.officialJobTitleSnapshot;
      const userJobTitle = officialSnapshot?.displayNameSnapshot || parsedSummary.userJobTitle || resolveUserJobTitle(db, userId, yearMonth);
      const jobTitleAuthority = officialSnapshot?.displayNameSnapshot ? 'CANONICAL_SSOT' : (parsedSummary.userJobTitle ? 'LEGACY_PROJECTION' : 'UNFINALIZED');

      return {
        userId,
        userName: user?.display_name || "",
        userDepartment: user?.department || "",
        userJobTitle,
        jobTitleAuthority,
        officialJobTitleSnapshot: officialSnapshot || null,
        yearMonth,

        canonicalVersion: '2026.1',
        days: restoredDays,
        summary: parsedSummary.formSummary || parsedSummary.summary || {},
        domainSummary: parsedSummary.domainSummary || {},
        approval: {
          status: approvalRecord ? approvalRecord.status : 'OPEN',
          snapshotId: approvalRecord?.snapshot_id || lockedSnapshot.id,
          confirmedByUserName: approvalRecord ? (approvalRecord.confirmed_user_display_name || approvalRecord.confirmed_user_name) : undefined,
          confirmedUserStampName: approvalRecord ? approvalRecord.confirmed_user_stamp_name : undefined,
          confirmedAt: approvalRecord ? approvalRecord.confirmed_at : undefined,
          comment: approvalRecord ? approvalRecord.comment : undefined,
          unlockedReason: approvalRecord ? approvalRecord.unlocked_reason : undefined,
          unlockedAt: approvalRecord ? approvalRecord.unlocked_at : undefined,
        },
        hasUnknownPattern: false,
        unresolvedDays: [],
        warnings: []
      };
    }

    // 2. UNLOCKED Month: SSOT から Canonical Fact を抽出し Evaluator 経由で Projection 生成
    const [y, m] = yearMonth.split("-").map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const extracted = ProductionFactReader.extractMonthlyFacts(db, userId, yearMonth);
    const factsByDate: Record<string, CanonicalServiceFact[]> = {};

    for (const f of extracted.facts) {
      if (!factsByDate[f.targetDate]) {
        factsByDate[f.targetDate] = [];
      }
      factsByDate[f.targetDate].push(f);
    }

    const days: CanonicalDailyAttendance[] = [];
    let hasUnknownPattern = false;
    const unresolvedDays: Array<{ date: string; reason: string }> = [];
    const warnings: string[] = [];

    // 集計用カウンタ
    let scheduledWorkdayCount = 0;
    let actualWorkedDayCount = 0;
    let businessTripDayCount = 0;
    let absenceFullDays = 0;
    let absenceHourlyMinutes = 0;
    let sickLeaveDays = 0;
    let specialLeaveDays = 0;
    let dutyExemptDays = 0;
    let careLeaveFullDays = 0;
    let careLeaveHalfDays = 0;
    let careLeaveHourlyMinutes = 0;
    let careLeaveTotalMinutes = 0;
    let annualLeaveMinutes = 0;
    let totalScheduledMinutes = 0;
    let totalActualMinutes = 0;
    let totalDeductionMinutes = 0;

    let exWorkdayCount = 0;
    let exWeeklyOffCount = 0;
    let exHolidayCount = 0;
    let exSubstituteHolidayCount = 0;
    let exOtherNonWorkdayCount = 0;
    let exUnknownPatternCount = 0;

    let workDayMinutes = 465;

    for (let day = 1; day <= daysInMonth; day++) {
      const targetDate = `${yearMonth}-${String(day).padStart(2, "0")}`;
      const dt = new Date(targetDate);
      const dayOfWeek = ["日", "月", "火", "水", "木", "金", "土"][dt.getDay()];
      const dayFacts = factsByDate[targetDate] || [];

      // 勤務パターン解決
      const workSchedule = resolveAuthoritativeWorkSchedule(userId, targetDate);
      let isUnknown = false;
      if (workSchedule.isFailClosed) {
        isUnknown = true;
        hasUnknownPattern = true;
        exUnknownPatternCount++;
        unresolvedDays.push({ date: targetDate, reason: workSchedule.failReason || "勤務パターン未設定" });
      }

      if (workSchedule.patternType === "STANDARD_FULLTIME" && (workSchedule.scheduledWorkMinutes || 0) > 0) {
        workDayMinutes = workSchedule.scheduledWorkMinutes || 465;
      }

      const domainResult: AttendanceDomainResult = CanonicalAttendanceEvaluator.evaluateDay(
        {
          userId,
          date: targetDate,
          scheduledWorkMinutes: workSchedule.scheduledWorkMinutes,
          isWorkDay: workSchedule.isWorkDay,
        },
        dayFacts
      );

      // Presentation & UI Attribute Resolution
      const primaryStatus = domainResult.primaryCanonicalStatus;
      let symbol = "出";
      let name = workSchedule.patternType === "SHORT_TIME" ? "育短勤務" : "通常勤務";
      let classification: CanonicalDailyAttendance["primaryDayClassification"] = "WORKDAY";
      let stampColor: 'indigo' | 'emerald' | 'teal' | 'purple' | 'blue' | 'amber' | 'rose' | 'slate' = "teal";
      let stampText: string | undefined = undefined;
      let stampSubText: string | undefined = undefined;
      let serviceStatus = "NORMAL_WORK";

      if (isUnknown) {
        symbol = "未";
        name = "ポリシー未設定";
        classification = "UNKNOWN_PATTERN";
        serviceStatus = "UNKNOWN_PATTERN";
        stampColor = "slate";
        stampText = "未定";
      } else if (domainResult.dutyStatus === "NO_WORK_REQUIRED" && domainResult.appliedConflictAction !== "COEXIST_AND_ACCUMULATE") {
        if (primaryStatus === "SUBSTITUTE_HOLIDAY") {
          symbol = "代休";
          name = "休日の代休日";
          classification = "SUBSTITUTE_HOLIDAY";
          serviceStatus = "SUBSTITUTE_HOLIDAY";
          stampColor = "purple";
          stampText = "代休";
        } else if (primaryStatus === "HOLIDAY") {
          symbol = "祝";
          name = "国民の祝日・学校休日";
          classification = "HOLIDAY";
          serviceStatus = "HOLIDAY";
          stampColor = "rose";
          stampText = "祝日";
        } else if (primaryStatus === "WEEKLY_OFF") {
          symbol = "休";
          name = "定例週休日";
          classification = "WEEKLY_OFF";
          serviceStatus = "WEEKLY_OFF";
          stampColor = "slate";
          stampText = "週休";
        } else {
          // 身分状態 (OVERRIDE_ALL)
          classification = "OTHER_NON_WORKDAY";
          serviceStatus = primaryStatus;
          stampColor = "purple";
          if (primaryStatus === "DISCIPLINARY_SUSPENSION") {
            symbol = "停";
            name = "停職";
            stampText = "停職";
          } else if (primaryStatus === "UNION_FULL_TIME_SUSPENSION") {
            symbol = "専";
            name = "専従休職";
            stampText = "専従";
          } else if (primaryStatus === "ADMINISTRATIVE_LEAVE_SUSPENSION") {
            symbol = "休";
            name = "分限休職";
            stampText = "休職";
          } else if (primaryStatus === "CHILDCARE_LEAVE") {
            symbol = "育休";
            name = "育児休業";
            stampText = "育休";
          } else if (primaryStatus === "SELF_DEVELOPMENT_LEAVE") {
            symbol = "自啓";
            name = "自己啓発等休業";
            stampText = "自啓";
          } else if (primaryStatus === "SPOUSAL_ACCOMPANIMENT_LEAVE") {
            symbol = "配同";
            name = "配偶者同行休業";
            stampText = "配同";
          } else if (primaryStatus === "DISPATCH" || primaryStatus === "FOREIGN_DISPATCH") {
            symbol = "派遣";
            name = "派遣";
            stampText = "派遣";
          }
        }
      } else {
        // 勤務義務日または実働算入日
        if (primaryStatus === "OFFICIAL_BUSINESS_TRIP") {
          symbol = "張";
          name = "公務旅行";
          serviceStatus = "BUSINESS_TRIP";
          stampColor = "indigo";
          stampText = "出張";
        } else if (primaryStatus === "TRAINING") {
          symbol = "研";
          name = "研修";
          serviceStatus = "TRAINING";
          stampColor = "teal";
          stampText = "研修";
        } else if (primaryStatus === "ABSENCE") {
          symbol = "欠";
          name = "全日欠勤";
          serviceStatus = "ABSENCE_FULL_DAY";
          stampColor = "rose";
          stampText = "欠";
          stampSubText = "全日欠勤";
        } else if (primaryStatus === "ANNUAL_LEAVE") {
          if (domainResult.appliedConflictAction === "COEXIST_AND_DEDUCT") {
            symbol = "年";
            name = "時間単位年休";
            serviceStatus = "WORKED_WITH_PARTIAL_LEAVE";
            stampColor = "blue";
            stampText = "年休";
            stampSubText = `${Math.floor(domainResult.deductionMinutes / 60)}h`;
          } else {
            symbol = "年";
            name = "年次有給休暇";
            serviceStatus = "LEAVE_ANNUAL";
            stampColor = "blue";
            stampText = "年休";
          }
        } else if (primaryStatus === "SICK_LEAVE") {
          symbol = "病";
          name = "病気休暇";
          serviceStatus = "LEAVE_SICK";
          stampColor = "rose";
          stampText = "病休";
        } else if (primaryStatus === "SPECIAL_MATERNITY_LEAVE") {
          symbol = "産休";
          name = "産前産後特別休暇";
          serviceStatus = "LEAVE_SPECIAL";
          stampColor = "amber";
          stampText = "産休";
        } else if (primaryStatus === "SPECIAL_LEAVE_GENERAL") {
          symbol = "特";
          name = "特別休暇";
          serviceStatus = "LEAVE_SPECIAL";
          stampColor = "amber";
          stampText = "特休";
        } else if (primaryStatus === "DUTY_EXEMPTION") {
          symbol = "免";
          name = "職務専念義務免除";
          serviceStatus = "LEAVE_DUTY_EXEMPT";
          stampColor = "emerald";
          stampText = "職免";
        } else if (primaryStatus === "CARE_LEAVE") {
          symbol = "介護";
          name = "介護休暇";
          serviceStatus = "LEAVE_CARE";
          stampColor = "purple";
          stampText = "介護";
        } else if (primaryStatus === "CARE_TIME") {
          symbol = "介時";
          name = "介護時間";
          serviceStatus = "WORKED_WITH_PARTIAL_LEAVE";
          stampColor = "purple";
          stampText = "介時";
          stampSubText = `${Math.floor(domainResult.deductionMinutes / 60)}h${domainResult.deductionMinutes % 60 > 0 ? (domainResult.deductionMinutes % 60) + "m" : ""}`;
        } else if (primaryStatus === "CHILDCARE_PARTIAL_LEAVE" || primaryStatus === "CHILDCARE_SUPPORT_PARTIAL_LEAVE" || primaryStatus === "STUDY_PARTIAL_LEAVE") {
          symbol = "部";
          name = "部分休業";
          serviceStatus = "WORKED_WITH_PARTIAL_LEAVE";
          stampColor = "amber";
          stampText = "部休";
          stampSubText = `${Math.floor(domainResult.deductionMinutes / 60)}h`;
        } else {
          symbol = "出";
          name = workSchedule.patternType === "SHORT_TIME" ? "育短勤務" : "通常勤務";
          classification = "WORKDAY";
          serviceStatus = "NORMAL_WORK";
          stampColor = "teal";
        }
      }

      // 欠勤情報の抽出
      const absFact = dayFacts.find(f => f.canonicalStatus === "ABSENCE");
      let absenceInfo: any = undefined;
      if (absFact) {
        absenceInfo = {
          absenceId: Number(absFact.sourceId),
          absenceType: absFact.factType === "TIME_EVENT" ? "HOURLY" : "FULL_DAY",
          status: "CONFIRMED",
          durationMinutes: absFact.quantityUnits || domainResult.deductionMinutes,
          reason: includeRestricted ? absFact.details?.reason : "非公開", // Visibility Masking (HD-PE-02)
        };
      }

      // 時間単位イベント一覧の生成
      const timeFacts = dayFacts.filter(f => f.factType === "TIME_EVENT");
      const hourlyEvents = timeFacts.map(tf => ({
        typeId: String(tf.canonicalStatus),
        startTime: tf.startTime || "00:00",
        endTime: tf.endTime || "00:00",
        durationMinutes: tf.quantityUnits || 60,
        sourceId: Number(tf.sourceId),
        sourceType: (tf.sourceType === "ADMIN_REGISTRATION" ? "ABSENCE" : "APPLICATION") as "APPLICATION" | "ABSENCE"
      }));

      // ApplicationInfo
      const appFact = dayFacts.find(f => f.sourceType === "INTERNAL_APPLICATION");
      let applicationInfo: any = undefined;
      if (appFact) {
        applicationInfo = {
          id: appFact.sourceId,
          typeId: appFact.details?.typeId || appFact.canonicalStatus,
          typeName: name,
          title: appFact.details?.reason || name,
          unitType: appFact.details?.unitType || (appFact.factType === "TIME_EVENT" ? "TIME" : "DAY"),
          calculatedMinutes: domainResult.deductionMinutes || domainResult.scheduledWorkMinutes,
        };
      }

      const stamps = buildDayStamps(dayFacts, domainResult, {
        symbol,
        text: stampText,
        subText: stampSubText,
        color: stampColor,
        serviceStatus
      });

      const dailyDto: CanonicalDailyAttendance = {
        day,
        date: targetDate,
        dayOfWeek,
        isWorkDay: domainResult.isScheduledWorkDay,
        isWorkRequired: domainResult.dutyStatus === "WORK_REQUIRED",
        dutyRequirement: (domainResult.dutyStatus === "WORK_REQUIRED" ? "WORK_REQUIRED" : "NO_WORK_REQUIRED") as "WORK_REQUIRED" | "NO_WORK_REQUIRED",
        scheduledWorkMinutes: domainResult.scheduledWorkMinutes,
        actualWorkMinutes: domainResult.effectiveWorkMinutes,
        deductionMinutes: domainResult.deductionMinutes,
        displaySymbol: symbol,
        displayName: name,
        stampColor,
        stampText,
        stampSubText,
        stamps,
        primaryDayClassification: classification,
        serviceStatus,
        aggregationCategory: domainResult.aggregationCategory,
        isPersonnelStatusOverridden: domainResult.isPersonnelStatusOverridden,
        dailyEventCode: applicationInfo?.typeId || (serviceStatus.startsWith("LEAVE_") || serviceStatus === "BUSINESS_TRIP" || serviceStatus === "TRAINING" ? serviceStatus : undefined),
        applicationId: applicationInfo?.id,
        applicationTitle: applicationInfo?.title,
        absenceInfo,
        applicationInfo,
        hourlyEvents: hourlyEvents.length > 0 ? hourlyEvents : undefined,
        isWorkday: domainResult.isScheduledWorkDay,
        explanations: domainResult.explanations
      };

      days.push(dailyDto);

      totalScheduledMinutes += dailyDto.scheduledWorkMinutes;
      totalActualMinutes += dailyDto.actualWorkMinutes;
      totalDeductionMinutes += dailyDto.deductionMinutes;

      // 集計
      if (classification === "WORKDAY") exWorkdayCount++;
      else if (classification === "WEEKLY_OFF") exWeeklyOffCount++;
      else if (classification === "HOLIDAY") exHolidayCount++;
      else if (classification === "SUBSTITUTE_HOLIDAY") exSubstituteHolidayCount++;
      else if (classification === "OTHER_NON_WORKDAY") exOtherNonWorkdayCount++;

      if (domainResult.dutyStatus === "WORK_REQUIRED") {
        scheduledWorkdayCount++;
        if (serviceStatus === "BUSINESS_TRIP" || primaryStatus === "OFFICIAL_BUSINESS_TRIP") {
          businessTripDayCount++;
        } else if (serviceStatus === "ABSENCE_FULL_DAY") {
          absenceFullDays++;
        } else if (serviceStatus === "LEAVE_SICK") {
          sickLeaveDays++;
        } else if (serviceStatus === "LEAVE_SPECIAL") {
          specialLeaveDays++;
        } else if (serviceStatus === "LEAVE_DUTY_EXEMPT") {
          dutyExemptDays++;
        } else if (serviceStatus === "LEAVE_CARE") {
          if (applicationInfo?.unitType === "HALF_DAY") {
            careLeaveHalfDays++;
            careLeaveTotalMinutes += domainResult.deductionMinutes;
          } else {
            careLeaveFullDays++;
            careLeaveTotalMinutes += (domainResult.deductionMinutes || domainResult.scheduledWorkMinutes);
          }
        } else if (serviceStatus === "LEAVE_ANNUAL") {
          annualLeaveMinutes += (domainResult.deductionMinutes || domainResult.scheduledWorkMinutes);
        } else {
          if (domainResult.effectiveWorkMinutes > 0) {
            actualWorkedDayCount++;
          }
        }

        if (hourlyEvents.length > 0) {
          for (const he of hourlyEvents) {
            const tId = String(he.typeId);
            if (tId === "ANNUAL_LEAVE" || tId === "LEAVE_ANNUAL") {
              annualLeaveMinutes += he.durationMinutes;
            } else if (tId === "CARE_LEAVE" || tId === "LEAVE_CARE" || tId === "CARE_TIME" || tId === "LEAVE_CARE_TIME") {
              careLeaveHourlyMinutes += he.durationMinutes;
              careLeaveTotalMinutes += he.durationMinutes;
            } else if (he.sourceType === "ABSENCE") {
              absenceHourlyMinutes += he.durationMinutes;
            }
          }
        }
      }
    }

    if (hasUnknownPattern) {
      warnings.push(`当月に勤務パターン未設定日が ${exUnknownPatternCount} 日存在します。管理設定で勤務パターンを割り当ててください。`);
    }

    // 公文書集計 DTO
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
      businessTripCount: businessTripDayCount,
      businessTripDays: businessTripDayCount
    };

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

    const user = db.prepare("SELECT id, display_name, department FROM users WHERE id = ?").get(userId) as any;
    const userJobTitle = resolveUserJobTitle(db, userId, yearMonth);

    return {
      userId,
      userName: user?.display_name || "",
      userDepartment: user?.department || "",
      userJobTitle,
      yearMonth,
      canonicalVersion: '2026.1',
      days,
      summary,
      domainSummary,
      approval: {
        status: approvalRecord ? approvalRecord.status : 'OPEN',
        snapshotId: approvalRecord?.snapshot_id,
        confirmedByUserName: approvalRecord ? (approvalRecord.confirmed_user_display_name || approvalRecord.confirmed_user_name) : undefined,
        confirmedUserStampName: approvalRecord ? approvalRecord.confirmed_user_stamp_name : undefined,
        confirmedAt: approvalRecord ? approvalRecord.confirmed_at : undefined,
        comment: approvalRecord ? approvalRecord.comment : undefined,
        unlockedReason: approvalRecord ? approvalRecord.unlocked_reason : undefined,
        unlockedAt: approvalRecord ? approvalRecord.unlocked_at : undefined,
      },
      hasUnknownPattern,
      unresolvedDays,
      warnings
    };
  }

  /**
   * 2. 帳票用公文書 DTO の生成 (DocumentProjection: HD-PE-03)
   */
  static getDocumentProjection(userId: number, yearMonth: string): DocumentProjectionResult {
    const db = getDb();
    const user = db.prepare("SELECT id, username, display_name, stamp_name, department FROM users WHERE id = ?").get(userId) as any;
    if (!user) {
      throw new Error("対象の教職員が見つかりません");
    }

    // PDF 公文書用には機微な欠勤理由はマスキング (includeRestricted = false: HD-PE-02)
    const attendanceData = this.getMonthlyProjection(userId, yearMonth, { includeRestricted: false });
    const template = db.prepare("SELECT * FROM official_form_templates WHERE form_code = 'ATTENDANCE_BOOK'").get() as any;
    const organizationSettings = resolveOrganizationSettings(db, null);

    return {
      template: template ? { ...template, template_definition: JSON.parse(template.template_definition || "{}") } : null,
      user,
      yearMonth,
      attendanceData,
      monthlyApproval: attendanceData.approval,
      organizationSettings,
    };
  }

  /**
   * 3. 月次確定保存用 Snapshot DTO の生成 (SnapshotProjection)
   */
  static getSnapshotProjection(userId: number, yearMonth: string): SnapshotProjectionResult {
    const db = getDb();

    // PO Decision (HD-JT-01 CLOSED): 月末在籍基準で職名を厳格解決 (Fail-Closed: INV-JT-12)
    const [y, m] = yearMonth.split("-").map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const endOfMonth = `${yearMonth}-${String(lastDay).padStart(2, "0")}`;
    const resolvedJobTitle = OfficialJobTitleResolver.resolveAtDate(db, userId, endOfMonth, { strict: true });

    // 確定時は権限付き完全データで DTO を計算
    const data = this.getMonthlyProjection(userId, yearMonth, { includeRestricted: true });

    const officialJobTitleSnapshot = {
      jobTitleId: resolvedJobTitle.jobTitleId,
      jobTitleCode: resolvedJobTitle.code,
      displayNameSnapshot: resolvedJobTitle.displayName,
      effectiveFromSnapshot: resolvedJobTitle.effectiveFrom,
      effectiveToSnapshot: resolvedJobTitle.effectiveTo,
      snapshottedAt: new Date().toISOString(),
    };

    const summaryJson = JSON.stringify({
      yearMonth,
      userJobTitle: resolvedJobTitle.displayName,
      officialJobTitleSnapshot,
      jobTitleAuthority: 'CANONICAL_SSOT',
      formSummary: data.summary,
      domainSummary: data.domainSummary,
      daysCount: data.days.length
    });

    const contentToHash = `${userId}:${yearMonth}:${summaryJson}:${JSON.stringify(data.days)}`;
    const checksum = crypto.createHash("sha256").update(contentToHash).digest("hex");

    return {
      userId,
      yearMonth,
      hasUnknownPattern: data.hasUnknownPattern,
      unresolvedDays: data.unresolvedDays,
      days: data.days,
      summaryJson,
      checksum
    };
  }

}
