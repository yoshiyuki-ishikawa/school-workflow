import { Router, Request, Response } from 'express';
import { getDb } from '../db/database';
import { requireAuth, getUserContext, checkUserPermission } from '../middlewares/auth';
import { getUserLeaveSummary } from '../utils/leaveCalculator';
import { CanonicalAttendanceProjectionEngine } from '../services/canonical/projectionEngine';
import { logAudit } from '../utils/auditLogger';
import { projectLeaveLedgerPages, projectTripOrderPages } from '../services/reportProjectionService';
import { OfficialJobTitleResolver } from '../domain/jobTitle/officialJobTitleResolver';

const router = Router();

router.use(requireAuth);

function resolveOrganizationSettings(db: any, snapshotJson?: string | null): any {
  if (snapshotJson) {
    try {
      return JSON.parse(snapshotJson);
    } catch {
      // fallback to current
    }
  }
  try {
    const current = db.prepare('SELECT * FROM system_settings WHERE id = 1').get() as any;
    if (current) {
      return {
        schoolName: current.school_name,
        municipalityName: current.municipality_name,
        boardOfEducationName: current.board_of_education_name,
        appTitle: current.app_title,
        version: current.version,
      };
    }
  } catch {}
  return {
    schoolName: '公立小学校',
    municipalityName: '〇〇市',
    boardOfEducationName: '〇〇市教育委員会',
    appTitle: '学校業務ワークフローシステム',
    version: 1,
  };
}

/**
 * 帳票テンプレート一覧取得
 */
router.get('/templates', (req: Request, res: Response): void => {
  const db = getDb();
  const templates = db.prepare('SELECT * FROM official_form_templates WHERE is_active = 1 ORDER BY id ASC').all();
  res.json({ success: true, templates });
});

/**
 * 特定帳票テンプレート定義取得
 */
router.get('/templates/:formCode', (req: Request, res: Response): void => {
  const db = getDb();
  const rawCode = Array.isArray(req.params.formCode) ? req.params.formCode[0] : req.params.formCode;
  const template = db.prepare('SELECT * FROM official_form_templates WHERE form_code = ? AND is_active = 1').get(rawCode) as any;
  if (!template) {
    res.status(404).json({ success: false, message: '帳票テンプレートが見つかりません' });
    return;
  }
  res.json({
    success: true,
    template: {
      ...template,
      template_definition: JSON.parse(template.template_definition || '{}'),
    },
  });
});

/**
 * 休暇簿帳票データ取得 (第9号様式相当)
 */
router.get('/leave/:applicationId/pdf-data', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const rawId = Array.isArray(req.params.applicationId) ? req.params.applicationId[0] : req.params.applicationId;
  const appId = parseInt(rawId, 10);
  const db = getDb();

  const app = db.prepare(`
    SELECT
      a.*,
      t.name as type_name,
      su.display_name as subject_user_name,
      su.stamp_name as subject_stamp_name,
      su.department as subject_department,
      pu.display_name as proxy_user_name
    FROM applications a
    JOIN application_types t ON a.type_id = t.id
    JOIN users su ON a.subject_user_id = su.id
    LEFT JOIN users pu ON a.submitted_by_user_id = pu.id
    WHERE a.id = ?
  `).get(appId) as any;

  if (!app) {
    res.status(404).json({ success: false, message: '対象の申請が存在しません' });
    return;
  }

  const isSubject = app.subject_user_id === user.id;
  const isProxySubmitter = app.submitted_by_user_id === user.id;
  const isManager = user.roles.some((r) => ['VICE_PRINCIPAL', 'PRINCIPAL', 'ADMIN', 'OFFICE'].includes(r));
  if (!isSubject && !isProxySubmitter && !isManager) {
    res.status(403).json({ success: false, message: 'この帳票を閲覧・出力する権限がありません' });
    return;
  }

  // 承認ステップと印影メタデータ（Snapshot最優先: Historical Record Immutability SSOT）
  const steps = db.prepare(`
    SELECT
      s.*,
      COALESCE(s.action_user_display_name, s.approver_name_snapshot, u.display_name) as action_user_name,
      COALESCE(s.action_user_stamp_name, u.stamp_name, '') as action_user_stamp_name,
      COALESCE(s.approver_position_name_snapshot, '') as approver_position_name
    FROM application_approval_steps s
    LEFT JOIN users u ON s.action_by_user_id = u.id
    WHERE s.application_id = ?
    ORDER BY s.step_order ASC
  `).all(appId);

  const leaveSummary = getUserLeaveSummary(app.subject_user_id);
  const template = db.prepare("SELECT * FROM official_form_templates WHERE form_code = 'LEAVE_RECORD'").get() as any;
  const orgSettings = resolveOrganizationSettings(db, app.organization_snapshot);

  // INV-W4-03: 申請日付から暦年 (Calendar Year) を特定し、Server-Authoritative な決定論的ページングを導出
  const appFormData = JSON.parse(app.form_data || '{}');
  const targetDateStr = appFormData.startDate || appFormData.targetDate || app.created_at?.split('T')[0] || new Date().toISOString().split('T')[0];
  const calendarYear = parseInt(targetDateStr.split('-')[0], 10) || new Date().getFullYear();
  const projectedLedger = projectLeaveLedgerPages(app.subject_user_id, calendarYear);

  logAudit({
    actorUserId: user.id,
    actorUsername: user.username,
    subjectUserId: app.subject_user_id,
    action: 'PRINT_FORM',
    entityType: 'OFFICIAL_FORM',
    entityId: appId,
    comment: `休暇簿帳票データ取得 (様式: LEAVE_RECORD, 申請ID: ${appId})`,
    ipAddress: user.ipAddress,
    userAgent: user.userAgent,
    metadata: { formCode: 'LEAVE_RECORD', applicationId: appId },
  });

  res.json({
    success: true,
    data: {
      template: template ? { ...template, template_definition: JSON.parse(template.template_definition || '{}') } : null,
      application: {
        ...app,
        form_data: appFormData,
      },
      steps,
      leaveSummary,
      organizationSettings: orgSettings,
      projectedLedger, // Server-Authoritative Deterministic Multi-Page DTO
    },
  });
});

