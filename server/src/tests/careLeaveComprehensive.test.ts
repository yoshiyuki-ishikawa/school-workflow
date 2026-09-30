import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { setDb } from '../db/database';
import { SCHEMA_SQL } from '../db/schema';
import { migrator } from '../db/migrations';
import { seedDatabase } from '../db/seeds';
import { AttendanceEngine } from '../services/attendance/attendanceEngine';
import { WorkflowEngine } from '../workflow/engine';
import { SnapshotService } from '../services/snapshotService';

describe('山口県勤務条例第15条「介護休暇」包括テストスイート (Care Leave Comprehensive Tests)', () => {
  let db: any;
  const testUserId = 1; // teacher1
  let testCareCaseId: number;
  let testCarePeriodId: number;

  const userTeacher = {
    id: 1,
    username: 'teacher1',
    displayName: '教諭 太郎',
    roles: ['TEACHER'],
    ipAddress: '127.0.0.1'
  };

  const userVice = {
    id: 3,
    username: 'vice_principal',
    displayName: '教頭 太郎',
    roles: ['VICE_PRINCIPAL'],
    ipAddress: '127.0.0.1'
  };

  const userPrincipal = {
    id: 4,
    username: 'principal',
    displayName: '校長 一郎',
    roles: ['PRINCIPAL'],
    ipAddress: '127.0.0.1'
  };

  before(() => {
    db = new Database(':memory:');
    setDb(db);
    db.exec(SCHEMA_SQL);
    migrator.runMigrations(db);
    seedDatabase();
  });

  beforeEach(() => {
    try {
      // 申請・介護ケース・承認ステップ・スナップショットのクリーンアップ
      db.prepare('DELETE FROM monthly_attendance_snapshots').run();
      db.prepare('DELETE FROM monthly_attendance_snapshot_days').run();
      db.prepare('DELETE FROM application_approval_steps').run();
      db.prepare('DELETE FROM applications').run();
      db.prepare('DELETE FROM care_periods').run();
      db.prepare('DELETE FROM care_cases').run();

      // 介護ケース作成
      const resCase = db.prepare(`
        INSERT INTO care_cases (user_id, recipient_relation, recipient_name, condition_summary, created_by_user_id)
        VALUES (?, '実母', '山田花子', '要介護3 通院付添及び身体介護', ?)
      `).run(testUserId, testUserId);
      testCareCaseId = resCase.lastInsertRowid as number;

      // 指定期間作成 (2026-09-01 〜 2026-11-30)
      const resPeriod = db.prepare(`
        INSERT INTO care_periods (care_case_id, period_number, start_date, end_date, status, approved_by_user_id)
        VALUES (?, 1, '2026-09-01', '2026-11-30', 'APPROVED', ?)
      `).run(testCareCaseId, testUserId);
      testCarePeriodId = resPeriod.lastInsertRowid as number;
    } catch (e: any) {
      console.error('[beforeEach Error]', e);
    }
  });

  /**
   * ヘルパー: 申請起案 -> 教頭確認 -> 校長決裁
   */
  function submitAndApproveCareLeave(formData: any) {
    const submitRes = WorkflowEngine.submitApplication(userTeacher, {
      typeId: 'LEAVE_CARE',
      title: '介護休暇申請',
      formData: {
        careCaseId: testCareCaseId,
        carePeriodId: testCarePeriodId,
        targetDate: formData.targetDate || formData.startDate,
        ...formData
      }
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;

    // 教頭確認
    const firstApprove = WorkflowEngine.approveApplication(userVice, {
      applicationId: appId,
      expectedVersion: 1,
      comment: '確認しました'
    });
    assert.strictEqual(firstApprove.success, true);

    // 校長決裁
    const finalApprove = WorkflowEngine.approveApplication(userPrincipal, {
      applicationId: appId,
      expectedVersion: 2,
      comment: '決裁します'
    });
    assert.strictEqual(finalApprove.success, true);

    return appId;
  }

  // TC-01: 終日介護休暇
  it('TC-01: 終日介護休暇の申請・決裁 -> 出勤簿「介護」、実働0分、所定全額控除', () => {
    // 2026-09-02 (水曜日: 通常勤務 465分)
    submitAndApproveCareLeave({
      unitType: 'DAY',
      startDate: '2026-09-02',
      endDate: '2026-09-02',
      reason: '実母の通院付添'
    });

    const monthlyData = AttendanceEngine.getMonthlyAttendanceData(testUserId, '2026-09');
    const day = monthlyData.days.find(d => d.date === '2026-09-02')!;

    assert.strictEqual(day.displaySymbol, '介護');
    assert.strictEqual(day.stampText, '介護');
    assert.strictEqual(day.scheduledWorkMinutes, 465);
    assert.strictEqual(day.actualWorkMinutes, 0);
    assert.strictEqual(day.deductionMinutes, 465);
    assert.strictEqual(day.serviceStatus, 'LEAVE_CARE');

    // 月次集計
    assert.strictEqual(monthlyData.summary.careLeave.fullDays, 1);
    assert.strictEqual(monthlyData.summary.careLeave.totalMinutes, 465);
    assert.strictEqual(monthlyData.domainSummary.careLeaveDays, 1);
    assert.strictEqual(monthlyData.domainSummary.salaryDeductionTargetMinutes, 465);
  });

  // TC-02: 半日介護休暇
  it('TC-02: 半日介護休暇（午前） -> 出勤簿「介護」「半日」、実働・控除が動的算出', () => {
    // 2026-09-03 (木曜日: 通常勤務 465分)
    submitAndApproveCareLeave({
      unitType: 'HALF_DAY',
      targetDate: '2026-09-03',
      halfDayType: 'MORNING',
      reason: '午前中通院付添'
    });

    const monthlyData = AttendanceEngine.getMonthlyAttendanceData(testUserId, '2026-09');
    const day = monthlyData.days.find(d => d.date === '2026-09-03')!;

    assert.strictEqual(day.displaySymbol, '介護');
    assert.strictEqual(day.stampText, '介護');
    assert.strictEqual(day.stampSubText, '半日');
    assert.strictEqual(day.scheduledWorkMinutes, 465);
    assert.strictEqual(day.deductionMinutes, 230); // 午前勤務区間実時間免除 (230分)
    assert.strictEqual(day.actualWorkMinutes, 235); // 465 - 230 = 235分 (午後実勤務)
    assert.strictEqual(day.isWorkDay, true);

    assert.strictEqual(monthlyData.summary.careLeave.halfDays, 1);
    assert.strictEqual(monthlyData.domainSummary.careLeaveDays, 0.5);
  });

  // TC-03: 時間単位介護休暇 (1時間)
  it('TC-03: 時間単位介護休暇（1時間・60分） -> 出勤簿「介護」「1h」、実働405分', () => {
    // 2026-09-04 (金曜日: 通常勤務 465分, 08:10-16:40)
    submitAndApproveCareLeave({
      unitType: 'TIME',
      targetDate: '2026-09-04',
      startTime: '08:10',
      endTime: '09:10',
      reason: '朝のデイサービス送り出し'
    });

    const monthlyData = AttendanceEngine.getMonthlyAttendanceData(testUserId, '2026-09');
    const day = monthlyData.days.find(d => d.date === '2026-09-04')!;

    assert.strictEqual(day.displaySymbol, '介護');
    assert.strictEqual(day.stampText, '介護');
    assert.strictEqual(day.stampSubText, '1h');
    assert.strictEqual(day.scheduledWorkMinutes, 465);
    assert.strictEqual(day.deductionMinutes, 60);
    assert.strictEqual(day.actualWorkMinutes, 405);

    assert.strictEqual(monthlyData.summary.careLeave.hours, 1);
    assert.strictEqual(monthlyData.summary.careLeave.totalMinutes, 60);
    assert.strictEqual(monthlyData.domainSummary.salaryDeductionTargetMinutes, 60);
  });

  // TC-04: 時間単位介護休暇 (2時間)
  it('TC-04: 時間単位介護休暇（2時間・120分） -> 出勤簿「介護」「2h」、実働345分', () => {
    // 2026-09-07 (月曜日: 通常勤務 465分)
    submitAndApproveCareLeave({
      unitType: 'TIME',
      targetDate: '2026-09-07',
      startTime: '14:40',
      endTime: '16:40',
      reason: '夕方のデイサービス迎え入れ'
    });

    const monthlyData = AttendanceEngine.getMonthlyAttendanceData(testUserId, '2026-09');
    const day = monthlyData.days.find(d => d.date === '2026-09-07')!;

    assert.strictEqual(day.displaySymbol, '介護');
    assert.strictEqual(day.stampText, '介護');
    assert.strictEqual(day.stampSubText, '2h');
    assert.strictEqual(day.scheduledWorkMinutes, 465);
    assert.strictEqual(day.deductionMinutes, 120);
    assert.strictEqual(day.actualWorkMinutes, 345);
  });

  // TC-05: 育児短時間勤務Fixtureでの時間単位介護休暇 (暗黙465分非依存の検証)
  it('TC-05: 育児短時間勤務日における時間単位介護休暇（60分）の正確な交差計算と実働算出', () => {
    // ユーザー2 (teacher2) は育児短時間勤務パターン (月水金 09:00〜13:00 240分) を持つ
    const targetUserId = 2;

    // 介護ケース・期間作成
    const resCase = db.prepare(`
      INSERT INTO care_cases (user_id, recipient_relation, recipient_name, condition_summary, created_by_user_id)
      VALUES (?, '実父', '鈴木次郎', '要介護2', ?)
    `).run(targetUserId, targetUserId);
    const caseId = resCase.lastInsertRowid as number;

    const resPeriod = db.prepare(`
      INSERT INTO care_periods (care_case_id, period_number, start_date, end_date, status, approved_by_user_id)
      VALUES (?, 1, '2026-09-01', '2026-11-30', 'APPROVED', ?)
    `).run(caseId, targetUserId);
    const periodId = resPeriod.lastInsertRowid as number;

    const userTeacher2 = {
      id: 2,
      username: 'teacher2',
      displayName: '教諭 花子',
      roles: ['TEACHER'],
      ipAddress: '127.0.0.1'
    };

    // ユーザー2 (teacher2) に育児短時間勤務パターン (09:00〜13:00 240分) を設定
    db.prepare('DELETE FROM user_work_patterns WHERE user_id = ?').run(targetUserId);
    db.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, effective_from, effective_to, weekly_off_days, schedule_details_json, weekly_total_minutes, created_by_user_id, created_at, updated_at
      ) VALUES (?, '育児短時間', 'SHORT_TIME', '2026-09-01', '2026-09-30', '0,6', ?, 1200, 1, DATETIME('now'), DATETIME('now'))
    `).run(
      targetUserId,
      JSON.stringify({
        mon: { isWorkDay: true, start: '09:00', end: '13:00', minutes: 240, intervals: [{ startTime: '09:00', endTime: '13:00' }] },
        tue: { isWorkDay: true, start: '09:00', end: '13:00', minutes: 240, intervals: [{ startTime: '09:00', endTime: '13:00' }] },
        wed: { isWorkDay: true, start: '09:00', end: '13:00', minutes: 240, intervals: [{ startTime: '09:00', endTime: '13:00' }] },
        thu: { isWorkDay: true, start: '09:00', end: '13:00', minutes: 240, intervals: [{ startTime: '09:00', endTime: '13:00' }] },
        fri: { isWorkDay: true, start: '09:00', end: '13:00', minutes: 240, intervals: [{ startTime: '09:00', endTime: '13:00' }] }
      })
    );

    // 2026-09-09 (水曜: 育児短時間 09:00〜13:00 240分) に 09:00〜10:00 (60分) の介護休暇
    const submitRes = WorkflowEngine.submitApplication(userTeacher2, {
      typeId: 'LEAVE_CARE',
      title: '短時間介護休暇申請',
      formData: {
        careCaseId: caseId,
        carePeriodId: periodId,
        unitType: 'TIME',
        targetDate: '2026-09-09',
        startTime: '09:00',
        endTime: '10:00',
        reason: '通院付添'
      }
    });
    const appId = submitRes.data.id;
    WorkflowEngine.approveApplication(userVice, { applicationId: appId, expectedVersion: 1, comment: '確認' });
    WorkflowEngine.approveApplication(userPrincipal, { applicationId: appId, expectedVersion: 2, comment: '決裁' });

    const monthlyData = AttendanceEngine.getMonthlyAttendanceData(targetUserId, '2026-09');
    const day = monthlyData.days.find(d => d.date === '2026-09-09')!;

    assert.strictEqual(day.displaySymbol, '介護');
    assert.strictEqual(day.scheduledWorkMinutes, 240);
    assert.strictEqual(day.deductionMinutes, 60);
    assert.strictEqual(day.actualWorkMinutes, 180); // 240 - 60 = 180分
  });

  // TC-06: 未承認状態では出勤簿に反映されないこと
  it('TC-06: 未承認（SUBMITTED/FIRST_APPROVED）状態では出勤簿に反映されないこと', () => {
    const submitRes = WorkflowEngine.submitApplication(userTeacher, {
      typeId: 'LEAVE_CARE',
      title: '未承認介護申請',
      formData: {
        careCaseId: testCareCaseId,
        carePeriodId: testCarePeriodId,
        unitType: 'DAY',
        targetDate: '2026-09-10',
        startDate: '2026-09-10',
        endDate: '2026-09-10',
        reason: '申請中'
      }
    });
    assert.strictEqual(submitRes.success, true);

    const monthlyData = AttendanceEngine.getMonthlyAttendanceData(testUserId, '2026-09');
    const day = monthlyData.days.find(d => d.date === '2026-09-10')!;
    assert.strictEqual(day.displaySymbol, '出');
    assert.strictEqual(day.actualWorkMinutes, 465);
  });

  // TC-07: 却下・取消で出勤簿から正常消去されること
  it('TC-07: 取消（WITHDRAWN）で出勤簿から正常消去されること', () => {
    const submitRes = WorkflowEngine.submitApplication(userTeacher, {
      typeId: 'LEAVE_CARE',
      title: '取消予定介護申請',
      formData: {
        careCaseId: testCareCaseId,
        carePeriodId: testCarePeriodId,
        unitType: 'DAY',
        targetDate: '2026-09-11',
        startDate: '2026-09-11',
        endDate: '2026-09-11',
        reason: '取消予定'
      }
    });
    const appId = submitRes.data.id;
    WorkflowEngine.withdrawApplication(userTeacher, { applicationId: appId, expectedVersion: 1 });

    const monthlyData = AttendanceEngine.getMonthlyAttendanceData(testUserId, '2026-09');
    const day = monthlyData.days.find(d => d.date === '2026-09-11')!;
    assert.strictEqual(day.displaySymbol, '出');
  });

  // TC-08: 月次確定スナップショットへの介護休暇記録と不変性検証
  it('TC-08: 月次確定スナップショットに介護休暇が正確に記録され不変保存されること', () => {
    submitAndApproveCareLeave({
      unitType: 'DAY',
      startDate: '2026-09-16',
      endDate: '2026-09-16',
      reason: '確定テスト'
    });

    const actorPrincipal = {
      id: userPrincipal.id,
      username: userPrincipal.username,
      displayName: userPrincipal.displayName,
      stampName: '鈴木'
    };

    const snapResultId = SnapshotService.finalizeMonth(testUserId, '2026-09', actorPrincipal);
    assert.ok(snapResultId > 0);

    const snap = SnapshotService.getSnapshot(testUserId, '2026-09')!;
    assert.ok(snap);
    const day = snap.days.find(d => d.date === '2026-09-16')!;
    assert.strictEqual(day.display_symbol, '介護');
    assert.strictEqual(day.daily_event_code, 'LEAVE_CARE');
  });
});
