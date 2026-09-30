import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { setDb } from '../db/database';
import { SCHEMA_SQL } from '../db/schema';
import { migrator } from '../db/migrations';
import { seedDatabase } from '../db/seeds';
import { AttendanceEngine } from '../services/attendance/attendanceEngine';
import { WorkflowEngine } from '../workflow/engine';
import { CareLeaveService } from '../services/careLeaveService';
import { getUserLeaveSummary } from '../utils/leaveCalculator';

describe('山口県勤務条例第15条「介護休暇」および第16条「介護時間」包括テストスイート', () => {
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
      db.prepare('DELETE FROM monthly_attendance_snapshots').run();
      db.prepare('DELETE FROM monthly_attendance_snapshot_days').run();
      db.prepare('DELETE FROM application_approval_steps').run();
      db.prepare('DELETE FROM applications').run();
      db.prepare('DELETE FROM care_periods').run();
      db.prepare('DELETE FROM care_cases').run();

      // 介護ケース作成 (実母, 介護開始日: 2026-09-01)
      const resCase = db.prepare(`
        INSERT INTO care_cases (user_id, recipient_relation, recipient_name, condition_summary, care_start_date, created_by_user_id)
        VALUES (?, '実母', '山田花子', '要介護3 通院付添及び身体介護', '2026-09-01', ?)
      `).run(testUserId, testUserId);
      testCareCaseId = resCase.lastInsertRowid as number;

      // 介護休暇 指定期間作成 (2026-09-01 〜 2026-11-30)
      const resPeriod = db.prepare(`
        INSERT INTO care_periods (care_case_id, period_number, start_date, end_date, status, approved_by_user_id)
        VALUES (?, 1, '2026-09-01', '2026-11-30', 'APPROVED', ?)
      `).run(testCareCaseId, testUserId);
      testCarePeriodId = resPeriod.lastInsertRowid as number;
    } catch (e: any) {
      console.error('[beforeEach Error]', e);
    }
  });

  function submitAndApprove(typeId: string, title: string, formData: any) {
    const submitRes = WorkflowEngine.submitApplication(userTeacher, {
      typeId,
      title,
      formData: {
        careCaseId: testCareCaseId,
        targetDate: formData.targetDate || formData.startDate,
        ...formData
      }
    });
    assert.strictEqual(submitRes.success, true, `Submit failed: ${submitRes.message}`);
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
      comment: '決裁しました'
    });
    assert.strictEqual(finalApprove.success, true);
    return appId;
  }

  // --- 条例第15条「介護休暇」テスト ---

  it('Case 1: 介護休暇 (終日) が決裁されると出勤簿に「介護」が印字され、無給減額（465分控除）されること', () => {
    submitAndApprove('LEAVE_CARE', '介護休暇 (終日)', {
      unitType: 'DAY',
      startDate: '2026-09-10',
      endDate: '2026-09-10',
      carePeriodId: testCarePeriodId,
      reason: '実母通院付添'
    });

    const att = AttendanceEngine.getMonthlyAttendanceData(testUserId, '2026-09');
    const day = att.days.find(d => d.date === '2026-09-10')!;
    assert.strictEqual(day.stampText, '介護');
    assert.strictEqual(day.stampColor, 'purple');
    assert.strictEqual(day.deductionMinutes, 465);
    assert.strictEqual(day.actualWorkMinutes, 0);
  });

  it('Case 2: 介護休暇 (時間単位: 2時間) が決裁されると出勤簿に「介護(2h)」が表示されること', () => {
    submitAndApprove('LEAVE_CARE', '介護休暇 (時間単位)', {
      unitType: 'TIME',
      targetDate: '2026-09-11',
      startTime: '08:10',
      endTime: '10:10', // 2時間 = 120分
      carePeriodId: testCarePeriodId,
      reason: '実母デイサービス送り出し'
    });

    const att = AttendanceEngine.getMonthlyAttendanceData(testUserId, '2026-09');
    const day = att.days.find(d => d.date === '2026-09-11')!;
    assert.strictEqual(day.stampText, '介護');
    assert.strictEqual(day.stampSubText, '2h');
    assert.strictEqual(day.deductionMinutes, 120);
    assert.strictEqual(day.actualWorkMinutes, 345);
  });

  it('Case 3: 介護休暇が指定期間外の日付の場合はバリデーションで拒絶されること', () => {
    const res = CareLeaveService.validateCareLeave({
      unitType: 'DAY',
      startDate: '2026-12-05', // 指定期間 (〜11-30) 外
      endDate: '2026-12-05',
      careCaseId: testCareCaseId,
      carePeriodId: testCarePeriodId
    }, testUserId);

    assert.strictEqual(res.valid, false);
    assert.match(res.message!, /指定期間外の日付/);
  });

  it('Case 4: 介護休暇の時間単位で60分整数倍以外（例: 45分）は拒絶されること', () => {
    const res = CareLeaveService.validateCareLeave({
      unitType: 'TIME',
      targetDate: '2026-09-15',
      startTime: '08:10',
      endTime: '08:55', // 45分
      careCaseId: testCareCaseId,
      carePeriodId: testCarePeriodId
    }, testUserId);

    assert.strictEqual(res.valid, false);
    assert.match(res.message!, /1時間単位（60分の整数倍）/);
  });

  // --- 条例第16条「介護時間」テスト ---

  it('Case 5: 介護時間 (30分単位: 90分) が決裁されると出勤簿に「介時(1h30m)」が表示されること', () => {
    // 介護時間は指定期間外 (2026-12月) で取得
    submitAndApprove('LEAVE_CARE_TIME', '介護時間 (90分)', {
      unitType: 'TIME',
      targetDate: '2026-12-02',
      startTime: '08:10',
      endTime: '09:40', // 90分
      reason: '実母訪問看護立会い'
    });

    const att = AttendanceEngine.getMonthlyAttendanceData(testUserId, '2026-12');
    const day = att.days.find(d => d.date === '2026-12-02')!;
    assert.strictEqual(day.stampText, '介時');
    assert.strictEqual(day.stampSubText, '1h30m');
    assert.strictEqual(day.deductionMinutes, 90);
    assert.strictEqual(day.actualWorkMinutes, 375);
  });

  it('Case 6: 介護時間が1日2時間（120分）を超える場合はバリデーションで拒絶されること', () => {
    const res = CareLeaveService.validateCareTime({
      unitType: 'TIME',
      targetDate: '2026-12-03',
      startTime: '08:10',
      endTime: '11:10', // 180分 (3時間)
      careCaseId: testCareCaseId
    }, testUserId);

    assert.strictEqual(res.valid, false);
    assert.match(res.message!, /1日につき2時間（120分）以内/);
  });

  it('Case 7: 介護時間は30分単位（例: 20分）でない場合は拒絶されること', () => {
    const res = CareLeaveService.validateCareTime({
      unitType: 'TIME',
      targetDate: '2026-12-03',
      startTime: '08:10',
      endTime: '08:30', // 20分
      careCaseId: testCareCaseId
    }, testUserId);

    assert.strictEqual(res.valid, false);
    assert.match(res.message!, /30分単位/);
  });

  it('Case 8: 介護時間は介護休暇の指定期間と重複する日付では取得できないこと (条例第16条第1項)', () => {
    const res = CareLeaveService.validateCareTime({
      unitType: 'TIME',
      targetDate: '2026-09-15', // 指定期間内 (2026-09-01〜2026-11-30)
      startTime: '08:10',
      endTime: '09:10', // 60分
      careCaseId: testCareCaseId
    }, testUserId);

    assert.strictEqual(res.valid, false);
    assert.match(res.message!, /介護休暇の指定期間.*と重複しているため/);
  });

  it('Case 9: 承認済み介護休暇および介護時間が leaveCalculator で正しく累計集計されること', () => {
    // 介護休暇 終日 (465分)
    submitAndApprove('LEAVE_CARE', '介護休暇 (終日)', {
      unitType: 'DAY',
      startDate: '2026-09-10',
      endDate: '2026-09-10',
      carePeriodId: testCarePeriodId,
      reason: '実母通院'
    });

    // 介護休暇 時間単位 (120分)
    submitAndApprove('LEAVE_CARE', '介護休暇 (時間単位)', {
      unitType: 'TIME',
      targetDate: '2026-09-11',
      startTime: '08:10',
      endTime: '10:10',
      carePeriodId: testCarePeriodId,
      reason: '実母デイサービス'
    });

    // 介護時間 (90分)
    submitAndApprove('LEAVE_CARE_TIME', '介護時間', {
      unitType: 'TIME',
      targetDate: '2026-12-02',
      startTime: '08:10',
      endTime: '09:40',
      reason: '実母訪問看護'
    });

    const summary = getUserLeaveSummary(testUserId, '2026-12-31');
    // 465分 + 120分 = 585分 (1日 2時間 0分)
    assert.strictEqual(summary.careLeave?.totalMinutes, 585);
    assert.strictEqual(summary.careLeave?.formatted, '1日 2時間 0分');

    // 90分 = 1時間 30分
    assert.strictEqual(summary.careTime?.totalMinutes, 90);
    assert.strictEqual(summary.careTime?.formatted, '1時間 30分');
  });
});