/**
 * 旅行命令・復命簿帳票データ取得 (別表第一相当)
 * HD-W3-A/B Data Minimization (住所・級号給・給料月額は空欄)
 * PINPOINT-05 構造化 Travel Actual Facts の備考欄への決定論的 Projection
 */
export function formatTripRemarksProjection(actualFacts?: any, planFacts?: any): string {
  const lines: string[] = [];
  const src = actualFacts || planFacts || {};

  if (src.actualDeparturePlace) {
    lines.push(`【出発地】${src.actualDeparturePlace}`);
  } else if (src.departurePlace) {
    lines.push(`【出発地(予定)】${src.departurePlace}`);
  }

  if (src.actualArrivalPlace) {
    lines.push(`【帰着地】${src.actualArrivalPlace}`);
  } else if (src.arrivalPlace) {
    lines.push(`【帰着地(予定)】${src.arrivalPlace}`);
  }

  if (src.actualTransportMode) {
    const vehicleType = src.vehicleUsageType === 'PASSENGER' ? ' (同乗)' : (src.vehicleUsageType === 'DRIVER' ? ' (運転)' : '');
    lines.push(`【交通手段】${src.actualTransportMode}${vehicleType}`);
  } else if (src.transport) {
    lines.push(`【交通手段(予定)】${src.transport}`);
  }

  if (src.actualDistanceKm !== undefined && src.actualDistanceKm !== null) {
    lines.push(`【実測距離】${src.actualDistanceKm} km`);
  }

  if (src.communicationCostBorne !== undefined && src.communicationCostBorne !== null) {
    lines.push(`【通信運送費負担】${src.communicationCostBorne ? 'あり' : 'なし'}`);
  }

  if (src.actualTripStartAt || src.actualTripEndAt) {
    lines.push(`【実時間】${src.actualTripStartAt || ''} 〜 ${src.actualTripEndAt || ''}`);
  }

  if (src.travelExpenseRemarks) {
    lines.push(`【特記事項】${src.travelExpenseRemarks}`);
  }

  return lines.join('\n');
}

