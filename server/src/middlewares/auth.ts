import { Request, Response, NextFunction } from 'express';
import { UserContext } from '../workflow/engine';
import { logAudit } from '../utils/auditLogger';
import { getDb } from '../db/database';
import { PermissionId } from '../types';

// ExpressのSessionにuserIdを追加するための型拡張
declare module 'express-session' {
  interface SessionData {
    user?: {
      id: number;
      username: string;
      displayName: string;
      department: string;
      roles: string[];
      mustChangePassword?: boolean;
      authVersion?: number;
    };
  }
}

/**
 * リクエストからユーザーコンテキストを取得
 */
export function getUserContext(req: Request): UserContext | null {
  if (!req.session || !req.session.user) {
    return null;
  }
  const ip = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '127.0.0.1';
  return {
    id: req.session.user.id,
    username: req.session.user.username,
    displayName: req.session.user.displayName,
    roles: req.session.user.roles,
    mustChangePassword: req.session.user.mustChangePassword,
    authVersion: req.session.user.authVersion,
    ipAddress: ip,
    userAgent: req.headers['user-agent'],
  };
}

/**
 * ログイン必須ミドルウェア (auth_version 照合を含む)
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const sessionUser = req.session?.user;
  if (!sessionUser) {
    res.status(401).json({ success: false, message: 'ログインが必要です' });
    return;
  }

  // DB から最新の auth_version, is_active, must_change_password を取得
  const db = getDb();
  const dbUser = db.prepare('SELECT id, is_active, must_change_password, auth_version FROM users WHERE id = ?').get(sessionUser.id) as any;

  if (!dbUser || dbUser.is_active === 0) {
    req.session.destroy(() => {});
    res.status(401).json({ success: false, message: 'ユーザーが存在しないか無効化されています' });
    return;
  }

  // auth_version 照合 (不一致時は失効)
  const expectedAuthVersion = dbUser.auth_version || 1;
  const currentSessionVersion = sessionUser.authVersion || 1;

  if (currentSessionVersion !== expectedAuthVersion) {
    req.session.destroy(() => {});
    res.status(401).json({
      success: false,
      errorCode: 'SESSION_CREDENTIAL_STALE',
      message: '認証情報が更新されたためセッションが無効化されました。再度ログインしてください。'
    });
    return;
  }

  // セッション側の mustChangePassword フラグを最新化
  sessionUser.mustChangePassword = dbUser.must_change_password === 1;

  next();
}

/**
 * Forced Password Change Gate (Default-Deny)
 * must_change_password === 1 のユーザーについて、明示的 Allowlist 以外の業務 API を 403 で遮断
 */
export function enforcePasswordStateGate(req: Request, res: Response, next: NextFunction): void {
  // 未認証状態（またはセッションなし）は requireAuth 側で処理させるため通過
  const sessionUser = req.session?.user;
  if (!sessionUser || !sessionUser.mustChangePassword) {
    next();
    return;
  }

  // 明示的 Allowlist:
  // - GET /api/auth/me
  // - PUT /api/auth/password
  // - POST /api/auth/logout
  // - GET /api/system/public-settings
  const rawPath = req.originalUrl ? req.originalUrl.split('?')[0] : (req.baseUrl ? `${req.baseUrl}${req.path}` : req.path);
  const path = rawPath.replace(/\/+/g, '/');
  const method = (req.method || 'GET').toUpperCase();

  const isMeRoute = (path === '/api/auth/me' || req.path === '/me' || req.path === '/api/auth/me') && method === 'GET';
  const isPasswordRoute = (path === '/api/auth/password' || req.path === '/password' || req.path === '/api/auth/password') && method === 'PUT';
  const isLogoutRoute = (path === '/api/auth/logout' || req.path === '/logout' || req.path === '/api/auth/logout') && method === 'POST';
  const isPublicSettings = (path === '/api/system/public-settings' || req.path === '/public-settings' || req.path === '/api/system/public-settings') && method === 'GET';

  if (isMeRoute || isPasswordRoute || isLogoutRoute || isPublicSettings) {
    next();
    return;
  }

  // Default-Deny: 許可リスト以外の全ルートを 403 で遮断
  const ip = (req.headers && req.headers['x-forwarded-for'] as string) || req.socket?.remoteAddress || '127.0.0.1';
  logAudit({
    userId: sessionUser.id,
    username: sessionUser.username,
    roleSnapshot: (sessionUser.roles || []).join(','),
    action: 'FORCED_PASSWORD_GATE_BLOCKED',
    targetType: 'API_ENDPOINT',
    targetId: path,
    comment: '初期/一時パスワード強制変更中のためアクセス拒否',
    ipAddress: ip,
    userAgent: req.headers ? req.headers['user-agent'] : undefined,
    isSuccess: false,
  });

  res.status(403).json({
    success: false,
    errorCode: 'FORCED_PASSWORD_CHANGE_REQUIRED',
    message: 'パスワードの変更が必要です。パスワードを変更するまで他の業務操作は行えません。',
  });
}

