import { getDb } from "../db/database";
import { calculateTimeLeaveMinutes } from "../utils/leaveCalculator";
import { WorkingObligationResolver } from "./attendance/workingObligationResolver";

export interface CareValidationResult {
  valid: boolean;
  status: number;
  message?: string;
}

/**
 * 山口県学校職員勤務時間条例第15条「介護休暇」および第16条「介護時間」のバリデーションサービスクラス
 */
export class CareLeaveService {
  /**
   * 1. 介護休暇 (LEAVE_CARE: 条例第15条) の厳格なバリデーション
   * - 指定期間 (care_periods) の有効性
   * - 単位: DAY, HALF_DAY, TIME (TIMEは60分整数倍、1日最大4時間)
   * - 勤務日チェック (週休日・休日の除外: WorkingObligationResolver Option B)
   */
  static validateCareLeave(formData: any, subjectUserId: number): CareValidationResult {
    const db = getDb();
    const targetDate = formData?.targetDate || formData?.startDate;
    if (!targetDate) {
      return { valid: false, status: 400, message: "対象日を指定してください" };
    }

    if (!formData.careCaseId) {
      return { valid: false, status: 400, message: "介護対象者（介護ケース）を指定してください" };
    }

    const careCase = db.prepare("SELECT * FROM care_cases WHERE id = ? AND user_id = ?").get(formData.careCaseId, subjectUserId) as any;
    if (!careCase) {
      return { valid: false, status: 400, message: "指定された介護ケースが存在しないか、対象職員のデータではありません" };
    }

    if (formData.carePeriodId) {
      const period = db.prepare("SELECT * FROM care_periods WHERE id = ? AND care_case_id = ?").get(formData.carePeriodId, formData.careCaseId) as any;
      if (!period) {
        return { valid: false, status: 400, message: "指定された指定期間が存在しません" };
      }
      if (targetDate < period.start_date || targetDate > period.end_date) {
        return { valid: false, status: 400, message: `指定期間外の日付（${targetDate}）です。指定期間: ${period.start_date} 〜 ${period.end_date}` };
      }
      if (formData.endDate && formData.endDate > period.end_date) {
        return { valid: false, status: 400, message: `終了日（${formData.endDate}）が指定期間（${period.end_date}まで）を超えています` };
      }
    }

    // 単位バリデーション
    const unitType = formData.unitType || "DAY";
    if (!["DAY", "HALF_DAY", "TIME"].includes(unitType)) {
      return { valid: false, status: 400, message: `無効な取得単位です（DAY, HALF_DAY, TIME のみ）: ${unitType}` };
    }

    if (unitType === "TIME") {
      if (!formData.startTime || !formData.endTime || formData.startTime >= formData.endTime) {
        return { valid: false, status: 400, message: "有効な開始時間と終了時間を指定してください" };
      }
      const minutes = calculateTimeLeaveMinutes(formData.startTime, formData.endTime);
      if (minutes <= 0 || minutes % 60 !== 0) {
        return { valid: false, status: 400, message: "時間単位の介護休暇は1時間単位（60分の整数倍）で取得してください" };
      }
      if (minutes > 240) {
        return { valid: false, status: 400, message: "時間単位の介護休暇は1日につき4時間（240分）以内です" };
      }
    }

    // 勤務日チェック (WorkingObligationResolver: Option B SSOT)
    const oblResult = WorkingObligationResolver.resolve(subjectUserId, targetDate);
    if (!oblResult.isWorkDay) {
      return {
        valid: false,
        status: 400,
        message: `対象日（${targetDate}）は勤務義務のない日（${oblResult.sourceDetails || "週休日・休日"}）のため、介護休暇を申請することはできません`
      };
    }

    return { valid: true, status: 200 };
  }