router.get('/trip/:applicationId/pdf-data', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const rawId = Array.isArray(req.params.applicationId) ? req.params.applicationId[0] : req.params.applicationId;
  const appId = parseInt(rawId, 10);
  const db = getDb();

  const app = db.prepare(`
    SELECT
      a.*,
      t.name as type_name,
      su.display_name as subject_user_name,
      su.stamp_name as subject_stamp_name,
      su.department as subject_department,
      pu.display_name as proxy_user_name,
      te.title as event_title,
      te.purpose as event_purpose,
      te.destination as event_destination,
      te.transport as event_transport,
      te.departure_place,
      te.arrival_place,
      te.is_oral_order,
      te.oral_order_issued_at
    FROM applications a
    JOIN application_types t ON a.type_id = t.id
    JOIN users su ON a.subject_user_id = su.id
    LEFT JOIN users pu ON a.submitted_by_user_id = pu.id
    LEFT JOIN trip_events te ON a.trip_event_id = te.id
    WHERE a.id = ?
  `).get(appId) as any;

  if (!app) {
    res.status(404).json({ success: false, message: '対象の申請が存在しません' });
    return;
  }

  const isSubject = app.subject_user_id === user.id;
  const isProxySubmitter = app.submitted_by_user_id === user.id;
  const isManager = user.roles.some((r) => ['VICE_PRINCIPAL', 'PRINCIPAL', 'ADMIN', 'OFFICE'].includes(r));
  if (!isSubject && !isProxySubmitter && !isManager) {
    res.status(403).json({ success: false, message: 'この帳票を閲覧・出力する権限がありません' });
    return;
  }

  // 旅行命令 Snapshot および 復命 Snapshot の取得 (Snapshot最優先 SSOT)
  const orderSnapshot = db.prepare(`
    SELECT * FROM travel_order_snapshots WHERE application_id = ? ORDER BY id DESC LIMIT 1
  `).get(appId) as any;

  const reportSnapshot = db.prepare(`
    SELECT * FROM post_trip_report_snapshots WHERE application_id = ? ORDER BY id DESC LIMIT 1
  `).get(appId) as any;

  // 承認ステップと印影メタデータ（Snapshot最優先: Historical Record Immutability SSOT）
  const steps = db.prepare(`
    SELECT
      s.*,
      COALESCE(s.action_user_display_name, s.approver_name_snapshot, u.display_name) as action_user_name,
      COALESCE(s.action_user_stamp_name, u.stamp_name, '') as action_user_stamp_name,
      COALESCE(s.approver_position_name_snapshot, '') as approver_position_name
    FROM application_approval_steps s
    LEFT JOIN users u ON s.action_by_user_id = u.id
    WHERE s.application_id = ?
    ORDER BY s.step_order ASC
  `).all(appId);

  const template = db.prepare("SELECT * FROM official_form_templates WHERE form_code = 'TRIP_ORDER'").get() as any;
  const orgSettings = resolveOrganizationSettings(db, app.organization_snapshot);

  // Travel Actual Facts / Plan Facts から備考欄テキストを決定論的 Projection
  let parsedActualFacts: any = null;
  if (reportSnapshot && reportSnapshot.travel_actual_facts_json) {
    try { parsedActualFacts = JSON.parse(reportSnapshot.travel_actual_facts_json); } catch {}
  }
  let parsedPlanFacts: any = null;
  if (orderSnapshot && orderSnapshot.trip_plan_facts_json) {
    try { parsedPlanFacts = JSON.parse(orderSnapshot.trip_plan_facts_json); } catch {}
  }
  const formattedRemarks = formatTripRemarksProjection(parsedActualFacts, parsedPlanFacts || JSON.parse(app.form_data || '{}'));

  const tripPurpose = parsedPlanFacts?.purpose || app.event_purpose || JSON.parse(app.form_data || '{}').purpose || '';
  const tripReportResult = reportSnapshot?.result_summary || JSON.parse(app.form_data || '{}').reportResult || '';
  const projectedTrip = projectTripOrderPages(tripPurpose, tripReportResult);

  logAudit({
    actorUserId: user.id,
    actorUsername: user.username,
    subjectUserId: app.subject_user_id,
    action: 'PRINT_FORM',
    entityType: 'OFFICIAL_FORM',
    entityId: appId,
    comment: `旅行命令・復命簿帳票データ取得 (様式: TRIP_ORDER, 申請ID: ${appId})`,
    ipAddress: user.ipAddress,
    userAgent: user.userAgent,
    metadata: { formCode: 'TRIP_ORDER', applicationId: appId },
  });

  // 山口県別表第一 Projection 項目 (HD-W3-A/B: 住所・級号給は空欄)
  const unfinalizedTargetDate = (app.form_data && JSON.parse(app.form_data).startDate) || (app.created_at ? app.created_at.split('T')[0] : new Date().toISOString().split('T')[0]);
  const unfinalizedJobTitle = OfficialJobTitleResolver.resolveAtDate(db, app.subject_user_id, unfinalizedTargetDate, { strict: false }).displayName;
  const finalTravelerPosition = orderSnapshot?.traveler_position_snapshot || unfinalizedJobTitle;

  res.json({
    success: true,
    data: {
      template: template ? { ...template, template_definition: JSON.parse(template.template_definition || '{}') } : null,
      application: {
        ...app,
        form_data: JSON.parse(app.form_data || '{}'),
      },
      orderSnapshot: orderSnapshot ? {
        ...orderSnapshot,
        trip_plan_facts: parsedPlanFacts,
        approval_history_snapshots: JSON.parse(orderSnapshot.approval_history_snapshots_json || '[]')
      } : null,
      reportSnapshot: reportSnapshot ? {
        ...reportSnapshot,
        travel_actual_facts: parsedActualFacts,
        report_approval_snapshots: JSON.parse(reportSnapshot.report_approval_snapshots_json || '[]')
      } : null,
      steps,
      organizationSettings: orgSettings,
      projectedTrip, // Server-Authoritative Deterministic Multi-Page DTO
      projection: {
        schoolName: orderSnapshot?.school_name_snapshot || orgSettings.schoolName,
        travelerAddress: '', // HD-W3-A: 保持せず空欄
        travelerPosition: finalTravelerPosition,
        isJobTitleResolved: finalTravelerPosition !== '（職名未設定）',
        travelerName: orderSnapshot?.traveler_name_snapshot || app.subject_user_name,
        travelerGradeAndStep: '', // HD-W3-B: 保持せず空欄
        travelOrderIssuedAt: orderSnapshot?.travel_order_issued_at || (app.is_oral_order === 1 ? app.oral_order_issued_at : null),
        purpose: tripPurpose,
        destination: parsedPlanFacts?.destination || app.event_destination || JSON.parse(app.form_data || '{}').destination || '',
        tripPeriod: {
          startAt: parsedPlanFacts?.plannedTripStartAt || app.form_data && JSON.parse(app.form_data).startAt,
          endAt: parsedPlanFacts?.plannedTripEndAt || app.form_data && JSON.parse(app.form_data).endAt
        },
        reportDate: reportSnapshot?.report_date || JSON.parse(app.form_data || '{}').reportDate || null,
        reportResult: tripReportResult,
        remarks: formattedRemarks
      }
    },
  });
});

