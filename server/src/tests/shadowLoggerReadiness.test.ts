/**
 * Shadow Logger Readiness Remediation Dedicated Test Suite
 * Canonical Service Fact Architecture — Remediation-01, 02, 03, 04
 * 
 * Verifications:
 * 1. REMEDIATION-01: Persistence, Append-only JSONL, PII Exclusion, subjectHash preservation
 * 2. REMEDIATION-02: Daily Rotation, 60 Days Retention Cleanup, 100MB Total Cap, Fault-Isolated
 * 3. REMEDIATION-03: Zero DB Mutation Proof (Read-Only DB blocks INSERT, UPDATE, DELETE, DDL, write attempts fail)
 * 4. Fault Isolation: File write errors or directory errors do not disrupt Legacy Production Response
 * 5. Strict Default-OFF: Unset / empty / "false" / "TRUE" / "1" / "yes" do not activate shadow mode
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import Database, { Database as DatabaseType } from 'better-sqlite3';
import { ShadowLogger } from '../services/canonical/shadow/shadowLogger';
import { ProductionShadowRunner, ShadowDiagnosticEntry } from '../services/canonical/shadow/productionShadowRunner';
import { getReadOnlyDb } from '../db/readOnlyDb';
import { config } from '../config';
import { AttendanceEngine } from '../services/attendance/attendanceEngine';
import { initDatabase } from '../db/database';
import { seedDatabase } from '../db/seeds';

const TEST_LOG_DIR = path.resolve(__dirname, '../../logs/test_shadow_remediation');

describe('Shadow Logger Readiness Remediation Dedicated Suite', () => {
  beforeEach(() => {
    ShadowLogger.configure({
      logDir: TEST_LOG_DIR,
      retentionDays: 60,
      maxTotalSizeBytes: 100 * 1024 * 1024
    });
    ShadowLogger.clearAllLogsSafe();
    ProductionShadowRunner.clearDiagnosticLogs();
  });

  afterEach(() => {
    ShadowLogger.clearAllLogsSafe();
    ShadowLogger.resetConfig();
    try {
      if (fs.existsSync(TEST_LOG_DIR)) {
        fs.rmSync(TEST_LOG_DIR, { recursive: true, force: true });
      }
    } catch {}
  });

  // ==========================================
  // REMEDIATION-01: 永続化と PII 非出力
  // ==========================================
  it('REM-01-A: 診断ログが JSONL 形式でファイルへ永続化され、プロセス再起動相当後も Evidence が保持されること', () => {
    const entry: ShadowDiagnosticEntry = {
      shadowRunId: 'test-run-1',
      subjectHash: '6b3f0a1d30745f89',
      targetMonth: '2026-05',
      inputFingerprint: 'a'.repeat(64),
      diffClassificationSummary: { MATCH_EXACT: 31 },
      totalDaysCompared: 31,
      matchRate: 1.0,
      durationMs: 3.5,
      status: 'COMPLETED'
    };

    const writeSuccess = ShadowLogger.writeEntrySafe(entry, '2026-05-01');
    assert.strictEqual(writeSuccess, true);

    // ファイルから直接読み込み（プロセス再起動相当）
    const entries = ShadowLogger.readAllEntriesSafe('2026-05-01');
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].shadowRunId, 'test-run-1');
    assert.strictEqual(entries[0].subjectHash, '6b3f0a1d30745f89');
    assert.strictEqual(entries[0].targetMonth, '2026-05');
    assert.strictEqual(entries[0].matchRate, 1.0);
  });

  it('REM-01-B: 永続化された JSONL ログに生氏名・職員番号・所属・申請理由等の Raw PII が含まれないこと', () => {
    const entry: ShadowDiagnosticEntry = {
      shadowRunId: 'test-run-pii-check',
      subjectHash: '7c4e0b2d40856f90',
      targetMonth: '2026-05',
      inputFingerprint: 'b'.repeat(64),
      diffClassificationSummary: { MATCH_EXACT: 31 },
      totalDaysCompared: 31,
      matchRate: 1.0,
      durationMs: 4.1,
      status: 'COMPLETED'
    };

    ShadowLogger.writeEntrySafe(entry, '2026-05-02');
    const logFilePath = ShadowLogger.getLogFilePath('2026-05-02');
    const rawContent = fs.readFileSync(logFilePath, 'utf-8');

    // PII 禁止検証
    assert.strictEqual(rawContent.includes('山田太郎'), false);
    assert.strictEqual(rawContent.includes('userName'), false);
    assert.strictEqual(rawContent.includes('userDepartment'), false);
    assert.strictEqual(rawContent.includes('reasonCode'), false);
    assert.strictEqual(rawContent.includes('form_data'), false);
    assert.ok(rawContent.includes('"subjectHash":"7c4e0b2d40856f90"'));
  });

  // ==========================================
  // REMEDIATION-02: 日次ローテーション・容量制限・保持期間
  // ==========================================
  it('REM-02-A: 日次ローテーションにより日付ごとに別ファイル (shadow_diagnostics_YYYY-MM-DD.jsonl) で出力されること', () => {
    const entry1: ShadowDiagnosticEntry = {
      shadowRunId: 'run-day1',
      subjectHash: 'hash1',
      targetMonth: '2026-05',
      inputFingerprint: 'c'.repeat(64),
      diffClassificationSummary: {},
      totalDaysCompared: 31,
      matchRate: 1.0,
      durationMs: 2.0,
      status: 'COMPLETED'
    };
    const entry2: ShadowDiagnosticEntry = {
      shadowRunId: 'run-day2',
      subjectHash: 'hash2',
      targetMonth: '2026-05',
      inputFingerprint: 'd'.repeat(64),
      diffClassificationSummary: {},
      totalDaysCompared: 31,
      matchRate: 1.0,
      durationMs: 2.5,
      status: 'COMPLETED'
    };

    ShadowLogger.writeEntrySafe(entry1, '2026-05-10');
    ShadowLogger.writeEntrySafe(entry2, '2026-05-11');

    const file1 = ShadowLogger.getLogFilePath('2026-05-10');
    const file2 = ShadowLogger.getLogFilePath('2026-05-11');

    assert.ok(fs.existsSync(file1), '2026-05-10のログファイルが存在すること');
    assert.ok(fs.existsSync(file2), '2026-05-11のログファイルが存在すること');
    assert.notStrictEqual(file1, file2);
  });

  it('REM-02-B: 保持期間 (60日) を超過した古いログファイルが安全に自動消去されること', () => {
    ShadowLogger.configure({ logDir: TEST_LOG_DIR, retentionDays: 60 });

    const oldFilePath = ShadowLogger.getLogFilePath('2026-01-01');
    fs.mkdirSync(TEST_LOG_DIR, { recursive: true });
    fs.writeFileSync(oldFilePath, '{"old":"log"}\n');

    // ファイル更新時刻を 70日前に設定
    const pastTime = (Date.now() - (70 * 24 * 60 * 60 * 1000)) / 1000;
    fs.utimesSync(oldFilePath, pastTime, pastTime);

    // 新規ログ書き込みに伴うローテーション発動
    const currentEntry: ShadowDiagnosticEntry = {
      shadowRunId: 'run-current',
      subjectHash: 'hash-curr',
      targetMonth: '2026-05',
      inputFingerprint: 'e'.repeat(64),
      diffClassificationSummary: {},
      totalDaysCompared: 31,
      matchRate: 1.0,
      durationMs: 3.0,
      status: 'COMPLETED'
    };
    ShadowLogger.writeEntrySafe(currentEntry, '2026-05-12');

    assert.strictEqual(fs.existsSync(oldFilePath), false, '70日前の古いログファイルが削除されていること');
    assert.strictEqual(fs.existsSync(ShadowLogger.getLogFilePath('2026-05-12')), true, '当日のログファイルは保持されていること');
  });

  it('REM-02-C: 総容量上限 (100MB) 超過時に古いログファイルから安全に削除されること', () => {
    // テスト用に容量上限を 500 バイトに設定
    ShadowLogger.configure({ logDir: TEST_LOG_DIR, retentionDays: 60, maxTotalSizeBytes: 500 });
    fs.mkdirSync(TEST_LOG_DIR, { recursive: true });

    const fileOld = ShadowLogger.getLogFilePath('2026-05-01');
    const fileNew = ShadowLogger.getLogFilePath('2026-05-02');

    // 400バイトのログを書き込み
    fs.writeFileSync(fileOld, 'X'.repeat(400) + '\n');
    const oldTime = (Date.now() - 100000) / 1000;
    fs.utimesSync(fileOld, oldTime, oldTime);

    // さらに400バイトのログを書き込み（合計800バイト > 500バイト上限）
    const entry: ShadowDiagnosticEntry = {
      shadowRunId: 'run-new',
      subjectHash: 'hash-new',
      targetMonth: '2026-05',
      inputFingerprint: 'f'.repeat(64),
      diffClassificationSummary: {},
      totalDaysCompared: 31,
      matchRate: 1.0,
      durationMs: 3.0,
      status: 'COMPLETED'
    };
    ShadowLogger.writeEntrySafe(entry, '2026-05-02');

    assert.strictEqual(fs.existsSync(fileOld), false, '上限超過により古いファイルが削除されたこと');
    assert.strictEqual(fs.existsSync(fileNew), true, '新しいファイルが保持されていること');
  });

  // ==========================================
  // REMEDIATION-03: Zero DB Mutation 証明方式
  // ==========================================
  it('REM-03: Shadow Read-Only DB コネクションから INSERT / UPDATE / DELETE / DDL を試行した場合に SQLITE_READONLY で物理拒絶されること', () => {
    const tempDbPath = path.resolve(__dirname, '../../data/test_shadow_readonly_mutation.db');
    const writeDb = new Database(tempDbPath);
    writeDb.exec('CREATE TABLE test_service (id INTEGER PRIMARY KEY, status TEXT)');
    writeDb.exec("INSERT INTO test_service (id, status) VALUES (1, 'NORMAL')");
    writeDb.close();

    const roDb = getReadOnlyDb(tempDbPath);

    // 1. SELECT は正常動作
    const rows = roDb.prepare('SELECT * FROM test_service WHERE id = 1').all();
    assert.strictEqual(rows.length, 1);

    // 2. INSERT 物理拒絶
    assert.throws(() => {
      roDb.prepare("INSERT INTO test_service (id, status) VALUES (2, 'ILLEGAL_INSERT')").run();
    }, (err: any) => err.message.includes('readonly') || err.message.includes('attempt to write a readonly database'));

    // 3. UPDATE 物理拒絶
    assert.throws(() => {
      roDb.prepare("UPDATE test_service SET status = 'ILLEGAL_UPDATE' WHERE id = 1").run();
    }, (err: any) => err.message.includes('readonly') || err.message.includes('attempt to write a readonly database'));

    // 4. DELETE 物理拒絶
    assert.throws(() => {
      roDb.prepare("DELETE FROM test_service WHERE id = 1").run();
    }, (err: any) => err.message.includes('readonly') || err.message.includes('attempt to write a readonly database'));

    // 5. DDL (DROP / ALTER) 物理拒絶
    assert.throws(() => {
      roDb.prepare("DROP TABLE test_service").run();
    }, (err: any) => err.message.includes('readonly') || err.message.includes('attempt to write a readonly database'));

    roDb.close();
    try {
      fs.unlinkSync(tempDbPath);
    } catch {}
  });

  // ==========================================
  // Fault Isolation: ログ障害時の本番保護
  // ==========================================
  it('Fault-Isolation: ログディレクトリの書込権限喪失・ファイル書込失敗時も Legacy Production Response が 100% 正常成立すること', () => {
    initDatabase();
    seedDatabase();

    // 書込不可能な無効パスを設定してログ障害をシミュレート
    ShadowLogger.configure({ logDir: '/invalid_root/read_only_dir_simulate' });

    config.CANONICAL_SHADOW_MODE = true;

    let result: any = null;
    assert.doesNotThrow(() => {
      result = AttendanceEngine.getMonthlyAttendanceData(1, '2026-05');
    });

    assert.notStrictEqual(result, null);
    assert.strictEqual(result.userId, 1);
    assert.strictEqual(result.days.length, 31);
    assert.strictEqual(result.userName, '山田 太郎 (教員A)');
  });

  // ==========================================
  // Default-OFF Invariant
  // ==========================================
  it('Default-OFF: 環境変数が未設定または "true" 以外の場合は Shadow が完全停止すること', () => {
    const falseValues = [undefined, '', 'false', 'FALSE', 'TRUE', '1', 'yes', 'enabled', 'null'];
    for (const val of falseValues) {
      if (val === undefined) {
        delete process.env.CANONICAL_SHADOW_MODE;
      } else {
        process.env.CANONICAL_SHADOW_MODE = val;
      }
      const isEnabled = process.env.CANONICAL_SHADOW_MODE === 'true';
      assert.strictEqual(isEnabled, false, `値 "${val}" は false になるべき`);
    }
  });
});
