import { Application, User } from '../types';

export interface ActionabilityState {
  canApprove: boolean;
  canReturn: boolean;
  canReject: boolean;
  canEditDraft: boolean;
  canResubmit: boolean;
  canWithdraw: boolean;
  canRequestCancellation: boolean;
  canApproveCancellation: boolean;
  canResubmitCancellation: boolean;
  canResolveCoverage: boolean;
  canSubmitReport: boolean;

  // 新設 Cancellation 細粒度 Actionability (Presentation Hints: Client Actionability ≠ Authorization)
  canAdvanceCancellationReview: boolean; // 教頭 REVIEW ステップの進達権限
  canAcceptCancellation: boolean;        // 校長 DECIDE ステップの同意権限
  canDeclineCancellation: boolean;       // 校長 DECIDE ステップの不同意権限
  canReturnCancellation: boolean;        // 取消差戻し権限
}

/**
 * applicationActionabilityResolver.ts
 * 
 * Server DTO Fact を入力とする Pure Presentation Visibility Resolver。
 * 
 * 【Architecture Invariant】
 * 1. Authorization Authority = Server: Client は認可判定者ではなく、Server Fact の投影者（Projection）である。
 * 2. Parallel Authorization Logic = 0: Client で独自の RBAC ルールや Workflow ルールを再発明しない。
 * 3. Server-Authoritative DTO Fact に完全準拠:
 *    - steps (PENDING かつ assigned / required_role_id)
 *    - subject_user_id / applicant_id
 *    - submitted_by_user_id / proxy_user_name
 *    - activeCancellationCycle / latestCancellationCycle / cancellationReturn
 */
/**
 * 代理申請判定の唯一の真実 (SSOT)
 * Primary SSOT: app.submission_actor_type === 'PROXY'
 * Legacy Fallback: submission_actor_type が未設定の場合のみ ID 不一致を評価
 */
export function isProxySubmission(app: Application): boolean {
  if (app.submission_actor_type) {
    return app.submission_actor_type === 'PROXY';
  }
  const subjectId = app.subject_user_id || app.applicant_id;
  return Boolean(app.submitted_by_user_id && subjectId && app.submitted_by_user_id !== subjectId);
}