/**
 * 出勤簿帳票データ取得 (Canonical ATTENDANCE_BOOK)
 */
router.get('/attendance/:userId/:yearMonth/pdf-data', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const rawUserId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  const rawYearMonth = Array.isArray(req.params.yearMonth) ? req.params.yearMonth[0] : req.params.yearMonth;
  const targetUserId = parseInt(rawUserId, 10);
  const yearMonth = rawYearMonth;
  const db = getDb();

  const isSubject = targetUserId === user.id;
  const isManager = user.roles.some((r) => ['VICE_PRINCIPAL', 'PRINCIPAL', 'ADMIN', 'OFFICE'].includes(r));
  if (!isSubject && !isManager) {
    res.status(403).json({ success: false, message: 'この出勤簿を閲覧・出力する権限がありません' });
    return;
  }

  const targetUser = db.prepare('SELECT id, username, display_name, stamp_name, department FROM users WHERE id = ?').get(targetUserId) as any;
  if (!targetUser) {
    res.status(404).json({ success: false, message: '対象の教職員が見つかりません' });
    return;
  }

  // Canonical Projection Engine から Document Projection を取得 (Server-Authoritative: HD-PE-01, HD-PE-03)
  const docData = CanonicalAttendanceProjectionEngine.getDocumentProjection(targetUserId, yearMonth);
  const attendanceData = docData.attendanceData;
  const template = docData.template;
  const orgSettings = docData.organizationSettings;

  logAudit({
    actorUserId: user.id,
    actorUsername: user.username,
    subjectUserId: targetUserId,
    action: 'PRINT_FORM',
    entityType: 'OFFICIAL_FORM',
    entityId: `${targetUserId}_${yearMonth}`,
    comment: `出勤簿帳票データ取得 (様式: ATTENDANCE_BOOK, 対象: ${targetUser.display_name}, 年月: ${yearMonth})`,
    ipAddress: user.ipAddress,
    userAgent: user.userAgent,
    metadata: { formCode: 'ATTENDANCE_BOOK', targetUserId, yearMonth },
  });

  res.json({
    success: true,
    data: {
      template: template || null,
      user: {
        id: targetUser.id,
        username: targetUser.username,
        displayName: targetUser.display_name,
        stampName: targetUser.stamp_name,
        department: targetUser.department,
      },
      yearMonth,
      attendanceData, // サーバー確定多軸データ (days, summary, domainSummary, approval)
      monthlyApproval: attendanceData.approval,
      organizationSettings: orgSettings,
    },
  });
});

export default router;
