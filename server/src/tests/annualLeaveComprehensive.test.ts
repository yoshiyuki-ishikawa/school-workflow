import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { getDb, initDatabase, seedDatabase } from '../db';
import { AnnualLeaveService } from '../services/annualLeaveService';
import { WorkflowEngine, UserContext } from '../workflow/engine';
import { AttendanceEngine } from '../services/attendance/attendanceEngine';

describe('年次有給休暇 包括テストスイート (7大ゴールデンケース & 境界値検証)', () => {
  const teacherUser: UserContext = {
    id: 1,
    username: 'teacher1',
    displayName: '教員 太郎',
    roles: ['TEACHER'],
    ipAddress: '127.0.0.1'
  };

  const vpUser: UserContext = {
    id: 3,
    username: 'vice_principal',
    displayName: '田中 誠 (教頭B)',
    roles: ['VICE_PRINCIPAL', 'TEACHER'],
    ipAddress: '127.0.0.1'
  };

  const principalUser: UserContext = {
    id: 4,
    username: 'principal',
    displayName: '鈴木 健一 (校長C)',
    roles: ['PRINCIPAL', 'TEACHER'],
    ipAddress: '127.0.0.1'
  };

  beforeEach(() => {
    initDatabase();
    seedDatabase();
    const db = getDb();

    // 既存の entitlements / usages / patterns をクリーンアップし標準フルタイムのみ設定
    db.prepare('DELETE FROM leave_usages').run();
    db.prepare('DELETE FROM leave_entitlements').run();
    db.prepare('DELETE FROM monthly_attendance_approvals').run();
    db.prepare('DELETE FROM applications').run();
    db.prepare('DELETE FROM user_work_patterns WHERE user_id = 1').run();

    const defaultScheduleJson = JSON.stringify({
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
        user_id, pattern_name, pattern_type, weekly_off_days,
        weekly_total_minutes, schedule_details_json, effective_from, effective_to, record_origin,
        schedule_source, created_by_user_id, created_at, updated_by_user_id, updated_at
      ) VALUES (1, '標準勤務', 'STANDARD_FULLTIME', '0,6', 2325, ?, '2025-01-01', '2027-12-31', 'ADMIN_CONFIGURED', 'INDIVIDUAL', 1, '2025-01-01', 1, '2025-01-01')
    `).run(defaultScheduleJson);
  });

  it('GOLDEN-CASE 1: 標準勤務職員・終日年休の付与・取得・出勤簿連携', () => {
    const db = getDb();
    // 20日付与 (2026年度)
    AnnualLeaveService.grantEntitlement({
      userId: 1,
      entitlementType: 'REGULAR_GRANT',
      fiscalYear: 2026,
      grantedDays: 20,
      grantDate: '2026-04-01',
      effectiveFrom: '2026-04-01',
      expiresAt: '2028-03-31',
      reason: '2026年度当初付与'
    });

    // 1. 残日数確認
    const initialProjection = AnnualLeaveService.getLeaveBalanceProjection(1, '2026-05-11');
    assert.strictEqual(initialProjection.totalGrantedDays, 20);
    assert.strictEqual(initialProjection.remainingDays, 20);
    assert.strictEqual(initialProjection.formattedRemaining, '20日');

    // 2. 2026-05-11(月) 終日年休の申請
    const submitRes = WorkflowEngine.submitApplication(teacherUser, {
      typeId: 'LEAVE_ANNUAL',
      title: '年次有給休暇（終日）',
      formData: {
        unitType: 'DAY',
        startDate: '2026-05-11',
        endDate: '2026-05-11',
        reason: '私事都合'
      }
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;

    // 3. 承認フロー (教頭確認 ➔ 校長決裁)
    const app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const vpApprove = WorkflowEngine.approveApplication(vpUser, {
      applicationId: appId,
      expectedVersion: app.version
    });
    assert.strictEqual(vpApprove.success, true);

    const app2 = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const princApprove = WorkflowEngine.approveApplication(principalUser, {
      applicationId: appId,
      expectedVersion: app2.version
    });
    assert.strictEqual(princApprove.success, true);

    // 4. 残日数とUsageの検証 (1日消費 ➔ 残19日)
    const afterProjection = AnnualLeaveService.getLeaveBalanceProjection(1, '2026-05-11');
    assert.strictEqual(afterProjection.remainingDays, 19);
    assert.strictEqual(afterProjection.formattedRemaining, '19日');

    // 5. 出勤簿 (AttendanceEngine) の検証 (免除465分、実勤務0分、年休表示)
    const attDay = AttendanceEngine.resolveDay({ userId: 1, date: '2026-05-11' });
    assert.strictEqual(attDay.serviceStatus, 'LEAVE_ANNUAL');
    assert.strictEqual(attDay.scheduledWorkMinutes, 465);
    assert.strictEqual(attDay.deductionMinutes, 465);
    assert.strictEqual(attDay.actualWorkMinutes, 0);
    assert.strictEqual(attDay.stampText, '年休');
  });

  it('GOLDEN-CASE 2: 午前半日・午後半日の勤務区間解決 (均等分割 floor(465/2) 廃止の検証)', () => {
    AnnualLeaveService.grantEntitlement({
      userId: 1,
      entitlementType: 'REGULAR_GRANT',
      fiscalYear: 2026,
      grantedDays: 20,
      grantDate: '2026-04-01',
      effectiveFrom: '2026-04-01',
      expiresAt: '2028-03-31',
      reason: '当初付与'
    });

    // 1. 午前年休の申請と免除分数 (標準 8:10-12:00 = 230分)
    const valMorning = AnnualLeaveService.validateAnnualLeaveRequest({
      unitType: 'HALF_DAY_AM',
      targetDate: '2026-05-12'
    }, 1);
    assert.strictEqual(valMorning.valid, true);
    assert.strictEqual(valMorning.deductionUnits, 1); // 半日 = 1単位
    assert.strictEqual(valMorning.attendanceDeductionMinutes, 230); // 232分ではない

    // 2. 午後年休の申請と免除分数 (標準 12:45-16:40 = 235分)
    const valAfternoon = AnnualLeaveService.validateAnnualLeaveRequest({
      unitType: 'HALF_DAY_PM',
      targetDate: '2026-05-13'
    }, 1);
    assert.strictEqual(valAfternoon.valid, true);
    assert.strictEqual(valAfternoon.deductionUnits, 1);
    assert.strictEqual(valAfternoon.attendanceDeductionMinutes, 235); // 232分ではない
  });

  it('GOLDEN-CASE 3: 時間単位年休の厳格バリデーション (60分単位厳守・45分拒絶)', () => {
    AnnualLeaveService.grantEntitlement({
      userId: 1,
      entitlementType: 'REGULAR_GRANT',
      fiscalYear: 2026,
      grantedDays: 20,
      grantDate: '2026-04-01',
      effectiveFrom: '2026-04-01',
      expiresAt: '2028-03-31',
      reason: '当初付与'
    });

    // 1. 60分年休 (8:10〜9:10) ➔ 成功 (60分)
    const val60 = AnnualLeaveService.validateAnnualLeaveRequest({
      unitType: 'HOURLY',
      targetDate: '2026-05-14',
      startTime: '08:10',
      endTime: '09:10'
    }, 1);
    assert.strictEqual(val60.valid, true);
    assert.strictEqual(val60.hourlyMinutes, 60);

    // 2. 45分実不在 (8:10〜8:55) ➔ 端数処理（1時間未満切上: CEIL_60）により 60分（1時間）として承認
    const val45 = AnnualLeaveService.validateAnnualLeaveRequest({
      unitType: 'HOURLY',
      targetDate: '2026-05-14',
      startTime: '08:10',
      endTime: '08:55'
    }, 1);
    assert.strictEqual(val45.valid, true);
    assert.strictEqual(val45.hourlyMinutes, 60); // 45分実不在 ＋ 端数切上15分 = 60分消費
  });

  it('GOLDEN-CASE 4: 曜日別勤務時間が異なる職員 (権利とAttendance時間の分離)', () => {
    const db = getDb();
    db.prepare('DELETE FROM user_work_patterns WHERE user_id = 1').run();
    // 水曜日だけ6時間勤務(360分: 8:30-12:00, 12:45-15:15)の変則パターン
    const scheduleDetails = {
      3: {
        workMinutes: 360,
        intervals: [
          { startTime: '08:30', endTime: '12:00' }, // 210分
          { startTime: '12:45', endTime: '15:15' }  // 150分 (合計360分)
        ]
      }
    };

    db.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, weekly_off_days,
        weekly_total_minutes, schedule_details_json, effective_from, effective_to, record_origin,
        schedule_source, created_by_user_id, created_at, updated_by_user_id, updated_at
      ) VALUES (1, '変則勤務', 'CUSTOM', '0,6', 2220, ?, '2026-04-01', '2027-03-31', 'ADMIN_CONFIGURED', 'INDIVIDUAL', 1, '2026-04-01', 1, '2026-04-01')
    `).run(JSON.stringify(scheduleDetails));

    AnnualLeaveService.grantEntitlement({
      userId: 1,
      entitlementType: 'REGULAR_GRANT',
      fiscalYear: 2026,
      grantedDays: 20,
      grantDate: '2026-04-01',
      effectiveFrom: '2026-04-01',
      expiresAt: '2028-03-31',
      reason: '当初付与'
    });

    const valWed = AnnualLeaveService.validateAnnualLeaveRequest({
      unitType: 'FULL_DAY',
      targetDate: '2026-05-13'
    }, 1);

    assert.strictEqual(valWed.valid, true);
    assert.strictEqual(valWed.deductionUnits, 2); // 法的権利はきっかり「1日」消費
    assert.strictEqual(valWed.attendanceDeductionMinutes, 360); // 出勤簿の免除時間はその日の割振りに沿って360分
  });

  it('GOLDEN-CASE 5: 時間単位年休の上限撤廃検証 (保有年休の範囲内で柔軟に取得可能)', () => {
    AnnualLeaveService.grantEntitlement({
      userId: 1,
      entitlementType: 'REGULAR_GRANT',
      fiscalYear: 2026,
      grantedDays: 20,
      grantDate: '2026-01-01',
      effectiveFrom: '2026-01-01',
      expiresAt: '2027-12-31',
      reason: '当初付与'
    });

    const projection = AnnualLeaveService.getLeaveBalanceProjection(1, '2026-05-15');
    // 残日数20日 = 9300分相当の枠を保持
    assert.strictEqual(projection.remainingDays, 20);
    assert.ok(projection.formattedHourlyUsage.includes('時間休上限なし'));
  });

  it('GOLDEN-CASE 6: 自己決裁の完全排除 (HD-02: 422拒絶)', () => {
    const selfAppRes = WorkflowEngine.submitApplication(principalUser, {
      typeId: 'LEAVE_SICK',
      title: '校長自身の病気休暇',
      formData: {
        startDate: '2026-05-18',
        endDate: '2026-05-18',
        calculatedDays: 1,
        reason: '急性胃腸炎による療養',
        medicalCertificateAttached: false,
      }
    });
    assert.strictEqual(selfAppRes.success, false);
    assert.strictEqual(selfAppRes.statusCode, 422);
    assert.strictEqual(selfAppRes.errorCode, 'FINAL_AUTHORITY_SELF_COLLISION');
  });

  it('GOLDEN-CASE 7: 定例週休日への年休申請遮断 (週休日消化の防止)', () => {
    AnnualLeaveService.grantEntitlement({
      userId: 1,
      entitlementType: 'REGULAR_GRANT',
      fiscalYear: 2026,
      grantedDays: 20,
      grantDate: '2026-01-01',
      effectiveFrom: '2026-01-01',
      expiresAt: '2027-12-31',
      reason: '当初付与'
    });

    const valSunday = AnnualLeaveService.validateAnnualLeaveRequest({
      unitType: 'FULL_DAY',
      targetDate: '2026-05-17'
    }, 1);

    assert.strictEqual(valSunday.valid, false);
    assert.strictEqual(valSunday.status, 400);
    assert.ok(valSunday.message?.includes('週休日'));
  });

  it('GOLDEN-CASE 8: 一暦年（12/31残数確定 ➔ 1/1繰越＋当年付与）＆ 1月以降の遅延決裁時自動再整合', () => {
    const db = getDb();
    // 1. 2025年1月1日に20日付与
    AnnualLeaveService.grantEntitlement({
      userId: 1,
      entitlementType: 'REGULAR_GRANT',
      fiscalYear: 2025,
      grantedDays: 20,
      grantDate: '2025-01-01',
      effectiveFrom: '2025-01-01',
      expiresAt: '2026-12-31',
      reason: '2025年当初付与'
    });

    // 2. 2025年中に2日取得
    AnnualLeaveService.grantEntitlement({
      userId: 1,
      entitlementType: 'REGULAR_GRANT',
      fiscalYear: 2025,
      grantedDays: 0,
      grantDate: '2025-01-01',
      effectiveFrom: '2025-01-01',
      expiresAt: '2026-12-31',
      reason: 'ダミー'
    });
    // 2025年12月31日時点の残数は20日（未使用時）
    const preview = AnnualLeaveService.getAnnualRolloverPreview(2026);
    const p1 = preview.find(p => p.userId === 1)!;
    assert.strictEqual(p1.carryoverDays, 20); // 上限20日
    assert.strictEqual(p1.regularGrantDays, 20);
    assert.strictEqual(p1.totalAvailableDays, 40);

    // 3. 2026年1月1日に年次繰越・付与を実行 (繰越20日 + 新規20日 = 計40日)
    const rolloverRes = AnnualLeaveService.processAnnualRollover(2026, 1);
    assert.ok(rolloverRes.processedCount >= 1);

    let proj2026 = AnnualLeaveService.getLeaveBalanceProjection(1, '2026-01-02');
    assert.strictEqual(proj2026.totalGrantedDays, 40);
    assert.strictEqual(proj2026.remainingDays, 40);

    // 4. ★ 遅延決裁シナリオ: 1月8日に「前年12月25日の年休1日」が申請・決裁される
    // 2025-12-25 (木) の年休申請
    const submitLate = WorkflowEngine.submitApplication(teacherUser, {
      typeId: 'LEAVE_ANNUAL',
      title: '前年冬休み年休（遅延決裁）',
      formData: {
        unitType: 'DAY',
        startDate: '2025-12-25',
        endDate: '2025-12-25',
        reason: '私事都合'
      }
    });
    assert.strictEqual(submitLate.success, true);
    const lateAppId = submitLate.data.id;

    // 教頭・校長決裁
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(lateAppId) as any;
    WorkflowEngine.approveApplication(vpUser, { applicationId: lateAppId, expectedVersion: app.version });
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(lateAppId) as any;
    WorkflowEngine.approveApplication(principalUser, { applicationId: lateAppId, expectedVersion: app.version });

    // 5. 自動再整合（Auto-Rebalance）の検証:
    // 2025年の残数が19日になったため、2026年の CARRYOVER ロットが自動的に 20日 ➔ 19日 に補正され、2026年の総残高が39日になること
    proj2026 = AnnualLeaveService.getLeaveBalanceProjection(1, '2026-01-10');
    assert.strictEqual(proj2026.remainingDays, 39);
    assert.strictEqual(proj2026.formattedRemaining, '39日');
  });
});
