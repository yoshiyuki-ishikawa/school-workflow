import { getDb } from '../db/database';
import { getServerIsoString, getCanonicalBusinessDate } from '../utils/serverTime';
import { logAudit } from '../utils/auditLogger';
import { UserContext } from '../workflow/engine';
import { resolvePositionHolder, PositionResolverError } from '../workflow/positionResolver';

export interface ActivatePolicyVersionParams {
  actor: UserContext;
  versionId: string;
  expectedCurrentActiveVersionId?: string | null;
}

export interface ActivatePolicyVersionResult {
  success: boolean;
  statusCode: number;
  message: string;
  errorCode?: string;
  data?: any;
}

export interface PolicyDraftReadinessResult {
  isReady: boolean;
  checks: {
    policyExists: { pass: boolean; message: string };
    versionIsDraft: { pass: boolean; message: string };
    stepsExist: { pass: boolean; message: string };
    stepOrderValid: { pass: boolean; message: string };
    finalDecisionExactlyOne: { pass: boolean; message: string };
    canonicalPositionsValid: { pass: boolean; message: string };
    roleSelectorExcluded: { pass: boolean; message: string };
    applicationTypesBound: { pass: boolean; message: string };
    effectivePeriodValid: { pass: boolean; message: string };
    effectiveFromReached: { pass: boolean; message: string };
    effectiveToNotExpired: { pass: boolean; message: string };
    priorityConflictFree: { pass: boolean; message: string };
    positionHoldersAssigned: { pass: boolean; message: string };
  };
  errors: string[];
}