/**
 * 特定ロール必須ミドルウェア
 */
export function requireRole(allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = getUserContext(req);
    if (!user) {
      res.status(401).json({ success: false, message: 'ログインが必要です' });
      return;
    }

    const hasRole = user.roles.some((r) => allowedRoles.includes(r));
    if (!hasRole) {
      logAudit({
        userId: user.id,
        username: user.username,
        roleSnapshot: user.roles.join(','),
        action: 'FORBIDDEN_ACCESS',
        targetType: 'API_ENDPOINT',
        targetId: req.originalUrl,
        comment: `必要ロール [${allowedRoles.join(',')}] に対し権限不足`,
        ipAddress: user.ipAddress,
        userAgent: user.userAgent,
        isSuccess: false,
      });
      res.status(403).json({ success: false, message: 'この操作を行う権限がありません' });
      return;
    }

    next();
  };
}

/**
 * パーミッションベース認可ミドルウェア
 */
export function requirePermission(permission: PermissionId) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = getUserContext(req);
    if (!user) {
      res.status(401).json({ success: false, message: 'ログインが必要です' });
      return;
    }

    const db = getDb();
    const placeholders = user.roles.map(() => '?').join(',');
    if (user.roles.length === 0) {
      res.status(403).json({ success: false, message: 'パーミッションが付与されていません' });
      return;
    }

    const stmt = db.prepare(`
      SELECT 1 FROM role_permissions
      WHERE role_id IN (${placeholders}) AND permission_id = ?
      LIMIT 1
    `);

    const hasPermission = stmt.get(...user.roles, permission);
    if (!hasPermission) {
      logAudit({
        userId: user.id,
        username: user.username,
        roleSnapshot: user.roles.join(','),
        action: 'FORBIDDEN_PERMISSION_ACCESS',
        targetType: 'PERMISSION',
        targetId: permission,
        comment: `必要パーミッション [${permission}] に対し権限不足 (Roles: [${user.roles.join(',')}])`,
        ipAddress: user.ipAddress,
        userAgent: user.userAgent,
        isSuccess: false,
      });
      res.status(403).json({ success: false, message: `この操作を行う権限 (${permission}) がありません` });
      return;
    }

    next();
  };
}

/**
 * ユーザーが特定パーミッションを持つか判定するヘルパー
 */
export function checkUserPermission(roles: string[], permission: PermissionId): boolean {
  if (!roles || roles.length === 0) return false;
  const db = getDb();
  const placeholders = roles.map(() => '?').join(',');
  const stmt = db.prepare(`
    SELECT 1 FROM role_permissions
    WHERE role_id IN (${placeholders}) AND permission_id = ?
    LIMIT 1
  `);
  return !!stmt.get(...roles, permission);
}
