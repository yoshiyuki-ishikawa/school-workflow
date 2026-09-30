import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, initDatabase, seedDatabase } from '../db';
import { WorkflowEngine } from '../workflow/engine';
import { AnnualLeaveService } from '../services/annualLeaveService';
import { UserContext } from '../types';

describe('Phase 2 Cancellation RESUBMIT Golden Tests (GT-CRESUB-*)', () => {
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

  const createAndReturnCancellation = (cancelStarter: UserContext = teacher1) => {
    const appId = createAndApproveAnnualLeave(teacher1, teacher1);
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    const cancelRes = WorkflowEngine.requestCancellation(cancelStarter, {
      applicationId: appId,
      cancellationReason: '初回取消理由：私用変更',
      expectedVersion: app.version,
    });
    assert.strictEqual(cancelRes.success, true);

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const retRes = WorkflowEngine.returnCancellation(vicePrincipal, {
      applicationId: appId,
      comment: '理由をより具体的に記載して再提出してください',
      expectedVersion: app.version,
    });
    assert.strictEqual(retRes.success, true);

    return appId;
  };

  it('GT-CRESUB-01: 正しい Action Owner (started_by_user_id) だけが再提出に成功する', () => {
    const appId = createAndReturnCancellation(teacher1);
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    const resubmitRes = WorkflowEngine.resubmitCancellation(teacher1, {
      applicationId: appId,
      cancellationReason: '修正後取消理由：9月10日の予定変更が確定したため',
      expectedVersion: app.version,
    });

    assert.strictEqual(resubmitRes.success, true);
    assert.strictEqual(resubmitRes.statusCode, 200);
    assert.strictEqual(resubmitRes.data.approvalCycle, 3);
  });

  it('GT-CRESUB-02: 代理取消起案された申請に対し、原申請本人 (非取消起案者) による再提出は 403 で拒絶される', () => {
    // Principal (School Manager) submits cancellation on behalf of teacher1
    const appId = createAndApproveAnnualLeave(teacher1, teacher1);
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(principal, {
      applicationId: appId,
      cancellationReason: '校長による代理取消起案',
      expectedVersion: app.version,
    });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.returnCancellation(vicePrincipal, {
      applicationId: appId,
      comment: '代理理由補足求む',
      expectedVersion: app.version,
    });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    // teacher1 (原申請本人だが cancellation started_by_user_id ではない) が再提出を試みる
    const resubmitRes = WorkflowEngine.resubmitCancellation(teacher1, {
      applicationId: appId,
      cancellationReason: '本人が再提出しようとする',
      expectedVersion: app.version,
    });

    assert.strictEqual(resubmitRes.success, false);
    assert.strictEqual(resubmitRes.statusCode, 403);
    assert.strictEqual(resubmitRes.errorCode, 'FORBIDDEN_CANCELLATION_RESUBMIT');
  });

  it('GT-CRESUB-03: 第三者教員 (teacher2) による再提出は 403 で拒絶される (Fail-Closed)', () => {
    const appId = createAndReturnCancellation(teacher1);
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    const resubmitRes = WorkflowEngine.resubmitCancellation(teacher2, {
      applicationId: appId,
      cancellationReason: '第三者による再提出',
      expectedVersion: app.version,
    });

    assert.strictEqual(resubmitRes.success, false);
    assert.strictEqual(resubmitRes.statusCode, 403);
    assert.strictEqual(resubmitRes.errorCode, 'FORBIDDEN_CANCELLATION_RESUBMIT');
  });

  it('GT-CRESUB-04: started_by_user_id 欠損時は誰に対しても 403 で Fail-Closed する', () => {
    const appId = createAndReturnCancellation(teacher1);
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    // Simulate corrupted cycle with null started_by_user_id
    db.prepare("UPDATE application_workflow_cycles SET workflow_source = 'LEGACY_SNAPSHOT', started_by_user_id = NULL WHERE application_id = ? AND approval_cycle = 2").run(appId);

    const resubmitRes = WorkflowEngine.resubmitCancellation(teacher1, {
      applicationId: appId,
      cancellationReason: '欠損Cycleへの再提出',
      expectedVersion: app.version,
    });

    assert.strictEqual(resubmitRes.success, false);
    assert.strictEqual(resubmitRes.statusCode, 403);
  });

  it('GT-CRESUB-05 & GT-CRESUB-08: Option B - 新Cycle (approval_cycle = 3) が生成され、新取消理由が保存される', () => {
    const appId = createAndReturnCancellation(teacher1);
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.resubmitCancellation(teacher1, {
      applicationId: appId,
      cancellationReason: '9月10日の年休取消理由の補足詳細',
      expectedVersion: app.version,
    });

    const newCycle = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ? AND approval_cycle = 3').get(appId) as any;
    assert.ok(newCycle);
    assert.strictEqual(newCycle.cycle_purpose, 'CANCELLATION');
    assert.strictEqual(newCycle.status, 'IN_PROGRESS');
    assert.strictEqual(newCycle.cancellation_reason, '9月10日の年休取消理由の補足詳細');
    assert.strictEqual(newCycle.started_by_user_id, teacher1.id);
  });

  it('GT-CRESUB-06 & GT-CRESUB-07: 旧 RETURNED Cycle (Cycle 2) およびそのステップ・理由が 100% 不変に維持される', () => {
    const appId = createAndReturnCancellation(teacher1);
    const cycle2Before = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ? AND approval_cycle = 2').get(appId) as any;
    const steps2Before = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ? AND approval_cycle = 2').all(appId) as any[];

    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.resubmitCancellation(teacher1, {
      applicationId: appId,
      cancellationReason: '新取消理由',
      expectedVersion: app.version,
    });

    const cycle2After = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ? AND approval_cycle = 2').get(appId) as any;
    const steps2After = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ? AND approval_cycle = 2').all(appId) as any[];

    assert.strictEqual(cycle2After.status, 'RETURNED');
    assert.strictEqual(cycle2After.cancellation_reason, cycle2Before.cancellation_reason);
    assert.strictEqual(cycle2After.return_reason, cycle2Before.return_reason);
    assert.strictEqual(steps2After.length, steps2Before.length);
    assert.strictEqual(steps2After[0].status, 'RETURNED');
    assert.strictEqual(steps2After[0].comment, steps2Before[0].comment);
  });

  it('GT-CRESUB-09: 再提出後の新 Cycle に最新 Policy に基づく承認ステップ (Step 1 PENDING, Step 2 WAITING) が生成される', () => {
    const appId = createAndReturnCancellation(teacher1);
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.resubmitCancellation(teacher1, {
      applicationId: appId,
      cancellationReason: '新取消理由',
      expectedVersion: app.version,
    });

    const newSteps = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ? AND approval_cycle = 3 ORDER BY step_order ASC').all(appId) as any[];
    assert.strictEqual(newSteps.length, 2);
    assert.strictEqual(newSteps[0].step_order, 1);
    assert.strictEqual(newSteps[0].status, 'PENDING');
    assert.strictEqual(newSteps[0].required_role_id, 'VICE_PRINCIPAL');
    assert.strictEqual(newSteps[1].step_order, 2);
    assert.strictEqual(newSteps[1].status, 'WAITING');
    assert.strictEqual(newSteps[1].required_role_id, 'PRINCIPAL');
  });

  it('GT-CRESUB-10: 二重再提出は 2件目で 409 Conflict となり遮断される (Optimistic Concurrency)', () => {
    const appId = createAndReturnCancellation(teacher1);
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    const res1 = WorkflowEngine.resubmitCancellation(teacher1, {
      applicationId: appId,
      cancellationReason: '1件目再提出',
      expectedVersion: app.version,
    });
    assert.strictEqual(res1.success, true);

    // 同じ expectedVersion で再度送信
    const res2 = WorkflowEngine.resubmitCancellation(teacher1, {
      applicationId: appId,
      cancellationReason: '2件目並行再提出',
      expectedVersion: app.version,
    });
    assert.strictEqual(res2.success, false);
    assert.strictEqual(res2.statusCode, 409);
    assert.strictEqual(res2.errorCode, 'CONFLICT_DETECTED');
  });

  it('GT-CRESUB-11: expectedVersion 不一致時は 409 で拒絶される', () => {
    const appId = createAndReturnCancellation(teacher1);

    const res = WorkflowEngine.resubmitCancellation(teacher1, {
      applicationId: appId,
      cancellationReason: '古いバージョン指定',
      expectedVersion: 999,
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.statusCode, 409);
  });

  it('GT-CRESUB-12: トランザクション失敗時は Partial State が残らず All-or-Nothing でロールバックされる', () => {
    const appId = createAndReturnCancellation(teacher1);
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    // 空の理由で失敗させる
    const res = WorkflowEngine.resubmitCancellation(teacher1, {
      applicationId: appId,
      cancellationReason: '   ',
      expectedVersion: app.version,
    });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.statusCode, 400);

    const cycle3 = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ? AND approval_cycle = 3').get(appId);
    assert.strictEqual(cycle3, undefined);
  });

  it('GT-CRESUB-13 & GT-CRESUB-14: 再提出中も applications.current_status = FINAL_APPROVED および出勤簿・年休引当が 100% 維持される', () => {
    const appId = createAndReturnCancellation(teacher1);
    const usagesBefore = db.prepare('SELECT * FROM leave_usages WHERE application_id = ?').all(appId) as any[];
    assert.strictEqual(usagesBefore.length, 1);
    assert.strictEqual(usagesBefore[0].status, 'ACTIVE');

    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.resubmitCancellation(teacher1, {
      applicationId: appId,
      cancellationReason: '再提出中',
      expectedVersion: app.version,
    });

    const appAfter = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(appAfter.current_status, 'FINAL_APPROVED');

    const usagesAfter = db.prepare('SELECT * FROM leave_usages WHERE application_id = ?').all(appId) as any[];
    assert.strictEqual(usagesAfter.length, 1);
    assert.strictEqual(usagesAfter[0].status, 'ACTIVE');
  });

  it('GT-CRESUB-15: 再提出後、教頭 → 校長の承認アクション (Actionability) が正常に成立する', () => {
    const appId = createAndReturnCancellation(teacher1);
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.resubmitCancellation(teacher1, {
      applicationId: appId,
      cancellationReason: '再提出後審査',
      expectedVersion: app.version,
    });

    let detail = WorkflowEngine.getApplicationDetail(vicePrincipal, appId);
    assert.strictEqual(detail.data.activeCancellationCycle?.approval_cycle, 3);

    // 教頭が Cycle 3 を承認
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const vpApprove = WorkflowEngine.approveCancellation(vicePrincipal, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '再提出確認OK',
    });
    assert.strictEqual(vpApprove.success, true);

    // 校長が Cycle 3 を承認 (最終取消決裁)
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const prApprove = WorkflowEngine.approveCancellation(principal, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '再提出決裁OK',
    });
    assert.strictEqual(prApprove.success, true);

    const finalApp = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(finalApp.current_status, 'CANCELLED');
  });

  it('GT-CRESUB-16 & GT-CRESUB-17: 再提出後に再度差戻し (2回目 RETURNED) されても、Action Owner が再々提出 (Cycle 4) 可能', () => {
    const appId = createAndReturnCancellation(teacher1);
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    // Cycle 3: 1回目の再提出
    WorkflowEngine.resubmitCancellation(teacher1, {
      applicationId: appId,
      cancellationReason: '1回目再提出理由',
      expectedVersion: app.version,
    });

    // 教頭が Cycle 3 を再度差戻し
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const ret2 = WorkflowEngine.returnCancellation(vicePrincipal, {
      applicationId: appId,
      comment: '2回目差戻し理由：再度修正求む',
      expectedVersion: app.version,
    });
    assert.strictEqual(ret2.success, true);

    // Cycle 4: 2回目の再提出 (再々提出)
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const resubmit4 = WorkflowEngine.resubmitCancellation(teacher1, {
      applicationId: appId,
      cancellationReason: '2回目再提出理由：完全に補足しました',
      expectedVersion: app.version,
    });
    assert.strictEqual(resubmit4.success, true);
    assert.strictEqual(resubmit4.data.approvalCycle, 4);

    const cycles = db.prepare('SELECT approval_cycle, cycle_purpose, status FROM application_workflow_cycles WHERE application_id = ? ORDER BY approval_cycle ASC').all(appId) as any[];
    assert.strictEqual(cycles.length, 4);
    assert.strictEqual(cycles[0].status, 'APPROVED'); // Cycle 1 (原申請)
    assert.strictEqual(cycles[1].status, 'RETURNED'); // Cycle 2 (1回目取消)
    assert.strictEqual(cycles[2].status, 'RETURNED'); // Cycle 3 (2回目取消)
    assert.strictEqual(cycles[3].status, 'IN_PROGRESS'); // Cycle 4 (3回目取消)
  });

  it('GT-CRESUB-18: 再提出された Cancellation Cycle の最終承認時に、既存の finalizeCancellation (年休ロット復元) が正常稼働する', () => {
    const appId = createAndReturnCancellation(teacher1);
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.resubmitCancellation(teacher1, {
      applicationId: appId,
      cancellationReason: '再提出',
      expectedVersion: app.version,
    });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(vicePrincipal, {
      applicationId: appId,
      expectedVersion: app.version,
    });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(principal, {
      applicationId: appId,
      expectedVersion: app.version,
    });

    const usages = db.prepare('SELECT * FROM leave_usages WHERE application_id = ?').all(appId) as any[];
    assert.strictEqual(usages.length, 1);
    assert.strictEqual(usages[0].status, 'REVERSED');
  });
});