export class PolicyActivationService {
  /**
   * DRAFT バージョンの Activation Readiness 検証 (UI・事前チェック用)
   */
  static validatePolicyDraftReadiness(versionId: string): PolicyDraftReadinessResult {
    const db = getDb();
    const today = getCanonicalBusinessDate();
    const errors: string[] = [];

    const targetVersion = db.prepare(`
      SELECT v.*, p.id as policy_id, p.policy_key, p.policy_name, p.policy_purpose
      FROM workflow_policy_versions v
      JOIN workflow_policies p ON v.policy_id = p.id
      WHERE v.id = ?
    `).get(versionId) as any;

    const checks: PolicyDraftReadinessResult['checks'] = {
      policyExists: { pass: !!targetVersion, message: targetVersion ? 'ポリシー存在確認 OK' : '対象ポリシーが存在しません' },
      versionIsDraft: { pass: targetVersion?.status === 'DRAFT', message: targetVersion?.status === 'DRAFT' ? 'DRAFT状態 OK' : `現在の状態は ${targetVersion?.status || '不明'} です` },
      stepsExist: { pass: false, message: 'ステップ未検証' },
      stepOrderValid: { pass: false, message: 'ステップ順序未検証' },
      finalDecisionExactlyOne: { pass: false, message: '最終決裁ステップ未検証' },
      canonicalPositionsValid: { pass: false, message: '役職指定未検証' },
      roleSelectorExcluded: { pass: false, message: 'Role指定検証未実施' },
      applicationTypesBound: { pass: false, message: '適用申請種別未検証' },
      effectivePeriodValid: { pass: false, message: '適用期間未検証' },
      effectiveFromReached: { pass: false, message: '適用開始日未検証' },
      effectiveToNotExpired: { pass: false, message: '適用終了日未検証' },
      priorityConflictFree: { pass: false, message: '優先度競合未検証' },
      positionHoldersAssigned: { pass: false, message: '役職配属者未検証' },
    };

    if (!targetVersion) {
      errors.push('対象のポリシーバージョンが存在しません');
      return { isReady: false, checks, errors };
    }

    if (targetVersion.status !== 'DRAFT') {
      errors.push('DRAFT状態のバージョンのみ有効化できます');
    }

    // ステップ取得
    const steps = db.prepare(`
      SELECT * FROM workflow_policy_steps
      WHERE policy_version_id = ?
      ORDER BY step_order ASC
    `).all(versionId) as any[];

    // 5. stepsExist
    if (steps.length > 0) {
      checks.stepsExist = { pass: true, message: `承認ステップ数: ${steps.length}件 OK` };
    } else {
      checks.stepsExist = { pass: false, message: '承認ステップが1件も設定されていません' };
      errors.push('承認ステップが1件も設定されていません');
    }

    // 6 & 7. stepOrderValid
    const orders = steps.map((s) => s.step_order);
    const uniqueOrders = new Set(orders);
    const isSequential = orders.every((ord, idx) => ord === idx + 1);
    if (uniqueOrders.size === steps.length && isSequential) {
      checks.stepOrderValid = { pass: true, message: 'ステップ順序 (1..N 連番) OK' };
    } else {
      checks.stepOrderValid = { pass: false, message: 'ステップ順序に重複または不正な連番があります' };
      errors.push('ステップ順序に重複または不正な連番があります');
    }

    // 8. finalDecisionExactlyOne
    const finalCount = steps.filter((s) => s.is_final_decision_step === 1).length;
    if (finalCount === 1) {
      checks.finalDecisionExactlyOne = { pass: true, message: '最終決裁ステップ数 (厳密に1件) OK' };
    } else {
      checks.finalDecisionExactlyOne = { pass: false, message: `最終決裁ステップは厳格に1件のみ設定してください (現在: ${finalCount}件)` };
      errors.push(`最終決裁ステップは厳格に1件のみ設定してください (現在: ${finalCount}件)`);
    }

    // 9 & 10. canonicalPositionsValid & 11. roleSelectorExcluded
    let invalidPositions = false;
    let roleUsed = false;
    for (const st of steps) {
      if (st.selector_type === 'ROLE') {
        roleUsed = true;
      } else if (st.selector_type === 'POSITION') {
        const pos = db.prepare('SELECT id, holder_type FROM positions WHERE id = ?').get(st.selector_value) as any;
        if (!pos || pos.holder_type !== 'SINGLE_HOLDER') {
          invalidPositions = true;
        }
      } else {
        invalidPositions = true;
      }
    }

    if (roleUsed) {
      checks.roleSelectorExcluded = { pass: false, message: '承認ルートの単一責任者SelectorにROLEは使用できません (POSITIONのみ可)' };
      errors.push('承認ルートの単一責任者SelectorにROLEは使用できません');
    } else {
      checks.roleSelectorExcluded = { pass: true, message: 'ROLEセレクター不使用 OK' };
    }

    if (invalidPositions) {
      checks.canonicalPositionsValid = { pass: false, message: '存在しない役職コードまたは単一担当制でない役職が含まれています' };
      errors.push('存在しない役職コードまたは単一担当制でない役職が含まれています');
    } else {
      checks.canonicalPositionsValid = { pass: true, message: 'Canonical Position指定 OK' };
    }

    // Gate 2-A: Canonical Action Validation (FC-01 / FB-02: CHECK is Write-Denied)
    const CANONICAL_ACTIONS = new Set(['REVIEW', 'APPROVE', 'DECIDE', 'ACK', 'ORDER']);
    const nonCanonicalSteps = steps.filter((s) => !CANONICAL_ACTIONS.has(s.action_type));
    if (nonCanonicalSteps.length > 0) {
      const invalidTypes = [...new Set(nonCanonicalSteps.map((s) => s.action_type))].join(', ');
      errors.push(`非推奨または無効なアクション種別が含まれています (${invalidTypes})。Canonical Action (REVIEW, APPROVE, DECIDE, ACK, ORDER) のみ有効化可能です`);
    }

    // 12. applicationTypesBound
    const appTypes = db.prepare(`
      SELECT app_type_id FROM workflow_policy_application_types WHERE policy_id = ?
    `).all(targetVersion.policy_id) as any[];
    if (appTypes.length > 0) {
      checks.applicationTypesBound = { pass: true, message: `適用申請種別: ${appTypes.map((a) => a.app_type_id).join(', ')} OK` };
    } else {
      checks.applicationTypesBound = { pass: false, message: '適用申請種別が1件も紐付けられていません' };
      errors.push('適用申請種別が1件も紐付けられていません');
    }

    // Gate 2-B: Travel Authority Validation (INV-BT-AUTH-01 / INV-BT-AUTH-02)
    // BUSINESS_TRIP の通常出張承認ポリシー (APPROVAL) において、終端が DECIDE または ORDER の場合は校長 (PRINCIPAL) が必須
    const isBusinessTrip = appTypes.some((a) => a.app_type_id === 'BUSINESS_TRIP');
    if (isBusinessTrip && targetVersion.policy_purpose === 'APPROVAL') {
      const finalStep = steps.find((s) => s.is_final_decision_step === 1);
      if (finalStep) {
        if (finalStep.action_type === 'DECIDE' || finalStep.action_type === 'ORDER') {
          const isPrincipal = finalStep.required_role_id === 'PRINCIPAL' || finalStep.selector_value === 'PRINCIPAL';
          if (!isPrincipal) {
            errors.push(`出張旅行命令ポリシーの最終決裁ステップ (${finalStep.step_name}) には旅行命令権限者 (PRINCIPAL) を指定してください`);
          }
        }
      }
    }

    // 13. effectivePeriodValid
    const effFrom = targetVersion.effective_from;
    const effTo = targetVersion.effective_to || '9999-12-31';
    if (effFrom && effTo && effFrom <= effTo) {
      checks.effectivePeriodValid = { pass: true, message: `適用期間形式 (${effFrom} 〜 ${effTo}) OK` };
    } else {
      checks.effectivePeriodValid = { pass: false, message: '適用開始日・終了日の形式が不正です (effective_from <= effective_to)' };
      errors.push('適用開始日・終了日の形式が不正です');
    }

    // 14. effectiveFromReached (未来開始日チェック)
    if (effFrom && effFrom <= today) {
      checks.effectiveFromReached = { pass: true, message: `適用開始日 (${effFrom}) 到達済み OK` };
    } else {
      checks.effectiveFromReached = { pass: false, message: `適用開始日 (${effFrom}) は未来日です。本日 (${today}) 以降に有効化してください` };
      errors.push(`適用開始日 (${effFrom}) は未来日です`);
    }

    // 15. effectiveToNotExpired (過去終了日チェック)
    if (!effTo || effTo === '9999-12-31' || today <= effTo) {
      checks.effectiveToNotExpired = { pass: true, message: `適用終了日 (${effTo}) 未経過 OK` };
    } else {
      checks.effectiveToNotExpired = { pass: false, message: `適用終了日 (${effTo}) は既に経過しています (本日: ${today})` };
      errors.push(`適用終了日 (${effTo}) は既に経過しています`);
    }

    // 16. priorityConflictFree
    // 同一申請種別・適用期間重複で同一 Priority を持つ別 ACTIVE バージョンが存在しないか
    let hasPriorityConflict = false;
    for (const at of appTypes) {
      const conflicting = db.prepare(`
        SELECT v.id, v.priority, p.policy_name
        FROM workflow_policy_versions v
        JOIN workflow_policies p ON v.policy_id = p.id
        JOIN workflow_policy_application_types pat ON p.id = pat.policy_id
        WHERE pat.app_type_id = ?
          AND p.policy_purpose = ?
          AND v.status = 'ACTIVE'
          AND v.policy_id != ?
          AND v.priority = ?
          AND v.effective_from <= ?
          AND v.effective_to >= ?
      `).all(at.app_type_id, targetVersion.policy_purpose, targetVersion.policy_id, targetVersion.priority, effTo, effFrom) as any[];

      if (conflicting.length > 0) {
        hasPriorityConflict = true;
        break;
      }
    }

    if (hasPriorityConflict) {
      checks.priorityConflictFree = { pass: false, message: `優先度 (${targetVersion.priority}) が同一申請種別の他のACTIVEポリシーと競合しています` };
      errors.push('優先度が同一申請種別の他のACTIVEポリシーと競合しています');
    } else {
      checks.priorityConflictFree = { pass: true, message: '優先度競合なし OK' };
    }

    // 18. positionHoldersAssigned
    let unassignedPosition = false;
    for (const st of steps) {
      if (st.selector_type === 'POSITION') {
        try {
          resolvePositionHolder({
            positionCode: st.selector_value,
            effectiveDate: today,
          });
        } catch {
          unassignedPosition = true;
          break;
        }
      }
    }

    if (unassignedPosition) {
      checks.positionHoldersAssigned = { pass: false, message: '指定された役職に有効な現任教職員が配属されていません' };
      errors.push('指定された役職に有効な現任教職員が配属されていません');
    } else {
      checks.positionHoldersAssigned = { pass: true, message: '役職現任配属者 OK' };
    }

    const isReady = errors.length === 0;
    return { isReady, checks, errors };
  }

