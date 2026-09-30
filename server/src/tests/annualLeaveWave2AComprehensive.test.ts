import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { setDb, closeDb } from '../db/database';
import { migrator } from '../db/migrations';
import { SCHEMA_SQL } from '../db/schema';
import { seedDatabase } from '../db/seeds';
import { WorkingObligationResolver } from '../services/attendance/workingObligationResolver';
import { AnnualLeavePolicyContextResolver } from '../services/leave/annualLeavePolicyContextResolver';
import { LeaveCalculationService } from '../services/leave/leaveCalculationService';
import { AnnualLeaveService } from '../services/annualLeaveService';

describe('Wave 2A Comprehensive Suite: Annual Leave Canonical Institutional Calculation (GAP-02)', () => {
  let db: any;

  before(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    migrator.runMigrations(db);
    setDb(db);
    seedDatabase();

    // 1. フルタイム職員 (userId: 1) の勤務パターン登録 (8:10〜16:40, 休憩 12:00〜12:45)
    db.prepare('DELETE FROM user_work_patterns WHERE user_id = 1').run();
    const sFull = JSON.stringify({
      "0": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null },
      "1": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
      "2": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
      "3": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
      "4": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
      "5": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
      "6": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null }
    });
    db.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, schedule_details_json, weekly_total_minutes, schedule_source, created_by_user_id, created_at, updated_by_user_id, updated_at
      ) VALUES (1, '通常フルタイム (週5日・土日週休)', 'STANDARD_FULLTIME', '2026-01-01', '9999-12-31', '0,6', ?, 2325, 'INDIVIDUAL', 1, '2026-01-01', 1, '2026-01-01')
    `).run(sFull);

    // 2. 再任用短時間・同一型職員 (userId: 2, 週4日勤務, 8:15〜16:45, 金曜週休)
    db.prepare('DELETE FROM user_work_patterns WHERE user_id = 2').run();
    const sUniform = JSON.stringify({
      "0": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null },
      "1": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
      "2": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
      "3": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
      "4": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
      "5": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null }, // 金曜非勤務
      "6": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null }
    });
    db.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, schedule_details_json, weekly_total_minutes, schedule_source, created_by_user_id, created_at, updated_by_user_id, updated_at
      ) VALUES (2, '再任用短時間・同一型 (週4日)', 'SHORT_TIME', '2026-01-01', '9999-12-31', '0,5,6', ?, 1860, 'INDIVIDUAL', 1, '2026-01-01', 1, '2026-01-01')
    `).run(sUniform);

    // 3. 再任用短時間・非同一型職員 (userId: 3, 曜日別変則勤務)
    db.prepare('DELETE FROM user_work_patterns WHERE user_id = 3').run();
    const sNonUniform = JSON.stringify({
      "0": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null },
      "1": { "isWorkDay": true,  "workMinutes": 240, "startTime": "08:30", "endTime": "12:30", "intervals": [{ "startTime": "08:30", "endTime": "12:30" }] },
      "2": { "isWorkDay": true,  "workMinutes": 360, "startTime": "08:30", "endTime": "15:00", "intervals": [{ "startTime": "08:30", "endTime": "12:00" }, { "startTime": "12:30", "endTime": "15:00" }] },
      "3": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
      "4": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null },
      "5": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null },
      "6": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null }
    });
    db.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, schedule_details_json, weekly_total_minutes, schedule_source, created_by_user_id, created_at, updated_by_user_id, updated_at
      ) VALUES (3, '再任用短時間・非同一型 (変則勤務)', 'CUSTOM', '2026-01-01', '9999-12-31', '0,4,5,6', ?, 1065, 'INDIVIDUAL', 1, '2026-01-01', 1, '2026-01-01')
    `).run(sNonUniform);
  });

  after(() => {
    closeDb();
  });

  beforeEach(() => {
    db.prepare('DELETE FROM leave_usages').run();
    db.prepare('DELETE FROM leave_entitlements').run();
    db.prepare('DELETE FROM application_workflow_cycles').run();
    db.prepare('DELETE FROM applications').run();
  });

  // ==========================================
  // 1. Golden Tests (GT-W2A)
  // ==========================================

  it('GT-W2A-GC-01: 通常勤務者（1日=7h45m） 40日 ➔ 1日取得 ➔ 5時間取得 ➔ 残数 38日2時間45分 検証', () => {
    // 40日付与 (2025年繰越20日 + 2026年定期20日)
    AnnualLeaveService.grantEntitlement({
      userId: 1,
      entitlementType: 'CARRYOVER',
      fiscalYear: 2026,
      grantedDays: 20,
      grantDate: '2026-01-01',
      effectiveFrom: '2026-01-01',
      expiresAt: '2026-12-31',
      reason: '2025年繰越'
    });
    AnnualLeaveService.grantEntitlement({
      userId: 1,
      entitlementType: 'REGULAR_GRANT',
      fiscalYear: 2026,
      grantedDays: 20,
      grantDate: '2026-01-01',
      effectiveFrom: '2026-01-01',
      expiresAt: '2027-12-31',
      reason: '2026年定期付与'
    });

    let balance = AnnualLeaveService.getLeaveBalance(1, '2026-05-11');
    assert.strictEqual(balance.remainingDays, 40);
    assert.strictEqual(balance.remainingMinutes, 0);

    // 1. 1日取得 (2026-05-11 月曜)
    const app1 = db.prepare(`
      INSERT INTO applications (type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, created_at, updated_at)
      VALUES ('LEAVE_ANNUAL', 1, 1, '年休1日', '{"targetDate":"2026-05-11","unitType":"FULL_DAY"}', 'APPROVED', DATETIME('now'), DATETIME('now'))
    `).run();
    AnnualLeaveService.finalizeUsage(Number(app1.lastInsertRowid));

    balance = AnnualLeaveService.getLeaveBalance(1, '2026-05-11');
    assert.strictEqual(balance.remainingDays, 39);
    assert.strictEqual(balance.remainingMinutes, 0);

    // 2. 5時間取得 (2026-05-12 火曜 08:10〜13:55 = Intersection 300分 = 5h)
    const app2 = db.prepare(`
      INSERT INTO applications (type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, created_at, updated_at)
      VALUES ('LEAVE_ANNUAL', 1, 1, '年休5時間', '{"targetDate":"2026-05-12","unitType":"HOURLY","startTime":"08:10","endTime":"13:55"}', 'APPROVED', DATETIME('now'), DATETIME('now'))
    `).run();
    AnnualLeaveService.finalizeUsage(Number(app2.lastInsertRowid));

    balance = AnnualLeaveService.getLeaveBalance(1, '2026-05-12');
    // 39日 - 5時間 = 38日 + (7時間45分 - 5時間) = 38日 2時間45分 (165分)
    assert.strictEqual(balance.remainingDays, 38);
    assert.strictEqual(balance.remainingMinutes, 165);
    assert.strictEqual(balance.formattedBalanceText, '38日 2時間45分');
  });

  it('GT-W2A-GC-02: 時間休累積（5h + 3h = 8h ➔ 1日15分相当）繰上げ正規化検証', () => {
    AnnualLeaveService.grantEntitlement({
      userId: 1,
      entitlementType: 'REGULAR_GRANT',
      fiscalYear: 2026,
      grantedDays: 20,
      grantDate: '2026-01-01',
      effectiveFrom: '2026-01-01',
      expiresAt: '2027-12-31',
      reason: '2026年定期付与'
    });

    // 5時間取得
    const app1 = db.prepare(`
      INSERT INTO applications (type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, created_at, updated_at)
      VALUES ('LEAVE_ANNUAL', 1, 1, '年休5h', '{"targetDate":"2026-05-11","unitType":"HOURLY","startTime":"08:10","endTime":"13:55"}', 'APPROVED', DATETIME('now'), DATETIME('now'))
    `).run();
    AnnualLeaveService.finalizeUsage(Number(app1.lastInsertRowid));

    // 3時間取得 (13:40〜16:40 = 3h)
    const app2 = db.prepare(`
      INSERT INTO applications (type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, created_at, updated_at)
      VALUES ('LEAVE_ANNUAL', 1, 1, '年休3h', '{"targetDate":"2026-05-12","unitType":"HOURLY","startTime":"13:40","endTime":"16:40"}', 'APPROVED', DATETIME('now'), DATETIME('now'))
    `).run();
    AnnualLeaveService.finalizeUsage(Number(app2.lastInsertRowid));

    const balance = AnnualLeaveService.getLeaveBalance(1, '2026-05-12');
    // 20日 (9300分) - 8時間 (480分) = 8820分 = 18日 450分 (18日 7時間30分)
    // 20日 - 1日15分 = 18日 7時間30分
    assert.strictEqual(balance.remainingDays, 18);
    assert.strictEqual(balance.remainingMinutes, 450);
    assert.strictEqual(balance.formattedBalanceText, '18日 7時間30分');
  });

  it('GT-W2A-GC-03: 人事委員会通知要件に基づく半日年休適格性検証', () => {
    const ctx = AnnualLeavePolicyContextResolver.resolve(1, '2026-05-11');
    assert.strictEqual(ctx.halfDayEligibility, 'ELIGIBLE');

    const calcAm = LeaveCalculationService.calculate({
      subjectUserId: 1,
      typeId: 'LEAVE_ANNUAL',
      targetDate: '2026-05-11',
      unitType: 'HALF_DAY',
      halfDayType: 'MORNING'
    });
    assert.strictEqual(calcAm.isValid, true);
    assert.strictEqual(calcAm.totalChargedDays, 0.5);
    assert.strictEqual(calcAm.entitlementDeduction?.deductionHalfUnits, 1);
  });

  it('GT-W2A-GC-04: 再任用短時間・同一型（userId: 2）: DAY/TIME 許可 ＆ HALF 拒絶検証', () => {
    const ctx = AnnualLeavePolicyContextResolver.resolve(2, '2026-05-11');
    assert.deepStrictEqual(ctx.allowedAcquisitionUnits, ['DAY', 'TIME']);
    assert.strictEqual(ctx.halfDayEligibility, 'NOT_ELIGIBLE');

    // 1日申請: 許可
    const calcDay = LeaveCalculationService.calculate({
      subjectUserId: 2,
      typeId: 'LEAVE_ANNUAL',
      targetDate: '2026-05-11',
      unitType: 'DAY'
    });
    assert.strictEqual(calcDay.isValid, true);

    // 半日申請: 拒絶 (Fail-Closed)
    const calcHalf = LeaveCalculationService.calculate({
      subjectUserId: 2,
      typeId: 'LEAVE_ANNUAL',
      targetDate: '2026-05-11',
      unitType: 'HALF_DAY',
      halfDayType: 'MORNING'
    });
    assert.strictEqual(calcHalf.isValid, false);
    assert.strictEqual(calcHalf.errorCode, 'UNSUPPORTED_UNIT');
  });

  it('GT-W2A-NONUNIFORM-01: 再任用短時間・非同一型（userId: 3）: 単一 minutesPerDay なしで TIME_ONLY 取得成立・日数付与維持検証', () => {
    const ctx = AnnualLeavePolicyContextResolver.resolve(3, '2026-05-11');
    assert.strictEqual(ctx.patternUniformity, 'NON_UNIFORM');
    assert.strictEqual(ctx.dayConversion.status, 'NOT_APPLICABLE');
    assert.deepStrictEqual(ctx.allowedAcquisitionUnits, ['TIME']);

    // 日単位申請: 拒絶
    const calcDay = LeaveCalculationService.calculate({
      subjectUserId: 3,
      typeId: 'LEAVE_ANNUAL',
      targetDate: '2026-05-11',
      unitType: 'DAY'
    });
    assert.strictEqual(calcDay.isValid, false);
    assert.strictEqual(calcDay.errorCode, 'UNSUPPORTED_UNIT');

    // 時間休申請: 許可 (08:30〜10:30 = 2h)
    const calcTime = LeaveCalculationService.calculate({
      subjectUserId: 3,
      typeId: 'LEAVE_ANNUAL',
      targetDate: '2026-05-11',
      unitType: 'TIME',
      startTime: '08:30',
      endTime: '10:30'
    });
    assert.strictEqual(calcTime.isValid, true);
    assert.strictEqual(calcTime.totalChargedHours, 2);
  });

  it('GT-W2A-RANGE-01: 金〜月（4日間）申請 ➔ 土日が週休日の場合 2日消費検証（土日除外）', () => {
    AnnualLeaveService.grantEntitlement({
      userId: 1,
      entitlementType: 'REGULAR_GRANT',
      fiscalYear: 2026,
      grantedDays: 20,
      grantDate: '2026-01-01',
      effectiveFrom: '2026-01-01',
      expiresAt: '2027-12-31',
      reason: '2026年定期付与'
    });

    // 2026-05-08(金) 〜 2026-05-11(月) の4日間
    const res = LeaveCalculationService.calculate({
      subjectUserId: 1,
      typeId: 'LEAVE_ANNUAL',
      startDate: '2026-05-08',
      endDate: '2026-05-11',
      unitType: 'DAY'
    });

    assert.strictEqual(res.isValid, true);
    assert.strictEqual(res.chargeableDaysCount, 2);
    assert.strictEqual(res.skippedNonWorkingDaysCount, 2);
    assert.strictEqual(res.totalChargedDays, 2);
    assert.strictEqual(res.entitlementDeduction?.deductionHalfUnits, 4); // 2日 = 4半日単位
  });

  it('GT-W2A-GC-06 & GC-07: 勤務形態変更時の調整日数算定 ＆ Type A 再換算検証', () => {
    AnnualLeaveService.grantEntitlement({
      userId: 1,
      entitlementType: 'REGULAR_GRANT',
      fiscalYear: 2026,
      grantedDays: 20,
      grantDate: '2026-01-01',
      effectiveFrom: '2026-01-01',
      expiresAt: '2027-12-31',
      reason: '2026年定期付与'
    });

    // 1. フルタイム(20日) ➔ 再任用週4日(16日) へ変更 (差分 -4日)
    const conv1 = AnnualLeaveService.convertWorkingPatternLeaveBalance({
      userId: 1,
      changeDate: '2026-09-01',
      oldPatternType: 'FULLTIME_STANDARD',
      newPatternType: 'REAPPOINTED_UNIFORM',
      oldStandardDays: 20,
      newStandardDays: 16,
      reason: '定年退職に伴う再任用短時間（週4日）移行'
    });

    assert.strictEqual(conv1.adjustmentDays, -4);
    assert.strictEqual(conv1.newRemainingDays, 16);

    // 2. 再任用週4日(16日) ➔ 再任用週3日(12日) へ変更 (差分 -4日)
    const conv2 = AnnualLeaveService.convertWorkingPatternLeaveBalance({
      userId: 1,
      changeDate: '2026-11-01',
      oldPatternType: 'REAPPOINTED_UNIFORM',
      newPatternType: 'REAPPOINTED_UNIFORM',
      oldStandardDays: 16,
      newStandardDays: 12,
      reason: '週3日勤務への割振り変更'
    });

    assert.strictEqual(conv2.adjustmentDays, -4);
    assert.strictEqual(conv2.newRemainingDays, 12);
  });

  it('GT-W2A-CAN-01: 承認後取消における Exact-Reversal 方式の元ロット完全復元検証', () => {
    AnnualLeaveService.grantEntitlement({
      userId: 1,
      entitlementType: 'REGULAR_GRANT',
      fiscalYear: 2026,
      grantedDays: 20,
      grantDate: '2026-01-01',
      effectiveFrom: '2026-01-01',
      expiresAt: '2027-12-31',
      reason: '2026年定期付与'
    });

    // 1日年休を申請・確定
    const app = db.prepare(`
      INSERT INTO applications (type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, created_at, updated_at)
      VALUES ('LEAVE_ANNUAL', 1, 1, '年休1日', '{"targetDate":"2026-05-11","unitType":"FULL_DAY"}', 'APPROVED', DATETIME('now'), DATETIME('now'))
    `).run();
    const appId = Number(app.lastInsertRowid);
    AnnualLeaveService.finalizeUsage(appId);

    let bal = AnnualLeaveService.getLeaveBalance(1, '2026-05-11');
    assert.strictEqual(bal.remainingDays, 19);

    // 取消ワークフローサイクルの登録 (FK制約充足)
    const cycle = db.prepare(`
      INSERT INTO application_workflow_cycles (
        application_id, approval_cycle, workflow_source, cycle_purpose, status, started_by_user_id, started_at
      ) VALUES (?, 2, 'LEGACY_SNAPSHOT', 'CANCELLATION', 'APPROVED', 1, DATETIME('now'))
    `).run(appId);
    const cycleId = Number(cycle.lastInsertRowid);

    // 取消実行 (Exact Reversal)
    AnnualLeaveService.reconcileLeaveLedgerOnCancellation({
      applicationId: appId,
      userId: 1,
      cancellationCycleId: cycleId,
      reason: '出張予定変更による取消'
    });

    bal = AnnualLeaveService.getLeaveBalance(1, '2026-05-11');
    assert.strictEqual(bal.remainingDays, 20); // 完全復元
  });

  // ==========================================
  // 2. Failure Injection Tests (FI-W2A)
  // ==========================================

  it('FI-W2A-HALF-01: 短時間勤務職員における半日申請試行 ➔ UNSUPPORTED_UNIT エラー', () => {
    const res = LeaveCalculationService.calculate({
      subjectUserId: 2,
      typeId: 'LEAVE_ANNUAL',
      targetDate: '2026-05-11',
      unitType: 'HALF_DAY',
      halfDayType: 'MORNING'
    });
    assert.strictEqual(res.isValid, false);
    assert.strictEqual(res.errorCode, 'UNSUPPORTED_UNIT');
  });

  it('FI-W2A-RANGE-UNIT-01: 複数日期間での TIME または HALF_DAY 申請試行 ➔ UNSUPPORTED_RANGE_UNIT エラー', () => {
    const resTime = LeaveCalculationService.calculate({
      subjectUserId: 1,
      typeId: 'LEAVE_ANNUAL',
      startDate: '2026-05-11',
      endDate: '2026-05-12',
      unitType: 'TIME',
      startTime: '09:00',
      endTime: '11:00'
    });
    assert.strictEqual(resTime.isValid, false);
    assert.strictEqual(resTime.errorCode, 'UNSUPPORTED_RANGE_UNIT');

    const resHalf = LeaveCalculationService.calculate({
      subjectUserId: 1,
      typeId: 'LEAVE_ANNUAL',
      startDate: '2026-05-11',
      endDate: '2026-05-12',
      unitType: 'HALF_DAY',
      halfDayType: 'MORNING'
    });
    assert.strictEqual(resHalf.isValid, false);
    assert.strictEqual(resHalf.errorCode, 'UNSUPPORTED_RANGE_UNIT');
  });

  it('FI-W2A-CONTEXT-01: 勤務パターン未登録職員の申請試行 ➔ CONTEXT_RESOLUTION_FAILED', () => {
    const res = LeaveCalculationService.calculate({
      subjectUserId: 9999, // 存在しないユーザー
      typeId: 'LEAVE_ANNUAL',
      targetDate: '2026-05-11',
      unitType: 'DAY'
    });
    assert.strictEqual(res.isValid, false);
    assert.strictEqual(res.errorCode, 'CONTEXT_RESOLUTION_FAILED');
  });

  it('FI-W2A-CONV-POLICY-01: 未定義の Conversion Policy (NON_UNIFORM変更) 試行 ➔ Fail-Closed', () => {
    assert.throws(() => {
      AnnualLeaveService.convertWorkingPatternLeaveBalance({
        userId: 1,
        changeDate: '2026-09-01',
        oldPatternType: 'FULLTIME_STANDARD',
        newPatternType: 'REAPPOINTED_NON_UNIFORM', // 未定義ポリシー
        oldStandardDays: 20,
        newStandardDays: 16,
        reason: '変則非同一型への移行'
      });
    }, /CONVERSION_POLICY_UNRESOLVED/);
  });
});
