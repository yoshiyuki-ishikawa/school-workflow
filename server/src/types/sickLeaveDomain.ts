/**
 * Original Wave 2B (GAP-06: 病気休暇) ドメイン型定義
 * 
 * 制度Invariant:
 * 1. 3種類の日数Semanticsの完全分離
 *    - applicationCalendarSpanDays: 今回申請の開始日〜終了日の暦日数
 *    - consecutiveSickLeaveSpanDays: 連続療養期間の暦日数（診断書6日判定用）
 *    - accumulatedSameDiseaseCalendarDays: 1年以内同一疾病認定期間のUnion暦日数（90日通算用）
 * 2. DiseaseContinuityDecision: 'SAME_DISEASE' | 'SEPARATE_DISEASE' | 'UNRESOLVED'
 * 3. 4層 Attendance Overlay Model 型
 * 4. final_calculation_snapshot 型
 */

export type DiseaseContinuityDecision =
  | 'SAME_DISEASE'       // 同一疾病認定（90日通算対象）
  | 'SEPARATE_DISEASE'   // 別疾病認定（新規通算起算）
  | 'UNRESOLVED';        // 未確定（Fail-Closed）

export type DayType =
  | 'WORKDAY'
  | 'WEEKLY_OFF'
  | 'HOLIDAY'
  | 'SUBSTITUTE_HOLIDAY';

export type ObligationStatus = 'WORKING' | 'NON_WORKING' | 'UNRESOLVED';

export interface DailyOverlayBreakdown {
  date: string;
  dayType: DayType;
  obligation: ObligationStatus;
  obligationMinutes: number;
  dutyExemptionMinutes: number;
  dutyExemptionDays: number;
  overlayTags: string[];
}

export interface SickLeaveCalculationSnapshot {
  // Fact 1: 今回申請暦日数
  applicationCalendarSpanDays: number;

  // Fact 2: 連続療養暦日数 (診断書判定用 - DiseaseDecision 非依存)
  consecutiveSickLeaveSpanDays: number;

  // Fact 3: 1年以内同一疾病通算暦日数 (90日境界用 - Interval Union)
  accumulatedSameDiseaseCalendarDaysBefore: number | null;
  accumulatedSameDiseaseCalendarDaysAfter: number | null;
  diseaseContinuityDecision: DiseaseContinuityDecision;

  // 勤務免除実績 (Working Obligation SSOT 由来)
  totalDutyExemptionDays: number;
  totalDutyExemptionMinutes: number;

  // 6日境界判定
  isConsecutive6Days: boolean;
  medicalCertificateRequired: boolean;

  // 90日境界判定
  isExceeding90Days: boolean;

  // 4層ブレークダウン
  dailyBreakdown: DailyOverlayBreakdown[];

  policyVersion: string;
  calculationVersion: string;
  calculatedAt: string;
}

export interface SickLeaveCalculationInput {
  userId: number;
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
  medicalCertificateAttached: boolean;
  diseaseContinuityDecision?: DiseaseContinuityDecision;
  existingApprovedIntervals?: Array<{
    startDate: string;
    endDate: string;
    diseaseContinuityDecision: DiseaseContinuityDecision;
    status: string; // 'APPROVED', 'CANCELLED', etc.
  }>;
}

export interface SickLeaveCalculationResult {
  isFailClosed: boolean;
  failReason?: string;
  snapshot?: SickLeaveCalculationSnapshot;
}
