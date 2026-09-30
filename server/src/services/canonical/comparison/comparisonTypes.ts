/**
 * Comparison Types and DTOs for Shadow Comparison
 * Canonical Service Fact Architecture — Phase C
 */

import { CanonicalServiceStatus } from '../types';

/**
 * 差分分類カテゴリ (Diff Classification)
 * Legacy Bias / Canonical Bias を排除し、客観的に差分の原因を定義
 */
export type DiffClassification =
  | 'MATCH_EXACT'          // 完全一致: displaySymbol, dutyRequirement, scheduledWorkMinutes, countedWorkMinutes, deductionMinutes, effectiveWorkMinutes すべて一致
  | 'MATCH_SEMANTIC'       // 実質一致: 表現の揺れ（例: '出' と '出勤'、空配列と未定義など）を吸収して業務上同一結果
  | 'LEGACY_DEFECT'        // Legacy側の欠陥: Legacyの計算バグ、重複制御漏れ、古い固定値等による不整合
  | 'CANONICAL_DEFECT'     // Canonical側の欠陥: Fact変換・Pipeline調停ルールの不備
  | 'DATA_INCONSISTENCY'   // 基礎データ不整合: SSOT側の外部キー欠損、無効な日付・時間フォーマット等
  | 'POLICY_UNRESOLVED'    // 未解決ポリシー: 就業規則・条例定義の解釈差分
  | 'COMPARATOR_DEFECT';   // 比較器自体の正規化不良

/**
 * 比較用正規化ファクト (共通 DTO)
 * Legacyの CanonicalDailyAttendance と Canonicalの AttendanceDomainResult を
 * 同一の比較軸に投影した DTO
 */
export interface AttendanceComparisonFact {
  userId: number;
  date: string;
  dayOfWeek: string;

  // 1. 勤務義務・カレンダー属性
  isScheduledWorkDay: boolean;
  dutyRequirement: 'WORK_REQUIRED' | 'NO_WORK_REQUIRED' | 'EXEMPT';

  // 2. 時間計算 (分数)
  scheduledWorkMinutes: number;
  countedWorkMinutes: number;
  deductionMinutes: number;
  effectiveWorkMinutes: number;

  // 3. サービス状態・表示
  primaryStatus: CanonicalServiceStatus | string;
  displaySymbol: string;
  displayName: string;
  aggregationCategory: string;

  // 4. 特殊身分・オーバーライド
  isPersonnelStatusOverridden: boolean;

  // 5. 監査情報
  ruleCount: number;
}

/**
 * 単一フィールド差分
 */
export interface FieldDifference {
  field: keyof AttendanceComparisonFact;
  legacyValue: any;
  canonicalValue: any;
  isSemanticEquivalent: boolean;
  explanation: string;
}

/**
 * 日次比較結果
 */
export interface DayComparisonResult {
  userId: number;
  date: string;
  classification: DiffClassification;
  isMatch: boolean; // MATCH_EXACT または MATCH_SEMANTIC の場合 true
  differences: FieldDifference[];
  legacyFact: AttendanceComparisonFact;
  canonicalFact: AttendanceComparisonFact;
  auditExplanation: string;
}

/**
 * 月次 Shadow Comparison 結果集計
 */
export interface MonthlyShadowComparisonReport {
  userId: number;
  yearMonth: string;
  totalDays: number;
  exactMatchCount: number;
  semanticMatchCount: number;
  legacyDefectCount: number;
  canonicalDefectCount: number;
  dataInconsistencyCount: number;
  policyUnresolvedCount: number;
  comparatorDefectCount: number;
  overallMatchRate: number; // (exact + semantic) / totalDays
  dailyResults: DayComparisonResult[];
}