  /**
   * 2. 介護時間 (LEAVE_CARE_TIME: 条例第16条) の厳格なバリデーション
   * - 介護ケース (care_cases) の有効性
   * - 取得単位: TIME のみ (30分刻み: 30, 60, 90, 120分)
   * - 1日最大2時間 (120分) 以内
   * - 同一日の育児部分休業 (LEAVE_CHILDCARE_PARTIAL) 等との合算上限チェック (最大120分)
   * - 指定期間と重複しない期間での取得 (条例第16条第1項)
   * - 勤務日チェック (WorkingObligationResolver: Option B SSOT)
   */
  static validateCareTime(formData: any, subjectUserId: number): CareValidationResult {
    const db = getDb();
    const targetDate = formData?.targetDate || formData?.startDate;
    if (!targetDate) {
      return { valid: false, status: 400, message: "対象日を指定してください" };
    }

    if (!formData.careCaseId) {
      return { valid: false, status: 400, message: "介護対象者（介護ケース）を指定してください" };
    }

    const careCase = db.prepare("SELECT * FROM care_cases WHERE id = ? AND user_id = ?").get(formData.careCaseId, subjectUserId) as any;
    if (!careCase) {
      return { valid: false, status: 400, message: "指定された介護ケースが存在しないか、対象職員のデータではありません" };
    }

    // 指定期間との重複チェック (条例第16条第1項: 当該要介護者に係る指定期間と重複する期間を除く)
    const overlappingPeriod = db.prepare(`
      SELECT * FROM care_periods
      WHERE care_case_id = ?
        AND start_date <= ? AND end_date >= ?
        AND status = 'APPROVED'
    `).get(formData.careCaseId, targetDate, targetDate) as any;

    if (overlappingPeriod) {
      return {
        valid: false,
        status: 400,
        message: `対象日（${targetDate}）は介護休暇の指定期間（${overlappingPeriod.start_date} 〜 ${overlappingPeriod.end_date}）と重複しているため、介護時間を取得することはできません（介護休暇をご利用ください）`
      };
    }

    // 連続3年（最長期間）チェック
    if (careCase.care_start_date) {
      const start = new Date(careCase.care_start_date);
      const maxEnd = new Date(start);
      maxEnd.setFullYear(maxEnd.getFullYear() + 3);
      const maxEndStr = maxEnd.toISOString().split("T")[0];
      if (targetDate > maxEndStr) {
        return {
          valid: false,
          status: 400,
          message: `対象日（${targetDate}）は介護時間の利用可能期間（起算日 ${careCase.care_start_date} から連続3年: ${maxEndStr} まで）を超過しています`
        };
      }
    }

    // 時間単位 (30分刻み) チェック
    if (!formData.startTime || !formData.endTime || formData.startTime >= formData.endTime) {
      return { valid: false, status: 400, message: "有効な開始時間と終了時間を指定してください" };
    }

    const minutes = calculateTimeLeaveMinutes(formData.startTime, formData.endTime);
    if (minutes <= 0 || minutes % 30 !== 0) {
      return { valid: false, status: 400, message: "介護時間は30分単位（30分、60分、90分、120分）で取得してください" };
    }

    if (minutes > 120) {
      return { valid: false, status: 400, message: "介護時間は1日につき2時間（120分）以内です" };
    }

    // 同一日の他の承認済み時間休（部分休業など）との合算排他チェック
    const otherApprovedApps = db.prepare(`
      SELECT type_id, form_data FROM applications
      WHERE subject_user_id = ?
        AND current_status IN ('SUBMITTED', 'FIRST_APPROVED', 'FINAL_APPROVED')
        AND (id != ?)
    `).all(subjectUserId, formData.id || 0) as { type_id: string; form_data: string }[];

    let sameDayOtherMinutes = 0;
    for (const other of otherApprovedApps) {
      const otherData = JSON.parse(other.form_data || "{}");
      const otherDate = otherData.targetDate || otherData.startDate;
      if (otherDate === targetDate && otherData.unitType === "TIME") {
        if (["LEAVE_CHILDCARE_PARTIAL", "LEAVE_CARE_TIME"].includes(other.type_id)) {
          const otherMin = calculateTimeLeaveMinutes(otherData.startTime, otherData.endTime);
          sameDayOtherMinutes += otherMin;
        }
      }
    }

    if (minutes + sameDayOtherMinutes > 120) {
      return {
        valid: false,
        status: 400,
        message: `同日に取得済みの育児部分休業・介護時間等との合計（${sameDayOtherMinutes + minutes}分）が1日の上限（120分）を超えています`
      };
    }

    // 勤務日チェック (WorkingObligationResolver: Option B SSOT)
    const oblResult = WorkingObligationResolver.resolve(subjectUserId, targetDate);
    if (!oblResult.isWorkDay) {
      return {
        valid: false,
        status: 400,
        message: `対象日（${targetDate}）は勤務義務のない日（${oblResult.sourceDetails || "週休日・休日"}）のため、介護時間を申請することはできません`
      };
    }

    return { valid: true, status: 200 };
  }
}
