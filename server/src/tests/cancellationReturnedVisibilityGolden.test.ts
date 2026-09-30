import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, initDatabase, seedDatabase } from '../db';
import { WorkflowEngine } from '../workflow/engine';
import { AnnualLeaveService } from '../services/annualLeaveService';
import { UserContext } from '../types';

describe('Cancellation RETURNED Visibility & Actionability Golden Tests (GT-CAR-*)', () => {
  let db: any;

  const teacher1: UserContext = {
    id: 1,
    username: 'teacher1',
    displayName: '山田 太郎 (教員A)',
    roles: ['TEACHER'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  const teacher2: UserContext = {
    id: 2,
    username: 'teacher2',
    displayName: '佐藤 花子 (教員B)',
    roles: ['TEACHER'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  const vicePrincipal: UserContext = {
    id: 3,
    username: 'vice_principal',
    displayName: '田中 誠 (教頭B)',
    roles: ['VICE_PRINCIPAL', 'TEACHER'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  const principal: UserContext = {
    id: 4,
    username: 'principal',
    displayName: '鈴木 健一 (校長C)',
    roles: ['PRINCIPAL', 'TEACHER'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  beforeEach(() => {
    initDatabase();
    seedDatabase();
    db = getDb();
    db.prepare('DELETE FROM leave_usages').run();
    db.prepare('DELETE FROM leave_entitlements').run();
    db.prepare('DELETE FROM travel_order_snapshots').run();
    db.prepare('DELETE FROM post_trip_report_snapshots').run();
    db.prepare('DELETE FROM application_approval_steps').run();
    db.prepare('DELETE FROM application_workflow_cycles').run();
    db.prepare('DELETE FROM trip_event_members').run();
    db.prepare('DELETE FROM applications').run();
    db.prepare('DELETE FROM trip_events').run();
    db.prepare('DELETE FROM monthly_attendance_approvals').run();

    AnnualLeaveService.grantEntitlement({
      userId: teacher1.id,
      entitlementType: 'REGULAR_GRANT',
      fiscalYear: 2026,
      grantedDays: 20,
      grantDate: '2026-04-01',
      effectiveFrom: '2026-04-01',
      expiresAt: '2028-03-31',
      reason: '2026年度当初付与',
    });
    AnnualLeaveService.grantEntitlement({
      userId: teacher2.id,
      entitlementType: 'REGULAR_GRANT',
      fiscalYear: 2026,
      grantedDays: 20,
      grantDate: '2026-04-01',
      effectiveFrom: '2026-04-01',
      expiresAt: '2028-03-31',
      reason: '2026年度当初付与',
    });
  });

  const createAndApproveAnnualLeave = (submitter: UserContext = teacher1, subject: UserContext = teacher1) => {
    const subRes = WorkflowEngine.submitApplication(submitter, {
      typeId: 'LEAVE_ANNUAL',
      title: `【年休】2026-09-10`,
      formData: {
        unitType: 'DAY',
        startDate: '2026-09-10',
        endDate: '2026-09-10',
        targetDate: '2026-09-10',
        calculatedDays: 1,
        reason: '私用のため',
      },
    });
    assert.strictEqual(subRes.success, true);
    const appId = subRes.data.id;

    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const vpRes = WorkflowEngine.approveApplication(vicePrincipal, {
      applicationId: appId,
      expectedVersion: app.version,
    });
    assert.strictEqual(vpRes.success, true);

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const prRes = WorkflowEngine.approveApplication(principal, {
      applicationId: appId,
      expectedVersion: app.version,
    });
    assert.strictEqual(prRes.success, true);

    return appId;
  };

  it('GT-CAR-01: WorkflowEngine returns cancellationReturn and latestCancellationCycle when cancellation is returned', () => {
    const appId = createAndApproveAnnualLeave(teacher1, teacher1);
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    // Request cancellation
    const cancelRes = WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      cancellationReason: '急な私用変更のため取消',
      expectedVersion: app.version,
    });
    assert.strictEqual(cancelRes.success, true);

    let detail = WorkflowEngine.getApplicationDetail(teacher1, appId);
    assert.strictEqual(detail.success, true);
    assert.strictEqual(detail.data.activeCancellationCycle?.status, 'IN_PROGRESS');

    // VP returns cancellation
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const retRes = WorkflowEngine.returnCancellation(vicePrincipal, {
      applicationId: appId,
      comment: '理由の詳細を補足してください',
      expectedVersion: app.version,
    });
    assert.strictEqual(retRes.success, true);

    detail = WorkflowEngine.getApplicationDetail(teacher1, appId);
    assert.strictEqual(detail.success, true);

    // Verify Primary Application Fact Immutability
    assert.strictEqual(detail.data.application.current_status, 'FINAL_APPROVED');
    assert.strictEqual(detail.data.activeCancellationCycle, null);
    assert.ok(detail.data.latestCancellationCycle);
    assert.strictEqual(detail.data.latestCancellationCycle.status, 'RETURNED');
    assert.strictEqual(detail.data.latestCancellationCycle.return_reason, '理由の詳細を補足してください');

    // Verify cancellationReturn DTO
    assert.ok(detail.data.cancellationReturn);
    assert.strictEqual(detail.data.cancellationReturn.cycleId, detail.data.latestCancellationCycle.id);
    assert.strictEqual(detail.data.cancellationReturn.approvalCycle, 2);
    assert.strictEqual(detail.data.cancellationReturn.status, 'RETURNED');
    assert.strictEqual(detail.data.cancellationReturn.returnReason, '理由の詳細を補足してください');
    assert.strictEqual(detail.data.cancellationReturn.returnedByUserId, vicePrincipal.id);
    assert.strictEqual(detail.data.cancellationReturn.returnedByUserName, vicePrincipal.displayName);
    assert.strictEqual(detail.data.cancellationReturn.actionActorUserId, teacher1.id);
  });

  it('GT-CAR-ACTOR-01 & GT-CAR-ACTOR-02: Self cancellation return sets actionActorUserId strictly to cancellation submitter', () => {
    const appId = createAndApproveAnnualLeave(teacher1, teacher1);
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      cancellationReason: '取消理由',
      expectedVersion: app.version,
    });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const retRes = WorkflowEngine.returnCancellation(vicePrincipal, {
      applicationId: appId,
      comment: '差戻し',
      expectedVersion: app.version,
    });
    assert.strictEqual(retRes.success, true);

    const detail = WorkflowEngine.getApplicationDetail(teacher1, appId);
    assert.strictEqual(detail.success, true);
    assert.ok(detail.data.cancellationReturn);
    assert.strictEqual(detail.data.cancellationReturn.actionActorUserId, teacher1.id);
  });

  it('GT-CAR-ACTOR-03 & GT-CAR-ACTOR-04: Proxy cancellation return sets actionActorUserId strictly to proxy cancellation submitter, NOT subject', () => {
    const appId = createAndApproveAnnualLeave(teacher1, teacher1);
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    // Principal (School Manager) submits cancellation on behalf of teacher1 (HD-W1-01 Option B)
    const cancelRes = WorkflowEngine.requestCancellation(principal, {
      applicationId: appId,
      cancellationReason: '校長による代理取消起案',
      expectedVersion: app.version,
    });
    assert.strictEqual(cancelRes.success, true);

    // VP returns cancellation at Step 1
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const retRes = WorkflowEngine.returnCancellation(vicePrincipal, {
      applicationId: appId,
      comment: '教頭による差戻し',
      expectedVersion: app.version,
    });
    assert.strictEqual(retRes.success, true);

    const detail = WorkflowEngine.getApplicationDetail(teacher1, appId);
    assert.strictEqual(detail.success, true);

    // Action Owner must strictly be principal (id 4), not teacher1 (id 1)
    assert.ok(detail.data.cancellationReturn);
    assert.strictEqual(detail.data.cancellationReturn.actionActorUserId, principal.id);
    assert.notStrictEqual(detail.data.cancellationReturn.actionActorUserId, teacher1.id);
  });

  it('GT-CAR-ACTOR-05: Fail-closed if started_by_user_id is missing → actionActorUserId is null with zero fallback', () => {
    const appId = createAndApproveAnnualLeave(teacher1, teacher1);
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    const cancelRes = WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      cancellationReason: '取消理由',
      expectedVersion: app.version,
    });
    assert.strictEqual(cancelRes.success, true);

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const retRes = WorkflowEngine.returnCancellation(vicePrincipal, {
      applicationId: appId,
      comment: '差戻し',
      expectedVersion: app.version,
    });
    assert.strictEqual(retRes.success, true);

    // Simulate legacy snapshot workflow cycle where started_by_user_id was null
    db.prepare(`
      UPDATE application_workflow_cycles
      SET workflow_source = 'LEGACY_SNAPSHOT', started_by_user_id = NULL
      WHERE application_id = ? AND approval_cycle = 2
    `).run(appId);

    const detail = WorkflowEngine.getApplicationDetail(teacher1, appId);
    assert.strictEqual(detail.success, true);
    assert.ok(detail.data.cancellationReturn);
    assert.strictEqual(detail.data.cancellationReturn.actionActorUserId, null);
  });

  it('GT-CAR-04: Attendance & leave deductions remain untouched when cancellation is returned', () => {
    const appId = createAndApproveAnnualLeave(teacher1, teacher1);
    const usagesBefore = db.prepare('SELECT * FROM leave_usages WHERE application_id = ?').all(appId);
    assert.strictEqual(usagesBefore.length, 1);

    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      cancellationReason: '取消理由',
      expectedVersion: app.version,
    });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.returnCancellation(vicePrincipal, {
      applicationId: appId,
      comment: '差戻し',
      expectedVersion: app.version,
    });

    const usagesAfter = db.prepare('SELECT * FROM leave_usages WHERE application_id = ?').all(appId);
    assert.strictEqual(usagesAfter.length, 1);
    assert.strictEqual((usagesAfter[0] as any).days_used, (usagesBefore[0] as any).days_used);
  });
});
