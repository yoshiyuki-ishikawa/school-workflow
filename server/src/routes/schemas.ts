import { Router, Request, Response } from 'express';
import { requireAuth } from '../middlewares/auth';
import { FormSchemaRegistry } from '../services/schema/formSchemaRegistry';

const router = Router();
router.use(requireAuth);

/**
 * 申請種別の最新Active入力スキーマ取得
 */
router.get('/:typeId', (req: Request, res: Response): void => {
  const typeId = Array.isArray(req.params.typeId) ? req.params.typeId[0] : req.params.typeId;
  const targetDate = (typeof req.query.date === 'string' ? req.query.date : undefined) || new Date().toISOString().split('T')[0];

  const schema = FormSchemaRegistry.resolveActiveSchema(typeId, targetDate);
  if (!schema) {
    res.status(404).json({
      success: false,
      errorCode: 'SCHEMA_NOT_FOUND',
      message: `申請種別（${typeId}）の入力スキーマが存在しません`
    });
    return;
  }

  res.json({
    success: true,
    schema
  });
});

/**
 * 全申請種別のActive入力スキーマ一覧取得
 */
router.get('/', (req: Request, res: Response): void => {
  const targetDate = (typeof req.query.date === 'string' ? req.query.date : undefined) || new Date().toISOString().split('T')[0];
  const schemas = FormSchemaRegistry.getAllActiveSchemas(targetDate);
  res.json({
    success: true,
    schemas
  });
});

export default router;
