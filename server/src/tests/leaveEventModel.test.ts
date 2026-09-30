import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { initDatabase, seedDatabase, getDb } from '../db';
import { WorkflowEngine, UserContext } from '../workflow/engine';
import { getUserLeaveSummary, addLeaveGrant, addLeaveAdjustment } from '../utils/leaveCalculator';

describe('修正② 年次有給休暇 イベント駆動モデル (Grant / Consumption / Adjustment) テスト', () => {
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
    roles: ['VICE_PRINCIPAL'],
    ipAddress: '192.168.1.102',
  };
  const principal: UserContext = {
    id: 4,
    username: 'principal',
    displayName: '鈴木 健一 (校長C)',
    roles: ['PRINCIPAL'],
    ipAddress: '192.168.1.103',
  };

  beforeEach(() => {
    initDatabase();
    seedDatabase();
    const db = getDb();
    db.prepare('DELETE FROM applications').run();
    db.prepare('DELETE FROM application_approval_steps').run();
    db.prepare('DELETE FROM monthly_attendance_approvals').run();
    db.prepare('DELETE FROM monthly_attendance_snapshots').run();
    db.prepare('DELETE FROM leave_usages').run();
    db.prepare('DELETE FROM leave_entitlements').run();
    db.prepare('DELETE FROM leave_grants').run();
    db.prepare('DELETE FROM leave_adjustments').run();
  });

  it('1. 初期付与 (Grant 20日) からの残高算出', () => {
    addLeaveGrant({
      userId: teacherA.id,
      leaveType: 'ANNUAL',
      grantedAmount: 20.0,
      grantDate: '2026-04-01',
      effectiveFrom: '2026-04-01',
      expiresAt: '2027-03-31',
      reason: '新年度定期付与',
    });

    const summary = getUserLeaveSummary(teacherA.id);
    assert.strictEqual(summary.annualLeave.grantedDays, 20);
    assert.strictEqual(summary.annualLeave.used.totalMinutes, 0);
    assert.strictEqual(summary.annualLeave.remaining.days, 20);
    // 時間休上限撤廃: 保有全量（20日 = 155時間）が時間休として利用可能
    assert.strictEqual(summary.annualLeave.remaining.hours, 155);
    assert.strictEqual(summary.annualLeave.remaining.minutes, 0);
    assert.strictEqual(summary.annualLeave.formattedRemainingDays, '20日');
  });

  it('2. 休暇消費 (Consumption: 1日 ＋ 3時間) の動的減算', () => {
    addLeaveGrant({
      userId: teacherA.id,
      leaveType: 'ANNUAL',
      grantedAmount: 20.0,
      grantDate: '2026-04-01',
      effectiveFrom: '2026-04-01',
      expiresAt: '2027-03-31',
      reason: '新年度定期付与',
    });

    const db = getDb();

    // 1日取得 (2026-05-11 月曜)
    const res1 = WorkflowEngine.submitApplication(teacherA, {
      typeId: 'LEAVE_ANNUAL',
      title: '年休 (1日)',
      formData: { unitType: 'DAY', calculatedDays: 1, startDate: '2026-05-11', endDate: '2026-05-11' },
    });
    let app1 = db.prepare('SELECT * FROM applications WHERE id = ?').get(res1.data.id) as any;
    WorkflowEngine.approveApplication(vicePrincipal, { applicationId: app1.id, expectedVersion: app1.version });
    app1 = db.prepare('SELECT * FROM applications WHERE id = ?').get(app1.id) as any;
    WorkflowEngine.approveApplication(principal, { applicationId: app1.id, expectedVersion: app1.version });

    // 3時間取得 (2026-05-15 金曜 09:00-12:00)
    const res2 = WorkflowEngine.submitApplication(teacherA, {
      typeId: 'LEAVE_ANNUAL',
      title: '年休 (時間休 3h)',
      formData: { unitType: 'TIME', calculatedMinutes: 180, targetDate: '2026-05-15', startTime: '09:00', endTime: '12:00' },
    });
    let app2 = db.prepare('SELECT * FROM applications WHERE id = ?').get(res2.data.id) as any;
    WorkflowEngine.approveApplication(vicePrincipal, { applicationId: app2.id, expectedVersion: app2.version });
    app2 = db.prepare('SELECT * FROM applications WHERE id = ?').get(app2.id) as any;
    WorkflowEngine.approveApplication(principal, { applicationId: app2.id, expectedVersion: app2.version });

    const summary = getUserLeaveSummary(teacherA.id, '2026-05-15');
    assert.strictEqual(summary.annualLeave.used.days, 1);
    assert.strictEqual(summary.annualLeave.used.hours, 3);
    // 残高: 19日、年間時間休残高: 19日 - 3時間相当（144時間15分 = 8655分）
    assert.strictEqual(summary.annualLeave.remaining.days, 19);
    assert.strictEqual(summary.annualLeave.remaining.hours, 144);
    assert.strictEqual(summary.annualLeave.remaining.minutes, 15);
    assert.strictEqual(summary.annualLeave.formattedRemainingDays, '19日');
  });

  it('3. 手動調整 (Adjustment) とロット台帳の記録', () => {
    addLeaveGrant({
      userId: teacherA.id,
      leaveType: 'ANNUAL',
      grantedAmount: 20.0,
      grantDate: '2026-04-01',
      effectiveFrom: '2026-04-01',
      expiresAt: '2027-03-31',
      reason: '新年度定期付与',
    });

    addLeaveAdjustment({
      userId: teacherA.id,
      leaveType: 'ANNUAL',
      adjustedAmount: -1.5,
      adjustedByUserId: principal.id,
      reason: '前年度失効未精算分の調整',
    });

    const db = getDb();
    const adj = db.prepare('SELECT * FROM leave_adjustments WHERE user_id = ?').get(teacherA.id) as any;
    assert.strictEqual(adj.adjusted_amount, -1.5);
    assert.strictEqual(adj.reason, '前年度失効未精算分の調整');
  });
});
