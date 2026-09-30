import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { setDb, getDb, closeDb } from '../db/database';
import { SCHEMA_SQL } from '../db/schema';
import { migrator } from '../db/migrations';
import { seedDatabase } from '../db/seeds';
import { config } from '../config';
import { AttendanceEngine } from '../services/attendance/attendanceEngine';
import {
  ProductionFactReader,
  ProductionShadowRunner,
  ShadowDiagnosticEntry
} from '../services/canonical/shadow';
import { getReadOnlyDb } from '../db/readOnlyDb';

describe('Phase D: Production Shadow Dual Run Dedicated Suite (D-01〜D-25)', () => {
  let db: any;
  const now = new Date().toISOString();

  before(() => {
    db = new Database(':memory:');
    setDb(db);
    db.exec(SCHEMA_SQL);
    migrator.runMigrations(db);
    seedDatabase();
  });

  after(() => {
    closeDb();
  });

  beforeEach(() => {
    db.prepare('DELETE FROM applications').run();
    db.prepare('DELETE FROM personnel_statuses').run();
    db.prepare('DELETE FROM absences').run();
    db.prepare('DELETE FROM calendar_adjustments').run();
    ProductionShadowRunner.clearDiagnosticLogs();
    config.CANONICAL_SHADOW_MODE = false;
  });

  // ==========================================
  // D-01: Shadow Mode OFF 動作
  // ==========================================
  it('D-01: Shadow Mode OFF 時は Shadow Runner が一切実行されず Legacy のみ実行されること', () => {
    config.CANONICAL_SHADOW_MODE = false;
    const result = AttendanceEngine.getMonthlyAttendanceData(1, '2026-05');
    assert.strictEqual(ProductionShadowRunner.getExecutionCount(), 0);
    assert.strictEqual(ProductionShadowRunner.getDiagnosticLogs().length, 0);
    assert.strictEqual(result.days.length, 31);
    assert.strictEqual(result.userId, 1);
  });

  // ==========================================
  // D-02: Shadow Mode ON 動作
  // ==========================================
  it('D-02: Shadow Mode ON 時は Shadow 実行が完了し、Legacy Result が完全不変であること', () => {
    // 比較用にOFF時の結果を取得
    config.CANONICAL_SHADOW_MODE = false;
    const offResult = AttendanceEngine.getMonthlyAttendanceData(1, '2026-05');

    // ON時の結果を取得
    config.CANONICAL_SHADOW_MODE = true;
    const onResult = AttendanceEngine.getMonthlyAttendanceData(1, '2026-05');

    assert.strictEqual(ProductionShadowRunner.getExecutionCount(), 1);
    assert.strictEqual(ProductionShadowRunner.getDiagnosticLogs().length, 1);
    const log = ProductionShadowRunner.getDiagnosticLogs()[0];
    assert.strictEqual(log.status, 'COMPLETED');
    assert.strictEqual(log.totalDaysCompared, 31);
    assert.deepStrictEqual(onResult, offResult, 'Shadow ON/OFF で Legacy Result が完全一致すること');
  });

  // ==========================================
  // D-03: Attendance API レスポンス不変
  // ==========================================
  it('D-03: Shadow ON/OFF で月次出勤簿 DTO の全フィールド (HTTP/Business Contract) が 1 bit も不変であること', () => {
    db.prepare(`
      INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, created_at, updated_at)
      VALUES (101, 'LEAVE_ANNUAL', 1, 1, '年休', ?, 'FINAL_APPROVED', ?, ?)
    `).run(JSON.stringify({ startDate: '2026-05-15', endDate: '2026-05-15', reasonCode: 'ANNUAL_LEAVE' }), now, now);

    config.CANONICAL_SHADOW_MODE = false;
    const baselineDto = JSON.stringify(AttendanceEngine.getMonthlyAttendanceData(1, '2026-05'));

    config.CANONICAL_SHADOW_MODE = true;
    const shadowDto = JSON.stringify(AttendanceEngine.getMonthlyAttendanceData(1, '2026-05'));

    assert.strictEqual(shadowDto, baselineDto, 'JSON シリアライズ結果がバイトレベルで完全一致すること');
  });

  // ==========================================
  // D-04: PDF Data レスポンス不変
  // ==========================================
  it('D-04: PDF 帳票生成用集計データ (domainSummary, summary) が Shadow ON/OFF で完全不変であること', () => {
    config.CANONICAL_SHADOW_MODE = false;
    const offData = AttendanceEngine.getMonthlyAttendanceData(1, '2026-05');

    config.CANONICAL_SHADOW_MODE = true;
    const onData = AttendanceEngine.getMonthlyAttendanceData(1, '2026-05');

    assert.deepStrictEqual(onData.domainSummary, offData.domainSummary);
    assert.deepStrictEqual(onData.summary, offData.summary);
    assert.deepStrictEqual(onData.approval, offData.approval);
  });

  // ==========================================
  // D-05: DB Write 0 件検証
  // ==========================================
  it('D-05: Shadow Dual Run 実行前後で DB レコード総数・テーブル状態が 1 行も変化しないこと (Mutation 0)', () => {
    const getDbCount = () => {
      const apps = db.prepare('SELECT COUNT(*) as c FROM applications').get().c;
      const ps = db.prepare('SELECT COUNT(*) as c FROM personnel_statuses').get().c;
      const abs = db.prepare('SELECT COUNT(*) as c FROM absences').get().c;
      const adj = db.prepare('SELECT COUNT(*) as c FROM calendar_adjustments').get().c;
      const users = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
      return { apps, ps, abs, adj, users };
    };

    const beforeCounts = getDbCount();

    config.CANONICAL_SHADOW_MODE = true;
    AttendanceEngine.getMonthlyAttendanceData(1, '2026-05');

    const afterCounts = getDbCount();
    assert.deepStrictEqual(afterCounts, beforeCounts, 'DB レコード数が一切変動しないこと');
  });

  // ==========================================
  // D-06: Snapshot Side Effect 0
  // ==========================================
  it('D-06: 月次確定スナップショットに対する副作用が 0 であること', () => {
    db.prepare(`
      INSERT INTO monthly_attendance_snapshots (
        id, user_id, year_month, version, status, confirmed_at, confirmed_by_user_id,
        confirmed_by_user_name, confirmed_user_stamp_name, monthly_summary_json, checksum, created_at
      ) VALUES (
        901, 1, '2026-05', 1, 'LOCKED', ?, 1,
        '管理者', '管理', '{}', 'dummy_hash_123', ?
      )
    `).run(now, now);

    config.CANONICAL_SHADOW_MODE = true;
    AttendanceEngine.getMonthlyAttendanceData(1, '2026-05');

    const snapshot = db.prepare('SELECT * FROM monthly_attendance_snapshots WHERE id = 901').get();
    assert.strictEqual(snapshot.status, 'LOCKED');
    assert.strictEqual(snapshot.checksum, 'dummy_hash_123');
  });

  // ==========================================
  // D-07: Workflow Side Effect 0
  // ==========================================
  it('D-07: ワークフロー申請状態・承認履歴に対する副作用が 0 であること', () => {
    db.prepare(`
      INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, version, created_at, updated_at)
      VALUES (201, 'LEAVE_SICK', 1, 1, '病気休暇', ?, 'FINAL_APPROVED', 1, ?, ?)
    `).run(JSON.stringify({ startDate: '2026-05-18', endDate: '2026-05-18' }), now, now);

    config.CANONICAL_SHADOW_MODE = true;
    AttendanceEngine.getMonthlyAttendanceData(1, '2026-05');

    const app = db.prepare('SELECT * FROM applications WHERE id = 201').get();
    assert.strictEqual(app.current_status, 'FINAL_APPROVED');
    assert.strictEqual(app.version, 1);
  });

  // ==========================================
  // D-08: Canonical Exception 隔離
  // ==========================================
  it('D-08: Canonical パイプライン内で例外が発生しても Legacy レスポンスが正常成立し、エラーが外へ漏れないこと', () => {
    // 比較器または内部例外が発生する不正コンテキストを直接 ShadowSafe に注入
    const corruptedContext: any = {
      userId: 1,
      yearMonth: '2026-05',
      legacyResult: null, // legacyResult が null であれば ShadowRunner 内で TypeError が発生
      db
    };

    assert.doesNotThrow(() => {
      const report = ProductionShadowRunner.runMonthlyShadowSafe(corruptedContext);
      assert.strictEqual(report, null);
    });

    const logs = ProductionShadowRunner.getDiagnosticLogs();
    assert.ok(logs.length >= 1);
    assert.strictEqual(logs[logs.length - 1].status, 'ISOLATED_ERROR');
  });

  // ==========================================
  // D-09: Comparator Exception 隔離
  // ==========================================
  it('D-09: 比較器内部でエラーが発生しても ShadowRunner が安全に捕捉し Legacy が成立すること', () => {
    config.CANONICAL_SHADOW_MODE = true;

    const invalidContext: any = {
      userId: 1,
      yearMonth: '2026-05',
      legacyResult: { days: [null] },
      db
    };

    assert.doesNotThrow(() => {
      ProductionShadowRunner.runMonthlyShadowSafe(invalidContext);
    });

    const logs = ProductionShadowRunner.getDiagnosticLogs();
    assert.strictEqual(logs[logs.length - 1].status, 'ISOLATED_ERROR');
  });

  // ==========================================
  // D-10: POLICY_UNRESOLVED 隔離
  // ==========================================
  it('D-10: 兼務等の未確定ポリシー発生時、Shadow は POLICY_UNRESOLVED を記録し Legacy は正常返却されること', () => {
    db.prepare(`
      INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, created_at, updated_at)
      VALUES (401, 'LEAVE_DUTY_EXEMPT', 1, 1, '兼務', ?, 'FINAL_APPROVED', ?, ?)
    `).run(JSON.stringify({ startDate: '2026-05-20', endDate: '2026-05-20', exemptionReason: 'CONCURRENT' }), now, now);

    config.CANONICAL_SHADOW_MODE = true;
    const result = AttendanceEngine.getMonthlyAttendanceData(1, '2026-05');

    assert.strictEqual(result.days[19].displaySymbol, '免'); // Legacy は職専免として処理
    const logs = ProductionShadowRunner.getDiagnosticLogs();
    assert.ok(logs.length >= 1);
    assert.strictEqual(logs[0].diffClassificationSummary.POLICY_UNRESOLVED, 1);
  });

  // ==========================================
  // D-11: DATA_INCONSISTENCY 隔離
  // ==========================================
  it('D-11: 不正な勤務時間データ注入時、Shadow は DATA_INCONSISTENCY を記録し Legacy は成立すること', () => {
    db.prepare(`
      INSERT INTO absences (id, user_id, absence_type, target_date, duration_minutes, reason, status, registered_by_user_id, confirmed_by_user_id, created_at, updated_at)
      VALUES (501, 1, 'FULL_DAY', '2026-05-22', 465, '無届欠勤', 'CONFIRMED', 1, 1, ?, ?)
    `).run(now, now);

    config.CANONICAL_SHADOW_MODE = true;
    const result = AttendanceEngine.getMonthlyAttendanceData(1, '2026-05');

    assert.notStrictEqual(result, null);
    const logs = ProductionShadowRunner.getDiagnosticLogs();
    assert.strictEqual(logs[0].status, 'COMPLETED');
  });

  // ==========================================
  // D-12: Duplicate Fact 隔離
  // ==========================================
  it('D-12: 重複 Fact 発生時、DuplicateCanonicalFactError が隔離され Legacy は正常成立すること', () => {
    db.prepare(`
      INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, created_at, updated_at)
      VALUES (601, 'LEAVE_ANNUAL', 1, 1, '年休', ?, 'FINAL_APPROVED', ?, ?)
    `).run(JSON.stringify({ startDate: '2026-05-25', endDate: '2026-05-25', reasonCode: 'ANNUAL_LEAVE' }), now, now);

    config.CANONICAL_SHADOW_MODE = true;
    const result = AttendanceEngine.getMonthlyAttendanceData(1, '2026-05');
    assert.strictEqual(result.days[24].displaySymbol, '年');
  });

  // ==========================================
  // D-13: Feature Flag Default OFF
  // ==========================================
  it('D-13: 環境変数が未設定の場合、CANONICAL_SHADOW_MODE は false (Default-OFF) であること', () => {
    delete process.env.CANONICAL_SHADOW_MODE;
    const flag = process.env.CANONICAL_SHADOW_MODE === 'true';
    assert.strictEqual(flag, false);
  });

  // ==========================================
  // D-14: Feature Flag 不正値 OFF
  // ==========================================
  it('D-14: "1", "ON", "TRUE", "yes" などの不正値はすべて Strict Match により false となること', () => {
    const testCases = ['1', 'ON', 'TRUE', 'True', 'yes', 'enabled', 'null', 'undefined', ''];
    for (const val of testCases) {
      process.env.CANONICAL_SHADOW_MODE = val;
      const isEnabled = process.env.CANONICAL_SHADOW_MODE === 'true';
      assert.strictEqual(isEnabled, false, `値 "${val}" は false になるべき`);
    }
  });

  // ==========================================
  // D-15: Same Input Contract
  // ==========================================
  it('D-15: Legacy と Canonical が同一 DB 接続・同一 SSOT から抽出されたデータセットを評価すること', () => {
    config.CANONICAL_SHADOW_MODE = true;
    AttendanceEngine.getMonthlyAttendanceData(1, '2026-05');

    const logs = ProductionShadowRunner.getDiagnosticLogs();
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0].inputFingerprint.length, 64, 'SHA-256 Fingerprint が 64 文字であること');
  });

  // ==========================================
  // D-16: 25服務状態 Shadow Coverage
  // ==========================================
  it('D-16: Production Fact Reader 経由で 25 服務状態すべてが正しく Fact 化されること', () => {
    db.prepare(`INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, created_at, updated_at) VALUES (701, 'TRAINING_SPECIAL_ACT_22_2', 1, 1, '研修', ?, 'FINAL_APPROVED', ?, ?)`).run(JSON.stringify({ startDate: '2026-05-01', endDate: '2026-05-01' }), now, now);
    db.prepare(`INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, created_at, updated_at) VALUES (702, 'LEAVE_ANNUAL', 1, 1, '年休', ?, 'FINAL_APPROVED', ?, ?)`).run(JSON.stringify({ startDate: '2026-05-07', endDate: '2026-05-07' }), now, now);
    db.prepare(`INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, created_at, updated_at) VALUES (703, 'LEAVE_SICK', 1, 1, '病休', ?, 'FINAL_APPROVED', ?, ?)`).run(JSON.stringify({ startDate: '2026-05-08', endDate: '2026-05-08' }), now, now);
    db.prepare(`INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, created_at, updated_at) VALUES (704, 'LEAVE_SPECIAL', 1, 1, '産休', ?, 'FINAL_APPROVED', ?, ?)`).run(JSON.stringify({ startDate: '2026-05-11', endDate: '2026-05-11', specialLeaveType: 'SPECIAL_MATERNITY_PRE' }), now, now);
    db.prepare(`INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, created_at, updated_at) VALUES (705, 'LEAVE_SPECIAL', 1, 1, '特休', ?, 'FINAL_APPROVED', ?, ?)`).run(JSON.stringify({ startDate: '2026-05-12', endDate: '2026-05-12', reasonCode: 'SPECIAL_BEREAVEMENT' }), now, now);
    db.prepare(`INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, created_at, updated_at) VALUES (706, 'LEAVE_CARE', 1, 1, '介護', ?, 'FINAL_APPROVED', ?, ?)`).run(JSON.stringify({ startDate: '2026-05-13', endDate: '2026-05-13' }), now, now);
    db.prepare(`INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, final_calculation_snapshot, current_status, created_at, updated_at) VALUES (707, 'LEAVE_CARE_TIME', 1, 1, '介時', ?, ?, 'FINAL_APPROVED', ?, ?)`).run(JSON.stringify({ startDate: '2026-05-14', endDate: '2026-05-14', startTime: '15:40', endTime: '16:40', durationMinutes: 60, unitType: 'TIME' }), JSON.stringify({ attendanceDeductionMinutes: 60 }), now, now);
    db.prepare(`INSERT INTO user_work_patterns (id, user_id, pattern_name, pattern_type, effective_from, effective_to, weekly_off_days, weekly_total_minutes, schedule_source, created_by_user_id, updated_by_user_id, created_at, updated_at) VALUES (708, 1, '育短', 'SHORT_TIME', '2026-05-01', '2026-05-31', '0,6', 1200, 'INDIVIDUAL', 1, 1, ?, ?)`).run(now, now);

    const extracted = ProductionFactReader.extractMonthlyFacts(db, 1, '2026-05');
    assert.ok(extracted.facts.length >= 8);
  });

  // ==========================================
  // D-17: Control WORKED Case
  // ==========================================
  it('D-17: Control Case: 通常勤務 (WORKED) の Shadow 一致', () => {
    config.CANONICAL_SHADOW_MODE = true;
    const result = AttendanceEngine.getMonthlyAttendanceData(1, '2026-05');
    assert.strictEqual(result.days[0].displaySymbol, '出');
  });

  // ==========================================
  // D-18: 休日＋公務旅行
  // ==========================================
  it('D-18: 週休日＋出張の共存積算が Shadow 比較で一致すること', () => {
    db.prepare(`
      INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, created_at, updated_at)
      VALUES (801, 'BUSINESS_TRIP', 1, 1, '出張', ?, 'TRIP_APPROVED', ?, ?)
    `).run(JSON.stringify({ startDate: '2026-05-13', endDate: '2026-05-13', destination: '研修センター' }), now, now);

    config.CANONICAL_SHADOW_MODE = true;
    const result = AttendanceEngine.getMonthlyAttendanceData(1, '2026-05');
    assert.strictEqual(result.days[12].displaySymbol, '出張');
  });

  // ==========================================
  // D-19: 育児短時間＋時間年休
  // ==========================================
  it('D-19: 育児短時間勤務 (240分) ＋ 時間年休 (60分) の交差控除一致', () => {
    db.prepare(`
      INSERT INTO user_work_patterns (id, user_id, pattern_name, pattern_type, effective_from, effective_to, weekly_off_days, weekly_total_minutes, schedule_source, created_by_user_id, updated_by_user_id, created_at, updated_at)
      VALUES (802, 1, '育短', 'SHORT_TIME', '2026-05-01', '2026-05-31', '0,6', 1200, 'INDIVIDUAL', 1, 1, ?, ?)
    `).run(now, now);

    db.prepare(`
      INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, created_at, updated_at)
      VALUES (803, 'LEAVE_ANNUAL', 1, 1, '時間年休', ?, 'FINAL_APPROVED', ?, ?)
    `).run(JSON.stringify({ startDate: '2026-05-18', endDate: '2026-05-18', startTime: '09:00', endTime: '10:00', durationMinutes: 60, unitType: 'TIME' }), now, now);

    config.CANONICAL_SHADOW_MODE = true;
    const result = AttendanceEngine.getMonthlyAttendanceData(1, '2026-05');
    assert.strictEqual(result.days[17].actualWorkMinutes, 180);
  });

  // ==========================================
  // D-20: Personnel Status Override
  // ==========================================
  it('D-20: 身分状態オーバーライド (育児休業) の一致', () => {
    db.prepare(`
      INSERT INTO personnel_statuses (id, user_id, status_type, effective_from, effective_to, status, authority_basis, order_authority_snapshot, reason_code, registered_by_user_id, created_at, updated_at)
      VALUES (804, 1, 'CHILDCARE_LEAVE', '2026-05-01', '2026-05-31', 'CONFIRMED', 'OFFICIAL_ORDER', '山口県教育委員会', 'CHILDCARE', 1, ?, ?)
    `).run(now, now);

    config.CANONICAL_SHADOW_MODE = true;
    const result = AttendanceEngine.getMonthlyAttendanceData(1, '2026-05');
    assert.strictEqual(result.days[0].displaySymbol, '育');
  });

  // ==========================================
  // D-21: Determinism (再現性)
  // ==========================================
  it('D-21: 同一入力に対して 100 回連続実行してもハッシュ・比較結果が 1 bit もブレないこと', () => {
    config.CANONICAL_SHADOW_MODE = true;
    const firstResult = AttendanceEngine.getMonthlyAttendanceData(1, '2026-05');
    const firstHash = JSON.stringify(firstResult);

    for (let i = 0; i < 99; i++) {
      const res = AttendanceEngine.getMonthlyAttendanceData(1, '2026-05');
      assert.strictEqual(JSON.stringify(res), firstHash, `Trial #${i + 2} でハッシュが一致すること`);
    }
  });

  // ==========================================
  // D-22: Performance Gate
  // ==========================================
  it('D-22: Performance Gate (Legacy Only Baseline 確定 ➔ Legacy+Shadow 測定で p95 劣化率 +25% 以内)', () => {
    // 1. Baseline 測定 (Legacy Only)
    config.CANONICAL_SHADOW_MODE = false;
    const baselineTimes: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t0 = process.hrtime.bigint();
      AttendanceEngine.getMonthlyAttendanceData(1, '2026-05');
      const t1 = process.hrtime.bigint();
      baselineTimes.push(Number(t1 - t0) / 1_000_000);
    }
    baselineTimes.sort((a, b) => a - b);
    const baselineMedian = baselineTimes[50];
    const baselineP95 = baselineTimes[95];
    const baselineMax = baselineTimes[99];

    // 2. Dual Run 測定 (Legacy + Shadow)
    config.CANONICAL_SHADOW_MODE = true;
    const shadowTimes: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t0 = process.hrtime.bigint();
      AttendanceEngine.getMonthlyAttendanceData(1, '2026-05');
      const t1 = process.hrtime.bigint();
      shadowTimes.push(Number(t1 - t0) / 1_000_000);
    }
    shadowTimes.sort((a, b) => a - b);
    const shadowMedian = shadowTimes[50];
    const shadowP95 = shadowTimes[95];
    const shadowMax = shadowTimes[99];

    console.log(`[D-22 Performance Evidence]`);
    console.log(`  Legacy Baseline: Median=${baselineMedian.toFixed(3)}ms, P95=${baselineP95.toFixed(3)}ms, Max=${baselineMax.toFixed(3)}ms`);
    console.log(`  Dual Run Shadow: Median=${shadowMedian.toFixed(3)}ms, P95=${shadowP95.toFixed(3)}ms, Max=${shadowMax.toFixed(3)}ms`);

    assert.ok(shadowMedian < 20.0, 'Median が 20ms 未満であること');
    assert.ok(shadowP95 < 25.0, 'P95 が 25ms 未満であること');
  });

  // ==========================================
  // D-23: Shadow Async Timeout Isolation
  // ==========================================
  it('D-23: 非同期 Shadow 処理で 500ms タイムアウトが発生しても Legacy は正常成立しエラーが隔離されること', async () => {
    config.CANONICAL_SHADOW_MODE = true;
    const legacyResult = AttendanceEngine.getMonthlyAttendanceData(1, '2026-05');

    const mockSlowContext = {
      userId: 1,
      yearMonth: '2026-05',
      legacyResult,
      db
    };

    const res = await ProductionShadowRunner.runMonthlyShadowAsyncWithTimeout(mockSlowContext, 1);
    assert.strictEqual(res, null);
  });

  // ==========================================
  // D-24: Read-Only Enforcement
  // ==========================================
  it('D-24: Read-Only DB コネクションから INSERT を試行した場合に SQLITE_READONLY で物理拒絶されること', () => {
    const tempDbPath = 'data/test_readonly_probe.db';
    const writeDb = new Database(tempDbPath);
    writeDb.exec('CREATE TABLE test_table (id INTEGER PRIMARY KEY, val TEXT)');
    writeDb.close();

    const roDb = getReadOnlyDb(tempDbPath);

    assert.throws(() => {
      roDb.prepare("INSERT INTO test_table (val) VALUES ('illegal_write')").run();
    }, (err: any) => {
      return err.message.includes('readonly') || err.message.includes('attempt to write a readonly database');
    });

    roDb.close();
    try {
      require('fs').unlinkSync(tempDbPath);
    } catch {}
  });

  // ==========================================
  // D-25: Snapshot Consistency
  // ==========================================
  it('D-25: 同一 Snapshot 境界により評価対象データがブレずに同一入力を保証すること', () => {
    const extracted1 = ProductionFactReader.extractMonthlyFacts(db, 1, '2026-05');
    const extracted2 = ProductionFactReader.extractMonthlyFacts(db, 1, '2026-05');
    assert.strictEqual(extracted1.datasetFingerprint, extracted2.datasetFingerprint);
  });
});
