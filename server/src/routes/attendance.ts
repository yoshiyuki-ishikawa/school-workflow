import { Router, Request, Response } from 'express';
import { getDb } from '../db/database';
import { requireAuth, requirePermission, getUserContext, checkUserPermission } from '../middlewares/auth';
import { CanonicalAttendanceProjectionEngine } from '../services/canonical/projectionEngine';
import { CalendarImportService } from '../services/calendarImportService';
import { getServerIsoString, getServerTime } from '../utils/serverTime';
import { logAudit } from '../utils/auditLogger';
import { WorkflowEngine } from '../workflow/engine';
import { timeToMinutes, validateWorkIntervals, WorkTimeInterval } from '../services/attendance/workPatternResolver';

const router = Router();
router.use(requireAuth);

/**
 * 1. 月間出勤簿データ取得 (出勤簿 - Canonical Monthly DTO)
 */
router.get('/monthly', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const targetUserId = req.query.userId ? parseInt(req.query.userId as string, 10) : user.id;
  const yearMonth = (req.query.yearMonth as string) || new Date().toISOString().substring(0, 7);

  // 他人の出勤簿閲覧権限チェック
  if (
    targetUserId !== user.id &&
    !user.roles.includes('ADMIN') &&
    !user.roles.includes('VICE_PRINCIPAL') &&
    !user.roles.includes('PRINCIPAL') &&
    !user.roles.includes('OFFICE')
  ) {
    res.status(403).json({ success: false, message: '他人の出勤簿を閲覧する権限がありません' });
    return;
  }

  const hasRestricted = checkUserPermission(user.roles, 'personnel.status.read.restricted');

  try {
    const data = CanonicalAttendanceProjectionEngine.getMonthlyProjection(targetUserId, yearMonth, { includeRestricted: hasRestricted });
    res.json({ success: true, data });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * 2. 服務調整イベント一覧取得 (GET /api/attendance/calendar-adjustments)
 */
router.get('/calendar-adjustments', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const fiscalYear = req.query.fiscalYear ? parseInt(req.query.fiscalYear as string, 10) : null;
  const yearMonth = req.query.yearMonth as string;
  const targetUserId = req.query.userId ? parseInt(req.query.userId as string, 10) : null;

  const db = getDb();
  let query = `
    SELECT ca.*, 
           cu.display_name as created_by_name,
           uu.display_name as target_user_name
    FROM calendar_adjustments ca
    LEFT JOIN users cu ON ca.created_by_user_id = cu.id
    LEFT JOIN users uu ON ca.user_id = uu.id
    WHERE 1=1
  `;
  const params: any[] = [];

  if (fiscalYear) {
    const start = `${fiscalYear}-04-01`;
    const end = `${fiscalYear + 1}-03-31`;
    query += ` AND ((ca.source_date BETWEEN ? AND ?) OR (ca.target_date BETWEEN ? AND ?))`;
    params.push(start, end, start, end);
  } else if (yearMonth) {
    query += ` AND (ca.source_date LIKE ? OR ca.target_date LIKE ?)`;
    params.push(`${yearMonth}-%`, `${yearMonth}-%`);
  }

  if (targetUserId) {
    query += ` AND (ca.scope_type = 'ALL' OR ca.user_id = ?)`;
    params.push(targetUserId);
  }

  query += ` ORDER BY ca.source_date ASC, ca.id ASC`;

  const adjustments = db.prepare(query).all(...params);
  res.json({ success: true, adjustments });
});

/**
 * 3. 服務調整イベントの登録 (POST /api/attendance/calendar-adjustments)
 * Canonical Permission: calendar.manage
 */
router.post('/calendar-adjustments', requirePermission('calendar.manage'), (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const {
    scopeType,
    userId,
    adjustmentType,
    reasonCode,
    authorityBasis,
    sourceDate,
    sourceDutyStatus,
    targetDate,
    targetDutyStatus,
    eventName,
    reason,
    relatedAdjustmentId,
    scheduleOverride,
  } = req.body;

  // バリデーション
  if (!scopeType || !adjustmentType || !reasonCode || !sourceDate || !sourceDutyStatus || !eventName || !reason) {
    res.status(400).json({ success: false, message: '必須項目が不足しています' });
    return;
  }

  if (scopeType === 'USER' && !userId) {
    res.status(400).json({ success: false, message: '対象教職員を選択してください' });
    return;
  }

  if (targetDate && sourceDate === targetDate) {
    res.status(400).json({ success: false, message: '振替元日と振替先日を同一にすることはできません' });
    return;
  }

  // GAP-01 / DELTA-01: Server-Authoritative Date Override Projection & Validation
  let scheduleOverrideJson: string | null = null;
  if (scheduleOverride) {
    if (sourceDutyStatus !== 'WORK_REQUIRED') {
      res.status(400).json({ success: false, message: '勤務日以外の調整には日課オーバーライドを設定できません' });
      return;
    }

    const { startTime, endTime, breakIntervals } = scheduleOverride;
    const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!startTime || !endTime || !timeRegex.test(startTime) || !timeRegex.test(endTime)) {
      res.status(400).json({ success: false, message: '勤務日課の始業・終業時刻の形式が不正です (HH:mm)' });
      return;
    }

    const S = timeToMinutes(startTime);
    const E = timeToMinutes(endTime);
    if (S >= E) {
      res.status(400).json({ success: false, message: '始業時刻は終業時刻より前である必要があります' });
      return;
    }

    const normalizedBreaks: Array<{ start: number; end: number; startTime: string; endTime: string }> = [];
    if (breakIntervals && Array.isArray(breakIntervals)) {
      for (const b of breakIntervals) {
        if (!b.startTime || !b.endTime || !timeRegex.test(b.startTime) || !timeRegex.test(b.endTime)) {
          res.status(400).json({ success: false, message: '休憩時刻の形式が不正です (HH:mm)' });
          return;
        }
        const bStart = timeToMinutes(b.startTime);
        const bEnd = timeToMinutes(b.endTime);
        if (bStart >= bEnd) {
          res.status(400).json({ success: false, message: '休憩開始時刻は休憩終了時刻より前である必要があります' });
          return;
        }
        if (bStart < S || bEnd > E) {
          res.status(400).json({ success: false, message: '休憩時間は勤務時間帯の内側に収める必要があります' });
          return;
        }
        normalizedBreaks.push({ start: bStart, end: bEnd, startTime: b.startTime, endTime: b.endTime });
      }

      normalizedBreaks.sort((a, b) => a.start - b.start);
      for (let i = 1; i < normalizedBreaks.length; i++) {
        if (normalizedBreaks[i].start < normalizedBreaks[i - 1].end) {
          res.status(400).json({ success: false, message: '休憩時間帯同士が重複しています' });
          return;
        }
      }
    }

    // DELTA-01: Server-Authoritative workIntervals Projection ([S, E] - breakIntervals)
    let currentStart = S;
    const workIntervals: WorkTimeInterval[] = [];
    for (const b of normalizedBreaks) {
      if (b.start > currentStart) {
        workIntervals.push({ start: currentStart, end: b.start });
      }
      currentStart = Math.max(currentStart, b.end);
    }
    if (currentStart < E) {
      workIntervals.push({ start: currentStart, end: E });
    }

    if (workIntervals.length === 0) {
      res.status(400).json({ success: false, message: '休憩によって有効な勤務区間が存在しません' });
      return;
    }

    const valRes = validateWorkIntervals(workIntervals);
    if (!valRes.isValid) {
      res.status(400).json({ success: false, message: `勤務区間の検証に失敗しました: ${valRes.error}` });
      return;
    }

    const totalWorkMinutes = workIntervals.reduce((sum, inv) => sum + (inv.end - inv.start), 0);
    if (totalWorkMinutes <= 0) {
      res.status(400).json({ success: false, message: '実勤務時間は1分以上必要です' });
      return;
    }

    scheduleOverrideJson = JSON.stringify({
      workIntervals,
      breakIntervals: normalizedBreaks.map(b => ({ start: b.start, end: b.end })),
      timeRange: {
        startTime,
        endTime,
      },
      totalWorkMinutes,
    });
  }

  const db = getDb();
  const now = getServerIsoString();

  // Conflict Validation: 重複ACTIVE設定の検査
  const checkDuplicate = (date: string, checkUserId: number | null, checkScope: string) => {
    if (checkScope === 'ALL') {
      return db.prepare(`
        SELECT id, event_name FROM calendar_adjustments
        WHERE status = 'ACTIVE' AND scope_type = 'ALL'
          AND (source_date = ? OR target_date = ?)
      `).get(date, date) as any;
    } else {
      return db.prepare(`
        SELECT id, event_name FROM calendar_adjustments
        WHERE status = 'ACTIVE' AND scope_type = 'USER' AND user_id = ?
          AND (source_date = ? OR target_date = ?)
      `).get(checkUserId, date, date) as any;
    }
  };

  const dupSource = checkDuplicate(sourceDate, userId || null, scopeType);
  if (dupSource) {
    res.status(400).json({
      success: false,
      message: `${sourceDate} には既に有効な調整（${dupSource.event_name}）が設定されています`,
    });
    return;
  }

  if (targetDate) {
    const dupTarget = checkDuplicate(targetDate, userId || null, scopeType);
    if (dupTarget) {
      res.status(400).json({
        success: false,
        message: `${targetDate} には既に有効な調整（${dupTarget.event_name}）が設定されています`,
      });
      return;
    }
  }

  // 調整コード採番 (例: ADJ-20260901-1234)
  const st = getServerTime();
  const dateCompact = `${st.getFullYear()}${String(st.getMonth() + 1).padStart(2, '0')}${String(st.getDate()).padStart(2, '0')}`;
  const randomSuffix = Math.floor(1000 + Math.random() * 9000);
  const adjustmentCode = `ADJ-${dateCompact}-${randomSuffix}`;

  const insertTx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO calendar_adjustments (
        adjustment_code, scope_type, user_id, adjustment_type, reason_code,
        authority_basis, source_date, source_duty_status, target_date, target_duty_status,
        related_adjustment_id, event_name, reason, status, record_origin,
        schedule_override_json,
        created_by_user_id, created_at, updated_by_user_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 'MANUAL', ?, ?, ?, ?, ?)
    `).run(
      adjustmentCode,
      scopeType,
      scopeType === 'USER' ? userId : null,
      adjustmentType,
      reasonCode,
      authorityBasis || null,
      sourceDate,
      sourceDutyStatus,
      targetDate || null,
      targetDutyStatus || null,
      relatedAdjustmentId || null,
      eventName,
      reason,
      scheduleOverrideJson,
      user.id,
      now,
      user.id,
      now
    );

    logAudit({
      actorUserId: user.id,
      actorUsername: user.username,
      subjectUserId: scopeType === 'USER' ? userId : undefined,
      submissionActorType: 'SELF',
      submissionMode: 'SINGLE',
      action: 'CALENDAR_ADJUSTMENT_CREATED',
      entityType: 'CALENDAR_ADJUSTMENT',
      entityId: String(info.lastInsertRowid),
      comment: `服務調整登録 [${adjustmentCode}] ${eventName} (${sourceDate}${targetDate ? ' -> ' + targetDate : ''}): ${reason}`,
      ipAddress: user.ipAddress,
      userAgent: user.userAgent,
    });

    return info.lastInsertRowid;
  });

  try {
    const newId = insertTx();
    res.json({ success: true, message: '服務調整を設定しました', id: newId, adjustmentCode });
  } catch (err: any) {
    res.status(500).json({ success: false, message: `設定保存に失敗しました: ${err.message}` });
  }
});

/**
 * 4. 服務調整イベントの取消 (論理解除: POST /api/attendance/calendar-adjustments/:id/cancel)
 * Canonical Permission: calendar.manage
 */
router.post('/calendar-adjustments/:id/cancel', requirePermission('calendar.manage'), (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const adjId = parseInt(rawId, 10);
  const { cancelReason } = req.body;

  const db = getDb();
  const target = db.prepare('SELECT * FROM calendar_adjustments WHERE id = ?').get(adjId) as any;
  if (!target) {
    res.status(404).json({ success: false, message: '対象の服務調整が見つかりません' });
    return;
  }

  if (target.status === 'CANCELLED') {
    res.status(400).json({ success: false, message: 'この服務調整は既に取り消されています' });
    return;
  }

  const now = getServerIsoString();

  db.prepare(`
    UPDATE calendar_adjustments
    SET status = 'CANCELLED',
        cancelled_by_user_id = ?,
        cancelled_at = ?,
        cancel_reason = ?,
        updated_by_user_id = ?,
        updated_at = ?
    WHERE id = ?
  `).run(user.id, now, cancelReason || '管理者による解除', user.id, now, adjId);

  logAudit({
    actorUserId: user.id,
    actorUsername: user.username,
    subjectUserId: target.user_id || undefined,
    action: 'CALENDAR_ADJUSTMENT_CANCELLED',
    entityType: 'CALENDAR_ADJUSTMENT',
    entityId: String(adjId),
    comment: `服務調整取消 [${target.adjustment_code}] ${target.event_name}: ${cancelReason || '解除'}`,
    ipAddress: user.ipAddress,
    userAgent: user.userAgent,
  });

  res.json({ success: true, message: '服務調整を取り消しました' });
});

/**
 * 5. 祝日・学校独自休日一覧取得 (GET /api/attendance/custom-holidays)
 */
router.get('/custom-holidays', (req: Request, res: Response): void => {
  const year = req.query.year ? parseInt(req.query.year as string, 10) : new Date().getFullYear();
  const db = getDb();

  const customRows = db.prepare(`
    SELECT ch.*, u.display_name as created_by_name
    FROM custom_holidays ch
    LEFT JOIN users u ON ch.created_by_user_id = u.id
    WHERE ch.holiday_date LIKE ?
    ORDER BY ch.holiday_date ASC
  `).all(`${year}-%`) as any[];

  res.json({ success: true, year, customHolidays: customRows });
});

/**
 * 6. 祝日・学校独自休日の登録・更新 (POST /api/attendance/custom-holidays)
 * Canonical Permission: calendar.manage
 */
router.post('/custom-holidays', requirePermission('calendar.manage'), (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const { holidayDate, name, holidayType, source, note } = req.body;
  if (!holidayDate || !name || !holidayType) {
    res.status(400).json({ success: false, message: '日付、名称、休日種別は必須です' });
    return;
  }

  const db = getDb();
  const now = getServerIsoString();

  db.prepare(`
    INSERT INTO custom_holidays (
      holiday_date, name, holiday_type, source, is_active, note,
      record_origin, created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, ?, 'MANUAL', ?, ?, ?)
    ON CONFLICT(holiday_date, holiday_type) DO UPDATE SET
      name = excluded.name,
      source = excluded.source,
      is_active = 1,
      note = excluded.note,
      record_origin = 'MANUAL',
      updated_at = excluded.updated_at
  `).run(
    holidayDate,
    name,
    holidayType,
    source || 'CUSTOM',
    note || null,
    user.id,
    now,
    now
  );

  logAudit({
    actorUserId: user.id,
    actorUsername: user.username,
    action: 'CUSTOM_HOLIDAY_CREATED',
    entityType: 'CUSTOM_HOLIDAY',
    entityId: holidayDate,
    comment: `学校休日・祝日設定: ${holidayDate} ${name} (${holidayType})`,
    ipAddress: user.ipAddress,
    userAgent: user.userAgent,
  });

  res.json({ success: true, message: '休日設定を保存しました' });
});

/**
 * 7. 祝日・学校独自休日の有効/無効切替 (POST /api/attendance/custom-holidays/:id/toggle)
 * Canonical Permission: calendar.manage
 */
router.post('/custom-holidays/:id/toggle', requirePermission('calendar.manage'), (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const holidayId = parseInt(rawId, 10);
  const db = getDb();

  const current = db.prepare('SELECT * FROM custom_holidays WHERE id = ?').get(holidayId) as any;
  if (!current) {
    res.status(404).json({ success: false, message: '休日設定が見つかりません' });
    return;
  }

  const newStatus = current.is_active === 1 ? 0 : 1;
  const now = getServerIsoString();

  db.prepare(`
    UPDATE custom_holidays
    SET is_active = ?, updated_at = ?
    WHERE id = ?
  `).run(newStatus, now, holidayId);

  logAudit({
    actorUserId: user.id,
    actorUsername: user.username,
    action: 'CUSTOM_HOLIDAY_TOGGLED',
    entityType: 'CUSTOM_HOLIDAY',
    entityId: String(holidayId),
    comment: `休日設定切替 [${current.name} (${current.holiday_date})]: ${newStatus === 1 ? '有効化' : '無効化'}`,
    ipAddress: user.ipAddress,
    userAgent: user.userAgent,
  });

  res.json({ success: true, message: `休日を${newStatus === 1 ? '有効化' : '無効化'}しました`, isActive: newStatus });
});

/**
 * 8. 年間カレンダー一括インポート Dry-Run プレビュー (POST /api/attendance/calendar-import/preview)
 * Canonical Permission: calendar.manage
 */
router.post('/calendar-import/preview', requirePermission('calendar.manage'), (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const { csvContent, fileName } = req.body;

  if (!csvContent || typeof csvContent !== 'string') {
    res.status(400).json({ success: false, message: 'CSVコンテンツが指定されていません' });
    return;
  }

  const effectiveFileName = fileName || 'annual_calendar.csv';

  try {
    // Base64 または 通常テキストの判定
    let buffer: Buffer;
    if (csvContent.startsWith('data:') || /^[A-Za-z0-9+/=]+$/.test(csvContent.substring(0, 100).trim()) && csvContent.length % 4 === 0) {
      const base64Data = csvContent.includes(',') ? csvContent.split(',')[1] : csvContent;
      buffer = Buffer.from(base64Data, 'base64');
    } else {
      buffer = Buffer.from(csvContent, 'utf8');
    }

    const { rows, sha256 } = CalendarImportService.parseCsv(buffer, effectiveFileName);
    const candidates = CalendarImportService.resolveCanonicalPairs(rows);
    const preview = CalendarImportService.generatePreview(candidates, effectiveFileName, sha256, user.id);

    res.json({ success: true, data: preview });
  } catch (err: any) {
    res.status(400).json({ success: false, message: `プレビュー生成に失敗しました: ${err.message}` });
  }
});

/**
 * 9. 年間カレンダー一括インポート 確定コミット (POST /api/attendance/calendar-import/commit)
 * Canonical Permission: calendar.manage
 */
router.post('/calendar-import/commit', requirePermission('calendar.manage'), (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const { previewToken, fileSha256, fileName, fiscalYear, approvedConflictIds, commitComment } = req.body;

  if (!previewToken || !fileSha256) {
    res.status(400).json({ success: false, message: 'PreviewToken および FileSha256 は必須です' });
    return;
  }

  try {
    const result = CalendarImportService.commitImport(
      {
        previewToken,
        fileSha256,
        fileName: fileName || 'annual_calendar.csv',
        fiscalYear: fiscalYear ? parseInt(String(fiscalYear), 10) : new Date().getFullYear(),
        approvedConflictIds,
        commitComment,
      },
      user.id,
      user
    );

    res.json({ success: true, data: result });
  } catch (err: any) {
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({ success: false, code: err.code, message: err.message });
  }
});

/**
 * 10. 校長による月次出勤簿の確定・承認サイン (POST /api/attendance/confirm)
 */
router.post('/confirm', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const { userId, yearMonth, comment } = req.body;

  if (!userId || !yearMonth) {
    res.status(400).json({ success: false, message: 'ユーザーIDおよび対象年月は必須です' });
    return;
  }

  const result = WorkflowEngine.confirmMonthlyAttendance(user, {
    userId: parseInt(userId, 10),
    yearMonth,
    comment,
  });

  res.status(result.statusCode).json(result);
});

/**
 * 11. 校長による月次出勤簿の確定解除 (POST /api/attendance/unlock)
 */
router.post('/unlock', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const { userId, yearMonth, reason } = req.body;

  if (!userId || !yearMonth || !reason) {
    res.status(400).json({ success: false, message: 'ユーザーID、対象年月、および解除理由は必須です' });
    return;
  }

  const result = WorkflowEngine.unlockMonthlyAttendance(user, {
    userId: parseInt(userId, 10),
    yearMonth,
    reason,
  });

  res.status(result.statusCode).json(result);
});

export default router;
