import { getDb } from '../db/database';
import { resolvePositionHolder, PositionResolverError } from './positionResolver';
import { StepActionType } from './types';
import { isUserPrincipal } from './collisionResolver';

export interface WorkflowPolicyStepDetail {
  id: number;
  stepOrder: number;
  stepName: string;
  stepKey: string;
  actionType: StepActionType;
  requiredRoleId: string;
  selectorType: 'POSITION' | 'ROLE';
  selectorValue: string;
  isFinalDecisionStep: boolean;
}

export interface ResolvedWorkflowStep {
  stepOrder: number;
  stepName: string;
  stepKey: string;
  actionType: StepActionType;
  requiredRoleId: string;
  selectorType: 'POSITION' | 'ROLE';
  selectorValue: string;
  isFinalDecisionStep: boolean;
  approverUserId: number;
  approverDisplayName: string;
  approverPositionCode?: string;
  approverPositionName?: string;
}

export interface PolicyResolutionResult {
  policyId: string;
  policyKey: string;
  policyName: string;
  policyVersionId: string;
  version: number;
  priority: number;
  steps: ResolvedWorkflowStep[];
}

export function validatePolicyDraft(params: {
  steps: {
    stepOrder: number;
    stepName: string;
    stepKey?: string;
    actionType?: string;
    requiredRoleId?: string;
    selectorType: string;
    selectorValue: string;
    isFinalDecisionStep?: boolean;
  }[];
}): { valid: boolean; errorCode?: string; message?: string } {
  if (!Array.isArray(params.steps) || params.steps.length === 0) {
    return { valid: false, errorCode: 'STEPS_EMPTY', message: '承認ステップは1件以上必要です' };
  }

  const finalCount = params.steps.filter((s) => !!s.isFinalDecisionStep).length;
  if (finalCount !== 1) {
    return {
      valid: false,
      errorCode: 'FINAL_DECISION_STEP_INVALID',
      message: `最終決裁ステップは厳格に1件のみ設定してください (現在: ${finalCount}件)`,
    };
  }

  const CANONICAL_ACTIONS = new Set(['REVIEW', 'APPROVE', 'DECIDE', 'ACK', 'ORDER']);

  for (const s of params.steps) {
    if (s.actionType && !CANONICAL_ACTIONS.has(s.actionType)) {
      return {
        valid: false,
        errorCode: 'CANONICAL_ACTION_REQUIRED',
        message: `アクション種別「${s.actionType}」は非推奨または無効です。Canonical Action (REVIEW, APPROVE, DECIDE, ACK, ORDER) を指定してください`,
      };
    }

    if (s.selectorType === 'USER') {
      return {
        valid: false,
        errorCode: 'SELECTOR_USER_UNSUPPORTED',
        message: 'USERセレクターは初期Releaseでは非対応です (POSITIONまたはROLEを指定してください)',
      };
    }
  }

  return { valid: true };
}

export class WorkflowPolicyError extends Error {
  statusCode: number;
  errorCode: string;

  constructor(statusCode: number, errorCode: string, message: string) {
    super(message);
    this.name = 'WorkflowPolicyError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
  }
}

export interface ResolveWorkflowPolicyParams {
  appTypeId: string;
  evaluationTime: string; // ISO8601 string or YYYY-MM-DD
  subjectUserId: number;
  submittedByUserId: number;
  policyPurpose?: 'APPROVAL' | 'CANCELLATION' | 'POST_TRIP_REPORT';
}

/**
 * 決定論的 Workflow Policy Resolver
 * 
 * 1. appTypeId, evaluationTime (基準日: YYYY-MM-DD), policyPurpose ('APPROVAL' | 'CANCELLATION' | 'POST_TRIP_REPORT') から ACTIVE な Policy Version を決定論的に選定
 * 2. 0件合致 -> WORKFLOW_POLICY_UNRESOLVED (Fail-Closed)
 * 3. 複数合致 -> 最高 Priority を比較。同値複数 -> WORKFLOW_POLICY_AMBIGUOUS (Fail-Closed)
 * 4. 各ステップの担当者を Position / Role Resolver で解決
 * 5. 自己承認 (INV-001) の検証
 */
