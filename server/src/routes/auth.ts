import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { getDb } from '../db/database';
import { config } from '../config';
import { getUserContext, requireAuth } from '../middlewares/auth';
import { logAudit, logAuditStrict } from '../utils/auditLogger';
import { validatePermanentPassword } from '../domain/auth/passwordPolicy';

const router = Router();

/**
 * ログイン
 */
router.post('/login', (req: Request, res: Response): void => {
  const { username, password } = req.body;
  const ip = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '127.0.0.1';

  if (!username || !password) {
    res.status(400).json({ success: false, message: 'ユーザー名とパスワードを入力してください' });
    return;
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any;

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    logAudit({
      username: username,
      action: 'LOGIN_FAILED',
      targetType: 'AUTH',
      comment: '認証失敗（パスワード不一致または存在しないユーザー）',
      ipAddress: ip,
      userAgent: req.headers['user-agent'],
      isSuccess: false,
    });
    res.status(401).json({ success: false, message: 'ユーザー名またはパスワードが正しくありません' });
    return;
  }

  if (user.is_active === 0) {
    logAudit({
      userId: user.id,
      username: user.username,
      action: 'LOGIN_FAILED_INACTIVE',
      targetType: 'AUTH',
      comment: '無効化されたアカウントでのログイン試行',
      ipAddress: ip,
      userAgent: req.headers['user-agent'],
      isSuccess: false,
    });
    res.status(403).json({ success: false, message: 'このアカウントは無効化されています' });
    return;
  }

  // ロール取得
  const roles = db.prepare('SELECT role_id FROM user_roles WHERE user_id = ?').all(user.id) as { role_id: string }[];
  const roleIds = roles.map((r) => r.role_id);

  // セッション再生成（セッション固定攻撃対策）
  req.session.regenerate((err) => {
    if (err) {
      res.status(500).json({ success: false, message: 'セッション生成エラー' });
      return;
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      department: user.department,
      roles: roleIds,
      mustChangePassword: user.must_change_password === 1,
      authVersion: user.auth_version || 1,
    };

    logAudit({
      userId: user.id,
      username: user.username,
      roleSnapshot: roleIds.join(','),
      action: 'LOGIN_SUCCESS',
      targetType: 'AUTH',
      targetId: user.id,
      comment: 'ログイン成功',
      ipAddress: ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({
      success: true,
      user: req.session.user,
      pocMode: config.POC_MODE,
    });
  });
});

/**
 * ログアウト
 */
router.post('/logout', (req: Request, res: Response): void => {
  const user = getUserContext(req);
  const ip = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '127.0.0.1';

  if (user) {
    logAudit({
      userId: user.id,
      username: user.username,
      roleSnapshot: user.roles.join(','),
      action: 'LOGOUT',
      targetType: 'AUTH',
      targetId: user.id,
      comment: 'ログアウト',
      ipAddress: ip,
      userAgent: req.headers['user-agent'],
    });
  }

  req.session.destroy((err) => {
    res.clearCookie('connect.sid');
    res.json({ success: true, message: 'ログアウトしました' });
  });
});

/**
 * 現在ログイン中ユーザー情報取得
 */
router.get('/me', (req: Request, res: Response): void => {
  const user = getUserContext(req);
  if (!user) {
    res.status(401).json({ success: false, user: null, pocMode: config.POC_MODE });
    return;
  }
  res.json({ success: true, user, pocMode: config.POC_MODE });
});

/**
 * パスワード変更 (Self Change / Forced Change)
 * CAS 楽観排他制御 (WHERE id = ? AND auth_version = ?) により Lost Update を完全防止
 */
router.put('/password', requireAuth, (req: Request, res: Response): void => {
  const sessionUser = req.session.user!;
  const { currentPassword, newPassword } = req.body;
  const ip = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '127.0.0.1';

  if (!newPassword) {
    res.status(400).json({ success: false, message: '新しいパスワードを入力してください' });
    return;
  }

  const db = getDb();
  const dbUser = db.prepare('SELECT * FROM users WHERE id = ?').get(sessionUser.id) as any;
  if (!dbUser) {
    res.status(404).json({ success: false, message: 'ユーザーが存在しません' });
    return;
  }

  const isForcedChange = dbUser.must_change_password === 1;

  // 通常変更時は currentPassword 検証必須
  if (!isForcedChange) {
    if (!currentPassword) {
      res.status(400).json({ success: false, message: '現在のパスワードを入力してください' });
      return;
    }
    if (!bcrypt.compareSync(currentPassword, dbUser.password_hash)) {
      logAudit({
        userId: sessionUser.id,
        username: sessionUser.username,
        action: 'PASSWORD_CHANGE_FAILED',
        targetType: 'AUTH',
        targetId: sessionUser.id,
        comment: 'パスワード変更失敗（現在のパスワード不一致）',
        ipAddress: ip,
        userAgent: req.headers['user-agent'],
        isSuccess: false,
      });
      res.status(400).json({ success: false, message: '現在のパスワードが正しくありません' });
      return;
    }
  }

  // Canonical Password Policy 検証 (Fail-Closed)
  try {
    const policyResult = validatePermanentPassword(newPassword, {
      username: dbUser.username,
      familyName: dbUser.family_name,
      givenName: dbUser.given_name,
      displayName: dbUser.display_name,
    });

    if (!policyResult.isValid) {
      logAudit({
        userId: sessionUser.id,
        username: sessionUser.username,
        action: 'PASSWORD_CHANGE_FAILED',
        targetType: 'AUTH',
        targetId: sessionUser.id,
        comment: `パスワード変更失敗（ポリシー違反: ${policyResult.errorCode}）`,
        ipAddress: ip,
        userAgent: req.headers['user-agent'],
        isSuccess: false,
      });
      res.status(400).json({
        success: false,
        errorCode: policyResult.errorCode,
        message: policyResult.errorMessage,
      });
      return;
    }
  } catch (err: any) {
    // Blocklist Missing/Malformed 時の Fail-Closed (503)
    res.status(503).json({
      success: false,
      errorCode: 'PASSWORD_POLICY_UNAVAILABLE',
      message: 'パスワード検証ポリシーが利用できません。システム管理者に連絡してください。',
    });
    return;
  }

  const newHash = bcrypt.hashSync(newPassword, 10);
  const now = new Date().toISOString();
  const expectedAuthVersion = dbUser.auth_version || 1;
  const nextAuthVersion = expectedAuthVersion + 1;

  // CAS UPDATE トランザクション
  const runTx = db.transaction(() => {
    const updateRes = db.prepare(`
      UPDATE users
      SET password_hash = ?,
          must_change_password = 0,
          auth_version = ?,
          password_changed_at = ?
      WHERE id = ? AND auth_version = ?
    `).run(newHash, nextAuthVersion, now, dbUser.id, expectedAuthVersion);

    if (updateRes.changes === 0) {
      throw {
        statusCode: 409,
        errorCode: 'AUTH_STATE_CONFLICT',
        message: '認証情報の排他制御競合が発生しました（他の操作によって更新されました）。再試行してください。',
      };
    }

    logAuditStrict({
      actorUserId: sessionUser.id,
      actorUsername: sessionUser.username,
      subjectUserId: sessionUser.id,
      action: 'PASSWORD_CHANGE',
      entityType: 'USER',
      entityId: sessionUser.id,
      afterState: 'ACTIVE',
      comment: isForcedChange ? '初回/リセット時強制パスワード変更完了' : 'パスワード自己変更完了',
      ipAddress: ip,
      userAgent: req.headers['user-agent'],
    });
  });

  try {
    runTx();

    // 現在のセッションの authVersion を更新して継続
    sessionUser.authVersion = nextAuthVersion;
    sessionUser.mustChangePassword = false;

    res.json({
      success: true,
      message: 'パスワードを変更しました',
      user: sessionUser,
    });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({
      success: false,
      errorCode: err.errorCode || 'INTERNAL_ERROR',
      message: err.message || 'パスワード更新エラー',
    });
  }
});

/**
 * 認証済みユーザー用: 代理申請・出張メンバー選択用の教職員一覧取得
 */
router.get('/members', requireAuth, (req: Request, res: Response): void => {
  const db = getDb();
  const members = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.family_name, u.given_name, u.stamp_name, u.department,
           GROUP_CONCAT(ur.role_id) as roles
    FROM users u
    LEFT JOIN user_roles ur ON u.id = ur.user_id
    WHERE u.is_active = 1
    GROUP BY u.id
    ORDER BY u.id ASC
  `).all() as any[];

  const formatted = members.map((m) => ({
    id: m.id,
    username: m.username,
    displayName: m.display_name,
    familyName: m.family_name,
    givenName: m.given_name,
    stampName: m.stamp_name,
    department: m.department,
    roles: m.roles ? m.roles.split(',') : [],
  }));

  res.json({ success: true, members: formatted });
});

/**
 * PoC専用: 検証用クイック切替ユーザー一覧
 * (POC_MODE=true の場合のみ有効。false時は404を返却)
 */
router.get('/poc-users', (req: Request, res: Response): void => {
  if (!config.POC_MODE) {
    res.status(404).json({ success: false, message: 'POC_MODE is disabled in production.' });
    return;
  }

  const db = getDb();
  const users = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.department,
           GROUP_CONCAT(ur.role_id) as roles
    FROM users u
    LEFT JOIN user_roles ur ON u.id = ur.user_id
    WHERE u.is_active = 1
    GROUP BY u.id
    ORDER BY u.id ASC
  `).all() as any[];

  const formatted = users.map((u) => ({
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    department: u.department,
    roles: u.roles ? u.roles.split(',') : [],
  }));

  res.json({ success: true, users: formatted });
});

/**
 * PoC専用: ワンクリックユーザー切り替え
 * (POC_MODE=true の場合のみ有効。false時は404を返却)
 */
router.post('/poc-switch', (req: Request, res: Response): void => {
  if (!config.POC_MODE) {
    res.status(404).json({ success: false, message: 'POC_MODE is disabled in production.' });
    return;
  }

  const { userId } = req.body;
  const ip = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '127.0.0.1';

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
  if (!user) {
    res.status(404).json({ success: false, message: '対象ユーザーが見つかりません' });
    return;
  }

  const roles = db.prepare('SELECT role_id FROM user_roles WHERE user_id = ?').all(user.id) as { role_id: string }[];
  const roleIds = roles.map((r) => r.role_id);

  req.session.regenerate((err) => {
    if (err) {
      res.status(500).json({ success: false, message: 'セッション再生成エラー' });
      return;
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      department: user.department,
      roles: roleIds,
      mustChangePassword: user.must_change_password === 1,
      authVersion: user.auth_version || 1,
    };

    logAudit({
      userId: user.id,
      username: user.username,
      roleSnapshot: roleIds.join(','),
      action: 'POC_USER_SWITCH',
      targetType: 'AUTH',
      targetId: user.id,
      comment: `[PoC検証] ${user.display_name} へユーザー切替`,
      ipAddress: ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({ success: true, user: req.session.user });
  });
});

export default router;