export function resolveActionability(app: Application, currentUser: User): ActionabilityState {
  const isSubject = (app.subject_user_id || app.applicant_id) === currentUser.id;
  const isActualProxy = isProxySubmission(app);
  const isProxySubmitter = isActualProxy && app.submitted_by_user_id === currentUser.id;
  const isSchoolManager = currentUser.roles.some((r) => ['VICE_PRINCIPAL', 'PRINCIPAL'].includes(r));
  const isPrincipal = currentUser.roles.includes('PRINCIPAL');
  const isApproved = app.current_status === 'FINAL_APPROVED' || app.current_status === 'TRIP_APPROVED';
  const hasActiveCancellation = Boolean(app.activeCancellationCycle && app.activeCancellationCycle.status === 'IN_PROGRESS');

  // 通常承認ステップ (Server DTO の current_step_order & status = PENDING に完全準拠)
  const currentStep = app.steps?.find(
    (s) => s.step_order === app.current_step_order && s.status === 'PENDING'
  );

  // ステップ属性
  const isCurrentStepAck = currentStep?.action_type === 'ACK';
  const isCurrentStepDecide = currentStep?.action_type === 'DECIDE';
  const isCurrentStepFinal = Boolean(currentStep?.is_final_decision_step);

  // Positive ACK-A (W2-01 / HD-SEM-04): 校長本人による終端受領確認 (Server evaluateApproverAuthorization 互換)
  const isLegitimateSelfAck = Boolean(
    isSubject &&
    isCurrentStepAck &&
    isCurrentStepFinal &&
    isPrincipal
  );

  // 自己承認衝突のブロック (Positive ACK-A のみ例外通過、SELF-DECISION は厳格遮断)
  const isSelfCollisionBlocked = isSubject && !isLegitimateSelfAck;

  // Server 側の evaluateApproverAuthorization に対応する Presentation Projection
  const isPendingApprover = Boolean(
    currentStep &&
    !isSelfCollisionBlocked &&
    !isProxySubmitter &&
    currentUser.roles.includes(currentStep.required_role_id) &&
    (!currentStep.assigned_user_id || currentStep.assigned_user_id === currentUser.id)
  );

  // 取消承認ステップ (Server DTO の activeCancellationCycle & status = PENDING に完全準拠)
  const activeCancelCycleNum = app.activeCancellationCycle?.approval_cycle;
  const currentCancelStep = app.steps?.find(
    (s) => s.approval_cycle === activeCancelCycleNum && s.status === 'PENDING'
  );
  const isCancelStarter = app.activeCancellationCycle?.started_by_user_id === currentUser.id;
  const isPendingCancelApprover = Boolean(
    currentCancelStep &&
    !isSubject &&
    !isCancelStarter &&
    currentUser.roles.includes(currentCancelStep.required_role_id) &&
    (!currentCancelStep.assigned_user_id || currentCancelStep.assigned_user_id === currentUser.id)
  );

  const isCurrentCancelStepReview = currentCancelStep?.action_type === 'REVIEW';
  const isCurrentCancelStepApprove = currentCancelStep?.action_type === 'APPROVE';
  const isCurrentCancelStepDecide = currentCancelStep?.action_type === 'DECIDE';
  const isCurrentCancelStepFinal = Boolean(currentCancelStep?.is_final_decision_step);

  // 中間進達ステップ: REVIEW または 非終端APPROVE
  const isCurrentCancelStepIntermediate =
    isCurrentCancelStepReview || (isCurrentCancelStepApprove && !isCurrentCancelStepFinal);

  // Presentation Hints (Client Actionability ≠ Authorization: Server re-verifies authoritatively)
  const canAdvanceCancellationReview = isPendingCancelApprover && isCurrentCancelStepIntermediate;
  const canAcceptCancellation = isPendingCancelApprover && isCurrentCancelStepDecide && isCurrentCancelStepFinal;
  // Unified Two-Action Cancellation Contract (v1.0 FINAL): 全服務で取消不同意(DECLINE)はUI露出させない
  const canDeclineCancellation = false;
  const canReturnCancellation = isPendingCancelApprover && currentCancelStep?.action_type !== 'ACK';
  const canApproveCancellation = canAdvanceCancellationReview || canAcceptCancellation;

  // 取消起案権限 (HD-W1-01 Option B: 本人、元の代理作成者、または管理職)
  const isOriginalProxyCreator = isActualProxy && app.submitted_by_user_id === currentUser.id;
  const canRequestCancellation = Boolean(isApproved && !hasActiveCancellation && (isSubject || isOriginalProxyCreator || isSchoolManager));

  // 申請取下げ (非終端状態かつ本人・代理者のみ)
  const terminalStatuses = ['FINAL_APPROVED', 'TRIP_APPROVED', 'REJECTED', 'WITHDRAWN', 'CANCELLED'];
  const canWithdraw = (isSubject || isProxySubmitter) && !terminalStatuses.includes(app.current_status);

  return {
    canApprove: isPendingApprover,
    // 差戻し: ACKステップでは非裁量のため禁止 (INV-SEM-04)、REVIEW/DECIDE では許可
    canReturn: isPendingApprover && !isCurrentStepAck,
    // 却下: Universal RETURN Model (v1.0 FINAL / INV-URETURN-01): 通常WorkflowにおけるGeneric REJECTは全面廃止
    canReject: false,
    canEditDraft: app.current_status === 'DRAFT' && (isSubject || isProxySubmitter),
    canResubmit: app.current_status === 'RETURNED' && (isSubject || isProxySubmitter),
    canWithdraw,
    canRequestCancellation,
    canApproveCancellation,
    canAdvanceCancellationReview,
    canAcceptCancellation,
    canDeclineCancellation,
    canReturnCancellation,
    canResubmitCancellation: Boolean(
      app.cancellationReturn &&
      app.cancellationReturn.status === 'RETURNED' &&
      app.cancellationReturn.actionActorUserId === currentUser.id
    ),
    // GAP-09: 進行中承認サイクルの PENDING 承認者に限定
    canResolveCoverage: isPendingApprover,
    // GAP-03: 出張ドメイン固有の復命書提出権限
    canSubmitReport: Boolean(
      app.type_id === 'BUSINESS_TRIP' &&
      (app.current_status === 'TRIP_APPROVED' || app.current_status === 'RETURNED') &&
      (isSubject || isProxySubmitter)
    ),
  };
}
