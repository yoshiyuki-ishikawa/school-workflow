import { getDb } from '../db/database';
import { getServerIsoString } from '../utils/serverTime';
import { logAudit, logAuditStrict } from '../utils/auditLogger';
import { resolvePositionHolder } from './positionResolver';
import { resolveSelfCollisions, isUserPrincipal, isUserVicePrincipal } from './collisionResolver';
import { validateResolvedRoute } from './routeValidator';
import { ResolvedWorkflowStep } from './types';

export function resolveAndValidateWorkflowSteps(
  subjectUserId: number,
  candidateSteps: any[],
  appTypeId?: string
): ResolvedWorkflowStep[] {
  const resolved = resolveSelfCollisions(subjectUserId, candidateSteps);
  validateResolvedRoute(subjectUserId, resolved, appTypeId);
  return resolved;
}

export interface UserContext {
  id: number;
  username: string;
  displayName: string;
  roles: string[];
  mustChangePassword?: boolean;
  authVersion?: number;
  ipAddress: string;
  userAgent?: string;
}

export type ApplicationStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'IN_APPROVAL'
  | 'FIRST_APPROVED'
  | 'SECOND_APPROVED'
  | 'TRIP_APPROVED'
  | 'REPORT_SUBMITTED'
  | 'REPORT_FIRST_APPROVED'
  | 'REPORT_SECOND_APPROVED'
  | 'FINAL_APPROVED'
  | 'RETURNED'
  | 'REJECTED'
  | 'WITHDRAWN'
  | 'CANCELLED';

export interface WorkflowResult {
  success: boolean;
  statusCode: number;
  message: string;
  errorCode?: string;
  data?: any;
}

export interface ApproverResolution {
  userId: number;
  displayName: string;
  positionCode?: string;
  positionName?: string;
}

/**
 * Approval Cycle生成時点（現在日・Server時刻基準）の人事・組織マスタから具体的承認者を解決する
 */
export function resolveApproverUser(
  db: any,
  selectorType: string,
  selectorValue: string,
  cycleCreatedAt: string,
  fallbackRoleId?: string,
  assignedUserId?: number | null,
  excludeUserIds: number[] = []
): ApproverResolution {
  const dateOnly = cycleCreatedAt.split('T')[0];

  // 1. USER 直接指定
  if (selectorType === 'USER' || assignedUserId) {
    const targetId = assignedUserId || parseInt(selectorValue, 10);
    const u = db.prepare('SELECT id, display_name FROM users WHERE id = ? AND is_active = 1').get(targetId) as any;
    if (u && !excludeUserIds.includes(u.id)) {
      return { userId: u.id, displayName: u.display_name };
    }
  }

  // 2. POSITION 指定 (Canonical Position Resolver に委譲: 役職担当者を厳格にSnapshot固定)
  if (selectorType === 'POSITION') {
    return resolvePositionHolder({
      positionCode: selectorValue,
      effectiveDate: dateOnly,
      excludeUserIds: [],
    });
  }

  // 3. ROLE 指定 (user_roles から検索)
  const roleCode = selectorType === 'ROLE' ? selectorValue : (fallbackRoleId || 'TEACHER');
  const urList = db.prepare(`
    SELECT u.id, u.display_name
    FROM user_roles ur
    JOIN users u ON ur.user_id = u.id
    WHERE ur.role_id = ? AND u.is_active = 1
    ORDER BY u.id ASC
  `).all(roleCode) as any[];

  const validUr = urList.find((u) => !excludeUserIds.includes(u.id));
  if (validUr) {
    return {
      userId: validUr.id,
      displayName: validUr.display_name,
    };
  }

  if (urList.length > 0) {
    return {
      userId: urList[0].id,
      displayName: urList[0].display_name,
    };
  }

  // 解決不能時はエラー (Fail-Closed)
  throw {
    statusCode: 500,
    message: `承認者の解決に失敗しました (Selector: ${selectorType}=${selectorValue}, 基準日: ${dateOnly})`,
  };
}

export interface ApproverAuthorizationResult {
  allowed: boolean;
  statusCode?: number;
  errorCode?: string;
  action?: string;
  message?: string;
}

/**
 * 承認・決裁操作の認可判定 (Production Authorization Canonical Resolver SSOT)
 * 認可判定ロジックおよびエラーセマンティクス（403, errorCode, message）の唯一の真実
 */
export function evaluateApproverAuthorization(
  actor: { id: number; roles: string[] },
  application: { subject_user_id: number; submitted_by_user_id: number; type_id?: string },
  cycle: { cycle_purpose?: string; started_by_user_id?: number | null },
  step: { approver_user_id_snapshot?: number | null; assigned_user_id?: number | null; required_role_id?: string | null; approver_name_snapshot?: string | null; action_type?: string; is_final_decision_step?: boolean | number }
): ApproverAuthorizationResult {
  const isAck = step.action_type === 'ACK';
  const isFinal = Boolean(step.is_final_decision_step);
  const isPrincipal = actor.roles.includes('PRINCIPAL') || isUserPrincipal(actor.id);
  const isLegitimateSelfAck = isAck && isFinal && isPrincipal;

  // 1. 業務本人 (Subject) による自己承認の禁止 (INV-001 / Positive ACK-A: W2-01)
  if (actor.id === application.subject_user_id) {
    if (!isLegitimateSelfAck) {
      return {
        allowed: false,
        statusCode: 403,
        errorCode: 'FORBIDDEN_SELF_APPROVAL',
        action: 'FORBIDDEN_SELF_APPROVAL',
        message: cycle.cycle_purpose === 'CANCELLATION'
          ? '申請対象本人は自身の申請の取消を承認できません'
          : '自己承認は禁止されています。自身の申請を承認・決裁することはできません。',
      };
    }
    // Positive ACK-A の場合は自己承認ブロックを通過し、ステップ担当者検証へ
  }

  // 2. 代理申請作成者 (Actor) による自己承認の禁止 (SoD 調停: W2-03)
  // 本人が起票した場合は代理起票ではないためスキップ
  const isProxySubmission = application.submitted_by_user_id !== application.subject_user_id;
  if (isProxySubmission && actor.id === application.submitted_by_user_id) {
    const isSubjectPrincipal = isUserPrincipal(application.subject_user_id);
    const isActorVP = actor.roles.includes('VICE_PRINCIPAL') || isUserVicePrincipal(actor.id);
    const isReviewStep = step.action_type === 'REVIEW' && !isFinal;

    // CASE-PROXY-02: 校長の代理起票を教頭が行い、教頭自身が中間審査（REVIEW）を行う場合のみ許可 (ALLOW)
    const isAllowedProxyReview = isSubjectPrincipal && isActorVP && isReviewStep;

    if (!isAllowedProxyReview) {
      return {
        allowed: false,
        statusCode: 403,
        errorCode: 'FORBIDDEN_PROXY_APPROVAL',
        action: 'FORBIDDEN_PROXY_APPROVAL',
        message: '代理申請を作成した操作者自身による承認操作は禁止されています。',
      };
    }
    // CASE-PROXY-02 の場合はプロキシブロックを通過し、ステップ担当者検証へ
  }

  // 3. 取消起案者 (StartedBy) 本人による取消承認の禁止 (CANCELLATION Cycle)
  if (cycle.cycle_purpose === 'CANCELLATION' && cycle.started_by_user_id && actor.id === cycle.started_by_user_id) {
    const isLegitimateSelfAckCancellation = isLegitimateSelfAck && actor.id === application.subject_user_id;
    if (!isLegitimateSelfAckCancellation) {
      return {
        allowed: false,
        statusCode: 403,
        errorCode: 'FORBIDDEN_SELF_APPROVAL',
        action: 'FORBIDDEN_SELF_APPROVAL',
        message: '取消起案者本人は取消承認を行えません',
      };
    }
    // Positive ACK-A の場合は起案者ブロックを通過し、ステップ担当者検証へ
  }

  // 4. 認可判定 (Server-Authoritative Snapshot 一本化)
  const expectedApproverId = step.approver_user_id_snapshot || step.assigned_user_id;
  if (expectedApproverId) {
    if (expectedApproverId === actor.id) {
      return { allowed: true };
    }
    return {
      allowed: false,
      statusCode: 403,
      action: 'FORBIDDEN_APPROVAL_ROLE',
      message: `このステップの承認権限がありません（承認指定者: ${step.approver_name_snapshot || expectedApproverId}）`,
    };
  }

  if (step.required_role_id) {
    if (actor.roles.includes(step.required_role_id)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      statusCode: 403,
      action: 'FORBIDDEN_APPROVAL_ROLE',
      message: `このステップを承認する権限がありません（必要ロール: ${step.required_role_id}）`,
    };
  }

  return {
    allowed: false,
    statusCode: 403,
    action: 'FORBIDDEN_APPROVAL_ROLE',
    message: '承認権限がありません',
  };
}

/**
 * 承認・決裁操作の認可判定 (Boolean Predicate - Canonical Resolver SSOT)
 * Pending Task 集約および各種認可チェックで共通利用
 */
export function isActionableApprover(
  actor: { id: number; roles: string[] },
  application: { subject_user_id: number; submitted_by_user_id: number },
  cycle: { cycle_purpose?: string; started_by_user_id?: number | null },
  step: { approver_user_id_snapshot?: number | null; assigned_user_id?: number | null; required_role_id?: string | null; approver_name_snapshot?: string | null }
): boolean {
  return evaluateApproverAuthorization(actor, application, cycle, step).allowed;
}

/**
 * Authoritative Final Approval Step Resolver (GAP-09)
 * 該当 approval_cycle 内で、現在ステップより後ろ（step_order > currentStepOrder）に
 * 未実行ステップ（status IN ('WAITING', 'PENDING')）が存在しないか判定
 */
export function isFinalApprovalStep(
  db: any,
  applicationId: number,
  approvalCycle: number,
  currentStepOrder: number
): boolean {
  const remainingCount = (db.prepare(`
    SELECT COUNT(*) as cnt
    FROM application_approval_steps
    WHERE application_id = ?
      AND approval_cycle = ?
      AND step_order > ?
      AND status IN ('WAITING', 'PENDING')
  `).get(applicationId, approvalCycle, currentStepOrder) as any)?.cnt || 0;

  return remainingCount === 0;
}

/**
 * 現在のシステム組織設定スナップショットを取得 (JSON文字列)
 * ※ Current Organization Settings (学校名、自治体名、教育委員会名、システム表示名、バージョン) のみを保存し、
 *    撤去された規程名称は新規スナップショットに含めない
 */
export function getCurrentOrganizationSnapshot(db: any): string {
  try {
    const settings = db.prepare('SELECT * FROM system_settings WHERE id = 1').get() as any;
    if (!settings) {
      return JSON.stringify({
        schoolName: '公立小学校',
        municipalityName: '〇〇市',
        boardOfEducationName: '〇〇市教育委員会',
        appTitle: '学校業務ワークフローシステム',
        version: 1,
      });
    }
    return JSON.stringify({
      schoolName: settings.school_name,
      municipalityName: settings.municipality_name,
      boardOfEducationName: settings.board_of_education_name,
      appTitle: settings.app_title,
      version: settings.version,
    });
  } catch {
    return JSON.stringify({
      schoolName: '公立小学校',
      municipalityName: '〇〇市',
      boardOfEducationName: '〇〇市教育委員会',
      appTitle: '学校業務ワークフローシステム',
      version: 1,
    });
  }
}

/**
 * 対象日付が含まれる年月が出勤簿月次確定（CONFIRMED）ロック中か判定
 */
export function isMonthlyLocked(userId: number, dateStr?: string): boolean {
  if (!dateStr) return false;
  try {
    const db = getDb();
    const yearMonth = dateStr.substring(0, 7);
    const row = db.prepare('SELECT status FROM monthly_attendance_approvals WHERE user_id = ? AND year_month = ?').get(userId, yearMonth) as { status: string } | undefined;
    return row?.status === 'CONFIRMED';
  } catch {
    return false;
  }
}

/**
 * 学校服務業務エンジン (School Service Workflow Engine)
 */
export class WorkflowEngine {
  /**
   * 申請の新規下書き保存・更新
   */
  static saveDraft(
    actor: UserContext,
    params: {
      id?: number;
      expectedVersion?: number;
      typeId: string;
      title: string;
      formData: Record<string, any>;
      subjectUserId?: number;
    }
  ): WorkflowResult {
    const db = getDb();
    const now = getServerIsoString();
    const targetSubjectId = params.subjectUserId || actor.id;
    const isProxy = targetSubjectId !== actor.id;

    // 月次確定ロック判定
    const targetDate = params.formData?.startDate || params.formData?.targetDate || now.split('T')[0];
    if (isMonthlyLocked(targetSubjectId, targetDate)) {
      return { success: false, statusCode: 400, message: `${targetDate.substring(0, 7)} の出勤簿は校長により月次確定（ロック）されているため編集できません` };
    }

    // 代理下書き作成時の権限チェック
    if (isProxy) {
      const canProxy = actor.roles.some((r) => ['VICE_PRINCIPAL', 'PRINCIPAL', 'ADMIN'].includes(r));
      if (!canProxy) {
        logAudit({
          actorUserId: actor.id,
          actorUsername: actor.username,
          subjectUserId: targetSubjectId,
          roleSnapshot: actor.roles.join(','),
          action: 'FORBIDDEN_PROXY_DRAFT',
          entityType: 'APPLICATION',
          comment: '一般教員による代理下書き作成試行',
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
          isSuccess: false,
        });
        return { success: false, statusCode: 403, message: '代理申請の作成権限がありません' };
      }
    }

    try {
      if (params.id) {
        const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(params.id) as any;
        if (!app) {
          return { success: false, statusCode: 404, message: '対象の申請が存在しません' };
        }

        // 下書き編集権限: 作成者または本人 (403をバージョンチェックより先に判定)
        if (app.submitted_by_user_id !== actor.id && app.subject_user_id !== actor.id) {
          logAudit({
            actorUserId: actor.id,
            actorUsername: actor.username,
            subjectUserId: app.subject_user_id,
            roleSnapshot: actor.roles.join(','),
            action: 'FORBIDDEN_DRAFT_UPDATE',
            entityType: 'APPLICATION',
            entityId: params.id,
            comment: '他人の下書き更新試行',
            ipAddress: actor.ipAddress,
            userAgent: actor.userAgent,
            isSuccess: false,
          });
          return { success: false, statusCode: 403, message: '他人の申請は編集できません' };
        }

        // Concurrency Contract: 既存DRAFT更新時は expectedVersion 必須
        if (params.expectedVersion === undefined || params.expectedVersion === null) {
          return { success: false, statusCode: 400, errorCode: 'VERSION_REQUIRED', message: '楽観ロック用の expectedVersion の指定は必須です' };
        }

        if (app.version !== params.expectedVersion) {
          return { success: false, statusCode: 409, errorCode: 'CONFLICT_DETECTED', message: '他のユーザーまたは別タブによって更新されました' };
        }

        if (app.current_status !== 'DRAFT') {
          return { success: false, statusCode: 400, message: '下書き状態以外の申請は下書き保存できません' };
        }

        // スキーマバリデーション (下書きモード: 緩和検証 + スナップショット生成)
        const { FormValidationEngine } = require('../services/schema/formValidationEngine');
        const schemaValidation = FormValidationEngine.validate({
          typeId: params.typeId,
          rawValues: params.formData,
          isDraft: true,
        });

        const draftFormData = {
          ...params.formData,
          schemaVersion: schemaValidation.schemaVersion,
          schemaSnapshot: schemaValidation.schemaSnapshot,
        };

        db.prepare(`
          UPDATE applications
          SET title = ?, form_data = ?, updated_at = ?, version = version + 1
          WHERE id = ?
        `).run(params.title, JSON.stringify(draftFormData), now, params.id);

        logAudit({
          actorUserId: actor.id,
          actorUsername: actor.username,
          subjectUserId: app.subject_user_id,
          submissionActorType: app.submission_actor_type,
          submissionMode: app.submission_mode,
          roleSnapshot: actor.roles.join(','),
          action: 'UPDATE_DRAFT',
          entityType: 'APPLICATION',
          entityId: params.id,
          entityVersion: app.version + 1,
          beforeState: app.current_status,
          afterState: app.current_status,
          comment: '下書き更新',
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
        });

        return { success: true, statusCode: 200, message: '下書きを保存しました', data: { id: params.id } };
      } else {
        const actorType = isProxy ? 'PROXY' : 'SELF';
        // スキーマバリデーション (下書きモード: 緩和検証 + スナップショット生成)
        const { FormValidationEngine } = require('../services/schema/formValidationEngine');
        const schemaValidation = FormValidationEngine.validate({
          typeId: params.typeId,
          rawValues: params.formData,
          isDraft: true,
        });

        const draftFormData = {
          ...params.formData,
          schemaVersion: schemaValidation.schemaVersion,
          schemaSnapshot: schemaValidation.schemaSnapshot,
        };

        const result = db.prepare(`
          INSERT INTO applications (
            type_id, subject_user_id, submitted_by_user_id, submission_actor_type,
            submission_mode, title, form_data, current_status, current_step_order, version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'SINGLE', ?, ?, 'DRAFT', 1, 1, ?, ?)
        `).run(params.typeId, targetSubjectId, actor.id, actorType, params.title, JSON.stringify(draftFormData), now, now);

        const newId = Number(result.lastInsertRowid);
        logAudit({
          actorUserId: actor.id,
          actorUsername: actor.username,
          subjectUserId: targetSubjectId,
          submissionActorType: actorType,
          submissionMode: 'SINGLE',
          roleSnapshot: actor.roles.join(','),
          action: isProxy ? 'CREATE_PROXY_DRAFT' : 'CREATE_DRAFT',
          entityType: 'APPLICATION',
          entityId: newId,
          entityVersion: 1,
          afterState: 'DRAFT',
          comment: isProxy ? `代理下書き作成 (対象教員ID: ${targetSubjectId})` : '新規下書き作成',
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
        });

        return { success: true, statusCode: 201, message: '下書きを作成しました', data: { id: newId } };
      }
    } catch (err: any) {
      return { success: false, statusCode: 500, message: err.message };
    }
  }

