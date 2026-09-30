import { Router, Request, Response } from 'express';
import { getDb } from '../db/database';

const router = Router();

/**
 * Public Settings API (未認証で取得可能な最小限の設定情報)
 * ログイン画面や共通ヘッダーでの学校名・システム表示名用
 */
router.get('/public-settings', (_req: Request, res: Response): void => {
  try {
    const db = getDb();
    const settings = db.prepare(`
      SELECT school_name, app_title
      FROM system_settings
      WHERE id = 1
    `).get() as { school_name: string; app_title: string } | undefined;

    if (!settings) {
      res.json({
        success: true,
        data: {
          schoolName: '公立小学校',
          appTitle: '学校業務ワークフローシステム',
        },
      });
      return;
    }

    res.json({
      success: true,
      data: {
        schoolName: settings.school_name,
        appTitle: settings.app_title,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
