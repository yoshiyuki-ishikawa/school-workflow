import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { setDb } from '../db/database';
import { migrator } from '../db/migrations';
import { SCHEMA_SQL } from '../db/schema';
import { seedDatabase } from '../db/seeds';
import { LeaveCalculationService, CALCULATION_ENGINE_VERSION } from '../services/leave/leaveCalculationService';
import { AnnualLeaveService } from '../services/annualLeaveService';
import { WorkflowEngine } from '../workflow/engine';

describe('Leave Calculation Comprehensive Suite (Snapshot, Idempotency, Semantic HalfDay, RBAC, FailClosed)', () => {
  let db: any;

  before(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    migrator.runMigrations(db);
    setDb(db);
    seedDatabase();

    // 勤務パターン登録 (佐藤花子 id: 2: 8:10〜16:40, 休憩 12:00〜12:45)
    db.prepare('DELETE FROM user_work_patterns WHERE user_id = 2').run();
    const s465 = JSON.stringify({
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
        weekly_off_days, schedule_details_json, weekly_total_minutes, created_by_user_id, created_at, updated_by_user_id, updated_at
      ) VALUES (2, '通常フルタイム', 'STANDARD_FULLTIME', '2025-01-01', '9999-12-31', '0,6', ?, 2325, 1, '2026-01-01', 1, '2026-01-01')
    `).run(s465);

    // 未登録ユーザー用クリーンアップ
    db.prepare('DELETE FROM user_work_patterns WHERE user_id = 999').run();

    // 年休初期付与 (山田太郎 2026年 20日)
    AnnualLeaveService.grantEntitlement({
      userId: 1, // teacher1 (山田太郎)
      entitlementType: 'REGULAR_GRANT',
      fiscalYear: 2026,
      grantedDays: 20,
      grantDate: '2026-01-01',
      effectiveFrom: '2026-01-01',
      expiresAt: '2027-12-31',
      reason: '2026年定期付与'
    });
  });

  after(() => {
    db.close();
  });

  // 1. Golden Tests
  it('TEST-INT-1: 13:00〜14:15 (Intersection 75分) ➔ 実不在1時間15分 ＋ 切上45分 ＝ 2時間', () => {
    const res = LeaveCalculationService.calculate({
      subjectUserId: 2,
      typeId: 'LEAVE_ANNUAL',
      targetDate: '2026-05-11', // 月曜日
      unitType: 'TIME',
      startTime: '13:00',
      endTime: '14:15'
    });

    assert.strictEqual(res.isValid, true);
    assert.strictEqual(res.snapshot?.netWorkMinutes, 75);
    assert.strictEqual(res.snapshot?.breakOverlapMinutes, 0);
    assert.strictEqual(res.snapshot?.roundingAddedMinutes, 45);
    assert.strictEqual(res.snapshot?.chargedHours, 2);
    assert.strictEqual(res.snapshot?.chargedMinutes, 120);
    assert.strictEqual(res.snapshot?.deductionUnits, 0);
  });

  it('TEST-INT-2: 11:00〜15:00 (昼休憩跨ぎ) ➔ Intersection 195分 (休憩45分控除) ➔ 4時間', () => {
    const res = LeaveCalculationService.calculate({
      subjectUserId: 2,
      typeId: 'LEAVE_ANNUAL',
      targetDate: '2026-05-11',
      unitType: 'TIME',
      startTime: '11:00',
      endTime: '15:00'
    });

    assert.strictEqual(res.isValid, true);
    assert.strictEqual(res.snapshot?.netWorkMinutes, 195);
    assert.strictEqual(res.snapshot?.breakOverlapMinutes, 45);
    assert.strictEqual(res.snapshot?.roundingAddedMinutes, 45);
    assert.strictEqual(res.snapshot?.chargedHours, 4);
    assert.strictEqual(res.snapshot?.chargedMinutes, 240);
  });

  it('TEST-HD-1: 半日年休（午前・午後）の意味的計算', () => {
    const resAm = LeaveCalculationService.calculate({
      subjectUserId: 2,
      typeId: 'LEAVE_ANNUAL',
      targetDate: '2026-05-11',
      unitType: 'HALF_DAY',
      halfDayType: 'MORNING'
    });
    assert.strictEqual(resAm.isValid, true);
    assert.strictEqual(resAm.snapshot?.chargedDays, 0.5);
    assert.strictEqual(resAm.snapshot?.deductionUnits, 1);
    assert.strictEqual(resAm.snapshot?.netWorkMinutes, 230); // 8:10〜12:00

    const resPm = LeaveCalculationService.calculate({
      subjectUserId: 2,
      typeId: 'LEAVE_ANNUAL',
      targetDate: '2026-05-11',
      unitType: 'HALF_DAY',
      halfDayType: 'AFTERNOON'
    });
    assert.strictEqual(resPm.isValid, true);
    assert.strictEqual(resPm.snapshot?.chargedDays, 0.5);
    assert.strictEqual(resPm.snapshot?.deductionUnits, 1);
    assert.strictEqual(resPm.snapshot?.netWorkMinutes, 235); // 12:45〜16:40
  });

  // 2. 境界値テスト
  it('TEST-BOUND-1: 休憩時間中のみの指定 (12:10〜12:40) ➔ Intersection 0分 ➔ Fail-Closed', () => {
    const res = LeaveCalculationService.calculate({
      subjectUserId: 2,
      typeId: 'LEAVE_ANNUAL',
      targetDate: '2026-05-11',
      unitType: 'TIME',
      startTime: '12:10',
      endTime: '12:40'
    });

    assert.strictEqual(res.isValid, false);
    assert.strictEqual(res.errorCode, 'NO_WORK_INTERSECTION');
  });

  it('TEST-BOUND-2: 休憩途中開始 (12:15〜15:00) ➔ 12:45〜15:00の135分のみ正しく算出 ➔ 3時間', () => {
    const res = LeaveCalculationService.calculate({
      subjectUserId: 2,
      typeId: 'LEAVE_ANNUAL',
      targetDate: '2026-05-11',
      unitType: 'TIME',
      startTime: '12:15',
      endTime: '15:00'
    });

    assert.strictEqual(res.isValid, true);
    assert.strictEqual(res.snapshot?.netWorkMinutes, 135);
    assert.strictEqual(res.snapshot?.breakOverlapMinutes, 30); // 12:15〜12:45
    assert.strictEqual(res.snapshot?.roundingAddedMinutes, 45); // 135 -> 180 (3h)
    assert.strictEqual(res.snapshot?.chargedHours, 3);
  });

  it('TEST-BOUND-3: 1分のみ勤務区間 (08:10〜08:11) ➔ 1分 ＋ 切上59分 ＝ 1時間', () => {
    const res = LeaveCalculationService.calculate({
      subjectUserId: 2,
      typeId: 'LEAVE_ANNUAL',
      targetDate: '2026-05-11',
      unitType: 'TIME',
      startTime: '08:10',
      endTime: '08:11'
    });

    assert.strictEqual(res.isValid, true);
    assert.strictEqual(res.snapshot?.netWorkMinutes, 1);
    assert.strictEqual(res.snapshot?.roundingAddedMinutes, 59);
    assert.strictEqual(res.snapshot?.chargedHours, 1);
  });

  // 3. Fail-Closed テスト
  it('TEST-FAIL-1: 勤務パターンが存在しないユーザー ➔ CONTEXT_RESOLUTION_FAILED', () => {
    const res = LeaveCalculationService.calculate({
      subjectUserId: 999, // 存在しないユーザー
      typeId: 'LEAVE_ANNUAL',
      targetDate: '2026-05-11',
      unitType: 'DAY'
    });

    assert.strictEqual(res.isValid, false);
    assert.strictEqual(res.errorCode, 'CONTEXT_RESOLUTION_FAILED');
  });

  it('TEST-FAIL-2: 定例週休日（土日）の申請 ➔ NO_CHARGEABLE_DAYS', () => {
    const res = LeaveCalculationService.calculate({
      subjectUserId: 1,
      typeId: 'LEAVE_ANNUAL',
      targetDate: '2026-05-10', // 日曜日
      unitType: 'DAY'
    });

    assert.strictEqual(res.isValid, false);
    assert.strictEqual(res.errorCode, 'NO_CHARGEABLE_DAYS');
  });

  // 4. Transaction & Idempotency テスト
  it('TEST-IDEMP-1: 同一申請の finalizeUsage を複数回実行してもロット消費は1回のみ (Idempotency保証)', () => {
    const teacherActor = {
      id: 1,
      username: 'teacher1',
      displayName: '山田 太郎 (教員A)',
      roles: ['TEACHER'],
      ipAddress: '127.0.0.1'
    };

    const principalActor = {
      id: 4,
      username: 'principal',
      displayName: '鈴木 健一 (校長C)',
      roles: ['PRINCIPAL'],
      ipAddress: '127.0.0.1'
    };

    // 1. 申請提出 (2時間休: 13:00〜15:00)
    const subRes = WorkflowEngine.submitApplication(teacherActor, {
      typeId: 'LEAVE_ANNUAL',
      title: '【年休】通院2時間',
      formData: {
        unitType: 'TIME',
        targetDate: '2026-05-11',
        startTime: '13:00',
        endTime: '15:00'
      }
    });
    assert.strictEqual(subRes.success, true);
    const appId = subRes.data.id;

    // 2. 承認実行 (教頭 -> 校長)
    const vpActor = {
      id: 3,
      username: 'vice_principal',
      displayName: '田中 誠 (教頭B)',
      roles: ['VICE_PRINCIPAL'],
      ipAddress: '127.0.0.1'
    };
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(vpActor, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '教頭確認'
    });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const appRes = WorkflowEngine.approveApplication(principalActor, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '承認します'
    });
    assert.strictEqual(appRes.success, true);

    // 3. ロット消費状況の確認 (used_hourly_minutes = 120)
    const entBefore = db.prepare('SELECT used_hourly_minutes FROM leave_entitlements WHERE user_id = 1 AND fiscal_year = 2026').get() as any;
    assert.strictEqual(entBefore.used_hourly_minutes, 120);

    // 4. 重複で finalizeUsage を呼び出し (Idempotency 検証)
    AnnualLeaveService.finalizeUsage(appId);
    AnnualLeaveService.finalizeUsage(appId);

    const entAfter = db.prepare('SELECT used_hourly_minutes FROM leave_entitlements WHERE user_id = 1 AND fiscal_year = 2026').get() as any;
    assert.strictEqual(entAfter.used_hourly_minutes, 120, '複数回実行しても使用分数は120分のまま不変であること');

    // 5. CalculationSnapshot の永続化確認
    const usageRow = db.prepare('SELECT calculation_snapshot FROM leave_usages WHERE application_id = ?').get(appId) as any;
    assert.ok(usageRow && usageRow.calculation_snapshot);
    const snap = JSON.parse(usageRow.calculation_snapshot);
    assert.strictEqual(snap.engineVersion, CALCULATION_ENGINE_VERSION);
    assert.strictEqual(snap.chargedHours, 2);
  });

  // 5. Security & Client 改ざん耐性テスト
  it('TEST-SEC-1: Clientが不正な chargedHours を送信しても Server 再計算で正規値が確定されること', () => {
    const teacherActor = {
      id: 1,
      username: 'teacher1',
      displayName: '山田 太郎 (教員A)',
      roles: ['TEACHER'],
      ipAddress: '127.0.0.1'
    };

    const vpActor = {
      id: 3,
      username: 'vice_principal',
      displayName: '田中 誠 (教頭B)',
      roles: ['VICE_PRINCIPAL'],
      ipAddress: '127.0.0.1'
    };

    const principalActor = {
      id: 4,
      username: 'principal',
      displayName: '鈴木 健一 (校長C)',
      roles: ['PRINCIPAL'],
      ipAddress: '127.0.0.1'
    };

    // Clientが改ざん値 (chargedHours: 0, deductionUnits: 0) を送信
    const subRes = WorkflowEngine.submitApplication(teacherActor, {
      typeId: 'LEAVE_ANNUAL',
      title: '【年休】改ざん試行',
      formData: {
        unitType: 'HALF_DAY',
        halfDayType: 'MORNING',
        targetDate: '2026-05-12',
        chargedHours: 0,
        deductionUnits: 0,
        calculatedDays: 0 // 改ざん
      }
    });
    assert.strictEqual(subRes.success, true);
    const appId = subRes.data.id;

    // 承認実行
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(vpActor, {
      applicationId: appId,
      expectedVersion: app.version
    });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(principalActor, {
      applicationId: appId,
      expectedVersion: app.version
    });

    // Server側で正規の半日 (deductionUnits: 1) が引当されていること
    const entRow = db.prepare('SELECT used_half_days FROM leave_entitlements WHERE user_id = 1 AND fiscal_year = 2026').get() as any;
    assert.strictEqual(entRow.used_half_days, 1, 'Client改ざん値に関わらず Server正規値 (1単位) が引当されること');
  });
});
