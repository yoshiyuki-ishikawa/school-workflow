/**
 * Shadow Comparator & Diff Classifier
 * Canonical Service Fact Architecture — Phase C
 */

import { CanonicalDailyAttendance } from '../../attendance/types';
import { AttendanceDomainResult } from '../types';
import {
  AttendanceComparisonFact,
  DayComparisonResult,
  DiffClassification,
  FieldDifference,
  MonthlyShadowComparisonReport
} from './comparisonTypes';
import { SemanticNormalizer } from './semanticNormalizer';

export class ShadowComparator {
  /**
   * 1日分の出勤結果を比較し、客観的分類を実施
   */
  static compareDay(
    legacyResult: CanonicalDailyAttendance,
    canonicalResult: AttendanceDomainResult,
    userId: number
  ): DayComparisonResult {
    const legacyFact = SemanticNormalizer.normalizeLegacy(legacyResult, userId);
    const canonicalFact = SemanticNormalizer.normalizeCanonical(canonicalResult);

    const differences: FieldDifference[] = [];

    // フィールドごとの詳細比較
    const fieldsToCompare: Array<keyof AttendanceComparisonFact> = [
      'isScheduledWorkDay',
      'dutyRequirement',
      'scheduledWorkMinutes',
      'countedWorkMinutes',
      'deductionMinutes',
      'effectiveWorkMinutes',
      'displaySymbol',
      'isPersonnelStatusOverridden'
    ];

    for (const field of fieldsToCompare) {
      const legVal = legacyFact[field];
      const canVal = canonicalFact[field];

      if (legVal !== canVal) {
        let isSemanticEquiv = false;
        if (field === 'displaySymbol') {
          isSemanticEquiv = SemanticNormalizer.areSymbolsEquivalent(
            String(legVal),
            String(canVal),
            canonicalFact.primaryStatus
          );
        }

        differences.push({
          field,
          legacyValue: legVal,
          canonicalValue: canVal,
          isSemanticEquivalent: isSemanticEquiv,
          explanation: `Field mismatch on ${String(field)}: Legacy=${JSON.stringify(legVal)} vs Canonical=${JSON.stringify(canVal)}`
        });
      }
    }

    // 分類判定
    const classification = this.classifyDifferences(differences, legacyFact, canonicalFact);
    const isMatch = classification === 'MATCH_EXACT' || classification === 'MATCH_SEMANTIC';

    return {
      userId,
      date: legacyResult.date,
      classification,
      isMatch,
      differences,
      legacyFact,
      canonicalFact,
      auditExplanation: `Day ${legacyResult.date}: Classification=${classification}, DiffCount=${differences.length}`
    };
  }

  /**
   * 差分原因の客観的7分類判定 (Legacy Bias / Canonical Bias 排除)
   */
  private static classifyDifferences(
    differences: FieldDifference[],
    legacyFact: AttendanceComparisonFact,
    canonicalFact: AttendanceComparisonFact
  ): DiffClassification {
    if (differences.length === 0) {
      return 'MATCH_EXACT';
    }

    // 1. COMPARATOR_DEFECT: 比較不能な不正構造・破損
    if (differences.some(d => d.legacyValue === undefined || d.canonicalValue === undefined)) {
      return 'COMPARATOR_DEFECT';
    }

    // 2. DATA_INCONSISTENCY: 負の時間や論理破綻データ
    if (
      legacyFact.scheduledWorkMinutes < 0 || canonicalFact.scheduledWorkMinutes < 0 ||
      legacyFact.effectiveWorkMinutes < 0 || canonicalFact.effectiveWorkMinutes < 0
    ) {
      return 'DATA_INCONSISTENCY';
    }

    // 3. MATCH_SEMANTIC: 全差分が厳格なセマンティック等価 (表記Alias等)
    const allSemantic = differences.every(d => d.isSemanticEquivalent);
    if (allSemantic) {
      return 'MATCH_SEMANTIC';
    }

    // 4. LEGACY_DEFECT: Legacy側の人事オーバーライド欠陥等
    if (canonicalFact.isPersonnelStatusOverridden && !legacyFact.isPersonnelStatusOverridden) {
      return 'LEGACY_DEFECT';
    }

    // 5. CANONICAL_DEFECT: Canonical側の欠陥
    if (!canonicalFact.isPersonnelStatusOverridden && legacyFact.isPersonnelStatusOverridden) {
      return 'CANONICAL_DEFECT';
    }

    // 6. POLICY_UNRESOLVED: 未確定・未解決ポリシー
    if (differences.some(d => d.field === 'dutyRequirement' || d.field === 'isScheduledWorkDay')) {
      return 'POLICY_UNRESOLVED';
    }
    if (canonicalFact.primaryStatus.includes('UNCONFIRMED') || legacyFact.primaryStatus.includes('UNKNOWN')) {
      return 'POLICY_UNRESOLVED';
    }
    if (
      canonicalFact.primaryStatus === 'CONCURRENT_APPOINTMENT' ||
      legacyFact.primaryStatus === 'CONCURRENT_APPOINTMENT' ||
      (canonicalFact.primaryStatus === 'CONCURRENT_APPOINTMENT' && legacyFact.primaryStatus === 'LEAVE_DUTY_EXEMPT') ||
      (canonicalFact.primaryStatus === 'CONCURRENT_APPOINTMENT' && legacyFact.primaryStatus === 'DUTY_EXEMPTION')
    ) {
      return 'POLICY_UNRESOLVED';
    }

    return 'CANONICAL_DEFECT';
  }

  /**
   * 月次比較サマリーレポートを生成
   */
  static generateMonthlyReport(
    userId: number,
    yearMonth: string,
    dailyComparisons: DayComparisonResult[]
  ): MonthlyShadowComparisonReport {
    let exactMatchCount = 0;
    let semanticMatchCount = 0;
    let legacyDefectCount = 0;
    let canonicalDefectCount = 0;
    let dataInconsistencyCount = 0;
    let policyUnresolvedCount = 0;
    let comparatorDefectCount = 0;

    for (const res of dailyComparisons) {
      switch (res.classification) {
        case 'MATCH_EXACT':
          exactMatchCount++;
          break;
        case 'MATCH_SEMANTIC':
          semanticMatchCount++;
          break;
        case 'LEGACY_DEFECT':
          legacyDefectCount++;
          break;
        case 'CANONICAL_DEFECT':
          canonicalDefectCount++;
          break;
        case 'DATA_INCONSISTENCY':
          dataInconsistencyCount++;
          break;
        case 'POLICY_UNRESOLVED':
          policyUnresolvedCount++;
          break;
        case 'COMPARATOR_DEFECT':
          comparatorDefectCount++;
          break;
      }
    }

    const totalDays = dailyComparisons.length;
    const matchCount = exactMatchCount + semanticMatchCount;
    const overallMatchRate = totalDays > 0 ? matchCount / totalDays : 1.0;

    return {
      userId,
      yearMonth,
      totalDays,
      exactMatchCount,
      semanticMatchCount,
      legacyDefectCount,
      canonicalDefectCount,
      dataInconsistencyCount,
      policyUnresolvedCount,
      comparatorDefectCount,
      overallMatchRate,
      dailyResults: dailyComparisons
    };
  }
}
