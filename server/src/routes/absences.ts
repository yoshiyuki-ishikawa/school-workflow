import { Router, Request, Response } from 'express';
import { getDb } from '../db/database';
import { requireAuth, getUserContext, requirePermission, checkUserPermission } from '../middlewares/auth';
import { AbsenceService } from '../services/absenceService';

const router = Router();
router.use(requireAuth);

/**
 * GET /api/absences
 * 欠勤一覧取得 (Scope制御: 一般教員は自身のマスク済みデータのみ、管理職/事務は完全取得)
 */
router.get('/', requirePermission('absence.read.self'), (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const hasManaged = checkUserPermission(user.roles, 'absence.read.managed');
  const targetUserId = req.query.userId ? parseInt(req.query.userId as string, 10) : null;
  const yearMonth = req.query.yearMonth as string;

  // 一般教員が他人の欠勤を明示的に指定した場合の拒否
  if (!hasManaged && targetUserId && targetUserId !== user.id) {
    res.status(403).json({ success: false, message: '他職員の欠勤データを閲覧する権限がありません' });
    return;
  }

  const db = getDb();
  let query = `
    SELECT a.*, 
           u.display_name as user_name,
           u.department as user_department,
           ru.display_name as registered_by_name,
           cu.display_name as confirmed_by_name
    FROM absences a
    JOIN users u ON a.user_id = u.id
    LEFT JOIN users ru ON a.registered_by_user_id = ru.id
    LEFT JOIN users cu ON a.confirmed_by_user_id = cu.id
    WHERE 1=1
  `;
  const params: any[] = [];

  if (!hasManaged) {
    query += ' AND a.user_id = ?';
    params.push(user.id);
  } else if (targetUserId) {
    query += ' AND a.user_id = ?';
    params.push(targetUserId);
  }

  if (yearMonth) {
    query += ' AND a.target_date LIKE ?';
    params.push(`${yearMonth}-%`);
  }

  query += ' ORDER BY a.target_date DESC, a.id DESC';

  const rows = db.prepare(query).all(...params) as any[];

  // 一般教員向けには機微情報 (reason, cancel_reason, correction_reason) をマスキング
  const sanitized = rows.map(r => {
    if (!hasManaged) {
      return {
        ...r,
        reason: '欠勤',
        cancel_reason: null,
        correction_reason: null,
      };
    }
    return r;
  });

  res.json({ success: true, data: sanitized });
});

/**
 * POST /api/absences
 * 欠勤新規登録 (管理職・事務限定)
 */
router.post('/', requirePermission('absence.manage'), (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const { userId, absenceType, targetDate, startTime, endTime, reason, status } = req.body;

  try {
    const newId = AbsenceService.createAbsence({
      userId: parseInt(userId, 10),
      absenceType,
      targetDate,
      startTime,
      endTime,
      reason,
      status,
      actor: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        ipAddress: user.ipAddress,
        userAgent: user.userAgent
      }
    });

    res.status(201).json({ success: true, message: '欠勤を登録しました', id: newId });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err.message });
  }
});

/**
 * PUT /api/absences/:id
 * 欠勤内容更新 (管理職・事務限定)
 */
router.put('/:id', requirePermission('absence.manage'), (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const id = parseInt(req.params.id as string, 10);
  const { absenceType, startTime, endTime, reason } = req.body;

  try {
    AbsenceService.updateAbsence({
      id,
      absenceType,
      startTime,
      endTime,
      reason,
      actor: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        ipAddress: user.ipAddress,
        userAgent: user.userAgent
      }
    });

    res.json({ success: true, message: '欠勤を更新しました' });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/absences/:id/cancel
 * 欠勤取消 (管理職・事務限定)
 */
router.post('/:id/cancel', requirePermission('absence.manage'), (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const id = parseInt(req.params.id as string, 10);
  const { cancelReason } = req.body;

  try {
    AbsenceService.cancelAbsence(id, cancelReason, {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      ipAddress: user.ipAddress,
      userAgent: user.userAgent
    });

    res.json({ success: true, message: '欠勤を取り消しました' });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/absences/:id/correct-to-leave
 * 欠勤から承認済休暇への事後訂正 (管理職・事務限定)
 */
router.post('/:id/correct-to-leave', requirePermission('absence.correct'), (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const id = parseInt(req.params.id as string, 10);
  const { correctionTargetType, correctedApplicationId, correctionReason } = req.body;

  try {
    AbsenceService.correctToLeave({
      id,
      correctionTargetType,
      correctedApplicationId: correctedApplicationId ? parseInt(correctedApplicationId, 10) : undefined,
      correctionReason,
      actor: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        ipAddress: user.ipAddress,
        userAgent: user.userAgent
      }
    });

    res.json({ success: true, message: '欠勤から休暇への事後訂正を完了しました' });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err.message });
  }
});

export default router;