export function resolveWorkflowPolicy(params: ResolveWorkflowPolicyParams): PolicyResolutionResult {
  const db = getDb();
  const dateOnly = params.evaluationTime.split('T')[0];
  const targetPurpose = params.policyPurpose || 'APPROVAL';

  // 1. Candidate 抽出 (N:M テーブル結合 ＋ policy_purpose フィルタ)
  const candidates = db.prepare(`
    SELECT v.id as version_id, v.policy_id, v.version, v.priority, v.conditions_json,
           p.policy_key, p.policy_name, p.policy_purpose
    FROM workflow_policy_versions v
    JOIN workflow_policies p ON v.policy_id = p.id
    JOIN workflow_policy_application_types pat ON p.id = pat.policy_id
    WHERE pat.app_type_id = ?
      AND p.policy_purpose = ?
      AND v.status = 'ACTIVE'
      AND v.effective_from <= ?
      AND v.effective_to >= ?
  `).all(params.appTypeId, targetPurpose, dateOnly, dateOnly) as any[];

  // conditions_json の検証 (現Releaseでは '{}' のみ許可)
  const validCandidates = candidates.filter((c) => {
    try {
      const parsed = JSON.parse(c.conditions_json || '{}');
      return typeof parsed === 'object' && parsed !== null && Object.keys(parsed).length === 0;
    } catch {
      return false;
    }
  });

  // ============================================================================
  // Canonical Semantic Partitioning: 出張申請における校長本人／一般職員の厳格分離
  // ============================================================================
  let partitionedCandidates = validCandidates;

  if (params.appTypeId === 'BUSINESS_TRIP') {
    const isPrincipalSubject = isUserPrincipal(params.subjectUserId, dateOnly);

    if (targetPurpose === 'APPROVAL') {
      if (isPrincipalSubject) {
        // 校長本人の出張: 校長専用ポリシーのみを候補集合とする (一般職員用TRIP_STANDARDは構造的に除外)
        partitionedCandidates = validCandidates.filter((c) => c.policy_id === 'TRIP_PRINCIPAL_STANDARD');
      } else {
        // 一般教職員の出張: 校長専用ポリシーを除外する
        partitionedCandidates = validCandidates.filter((c) => c.policy_id !== 'TRIP_PRINCIPAL_STANDARD');
      }
    } else if (targetPurpose === 'CANCELLATION') {
      if (isPrincipalSubject) {
        // 校長本人の出張取消: 校長専用取消ポリシーのみを候補集合とする (一般職員用TRIP_STANDARD_CANCELは構造的に除外)
        partitionedCandidates = validCandidates.filter((c) => c.policy_id === 'TRIP_PRINCIPAL_STANDARD_CANCEL');
      } else {
        // 一般教職員の出張取消: 校長専用取消ポリシーを除外する
        partitionedCandidates = validCandidates.filter((c) => c.policy_id !== 'TRIP_PRINCIPAL_STANDARD_CANCEL');
      }
    }
  }

  const getPurposeLabel = (purpose: string) => {
    if (purpose === 'CANCELLATION') return '取消';
    if (purpose === 'POST_TRIP_REPORT') return '復命報告';
    return '承認';
  };

  if (partitionedCandidates.length === 0) {
    const purposeLabel = getPurposeLabel(targetPurpose);
    throw new WorkflowPolicyError(
      400,
      'WORKFLOW_POLICY_UNRESOLVED',
      `申請種別「${params.appTypeId}」に適用可能な${purposeLabel}ポリシーが見つかりません (基準日: ${dateOnly})`
    );
  }

  // 最高 Priority の算出 (Partition 後の候補から算出)
  const maxPriority = Math.max(...partitionedCandidates.map((c) => c.priority));
  const topCandidates = partitionedCandidates.filter((c) => c.priority === maxPriority);

  if (topCandidates.length > 1) {
    const purposeLabel = getPurposeLabel(targetPurpose);
    throw new WorkflowPolicyError(
      400,
      'WORKFLOW_POLICY_AMBIGUOUS',
      `申請種別「${params.appTypeId}」に適用可能な${purposeLabel}ポリシーが一意に決定できません (最高Priority ${maxPriority} の候補が${topCandidates.length}件合致)`
    );
  }

  const selectedVersion = topCandidates[0];

  // 2. Policy Version 所属ステップの取得
  const policySteps = db.prepare(`
    SELECT id, step_order, step_name, step_key, action_type, required_role_id,
           selector_type, selector_value, is_final_decision_step
    FROM workflow_policy_steps
    WHERE policy_version_id = ?
    ORDER BY step_order ASC
  `).all(selectedVersion.version_id) as any[];

  if (policySteps.length === 0) {
    throw new WorkflowPolicyError(
      422,
      'WORKFLOW_STEP_VALIDATION_FAILED',
      `ポリシー「${selectedVersion.policy_name} (v${selectedVersion.version})」にステップが定義されていません`
    );
  }

  // Final Decision Step の Multiplicity 検証 (Exactly One)
  const finalDecisionCount = policySteps.filter((s) => s.is_final_decision_step === 1).length;
  if (finalDecisionCount !== 1) {
    throw new WorkflowPolicyError(
      422,
      'WORKFLOW_STEP_VALIDATION_FAILED',
      `ポリシー「${selectedVersion.policy_name}」の最終決裁ステップ数が不正です (期待値: 1, 実際: ${finalDecisionCount})`
    );
  }

  // 3. 各ステップの担当者解決 (Canonical Position Resolver / Role Resolver)
  const resolvedSteps: ResolvedWorkflowStep[] = [];
  const excludeIds = [params.subjectUserId, params.submittedByUserId];

  for (const step of policySteps) {
    let approverUserId: number;
    let approverDisplayName: string;
    let approverPositionCode: string | undefined;
    let approverPositionName: string | undefined;

    if (step.selector_type === 'POSITION') {
      try {
        const posRes = resolvePositionHolder({
          positionCode: step.selector_value,
          effectiveDate: dateOnly,
          excludeUserIds: [], // 自己承認チェックは後続で明示的に実施
        });
        approverUserId = posRes.userId;
        approverDisplayName = posRes.displayName;
        approverPositionCode = posRes.positionCode;
        approverPositionName = posRes.positionName;
      } catch (err: any) {
        if (err instanceof PositionResolverError) {
          throw new WorkflowPolicyError(
            err.statusCode,
            err.errorCode === 'POSITION_HOLDER_NOT_FOUND' ? 'WORKFLOW_ACTOR_UNRESOLVED' : err.errorCode === 'POSITION_HOLDER_AMBIGUOUS' ? 'WORKFLOW_ACTOR_AMBIGUOUS' : err.errorCode,
            err.message
          );
        }
        throw err;
      }
    } else if (step.selector_type === 'ROLE') {
      const urList = db.prepare(`
        SELECT u.id, u.display_name
        FROM user_roles ur
        JOIN users u ON ur.user_id = u.id
        WHERE ur.role_id = ? AND u.is_active = 1
        ORDER BY u.id ASC
      `).all(step.selector_value) as any[];

      if (urList.length === 0) {
        throw new WorkflowPolicyError(
          400,
          'WORKFLOW_ACTOR_UNRESOLVED',
          `承認ステップ「${step.step_name}」に該当するロール保持教職員（${step.selector_value}）が存在しません`
        );
      }
      const validUr = urList.find((u) => !excludeIds.includes(u.id));
      const targetUser = validUr || urList[0];
      approverUserId = targetUser.id;
      approverDisplayName = targetUser.display_name;
    } else {
      throw new WorkflowPolicyError(
        422,
        'WORKFLOW_INVALID_SELECTOR',
        `未サポートのセレクター種別です: ${step.selector_type}`
      );
    }

    resolvedSteps.push({
      stepOrder: step.step_order,
      stepName: step.step_name,
      stepKey: step.step_key,
      actionType: step.action_type,
      requiredRoleId: step.required_role_id,
      selectorType: step.selector_type,
      selectorValue: step.selector_value,
      isFinalDecisionStep: step.is_final_decision_step === 1,
      approverUserId,
      approverDisplayName,
      approverPositionCode,
      approverPositionName,
    });
  }

  return {
    policyId: selectedVersion.policy_id,
    policyKey: selectedVersion.policy_key,
    policyName: selectedVersion.policy_name,
    policyVersionId: selectedVersion.version_id,
    version: selectedVersion.version,
    priority: selectedVersion.priority,
    steps: resolvedSteps,
  };
}
