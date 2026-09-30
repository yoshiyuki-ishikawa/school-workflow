import { Router, Request, Response } from 'express';
import { getDb } from '../db/database';
import { requireAuth, getUserContext, checkUserPermission } from '../middlewares/auth';
import { logAudit } from '../utils/auditLogger';
import { getServerIsoString } from '../utils/serverTime';

const router = Router();
router.use(requireAuth);

/**
 * 1. 介護ケース・指定期間一覧取得 (GET /api/care-cases)
 * 一般職員: 自らのケースのみ (care.case.read.self)
 * 管理職/事務: 管理下の全ケース (care.case.read.managed)
 */
router.get('/', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const targetUserId = req.query.userId ? parseInt(req.query.userId as string, 10) : user.id;

  const canReadManaged = checkUserPermission(user.roles, 'care.case.read.managed');
  if (targetUserId !== user.id && !canReadManaged) {
    res.status(403).json({ success: false, message: '他職員の介護ケースを閲覧する権限がありません' });
    return;
  }

  try {
    const db = getDb();
    const cases = db.prepare(`
      SELECT c.*, u.display_name as user_name
      FROM care_cases c
      JOIN users u ON c.user_id = u.id
      WHERE c.user_id = ? AND c.status = 'ACTIVE'
      ORDER BY c.id DESC
    `).all(targetUserId) as any[];

    // 各ケースの指定期間を取得
    const casesWithPeriods = cases.map(c => {
      const periods = db.prepare(`
        SELECT * FROM care_periods
        WHERE care_case_id = ?
        ORDER BY start_date ASC
      `).all(c.id);

      return {
        ...c,
        periods
      };
    });

    res.json({ success: true, cases: casesWithPeriods });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * 2. 介護ケース登録 (POST /api/care-cases)
 * 権限: care.case.manage または 本人
 */
router.post('/', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const { targetUserId, recipientRelation, recipientName, conditionSummary, initialPeriod, careStartDate } = req.body;
  const effectiveUserId = targetUserId || user.id;

  const canManage = checkUserPermission(user.roles, 'care.case.manage');
  if (effectiveUserId !== user.id && !canManage) {
    res.status(403).json({ success: false, message: '他職員の介護ケースを登録する権限がありません' });
    return;
  }

  if (!recipientRelation || !recipientName || !conditionSummary) {
    res.status(400).json({ success: false, message: '続柄・対象者氏名・介護事由は必須です' });
    return;
  }

  try {
    const db = getDb();
    const insertCase = db.prepare(`
      INSERT INTO care_cases (user_id, recipient_relation, recipient_name, condition_summary, care_start_date, created_by_user_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = insertCase.run(
      effectiveUserId,
      recipientRelation,
      recipientName,
      conditionSummary,
      careStartDate || (initialPeriod?.startDate || new Date().toISOString().split('T')[0]),
      user.id
    );
    const caseId = result.lastInsertRowid as number;

    let periodId: number | null = null;
    if (initialPeriod && initialPeriod.startDate && initialPeriod.endDate) {
      if (initialPeriod.startDate > initialPeriod.endDate) {
        res.status(400).json({ success: false, message: '指定期間の開始日は終了日以前である必要があります' });
        return;
      }

      const insertPeriod = db.prepare(`
        INSERT INTO care_periods (care_case_id, period_number, start_date, end_date, status, approved_by_user_id, approved_at)
        VALUES (?, 1, ?, ?, 'APPROVED', ?, ?)
      `);
      const pResult = insertPeriod.run(caseId, initialPeriod.startDate, initialPeriod.endDate, user.id, getServerIsoString());
      periodId = pResult.lastInsertRowid as number;
    }

    logAudit({
      actorUserId: user.id,
      actorUsername: user.username,
      subjectUserId: effectiveUserId,
      action: 'CREATE_CARE_CASE',
      entityType: 'CARE_CASE',
      entityId: caseId,
      comment: `介護ケース登録: 続柄 ${recipientRelation}, 対象者 ${recipientName}`,
      ipAddress: (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '127.0.0.1',
      userAgent: req.headers['user-agent']
    });

    res.json({ success: true, message: '介護ケースを登録しました', caseId, periodId });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * 3. 既存介護ケースへの指定期間（第2期・第3期）追加 (POST /api/care-cases/:caseId/periods)
 */
router.post('/:caseId/periods', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const rawId = Array.isArray(req.params.caseId) ? req.params.caseId[0] : req.params.caseId;
  const caseId = parseInt(rawId, 10);
  const { startDate, endDate, memo } = req.body;

  if (!startDate || !endDate) {
    res.status(400).json({ success: false, message: '開始日と終了日は必須です' });
    return;
  }
  if (startDate > endDate) {
    res.status(400).json({ success: false, message: '開始日は終了日以前である必要があります' });
    return;
  }

  try {
    const db = getDb();
    const careCase = db.prepare('SELECT * FROM care_cases WHERE id = ?').get(caseId) as any;
    if (!careCase) {
      res.status(404).json({ success: false, message: '対象の介護ケースが見つかりません' });
      return;
    }

    const canManage = checkUserPermission(user.roles, 'care.case.manage');
    if (careCase.user_id !== user.id && !canManage) {
      res.status(403).json({ success: false, message: 'この介護ケースに指定期間を追加する権限がありません' });
      return;
    }

    // 既存期間数を取得 (最大3回制限: 条例第15条第1項)
    const existingPeriods = db.prepare('SELECT * FROM care_periods WHERE care_case_id = ? ORDER BY period_number ASC').all(caseId) as any[];
    if (existingPeriods.length >= 3) {
      res.status(400).json({ success: false, message: '同一要介護者に対する指定期間は最大3回までです（条例第15条第1項）' });
      return;
    }

    const nextPeriodNumber = existingPeriods.length + 1;
    const insertPeriod = db.prepare(`
      INSERT INTO care_periods (care_case_id, period_number, start_date, end_date, status, approved_by_user_id, approved_at, memo)
      VALUES (?, ?, ?, ?, 'APPROVED', ?, ?, ?)
    `);

    const pResult = insertPeriod.run(caseId, nextPeriodNumber, startDate, endDate, user.id, getServerIsoString(), memo || null);
    const periodId = pResult.lastInsertRowid as number;

    logAudit({
      actorUserId: user.id,
      actorUsername: user.username,
      subjectUserId: careCase.user_id,
      action: 'ADD_CARE_PERIOD',
      entityType: 'CARE_PERIOD',
      entityId: periodId,
      comment: `指定期間（第${nextPeriodNumber}期）追加: ${startDate} 〜 ${endDate}`,
      ipAddress: (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '127.0.0.1',
      userAgent: req.headers['user-agent']
    });

    res.json({ success: true, message: `指定期間（第${nextPeriodNumber}期）を登録しました`, periodId, periodNumber: nextPeriodNumber });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