  /**
   * Policy Version の Atomic Activation (20項目の Server-Authoritative 再検証 + OCC)
   */
  static activateVersion(params: ActivatePolicyVersionParams): ActivatePolicyVersionResult {
    const db = getDb();
    const nowIso = getServerIsoString();
    const today = getCanonicalBusinessDate();

    // 1. 事前 Readiness 再検証 (Authority = Server)
    const readiness = this.validatePolicyDraftReadiness(params.versionId);
    if (!readiness.isReady) {
      const firstError = readiness.errors[0];
      let errorCode = 'WORKFLOW_ACTIVATION_NOT_READY';
      if (!readiness.checks.versionIsDraft.pass) errorCode = 'WORKFLOW_POLICY_VERSION_NOT_DRAFT';
      else if (!readiness.checks.finalDecisionExactlyOne.pass) errorCode = 'WORKFLOW_FINAL_DECISION_INVALID';
      else if (!readiness.checks.stepOrderValid.pass) errorCode = 'WORKFLOW_STEP_ORDER_INVALID';
      else if (!readiness.checks.effectiveFromReached.pass) errorCode = 'WORKFLOW_ACTIVATION_BEFORE_EFFECTIVE_DATE';
      else if (!readiness.checks.effectiveToNotExpired.pass) errorCode = 'WORKFLOW_ACTIVATION_AFTER_EFFECTIVE_DATE';
      else if (!readiness.checks.canonicalPositionsValid.pass) errorCode = 'WORKFLOW_POSITION_INVALID';
      else if (!readiness.checks.positionHoldersAssigned.pass) errorCode = 'WORKFLOW_POSITION_UNASSIGNED';
      else if (!readiness.checks.priorityConflictFree.pass) errorCode = 'WORKFLOW_PRIORITY_CONFLICT';

      // 独立した Failure Audit 記録
      logAudit({
        actorUserId: params.actor.id,
        actorUsername: params.actor.username,
        roleSnapshot: params.actor.roles.join(','),
        action: 'FAILED_ACTIVATION_ATTEMPT',
        entityType: 'WORKFLOW_POLICY_VERSION',
        entityId: params.versionId,
        comment: `Activation失敗: ${errorCode}`,
        ipAddress: params.actor.ipAddress,
        userAgent: params.actor.userAgent,
        isSuccess: false,
        metadata: { versionId: params.versionId, errorCode, failureReason: firstError },
      });

      return {
        success: false,
        statusCode: 422,
        errorCode,
        message: `有効化バリデーションに失敗しました: ${firstError}`,
      };
    }

    // 2. 単一 Business Transaction の実行 (All-or-Nothing)
    const runTx = db.transaction(() => {
      const targetVersion = db.prepare(`
        SELECT v.*, p.policy_key, p.policy_name
        FROM workflow_policy_versions v
        JOIN workflow_policies p ON v.policy_id = p.id
        WHERE v.id = ?
      `).get(params.versionId) as any;

      if (!targetVersion) {
        throw { statusCode: 404, errorCode: 'WORKFLOW_POLICY_VERSION_NOT_FOUND', message: '対象のポリシーバージョンが存在しません' };
      }

      if (targetVersion.status !== 'DRAFT') {
        throw { statusCode: 422, errorCode: 'WORKFLOW_POLICY_VERSION_NOT_DRAFT', message: 'DRAFT状態のバージョンのみ有効化できます' };
      }

      // 3. Optimistic Concurrency Control (OCC) 検証
      const currentActive = db.prepare(`
        SELECT id, version FROM workflow_policy_versions
        WHERE policy_id = ? AND status = 'ACTIVE'
      `).get(targetVersion.policy_id) as any;

      if (params.expectedCurrentActiveVersionId !== undefined) {
        const actualActiveId = currentActive ? currentActive.id : null;
        const expectedActiveId = params.expectedCurrentActiveVersionId || null;
        if (actualActiveId !== expectedActiveId) {
          throw {
            statusCode: 409,
            errorCode: 'WORKFLOW_ACTIVE_VERSION_CONFLICT',
            message: `他の管理者によって承認ポリシーが既に更新されています (想定ACTIVE: ${expectedActiveId || 'なし'}, 実際: ${actualActiveId || 'なし'})`,
          };
        }
      }

      // 4. 既存 ACTIVE バージョンの退役処理 (INACTIVE ＆ retired_at 記録)
      if (currentActive) {
        db.prepare(`
          UPDATE workflow_policy_versions
          SET status = 'INACTIVE', retired_at = ?
          WHERE id = ?
        `).run(nowIso, currentActive.id);
      }

      // 5. 対象 Version の ACTIVE 化
      db.prepare(`
        UPDATE workflow_policy_versions
        SET status = 'ACTIVE'
        WHERE id = ?
      `).run(params.versionId);

      // 6. 成功 AuditLog 記録 (Transaction 内部)
      logAudit({
        actorUserId: params.actor.id,
        actorUsername: params.actor.username,
        roleSnapshot: params.actor.roles.join(','),
        action: 'ACTIVATE_WORKFLOW_POLICY_VERSION',
        entityType: 'WORKFLOW_POLICY_VERSION',
        entityId: targetVersion.id,
        beforeState: currentActive ? `v${currentActive.version} (ACTIVE)` : 'NONE',
        afterState: `v${targetVersion.version} (ACTIVE)`,
        comment: `ポリシー「${targetVersion.policy_name}」バージョン ${targetVersion.version} を有効化`,
        ipAddress: params.actor.ipAddress,
        userAgent: params.actor.userAgent,
        metadata: {
          policyId: targetVersion.policy_id,
          policyKey: targetVersion.policy_key,
          previousActiveVersionId: currentActive?.id || null,
          newActiveVersionId: targetVersion.id,
        },
      });

      return {
        policyId: targetVersion.policy_id,
        activatedVersionId: targetVersion.id,
        activatedVersion: targetVersion.version,
        previousActiveVersionId: currentActive?.id || null,
      };
    });

    try {
      const data = runTx();
      return {
        success: true,
        statusCode: 200,
        message: 'ポリシーバージョンを有効化しました',
        data,
      };
    } catch (err: any) {
      // 独立した Failure Audit 記録
      try {
        logAudit({
          actorUserId: params.actor.id,
          actorUsername: params.actor.username,
          roleSnapshot: params.actor.roles.join(','),
          action: 'FAILED_ACTIVATION_ATTEMPT',
          entityType: 'WORKFLOW_POLICY_VERSION',
          entityId: params.versionId,
          comment: `Activation失敗: ${err.errorCode || 'TRANSACTION_ERROR'}`,
          ipAddress: params.actor.ipAddress,
          userAgent: params.actor.userAgent,
          isSuccess: false,
          metadata: { versionId: params.versionId, errorCode: err.errorCode || 'INTERNAL_ERROR' },
        });
      } catch {
        // Failure Audit 保存失敗でも Rollback 済み状態は絶対に変更しない
      }

      return {
        success: false,
        statusCode: err.statusCode || 500,
        errorCode: err.errorCode || 'INTERNAL_ERROR',
        message: err.message,
      };
    }
  }
}

