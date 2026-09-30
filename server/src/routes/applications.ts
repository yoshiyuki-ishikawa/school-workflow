import { Router, Request, Response } from 'express';
import { getDb } from '../db/database';
import { requireAuth, getUserContext, checkUserPermission } from '../middlewares/auth';
import { WorkflowEngine, evaluateApproverAuthorization } from '../workflow/engine';
import { getUserLeaveSummary, calculateTimeLeaveMinutes, WORK_DAY_MINUTES } from '../utils/leaveCalculator';
import { CareLeaveService } from '../services/careLeaveService';
import { AnnualLeaveService } from '../services/annualLeaveService';
import { ApplicationWorkflowService } from '../services/applicationWorkflowService';
import { logAudit } from '../utils/auditLogger';
import { getServerIsoString } from '../utils/serverTime';
import { FormValidationEngine } from '../services/schema/formValidationEngine';
import { ApplicationEligibilityResolver } from '../services/applicationEligibilityResolver';

const router = Router();
router.use(requireAuth);

/**
 * 承認待ち申請件数取得 (GAP-08: Pending Count API)
 * 必ず /:id より前に定義して Route Hijacking を防止
 */
router.get('/pending/count', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  try {
    const pending_count = ApplicationWorkflowService.getPendingTaskCount(user);
    res.json({
      success: true,
      data: {
        pending_count,
      },
    });
  } catch (err: any) {
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({
      success: false,
      error: err.code || 'INTERNAL_ERROR',
      message: err.message,
    });
  }
});

/**
 * 承認待ち申請タスク一覧取得 (GAP-08: Pending Task List API)
 * 必ず /:id より前に定義して Route Hijacking を防止
 */
router.get('/pending/tasks', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
  const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;

  try {
    const tasks = ApplicationWorkflowService.getPendingApplicationsForUser(user, { limit, offset });
    res.json({
      success: true,
      data: {
        total_count: tasks.length,
        tasks,
      },
    });
  } catch (err: any) {
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({
      success: false,
      error: err.code || 'INTERNAL_ERROR',
      message: err.message,
    });
  }
});

/**
 * 申請種別マスタ一覧取得 (Server-Authoritative with Category Metadata & Capability Filtering)
 */
router.get('/types', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const db = getDb();
  const dbUser = db.prepare('SELECT is_active FROM users WHERE id = ?').get(user.id) as { is_active: number } | undefined;
  const isActive = dbUser ? dbUser.is_active === 1 : true;

  const types = ApplicationEligibilityResolver.resolveSelectableTypes({
    id: user.id,
    username: user.username,
    roles: user.roles,
    isActive,
  });

  res.json({ success: true, types });
});

/**
 * 制度ルール一覧・ポリシー設定取得
 */
router.get('/policy-rules', (req: Request, res: Response): void => {
  const db = getDb();
  const rules = db.prepare('SELECT * FROM policy_rules WHERE is_active = 1 ORDER BY id ASC').all() as any[];
  const formatted = rules.map(r => ({
    ...r,
    rule_definition: (() => {
      try { return JSON.parse(r.rule_definition_json || '{}'); } catch { return {}; }
    })()
  }));
  res.json({ success: true, policyRules: formatted });
});

/**
 * 特別休暇ポリシー一覧取得 (Client動的制御用)
 */
router.get('/special-leave-policies', (req: Request, res: Response): void => {
  const db = getDb();
  const rules = db.prepare("SELECT * FROM policy_rules WHERE policy_code LIKE 'SPECIAL_%' AND is_active = 1 ORDER BY id ASC").all() as any[];
  const formatted = rules.map(r => {
    let def: any = {};
    try { def = JSON.parse(r.rule_definition_json || '{}'); } catch {}
    return {
      reasonCode: r.policy_code,
      name: r.official_name,
      displaySymbol: r.display_code,
      allowedDurationUnits: def.allowedDurationUnits || ['DAY'],
      status: def.status || 'ACTIVE',
      legalBasis: def.legalBasis,
      effectiveFrom: r.effective_from,
      effectiveTo: r.effective_to,
      version: r.version
    };
  });
  res.json({ success: true, policies: formatted });
});

