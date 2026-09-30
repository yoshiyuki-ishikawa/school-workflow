import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { initDatabase, seedDatabase, getDb } from '../db';
import { WorkflowEngine, UserContext } from './engine';
import { calculateTimeLeaveMinutes, minutesToLeaveUnits, getUserLeaveSummary, WORK_DAY_MINUTES } from '../utils/leaveCalculator';
import { getMonthlyAttendanceData } from '../utils/attendanceEngine';

describe('学校業務ワークフローエンジン 包括的テスト (休暇簿・旅行命令簿・出勤簿)', () => {
  const teacherA: UserContext = {
    id: 1,
    username: 'teacher1',
    displayName: '山田 太郎 (教員A)',
    roles: ['TEACHER'],
    ipAddress: '192.168.1.100',
  };

  const vicePrincipal: UserContext = {
    id: 3,
    username: 'vice_principal',
    displayName: '田中 誠 (教頭B)',
    roles: ['VICE_PRINCIPAL', 'TEACHER'],
    ipAddress: '192.168.1.102',
  };

  const principal: UserContext = {
    id: 4,
    username: 'principal',
    displayName: '鈴木 健一 (校長C)',
    roles: ['PRINCIPAL', 'TEACHER'],
    ipAddress: '192.168.1.103',
  };

  const office: UserContext = {
    id: 5,
    username: 'office',
    displayName: '高橋 節子 (事務D)',
    roles: ['OFFICE', 'TEACHER'],
    ipAddress: '192.168.1.104',
  };

  const admin: UserContext = {
    id: 6,
    username: 'admin',
    displayName: 'システム管理者E',
    roles: ['ADMIN'],
    ipAddress: '192.168.1.105',
  };

  beforeEach(() => {
    initDatabase();
    seedDatabase();
    const db = getDb();
    db.prepare('DELETE FROM travel_order_snapshots').run();
    db.prepare('DELETE FROM post_trip_report_snapshots').run();
    db.prepare('DELETE FROM application_approval_steps').run();
    db.prepare('DELETE FROM leave_usages').run();
    db.prepare('DELETE FROM leave_entitlements').run();
    db.prepare('DELETE FROM trip_event_members').run();
    db.prepare('DELETE FROM applications').run();
    db.prepare('DELETE FROM trip_events').run();
    db.prepare('DELETE FROM application_workflow_cycles').run();
    db.prepare('DELETE FROM audit_logs').run();
    db.prepare('DELETE FROM calendar_overrides').run();
    db.prepare('DELETE FROM monthly_attendance_approvals').run();
    db.prepare('DELETE FROM monthly_attendance_snapshots').run();
    db.prepare('DELETE FROM personnel_statuses').run();
    db.prepare('DELETE FROM absences').run();

    const tUser = db.prepare('SELECT id FROM users WHERE username = ?').get('teacher1') as any;
    if (tUser) teacherA.id = tUser.id;
    const pUser = db.prepare('SELECT id FROM users WHERE username = ?').get('principal') as any;
    if (pUser) principal.id = pUser.id;

    // 年休初期付与 (20日 = 155時間 = 9300分)
    const { AnnualLeaveService } = require('../services/annualLeaveService');
    AnnualLeaveService.grantEntitlement({
      userId: teacherA.id,
      entitlementType: 'REGULAR_GRANT',
      fiscalYear: 2026,
      grantedDays: 20,
      grantDate: '2026-04-01',
      effectiveFrom: '2026-04-01',
      expiresAt: '2027-03-31',
      reason: '2026年度当初付与'
    });
  });

  it('1. 第9号様式 休暇簿: 勤務時間計算 (7時間45分=465分) と時間休累計更新', () => {
    const mins = calculateTimeLeaveMinutes('09:00', '12:00');
    assert.strictEqual(mins, 180);

    const submitRes = WorkflowEngine.submitApplication(teacherA, {
      typeId: 'LEAVE_ANNUAL',
      title: '年休 (時間休 9:00〜12:00)',
      formData: {
        unitType: 'TIME',
        targetDate: '2026-10-05',
        startTime: '09:00',
        endTime: '12:00',
        calculatedMinutes: 180,
        reason: '通院のため',
      },
    });
    const appId = submitRes.data.id;
    const db = getDb();
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.approveApplication(vicePrincipal, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(principal, { applicationId: appId, expectedVersion: app.version });

    const summary = getUserLeaveSummary(teacherA.id);
    assert.strictEqual(summary.annualLeave.used.hours, 3);
  });

  it('2. 別表第一 出張申請 ＆ 復命書: 3段階決裁完了', () => {
    const submitRes = WorkflowEngine.submitApplication(teacherA, {
      typeId: 'BUSINESS_TRIP',
      title: '県小教研生活部研究大会 出張申請',
      formData: {
        destination: '下関市民会館',
        purpose: '県小教研生活部研究大会出席のため',
        startDate: '2026-10-15',
        endDate: '2026-10-15',
        startAt: '2026-10-15T08:10:00',
        endAt: '2026-10-15T16:40:00',
        departurePlace: '本校',
        arrivalPlace: '本校',
      },
    });
    const appId = submitRes.data.id;
    const db = getDb();
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.approveApplication(office, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(vicePrincipal, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(principal, { applicationId: appId, expectedVersion: app.version });

    // 復命書提出
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.submitReport(teacherA, {
      applicationId: appId,
      expectedVersion: app.version,
      reportDate: '2026-10-16',
      reportResult: '研究成果を教科部会で共有',
      actualMatchesPlan: true,
    });

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(office, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(vicePrincipal, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(principal, { applicationId: appId, expectedVersion: app.version });

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'TRIP_APPROVED');
    assert.strictEqual(app.report_status, 'REPORT_FINAL_APPROVED');
  });

  it('3. 出勤簿: 決裁済み休暇・出張の自動転記 ＆ 勤務日・代休振替', () => {
    const db = getDb();

    // 10/05(月) に時間年休 (3時間) を申請・決裁
    const resLeave = WorkflowEngine.submitApplication(teacherA, {
      typeId: 'LEAVE_ANNUAL',
      title: '年休 3h',
      formData: { unitType: 'TIME', targetDate: '2026-10-05', startTime: '09:00', endTime: '12:00', calculatedMinutes: 180 },
    });
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(resLeave.data.id) as any;
    WorkflowEngine.approveApplication(vicePrincipal, { applicationId: app.id, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(app.id) as any;
    WorkflowEngine.approveApplication(principal, { applicationId: app.id, expectedVersion: app.version });

    // 10/15(木) に出張を申請・決裁
    const resTrip = WorkflowEngine.submitApplication(teacherA, {
      typeId: 'BUSINESS_TRIP',
      title: '出張',
      formData: {
        destination: '下関',
        purpose: '研修',
        startDate: '2026-10-15',
        endDate: '2026-10-15',
        startAt: '2026-10-15T08:10:00',
        endAt: '2026-10-15T16:40:00',
        departurePlace: '本校',
        arrivalPlace: '本校',
      },
    });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(resTrip.data.id) as any;
    WorkflowEngine.approveApplication(office, { applicationId: app.id, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(app.id) as any;
    WorkflowEngine.approveApplication(vicePrincipal, { applicationId: app.id, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(app.id) as any;
    WorkflowEngine.approveApplication(principal, { applicationId: app.id, expectedVersion: app.version });

    // 10/18(日) を運動会で「勤務日」に変更、10/19(月) を「代休」に振替設定
    db.prepare(`
      INSERT INTO calendar_overrides (date, scope, override_type, reason, created_at)
      VALUES ('2026-10-18', 'ALL', 'WORKDAY', '秋季大運動会', '2026-10-01')
    `).run();
    db.prepare(`
      INSERT INTO calendar_overrides (date, scope, override_type, reason, created_at)
      VALUES ('2026-10-19', 'ALL', 'SUBSTITUTE_HOLIDAY', '運動会振替休業日', '2026-10-01')
    `).run();

    // 出勤簿生成
    const attendance = getMonthlyAttendanceData(teacherA.id, '2026-10');

    // 10/5 のセル検証 (年休 3h)
    const day5 = attendance.days.find((d) => d.day === 5)!;
    assert.strictEqual(day5.stampText, '年休');
    assert.strictEqual(day5.stampSubText, '3h');

    // 10/15 のセル検証 (出張)
    const day15 = attendance.days.find((d) => d.day === 15)!;
    assert.strictEqual(day15.stampText, '出張');

    // 10/18 (日) のセル検証 (勤務日: 秋季大運動会)
    const day18 = attendance.days.find((d) => d.day === 18)!;
    assert.strictEqual(day18.stampText, '勤務日');
    assert.strictEqual(day18.stampSubText, '秋季大運動会');
    assert.strictEqual(day18.isWorkday, true);

    // 10/19 (月) のセル検証 (代休: 運動会振替休業日)
    const day19 = attendance.days.find((d) => d.day === 19)!;
    assert.strictEqual(day19.stampText, '代休');
    assert.strictEqual(day19.isSubstituteHoliday, true);

    // 集計検証
    assert.strictEqual(attendance.summary.annualLeave.hours, 3);
    assert.strictEqual(attendance.summary.businessTripCount, 1);
  });

  it('4. 月次確定・ロック・解除（アンロック）ライフサイクル検証', () => {
    // 校長による出勤簿月次確定
    const confirmRes = WorkflowEngine.confirmMonthlyAttendance(principal, {
      userId: teacherA.id,
      yearMonth: '2026-10',
      comment: '10月分点検済',
    });
    assert.strictEqual(confirmRes.success, true);

    // ロック中の新規申請提出試行が 400 で遮断されること
    const blockedSubmit = WorkflowEngine.submitApplication(teacherA, {
      typeId: 'LEAVE_ANNUAL',
      title: '確定後年休申請試行',
      formData: { unitType: 'DAY', startDate: '2026-10-27', endDate: '2026-10-27' },
    });
    assert.strictEqual(blockedSubmit.success, false);
    assert.strictEqual(blockedSubmit.statusCode, 400);

    // 校長による月次確定解除 (アンロック)
    const unlockRes = WorkflowEngine.unlockMonthlyAttendance(principal, {
      userId: teacherA.id,
      yearMonth: '2026-10',
      reason: '10/27 年休追記のため',
    });
    assert.strictEqual(unlockRes.success, true);

    // 解除後は申請可能になること
    const allowedSubmit = WorkflowEngine.submitApplication(teacherA, {
      typeId: 'LEAVE_ANNUAL',
      title: '確定解除後年休申請',
      formData: { unitType: 'DAY', startDate: '2026-10-27', endDate: '2026-10-27' },
    });
    assert.strictEqual(allowedSubmit.success, true);
  });
});
