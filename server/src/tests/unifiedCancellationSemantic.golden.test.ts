import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, initDatabase, seedDatabase } from '../db';
import { WorkflowEngine } from '../workflow/engine';
import { AnnualLeaveService } from '../services/annualLeaveService';
import { resolveCancellationDeclineSemantic, resolveHistoricalCancellationSemantic } from '../workflow/historicalResolver';
import { resolveActionability } from '../../../client/src/utils/applicationActionabilityResolver';
import { UserContext } from '../types';

describe('Unified Cancellation Semantic Reconciliation — Dedicated Golden Tests (GT-CSEM-01〜14)', () => {
  let db: any;

  const teacher1: UserContext = {
    id: 1,
    username: 'teacher1',
    displayName: '教員 太郎',
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
    // テストごとの独立性を保つため、動的トランザクションデータをクリーンアップ
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

    // 標準の年休付与 (2026年度: 20日)
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

  function createAndApproveAnnualLeave(date: string = '2026-06-01'): number {
    const submitRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'LEAVE_ANNUAL',
      title: '【年休】取消検証用申請',
      formData: {
        unitType: 'DAY',
        startDate: date,
        endDate: date,
        calculatedDays: 1,
        reason: '私用',
      },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;

    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const vpRes = WorkflowEngine.approveApplication(vicePrincipal, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '教頭確認',
    });
    assert.strictEqual(vpRes.success, true);

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const pRes = WorkflowEngine.approveApplication(principal, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '校長承認',
    });
    assert.strictEqual(pRes.success, true);

    const checkApp = db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(checkApp.current_status, 'FINAL_APPROVED');
    return appId;
  }

  // GT-CSEM-01: REVIEW Cancellation REJECT ──► 422
  it('GT-CSEM-01: REVIEW Step（教頭）による Cancellation REJECT は 422 INVALID_ACTION_FOR_REVIEW で遮断される', () => {
    const appId = createAndApproveAnnualLeave('2026-06-01');
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '取消申出',
    });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const res = WorkflowEngine.rejectCancellation(vicePrincipal, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '教頭による不当却下試行',
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.statusCode, 422);
    assert.strictEqual(res.errorCode, 'INVALID_ACTION_FOR_REVIEW');
  });

  // GT-CSEM-02: Client bypass direct API REVIEW REJECT ──► 422 ＆ Zero-Mutation
  it('GT-CSEM-02: Client 迂回直接 API 呼出による REVIEW REJECT は 422 遮断され、DB に mutation が一切発生しない (Zero-Mutation)', () => {
    const appId = createAndApproveAnnualLeave('2026-06-01');
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '取消申出',
    });

    const beforeCycle = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ? AND cycle_purpose = \'CANCELLATION\'').get(appId) as any;
    const beforeStep = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ? AND approval_cycle = ? AND status = \'PENDING\'').get(appId, beforeCycle.approval_cycle) as any;
    const beforeApp = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const beforeUsage = db.prepare('SELECT * FROM leave_usages WHERE application_id = ?').get(appId) as any;
    const beforeBalance = AnnualLeaveService.getLeaveBalanceProjection(teacher1.id, '2026-06-01');

    // クライアント非表示を迂回して直接 API 呼出（教頭 REVIEW REJECT）
    const res = WorkflowEngine.rejectCancellation(vicePrincipal, {
      applicationId: appId,
      expectedVersion: beforeApp.version,
      comment: '不正バイパス試行',
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.statusCode, 422);

    // Zero-Mutation 検証
    const afterCycle = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ? AND cycle_purpose = \'CANCELLATION\'').get(appId) as any;
    const afterStep = db.prepare('SELECT * FROM application_approval_steps WHERE id = ?').get(beforeStep.id) as any;
    const afterApp = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const afterUsage = db.prepare('SELECT * FROM leave_usages WHERE application_id = ?').get(appId) as any;
    const afterBalance = AnnualLeaveService.getLeaveBalanceProjection(teacher1.id, '2026-06-01');

    assert.strictEqual(afterCycle.status, beforeCycle.status); // IN_PROGRESS
    assert.strictEqual(afterStep.status, beforeStep.status);   // PENDING
    assert.strictEqual(afterApp.version, beforeApp.version);   // version 不変
    assert.strictEqual(afterApp.current_status, 'FINAL_APPROVED');
    assert.strictEqual(afterUsage.status, beforeUsage.status); // ACTIVE
    assert.strictEqual(afterBalance.remainingDays, beforeBalance.remainingDays);
  });

  // GT-CSEM-03: non-final DECIDE REJECT ──► 422
  it('GT-CSEM-03: 非終端決裁ステップ (is_final_decision_step = 0) からの REJECT は 422 NOT_FINAL_DECISION_STEP で遮断される', () => {
    const appId = createAndApproveAnnualLeave('2026-06-01');
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '取消申出',
    });

    // DB 上で該当 PENDING ステップを action_type = 'DECIDE' だが is_final_decision_step = 0 に強制設定（中間決裁シミュレーション）
    db.prepare(`
      UPDATE application_approval_steps
      SET action_type = 'DECIDE', is_final_decision_step = 0
      WHERE application_id = ? AND status = 'PENDING'
    `).run(appId);

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const res = WorkflowEngine.rejectCancellation(vicePrincipal, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '非終端決裁での却下試行',
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.statusCode, 422);
    assert.strictEqual(res.errorCode, 'NOT_FINAL_DECISION_STEP');
  });

  // GT-CSEM-04: FINAL DECIDE Cancellation REJECT ──► success ＆ Cycle REJECTED
  it('GT-CSEM-04: FINAL DECIDE Step（校長）による Cancellation REJECT は正規に受理され、Cycle が REJECTED となる', () => {
    const appId = createAndApproveAnnualLeave('2026-06-01');
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '取消申出',
    });

    // 教頭が進達
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const vpRes = WorkflowEngine.approveCancellation(vicePrincipal, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '確認して進達',
    });
    assert.strictEqual(vpRes.success, true);

    // 校長が取消不同意 (Decline / REJECT)
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const pRes = WorkflowEngine.rejectCancellation(principal, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '業務都合により取消不同意',
    });
    assert.strictEqual(pRes.success, true);

    const cycle = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ? AND cycle_purpose = \'CANCELLATION\'').get(appId) as any;
    assert.strictEqual(cycle.status, 'REJECTED');
  });

  // GT-CSEM-05: Original Application Status maintained
  it('GT-CSEM-05: Cancellation Decline 完了後も、元の Application は FINAL_APPROVED を維持する', () => {
    const appId = createAndApproveAnnualLeave('2026-06-01');
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '取消申出',
    });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(vicePrincipal, { applicationId: appId, expectedVersion: app.version });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.rejectCancellation(principal, { applicationId: appId, expectedVersion: app.version, comment: '不同意' });

    const finalApp = db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(finalApp.current_status, 'FINAL_APPROVED');
  });

  // GT-CSEM-06: leave_usages ACTIVE maintained
  it('GT-CSEM-06: Cancellation Decline 完了後も、leave_usages は ACTIVE 状態を維持する', () => {
    const appId = createAndApproveAnnualLeave('2026-06-01');
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '取消申出',
    });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(vicePrincipal, { applicationId: appId, expectedVersion: app.version });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.rejectCancellation(principal, { applicationId: appId, expectedVersion: app.version, comment: '不同意' });

    const usage = db.prepare('SELECT status FROM leave_usages WHERE application_id = ?').get(appId) as any;
    assert.strictEqual(usage.status, 'ACTIVE');
  });

  // GT-CSEM-07: Annual Leave consumed state maintained
  it('GT-CSEM-07: Cancellation Decline 完了後も、年休残数は消化された状態（19日）を維持する', () => {
    const appId = createAndApproveAnnualLeave('2026-06-01');
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '取消申出',
    });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(vicePrincipal, { applicationId: appId, expectedVersion: app.version });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.rejectCancellation(principal, { applicationId: appId, expectedVersion: app.version, comment: '不同意' });

    const proj = AnnualLeaveService.getLeaveBalanceProjection(teacher1.id, '2026-06-01');
    assert.strictEqual(proj.remainingDays, 19);
  });

  // GT-CSEM-08: Attendance Fact maintained
  it('GT-CSEM-08: Cancellation Decline 完了後も、出勤簿の休暇 Fact は維持される', () => {
    const appId = createAndApproveAnnualLeave('2026-06-01');
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '取消申出',
    });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(vicePrincipal, { applicationId: appId, expectedVersion: app.version });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.rejectCancellation(principal, { applicationId: appId, expectedVersion: app.version, comment: '不同意' });

    // 年休 Fact が維持されていることの確認 (leave_usages が ACTIVE)
    const usage = db.prepare('SELECT status, unit_type, day_deduction_units FROM leave_usages WHERE application_id = ?').get(appId) as any;
    assert.strictEqual(usage.status, 'ACTIVE');
    assert.strictEqual(usage.unit_type, 'FULL_DAY');
    assert.strictEqual(usage.day_deduction_units, 2);
  });

  // GT-CSEM-09: Historical Strong Evidence ──► DECLINE_CANCELLATION
  it('GT-CSEM-09: 【REVISION-01 / P1-02】Historical Strong Evidence（Audit Log 相関）から DECLINE_CANCELLATION が決定論的に復元される', () => {
    const appId = createAndApproveAnnualLeave('2026-06-01');
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '取消申出',
    });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(vicePrincipal, { applicationId: appId, expectedVersion: app.version });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.rejectCancellation(principal, { applicationId: appId, expectedVersion: app.version, comment: '不同意' });

    const cycle = db.prepare('SELECT approval_cycle FROM application_workflow_cycles WHERE application_id = ? AND cycle_purpose = \'CANCELLATION\'').get(appId) as any;

    // Historical Strong Evidence Resolver 実行
    const res = resolveHistoricalCancellationSemantic({
      applicationId: appId,
      approvalCycle: cycle.approval_cycle,
    });

    assert.strictEqual(res.businessSemantic, 'DECLINE_CANCELLATION');
    assert.strictEqual(res.resolutionLevel, 'STRONG_EVIDENCE');
  });

  // GT-CSEM-10: Historical Fallback ──► DECLINE_CANCELLATION
  it('GT-CSEM-10: 【REVISION-01 / P1-02】Audit metadata 欠落レガシーデータでも Fallback Historical Contract から DECLINE_CANCELLATION が決定論的に復元される', () => {
    const appId = createAndApproveAnnualLeave('2026-06-01');
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '取消申出',
    });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(vicePrincipal, { applicationId: appId, expectedVersion: app.version });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.rejectCancellation(principal, { applicationId: appId, expectedVersion: app.version, comment: '不同意' });

    const cycle = db.prepare('SELECT approval_cycle FROM application_workflow_cycles WHERE application_id = ? AND cycle_purpose = \'CANCELLATION\'').get(appId) as any;

    // レガシー状態シミュレーション: audit_logs の metadata を null にクリア
    db.prepare('UPDATE audit_logs SET metadata = NULL WHERE entity_id = ? AND action = \'CANCEL_REJECT\'').run(String(appId));

    // Historical Fallback Resolver 実行
    const res = resolveHistoricalCancellationSemantic({
      applicationId: appId,
      approvalCycle: cycle.approval_cycle,
    });

    assert.strictEqual(res.businessSemantic, 'DECLINE_CANCELLATION');
    assert.strictEqual(res.resolutionLevel, 'FALLBACK_CONTRACT');
  });

  // GT-CSEM-11: Unknown / Future Semantic ──► NOT inferred ──► Fail-Closed
  it('GT-CSEM-11: 【REVISION-01】未知の cycle_purpose や非終端状態は DECLINE_CANCELLATION へ推測せず Fail-Closed となる', () => {
    const appId = createAndApproveAnnualLeave('2026-06-01');

    // 1. 取消目的以外の Cycle (例: APPROVAL サイクル) に対して取消不同意セマンティクス解決を試みる
    const resApproval = resolveHistoricalCancellationSemantic({
      applicationId: appId,
      approvalCycle: 1, // APPROVAL サイクル
    });
    assert.strictEqual(resApproval.businessSemantic, null);
    assert.strictEqual(resApproval.resolutionLevel, 'UNSUPPORTED');

    // 2. 存在しない Cycle に対して取消不同意セマンティクス解決を試みる
    const resNonExistent = resolveHistoricalCancellationSemantic({
      applicationId: appId,
      approvalCycle: 99,
    });
    assert.strictEqual(resNonExistent.businessSemantic, null);
    assert.strictEqual(resNonExistent.resolutionLevel, 'UNSUPPORTED');
  });

  // GT-CSEM-12: Normal REJECT vs Cancellation Decline ──► Semantic Separation (P1-01)
  it('GT-CSEM-12: 【P1-01】同一 Engine Primitive REJECT が、通常申請と取消申請で異なる Business Semantic へ厳格に分離される', () => {
    // 1. 通常申請コンテキスト（病気休暇: 承認ステップは REVIEW -> DECIDE）
    const submitRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'LEAVE_SICK',
      title: '通常申請REJECT分離テスト',
      formData: { unitType: 'DAY', startDate: '2026-07-01', endDate: '2026-07-01', calculatedDays: 1, reason: '体調不良' },
    });
    assert.strictEqual(submitRes.success, true);
    const normalAppId = submitRes.data.id;
    let normalApp = db.prepare('SELECT version FROM applications WHERE id = ?').get(normalAppId) as any;

    const vpRes = WorkflowEngine.approveApplication(vicePrincipal, {
      applicationId: normalAppId,
      expectedVersion: normalApp.version,
      comment: '教頭進達',
    });
    assert.strictEqual(vpRes.success, true);
    const preRejectNormalApp = db.prepare('SELECT current_status, version FROM applications WHERE id = ?').get(normalAppId) as any;

    // 通常申請で校長（DECIDE）が REJECT 試行 ──► Universal RETURN Model (v1.0 FINAL) により 422 Fail-Closed
    const normalRejRes = WorkflowEngine.rejectApplication(principal, {
      applicationId: normalAppId,
      expectedVersion: preRejectNormalApp.version,
      comment: '公務都合による申請否認',
    });
    assert.strictEqual(normalRejRes.success, false);
    assert.strictEqual(normalRejRes.statusCode, 422);
    assert.strictEqual(normalRejRes.errorCode, 'REJECT_ACTION_DEPRECATED');
    const normalAppAfterReject = db.prepare('SELECT current_status, version FROM applications WHERE id = ?').get(normalAppId) as any;
    assert.strictEqual(normalAppAfterReject.current_status, preRejectNormalApp.current_status); // Zero Mutation: 原申請状態維持 (IN_APPROVAL)
    assert.strictEqual(normalAppAfterReject.version, preRejectNormalApp.version);

    // 通常 REJECT は DECLINE_CANCELLATION ではない
    const normalSemantic = resolveCancellationDeclineSemantic({
      cyclePurpose: 'APPROVAL',
      stepActionType: 'DECIDE',
      isFinalDecisionStep: true,
      engineAction: 'REJECT',
    });
    assert.strictEqual(normalSemantic, null); // DECLINE_CANCELLATION ではない

    // 2. 取消申請コンテキスト
    const cancelAppId = createAndApproveAnnualLeave('2026-07-15');
    let cancelApp = db.prepare('SELECT version FROM applications WHERE id = ?').get(cancelAppId) as any;
    WorkflowEngine.requestCancellation(teacher1, { applicationId: cancelAppId, expectedVersion: cancelApp.version, cancellationReason: '取消' });
    cancelApp = db.prepare('SELECT version FROM applications WHERE id = ?').get(cancelAppId) as any;
    WorkflowEngine.approveCancellation(vicePrincipal, { applicationId: cancelAppId, expectedVersion: cancelApp.version });
    cancelApp = db.prepare('SELECT version FROM applications WHERE id = ?').get(cancelAppId) as any;

    // 取消申請で校長が REJECT (DECLINE_CANCELLATION)
    const cancelRejRes = WorkflowEngine.rejectCancellation(principal, {
      applicationId: cancelAppId,
      expectedVersion: cancelApp.version,
      comment: '取消申出不同意',
    });
    assert.strictEqual(cancelRejRes.success, true);
    const declinedApp = db.prepare('SELECT current_status FROM applications WHERE id = ?').get(cancelAppId) as any;
    assert.strictEqual(declinedApp.current_status, 'FINAL_APPROVED'); // 原Fact完全維持

    // 取消 REJECT は DECLINE_CANCELLATION に解決される
    const cancelSemantic = resolveCancellationDeclineSemantic({
      cyclePurpose: 'CANCELLATION',
      stepActionType: 'DECIDE',
      isFinalDecisionStep: true,
      engineAction: 'REJECT',
    });
    assert.strictEqual(cancelSemantic, 'DECLINE_CANCELLATION');
  });

  // GT-CSEM-13: REVIEW Actionability ──► canAdvanceCancellationReview = true, canDeclineCancellation = false
  it('GT-CSEM-13: REVIEW Step（教頭）における Actionability は進達許可・不同意非表示となる', () => {
    const appId = createAndApproveAnnualLeave('2026-06-01');
    let appRow = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: appRow.version,
      cancellationReason: '取消申出',
    });

    const appDetailRes = WorkflowEngine.getApplicationDetail(vicePrincipal, appId);
    assert.strictEqual(appDetailRes.success, true);
    const appDto = {
      ...appDetailRes.data.application,
      steps: appDetailRes.data.steps,
      activeCancellationCycle: appDetailRes.data.activeCancellationCycle,
    };

    const actionability = resolveActionability(appDto as any, vicePrincipal as any);

    assert.strictEqual(actionability.canAdvanceCancellationReview, true);
    assert.strictEqual(actionability.canDeclineCancellation, false); // 却下非表示
    assert.strictEqual(actionability.canAcceptCancellation, false);
    assert.strictEqual(actionability.canReturnCancellation, true);
  });

  // GT-CSEM-14: FINAL DECIDE Actionability ──► canAdvanceCancellationReview = false, canAcceptCancellation = true, canDeclineCancellation = false (Unified Two-Action v1.0 FINAL)
  it('GT-CSEM-14: 【P1-01 / Unified Two-Action v1.0 FINAL】FINAL DECIDE Step（校長）における Actionability は同意・差戻しが許可され、不同意はUI抑制される', () => {
    const appId = createAndApproveAnnualLeave('2026-06-01');
    let appRow = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: appRow.version,
      cancellationReason: '取消申出',
    });

    // 教頭が進達
    appRow = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(vicePrincipal, {
      applicationId: appId,
      expectedVersion: appRow.version,
      comment: '教頭進達',
    });

    // 校長が詳細取得
    const appDetailRes = WorkflowEngine.getApplicationDetail(principal, appId);
    assert.strictEqual(appDetailRes.success, true);
    const appDto = {
      ...appDetailRes.data.application,
      steps: appDetailRes.data.steps,
      activeCancellationCycle: appDetailRes.data.activeCancellationCycle,
    };

    const actionability = resolveActionability(appDto as any, principal as any);

    assert.strictEqual(actionability.canAdvanceCancellationReview, false);
    assert.strictEqual(actionability.canAcceptCancellation, true);
    assert.strictEqual(actionability.canDeclineCancellation, false); // Unified Two-Action v1.0 FINAL: 不同意ボタンはUI非表示(抑制)
    assert.strictEqual(actionability.canReturnCancellation, true);
  });
});
