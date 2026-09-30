/**
 * Shadow Logger
 * Canonical Service Fact Architecture — Phase D / E Readiness Remediation
 * 
 * Invariants:
 * - REMEDIATION-01: Append-only JSONL, Server Local Only, No External Transmission, No Raw PII (Pseudonymous Hash Only)
 * - REMEDIATION-02: Daily Rotation, 60 Days Retention, 100 MB Maximum Total Size Cap, Fault-Isolated
 * - Fail-Closed: ログ書き込み・ローテーション失敗時も Legacy 本番処理を阻害しない (例外完全捕捉)
 */

import fs from 'fs';
import path from 'path';
import { config } from '../../../config';
import { ShadowDiagnosticEntry } from './productionShadowRunner';

export interface ShadowLoggerOptions {
  logDir?: string;
  retentionDays?: number; // Default: 60
  maxTotalSizeBytes?: number; // Default: 100 MB (104,857,600 bytes)
}

export class ShadowLogger {
  private static defaultLogDir = path.resolve(config.LOGS_DIR, 'shadow');
  private static retentionDays = 60;
  private static maxTotalSizeBytes = 100 * 1024 * 1024; // 100 MB

  /**
   * ログ出力ディレクトリの取得
   */
  static getLogDir(): string {
    return this.defaultLogDir;
  }

  /**
   * 設定の上書き (テスト・運用用)
   */
  static configure(options: ShadowLoggerOptions): void {
    if (options.logDir) this.defaultLogDir = options.logDir;
    if (options.retentionDays !== undefined) this.retentionDays = options.retentionDays;
    if (options.maxTotalSizeBytes !== undefined) this.maxTotalSizeBytes = options.maxTotalSizeBytes;
  }

  /**
   * 設定のリセット (テスト用)
   */
  static resetConfig(): void {
    this.defaultLogDir = path.resolve(config.LOGS_DIR, 'shadow');
    this.retentionDays = 60;
    this.maxTotalSizeBytes = 100 * 1024 * 1024;
  }

  /**
   * 診断ログの決定論的ファイル名生成 (Daily Rotation: shadow_diagnostics_YYYY-MM-DD.jsonl)
   */
  static getLogFilePath(dateStr?: string): string {
    const d = dateStr || new Date().toISOString().split('T')[0];
    return path.resolve(this.defaultLogDir, `shadow_diagnostics_${d}.jsonl`);
  }

  /**
   * 診断ログエントリーの安全な永続化 (Append-Only JSONL)
   * Invariant: 何があっても例外を外部に漏らさない
   */
  static writeEntrySafe(entry: ShadowDiagnosticEntry, targetDateStr?: string): boolean {
    try {
      if (!fs.existsSync(this.defaultLogDir)) {
        fs.mkdirSync(this.defaultLogDir, { recursive: true });
      }

      const filePath = this.getLogFilePath(targetDateStr);
      
      // PII 排除の検証 (Raw PII は entry 型定義により除外されているが、シリアライズ時も厳格保証)
      const sanitizedEntry = {
        shadowRunId: entry.shadowRunId,
        subjectHash: entry.subjectHash,
        targetMonth: entry.targetMonth,
        inputFingerprint: entry.inputFingerprint,
        diffClassificationSummary: entry.diffClassificationSummary,
        totalDaysCompared: entry.totalDaysCompared,
        matchRate: entry.matchRate,
        durationMs: entry.durationMs,
        status: entry.status,
        errorCategory: entry.errorCategory,
        timestamp: new Date().toISOString()
      };

      const line = JSON.stringify(sanitizedEntry) + '\n';
      fs.appendFileSync(filePath, line, { encoding: 'utf-8' });

      // ローテーションおよび容量制限チェックの実行
      this.enforceRetentionAndSizeLimitSafe();

      return true;
    } catch {
      // ログ書き込み失敗時も Legacy レスポンスを阻害しないため例外を完全隔離
      return false;
    }
  }

  /**
   * 保持期間 (60日) および 総容量上限 (100MB) の安全な強制
   */
  static enforceRetentionAndSizeLimitSafe(): void {
    try {
      if (!fs.existsSync(this.defaultLogDir)) {
        return;
      }

      const files = fs.readdirSync(this.defaultLogDir)
        .filter(f => f.startsWith('shadow_diagnostics_') && f.endsWith('.jsonl'))
        .map(f => {
          const fullPath = path.resolve(this.defaultLogDir, f);
          const stat = fs.statSync(fullPath);
          return {
            filename: f,
            fullPath,
            size: stat.size,
            mtimeMs: stat.mtimeMs
          };
        })
        .sort((a, b) => a.mtimeMs - b.mtimeMs); // 古い順にソート

      const nowMs = Date.now();
      const retentionCutoffMs = nowMs - (this.retentionDays * 24 * 60 * 60 * 1000);

      let totalSize = files.reduce((acc, f) => acc + f.size, 0);

      // 1. 保持期間 (Retention) 超過ファイルの削除
      for (const file of files) {
        if (file.mtimeMs < retentionCutoffMs) {
          try {
            fs.unlinkSync(file.fullPath);
            totalSize -= file.size;
          } catch {}
        }
      }

      // 2. 総容量上限 (Max Total Size) 超過時の古いファイル順削除
      if (totalSize > this.maxTotalSizeBytes) {
        // 残存ファイルを再取得
        const remainingFiles = fs.readdirSync(this.defaultLogDir)
          .filter(f => f.startsWith('shadow_diagnostics_') && f.endsWith('.jsonl'))
          .map(f => {
            const fullPath = path.resolve(this.defaultLogDir, f);
            const stat = fs.statSync(fullPath);
            return { fullPath, size: stat.size, mtimeMs: stat.mtimeMs };
          })
          .sort((a, b) => a.mtimeMs - b.mtimeMs);

        for (const file of remainingFiles) {
          if (totalSize <= this.maxTotalSizeBytes) {
            break;
          }
          try {
            fs.unlinkSync(file.fullPath);
            totalSize -= file.size;
          } catch {}
        }
      }
    } catch {
      // ローテーション失敗時もサイレントに隔離
    }
  }

  /**
   * 永続化されたログの読み込み (監査・テスト用)
   */
  static readAllEntriesSafe(targetDateStr?: string): ShadowDiagnosticEntry[] {
    try {
      if (!fs.existsSync(this.defaultLogDir)) {
        return [];
      }

      const files = fs.readdirSync(this.defaultLogDir)
        .filter(f => f.startsWith('shadow_diagnostics_') && f.endsWith('.jsonl'))
        .filter(f => !targetDateStr || f.includes(targetDateStr))
        .map(f => path.resolve(this.defaultLogDir, f));

      const entries: ShadowDiagnosticEntry[] = [];

      for (const filePath of files) {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim().length > 0);
        for (const line of lines) {
          try {
            entries.push(JSON.parse(line));
          } catch {}
        }
      }

      return entries;
    } catch {
      return [];
    }
  }

  /**
   * ログディレクトリの全クリア (テスト用)
   */
  static clearAllLogsSafe(): void {
    try {
      if (fs.existsSync(this.defaultLogDir)) {
        const files = fs.readdirSync(this.defaultLogDir);
        for (const file of files) {
          fs.unlinkSync(path.resolve(this.defaultLogDir, file));
        }
      }
    } catch {}
  }
}