  /**
   * 本人による通常申請提出 (SELF + SINGLE)
   */
  static submitApplication(
    actor: UserContext,
    params: {
      id?: number;
      expectedVersion?: number;
      typeId: string;
      title: string;
      formData: Record<string, any>;
    }
  ): WorkflowResult {
    return this._executeSubmit({
      actor,
      subjectUserId: actor.id,
      submissionActorType: 'SELF',
      submissionMode: 'SINGLE',
      id: params.id,
      expectedVersion: params.expectedVersion,
      typeId: params.typeId,
      title: params.title,
      formData: params.formData,
    });
  }

  /**
   * 代理申請提出 (PROXY + SINGLE)
   */
  static submitProxyApplication(
    actor: UserContext,
    params: {
      id?: number;
      expectedVersion?: number;
      typeId: string;
      subjectUserId: number;
      title: string;
      formData: Record<string, any>;
      proxyReason?: string;
    }
  ): WorkflowResult {
    const canProxy = actor.roles.some((r) => ['VICE_PRINCIPAL', 'PRINCIPAL', 'ADMIN'].includes(r));
    if (!canProxy) {
      logAudit({
        actorUserId: actor.id,
        actorUsername: actor.username,
        subjectUserId: params.subjectUserId,
        roleSnapshot: actor.roles.join(','),
        action: 'FORBIDDEN_PROXY_SUBMIT',
        entityType: 'APPLICATION',
        comment: '一般教員による代理申請提出試行',
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
        isSuccess: false,
      });
      return { success: false, statusCode: 403, message: '代理申請の権限がありません' };
    }

    const enhancedFormData = {
      ...params.formData,
      proxyReason: params.proxyReason || '',
      proxySubmitterName: actor.displayName,
    };

    return this._executeSubmit({
      actor,
      subjectUserId: params.subjectUserId,
      submissionActorType: 'PROXY',
      submissionMode: 'SINGLE',
      id: params.id,
      expectedVersion: params.expectedVersion,
      typeId: params.typeId,
      title: params.title,
      formData: enhancedFormData,
    });
  }

