import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

export const SESSION_COOKIE_NAME = 'school_workflow_session';

interface SessionData {
  user?: any;
  [key: string]: any;
}

function sign(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function encodeSession(data: SessionData, secret: string): string {
  const json = JSON.stringify(data);
  const b64 = Buffer.from(json, 'utf8').toString('base64url');
  const sig = sign(b64, secret);
  return `${b64}.${sig}`;
}

function decodeSession(raw: string, secret: string): SessionData | null {
  try {
    const [b64, sig] = raw.split('.');
    if (!b64 || !sig) return null;
    const expectedSig = sign(b64, secret);
    if (crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
      const json = Buffer.from(b64, 'base64url').toString('utf8');
      return JSON.parse(json);
    }
  } catch {
    // 不正または期限切れのCookieは破棄
  }
  return null;
}

function parseCookies(header?: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const [k, ...v] = pair.trim().split('=');
    if (k) cookies[k] = decodeURIComponent(v.join('='));
  }
  return cookies;
}

/**
 * Vercelなどのサーバーレス環境に特化したステートレス署名付きCookieセッションミドルウェア
 * インメモリの揮発やコンテナ分散に依存せず、常にセッション状態を完全に維持します。
 */
export function statelessSession(secret: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const cookies = parseCookies(req.headers.cookie);
    const raw = cookies[SESSION_COOKIE_NAME];
    const initialData = raw ? decodeSession(raw, secret) : null;

    let sessionData: SessionData = initialData ? { ...initialData } : {};
    let isDestroyed = false;

    // express-session 互換のインターフェース
    const sessionProxy = {
      get user() {
        return sessionData.user;
      },
      set user(val: any) {
        sessionData.user = val;
      },
      regenerate(cb?: (err?: any) => void) {
        sessionData = {};
        isDestroyed = false;
        if (cb) cb();
      },
      destroy(cb?: (err?: any) => void) {
        sessionData = {};
        isDestroyed = true;
        res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
        if (cb) cb();
      },
    };

    (req as any).session = sessionProxy;

    // レスポンス送信時に Cookie を設定
    const originalEnd = res.end;
    res.end = function (...args: any[]) {
      if (isDestroyed) {
        res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
      } else if (sessionData && Object.keys(sessionData).length > 0 && sessionData.user) {
        const token = encodeSession(sessionData, secret);
        const isProduction = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
        const cookieParts = [
          `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
          'Path=/',
          'HttpOnly',
          'SameSite=Lax',
          `Max-Age=${60 * 60 * 24 * 7}`, // 7日間有効
        ];
        if (isProduction) {
          cookieParts.push('Secure');
        }
        res.setHeader('Set-Cookie', cookieParts.join('; '));
      }
      return (originalEnd as any).apply(res, args);
    };

    next();
  };
}
