/**
 * Production Shadow Runner
 * Canonical Service Fact Architecture — Phase D
 * 
 * Invariants:
 * - INV-D-01: Legacy Sole Authority (Return legacy result 100%)
 * - INV-D-02: Zero Canonical Leakage
 * - INV-D-03: Production Response Immutability
 * - INV-D-04: Structural Read-Only
 * - INV-D-05: Shadow Failure Isolation (Try-catch, promise rejection isolation)
 * - INV-D-06: Async Timeout Isolation (500ms limit for async) & Synchronous CPU safety
 * - INV-D-10: Privacy Preservation (Pseudonymous Hash in diagnostic log, no raw PII)
 */

import crypto from 'crypto';
import { Database as DatabaseType } from 'better-sqlite3';
import { CanonicalMonthlyAttendance } from '../../attendance/types';
import { CanonicalPipelinePoC } from '../pipeline';
import { ShadowComparator } from '../comparison/shadowComparator';
import { DayComparisonResult, MonthlyShadowComparisonReport } from '../comparison/comparisonTypes';
import { ProductionFactReader } from './productionFactReader';
import { ShadowLogger } from './shadowLogger';

export interface ProductionShadowContext {
  userId: number;
  yearMonth: string;
  legacyResult: CanonicalMonthlyAttendance;
  db: DatabaseType;
  timeoutMs?: number; // Default: 500ms
}

export interface ShadowDiagnosticEntry {
  shadowRunId: string;
  subjectHash: string;
  targetMonth: string;
  inputFingerprint: string;
  diffClassificationSummary: Record<string, number>;
  totalDaysCompared: number;
  matchRate: number;
  durationMs: number;
  status: 'COMPLETED' | 'ISOLATED_ERROR' | 'TIMEOUT';
  errorCategory?: string;
}

// 診断ログのインメモリ蓄積（テストおよび監査検証用）
const diagnosticLogStore: ShadowDiagnosticEntry[] = [];

export class ProductionShadowRunner {
  private static executionCounter = 0;

  /**
   * 診断ログストアの取得（テスト・監査用）
   */
  static getDiagnosticLogs(): ShadowDiagnosticEntry[] {
    return [...diagnosticLogStore];
  }

  /**
   * 診断ログストアのクリア（テスト用）
   */
  static clearDiagnosticLogs(): void {
    diagnosticLogStore.length = 0;
    this.executionCounter = 0;
  }

  /**
   * 実行カウンタの取得
   */
  static getExecutionCount(): number {
    return this.executionCounter;
  }