  /**
   * 複数名一括出張申請の作成・提出 (Trip Event + 各参加者 Application Snapshot)
   * @deprecated — Legacy/Test Compatibility Only. Not a Production Entry Path.
   */
  static submitBatchTrip(
    actor: UserContext,
    params: {
      title: string;
      purpose: string;
      destination: string;
      startAt: string;
      endAt: string;
      transport: string;
      notes?: string;
      participantUserIds: number[];
      individualNotes?: Record<number, string>;
    }
  ): WorkflowResult {
    if (!params.participantUserIds || params.participantUserIds.length === 0) {
      return { success: false, statusCode: 400, message: '参加教職員を1名以上選択してください' };
    }

    // 月次確定ロック判定
    for (const userId of params.participantUserIds) {
      if (isMonthlyLocked(userId, params.startAt) || isMonthlyLocked(userId, params.endAt)) {
        return { success: false, statusCode: 400, message: `対象年月は出勤簿が校長により確定（ロック）されているため出張申請を提出できません` };
      }
    }

    const db = getDb();
    const now = getServerIsoString();

    const runTx = db.transaction(() => {
      // 1. trip_events レコード作成 (共通情報の Source of Truth)
      const eventResult = db.prepare(`
        INSERT INTO trip_events (
          title, purpose, destination, start_at, end_at, transport, notes, created_by_user_id, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        params.title,
        params.purpose,
        params.destination,
        params.startAt,
        params.endAt,
        params.transport,
        params.notes || '',
        actor.id,
        now,
        now
      );
      const tripEventId = Number(eventResult.lastInsertRowid);

      // 出張用 Policy 解決
      const { resolveWorkflowPolicy } = require('./policyResolver');

      const insertApp = db.prepare(`
        INSERT INTO applications (
          type_id, subject_user_id, submitted_by_user_id, submission_actor_type, submission_mode,
          trip_event_id, title, form_data, current_status, current_step_order, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SUBMITTED', 1, 1, ?, ?)
      `);

      const insertMember = db.prepare(`
        INSERT INTO trip_event_members (
          trip_event_id, user_id, application_id, participation_status, individual_notes, created_at
        ) VALUES (?, ?, ?, 'JOINED', ?, ?)
      `);

      const insertCycle = db.prepare(`
        INSERT INTO application_workflow_cycles (
          application_id, approval_cycle, workflow_source, workflow_policy_version_id,
          policy_evaluation_at, status, started_at, started_by_user_id
        ) VALUES (?, 1, 'NEW_POLICY_ENGINE', ?, ?, 'IN_PROGRESS', ?, ?)
      `);

      const insertStep = db.prepare(`
        INSERT INTO application_approval_steps (
          application_id, approval_cycle, workflow_cycle_id, step_order, step_name, step_key, step_label_snapshot,
          selector_type_snapshot, selector_value_snapshot, approver_user_id_snapshot,
          approver_name_snapshot, approver_position_code_snapshot, approver_position_name_snapshot,
          required_role_id, assigned_user_id, status, resolution_reason, action_type, is_final_decision_step
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const generatedAppIds: number[] = [];

      // 2. 各参加者の個別 Application Snapshot 生成
      for (const userId of params.participantUserIds) {
        const isSelf = userId === actor.id;
        const actorType = isSelf ? 'SELF' : 'PROXY';
        const userNotes = params.individualNotes?.[userId] || '';

        // Application Snapshot データ
        const formDataSnapshot = {
          tripEventId,
          purpose: params.purpose,
          destination: params.destination,
          startDate: params.startAt.split('T')[0] || params.startAt,
          endDate: params.endAt.split('T')[0] || params.endAt,
          startAt: params.startAt,
          endAt: params.endAt,
          transport: params.transport,
          remarks: params.notes || '',
          individualNotes: userNotes,
          batchGroupId: `TRIP-EVENT-${tripEventId}`,
        };

        // 参加者ごとの重複検証 (Canonical Conflict Validation SSOT)
        const { ConflictService } = require('../services/conflictService');
        const conflictCheck = ConflictService.validate({
          userId,
          startDate: formDataSnapshot.startDate,
          endDate: formDataSnapshot.endDate,
          applicationTypeId: 'BUSINESS_TRIP',
          unitType: 'MULTI_DAY',
        });

        if (conflictCheck.hasConflict) {
          throw {
            statusCode: 422,
            errorCode: 'SERVICE_PERIOD_CONFLICT',
            message: `参加教職員 (ID: ${userId}) の一括出張登録エラー: ${conflictCheck.reason}`,
          };
        }

        const appRes = insertApp.run(
          'BUSINESS_TRIP',
          userId,
          actor.id,
          actorType,
          'BATCH',
          tripEventId,
          `【一括出張】${params.title}`,
          JSON.stringify(formDataSnapshot),
          now,
          now
        );
        const appId = Number(appRes.lastInsertRowid);
        generatedAppIds.push(appId);

        // member レコード
        insertMember.run(tripEventId, userId, appId, userNotes, now);

        // Policy 解決
        const resolvedPolicy = resolveWorkflowPolicy({
          appTypeId: 'BUSINESS_TRIP',
          evaluationTime: now,
          subjectUserId: userId,
          submittedByUserId: actor.id,
        });

        // 自己衝突解決 (HD-01〜03) ＆ 独立ルート検証 (INV-SC-01〜07, INV-FA-01〜06)
        const resolvedSteps = resolveAndValidateWorkflowSteps(userId, resolvedPolicy.steps);

        const firstPendingStep = resolvedSteps.find((s) => s.status === 'PENDING');
        const initialCurrentStepOrder = firstPendingStep ? firstPendingStep.stepOrder : 1;

        db.prepare('UPDATE applications SET current_step_order = ? WHERE id = ?').run(initialCurrentStepOrder, appId);

        const cycleRes = insertCycle.run(
          appId,
          resolvedPolicy.policyVersionId,
          now,
          now,
          actor.id
        );
        const cycleId = Number(cycleRes.lastInsertRowid);

        // Policy Version の参照実績更新
        db.prepare('UPDATE workflow_policy_versions SET is_used = 1 WHERE id = ?').run(resolvedPolicy.policyVersionId);

        // 承認ステップ Snapshot (Cycle生成時点の承認者を完全固定)
        for (const rs of resolvedSteps) {
          insertStep.run(
            appId,
            cycleId,
            rs.stepOrder,
            rs.stepName,
            rs.stepKey || null,
            rs.stepName,
            rs.selectorType,
            rs.selectorValue,
            rs.approverUserId,
            rs.approverDisplayName,
            rs.approverPositionCode || null,
            rs.approverPositionName || null,
            rs.requiredRoleId,
            rs.approverUserId,
            rs.status,
            rs.resolutionReason || null,
            rs.actionType,
            rs.isFinalDecisionStep ? 1 : 0
          );
        }
      }

      return { tripEventId, generatedAppIds };
    });

    try {
      const res = runTx();

      logAudit({
        actorUserId: actor.id,
        actorUsername: actor.username,
        submissionActorType: params.participantUserIds.includes(actor.id) && params.participantUserIds.length === 1 ? 'SELF' : 'PROXY',
        submissionMode: 'BATCH',
        roleSnapshot: actor.roles.join(','),
        action: 'BATCH_TRIP_SUBMIT',
        entityType: 'TRIP_EVENT',
        entityId: res.tripEventId,
        afterState: 'SUBMITTED',
        comment: `複数名一括出張申請作成 (参加教員数: ${params.participantUserIds.length}名, 申請ID一覧: ${res.generatedAppIds.join(',')})`,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
        metadata: {
          participantUserIds: params.participantUserIds,
          generatedAppIds: res.generatedAppIds,
        },
      });

      return {
        success: true,
        statusCode: 201,
        message: `${params.participantUserIds.length}名の出張申請を一括生成・提出しました`,
        data: res,
      };
    } catch (err: any) {
      return { success: false, statusCode: err.statusCode || 500, message: err.message };
    }
  }

  /**
   * 内部提出実行ロジック (Snapshot & 承認ステップ生成 - Atomic Business Transaction)
   */
  private static _executeSubmit(params: {
    actor: UserContext;
    subjectUserId: number;
    submissionActorType: 'SELF' | 'PROXY' | 'SYSTEM';
    submissionMode: 'SINGLE' | 'BATCH';
    id?: number;
    expectedVersion?: number;
    typeId: string;
    title: string;
    formData: Record<string, any>;
  }): WorkflowResult {
    const targetDate = params.formData?.startDate || params.formData?.targetDate;
    if (isMonthlyLocked(params.subjectUserId, targetDate)) {
      return { success: false, statusCode: 400, message: `${targetDate ? targetDate.substring(0, 7) : ''} の出勤簿は校長により確定（ロック）されているため申請を提出できません` };
    }

    const db = getDb();
    const now = getServerIsoString();

    const runTx = db.transaction(() => {
      let applicationId = params.id;
      let effectiveSubjectUserId = params.subjectUserId;
      let effectiveActorType = params.submissionActorType;
      let app: any = null;

      if (applicationId) {
        // Concurrency Contract: 既存DRAFT正式提出時は expectedVersion 必須
        if (params.expectedVersion === undefined || params.expectedVersion === null) {
          throw { statusCode: 400, errorCode: 'VERSION_REQUIRED', message: '楽観ロック用の expectedVersion の指定は必須です' };
        }

        app = db.prepare('SELECT * FROM applications WHERE id = ?').get(applicationId) as any;
        if (!app) {
          throw { statusCode: 404, message: '対象の申請が存在しません' };
        }

        // Server-Owned Identity による認可SSOT検証 (403をバージョンチェックより先に判定)
        effectiveSubjectUserId = app.subject_user_id;
        effectiveActorType = app.submission_actor_type;

        if (effectiveActorType === 'SELF') {
          if (app.subject_user_id !== params.actor.id || app.submitted_by_user_id !== params.actor.id) {
            throw { statusCode: 403, errorCode: 'FORBIDDEN_SELF_SUBMIT', message: '本人下書き申請は作成者本人のみ提出できます', action: 'FORBIDDEN_SUBMIT' };
          }
        } else if (effectiveActorType === 'PROXY') {
          const canProxy = params.actor.roles.some((r) => ['VICE_PRINCIPAL', 'PRINCIPAL', 'ADMIN'].includes(r));
          if (app.submitted_by_user_id !== params.actor.id && !canProxy) {
            throw { statusCode: 403, errorCode: 'FORBIDDEN_PROXY_SUBMIT', message: '代理下書き申請は作成代理者または管理職のみ提出できます', action: 'FORBIDDEN_SUBMIT' };
          }
        }

        // Concurrency Contract: Version一致検証
        if (app.version !== params.expectedVersion) {
          throw { statusCode: 409, errorCode: 'CONFLICT_DETECTED', message: '他のユーザーまたは別タブによって更新されました', action: 'CONFLICT_DETECTED' };
        }

        // Invariant: DRAFT 状態のみ Draft Submit 経路で提出可能 (RETURNED は resubmit 専用)
        if (app.current_status !== 'DRAFT') {
          throw { statusCode: 400, errorCode: 'INVALID_STATUS_FOR_DRAFT_SUBMIT', message: '下書き（DRAFT）以外の申請はドラフト提出できません。差戻し申請は再申請（resubmit）を行ってください。' };
        }

        // Invariant: 既存の Cycle / Step が存在しないこと (Clean Draft Isolation)
        const cycleCount = (db.prepare('SELECT COUNT(*) as cnt FROM application_workflow_cycles WHERE application_id = ?').get(applicationId) as any)?.cnt || 0;
        const stepCount = (db.prepare('SELECT COUNT(*) as cnt FROM application_approval_steps WHERE application_id = ?').get(applicationId) as any)?.cnt || 0;
        if (cycleCount > 0 || stepCount > 0) {
          throw { statusCode: 409, errorCode: 'WORKFLOW_ALREADY_EXISTS', message: 'この申請には既にワークフローサイクルまたはステップが存在します' };
        }

        // Transaction内 TOCTOU 再検証: 対象日付の月次ロックを再確認
        const draftTargetDate = params.formData?.startDate || params.formData?.targetDate;
        if (isMonthlyLocked(effectiveSubjectUserId, draftTargetDate)) {
          throw { statusCode: 400, errorCode: 'MONTHLY_LOCKED', message: `${draftTargetDate ? draftTargetDate.substring(0, 7) : ''} の出勤簿は校長により確定（ロック）されているため申請を提出できません` };
        }
      }

      // 0. 制度バリデーション ＆ 期間重複バリデーション (ApplicationValidationPipeline SSOT)
      const { ApplicationValidationPipeline } = require('../services/applicationValidationPipeline');
      const validation = ApplicationValidationPipeline.validate({
        typeId: params.typeId,
        subjectUserId: effectiveSubjectUserId,
        formData: params.formData,
        applicationId,
        db,
      });

      if (!validation.valid) {
        throw {
          statusCode: validation.status || 422,
          errorCode: validation.errorCode || 'VALIDATION_FAILED',
          message: validation.message || '申請バリデーションに失敗しました',
        };
      }

      const finalFormData = {
        ...(validation.sanitizedValues || params.formData),
        schemaVersion: validation.schemaVersion,
        schemaSnapshot: validation.schemaSnapshot,
      };

      let tripEventId: number | null = app?.trip_event_id || null;
      if (params.typeId === 'BUSINESS_TRIP' && !tripEventId) {
        const title = params.title || '出張申請';
        const purpose = finalFormData.purpose || finalFormData.reason || params.title || '校外業務';
        const destination = finalFormData.destination || '未定';
        const startAt = finalFormData.startAt || (finalFormData.startDate ? `${finalFormData.startDate}T00:00:00` : now);
        const endAt = finalFormData.endAt || (finalFormData.endDate ? `${finalFormData.endDate}T23:59:59` : startAt);
        const transport = finalFormData.transport || '';
        const notes = finalFormData.remarks || finalFormData.notes || '';
        const departurePlace = finalFormData.departurePlace || null;
        const arrivalPlace = finalFormData.arrivalPlace || null;
        const isOralOrder = finalFormData.isOralOrder === true || finalFormData.isOralOrder === 1 ? 1 : 0;
        const oralOrderIssuedAt = finalFormData.oralOrderIssuedAt || null;

        const tripRes = db.prepare(`
          INSERT INTO trip_events (
            title, purpose, destination, departure_place, arrival_place,
            start_at, end_at, transport, is_oral_order, oral_order_issued_at,
            notes, created_by_user_id, version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        `).run(
          title, purpose, destination, departurePlace, arrivalPlace,
          startAt, endAt, transport, isOralOrder, oralOrderIssuedAt,
          notes, params.actor.id, now, now
        );
        tripEventId = Number(tripRes.lastInsertRowid);
      }

      if (applicationId) {
        db.prepare(`
          UPDATE applications
          SET title = ?, form_data = ?, current_status = 'SUBMITTED', current_step_order = 1,
              trip_event_id = COALESCE(?, trip_event_id),
              updated_at = ?, version = version + 1
          WHERE id = ?
        `).run(
          params.title,
          JSON.stringify(finalFormData),
          tripEventId,
          now,
          applicationId
        );
      } else {
        const result = db.prepare(`
          INSERT INTO applications (
            type_id, subject_user_id, submitted_by_user_id, submission_actor_type, submission_mode,
            trip_event_id, title, form_data, current_status, current_step_order, version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SUBMITTED', 1, 1, ?, ?)
        `).run(
          params.typeId,
          params.subjectUserId,
          params.actor.id,
          params.submissionActorType,
          params.submissionMode,
          tripEventId,
          params.title,
          JSON.stringify(finalFormData),
          now,
          now
        );
        applicationId = Number(result.lastInsertRowid);
      }

      if (params.typeId === 'BUSINESS_TRIP' && tripEventId) {
        db.prepare(`
          INSERT OR IGNORE INTO trip_event_members (trip_event_id, user_id, application_id, participation_status, created_at)
          VALUES (?, ?, ?, 'JOINED', ?)
        `).run(tripEventId, effectiveSubjectUserId, applicationId, now);
      }

      // Policy 解決 ＆ 承認ステップ Snapshot 生成 (Server-Authoritative)
      const { resolveWorkflowPolicy } = require('./policyResolver');
      const resolvedPolicy = resolveWorkflowPolicy({
        appTypeId: params.typeId,
        evaluationTime: now,
        subjectUserId: effectiveSubjectUserId,
        submittedByUserId: params.actor.id,
      });

      // 自己衝突解決 (HD-01〜03) ＆ 独立ルート検証 (INV-SC-01〜07, INV-FA-01〜06)
      const resolvedSteps = resolveAndValidateWorkflowSteps(effectiveSubjectUserId, resolvedPolicy.steps);

      const firstPendingStep = resolvedSteps.find((s) => s.status === 'PENDING');
      const initialCurrentStepOrder = firstPendingStep ? firstPendingStep.stepOrder : 1;

      // applications.current_step_order を最初のアクティブ承認ステップへ同期
      db.prepare('UPDATE applications SET current_step_order = ? WHERE id = ?').run(initialCurrentStepOrder, applicationId);

      const insertCycle = db.prepare(`
        INSERT INTO application_workflow_cycles (
          application_id, approval_cycle, workflow_source, workflow_policy_version_id,
          policy_evaluation_at, status, started_at, started_by_user_id
        ) VALUES (?, 1, 'NEW_POLICY_ENGINE', ?, ?, 'IN_PROGRESS', ?, ?)
      `);

      const cycleRes = insertCycle.run(
        applicationId,
        resolvedPolicy.policyVersionId,
        now,
        now,
        params.actor.id
      );
      const cycleId = Number(cycleRes.lastInsertRowid);

      // Policy Version の参照実績更新
      db.prepare('UPDATE workflow_policy_versions SET is_used = 1 WHERE id = ?').run(resolvedPolicy.policyVersionId);

      const insertStep = db.prepare(`
        INSERT INTO application_approval_steps (
          application_id, approval_cycle, workflow_cycle_id, step_order, step_name, step_key, step_label_snapshot,
          selector_type_snapshot, selector_value_snapshot, approver_user_id_snapshot,
          approver_name_snapshot, approver_position_code_snapshot, approver_position_name_snapshot,
          required_role_id, assigned_user_id, status, resolution_reason, action_type, is_final_decision_step
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const rs of resolvedSteps) {
        insertStep.run(
          applicationId,
          cycleId,
          rs.stepOrder,
          rs.stepName,
          rs.stepKey || null,
          rs.stepName,
          rs.selectorType,
          rs.selectorValue,
          rs.approverUserId,
          rs.approverDisplayName,
          rs.approverPositionCode || null,
          rs.approverPositionName || null,
          rs.requiredRoleId,
          rs.approverUserId,
          rs.status,
          rs.resolutionReason || null,
          rs.actionType,
          rs.isFinalDecisionStep ? 1 : 0
        );
      }

      return { applicationId, effectiveSubjectUserId, effectiveActorType };
    });

    try {
      const txResult = runTx();
      const isProxy = txResult.effectiveActorType === 'PROXY';

      // Post-Commit Forensic Audit (品質基盤・独立ログSSOT)
      logAudit({
        actorUserId: params.actor.id,
        actorUsername: params.actor.username,
        subjectUserId: txResult.effectiveSubjectUserId,
        submissionActorType: txResult.effectiveActorType,
        submissionMode: params.submissionMode,
        roleSnapshot: params.actor.roles.join(','),
        action: isProxy ? 'PROXY_SUBMIT' : 'SELF_SUBMIT',
        entityType: 'APPLICATION',
        entityId: txResult.applicationId,
        afterState: 'SUBMITTED',
        comment: isProxy ? `代理申請提出 (対象教員ID: ${txResult.effectiveSubjectUserId})` : '本人申請提出',
        ipAddress: params.actor.ipAddress,
        userAgent: params.actor.userAgent,
      });

      return { success: true, statusCode: 200, message: '申請を提出しました', data: { id: txResult.applicationId } };
    } catch (err: any) {
      if (err.action) {
        logAudit({
          actorUserId: params.actor.id,
          actorUsername: params.actor.username,
          subjectUserId: params.subjectUserId,
          roleSnapshot: params.actor.roles.join(','),
          action: err.action,
          entityType: 'APPLICATION',
          entityId: params.id,
          comment: err.message,
          ipAddress: params.actor.ipAddress,
          userAgent: params.actor.userAgent,
          isSuccess: false,
        });
      }
      return { success: false, statusCode: err.statusCode || 500, errorCode: err.errorCode, message: err.message };
    }
  }

  /**
   * 復命書の提出 (出張後の結果報告)
   */
  static submitReport(
    actor: UserContext,
    params: {
      applicationId: number;
      expectedVersion: number;
      reportDate: string;
      reportResult: string;
      reportRemarks?: string;
      actualMatchesPlan?: boolean;
      actualDeparturePlace?: string;
      actualArrivalPlace?: string;
      actualTransportMode?: string;
      vehicleUsageType?: 'DRIVER' | 'PASSENGER';
      actualDistanceKm?: number;
      communicationCostBorne?: boolean | null;
      actualTripStartAt?: string;
      actualTripEndAt?: string;
      travelExpenseRemarks?: string;
    }
  ): WorkflowResult {
    // 1. Basic Required Validation
    if (!params.reportDate || !params.reportResult || params.reportResult.trim() === '') {
      return { success: false, statusCode: 400, errorCode: 'REPORT_BASIC_FACTS_REQUIRED', message: '復命年月日および結果・状況の記入は必須です' };
    }

    const db = getDb();
    const now = getServerIsoString();

    const runTx = db.transaction(() => {
      const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(params.applicationId) as any;
      if (!app) {
        throw { statusCode: 404, errorCode: 'APPLICATION_NOT_FOUND', message: '対象の申請が存在しません' };
      }
      // 復命書提出権限: 業務本人 (subject_user_id) または代理作成者
      if (app.subject_user_id !== actor.id && app.submitted_by_user_id !== actor.id) {
        throw { statusCode: 403, errorCode: 'FORBIDDEN_REPORT_SUBMIT', message: '対象教員本人のみ復命書を提出できます', action: 'FORBIDDEN_REPORT_SUBMIT' };
      }
      if (app.type_id !== 'BUSINESS_TRIP') {
        throw { statusCode: 400, errorCode: 'INVALID_APPLICATION_TYPE', message: '出張申請のみ復命書を提出できます' };
      }
      if (app.current_status !== 'TRIP_APPROVED') {
        throw { statusCode: 400, errorCode: 'INVALID_APPLICATION_STATUS', message: '旅行命令発令済み（TRIP_APPROVED）以外は復命書を提出できません' };
      }
      if (isMonthlyLocked(app.subject_user_id, params.reportDate)) {
        throw { statusCode: 400, errorCode: 'MONTHLY_LOCKED', message: `${params.reportDate.substring(0, 7)} の出勤簿は校長により確定（ロック）されているため復命書を提出できません` };
      }
      if (app.version !== params.expectedVersion) {
        throw { statusCode: 409, errorCode: 'CONFLICT_DETECTED', message: '他のユーザーによって更新されました', action: 'CONFLICT_DETECTED' };
      }

      // 1.5 Single Active Cycle ガード (PR-09)
      const activeCycle = db.prepare(`
        SELECT id FROM application_workflow_cycles
        WHERE application_id = ? AND status = 'IN_PROGRESS'
      `).get(params.applicationId);

      if (activeCycle) {
        throw { statusCode: 409, errorCode: 'ACTIVE_CYCLE_EXISTS', message: '進行中の承認サイクルが存在するため復命書を提出できません' };
      }

      const trip = db.prepare('SELECT * FROM trip_events WHERE id = ?').get(app.trip_event_id) as any;
      const currentFormData = JSON.parse(app.form_data || '{}');

      // 2. actualMatchesPlan Explicit Confirmation (Strict Tri-State)
      if (params.actualMatchesPlan === undefined || params.actualMatchesPlan === null || typeof params.actualMatchesPlan !== 'boolean') {
        throw {
          statusCode: 400,
          errorCode: 'ACTUAL_MATCHES_PLAN_REQUIRED',
          message: '当初の旅行計画どおり実施したか（actualMatchesPlan）の明示確認が必要です',
        };
      }

      // 3. actualMatchesPlan Consistency
      if (params.actualMatchesPlan === true) {
        if (
          params.actualDeparturePlace !== undefined ||
          params.actualArrivalPlace !== undefined ||
          params.actualTransportMode !== undefined
        ) {
          throw {
            statusCode: 400,
            errorCode: 'ACTUAL_FACT_CONTRADICTION',
            message: '旅行計画どおり（actualMatchesPlan: true）の場合、実績差異項目（actualDeparturePlace, actualArrivalPlace, actualTransportMode）の送信は禁止されています',
          };
        }
      } else {
        // actualMatchesPlan === false: 差異項目が必須
        if (
          !params.actualDeparturePlace ||
          params.actualDeparturePlace.trim() === '' ||
          !params.actualArrivalPlace ||
          params.actualArrivalPlace.trim() === '' ||
          !params.actualTransportMode ||
          params.actualTransportMode.trim() === ''
        ) {
          throw {
            statusCode: 400,
            errorCode: 'ACTUAL_TRIP_FACTS_REQUIRED',
            message: '旅行計画と差異がある場合、実出発地・実帰着地・実交通手段の入力は必須です',
          };
        }
      }

      // 4. Transport-specific Consistency & 5. Format Validation
      const effectiveTransport = params.actualMatchesPlan === true
        ? (trip?.transport || currentFormData.transport)
        : params.actualTransportMode;

      if (effectiveTransport === '自家用車') {
        if (params.vehicleUsageType === 'PASSENGER' && params.actualDistanceKm !== undefined && params.actualDistanceKm !== null) {
          throw {
            statusCode: 400,
            errorCode: 'ACTUAL_DISTANCE_FORBIDDEN_FOR_PASSENGER',
            message: '自家用車同乗者の場合、実走行距離（actualDistanceKm）の入力・送信は禁止されています',
          };
        }
        if (params.vehicleUsageType === 'DRIVER') {
          if (params.actualDistanceKm === undefined || params.actualDistanceKm === null) {
            throw {
              statusCode: 400,
              errorCode: 'ACTUAL_DISTANCE_REQUIRED_FOR_DRIVER',
              message: '自家用車運転者の場合、実走行距離（actualDistanceKm）の入力は必須です',
            };
          }
          if (typeof params.actualDistanceKm !== 'number' || isNaN(params.actualDistanceKm) || params.actualDistanceKm < 0) {
            throw {
              statusCode: 400,
              errorCode: 'INVALID_ACTUAL_DISTANCE',
              message: '実走行距離（actualDistanceKm）は0以上の数値を指定してください',
            };
          }
        }
      } else {
        // 自家用車以外の場合、vehicleUsageType および actualDistanceKm の送信は禁止（Fail-Closed）
        if (params.vehicleUsageType !== undefined && params.vehicleUsageType !== null && (params.vehicleUsageType as any) !== '') {
          throw {
            statusCode: 400,
            errorCode: 'VEHICLE_USAGE_TYPE_FORBIDDEN',
            message: '自家用車以外の場合、運転・同乗区分（vehicleUsageType）の送信は禁止されています',
          };
        }
        if (params.actualDistanceKm !== undefined && params.actualDistanceKm !== null) {
          throw {
            statusCode: 400,
            errorCode: 'ACTUAL_DISTANCE_FORBIDDEN',
            message: '自家用車以外の場合、実走行距離（actualDistanceKm）の送信は禁止されています',
          };
        }
      }

      // 6. Persistence: form_data に復命情報を統合 (Snapshot)
      const updatedFormData = {
        ...currentFormData,
        reportDate: params.reportDate,
        reportResult: params.reportResult,
        reportRemarks: params.reportRemarks || '',
        actualMatchesPlan: params.actualMatchesPlan,
        actualDeparturePlace: params.actualDeparturePlace,
        actualArrivalPlace: params.actualArrivalPlace,
        actualTransportMode: params.actualTransportMode,
        vehicleUsageType: params.vehicleUsageType,
        actualDistanceKm: params.actualDistanceKm,
        communicationCostBorne: params.communicationCostBorne !== undefined ? params.communicationCostBorne : null,
        actualTripStartAt: params.actualTripStartAt,
        actualTripEndAt: params.actualTripEndAt,
        travelExpenseRemarks: params.travelExpenseRemarks,
      };

      // 7. Workflow Progression: Policy 解決 ＆ 自己衝突解決 (HD-01〜03, INV-SC, INV-FA)
      const { resolveWorkflowPolicy } = require('./policyResolver');
      const resolvedPolicy = resolveWorkflowPolicy({
        appTypeId: app.type_id,
        evaluationTime: now,
        subjectUserId: app.subject_user_id,
        submittedByUserId: actor.id,
        policyPurpose: 'POST_TRIP_REPORT',
      });

      const resolvedSteps = resolveAndValidateWorkflowSteps(app.subject_user_id, resolvedPolicy.steps);
      const firstPendingStep = resolvedSteps.find((s) => s.status === 'PENDING');
      const nextStepOrder = firstPendingStep ? firstPendingStep.stepOrder : 1;

      // 新 ApprovalCycle 番号の算出
      const maxCycleRow = db.prepare('SELECT COALESCE(MAX(approval_cycle), 1) as max_cycle FROM application_workflow_cycles WHERE application_id = ?').get(params.applicationId) as any;
      const nextCycle = (maxCycleRow?.max_cycle || 1) + 1;

      // application_workflow_cycles の INSERT (PR-07)
      const cycleRes = db.prepare(`
        INSERT INTO application_workflow_cycles (
          application_id, approval_cycle, cycle_purpose, workflow_source,
          workflow_policy_version_id, policy_evaluation_at, status, started_at, started_by_user_id
        ) VALUES (?, ?, 'POST_TRIP_REPORT', 'NEW_POLICY_ENGINE', ?, ?, 'IN_PROGRESS', ?, ?)
      `).run(params.applicationId, nextCycle, resolvedPolicy.policyVersionId, now, now, actor.id);
      const cycleId = Number(cycleRes.lastInsertRowid);

      // Policy Version の参照実績更新
      db.prepare('UPDATE workflow_policy_versions SET is_used = 1 WHERE id = ?').run(resolvedPolicy.policyVersionId);

      // application_approval_steps の動的 INSERT (Step 1..M)
      const insertStep = db.prepare(`
        INSERT INTO application_approval_steps (
          application_id, approval_cycle, workflow_cycle_id, step_order, step_name, step_key, step_label_snapshot,
          selector_type_snapshot, selector_value_snapshot, approver_user_id_snapshot,
          approver_name_snapshot, approver_position_code_snapshot, approver_position_name_snapshot,
          required_role_id, assigned_user_id, status, resolution_reason, action_type, is_final_decision_step
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const rs of resolvedSteps) {
        insertStep.run(
          params.applicationId,
          nextCycle,
          cycleId,
          rs.stepOrder,
          rs.stepName,
          rs.stepKey || null,
          rs.stepName,
          rs.selectorType,
          rs.selectorValue,
          rs.approverUserId,
          rs.approverDisplayName,
          rs.approverPositionCode || null,
          rs.approverPositionName || null,
          rs.requiredRoleId,
          rs.approverUserId,
          rs.status,
          rs.resolutionReason || null,
          rs.actionType,
          rs.isFinalDecisionStep ? 1 : 0
        );
      }

      // 出張命令 current_status は TRIP_APPROVED を維持し、report_status を REPORT_SUBMITTED、current_step_order を nextStepOrder に更新
      db.prepare(`
        UPDATE applications
        SET form_data = ?, report_status = 'REPORT_SUBMITTED', current_step_order = ?, updated_at = ?, version = version + 1
        WHERE id = ?
      `).run(JSON.stringify(updatedFormData), nextStepOrder, now, params.applicationId);

      return { beforeStatus: app.current_status, subjectUserId: app.subject_user_id };
    });

    try {
      const res = runTx();
      logAudit({
        actorUserId: actor.id,
        actorUsername: actor.username,
        subjectUserId: res.subjectUserId,
        roleSnapshot: actor.roles.join(','),
        action: 'SUBMIT_TRIP_REPORT',
        entityType: 'APPLICATION',
        entityId: params.applicationId,
        beforeState: res.beforeStatus,
        afterState: 'REPORT_SUBMITTED',
        comment: `出張復命書提出 (復命日: ${params.reportDate})`,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      });

      return { success: true, statusCode: 200, message: '出張復命書を提出しました' };
    } catch (err: any) {
      if (err.action) {
        logAudit({
          actorUserId: actor.id,
          actorUsername: actor.username,
          roleSnapshot: actor.roles.join(','),
          action: err.action,
          entityType: 'APPLICATION',
          entityId: params.applicationId,
          comment: err.message,
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
          isSuccess: false,
        });
      }
      return { success: false, statusCode: err.statusCode || 500, errorCode: err.errorCode, message: err.message };
    }
  }

  /**
   * 承認処理 (二重自己承認ブロック・決定論的印影メタデータ生成・スナップショット記録)
   */
  static approveApplication(
    actor: UserContext,
    params: {
      applicationId: number;
      expectedVersion: number;
      comment?: string;
      actionType?: string;
    }
  ): WorkflowResult {
    const db = getDb();
    const now = getServerIsoString();

    const runTx = db.transaction(() => {
      const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(params.applicationId) as any;
      if (!app) {
        throw { statusCode: 404, message: '対象の申請が存在しません' };
      }

      if (app.version !== params.expectedVersion) {
        throw { statusCode: 409, message: '他のユーザーによって更新されました', action: 'CONFLICT_DETECTED' };
      }

      const currentStep = db.prepare(`
        SELECT * FROM application_approval_steps
        WHERE application_id = ? AND step_order = ?
        ORDER BY approval_cycle DESC
        LIMIT 1
      `).get(params.applicationId, app.current_step_order) as any;

      if (!currentStep || currentStep.status !== 'PENDING') {
        throw { statusCode: 400, message: '現在承認可能なステップが存在しません', action: 'INVALID_APPROVAL_STEP' };
      }

      // Server Snapshot Action Authority (W3-01 / W3-02):
      // Client から actionType が明示指定された場合、現在の step.action_type (Snapshot) と一致しているか検証
      if (params.actionType && currentStep.action_type && params.actionType !== currentStep.action_type) {
        throw {
          statusCode: 422,
          errorCode: 'ACTION_TYPE_MISMATCH',
          action: 'ACTION_TYPE_MISMATCH',
          message: `要求されたアクション種別（${params.actionType}）は現在のステップ種別（${currentStep.action_type}）と一致しません（Server Snapshot不一致）。`,
        };
      }

      // 1. 現在のステップが属する Active Cycle を取得
      const activeCycle = db.prepare(`
        SELECT * FROM application_workflow_cycles
        WHERE application_id = ? AND approval_cycle = ?
      `).get(params.applicationId, currentStep.approval_cycle) as any;

      // 認可判定 (Production Authorization Canonical Resolver SSOT)
      const authDecision = evaluateApproverAuthorization(
        actor,
        { subject_user_id: app.subject_user_id, submitted_by_user_id: app.submitted_by_user_id },
        { cycle_purpose: activeCycle?.cycle_purpose || 'APPROVAL', started_by_user_id: activeCycle?.started_by_user_id || app.submitted_by_user_id },
        currentStep
      );

      if (!authDecision.allowed) {
        throw {
          statusCode: authDecision.statusCode || 403,
          errorCode: authDecision.errorCode,
          action: authDecision.action,
          message: authDecision.message || 'このステップを承認する権限がありません',
        };
      }

      // GAP-09: 最終決裁時の UNSURE 保留ガード (Fail-Closed)
      // 該当サイクルにおける最終ステップ決裁時、授業引継ぎ措置が UNSURE のままの場合は決裁を遮断
      const isFinal = isFinalApprovalStep(db, params.applicationId, currentStep.approval_cycle, app.current_step_order);
      if (isFinal) {
        let appFormData: any = {};
        try {
          appFormData = JSON.parse(app.form_data || '{}');
        } catch {}

        if (appFormData.coverageStatus === 'UNSURE') {
          throw {
            statusCode: 422,
            errorCode: 'UNRESOLVED_COVERAGE_STATUS_ON_FINAL_APPROVAL',
            message: '授業引継ぎ・代替措置の要否が未確定（確認中）のまま最終決裁することはできません。要否を確定させてから決裁してください。',
            action: 'UNRESOLVED_COVERAGE_STATUS'
          };
        }
      }

      // 承認者の stamp_name / display_name 取得 (スナップショット用)
      const approverUser = db.prepare('SELECT stamp_name, display_name FROM users WHERE id = ?').get(actor.id) as any;
      const stampName = approverUser?.stamp_name || actor.displayName.slice(0, 4);
      const displayName = approverUser?.display_name || actor.displayName;

      // ステップを APPROVED に更新 (スナップショットカラムも永続化)
      db.prepare(`
        UPDATE application_approval_steps
        SET status = 'APPROVED', action_by_user_id = ?, comment = ?, acted_at = ?,
            action_user_display_name = ?, action_user_stamp_name = ?, action_user_role_name = ?
        WHERE id = ?
      `).run(actor.id, params.comment || '承認', now, displayName, stampName, currentStep.required_role_id, currentStep.id);

      // 次のステップの解決 (同一 approval_cycle 内で SKIPPED を安全に跨ぎ、次の WAITING ステップを探索)
      const nextStep = db.prepare(`
        SELECT * FROM application_approval_steps
        WHERE application_id = ? AND approval_cycle = ? AND step_order > ? AND status = 'WAITING'
        ORDER BY step_order ASC
        LIMIT 1
      `).get(params.applicationId, currentStep.approval_cycle, currentStep.step_order) as any;

      let nextStatus: ApplicationStatus = app.current_status;
      let nextReportStatus: string = app.report_status || 'UNSUBMITTED';
      let nextStepOrder = app.current_step_order;

      if (!isFinal && nextStep) {
        // 次ステップへ進行 (PENDING 更新 ＆ current_step_order のジャンプ)
        nextStepOrder = nextStep.step_order;
        db.prepare("UPDATE application_approval_steps SET status = 'PENDING' WHERE id = ?").run(nextStep.id);

        const cyclePurpose = activeCycle?.cycle_purpose || 'APPROVAL';
        if (cyclePurpose === 'APPROVAL' || cyclePurpose === 'RESUBMISSION') {
          nextStatus = 'IN_APPROVAL';
        } else if (cyclePurpose === 'POST_TRIP_REPORT') {
          nextReportStatus = nextStep.step_order === 2 ? 'REPORT_FIRST_APPROVED' : 'REPORT_SECOND_APPROVED';
        }
      } else {
        // Cycle 完了時のドメイン状態遷移 (PR-06 / ADR-03 / ADR-04)
        const cyclePurpose = activeCycle?.cycle_purpose || 'APPROVAL';
        if (cyclePurpose === 'APPROVAL' || cyclePurpose === 'RESUBMISSION') {
          if (app.type_id === 'BUSINESS_TRIP') {
            nextStatus = 'TRIP_APPROVED';
            nextReportStatus = 'UNSUBMITTED';
          } else {
            nextStatus = 'FINAL_APPROVED';
          }
        } else if (cyclePurpose === 'POST_TRIP_REPORT') {
          nextReportStatus = 'REPORT_FINAL_APPROVED';
        } else if (cyclePurpose === 'CANCELLATION') {
          nextStatus = 'CANCELLED';
        }

        // Active Cycle を APPROVED に更新
        if (activeCycle) {
          db.prepare(`
            UPDATE application_workflow_cycles
            SET status = 'APPROVED', ended_at = ?
            WHERE id = ?
          `).run(now, activeCycle.id);
        }
      }

      // 決裁完了直前再検証 (Final Approval Conflict Revalidation):
      // 並行申請等により、提出後に既に別の申請が FINAL_APPROVED / TRIP_APPROVED になっている場合の排他競合を Fail-Closed 遮断
      if (nextStatus === 'FINAL_APPROVED' || nextStatus === 'TRIP_APPROVED') {
        const formData = JSON.parse(app.form_data || '{}');
        const startDate = formData.startDate || formData.targetDate || formData.startAt?.split('T')?.[0];
        const endDate = formData.endDate || formData.targetDate || formData.endAt?.split('T')?.[0] || startDate;

        if (startDate && endDate) {
          const rawStartTime = formData.startTime || (formData.startAt ? formData.startAt.split('T')?.[1]?.substring(0, 5) : undefined);
          const rawEndTime = formData.endTime || (formData.endAt ? formData.endAt.split('T')?.[1]?.substring(0, 5) : undefined);

          const { ConflictService } = require('../services/conflictService');
          const conflictCheck = ConflictService.validate({
            userId: app.subject_user_id,
            startDate,
            endDate,
            applicationTypeId: app.type_id,
            unitType: formData.unitType || (rawStartTime && rawEndTime ? 'TIME' : 'DAY'),
            startTime: rawStartTime,
            endTime: rawEndTime,
            halfDayType: formData.halfDayType,
            excludeApplicationId: params.applicationId,
            forFinalApproval: true, // 既に決裁済みの確定申請のみと照合
          });

          if (conflictCheck.hasConflict) {
            throw {
              statusCode: 409,
              errorCode: 'SERVICE_PERIOD_CONFLICT',
              message: `最終決裁エラー: ${conflictCheck.reason || '先行して確定した別の服務申請と期間・時間帯が重複しています'}`,
              action: 'CONFLICT_DETECTED',
            };
          }
        }
      }

      // 決裁完了時の組織情報スナップショット固定
      let orgSnapshot: string | null = null;
      if (nextStatus === 'FINAL_APPROVED' || nextStatus === 'TRIP_APPROVED' || nextReportStatus === 'REPORT_FINAL_APPROVED') {
        orgSnapshot = getCurrentOrganizationSnapshot(db);
      }

      // 年次有給休暇の決裁完了時: FIFOロット行使・Usageレコード作成
      if (nextStatus === 'FINAL_APPROVED' && app.type_id === 'LEAVE_ANNUAL') {
        const { AnnualLeaveService } = require('../services/annualLeaveService');
        AnnualLeaveService.finalizeUsage(params.applicationId);
      }

      // 【Original Wave 2B】病気休暇の決裁完了時: Canonical Snapshot 生成・確定永続化
      if (nextStatus === 'FINAL_APPROVED' && app.type_id === 'LEAVE_SICK') {
        const { SickLeaveService } = require('../services/sickLeaveService');
        SickLeaveService.finalizeSickLeaveApplication(params.applicationId, db);
      }

      // 【Original Wave 3】公務旅行・出張命令の決裁完了時: Travel Order Snapshot 生成・確定永続化 (未確定状態からの確定時のみ実行)
      if (nextStatus === 'TRIP_APPROVED' && app.current_status !== 'TRIP_APPROVED' && app.type_id === 'BUSINESS_TRIP') {
        const { TripFinalizationService } = require('../domain/trip/tripFinalizationService');
        TripFinalizationService.finalizeTravelOrder(params.applicationId, db, actor);
      }

      // 【Original Wave 3】出張復命書の決裁完了時: Post-Trip Report Snapshot 生成・確定永続化
      if (nextReportStatus === 'REPORT_FINAL_APPROVED' && app.type_id === 'BUSINESS_TRIP') {
        const { TripReportFinalizationService } = require('../domain/trip/tripReportFinalizationService');
        TripReportFinalizationService.finalizeTripReport(params.applicationId, db, actor);
      }

      db.prepare(`
        UPDATE applications
        SET current_status = ?,
            report_status = ?,
            current_step_order = ?,
            updated_at = ?,
            version = version + 1,
            organization_snapshot = COALESCE(?, organization_snapshot)
        WHERE id = ?
      `).run(nextStatus, nextReportStatus, nextStepOrder, now, orgSnapshot, params.applicationId);

      const isAckStep = currentStep.action_type === 'ACK';
      const isSelfAck = isAckStep && (actor.id === app.subject_user_id);
      const auditAction = isAckStep ? (isSelfAck ? 'ACK_SELF' : 'ACK_RECEIPT') : (isFinal ? 'DECIDE' : 'APPROVE');
      const actionLabel = isAckStep ? (isSelfAck ? '受領確認（本人）' : '受領確認') : (isFinal ? '決裁' : '承認');

      return {
        beforeStatus: app.current_status,
        afterStatus: nextStatus,
        reportStatus: nextReportStatus,
        stepName: currentStep.step_name,
        subjectUserId: app.subject_user_id,
        stampName,
        auditAction,
        actionLabel,
      };
    });

    try {
      const res = runTx();
      logAudit({
        actorUserId: actor.id,
        actorUsername: actor.username,
        subjectUserId: res.subjectUserId,
        roleSnapshot: actor.roles.join(','),
        action: res.auditAction,
        entityType: 'APPLICATION',
        entityId: params.applicationId,
        beforeState: res.beforeStatus,
        afterState: res.afterStatus,
        comment: `${res.actionLabel} [${res.stepName}] (印影氏名: ${res.stampName}, コメント: ${params.comment || res.actionLabel})`,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
        metadata: {
          stepName: res.stepName,
          stampName: res.stampName,
          actedAt: now,
        },
      });

      return {
        success: true,
        statusCode: 200,
        message: `「${res.stepName}」を${res.actionLabel}しました`,
        data: { nextStatus: res.afterStatus, stampName: res.stampName },
      };
    } catch (err: any) {
      if (err.action) {
        logAudit({
          actorUserId: actor.id,
          actorUsername: actor.username,
          roleSnapshot: actor.roles.join(','),
          action: err.action,
          entityType: 'APPLICATION',
          entityId: params.applicationId,
          comment: err.message,
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
          isSuccess: false,
        });
      }
      return { success: false, statusCode: err.statusCode || 500, errorCode: err.errorCode, message: err.message };
    }
  }

  /**
   * 申請差戻し (Return)
   */
  static returnApplication(
    actor: UserContext,
    params: {
      applicationId: number;
      expectedVersion: number;
      comment: string;
    }
  ): WorkflowResult {
    if (!params.comment || params.comment.trim() === '') {
      return { success: false, statusCode: 400, message: '差戻し理由の入力は必須です' };
    }

    const db = getDb();
    const now = getServerIsoString();

    const runTx = db.transaction(() => {
      const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(params.applicationId) as any;
      if (!app) {
        throw { statusCode: 404, message: '対象の申請が存在しません' };
      }
      if (app.version !== params.expectedVersion) {
        throw { statusCode: 409, message: '他のユーザーによって更新されました', action: 'CONFLICT_DETECTED' };
      }

      const currentStep = db.prepare(`
        SELECT * FROM application_approval_steps
        WHERE application_id = ? AND step_order = ?
        ORDER BY approval_cycle DESC
        LIMIT 1
      `).get(params.applicationId, app.current_step_order) as any;

      if (!currentStep || currentStep.status !== 'PENDING') {
        throw { statusCode: 400, message: '現在処理可能なステップが存在しません' };
      }

      // ACK Non-Discretionary Guard (INV-SEM-04 / W3-02):
      // 受領確認（ACK）ステップに対する差戻しは非裁量のため禁止 (Fail-Closed)
      if (currentStep.action_type === 'ACK') {
        throw {
          statusCode: 422,
          errorCode: 'INVALID_ACTION_FOR_ACK',
          action: 'INVALID_ACTION_FOR_ACK',
          message: '受領確認（ACK）ステップに対して差戻しを行うことはできません（INV-SEM-04: 非裁量確認）。',
        };
      }

      const activeCycle = db.prepare(`
        SELECT * FROM application_workflow_cycles
        WHERE application_id = ? AND approval_cycle = ?
      `).get(params.applicationId, currentStep.approval_cycle) as any;

      const expectedApproverId = currentStep.approver_user_id_snapshot || currentStep.assigned_user_id;
      if (expectedApproverId && expectedApproverId !== actor.id) {
        throw { statusCode: 403, message: '差戻しを行う権限がありません', action: 'FORBIDDEN_RETURN_ROLE' };
      } else if (!expectedApproverId && !actor.roles.includes(currentStep.required_role_id)) {
        throw { statusCode: 403, message: '差戻しを行う権限がありません', action: 'FORBIDDEN_RETURN_ROLE' };
      }

      const isReportCycle = activeCycle?.cycle_purpose === 'POST_TRIP_REPORT';

      db.prepare(`
        UPDATE application_approval_steps
        SET status = 'RETURNED', action_by_user_id = ?, comment = ?, acted_at = ?
        WHERE id = ?
      `).run(actor.id, params.comment, now, currentStep.id);

      if (isReportCycle) {
        db.prepare(`
          UPDATE applications
          SET report_status = 'REPORT_RETURNED', updated_at = ?, version = version + 1
          WHERE id = ?
        `).run(now, params.applicationId);
      } else {
        db.prepare(`
          UPDATE applications
          SET current_status = 'RETURNED', updated_at = ?, version = version + 1
          WHERE id = ?
        `).run(now, params.applicationId);
      }

      // Active Cycle を RETURNED に更新
      db.prepare(`
        UPDATE application_workflow_cycles
        SET status = 'RETURNED', return_reason = ?, ended_at = ?
        WHERE application_id = ? AND approval_cycle = ?
      `).run(params.comment, now, params.applicationId, currentStep.approval_cycle);

      return {
        beforeStatus: app.current_status,
        afterStatus: isReportCycle ? app.current_status : 'RETURNED',
        afterReportStatus: isReportCycle ? 'REPORT_RETURNED' : app.report_status,
        subjectUserId: app.subject_user_id,
        isReportStep: isReportCycle,
      };
    });

    try {
      const res = runTx();
      logAudit({
        actorUserId: actor.id,
        actorUsername: actor.username,
        subjectUserId: res.subjectUserId,
        roleSnapshot: actor.roles.join(','),
        action: res.isReportStep ? 'REPORT_RETURN' : 'RETURN',
        entityType: 'APPLICATION',
        entityId: params.applicationId,
        beforeState: res.beforeStatus,
        afterState: res.afterStatus,
        comment: `${res.isReportStep ? '復命書差戻し' : '差戻し'} (理由: ${params.comment})`,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      });


      return { success: true, statusCode: 200, message: '申請を差戻しました' };
    } catch (err: any) {
      if (err.action) {
        logAudit({
          actorUserId: actor.id,
          actorUsername: actor.username,
          roleSnapshot: actor.roles.join(','),
          action: err.action,
          entityType: 'APPLICATION',
          entityId: params.applicationId,
          comment: err.message,
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
          isSuccess: false,
        });
      }
      return { success: false, statusCode: err.statusCode || 500, errorCode: err.errorCode, message: err.message };
    }
  }

  /**
   * 申請却下 (Reject)
   * 
   * 【Universal RETURN Model v1.0 FINAL / Guard Hierarchy OPTION B】
   * 1. ACK ガード (422 INVALID_ACTION_FOR_ACK) ── 既存非裁量確認セマンティクス
   * 2. REVIEW ガード (422 INVALID_ACTION_FOR_REVIEW) ── 既存中間審査セマンティクス
   * 3. DECIDE / 終端決裁ステップ ──► 422 REJECT_ACTION_DEPRECATED (Universal RETURN Fail-Closed)
   * 4. DB / Step / Cycle / Version Mutation ──► 到達禁止 (Zero Business Mutation)
   */
  static rejectApplication(
    actor: UserContext,
    params: {
      applicationId: number;
      expectedVersion: number;
      comment: string;
    }
  ): WorkflowResult {
    if (!params.comment || params.comment.trim() === '') {
      return { success: false, statusCode: 400, message: '却下理由の入力は必須です' };
    }

    const db = getDb();
    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(params.applicationId) as any;
    if (!app) {
      return { success: false, statusCode: 404, message: '対象の申請が存在しません' };
    }
    if (app.version !== params.expectedVersion) {
      return { success: false, statusCode: 409, errorCode: 'CONFLICT_DETECTED', message: '他のユーザーによって更新されました' };
    }

    const currentStep = db.prepare(`
      SELECT * FROM application_approval_steps
      WHERE application_id = ? AND step_order = ?
      ORDER BY approval_cycle DESC
      LIMIT 1
    `).get(params.applicationId, app.current_step_order) as any;

    if (!currentStep || currentStep.status !== 'PENDING') {
      return { success: false, statusCode: 400, message: '現在処理可能なステップが存在しません' };
    }

    // 1. ACK Non-Discretionary Guard (INV-SEM-04 / W3-02 / INV-URETURN-08):
    if (currentStep.action_type === 'ACK') {
      return {
        success: false,
        statusCode: 422,
        errorCode: 'INVALID_ACTION_FOR_ACK',
        message: '受領確認（ACK）ステップに対して却下を行うことはできません（INV-SEM-04: 非裁量確認）。',
      };
    }

    // 2. Intermediate REVIEW Guard (REJECT SHOULD BE DECIDE-ONLY):
    if (currentStep.action_type !== 'DECIDE') {
      return {
        success: false,
        statusCode: 422,
        errorCode: 'INVALID_ACTION_FOR_REVIEW',
        message: '中間審査ステップに対して却下を行うことはできません（REJECTは終端決裁ステップ専属の権能です）。',
      };
    }

    // 3. DECIDE / formerly reject-capable Generic Business REJECT (Universal RETURN Model v1.0 FINAL / INV-URETURN-01 / INV-URETURN-07):
    return {
      success: false,
      statusCode: 422,
      errorCode: 'REJECT_ACTION_DEPRECATED',
      message: '本システムでは却下（REJECT）アクションは廃止されました。内容に不備や支障がある場合は「差戻し（RETURN）」を行ってください（Universal RETURN Model v1.0 FINAL）。',
    };
  }

  /**
   * 取下げ処理 (申請者本人による取消)
   */
  static withdrawApplication(
    actor: UserContext,
    params: {
      applicationId: number;
      expectedVersion: number;
    }
  ): WorkflowResult {
    const db = getDb();
    const now = getServerIsoString();

    const runTx = db.transaction(() => {
      const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(params.applicationId) as any;
      if (!app) {
        throw { statusCode: 404, message: '対象の申請が存在しません' };
      }
      if (app.subject_user_id !== actor.id && app.submitted_by_user_id !== actor.id) {
        throw { statusCode: 403, message: '申請者本人のみ取下げできます', action: 'FORBIDDEN_WITHDRAW' };
      }
      if (['FINAL_APPROVED', 'REJECTED', 'WITHDRAWN'].includes(app.current_status)) {
        throw { statusCode: 400, message: '確定・却下・取下げ済みの申請は取下げできません' };
      }
      if (app.version !== params.expectedVersion) {
        throw { statusCode: 409, message: '他のユーザーによって更新されました', action: 'CONFLICT_DETECTED' };
      }

      db.prepare(`
        UPDATE applications
        SET current_status = 'WITHDRAWN', updated_at = ?, version = version + 1
        WHERE id = ?
      `).run(now, params.applicationId);

      // Active Cycle を WITHDRAWN に更新
      db.prepare(`
        UPDATE application_workflow_cycles
        SET status = 'WITHDRAWN', ended_at = ?
        WHERE application_id = ? AND status = 'IN_PROGRESS'
      `).run(now, params.applicationId);

      // 残存する PENDING / WAITING ステップを WITHDRAWN に更新
      db.prepare(`
        UPDATE application_approval_steps
        SET status = 'WITHDRAWN'
        WHERE application_id = ? AND status IN ('PENDING', 'WAITING')
      `).run(params.applicationId);

      return { beforeStatus: app.current_status, subjectUserId: app.subject_user_id };
    });

    try {
      const res = runTx();
      logAudit({
        actorUserId: actor.id,
        actorUsername: actor.username,
        subjectUserId: res.subjectUserId,
        roleSnapshot: actor.roles.join(','),
        action: 'WITHDRAW',
        entityType: 'APPLICATION',
        entityId: params.applicationId,
        beforeState: res.beforeStatus,
        afterState: 'WITHDRAWN',
        comment: '申請取下げ',
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      });

      return { success: true, statusCode: 200, message: '申請を取下げました' };
    } catch (err: any) {
      if (err.action) {
        logAudit({
          actorUserId: actor.id,
          actorUsername: actor.username,
          roleSnapshot: actor.roles.join(','),
          action: err.action,
          entityType: 'APPLICATION',
          entityId: params.applicationId,
          comment: err.message,
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
          isSuccess: false,
        });
      }
      return { success: false, statusCode: err.statusCode || 500, message: err.message };
    }
  }

  /**
   * 出張イベント詳細取得 (行・フィールドレベル認可)
   */
  static getTripEventDetail(actor: UserContext, tripEventId: number): WorkflowResult {
    const db = getDb();
    const event = db.prepare('SELECT * FROM trip_events WHERE id = ?').get(tripEventId) as any;
    if (!event) {
      return { success: false, statusCode: 404, message: '対象の出張イベントが存在しません' };
    }

    const members = db.prepare(`
      SELECT tem.*, u.display_name, u.stamp_name, u.department
      FROM trip_event_members tem
      JOIN users u ON tem.user_id = u.id
      WHERE tem.trip_event_id = ?
    `).all(tripEventId) as any[];

    const isMember = members.some((m) => m.user_id === actor.id);
    const isManager = actor.roles.some((r) => ['VICE_PRINCIPAL', 'PRINCIPAL', 'ADMIN'].includes(r));

    if (!isMember && !isManager) {
      return { success: false, statusCode: 403, message: 'この出張イベントを閲覧する権限がありません' };
    }

    // 一般教員は自分以外の個別申請詳細・復命内容をマスク
    let filteredMembers = members;
    if (!isManager) {
      filteredMembers = members.map((m) => {
        if (m.user_id === actor.id) {
          return m;
        }
        return {
          id: m.id,
          trip_event_id: m.trip_event_id,
          user_id: m.user_id,
          display_name: m.display_name,
          stamp_name: m.stamp_name,
          department: m.department,
          participation_status: m.participation_status,
          // application_id や individual_notes は除外
        };
      });
    }

    return {
      success: true,
      statusCode: 200,
      message: '取得成功',
      data: {
        event,
        members: filteredMembers,
      },
    };
  }

  /**
   * 申請詳細取得 (行レベル認可 + 印影メタデータ付与)
   */
  static getApplicationDetail(actor: UserContext, applicationId: number): WorkflowResult {
    const db = getDb();
    const app = db.prepare(`
      SELECT
        a.*,
        t.name as type_name,
        su.display_name as subject_user_name,
        su.stamp_name as subject_stamp_name,
        su.department as subject_department,
        pu.display_name as proxy_user_name,
        pu.stamp_name as proxy_stamp_name
      FROM applications a
      JOIN application_types t ON a.type_id = t.id
      JOIN users su ON a.subject_user_id = su.id
      LEFT JOIN users pu ON a.submitted_by_user_id = pu.id
      WHERE a.id = ?
    `).get(applicationId) as any;

    if (!app) {
      return { success: false, statusCode: 404, message: '対象の申請が存在しません' };
    }

    const isSubject = app.subject_user_id === actor.id;
    const isProxySubmitter = app.submitted_by_user_id === actor.id;
    const isManager = actor.roles.some((r) => ['VICE_PRINCIPAL', 'PRINCIPAL', 'ADMIN'].includes(r));

    // Current / Active Cycle (IN_PROGRESS) の Snapshot 担当者であるかを判定 (Canonical SSOT)
    const isCurrentCycleParticipant = db.prepare(`
      SELECT 1
      FROM application_approval_steps s
      JOIN application_workflow_cycles c
        ON s.application_id = c.application_id AND s.approval_cycle = c.approval_cycle
      WHERE s.application_id = ?
        AND c.status = 'IN_PROGRESS'
        AND COALESCE(s.approver_user_id_snapshot, s.assigned_user_id) = ?
      LIMIT 1
    `).get(applicationId, actor.id) !== undefined;

    if (!isSubject && !isProxySubmitter && !isManager && !isCurrentCycleParticipant) {
      return { success: false, statusCode: 403, message: 'この申請を閲覧する権限がありません' };
    }

    // ワークフロー世代一覧と承認ステップ取得（Snapshot最優先: Historical Record Immutability SSOT）
    const cycles = db.prepare(`
      SELECT * FROM application_workflow_cycles
      WHERE application_id = ?
      ORDER BY approval_cycle ASC
    `).all(applicationId) as any[];

    const activeCancellationCycle = cycles.find(
      (c) => c.cycle_purpose === 'CANCELLATION' && c.status === 'IN_PROGRESS'
    ) || null;

    const latestCancellationCycle = cycles
      .filter((c) => c.cycle_purpose === 'CANCELLATION')
      .sort((a, b) => b.approval_cycle - a.approval_cycle)[0] || null;

    let cancellationReturn = null;
    if (latestCancellationCycle && latestCancellationCycle.status === 'RETURNED') {
      const returnedStep = db.prepare(`
        SELECT s.*, u.display_name as action_user_name
        FROM application_approval_steps s
        LEFT JOIN users u ON s.action_by_user_id = u.id
        WHERE s.application_id = ? AND s.approval_cycle = ? AND s.status = 'RETURNED'
        ORDER BY s.step_order DESC
        LIMIT 1
      `).get(applicationId, latestCancellationCycle.approval_cycle) as any;

      // Cancellation Domain authoritative fact only (started_by_user_id), strictly NO original application fallback
      const actionActorUserId = latestCancellationCycle.started_by_user_id ?? null;

      cancellationReturn = {
        cycleId: latestCancellationCycle.id,
        approvalCycle: latestCancellationCycle.approval_cycle,
        status: 'RETURNED' as const,
        returnReason: latestCancellationCycle.return_reason || returnedStep?.comment || '',
        returnedAt: latestCancellationCycle.ended_at || returnedStep?.acted_at || '',
        returnedByUserId: returnedStep?.action_by_user_id ?? null,
        returnedByUserName: returnedStep?.action_user_name || returnedStep?.action_user_display_name || '決裁者',
        actionActorUserId,
      };
    }

    const steps = db.prepare(`
      SELECT
        s.*,
        COALESCE(s.action_user_display_name, s.approver_name_snapshot, u.display_name) as action_user_name,
        COALESCE(s.action_user_stamp_name, u.stamp_name, '') as action_user_stamp_name,
        COALESCE(s.approver_position_name_snapshot, '') as approver_position_name
      FROM application_approval_steps s
      LEFT JOIN users u ON s.action_by_user_id = u.id
      WHERE s.application_id = ?
      ORDER BY s.approval_cycle ASC, s.step_order ASC
    `).all(applicationId) as any[];

    return {
      success: true,
      statusCode: 200,
      message: '取得成功',
      data: {
        application: app,
        steps,
        cycles,
        activeCancellationCycle,
        latestCancellationCycle,
        cancellationReturn,
      },
    };
  }

  /**
   * 校長による出勤簿の月次確定・承認サイン (校長本人のみ実行可能)
   */
  static confirmMonthlyAttendance(
    actor: UserContext,
    params: {
      userId: number;
      yearMonth: string;
      comment?: string;
    }
  ): WorkflowResult {
    // 厳格な業務権限チェック: 校長 (PRINCIPAL) のみ実行可能 (ADMIN代行不可)
    if (!actor.roles.includes('PRINCIPAL')) {
      logAudit({
        actorUserId: actor.id,
        actorUsername: actor.username,
        subjectUserId: params.userId,
        roleSnapshot: actor.roles.join(','),
        action: 'FORBIDDEN_CONFIRM_ATTENDANCE',
        entityType: 'ATTENDANCE_BOOK',
        entityId: `${params.userId}_${params.yearMonth}`,
        comment: '非校長アカウントによる出勤簿月次確定試行 (ADMIN等による代行は禁止されています)',
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
        isSuccess: false,
      });
      return { success: false, statusCode: 403, message: '出勤簿の月次確定は校長本人のみ実行可能です' };
    }

    const db = getDb();
    const now = getServerIsoString();

    try {
      const approverUser = db.prepare('SELECT stamp_name, display_name FROM users WHERE id = ?').get(actor.id) as any;
      const stampName = approverUser?.stamp_name || actor.displayName.slice(0, 4);
      const displayName = approverUser?.display_name || actor.displayName;

      // SnapshotService を実行 (Fail-Closed UNKNOWN_PATTERN ガード + 不変スナップショット作成)
      const { SnapshotService } = require('../services/snapshotService');
      const snapshotId = SnapshotService.finalizeMonth(
        params.userId,
        params.yearMonth,
        {
          id: actor.id,
          username: actor.username,
          displayName,
          stampName,
        },
        params.comment
      );

      logAudit({
        actorUserId: actor.id,
        actorUsername: actor.username,
        subjectUserId: params.userId,
        roleSnapshot: actor.roles.join(','),
        action: 'CONFIRM_MONTHLY_ATTENDANCE',
        entityType: 'ATTENDANCE_BOOK',
        entityId: `${params.userId}_${params.yearMonth}`,
        afterState: 'CONFIRMED',
        comment: `月次出勤簿確定・承認サイン (${params.yearMonth}, 印影氏名: ${stampName}, Snapshot ID: ${snapshotId})`,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
        metadata: {
          confirmedByUserName: displayName,
          confirmedByStampName: stampName,
          snapshotId,
          actedAt: now,
        },
      });

      return { success: true, statusCode: 200, message: `${params.yearMonth} の出勤簿を確定・承認しました`, data: { snapshotId } };
    } catch (err: any) {
      console.error('[confirmMonthlyAttendance Error]:', err.message);
      return { success: false, statusCode: 400, message: err.message || '出勤簿確定処理に失敗しました' };
    }
  }

  /**
   * 校長による出勤簿の月次確定解除 (アンロック・訂正用)
   */
  static unlockMonthlyAttendance(
    actor: UserContext,
    params: {
      userId: number;
      yearMonth: string;
      reason: string;
    }
  ): WorkflowResult {
    // 厳格な業務権限チェック: 校長 (PRINCIPAL) のみ実行可能
    if (!actor.roles.includes('PRINCIPAL')) {
      logAudit({
        actorUserId: actor.id,
        actorUsername: actor.username,
        subjectUserId: params.userId,
        roleSnapshot: actor.roles.join(','),
        action: 'FORBIDDEN_UNLOCK_ATTENDANCE',
        entityType: 'ATTENDANCE_BOOK',
        entityId: `${params.userId}_${params.yearMonth}`,
        comment: '非校長アカウントによる出勤簿月次確定解除試行',
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
        isSuccess: false,
      });
      return { success: false, statusCode: 403, message: '出勤簿の確定解除（アンロック）は校長本人のみ実行可能です' };
    }

    if (!params.reason || params.reason.trim() === '') {
      return { success: false, statusCode: 400, message: '確定解除理由の入力は必須です' };
    }

    const db = getDb();
    const now = getServerIsoString();

    const approval = db.prepare(`
      SELECT * FROM monthly_attendance_approvals WHERE user_id = ? AND year_month = ?
    `).get(params.userId, params.yearMonth) as any;

    if (!approval || approval.status !== 'CONFIRMED') {
      return { success: false, statusCode: 400, message: '対象年月は確定（ロック）されていません' };
    }

    db.prepare(`
      UPDATE monthly_attendance_approvals
      SET status = 'UNLOCKED_FOR_CORRECTION',
          unlocked_by_user_id = ?,
          unlocked_reason = ?,
          unlocked_at = ?,
          version = version + 1
      WHERE user_id = ? AND year_month = ?
    `).run(actor.id, params.reason, now, params.userId, params.yearMonth);

    // 確定解除に伴い、該当月のLOCKEDスナップショットをNEEDS_RECONFIRMATIONへ遷移
    db.prepare(`
      UPDATE monthly_attendance_snapshots
      SET status = 'NEEDS_RECONFIRMATION',
          reconfirmation_reason = ?
      WHERE user_id = ? AND year_month = ? AND status = 'LOCKED'
    `).run(`月次確定解除 (理由: ${params.reason})`, params.userId, params.yearMonth);

    logAudit({
      actorUserId: actor.id,
      actorUsername: actor.username,
      subjectUserId: params.userId,
      roleSnapshot: actor.roles.join(','),
      action: 'UNLOCK_MONTHLY_ATTENDANCE',
      entityType: 'ATTENDANCE_BOOK',
      entityId: `${params.userId}_${params.yearMonth}`,
      beforeState: 'CONFIRMED',
      afterState: 'UNLOCKED_FOR_CORRECTION',
      comment: `月次出勤簿確定解除 (理由: ${params.reason})`,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return { success: true, statusCode: 200, message: `${params.yearMonth} の出勤簿確定を解除（アンロック）しました` };
  }

  /**
   * 差戻し後の再申請（Resubmit）処理 (Atomic Transaction & 過去履歴完全保持)
   */
  static resubmitApplication(
    actor: UserContext,
    params: {
      applicationId: number;
      expectedVersion: number;
      title: string;
      formData: Record<string, any>;
    }
  ): WorkflowResult {
    const db = getDb();
    const now = getServerIsoString();

    const runTx = db.transaction(() => {
      const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(params.applicationId) as any;
      if (!app) {
        throw { statusCode: 404, message: '対象の申請が存在しません' };
      }

      // 1. 状態遷移チェック (Matrix: RETURNED のみ許可)
      if (app.current_status !== 'RETURNED') {
        throw {
          statusCode: 400,
          message: `現在の状態（${app.current_status}）からは再提出できません。差戻し（RETURNED）状態の申請のみ再提出可能です。`,
          action: 'INVALID_RESUBMIT_STATUS',
        };
      }

      // 2. 楽観的排他制御 (Version Check)
      if (app.version !== params.expectedVersion) {
        throw { statusCode: 409, message: '他のユーザーによって更新されました', action: 'CONFLICT_DETECTED' };
      }

      // 3. 再提出 Actor Policy (canResubmit)
      const isSubject = app.subject_user_id === actor.id;
      const isProxySubmitter = app.submitted_by_user_id === actor.id;
      const isManager = actor.roles.some((r) => ['VICE_PRINCIPAL', 'PRINCIPAL', 'ADMIN'].includes(r));

      if (app.submission_actor_type === 'SELF') {
        if (!isSubject) {
          throw { statusCode: 403, message: '本人申請の再提出は本人のみ実行可能です', action: 'FORBIDDEN_RESUBMIT' };
        }
      } else {
        // PROXY
        if (!isProxySubmitter && !isManager) {
          throw { statusCode: 403, message: '代理申請の再提出は代理起案者または管理職のみ実行可能です', action: 'FORBIDDEN_RESUBMIT' };
        }
      }

      // 4. 月次確定ロック確認
      const targetDate = params.formData?.startDate || params.formData?.targetDate;
      if (isMonthlyLocked(app.subject_user_id, targetDate)) {
        throw {
          statusCode: 423,
          message: `${targetDate ? targetDate.substring(0, 7) : ''} の出勤簿は校長により確定（ロック）されているため再提出できません`,
          action: 'MONTHLY_LOCKED_RESUBMIT',
        };
      }

      // 5. 制度バリデーション (ApplicationValidationPipeline)
      // 既存スナップショットを抽出して再利用 (Historical Schema Snapshot Preservation)
      let existingSnapshot: any = undefined;
      try {
        const storedFormData = JSON.parse(app.form_data || '{}');
        if (storedFormData.schemaSnapshot) {
          existingSnapshot = storedFormData.schemaSnapshot;
        }
      } catch {}

      const { ApplicationValidationPipeline } = require('../services/applicationValidationPipeline');
      const validation = ApplicationValidationPipeline.validate({
        typeId: app.type_id,
        subjectUserId: app.subject_user_id,
        formData: params.formData,
        applicationId: params.applicationId,
        schemaSnapshot: existingSnapshot,
        db,
      });

      if (!validation.valid) {
        throw {
          statusCode: validation.status || 400,
          message: validation.message || '再提出のバリデーションに失敗しました',
          errorCode: validation.errorCode,
        };
      }

      const finalFormData = {
        ...(validation.sanitizedValues || params.formData),
        schemaVersion: existingSnapshot?.version || validation.schemaVersion,
        schemaSnapshot: existingSnapshot || validation.schemaSnapshot,
      };

      // 6. 新 ApprovalCycle の算出と生成 (過去履歴は DELETE/UPDATE せず完全保持)
      const maxCycleRow = db.prepare('SELECT COALESCE(MAX(approval_cycle), 1) as max_cycle FROM application_approval_steps WHERE application_id = ?').get(params.applicationId) as any;
      const nextCycle = (maxCycleRow?.max_cycle || 1) + 1;

      const isReport = app.report_status === 'REPORT_RETURNED';
      const cyclePurpose = isReport ? 'POST_TRIP_REPORT' : 'RESUBMISSION';
      const policyPurpose = isReport ? 'POST_TRIP_REPORT' : 'APPROVAL';

      const { resolveWorkflowPolicy } = require('./policyResolver');
      const resolvedPolicy = resolveWorkflowPolicy({
        appTypeId: app.type_id,
        evaluationTime: now,
        subjectUserId: app.subject_user_id,
        submittedByUserId: actor.id,
        policyPurpose,
      });

      // 自己衝突解決 (HD-01〜03) ＆ 独立ルート検証 (INV-SC-01〜07, INV-FA-01〜06)
      const resolvedSteps = resolveAndValidateWorkflowSteps(app.subject_user_id, resolvedPolicy.steps);
      const firstPendingStep = resolvedSteps.find((s) => s.status === 'PENDING');
      const initialStepOrder = firstPendingStep ? firstPendingStep.stepOrder : 1;

      const insertCycle = db.prepare(`
        INSERT INTO application_workflow_cycles (
          application_id, approval_cycle, cycle_purpose, workflow_source, workflow_policy_version_id,
          policy_evaluation_at, status, started_at, started_by_user_id
        ) VALUES (?, ?, ?, 'NEW_POLICY_ENGINE', ?, ?, 'IN_PROGRESS', ?, ?)
      `);

      const cycleRes = insertCycle.run(
        params.applicationId,
        nextCycle,
        cyclePurpose,
        resolvedPolicy.policyVersionId,
        now,
        now,
        actor.id
      );
      const cycleId = Number(cycleRes.lastInsertRowid);

      // Policy Version の参照実績更新
      db.prepare('UPDATE workflow_policy_versions SET is_used = 1 WHERE id = ?').run(resolvedPolicy.policyVersionId);

      const insertStep = db.prepare(`
        INSERT INTO application_approval_steps (
          application_id, approval_cycle, workflow_cycle_id, step_order, step_name, step_key, step_label_snapshot,
          selector_type_snapshot, selector_value_snapshot, approver_user_id_snapshot,
          approver_name_snapshot, approver_position_code_snapshot, approver_position_name_snapshot,
          required_role_id, assigned_user_id, status, resolution_reason, action_type, is_final_decision_step
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const rs of resolvedSteps) {
        insertStep.run(
          params.applicationId,
          nextCycle,
          cycleId,
          rs.stepOrder,
          rs.stepName,
          rs.stepKey || null,
          rs.stepName,
          rs.selectorType,
          rs.selectorValue,
          rs.approverUserId,
          rs.approverDisplayName,
          rs.approverPositionCode || null,
          rs.approverPositionName || null,
          rs.requiredRoleId,
          rs.approverUserId,
          rs.status,
          rs.resolutionReason || null,
          rs.actionType,
          rs.isFinalDecisionStep ? 1 : 0
        );
      }

      // 7. Application の更新 (current_status -> SUBMITTED, current_step_order -> 1, version -> version + 1)
      db.prepare(`
        UPDATE applications
        SET title = ?,
             form_data = ?,
             current_status = 'SUBMITTED',
             current_step_order = 1,
             updated_at = ?,
             version = version + 1
        WHERE id = ?
      `).run(params.title, JSON.stringify(finalFormData), now, params.applicationId);

      return {
        beforeStatus: app.current_status,
        beforeVersion: app.version,
        newVersion: app.version + 1,
        subjectUserId: app.subject_user_id,
        approvalCycle: nextCycle,
        typeId: app.type_id,
      };
    });

    try {
      const res = runTx();

      logAudit({
        actorUserId: actor.id,
        actorUsername: actor.username,
        subjectUserId: res.subjectUserId,
        roleSnapshot: actor.roles.join(','),
        action: 'RESUBMIT',
        entityType: 'APPLICATION',
        entityId: params.applicationId,
        entityVersion: res.newVersion,
        beforeState: res.beforeStatus,
        afterState: 'SUBMITTED',
        comment: `差戻し後の再申請提出 (Cycle: ${res.approvalCycle}, Version: v${res.beforeVersion} -> v${res.newVersion})`,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
        metadata: {
          approvalCycle: res.approvalCycle,
          previousVersion: res.beforeVersion,
          newVersion: res.newVersion,
          typeId: res.typeId,
        },
      });

      return {
        success: true,
        statusCode: 200,
        message: '申請を再提出しました（承認フローが再開されました）',
        data: { id: params.applicationId, version: res.newVersion, approvalCycle: res.approvalCycle },
      };
    } catch (err: any) {
      if (err.action) {
        logAudit({
          actorUserId: actor.id,
          actorUsername: actor.username,
          roleSnapshot: actor.roles.join(','),
          action: err.action,
          entityType: 'APPLICATION',
          entityId: params.applicationId,
          comment: err.message,
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
          isSuccess: false,
        });
      }
      return { success: false, statusCode: err.statusCode || 500, message: err.message, errorCode: err.errorCode };
    }
  }

  /**
   * 承認後取消起案 (Request Cancellation)
   * 
   * 1. 状態検証: FINAL_APPROVED または TRIP_APPROVED のみ起案可能
   * 2. 重複起案防止: 進行中 (IN_PROGRESS) の CANCELLATION Cycle が存在する場合は 409
   * 3. 起案者権限検証 (HD-W1-01 Option B):
   *    - SUBJECT (本人)
   *    - ORIGINAL_PROXY_CREATOR (元の代理作成者)
   *    - AUTHORIZED_SCHOOL_MANAGER (VICE_PRINCIPAL, PRINCIPAL)
   *    - ADMIN role alone は起案権限なし (403)
   * 4. TOCTOU 月次確定ロック検証: 423
   * 5. Policy 解決 (policy_purpose = 'CANCELLATION'): Fail-Closed
   * 6. Cycle 生成 (cycle_purpose = 'CANCELLATION', status = 'IN_PROGRESS', cancellation_reason)
   * 7. applications.current_status は FINAL_APPROVED / TRIP_APPROVED を維持 (Dual-Axis Lifecycle)
   * 8. Strict Audit Trail (logAuditStrict)
   */
  static requestCancellation(
    actor: UserContext,
    params: {
      applicationId: number;
      expectedVersion: number;
      cancellationReason: string;
    }
  ): WorkflowResult {
    if (!params.cancellationReason || params.cancellationReason.trim() === '') {
      return { success: false, statusCode: 400, message: '取消理由の入力は必須です' };
    }

    const db = getDb();
    const now = getServerIsoString();

    const runTx = db.transaction(() => {
      const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(params.applicationId) as any;
      if (!app) {
        throw { statusCode: 404, message: '対象の申請が存在しません' };
      }

      // 1. 状態検証: 承認済みの確定申請のみ取消起案可能
      if (app.current_status !== 'FINAL_APPROVED' && app.current_status !== 'TRIP_APPROVED') {
        throw {
          statusCode: 400,
          errorCode: 'INVALID_STATUS_FOR_CANCELLATION',
          message: `承認済みの申請のみ取消起案が可能です (現在の状態: ${app.current_status})`,
        };
      }

      // 2. 楽観ロック (Version Check)
      if (app.version !== params.expectedVersion) {
        throw { statusCode: 409, errorCode: 'CONFLICT_DETECTED', message: '他のユーザーまたは別タブによって更新されました', action: 'CONFLICT_DETECTED' };
      }

      // 3. 起案者権限検証 (HD-W1-01 Option B)
      const isSubject = app.subject_user_id === actor.id;
      const isOriginalProxyCreator = app.submission_actor_type === 'PROXY' && app.submitted_by_user_id === actor.id;
      const isSchoolManager = actor.roles.some((r) => ['VICE_PRINCIPAL', 'PRINCIPAL'].includes(r));

      if (!isSubject && !isOriginalProxyCreator && !isSchoolManager) {
        throw {
          statusCode: 403,
          errorCode: 'FORBIDDEN_CANCELLATION_REQUEST',
          message: '承認後取消の起案権限がありません (本人、元の代理起案者、または管理職のみ起案可能です)',
          action: 'FORBIDDEN_CANCELLATION_REQUEST',
        };
      }

      // 4. 重複起案防止 (二重進行中防止)
      const activeCancelCycle = db.prepare(`
        SELECT id FROM application_workflow_cycles
        WHERE application_id = ? AND cycle_purpose = 'CANCELLATION' AND status = 'IN_PROGRESS'
      `).get(params.applicationId);

      if (activeCancelCycle) {
        throw {
          statusCode: 409,
          errorCode: 'CANCELLATION_ALREADY_IN_PROGRESS',
          message: 'この申請には既に進行中の取消ワークフローが存在します',
        };
      }

      // 5. TOCTOU 月次確定ロック検証 (HTTP 423)
      const formData = JSON.parse(app.form_data || '{}');
      const targetDate = formData.startDate || formData.targetDate || formData.startAt?.split('T')?.[0];
      if (isMonthlyLocked(app.subject_user_id, targetDate)) {
        throw {
          statusCode: 423,
          errorCode: 'MONTHLY_LOCKED',
          message: `${targetDate ? targetDate.substring(0, 7) : ''} の出勤簿は校長により月次確定（ロック）されているため取消起案できません`,
          action: 'MONTHLY_LOCKED_CANCELLATION',
        };
      }

      // 6. Cancellation Policy 解決 ＆ 自己衝突解決 (HD-01〜03, INV-SC, INV-FA)
      const { resolveWorkflowPolicy } = require('./policyResolver');
      const resolvedPolicy = resolveWorkflowPolicy({
        appTypeId: app.type_id,
        evaluationTime: now,
        subjectUserId: app.subject_user_id,
        submittedByUserId: actor.id,
        policyPurpose: 'CANCELLATION',
      });

      const resolvedSteps = resolveAndValidateWorkflowSteps(app.subject_user_id, resolvedPolicy.steps);

      // 7. 新 ApprovalCycle 番号算出
      const maxCycleRow = db.prepare('SELECT COALESCE(MAX(approval_cycle), 0) as max_cycle FROM application_workflow_cycles WHERE application_id = ?').get(params.applicationId) as any;
      const nextCycle = (maxCycleRow?.max_cycle || 1) + 1;

      // 8. Cycle 作成
      const insertCycle = db.prepare(`
        INSERT INTO application_workflow_cycles (
          application_id, approval_cycle, cycle_purpose, workflow_source,
          workflow_policy_version_id, policy_evaluation_at, status, cancellation_reason,
          started_at, started_by_user_id
        ) VALUES (?, ?, 'CANCELLATION', 'NEW_POLICY_ENGINE', ?, ?, 'IN_PROGRESS', ?, ?, ?)
      `);

      const cycleRes = insertCycle.run(
        params.applicationId,
        nextCycle,
        resolvedPolicy.policyVersionId,
        now,
        params.cancellationReason,
        now,
        actor.id
      );
      const cycleId = Number(cycleRes.lastInsertRowid);

      // Policy Version 参照実績更新
      db.prepare('UPDATE workflow_policy_versions SET is_used = 1 WHERE id = ?').run(resolvedPolicy.policyVersionId);

      // 9. 承認ステップ Snapshot 作成
      const insertStep = db.prepare(`
        INSERT INTO application_approval_steps (
          application_id, approval_cycle, workflow_cycle_id, step_order, step_name, step_key, step_label_snapshot,
          selector_type_snapshot, selector_value_snapshot, approver_user_id_snapshot,
          approver_name_snapshot, approver_position_code_snapshot, approver_position_name_snapshot,
          required_role_id, assigned_user_id, status, resolution_reason, action_type, is_final_decision_step
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const rs of resolvedSteps) {
        insertStep.run(
          params.applicationId,
          nextCycle,
          cycleId,
          rs.stepOrder,
          rs.stepName,
          rs.stepKey || null,
          rs.stepName,
          rs.selectorType,
          rs.selectorValue,
          rs.approverUserId,
          rs.approverDisplayName,
          rs.approverPositionCode || null,
          rs.approverPositionName || null,
          rs.requiredRoleId,
          rs.approverUserId,
          rs.status,
          rs.resolutionReason || null,
          rs.actionType,
          rs.isFinalDecisionStep ? 1 : 0
        );
      }

      // 10. applications の更新: current_status は FINAL_APPROVED / TRIP_APPROVED を維持し version を進める
      db.prepare(`
        UPDATE applications
        SET updated_at = ?, version = version + 1
        WHERE id = ?
      `).run(now, params.applicationId);

      // 11. Strict Audit Log
      logAuditStrict({
        actorUserId: actor.id,
        actorUsername: actor.username,
        subjectUserId: app.subject_user_id,
        roleSnapshot: actor.roles.join(','),
        action: 'CANCEL_REQUEST',
        entityType: 'APPLICATION',
        entityId: params.applicationId,
        entityVersion: app.version + 1,
        beforeState: app.current_status,
        afterState: app.current_status,
        comment: `承認後取消起案 (Cycle: ${nextCycle}, 理由: ${params.cancellationReason})`,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
        metadata: {
          approvalCycle: nextCycle,
          cyclePurpose: 'CANCELLATION',
          policyVersionId: resolvedPolicy.policyVersionId,
          cancellationReason: params.cancellationReason,
        },
      });

      return {
        approvalCycle: nextCycle,
        cycleId,
        newVersion: app.version + 1,
        subjectUserId: app.subject_user_id,
      };
    });

    try {
      const res = runTx();
      return {
        success: true,
        statusCode: 201,
        message: '承認後取消を起案しました（取消承認フローが開始されました）',
        data: res,
      };
    } catch (err: any) {
      if (err.action) {
        logAudit({
          actorUserId: actor.id,
          actorUsername: actor.username,
          roleSnapshot: actor.roles.join(','),
          action: err.action,
          entityType: 'APPLICATION',
          entityId: params.applicationId,
          comment: err.message,
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
          isSuccess: false,
        });
      }
      return { success: false, statusCode: err.statusCode || 500, message: err.message, errorCode: err.errorCode };
    }
  }

  /**
   * 承認後取消のステップ承認 (Approve Cancellation)
   */
  static approveCancellation(
    actor: UserContext,
    params: {
      applicationId: number;
      expectedVersion: number;
      comment?: string;
    }
  ): WorkflowResult {
    const db = getDb();
    const now = getServerIsoString();

    const runTx = db.transaction(() => {
      const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(params.applicationId) as any;
      if (!app) {
        throw { statusCode: 404, message: '対象の申請が存在しません' };
      }

      // 1. Version Check
      if (app.version !== params.expectedVersion) {
        throw { statusCode: 409, errorCode: 'CONFLICT_DETECTED', message: '他のユーザーまたは別タブによって更新されました', action: 'CONFLICT_DETECTED' };
      }

      // 2. 進行中 CANCELLATION Cycle の取得
      const activeCancelCycle = db.prepare(`
        SELECT * FROM application_workflow_cycles
        WHERE application_id = ? AND cycle_purpose = 'CANCELLATION' AND status = 'IN_PROGRESS'
      `).get(params.applicationId) as any;

      if (!activeCancelCycle) {
        throw { statusCode: 400, message: '現在処理可能な取消ワークフローが存在しません' };
      }

      // 3. 処理対象ステップの取得 (status = 'PENDING')
      const currentStep = db.prepare(`
        SELECT * FROM application_approval_steps
        WHERE application_id = ? AND approval_cycle = ? AND status = 'PENDING'
        ORDER BY step_order ASC
        LIMIT 1
      `).get(params.applicationId, activeCancelCycle.approval_cycle) as any;

      if (!currentStep) {
        throw { statusCode: 400, message: '現在処理可能な取消承認ステップが存在しません' };
      }

      // 4. 認可判定 (Production Authorization Canonical Resolver SSOT)
      const authDecision = evaluateApproverAuthorization(
        actor,
        { subject_user_id: app.subject_user_id, submitted_by_user_id: app.submitted_by_user_id },
        { cycle_purpose: 'CANCELLATION', started_by_user_id: activeCancelCycle.started_by_user_id },
        currentStep
      );

      if (!authDecision.allowed) {
        throw {
          statusCode: authDecision.statusCode || 403,
          errorCode: authDecision.errorCode,
          action: authDecision.action,
          message: authDecision.message || 'このステップの承認権限がありません',
        };
      }

      // 6. 印影情報取得
      const approverUser = db.prepare('SELECT stamp_name, display_name FROM users WHERE id = ?').get(actor.id) as any;
      const stampName = approverUser?.stamp_name || actor.displayName.slice(0, 4);
      const displayName = approverUser?.display_name || actor.displayName;

      // 7. ステップを APPROVED に更新
      db.prepare(`
        UPDATE application_approval_steps
        SET status = 'APPROVED', action_by_user_id = ?, comment = ?, acted_at = ?,
            action_user_display_name = ?, action_user_stamp_name = ?, action_user_role_name = ?
        WHERE id = ?
      `).run(actor.id, params.comment || '承認', now, displayName, stampName, currentStep.required_role_id, currentStep.id);

      // 8. 次ステップ探索 (SKIPPED を安全に跨ぎ、次の WAITING ステップを探索)
      const nextStep = db.prepare(`
        SELECT * FROM application_approval_steps
        WHERE application_id = ? AND approval_cycle = ? AND step_order > ? AND status = 'WAITING'
        ORDER BY step_order ASC
        LIMIT 1
      `).get(params.applicationId, activeCancelCycle.approval_cycle, currentStep.step_order) as any;

      let isFinalCancellationApproval = false;

      if (nextStep) {
        db.prepare("UPDATE application_approval_steps SET status = 'PENDING' WHERE id = ?").run(nextStep.id);
      } else {
        // ★ 最終決裁完了 (Final Cancellation Approval)
        isFinalCancellationApproval = true;

        // TOCTOU 月次確定ロック再検証
        const formData = JSON.parse(app.form_data || '{}');
        const targetDate = formData.startDate || formData.targetDate || formData.startAt?.split('T')?.[0];
        if (isMonthlyLocked(app.subject_user_id, targetDate)) {
          throw {
            statusCode: 423,
            errorCode: 'MONTHLY_LOCKED',
            message: `${targetDate ? targetDate.substring(0, 7) : ''} の出勤簿は校長により月次確定（ロック）されているため取消決裁できません`,
            action: 'MONTHLY_LOCKED_CANCELLATION',
          };
        }

        // Cycle を APPROVED に更新
        db.prepare(`
          UPDATE application_workflow_cycles
          SET status = 'APPROVED', ended_at = ?
          WHERE id = ?
        `).run(now, activeCancelCycle.id);

        // Application を CANCELLED に更新 (Atomic Reversal)
        db.prepare(`
          UPDATE applications
          SET current_status = 'CANCELLED', updated_at = ?, version = version + 1
          WHERE id = ?
        `).run(now, params.applicationId);

        // 年次有給休暇の台帳原状復帰 (Reconciliation)
        if (app.type_id === 'LEAVE_ANNUAL') {
          const { AnnualLeaveService } = require('../services/annualLeaveService');
          AnnualLeaveService.reconcileLeaveLedgerOnCancellation({
            applicationId: params.applicationId,
            userId: app.subject_user_id,
            cancellationCycleId: activeCancelCycle.id,
            reason: activeCancelCycle.cancellation_reason || '承認後取消決裁完了',
          });
        }

        // 出張 (BUSINESS_TRIP) の参加状態更新
        if (app.type_id === 'BUSINESS_TRIP') {
          db.prepare(`
            UPDATE trip_event_members
            SET participation_status = 'CANCELLED'
            WHERE application_id = ?
          `).run(params.applicationId);
        }
      }

      if (!isFinalCancellationApproval) {
        db.prepare(`
          UPDATE applications
          SET updated_at = ?, version = version + 1
          WHERE id = ?
        `).run(now, params.applicationId);
      }

      // Strict Audit Log
      logAuditStrict({
        actorUserId: actor.id,
        actorUsername: actor.username,
        subjectUserId: app.subject_user_id,
        roleSnapshot: actor.roles.join(','),
        action: isFinalCancellationApproval ? 'CANCEL_FINAL_APPROVE' : 'CANCEL_APPROVE',
        entityType: 'APPLICATION',
        entityId: params.applicationId,
        entityVersion: app.version + 1,
        beforeState: app.current_status,
        afterState: isFinalCancellationApproval ? 'CANCELLED' : app.current_status,
        comment: `取消承認 [${currentStep.step_name}] (印影氏名: ${stampName}, コメント: ${params.comment || '承認'})`,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
        metadata: {
          stepName: currentStep.step_name,
          stampName,
          isFinalCancellationApproval,
          approvalCycle: activeCancelCycle.approval_cycle,
        },
      });

      return {
        stepName: currentStep.step_name,
        isFinalCancellationApproval,
        stampName,
        afterStatus: isFinalCancellationApproval ? 'CANCELLED' : app.current_status,
      };
    });

    try {
      const res = runTx();
      return {
        success: true,
        statusCode: 200,
        message: res.isFinalCancellationApproval
          ? '取消決裁が完了し、申請が正式に取り消されました'
          : `取消承認「${res.stepName}」を完了しました`,
        data: res,
      };
    } catch (err: any) {
      if (err.action) {
        logAudit({
          actorUserId: actor.id,
          actorUsername: actor.username,
          roleSnapshot: actor.roles.join(','),
          action: err.action,
          entityType: 'APPLICATION',
          entityId: params.applicationId,
          comment: err.message,
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
          isSuccess: false,
        });
      }
      return { success: false, statusCode: err.statusCode || 500, message: err.message, errorCode: err.errorCode };
    }
  }

  /**
   * 承認後取消の却下 (Reject Cancellation)
   */
  static rejectCancellation(
    actor: UserContext,
    params: {
      applicationId: number;
      expectedVersion: number;
      comment: string;
    }
  ): WorkflowResult {
    if (!params.comment || params.comment.trim() === '') {
      return { success: false, statusCode: 400, message: '却下理由の入力は必須です' };
    }

    const db = getDb();
    const now = getServerIsoString();

    const runTx = db.transaction(() => {
      const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(params.applicationId) as any;
      if (!app) {
        throw { statusCode: 404, message: '対象の申請が存在しません' };
      }
      if (app.version !== params.expectedVersion) {
        throw { statusCode: 409, errorCode: 'CONFLICT_DETECTED', message: '他のユーザーによって更新されました', action: 'CONFLICT_DETECTED' };
      }

      const activeCancelCycle = db.prepare(`
        SELECT * FROM application_workflow_cycles
        WHERE application_id = ? AND cycle_purpose = 'CANCELLATION' AND status = 'IN_PROGRESS'
      `).get(params.applicationId) as any;

      if (!activeCancelCycle) {
        throw { statusCode: 400, message: '現在処理可能な取消ワークフローが存在しません' };
      }

      const currentStep = db.prepare(`
        SELECT * FROM application_approval_steps
        WHERE application_id = ? AND approval_cycle = ? AND status = 'PENDING'
        ORDER BY step_order ASC
        LIMIT 1
      `).get(params.applicationId, activeCancelCycle.approval_cycle) as any;

      if (!currentStep) {
        throw { statusCode: 400, message: '現在処理可能な取消承認ステップが存在しません' };
      }

      // ACK Non-Discretionary Guard (INV-SEM-04 / W3-02)
      if (currentStep.action_type === 'ACK') {
        throw {
          statusCode: 422,
          errorCode: 'INVALID_ACTION_FOR_ACK',
          action: 'INVALID_ACTION_FOR_ACK',
          message: '受領確認（ACK）ステップに対して取消不同意（REJECT）を行うことはできません。',
        };
      }

      // Intermediate REVIEW / Non-DECIDE Guard (INV-01, INV-03, INV-04)
      if (currentStep.action_type !== 'DECIDE') {
        throw {
          statusCode: 422,
          errorCode: 'INVALID_ACTION_FOR_REVIEW',
          action: 'INVALID_ACTION_FOR_REVIEW',
          message: '中間審査ステップに対して取消不同意を行うことはできません（DECLINE_CANCELLATIONは終端決裁ステップ専属の権能です）。',
        };
      }

      // Final Decision Step Guard (INV-02)
      if (!currentStep.is_final_decision_step) {
        throw {
          statusCode: 422,
          errorCode: 'NOT_FINAL_DECISION_STEP',
          action: 'NOT_FINAL_DECISION_STEP',
          message: '最終決裁ステップ以外のステップで取消不同意（REJECT）を行うことはできません。',
        };
      }

      // 権限判定
      const expectedApproverId = currentStep.approver_user_id_snapshot || currentStep.assigned_user_id;
      if (expectedApproverId && expectedApproverId !== actor.id) {
        throw { statusCode: 403, message: '却下を行う権限がありません', action: 'FORBIDDEN_REJECT_ROLE' };
      } else if (!expectedApproverId && !actor.roles.includes(currentStep.required_role_id)) {
        throw { statusCode: 403, message: '却下を行う権限がありません', action: 'FORBIDDEN_REJECT_ROLE' };
      }

      // ステップを REJECTED に更新
      db.prepare(`
        UPDATE application_approval_steps
        SET status = 'REJECTED', action_by_user_id = ?, comment = ?, acted_at = ?
        WHERE id = ?
      `).run(actor.id, params.comment, now, currentStep.id);

      // Cycle を REJECTED に更新
      db.prepare(`
        UPDATE application_workflow_cycles
        SET status = 'REJECTED', ended_at = ?
        WHERE id = ?
      `).run(now, activeCancelCycle.id);

      // applications: current_status は FINAL_APPROVED / TRIP_APPROVED を維持
      db.prepare(`
        UPDATE applications
        SET updated_at = ?, version = version + 1
        WHERE id = ?
      `).run(now, params.applicationId);

      // Strict Audit Log
      logAuditStrict({
        actorUserId: actor.id,
        actorUsername: actor.username,
        subjectUserId: app.subject_user_id,
        roleSnapshot: actor.roles.join(','),
        action: 'CANCEL_REJECT',
        entityType: 'APPLICATION',
        entityId: params.applicationId,
        entityVersion: app.version + 1,
        beforeState: app.current_status,
        afterState: app.current_status,
        comment: `取消却下 (理由: ${params.comment})`,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
        metadata: {
          approvalCycle: activeCancelCycle.approval_cycle,
          rejectReason: params.comment,
          canonicalBusinessAction: 'DECLINE_CANCELLATION',
          enginePrimitive: 'REJECT',
        },
      });

      return { approvalCycle: activeCancelCycle.approval_cycle };
    });

    try {
      const res = runTx();
      return { success: true, statusCode: 200, message: '取消申請を却下しました（申請は有効な承認状態を継続します）', data: res };
    } catch (err: any) {
      if (err.action) {
        logAudit({
          actorUserId: actor.id,
          actorUsername: actor.username,
          roleSnapshot: actor.roles.join(','),
          action: err.action,
          entityType: 'APPLICATION',
          entityId: params.applicationId,
          comment: err.message,
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
          isSuccess: false,
        });
      }
      return { success: false, statusCode: err.statusCode || 500, message: err.message, errorCode: err.errorCode };
    }
  }

  /**
   * 承認後取消の差戻し (Return Cancellation)
   */
  static returnCancellation(
    actor: UserContext,
    params: {
      applicationId: number;
      expectedVersion: number;
      comment: string;
    }
  ): WorkflowResult {
    if (!params.comment || params.comment.trim() === '') {
      return { success: false, statusCode: 400, message: '差戻し理由の入力は必須です' };
    }

    const db = getDb();
    const now = getServerIsoString();

    const runTx = db.transaction(() => {
      const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(params.applicationId) as any;
      if (!app) {
        throw { statusCode: 404, message: '対象の申請が存在しません' };
      }
      if (app.version !== params.expectedVersion) {
        throw { statusCode: 409, errorCode: 'CONFLICT_DETECTED', message: '他のユーザーによって更新されました', action: 'CONFLICT_DETECTED' };
      }

      const activeCancelCycle = db.prepare(`
        SELECT * FROM application_workflow_cycles
        WHERE application_id = ? AND cycle_purpose = 'CANCELLATION' AND status = 'IN_PROGRESS'
      `).get(params.applicationId) as any;

      if (!activeCancelCycle) {
        throw { statusCode: 400, message: '現在処理可能な取消ワークフローが存在しません' };
      }

      const currentStep = db.prepare(`
        SELECT * FROM application_approval_steps
        WHERE application_id = ? AND approval_cycle = ? AND status = 'PENDING'
        ORDER BY step_order ASC
        LIMIT 1
      `).get(params.applicationId, activeCancelCycle.approval_cycle) as any;

      if (!currentStep) {
        throw { statusCode: 400, message: '現在処理可能な取消承認ステップが存在しません' };
      }

      // 権限判定
      const expectedApproverId = currentStep.approver_user_id_snapshot || currentStep.assigned_user_id;
      if (expectedApproverId && expectedApproverId !== actor.id) {
        throw { statusCode: 403, message: '差戻しを行う権限がありません', action: 'FORBIDDEN_RETURN_ROLE' };
      } else if (!expectedApproverId && !actor.roles.includes(currentStep.required_role_id)) {
        throw { statusCode: 403, message: '差戻しを行う権限がありません', action: 'FORBIDDEN_RETURN_ROLE' };
      }

      // ステップを RETURNED に更新
      db.prepare(`
        UPDATE application_approval_steps
        SET status = 'RETURNED', action_by_user_id = ?, comment = ?, acted_at = ?
        WHERE id = ?
      `).run(actor.id, params.comment, now, currentStep.id);

      // Cycle を RETURNED に更新
      db.prepare(`
        UPDATE application_workflow_cycles
        SET status = 'RETURNED', return_reason = ?, ended_at = ?
        WHERE id = ?
      `).run(params.comment, now, activeCancelCycle.id);

      // applications: current_status は FINAL_APPROVED / TRIP_APPROVED を維持
      db.prepare(`
        UPDATE applications
        SET updated_at = ?, version = version + 1
        WHERE id = ?
      `).run(now, params.applicationId);

      // Strict Audit Log
      logAuditStrict({
        actorUserId: actor.id,
        actorUsername: actor.username,
        subjectUserId: app.subject_user_id,
        roleSnapshot: actor.roles.join(','),
        action: 'CANCEL_RETURN',
        entityType: 'APPLICATION',
        entityId: params.applicationId,
        entityVersion: app.version + 1,
        beforeState: app.current_status,
        afterState: app.current_status,
        comment: `取消差戻し (理由: ${params.comment})`,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
        metadata: {
          approvalCycle: activeCancelCycle.approval_cycle,
          returnReason: params.comment,
        },
      });

      return { approvalCycle: activeCancelCycle.approval_cycle };
    });

    try {
      const res = runTx();
      return { success: true, statusCode: 200, message: '取消申請を差戻しました', data: res };
    } catch (err: any) {
      if (err.action) {
        logAudit({
          actorUserId: actor.id,
          actorUsername: actor.username,
          roleSnapshot: actor.roles.join(','),
          action: err.action,
          entityType: 'APPLICATION',
          entityId: params.applicationId,
          comment: err.message,
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
          isSuccess: false,
        });
      }
      return { success: false, statusCode: err.statusCode || 500, message: err.message, errorCode: err.errorCode };
    }
  }

  /**
   * 承認後取消の差戻し後再申請（Resubmit Cancellation）
   * Option B (新Cycle生成方式) ＆ Strict Server-Authoritative 認可
   */
  static resubmitCancellation(
    actor: UserContext,
    params: {
      applicationId: number;
      expectedVersion: number;
      cancellationReason: string;
    }
  ): WorkflowResult {
    // 0. Payload 検証
    if (!params.cancellationReason || typeof params.cancellationReason !== 'string' || params.cancellationReason.trim() === '') {
      return {
        success: false,
        statusCode: 400,
        errorCode: 'CANCELLATION_REASON_REQUIRED',
        message: '取消理由の入力は必須です',
      };
    }

    const trimmedReason = params.cancellationReason.trim();
    const db = getDb();
    const now = getServerIsoString();

    const runTx = db.transaction(() => {
      // 1. Application 取得 ＆ 存在確認
      const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(params.applicationId) as any;
      if (!app) {
        throw { statusCode: 404, message: '対象の申請が存在しません' };
      }

      // 2. 楽観的排他制御 (Optimistic Lock)
      if (params.expectedVersion === undefined || params.expectedVersion === null || app.version !== params.expectedVersion) {
        throw {
          statusCode: 409,
          errorCode: 'CONFLICT_DETECTED',
          message: '他のユーザーまたは別タブによって更新されました',
          action: 'CONFLICT_DETECTED',
        };
      }

      // 3. 最新 Cancellation Cycle 取得 ＆ 検証
      const latestCancelCycle = db.prepare(`
        SELECT * FROM application_workflow_cycles
        WHERE application_id = ? AND cycle_purpose = 'CANCELLATION'
        ORDER BY approval_cycle DESC
        LIMIT 1
      `).get(params.applicationId) as any;

      if (!latestCancelCycle) {
        throw {
          statusCode: 400,
          errorCode: 'INVALID_CYCLE_PURPOSE',
          message: '取消ワークフローが存在しません',
        };
      }

      if (latestCancelCycle.status !== 'RETURNED') {
        throw {
          statusCode: 400,
          errorCode: 'INVALID_STATUS_FOR_RESUBMIT',
          message: `差戻し（RETURNED）状態の取消申請のみ再提出可能です (現在の状態: ${latestCancelCycle.status})`,
        };
      }

      // 4. Action Owner SSOT 認可検証 (started_by_user_id)
      if (!latestCancelCycle.started_by_user_id || latestCancelCycle.started_by_user_id !== actor.id) {
        throw {
          statusCode: 403,
          errorCode: 'FORBIDDEN_CANCELLATION_RESUBMIT',
          message: '取消申請の再提出は取消起案者本人のみ実行可能です',
          action: 'FORBIDDEN_CANCELLATION_RESUBMIT',
        };
      }

      // 5. TOCTOU 月次確定ロック検証 (HTTP 423)
      const formData = JSON.parse(app.form_data || '{}');
      const targetDate = formData.startDate || formData.targetDate || formData.startAt?.split('T')?.[0];
      if (isMonthlyLocked(app.subject_user_id, targetDate)) {
        throw {
          statusCode: 423,
          errorCode: 'MONTHLY_LOCKED',
          message: `${targetDate ? targetDate.substring(0, 7) : ''} の出勤簿は校長により月次確定（ロック）されているため再提出できません`,
          action: 'MONTHLY_LOCKED_RESUBMIT',
        };
      }

      // 6. 最新 Cancellation Policy 再解決 ＆ 自己衝突解決 (HD-01〜03, INV-SC, INV-FA)
      const { resolveWorkflowPolicy } = require('./policyResolver');
      const resolvedPolicy = resolveWorkflowPolicy({
        appTypeId: app.type_id,
        evaluationTime: now,
        subjectUserId: app.subject_user_id,
        submittedByUserId: actor.id,
        policyPurpose: 'CANCELLATION',
      });

      const resolvedSteps = resolveAndValidateWorkflowSteps(app.subject_user_id, resolvedPolicy.steps);

      // 7. 新 ApprovalCycle 番号算出 (maxCycle + 1)
      const maxCycleRow = db.prepare('SELECT COALESCE(MAX(approval_cycle), 0) as max_cycle FROM application_workflow_cycles WHERE application_id = ?').get(params.applicationId) as any;
      const nextCycle = (maxCycleRow?.max_cycle || 1) + 1;

      // 8. 新 Cycle 作成 (Option B: New Cycle INSERT)
      const insertCycle = db.prepare(`
        INSERT INTO application_workflow_cycles (
          application_id, approval_cycle, cycle_purpose, workflow_source,
          workflow_policy_version_id, policy_evaluation_at, status, cancellation_reason,
          started_at, started_by_user_id
        ) VALUES (?, ?, 'CANCELLATION', 'NEW_POLICY_ENGINE', ?, ?, 'IN_PROGRESS', ?, ?, ?)
      `);

      const cycleRes = insertCycle.run(
        params.applicationId,
        nextCycle,
        resolvedPolicy.policyVersionId,
        now,
        trimmedReason,
        now,
        actor.id
      );
      const cycleId = Number(cycleRes.lastInsertRowid);

      // Policy Version 参照実績更新
      db.prepare('UPDATE workflow_policy_versions SET is_used = 1 WHERE id = ?').run(resolvedPolicy.policyVersionId);

      // 9. 承認ステップ Snapshot 作成
      const insertStep = db.prepare(`
        INSERT INTO application_approval_steps (
          application_id, approval_cycle, workflow_cycle_id, step_order, step_name, step_key, step_label_snapshot,
          selector_type_snapshot, selector_value_snapshot, approver_user_id_snapshot,
          approver_name_snapshot, approver_position_code_snapshot, approver_position_name_snapshot,
          required_role_id, assigned_user_id, status, resolution_reason, action_type, is_final_decision_step
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const rs of resolvedSteps) {
        insertStep.run(
          params.applicationId,
          nextCycle,
          cycleId,
          rs.stepOrder,
          rs.stepName,
          rs.stepKey || null,
          rs.stepName,
          rs.selectorType,
          rs.selectorValue,
          rs.approverUserId,
          rs.approverDisplayName,
          rs.approverPositionCode || null,
          rs.approverPositionName || null,
          rs.requiredRoleId,
          rs.approverUserId,
          rs.status,
          rs.resolutionReason || null,
          rs.actionType,
          rs.isFinalDecisionStep ? 1 : 0
        );
      }

      // 10. applications の更新: current_status は FINAL_APPROVED / TRIP_APPROVED を維持し version をインクリメント
      db.prepare(`
        UPDATE applications
        SET updated_at = ?, version = version + 1
        WHERE id = ?
      `).run(now, params.applicationId);

      // 11. Strict Audit Log 記録 (Data Minimization 原則準拠)
      logAuditStrict({
        actorUserId: actor.id,
        actorUsername: actor.username,
        subjectUserId: app.subject_user_id,
        roleSnapshot: actor.roles.join(','),
        action: 'CANCEL_RESUBMIT',
        entityType: 'APPLICATION',
        entityId: params.applicationId,
        entityVersion: app.version + 1,
        beforeState: app.current_status,
        afterState: app.current_status,
        comment: `承認後取消の再提出 (Cycle: ${latestCancelCycle.approval_cycle} -> ${nextCycle}, Version: v${app.version} -> v${app.version + 1})`,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
        metadata: {
          applicationId: params.applicationId,
          previousCycle: latestCancelCycle.approval_cycle,
          newCycle: nextCycle,
          previousVersion: app.version,
          newVersion: app.version + 1,
          policyVersionId: resolvedPolicy.policyVersionId,
        },
      });

      return {
        applicationId: params.applicationId,
        approvalCycle: nextCycle,
        newVersion: app.version + 1,
      };
    });

    try {
      const res = runTx();
      return {
        success: true,
        statusCode: 200,
        message: '取消申請を修正して再提出しました（取消承認フローが再開されました）',
        data: res,
      };
    } catch (err: any) {
      if (err.action) {
        logAudit({
          actorUserId: actor.id,
          actorUsername: actor.username,
          roleSnapshot: actor.roles.join(','),
          action: err.action,
          entityType: 'APPLICATION',
          entityId: params.applicationId,
          comment: err.message,
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
          isSuccess: false,
        });
      }
      return { success: false, statusCode: err.statusCode || 500, message: err.message, errorCode: err.errorCode };
    }
  }

}