/**
 * ログイン中教職員（または指定教職員）の休暇等累計・年休残数サマリー取得 (第9号様式)
 */
router.get('/leave-summary', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const targetUserId = req.query.userId ? parseInt(req.query.userId as string, 10) : user.id;

  if (targetUserId !== user.id && !user.roles.some((r) => ['ADMIN', 'VICE_PRINCIPAL', 'PRINCIPAL', 'OFFICE'].includes(r))) {
    res.status(403).json({ success: false, message: '他人の休暇累計を閲覧する権限がありません' });
    return;
  }

  const summary = getUserLeaveSummary(targetUserId);
  res.json({ success: true, summary });
});

/**
 * 申請一覧取得 (フィルタ: scope = 'my' | 'pending_approval' | 'all')
 */
router.get('/', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const scope = (req.query.scope as string) || 'my';
  const db = getDb();

  let query = `
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
  `;

  const params: any[] = [];

  if (scope === 'my') {
    query += ` WHERE (a.subject_user_id = ? OR a.submitted_by_user_id = ?) ORDER BY a.updated_at DESC`;
    params.push(user.id, user.id);
  } else if (scope === 'pending_approval') {
    query += `
      JOIN application_approval_steps s ON a.id = s.application_id AND a.current_step_order = s.step_order AND s.status = 'PENDING'
      WHERE a.subject_user_id != ?
        AND a.submitted_by_user_id != ?
        AND (
          s.approver_user_id_snapshot = ?
          OR (s.approver_user_id_snapshot IS NULL AND (s.assigned_user_id = ? OR (s.assigned_user_id IS NULL AND s.required_role_id IN (${user.roles.map(() => '?').join(',')}))))
        )
      ORDER BY a.updated_at ASC
    `;
    params.push(user.id, user.id, user.id, user.id, ...user.roles);
  } else if (scope === 'all') {
    if (!user.roles.some((r) => ['ADMIN', 'PRINCIPAL', 'VICE_PRINCIPAL', 'OFFICE'].includes(r))) {
      res.status(403).json({ success: false, message: '全件閲覧の権限がありません' });
      return;
    }
    query += ` ORDER BY a.updated_at DESC`;
  }

  const applications = db.prepare(query).all(...params) as any[];

  const formatted = applications.map((app) => {
    // 申請ごとの最新取消サイクルと差戻しメタデータを解決 (Server-Authoritative)
    const cycles = db.prepare(`
      SELECT * FROM application_workflow_cycles
      WHERE application_id = ?
      ORDER BY approval_cycle ASC
    `).all(app.id) as any[];

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
      `).get(app.id, latestCancellationCycle.approval_cycle) as any;

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

    return {
      ...app,
      applicant_name: app.subject_user_name,
      applicant_department: app.subject_department,
      form_data: JSON.parse(app.form_data || '{}'),
      activeCancellationCycle,
      latestCancellationCycle,
      cancellationReturn,
    };
  });

  res.json({ success: true, applications: formatted });
});

/**
 * 申請詳細取得
 */
router.get('/:id', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const appId = parseInt(rawId, 10);

  const result = WorkflowEngine.getApplicationDetail(user, appId);
  if (!result.success) {
    res.status(result.statusCode).json(result);
    return;
  }

  const app = result.data.application;
  const userSummary = getUserLeaveSummary(app.subject_user_id);

  res.json({
    success: true,
    application: {
      ...app,
      applicant_name: app.subject_user_name,
      applicant_department: app.subject_department,
      form_data: JSON.parse(app.form_data || '{}'),
      steps: result.data.steps,
      activeCancellationCycle: result.data.activeCancellationCycle,
      latestCancellationCycle: result.data.latestCancellationCycle,
      cancellationReturn: result.data.cancellationReturn,
      leaveSummarySnapshot: userSummary,
    },
  });
});

/**
 * 出張イベント詳細取得
 */
router.get('/trip-events/:id', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const eventId = parseInt(rawId, 10);

  const result = WorkflowEngine.getTripEventDetail(user, eventId);
  res.status(result.statusCode).json(result);
});

/**
 * フォームデータの補正・計算 (Server-Authoritative)
 */
export function normalizeFormData(typeId: string, rawFormData: Record<string, any>, subjectUserId?: number) {
  const data = { ...rawFormData };
  const { LeaveCalculationService } = require('../services/leave/leaveCalculationService');

  if (typeId === 'LEAVE_ANNUAL') {
    const startDate = data.startDate || data.targetDate;
    const endDate = data.endDate || data.startDate || data.targetDate;

    let rawUnit: 'DAY' | 'HALF_DAY' | 'TIME' = 'DAY';
    let halfDayType = data.halfDayType;

    if (data.unitType === 'TIME' || data.unitType === 'HOURLY') {
      rawUnit = 'TIME';
      data.unitType = 'TIME';
    } else if (data.unitType === 'HALF_DAY' || data.unitType === 'HALF_DAY_AM' || data.unitType === 'HALF_DAY_PM') {
      rawUnit = 'HALF_DAY';
      if (!halfDayType) {
        halfDayType = data.unitType === 'HALF_DAY_PM' ? 'AFTERNOON' : 'MORNING';
      }
      data.unitType = 'HALF_DAY';
      data.halfDayType = halfDayType;
    } else {
      rawUnit = 'DAY';
      data.unitType = 'DAY';
    }

    if (rawUnit === 'HALF_DAY') {
      if (startDate && endDate && subjectUserId) {
        try {
          const calc = LeaveCalculationService.calculate({
            subjectUserId,
            typeId: 'LEAVE_ANNUAL',
            startDate,
            endDate,
            targetDate: startDate,
            unitType: rawUnit,
            halfDayType,
            startTime: data.startTime,
            endTime: data.endTime,
            calculatedDays: data.calculatedDays,
          });

          if (calc.isValid) {
            data.calculatedDays = calc.totalChargedDays !== undefined ? calc.totalChargedDays : 0.5;
            data.calculatedMinutes = calc.totalChargedMinutes;
          } else {
            // Fail-Closed: 計算不成立時はクライアントの数値を信用せず未定義化
            data.calculatedDays = 0.5;
            delete data.calculatedMinutes;
          }
        } catch {
          data.calculatedDays = 0.5;
          delete data.calculatedMinutes;
        }
      } else {
        data.calculatedDays = 0.5;
        delete data.calculatedMinutes;
      }
    } else if (startDate && endDate && subjectUserId) {
      try {
        const calc = LeaveCalculationService.calculate({
          subjectUserId,
          typeId: 'LEAVE_ANNUAL',
          startDate,
          endDate,
          targetDate: startDate,
          unitType: rawUnit,
          halfDayType,
          startTime: data.startTime,
          endTime: data.endTime,
          calculatedDays: data.calculatedDays,
        });

        if (calc.isValid) {
          if (calc.totalChargedDays !== undefined) {
            data.calculatedDays = calc.totalChargedDays;
          }
          if (calc.totalChargedMinutes !== undefined) {
            data.calculatedMinutes = calc.totalChargedMinutes;
          }
        }
      } catch {
        // Fail-Safe: 下書き等で計算エラーが発生した場合でも最低限の型安全性を維持
      }
    }

    // もし LeaveCalculationService による算出が未設定の場合の安全なフォールバック
    if (data.calculatedDays === undefined) {
      data.calculatedDays = rawUnit === 'DAY' ? 1 : (rawUnit === 'HALF_DAY' ? 0.5 : 0);
    }
    if (data.calculatedMinutes === undefined) {
      // HALF_DAY では未算出のまま 0 分に偽装フォールバックすることを禁止 (Fail-Closed)
      if (rawUnit !== 'HALF_DAY') {
        data.calculatedMinutes = 0;
      }
    }
  } else if (['LEAVE_SICK', 'LEAVE_SPECIAL', 'LEAVE_DUTY_EXEMPT'].includes(typeId)) {
    const rawUnit = data.unitType || 'DAY';
    const startDate = data.startDate || data.targetDate;
    const endDate = data.endDate || data.startDate || data.targetDate;

    if (startDate && subjectUserId) {
      try {
        const calc = LeaveCalculationService.calculate({
          subjectUserId,
          typeId,
          startDate,
          endDate,
          unitType: rawUnit,
          halfDayType: data.halfDayType,
          startTime: data.startTime,
          endTime: data.endTime,
          reasonCode: data.reasonCode
        });
        if (calc.isValid) {
          data.calculatedDays = calc.totalChargedDays ?? (rawUnit === 'DAY' ? 1 : rawUnit === 'HALF_DAY' ? 0.5 : 0);
          data.calculatedMinutes = calc.totalChargedMinutes ?? 0;
        } else {
          data.calculatedDays = calc.totalChargedDays ?? 0;
          data.calculatedMinutes = calc.totalChargedMinutes ?? 0;
        }
      } catch {
        // Fail-Closed: 465フォールバックは完全排除 (P0-01)
        data.calculatedDays = 0;
        data.calculatedMinutes = 0;
      }
    } else {
      data.calculatedDays = rawUnit === 'DAY' ? 1 : rawUnit === 'HALF_DAY' ? 0.5 : 0;
      data.calculatedMinutes = 0;
    }
  } else {
    if (data.unitType === 'TIME') {
      const minutes = calculateTimeLeaveMinutes(data.startTime, data.endTime);
      data.calculatedMinutes = minutes;
      data.calculatedDays = 0;
    } else if (data.unitType === 'HALF_DAY') {
      data.calculatedDays = 0.5;
      data.calculatedMinutes = Math.floor(WORK_DAY_MINUTES / 2);
    } else {
      data.unitType = 'DAY';
      data.calculatedDays = Number(data.calculatedDays) || 1;
      data.calculatedMinutes = data.calculatedDays * WORK_DAY_MINUTES;
    }
  }

  // Server-Authoritative Sanitization (GAP-S3-02): TIME単位以外では不要な時刻プロパティを完全除去
  if (data.unitType !== 'TIME') {
    delete data.startTime;
    delete data.endTime;
  }

  return data;
}

/**
 * 休暇・服務のリアルタイム計算プレビュー (Server-Authoritative / RBACガード付き)
 */
router.post('/preview-calculation', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const {
    typeId,
    targetDate,
    startDate,
    endDate,
    unitType,
    halfDayType,
    startTime,
    endTime,
    calculatedDays,
    reasonCode,
    subjectUserId: reqSubjectUserId
  } = req.body;

  let subjectUserId = user.id;

  // 代理申請モードの場合のみ subjectUserId の指定を許可 (Capability検証: HD-NAE-04)
  if (reqSubjectUserId && Number(reqSubjectUserId) !== user.id) {
    const hasProxyPerm = checkUserPermission(user.roles, 'application.create.proxy');
    if (!hasProxyPerm) {
      res.status(403).json({
        success: false,
        errorCode: 'FORBIDDEN_SUBJECT_ACCESS',
        message: '他教職員の休暇・服務計算プレビューを取得する権限がありません'
      });
      return;
    }
    subjectUserId = Number(reqSubjectUserId);
  }

  const { LeaveCalculationService } = require('../services/leave/leaveCalculationService');

  let rawUnit = unitType || 'DAY';
  if (rawUnit === 'FULL_DAY') rawUnit = 'DAY';
  if (rawUnit === 'HOURLY') rawUnit = 'TIME';

  const result = LeaveCalculationService.calculate({
    subjectUserId,
    typeId: typeId || 'LEAVE_ANNUAL',
    targetDate: targetDate || startDate || new Date().toISOString().split('T')[0],
    startDate: startDate || targetDate,
    endDate: endDate || startDate || targetDate,
    unitType: rawUnit,
    halfDayType,
    startTime,
    endTime,
    calculatedDays: Number(calculatedDays) || 1,
    reasonCode
  });

  if (!result.isValid) {
    res.status(400).json({
      success: false,
      errorCode: result.errorCode || 'CALCULATION_FAILED',
      message: result.message || '計算プレビューに失敗しました'
    });
    return;
  }

  res.json({
    success: true,
    calculation: result
  });
});

/**
 * 下書き保存
 */
router.post('/draft', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const { id, expectedVersion, typeId, title, formData, subjectUserId } = req.body;
  const targetSubId = subjectUserId ? Number(subjectUserId) : user.id;

  const isProxy = !!(subjectUserId && Number(subjectUserId) !== user.id);
  const db = getDb();
  const dbUser = db.prepare('SELECT is_active FROM users WHERE id = ?').get(user.id) as { is_active: number } | undefined;
  const isActive = dbUser ? dbUser.is_active === 1 : true;

  try {
    ApplicationEligibilityResolver.assertEligible({
      actor: {
        id: user.id,
        username: user.username,
        roles: user.roles,
        isActive,
      },
      initiationMode: isProxy ? 'PROXY' : 'SELF',
      applicationTypeId: typeId,
      subjectUserId: isProxy ? targetSubId : undefined,
    });
  } catch (err: any) {
    res.status(err.statusCode || 403).json({
      success: false,
      errorCode: err.code || 'APPLICATION_NOT_ELIGIBLE',
      message: err.message,
    });
    return;
  }

  const normalized = normalizeFormData(typeId, formData || {}, targetSubId);
  const result = WorkflowEngine.saveDraft(user, {
    id,
    expectedVersion: expectedVersion !== undefined ? Number(expectedVersion) : undefined,
    typeId,
    title,
    formData: normalized,
    subjectUserId,
  });
  res.status(result.statusCode).json(result);
});

/**
 * 介護休暇 (条例第15条) および 介護時間 (条例第16条) のServer Validation
 */
function validateCareLeaveApplication(typeId: string, formData: any, subjectUserId: number): { valid: boolean; status: number; message?: string } {
  if (typeId === 'LEAVE_CARE_TIME') {
    return CareLeaveService.validateCareTime(formData, subjectUserId);
  }
  return CareLeaveService.validateCareLeave(formData, subjectUserId);
}

/**
 * 本人提出 (SELF + SINGLE)
 */
router.post('/submit', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const { id, expectedVersion, typeId, title, formData } = req.body;
  const db = getDb();
  const dbUser = db.prepare('SELECT is_active FROM users WHERE id = ?').get(user.id) as { is_active: number } | undefined;
  const isActive = dbUser ? dbUser.is_active === 1 : true;

  try {
    ApplicationEligibilityResolver.assertEligible({
      actor: {
        id: user.id,
        username: user.username,
        roles: user.roles,
        isActive,
      },
      initiationMode: 'SELF',
      applicationTypeId: typeId,
    });
  } catch (err: any) {
    res.status(err.statusCode || 403).json({
      success: false,
      errorCode: err.code || 'APPLICATION_NOT_ELIGIBLE',
      message: err.message,
    });
    return;
  }

  const { ApplicationValidationPipeline } = require('../services/applicationValidationPipeline');
  const validation = ApplicationValidationPipeline.validate({
    typeId,
    subjectUserId: user.id,
    formData: formData || {},
    db,
  });

  if (!validation.valid) {
    res.status(validation.status).json({ success: false, message: validation.message, errorCode: validation.errorCode });
    return;
  }

  const normalized = normalizeFormData(typeId, formData || {}, user.id);
  const result = WorkflowEngine.submitApplication(user, {
    id,
    expectedVersion: expectedVersion !== undefined ? Number(expectedVersion) : undefined,
    typeId,
    title,
    formData: normalized,
  });
  res.status(result.statusCode).json(result);
});

/**
 * 代理申請提出 (PROXY + SINGLE)
 */
router.post('/proxy', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const { id, expectedVersion, typeId, subjectUserId, title, formData, proxyReason } = req.body;

  const targetSubUserId = subjectUserId ? parseInt(subjectUserId, 10) : undefined;
  const db = getDb();
  const dbUser = db.prepare('SELECT is_active FROM users WHERE id = ?').get(user.id) as { is_active: number } | undefined;
  const isActive = dbUser ? dbUser.is_active === 1 : true;

  try {
    ApplicationEligibilityResolver.assertEligible({
      actor: {
        id: user.id,
        username: user.username,
        roles: user.roles,
        isActive,
      },
      initiationMode: 'PROXY',
      applicationTypeId: typeId,
      subjectUserId: targetSubUserId,
    });
  } catch (err: any) {
    res.status(err.statusCode || 403).json({
      success: false,
      errorCode: err.code || 'APPLICATION_NOT_ELIGIBLE',
      message: err.message,
    });
    return;
  }

  const { ApplicationValidationPipeline } = require('../services/applicationValidationPipeline');
  const validation = ApplicationValidationPipeline.validate({
    typeId,
    subjectUserId: targetSubUserId!,
    formData: formData || {},
    db,
  });

  if (!validation.valid) {
    res.status(validation.status).json({ success: false, message: validation.message, errorCode: validation.errorCode });
    return;
  }

  const normalized = normalizeFormData(typeId, formData || {}, targetSubUserId!);
  const result = WorkflowEngine.submitProxyApplication(user, {
    id,
    expectedVersion: expectedVersion !== undefined ? Number(expectedVersion) : undefined,
    typeId,
    subjectUserId: targetSubUserId!,
    title,
    formData: normalized,
    proxyReason,
  });
  res.status(result.statusCode).json(result);
});

/**
 * 復命書提出
 */
router.post('/:id/report', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const appId = parseInt(rawId, 10);
  const {
    expectedVersion,
    reportDate,
    reportResult,
    reportRemarks,
    actualMatchesPlan,
    actualDeparturePlace,
    actualArrivalPlace,
    actualTransportMode,
    vehicleUsageType,
    actualDistanceKm,
    communicationCostBorne,
    actualTripStartAt,
    actualTripEndAt,
    travelExpenseRemarks,
  } = req.body;

  const result = WorkflowEngine.submitReport(user, {
    applicationId: appId,
    expectedVersion,
    reportDate,
    reportResult,
    reportRemarks,
    actualMatchesPlan,
    actualDeparturePlace,
    actualArrivalPlace,
    actualTransportMode,
    vehicleUsageType,
    actualDistanceKm,
    communicationCostBorne,
    actualTripStartAt,
    actualTripEndAt,
    travelExpenseRemarks,
  });

  res.status(result.statusCode).json(result);
});

/**
 * 授業引継ぎ・代替措置 解決・確定API (GAP-09: Coverage Resolution API)
 * Active Cycle における承認権限者による中間確定および差戻し不要の柔軟な更新
 */
router.patch('/:id/coverage', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const appId = parseInt(rawId, 10);
  const { expectedVersion, coverageStatus, notRequiredReason, coverageItems } = req.body;

  if (expectedVersion === undefined || expectedVersion === null) {
    res.status(400).json({ success: false, errorCode: 'VERSION_REQUIRED', message: '楽観ロック用の expectedVersion は必須です' });
    return;
  }

  const db = getDb();
  const now = getServerIsoString();

  try {
    const txResult = db.transaction(() => {
      const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
      if (!app) {
        throw { statusCode: 404, message: '対象の申請が存在しません' };
      }

      if (app.version !== expectedVersion) {
        throw { statusCode: 409, errorCode: 'CONFLICT_DETECTED', message: '他のユーザーによって更新されました' };
      }

      // 申請状態の検証 (進行中かつ未確定・未却下・未取下げのみ)
      const nonModifiableStatuses = ['DRAFT', 'FINAL_APPROVED', 'REJECTED', 'WITHDRAWN', 'CANCELLED'];
      if (nonModifiableStatuses.includes(app.current_status)) {
        throw { statusCode: 400, errorCode: 'INVALID_STATUS', message: `現在の状態（${app.current_status}）では授業措置を更新できません` };
      }

      // Active Approval Cycle & Step の取得
      const currentStep = db.prepare(`
        SELECT * FROM application_approval_steps
        WHERE application_id = ? AND step_order = ?
        ORDER BY approval_cycle DESC
        LIMIT 1
      `).get(appId, app.current_step_order) as any;

      if (!currentStep || currentStep.status !== 'PENDING') {
        throw { statusCode: 400, errorCode: 'NO_ACTIVE_STEP', message: '現在処理可能な承認ステップが存在しません' };
      }

      // 認可判定 (Canonical Evaluator)
      const authDecision = evaluateApproverAuthorization(
        user,
        { subject_user_id: app.subject_user_id, submitted_by_user_id: app.submitted_by_user_id },
        { cycle_purpose: 'APPROVAL', started_by_user_id: app.submitted_by_user_id },
        currentStep
      );

      if (!authDecision.allowed) {
        throw {
          statusCode: authDecision.statusCode || 403,
          errorCode: authDecision.errorCode,
          message: authDecision.message || 'この申請の授業引継ぎ措置を更新・解決する権限がありません'
        };
      }

      // 既存 formData から スナップショット取得
      const currentFormData = JSON.parse(app.form_data || '{}');
      const schemaSnapshot = currentFormData.schemaSnapshot;

      // 差分ペイロードでバリデーション実行
      const payloadToValidate = {
        ...currentFormData,
        coverageStatus,
        notRequiredReason,
        coverageItems
      };

      const validation = FormValidationEngine.validate({
        typeId: app.type_id,
        rawValues: payloadToValidate,
        schemaSnapshot,
        targetDate: currentFormData.targetDate || currentFormData.startDate,
        isDraft: false
      });

      if (!validation.valid) {
        throw {
          statusCode: validation.status || 422,
          errorCode: validation.errorCode,
          message: validation.message
        };
      }

      const updatedFormData = {
        ...currentFormData,
        coverageStatus: validation.sanitizedValues?.coverageStatus,
        notRequiredReason: validation.sanitizedValues?.notRequiredReason,
        coverageItems: validation.sanitizedValues?.coverageItems || []
      };

      // Atomic CAS UPDATE (409 Conflict Guard)
      const updateRes = db.prepare(`
        UPDATE applications
        SET form_data = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND version = ?
      `).run(JSON.stringify(updatedFormData), now, appId, expectedVersion);

      if (updateRes.changes === 0) {
        throw { statusCode: 409, errorCode: 'CONFLICT_DETECTED', message: '排他制御競合が発生しました（他のユーザーによって更新されました）' };
      }

      return {
        newVersion: expectedVersion + 1,
        coverageData: {
          coverageStatus: updatedFormData.coverageStatus,
          notRequiredReason: updatedFormData.notRequiredReason,
          coverageItems: updatedFormData.coverageItems
        },
        subjectUserId: app.subject_user_id
      };
    })();

    logAudit({
      actorUserId: user.id,
      actorUsername: user.username,
      subjectUserId: txResult.subjectUserId,
      roleSnapshot: user.roles.join(','),
      action: 'RESOLVE_CLASS_COVERAGE',
      entityType: 'APPLICATION',
      entityId: appId,
      entityVersion: txResult.newVersion,
      comment: `授業引継ぎ・代替措置解決 (ステータス: ${txResult.coverageData.coverageStatus})`,
      ipAddress: (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '127.0.0.1',
      userAgent: req.headers['user-agent']
    });

    res.json({
      success: true,
      message: '授業引継ぎ措置を更新・確定しました',
      data: {
        applicationId: appId,
        version: txResult.newVersion,
        ...txResult.coverageData
      }
    });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({
      success: false,
      errorCode: err.errorCode || 'INTERNAL_ERROR',
      message: err.message
    });
  }
});

/**
 * 申請承認 (教頭・校長・事務)
 */
router.post('/:id/approve', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const appId = parseInt(rawId, 10);
  const { expectedVersion, comment } = req.body;

  const result = WorkflowEngine.approveApplication(user, {
    applicationId: appId,
    expectedVersion,
    comment,
  });
  res.status(result.statusCode).json(result);
});

/**
 * 申請差戻し (Return)
 */
router.post('/:id/return', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const appId = parseInt(rawId, 10);
  const { expectedVersion, comment } = req.body;

  const result = WorkflowEngine.returnApplication(user, {
    applicationId: appId,
    expectedVersion,
    comment,
  });
  res.status(result.statusCode).json(result);
});

/**
 * 申請却下 (Reject)
 */
router.post('/:id/reject', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const appId = parseInt(rawId, 10);
  const { expectedVersion, comment } = req.body;

  const result = WorkflowEngine.rejectApplication(user, {
    applicationId: appId,
    expectedVersion,
    comment,
  });
  res.status(result.statusCode).json(result);
});

/**
 * 差戻し後の再申請（Resubmit）
 */
router.post('/:id/resubmit', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const appId = parseInt(rawId, 10);
  const { expectedVersion, title, formData, typeId: clientTypeId } = req.body;

  const app = getDb().prepare('SELECT type_id, version FROM applications WHERE id = ?').get(appId) as any;
  if (!app) {
    res.status(404).json({ success: false, message: '対象の申請が存在しません' });
    return;
  }

  // 申請種別改ざんチェック (Server-Authoritative)
  if (clientTypeId && clientTypeId !== app.type_id) {
    res.status(400).json({
      success: false,
      errorCode: 'APPLICATION_TYPE_IMMUTABLE',
      message: '差戻し後の再申請で申請種別を変更することはできません。種別変更が必要な場合は取下げの上で新規起案してください。',
    });
    return;
  }

  const expVersion = expectedVersion !== undefined ? Number(expectedVersion) : app.version;
  const normalized = normalizeFormData(app.type_id, formData || {}, app.subject_user_id);

  const result = WorkflowEngine.resubmitApplication(user, {
    applicationId: appId,
    expectedVersion: expVersion,
    title,
    formData: normalized,
  });

  res.status(result.statusCode).json(result);
});


/**
 * 申請取下げ (Withdraw)
 */
router.post('/:id/withdraw', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const appId = parseInt(rawId, 10);
  const { expectedVersion } = req.body;

  const result = WorkflowEngine.withdrawApplication(user, {
    applicationId: appId,
    expectedVersion,
  });
  res.status(result.statusCode).json(result);
});


/**
 * 承認後取消起案 (Request Cancellation)
 */
router.post("/:id/cancel-request", (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const appId = parseInt(rawId, 10);
  const { expectedVersion, cancellationReason } = req.body;

  const result = WorkflowEngine.requestCancellation(user, {
    applicationId: appId,
    expectedVersion: expectedVersion !== undefined ? Number(expectedVersion) : 0,
    cancellationReason,
  });
  res.status(result.statusCode).json(result);
});

/**
 * 承認後取消ステップ承認 (Cancel Approve)
 */
router.post("/:id/cancel-approve", (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const appId = parseInt(rawId, 10);
  const { expectedVersion, comment } = req.body;

  const result = WorkflowEngine.approveCancellation(user, {
    applicationId: appId,
    expectedVersion: expectedVersion !== undefined ? Number(expectedVersion) : 0,
    comment,
  });
  res.status(result.statusCode).json(result);
});

/**
 * 承認後取消却下 (Cancel Reject)
 */
router.post("/:id/cancel-reject", (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const appId = parseInt(rawId, 10);
  const { expectedVersion, comment } = req.body;

  const result = WorkflowEngine.rejectCancellation(user, {
    applicationId: appId,
    expectedVersion: expectedVersion !== undefined ? Number(expectedVersion) : 0,
    comment,
  });
  res.status(result.statusCode).json(result);
});

/**
 * 承認後取消差戻し (Cancel Return)
 */
router.post("/:id/cancel-return", (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const appId = parseInt(rawId, 10);
  const { expectedVersion, comment } = req.body;

  const result = WorkflowEngine.returnCancellation(user, {
    applicationId: appId,
    expectedVersion: expectedVersion !== undefined ? Number(expectedVersion) : 0,
    comment,
  });
  res.status(result.statusCode).json(result);
});

/**
 * 承認後取消差戻し後再申請 (Cancel Resubmit)
 */
router.post("/:id/cancel-resubmit", (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const appId = parseInt(rawId, 10);
  const { expectedVersion, cancellationReason } = req.body;

  const result = WorkflowEngine.resubmitCancellation(user, {
    applicationId: appId,
    expectedVersion: expectedVersion !== undefined ? Number(expectedVersion) : 0,
    cancellationReason,
  });
  res.status(result.statusCode).json(result);
});

export default router;
