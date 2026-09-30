import { CandidateWorkflowStep, ResolvedWorkflowStep } from './types';
import { getDb } from '../db/database';

export class FinalAuthoritySelfCollisionError extends Error {
  statusCode = 422;
  errorCode = 'FINAL_AUTHORITY_SELF_COLLISION';
  details?: Record<string, any>;

  constructor(message: string, details?: Record<string, any>) {
    super(message);
    this.name = 'FinalAuthoritySelfCollisionError';
    this.details = details;
  }
}

/**
 * ユーザーが校長役職（PRINCIPAL）を保持しているか判定
 */
export function isUserPrincipal(userId: number, effectiveDate?: string): boolean {
  try {
    const db = getDb();
    const dateOnly = effectiveDate ? effectiveDate.split('T')[0] : new Date().toISOString().split('T')[0];
    const posRow = db.prepare(`
      SELECT 1 FROM user_positions
      WHERE user_id = ?
        AND position_id = 'PRINCIPAL'
        AND effective_from <= ?
        AND (effective_to IS NULL OR effective_to >= ?)
      LIMIT 1
    `).get(userId, dateOnly, dateOnly);
    if (posRow) return true;

    const roleRow = db.prepare(`
      SELECT 1 FROM user_roles
      WHERE user_id = ? AND role_id = 'PRINCIPAL'
      LIMIT 1
    `).get(userId);
    return !!roleRow;
  } catch {
    return false;
  }
}

/**
 * ユーザーが教頭役職（VICE_PRINCIPAL系）を保持しているか判定
 */
export function isUserVicePrincipal(userId: number, effectiveDate?: string): boolean {
  try {
    const db = getDb();
    const dateOnly = effectiveDate ? effectiveDate.split('T')[0] : new Date().toISOString().split('T')[0];
    const posRow = db.prepare(`
      SELECT 1 FROM user_positions
      WHERE user_id = ?
        AND position_id IN ('VICE_PRINCIPAL', 'VICE_PRINCIPAL_1', 'VICE_PRINCIPAL_2')
        AND effective_from <= ?
        AND (effective_to IS NULL OR effective_to >= ?)
      LIMIT 1
    `).get(userId, dateOnly, dateOnly);
    if (posRow) return true;

    const roleRow = db.prepare(`
      SELECT 1 FROM user_roles
      WHERE user_id = ? AND role_id = 'VICE_PRINCIPAL'
      LIMIT 1
    `).get(userId);
    return !!roleRow;
  } catch {
    return false;
  }
}

export interface ResolveSelfCollisionOptions {
  subjectPositionCode?: string;
  isPrincipal?: boolean;
  effectiveDate?: string;
}

/**
 * Self-Collision Resolver (HD-01 〜 HD-05 & HD-SEM-04 / W2-01)
 * 
 * 1. 各ステップに対して approverUserId === subjectUserId を独立評価 (HD-03: Same User != Same Authority Semantic)
 * 2. 最終ステップ (isFinalDecisionStep === true または actionType in ['DECIDE', 'ACK', 'ORDER']) が本人の場合:
 *    - DECIDE / ORDER の場合: FINAL_AUTHORITY_SELF_COLLISION (HTTP 422) で Fail-Closed (HD-02, HD-SEM-01)
 *    - ACK の場合 (Positive ACK-A):
 *      - 校長本人（TYPE-D）の場合のみ合法として認可（Positive Authorization: W2-01）。
 *        スキップせず、通常のステップ（手前にアクティブがあれば WAITING、先頭なら PENDING）として保持。
 *      - 一般職員の自己 ACK は FINAL_AUTHORITY_SELF_COLLISION (HTTP 422) で Fail-Closed。
 * 3. 中間承認者が本人の場合:
 *    - status = 'SKIPPED', resolutionReason = 'SELF_COLLISION', actionByUserId = null, actedAt = null (HD-01, HD-04)
 * 4. 初回のアクティブ (非SKIPPED) ステップを PENDING、後続のアクティブステップを WAITING に設定
 */
export function resolveSelfCollisions(
  subjectUserId: number,
  candidateSteps: CandidateWorkflowStep[],
  options?: ResolveSelfCollisionOptions
): ResolvedWorkflowStep[] {
  let firstPendingAssigned = false;

  return candidateSteps.map((step) => {
    const isFinal = Boolean(step.isFinalDecisionStep || step.actionType === 'DECIDE' || step.actionType === 'ACK' || step.actionType === 'ORDER');
    const isSelf = step.approverUserId === subjectUserId;

    // Positive ACK-A の判定 (HD-SEM-04 / W2-01)
    const isSubjectPrincipal =
      options?.isPrincipal ??
      (options?.subjectPositionCode === 'PRINCIPAL' ||
       step.selectorValue === 'PRINCIPAL' ||
       step.approverPositionCode === 'PRINCIPAL' ||
       step.requiredRoleId === 'PRINCIPAL' ||
       isUserPrincipal(subjectUserId, options?.effectiveDate));

    const isLegitimateSelfAck =
      isSelf &&
      step.actionType === 'ACK' &&
      Boolean(step.isFinalDecisionStep) &&
      isSubjectPrincipal;

    // 1. 最終ステップの自己衝突判定 (HD-02, HD-SEM-01, HD-SEM-04)
    if (isFinal && isSelf) {
      if (isLegitimateSelfAck) {
        // Positive Authorization: 校長本人の受領確認（ACK）は例外とせず通常ステップとして保持
      } else {
        // DECIDE, ORDER, または一般職員の自己ACK等は 422 Fail-Closed
        throw new FinalAuthoritySelfCollisionError(
          `申請者本人 (${subjectUserId}) が最終決裁者 (${step.stepName || step.stepOrder}) に指定されているため提出できません (HD-02: Fail-Closed)`,
          {
            stepOrder: step.stepOrder,
            stepName: step.stepName,
            approverUserId: step.approverUserId,
            subjectUserId,
            actionType: step.actionType,
          }
        );
      }
    }

    // 2. 中間承認者の自己衝突判定 (HD-01)
    if (isSelf && !isLegitimateSelfAck) {
      return {
        ...step,
        status: 'SKIPPED',
        resolutionReason: 'SELF_COLLISION',
        actionByUserId: null,
        actedAt: null,
      };
    }

    // 3. 通常のアクティブ承認者 (HD-03: 重複排除・統合は行わず独立維持)
    if (!firstPendingAssigned) {
      firstPendingAssigned = true;
      return {
        ...step,
        status: 'PENDING',
        resolutionReason: null,
        actionByUserId: null,
        actedAt: null,
      };
    }

    return {
      ...step,
      status: 'WAITING',
      resolutionReason: null,
      actionByUserId: null,
      actedAt: null,
    };
  });
}