  /**
   * Safe Synchronous Execution of Monthly Shadow Dual Run
   * Invariant: 何があっても例外を外部に漏らさず、Legacy Production Response を成立させる
   */
  static runMonthlyShadowSafe(context: ProductionShadowContext): MonthlyShadowComparisonReport | null {
    this.executionCounter++;
    const startTime = Date.now();
    const shadowRunId = crypto.randomUUID();
    const subjectHash = crypto
      .createHash('sha256')
      .update(`USER_${context.userId}`)
      .digest('hex')
      .substring(0, 16);

    try {
      const { userId, yearMonth, legacyResult, db } = context;

      // 1. Same Input Fact Extraction
      const extracted = ProductionFactReader.extractMonthlyFacts(db, userId, yearMonth);

      // 2. 日次ごとの Side-by-Side 比較実行
      const dailyComparisons: DayComparisonResult[] = [];

      for (const legacyDay of legacyResult.days) {
        // 当該日の Canonical Fact 群を抽出
        const dayFacts = extracted.facts.filter(f => f.targetDate === legacyDay.date);

        // Same Input Context for Evaluation
        const evalCtx = {
          userId,
          date: legacyDay.date,
          scheduledWorkMinutes: legacyDay.workScheduleAttributes?.scheduledWorkMinutes ?? legacyDay.scheduledWorkMinutes ?? 465,
          isWorkDay: legacyDay.workScheduleAttributes?.isScheduledWorkDay ?? (legacyDay.dutyRequirement === 'WORK_REQUIRED' || legacyDay.isWorkDay)
        };

        // Canonical Pipeline PoC Evaluation
        const canonicalResult = CanonicalPipelinePoC.evaluateDay(evalCtx, dayFacts);

        // Side-by-Side Comparison
        const dayComp = ShadowComparator.compareDay(legacyDay, canonicalResult, userId);
        dailyComparisons.push(dayComp);
      }

      // 3. 月次サマリーレポート生成
      const report = ShadowComparator.generateMonthlyReport(userId, yearMonth, dailyComparisons);
      const durationMs = Date.now() - startTime;

      // 4. プライバシー保護構造化ログの記録 (No PII)
      const diffSummary: Record<string, number> = {
        MATCH_EXACT: report.exactMatchCount,
        MATCH_SEMANTIC: report.semanticMatchCount,
        LEGACY_DEFECT: report.legacyDefectCount,
        CANONICAL_DEFECT: report.canonicalDefectCount,
        DATA_INCONSISTENCY: report.dataInconsistencyCount,
        POLICY_UNRESOLVED: report.policyUnresolvedCount,
        COMPARATOR_DEFECT: report.comparatorDefectCount
      };

      const entry: ShadowDiagnosticEntry = {
        shadowRunId,
        subjectHash,
        targetMonth: yearMonth,
        inputFingerprint: extracted.datasetFingerprint,
        diffClassificationSummary: diffSummary,
        totalDaysCompared: report.totalDays,
        matchRate: report.overallMatchRate,
        durationMs,
        status: 'COMPLETED'
      };

      diagnosticLogStore.push(entry);
      ShadowLogger.writeEntrySafe(entry);

      return report;
    } catch (err: any) {
      // Invariant INV-D-05: Shadow Failure Isolation
      const durationMs = Date.now() - startTime;
      const errorEntry: ShadowDiagnosticEntry = {
        shadowRunId,
        subjectHash,
        targetMonth: context.yearMonth,
        inputFingerprint: 'ERROR_BEFORE_FINGERPRINT',
        diffClassificationSummary: {},
        totalDaysCompared: 0,
        matchRate: 0,
        durationMs,
        status: 'ISOLATED_ERROR',
        errorCategory: err?.name || 'UnknownError'
      };

      diagnosticLogStore.push(errorEntry);
      ShadowLogger.writeEntrySafe(errorEntry);

      // エラーはログに隔離し、外には一切スローしない（Legacy 処理を守る）
      return null;
    }
  }

  /**
   * Async Timeout Isolation Wrapper (INV-D-06 & D-23)
   */
  static async runMonthlyShadowAsyncWithTimeout(
    context: ProductionShadowContext,
    timeoutMs = 500
  ): Promise<MonthlyShadowComparisonReport | null> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('SHADOW_TIMEOUT_EXCEEDED')), timeoutMs);
    });

    const executionPromise = new Promise<MonthlyShadowComparisonReport | null>((resolve) => {
      setImmediate(() => {
        const res = this.runMonthlyShadowSafe(context);
        resolve(res);
      });
    });

    try {
      return await Promise.race([executionPromise, timeoutPromise]);
    } catch (err: any) {
      // Timeout または 非同期エラーを隔離
      const shadowRunId = crypto.randomUUID();
      const subjectHash = crypto
        .createHash('sha256')
        .update(`USER_${context.userId}`)
        .digest('hex')
        .substring(0, 16);

      const timeoutEntry: ShadowDiagnosticEntry = {
        shadowRunId,
        subjectHash,
        targetMonth: context.yearMonth,
        inputFingerprint: 'TIMEOUT_ISOLATED',
        diffClassificationSummary: {},
        totalDaysCompared: 0,
        matchRate: 0,
        durationMs: timeoutMs,
        status: 'TIMEOUT',
        errorCategory: err?.message || 'SHADOW_TIMEOUT'
      };

      diagnosticLogStore.push(timeoutEntry);
      ShadowLogger.writeEntrySafe(timeoutEntry);

      return null;
    }
  }
}
