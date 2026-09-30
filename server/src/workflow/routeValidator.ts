import { ResolvedWorkflowStep } from './types';
import { FinalAuthoritySelfCollisionError } from './collisionResolver';

export class WorkflowRouteValidationError extends Error {
  statusCode: number;
  errorCode: string;
  details?: Record<string, any>;

  constructor(statusCode: number, errorCode: string, message: string, details?: Record<string, any>) {
    super(message);
    this.name = 'WorkflowRouteValidationError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.details = details;
  }
}

/**
 * Independent Final Route Validator (Defense-in-Depth)
 * 
 * Final Authority Semantic Model v1.1 FINAL 準拠:
 * - Terminality != Authority Action
 * - Terminal Step (isFinalDecisionStep = 1) の Action は DECIDE, ACK, ORDER が合法
 * - 中間ステップへの DECIDE 混入禁止
 * - INV-SEM-09: 年次有給休暇 (LEAVE_ANNUAL) の通常ルートに DECIDE 割り当て禁止 (ACK 必須)
 */
export function validateResolvedRoute(
  subjectUserId: number,
  steps: ResolvedWorkflowStep[],
  appTypeId?: string
): void {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new WorkflowRouteValidationError(422, 'ROUTE_EMPTY', '承認ルートが空です');
  }

  // 1. Terminal Step Multiplicity 検証 (isFinalDecisionStep は厳密に1件)
  const finalFlagSteps = steps.filter((s) => !!s.isFinalDecisionStep);

  if (finalFlagSteps.length !== 1) {
    throw new WorkflowRouteValidationError(
      422,
      'INV_FA_03_FINAL_FLAG_COUNT_INVALID',
      `最終終端ステップフラグ (isFinalDecisionStep) は厳密に1件である必要があります (実際: ${finalFlagSteps.length}件)`
    );
  }

  const finalStep = finalFlagSteps[0];

  // 2. Terminal Authority Action 妥当性検証 (DECIDE, ACK, ORDER のみ合法)
  const validTerminalActions = ['DECIDE', 'ACK', 'ORDER'];
  if (!validTerminalActions.includes(finalStep.actionType)) {
    throw new WorkflowRouteValidationError(
      422,
      'INV_FA_01_TERMINAL_ACTION_INVALID',
      `終端ステップの ActionType は DECIDE, ACK, ORDER のいずれかである必要があります (実際: ${finalStep.actionType})`
    );
  }

  // 3. 中間ステップへの DECIDE 混入禁止 (DECIDE は終端でのみ行使可能)
  const nonFinalSteps = steps.filter((s) => s.stepOrder !== finalStep.stepOrder);
  const intermediateDecideSteps = nonFinalSteps.filter((s) => s.actionType === 'DECIDE');
  if (intermediateDecideSteps.length > 0) {
    throw new WorkflowRouteValidationError(
      422,
      'INV_FA_02_INTERMEDIATE_DECIDE_PROHIBITED',
      `中間ステップに決裁アクション (DECIDE) を設定することはできません (該当ステップ: ${intermediateDecideSteps.map((s) => s.stepOrder).join(', ')})`
    );
  }

  // 4. INV-SEM-09: 年次有給休暇 (LEAVE_ANNUAL) における DECIDE 割り当ての禁止 (ACK 必須)
  if (appTypeId === 'LEAVE_ANNUAL' && finalStep.actionType === 'DECIDE') {
    throw new WorkflowRouteValidationError(
      422,
      'INV_SEM_09_ANNUAL_LEAVE_DECIDE_PROHIBITED',
      '年次有給休暇（請求）の通常ルートに裁量決裁 (DECIDE) を設定することはできません (ACK を指定してください)'
    );
  }

  // 5. Terminality Enforcement (INV-FA-05)
  // 終端ステップより後ろに後続の承認・審査ステップ (APPROVE / REVIEW / DECIDE) が存在しないこと (事後確認 CHECK/ACK のみ許容)
  const postFinalSteps = steps.filter((s) => s.stepOrder > finalStep.stepOrder);
  const postApprovalSteps = postFinalSteps.filter(
    (s) => s.actionType === 'APPROVE' || s.actionType === 'REVIEW' || s.actionType === 'DECIDE'
  );
  if (postApprovalSteps.length > 0) {
    throw new WorkflowRouteValidationError(
      422,
      'INV_FA_05_NON_TERMINAL_FINAL_STEP',
      `終端ステップ (${finalStep.stepOrder}) より後ろに後続の承認・審査ステップが存在します: ${postApprovalSteps.map((s) => `${s.stepOrder}(${s.actionType})`).join(', ')}`
    );
  }

  // 6. Final Authority SELF Check (INV-SC-04, INV-SC-05)
  // 終端ステップが DECIDE の場合、申請者本人が決裁者であれば Fail-Closed (HD-02)
  if (finalStep.actionType === 'DECIDE' && finalStep.approverUserId === subjectUserId) {
    throw new FinalAuthoritySelfCollisionError(
      `申請者本人 (${subjectUserId}) が最終決裁者 (${finalStep.stepName || finalStep.stepOrder}) に指定されているため提出できません (HD-02: Fail-Closed)`,
      {
        stepOrder: finalStep.stepOrder,
        stepName: finalStep.stepName,
        approverUserId: finalStep.approverUserId,
        subjectUserId,
      }
    );
  }

  if (finalStep.status === 'SKIPPED') {
    throw new WorkflowRouteValidationError(
      422,
      'INV_SC_04_FINAL_STEP_SKIPPED',
      `終端ステップ (${finalStep.stepOrder}) は SKIPPED にできません`
    );
  }

  // 7. Per-Step Invariants (INV-SC-01, INV-SC-02, INV-SC-03)
  for (const step of steps) {
    // INV-SC-01: 本人が PENDING になってはならない
    if (step.status === 'PENDING' && step.approverUserId === subjectUserId) {
      throw new WorkflowRouteValidationError(
        422,
        'INV_SC_01_SELF_PENDING_PROHIBITED',
        `申請者本人 (${subjectUserId}) が Step ${step.stepOrder} で PENDING に設定されています (自己承認の禁止)`
      );
    }

    // INV-SC-02: 本人が WAITING に残っていてはならない (※終端が ACK の場合の自己確定は Wave 2 の Positive Auth で調停)
    // 現時点では終端が DECIDE または中間ステップでの自己 WAITING を遮断
    if (step.status === 'WAITING' && step.approverUserId === subjectUserId && step.actionType === 'DECIDE') {
      throw new WorkflowRouteValidationError(
        422,
        'INV_SC_02_SELF_WAITING_PROHIBITED',
        `申請者本人 (${subjectUserId}) が Step ${step.stepOrder} で WAITING に設定されています (自己承認の禁止)`
      );
    }

    // INV-SC-03: SKIPPED ステップに承認操作 Fact が存在してはならない
    if (step.status === 'SKIPPED') {
      if (step.actionByUserId !== null && step.actionByUserId !== undefined) {
        throw new WorkflowRouteValidationError(
          422,
          'INV_SC_03_SKIPPED_ACTION_USER_EXISTS',
          `SKIPPED ステップ (${step.stepOrder}) に actionByUserId が設定されています`
        );
      }
      if (step.actedAt !== null && step.actedAt !== undefined) {
        throw new WorkflowRouteValidationError(
          422,
          'INV_SC_03_SKIPPED_ACTED_AT_EXISTS',
          `SKIPPED ステップ (${step.stepOrder}) に actedAt が設定されています`
        );
      }
    }
  }

  // 8. Active PENDING Count (INV-SC-06)
  const pendingSteps = steps.filter((s) => s.status === 'PENDING');
  if (pendingSteps.length !== 1) {
    throw new WorkflowRouteValidationError(
      422,
      'INV_SC_06_PENDING_COUNT_INVALID',
      `アクティブな承認待ちステップ (PENDING) は厳密に1件である必要があります (実際: ${pendingSteps.length}件)`
    );
  }
}
