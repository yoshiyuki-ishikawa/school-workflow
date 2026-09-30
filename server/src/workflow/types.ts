export type StepResolutionReason = 'SELF_COLLISION' | null;

/**
 * StepActionType:
 * - Canonical Actions: 'REVIEW' | 'APPROVE' | 'DECIDE' | 'ORDER' | 'ACK'
 * - Legacy Compatibility Action: 'CHECK' (出張事後事務確認用)
 */
export type StepActionType = 'REVIEW' | 'APPROVE' | 'DECIDE' | 'ORDER' | 'CHECK' | 'ACK';

export type StepStatus = 'WAITING' | 'PENDING' | 'APPROVED' | 'RETURNED' | 'REJECTED' | 'SKIPPED';

/**
 * CanonicalCancellationDeclineAction:
 * 本計画 (Implementation Plan v1.1.1 FINAL) において正式に確定・凍結される唯一の Canonical Business Semantic。
 * 意味：「成立済み服務Factの取消申出に同意しない（原Factを維持し、Engine Primitive REJECT へマップする）」
 */
export type CanonicalCancellationDeclineAction = 'DECLINE_CANCELLATION';

/**
 * ProvisionalBusinessAction:
 * 実装上の便宜または将来の参考として定義されるが、本計画では制度的・Canonical に凍結されない暫定語彙。
 * （PROVISIONAL / NOT FROZEN BY THIS PLAN / OUTSIDE CURRENT SEMANTIC FREEZE）
 */
export type ProvisionalBusinessAction =
  | 'REJECT_APPLICATION'          // 暫定: 通常申請の否認
  | 'ACCEPT_CANCELLATION'         // 暫定: 取消申出への同意
  | 'ADVANCE_CANCELLATION_REVIEW' // 暫定: 取消審査ステップの進達
  | 'RETURN_CANCELLATION';        // 暫定: 取消申出の差戻し


export interface CandidateWorkflowStep {
  stepOrder: number;
  stepName: string;
  stepKey?: string;
  actionType: StepActionType;
  requiredRoleId: string;
  selectorType: 'POSITION' | 'ROLE' | 'USER';
  selectorValue: string;
  isFinalDecisionStep: boolean;
  approverUserId: number;
  approverDisplayName: string;
  approverPositionCode?: string;
  approverPositionName?: string;
}

export interface ResolvedWorkflowStep extends CandidateWorkflowStep {
  status: StepStatus;
  resolutionReason: StepResolutionReason;
  actionByUserId?: number | null;
  actedAt?: string | null;
}

export interface ApprovalStepRow {
  id: number;
  application_id: number;
  approval_cycle: number;
  workflow_cycle_id?: number | null;
  step_order: number;
  step_name: string;
  step_key?: string | null;
  step_label_snapshot: string;
  selector_type_snapshot: string;
  selector_value_snapshot: string;
  approver_user_id_snapshot?: number | null;
  approver_name_snapshot: string;
  approver_position_code_snapshot?: string | null;
  approver_position_name_snapshot?: string | null;
  required_role_id: string;
  assigned_user_id?: number | null;
  status: StepStatus;
  resolution_reason?: string | null;
  action_type?: string | null;
  is_final_decision_step?: number | null;
  action_by_user_id?: number | null;
  action_user_display_name?: string | null;
  action_user_stamp_name?: string | null;
  action_user_role_name?: string | null;
  comment?: string | null;
  acted_at?: string | null;
}
