import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, initDatabase, seedDatabase } from '../db';
import { WorkflowEngine } from '../workflow/engine';
import { AnnualLeaveService } from '../services/annualLeaveService';
import { getUserLeaveSummary } from '../utils/leaveCalculator';
import { UserContext } from '../types';

describe('Cancellation Workflow DTO Projection & Actionability Golden Tests (GT-CANCEL-*)', () => {
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
  });

  const createAndApproveAnnualLeave = (targetDate = '2026-09-10') => {
    const subRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'LEAVE_ANNUAL',
      title: `【年休】${targetDate}`,
      formData: {
        unitType: 'DAY',
        startDate: targetDate,
        endDate: targetDate,
        targetDate,
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

  // Helper simulating the GET /:id route projection logic
  const getApplicationDetailViaRouteProjection = (actor: UserContext, applicationId: number) => {
    const result = WorkflowEngine.getApplicationDetail(actor, applicationId);
    if (!result.success) return result;

    const app = result.data.application;
    const userSummary = getUserLeaveSummary(app.subject_user_id);

    return {
      success: true,
      statusCode: 200,
      application: {
        ...app,
        applicant_name: app.subject_user_name,
        applicant_department: app.subject_department,
        form_data: JSON.parse(app.form_data || '{}'),
        steps: result.data.steps,
        activeCancellationCycle: result.data.activeCancellationCycle,
        leaveSummarySnapshot: userSummary,
      },
    };
  };

  // Helper simulating Client ApplicationDetailPage canApproveCancellation computation
  const evaluateClientCancellationActionability = (app: any, currentUser: UserContext) => {
    const isSubject = app.subject_user_id === currentUser.id;
    const activeCancelCycleNum = app.activeCancellationCycle?.approval_cycle;
    const currentCancelStep = app.steps?.find(
      (s: any) => s.approval_cycle === activeCancelCycleNum && s.status === 'PENDING'
    );
    const isCancelStarter = app.activeCancellationCycle?.started_by_user_id === currentUser.id;
    const canApproveCancellation = Boolean(
      currentCancelStep &&
      !isSubject &&
      !isCancelStarter &&
      currentUser.roles.includes(currentCancelStep.required_role_id) &&
      (!currentCancelStep.assigned_user_id || currentCancelStep.assigned_user_id === currentUser.id)
    );

    return {
      activeCancelCycleNum,
      currentCancelStep,
      canApproveCancellation,
    };
  };

  it('GT-CANCEL-DTO-01: 承認済年休 -> 取消申請 -> Cancellation Cycle = IN_PROGRESS の場合、GET /applications/:id が activeCancellationCycle != null を返す', () => {
    const appId = createAndApproveAnnualLeave('2026-09-10');
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    const cancelRes = WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '公務都合による取消',
    });
    assert.strictEqual(cancelRes.success, true);

    const routeRes = getApplicationDetailViaRouteProjection(vicePrincipal, appId);
    assert.strictEqual(routeRes.success, true);
    assert.ok(routeRes.application.activeCancellationCycle != null, 'activeCancellationCycle must not be null');
    assert.strictEqual(routeRes.application.activeCancellationCycle.cycle_purpose, 'CANCELLATION');
    assert.strictEqual(routeRes.application.activeCancellationCycle.status, 'IN_PROGRESS');
    assert.strictEqual(routeRes.application.activeCancellationCycle.approval_cycle, 2);
  });

  it('GT-CANCEL-DTO-02: 返却された activeCancellationCycle.approval_cycle と PENDING cancellation step.approval_cycle が一致する', () => {
    const appId = createAndApproveAnnualLeave('2026-09-10');
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '公務都合による取消',
    });

    const routeRes = getApplicationDetailViaRouteProjection(vicePrincipal, appId);
    assert.strictEqual(routeRes.success, true);

    const activeCycle = routeRes.application.activeCancellationCycle;
    assert.ok(activeCycle);

    const pendingCancelStep = routeRes.application.steps.find(
      (s: any) => s.approval_cycle === activeCycle.approval_cycle && s.status === 'PENDING'
    );
    assert.ok(pendingCancelStep);
    assert.strictEqual(pendingCancelStep.approval_cycle, activeCycle.approval_cycle);
    assert.strictEqual(pendingCancelStep.step_order, 1);
    assert.strictEqual(pendingCancelStep.step_name, '教頭取消確認');
    assert.strictEqual(pendingCancelStep.required_role_id, 'VICE_PRINCIPAL');
  });

  it('GT-CANCEL-UI-03: 現在承認者が Cancellation Step 担当者 (教頭) の場合、取消承認 Action が有効 (true) となる', () => {
    const appId = createAndApproveAnnualLeave('2026-09-10');
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '公務都合による取消',
    });

    const routeRes = getApplicationDetailViaRouteProjection(vicePrincipal, appId);
    const clientState = evaluateClientCancellationActionability(routeRes.application, vicePrincipal);

    assert.ok(clientState.currentCancelStep, 'currentCancelStep must be found');
    assert.strictEqual(clientState.currentCancelStep.step_name, '教頭取消確認');
    assert.strictEqual(clientState.canApproveCancellation, true, 'VP must have canApproveCancellation = true');
  });

  it('GT-CANCEL-UI-04: 現在承認者でないユーザー (本人 teacher1 / 第三者教員 teacher2 / 次段階校長 principal) には Cancellation Action が非表示 (Fail-Closed)', () => {
    const appId = createAndApproveAnnualLeave('2026-09-10');
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '公務都合による取消',
    });

    const routeRes = getApplicationDetailViaRouteProjection(vicePrincipal, appId);

    // 本人 (teacher1: 申請者かつ取消起案者) -> false (自己承認禁止)
    const teacher1State = evaluateClientCancellationActionability(routeRes.application, teacher1);
    assert.strictEqual(teacher1State.canApproveCancellation, false);

    // 第三者一般教員 (teacher2: 権限なし) -> false
    const teacher2State = evaluateClientCancellationActionability(routeRes.application, teacher2);
    assert.strictEqual(teacher2State.canApproveCancellation, false);

    // 校長 (principal: Step 2 担当だが、現在は Step 1 教頭確認待ちのため Step 1 の required_role_id と不一致) -> false
    const principalState = evaluateClientCancellationActionability(routeRes.application, principal);
    assert.strictEqual(principalState.canApproveCancellation, false);
  });

  it('GT-CANCEL-WF-05: 教頭取消確認 -> 校長取消決裁 の両StepでActionabilityが連続して成立する', () => {
    const appId = createAndApproveAnnualLeave('2026-09-10');
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '公務都合による取消',
    });

    // --- Step 1: 教頭取消確認 ---
    let routeRes = getApplicationDetailViaRouteProjection(vicePrincipal, appId);
    let vpState = evaluateClientCancellationActionability(routeRes.application, vicePrincipal);
    let prState = evaluateClientCancellationActionability(routeRes.application, principal);
    assert.strictEqual(vpState.canApproveCancellation, true, 'Step 1: VP can approve');
    assert.strictEqual(prState.canApproveCancellation, false, 'Step 1: Principal cannot approve yet');

    // 教頭が取消確認を実行
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const vpApproveRes = WorkflowEngine.approveCancellation(vicePrincipal, {
      applicationId: appId,
      expectedVersion: app.version,
    });
    assert.strictEqual(vpApproveRes.success, true);

    // --- Step 2: 校長取消決裁 ---
    routeRes = getApplicationDetailViaRouteProjection(principal, appId);
    vpState = evaluateClientCancellationActionability(routeRes.application, vicePrincipal);
    prState = evaluateClientCancellationActionability(routeRes.application, principal);
    assert.strictEqual(vpState.canApproveCancellation, false, 'Step 2: VP cannot approve anymore');
    assert.strictEqual(prState.canApproveCancellation, true, 'Step 2: Principal can approve');

    // 校長が取消決裁を実行
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const prApproveRes = WorkflowEngine.approveCancellation(principal, {
      applicationId: appId,
      expectedVersion: app.version,
    });
    assert.strictEqual(prApproveRes.success, true);

    // 取消完了後: activeCancellationCycle は null になり、Actionability は誰に対しても false
    routeRes = getApplicationDetailViaRouteProjection(principal, appId);
    assert.strictEqual(routeRes.application.activeCancellationCycle, null);
    prState = evaluateClientCancellationActionability(routeRes.application, principal);
    assert.strictEqual(prState.canApproveCancellation, false);
  });
});
