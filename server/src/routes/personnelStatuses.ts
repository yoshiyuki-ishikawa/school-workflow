import { Router } from 'express';
import { requireAuth, getUserContext, requirePermission, checkUserPermission } from '../middlewares/auth';
import { PersonnelService } from '../services/personnelService';
import { getDb } from '../db/database';

const router = Router();

// 全エンドポイントで認証必須
router.use(requireAuth);

/**
 * GET /api/personnel-statuses
 * 人事身分一覧取得 (基本閲覧 or restricted閲覧)
 */
router.get('/', requirePermission('personnel.status.read.basic'), (req, res) => {
  const user = getUserContext(req)!;
  const hasRestricted = checkUserPermission(user.roles, 'personnel.status.read.restricted');
  const db = getDb();

  const rows = db.prepare(`
    SELECT ps.*, u.display_name, u.department, pr.official_name, pr.display_code
    FROM personnel_statuses ps
    JOIN users u ON ps.user_id = u.id
    LEFT JOIN policy_rules pr ON ps.policy_rule_id = pr.id
    ORDER BY ps.effective_from DESC, ps.id DESC
  `).all() as any[];

  // restricted 権限がない場合はセンシティブ情報を中立記号・中立名へマスキング（別略号への偽装禁止）
  const masked = rows.map(r => {
    const isSensitive = ['SUSPENSION', 'DISCIPLINARY_SUSPENSION'].includes(r.status_type);
    if (!hasRestricted && isSensitive) {
      return {
        id: r.id,
        user_id: r.user_id,
        display_name: r.display_name,
        department: r.department,
        status_type: 'MASKED_STATUS',
        official_name: '***',
        display_code: '-',
        effective_from: r.effective_from,
        effective_to: r.effective_to,
        status: r.status,
        authority_basis: r.authority_basis,
        order_authority_snapshot: '***',
        reason_code: 'CONFIDENTIAL',
        document_reference_no: null
      };
    }
    return r;
  });

  res.json({ success: true, data: masked });
});

/**
 * POST /api/personnel-statuses
 * 人事発令新規登録 Command API
 */
router.post('/', requirePermission('personnel.status.manage'), (req, res) => {
  const user = getUserContext(req)!;
  const { userId, statusType, effectiveFrom, effectiveTo, documentReferenceNo, issuedAt, authorityBasis, reasonCode } = req.body;

  if (!userId || !statusType || !effectiveFrom || !reasonCode) {
    res.status(400).json({ success: false, message: '必須項目が不足しています' });
    return;
  }

  try {
    const id = PersonnelService.createStatus({
      userId: Number(userId),
      statusType,
      effectiveFrom,
      effectiveTo: effectiveTo || null,
      documentReferenceNo,
      issuedAt,
      authorityBasis,
      reasonCode,
      actorUserId: user.id
    });
    res.json({ success: true, id, message: '人事発令を登録しました' });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/personnel-statuses/:id/amend
 * 人事発令訂正 Command API
 */
router.post('/:id/amend', requirePermission('personnel.status.manage'), (req, res) => {
  const user = getUserContext(req)!;
  const id = parseInt(req.params.id as string, 10);
  const { newEffectiveFrom, newEffectiveTo, newDocumentReferenceNo, newIssuedAt, newAuthorityBasis, amendmentReason } = req.body;

  if (!newEffectiveFrom || !amendmentReason) {
    res.status(400).json({ success: false, message: '新開始日 (newEffectiveFrom) および訂正理由 (amendmentReason) は必須です' });
    return;
  }

  try {
    const newId = PersonnelService.amendStatus({
      statusId: id,
      newEffectiveFrom,
      newEffectiveTo,
      newDocumentReferenceNo,
      newIssuedAt,
      newAuthorityBasis,
      amendmentReason,
      actorUserId: user.id
    });
    res.json({ success: true, newId, message: '人事発令を訂正しました' });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/personnel-statuses/:id/cancel
 * 人事発令取消 Command API
 */
router.post('/:id/cancel', requirePermission('personnel.status.manage'), (req, res) => {
  const user = getUserContext(req)!;
  const id = parseInt(req.params.id as string, 10);
  const { cancellationReason } = req.body;

  if (!cancellationReason) {
    res.status(400).json({ success: false, message: '取消理由 (cancellationReason) は必須です' });
    return;
  }

  try {
    PersonnelService.cancelStatus({
      statusId: id,
      cancellationReason,
      actorUserId: user.id
    });
    res.json({ success: true, message: '人事発令を取り消しました' });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/personnel-statuses/:id/return-to-duty
 * 復職 Command API
 */
router.post('/:id/return-to-duty', requirePermission('personnel.status.manage'), (req, res) => {
  const user = getUserContext(req)!;
  const id = parseInt(req.params.id as string, 10);
  const { returnDate, comment } = req.body;

  if (!returnDate) {
    res.status(400).json({ success: false, message: '復職日 (returnDate) は必須です' });
    return;
  }

  try {
    PersonnelService.returnToDuty(id, returnDate, user.id, comment);
    res.json({ success: true, message: '復職発令を反映しました' });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/personnel-statuses/:id/extend
 * 期間延長 Command API
 */
router.post('/:id/extend', requirePermission('personnel.status.manage'), (req, res) => {
  const user = getUserContext(req)!;
  const id = parseInt(req.params.id as string, 10);
  const { newEffectiveTo, comment } = req.body;

  if (!newEffectiveTo) {
    res.status(400).json({ success: false, message: '新しい終了日 (newEffectiveTo) は必須です' });
    return;
  }

  try {
    PersonnelService.extendPeriod(id, newEffectiveTo, user.id, comment);
    res.json({ success: true, message: '期間を延長しました' });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err.message });
  }
});

export default router;
