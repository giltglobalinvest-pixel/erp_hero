import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppDeps } from '../deps.js';
import type { AppEnv } from '../types.js';
import { ApiError, jsonError } from '../util/errors.js';
import { isActiveUser, toSessionUser } from './users.js';

export const COOKIE_NAME = 'erp_session';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Production uses the "__Host-" prefix, which requires Secure; local dev over http cannot. */
const cookiePrefix = (secure: boolean) => (secure ? ('host' as const) : undefined);

export function readSessionCookie(c: Context, secure: boolean): string | undefined {
  return getCookie(c, COOKIE_NAME, cookiePrefix(secure));
}

export function writeSessionCookie(c: Context, secure: boolean, token: string, maxAgeSeconds?: number): void {
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    secure,
    sameSite: 'Strict',
    path: '/',
    prefix: cookiePrefix(secure),
    ...(maxAgeSeconds !== undefined ? { maxAge: maxAgeSeconds } : {}),
  });
}

export function clearSessionCookie(c: Context, secure: boolean): void {
  deleteCookie(c, COOKIE_NAME, { path: '/', secure, prefix: cookiePrefix(secure) });
}

/** Right-most X-Forwarded-For entry (appended by Railway's edge), else the socket address. */
export function clientIp(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) {
    const last = forwarded
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .at(-1);
    if (last) return last;
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Blocks state-changing requests that do not come from our own page. */
export function originCheck(publicOrigin: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (UNSAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header('origin');
      const ok = origin ? origin === publicOrigin : c.req.header('sec-fetch-site') === 'same-origin';
      if (!ok) throw new ApiError('FORBIDDEN', 'Anfrage von fremder Herkunft abgelehnt');
    }
    await next();
  };
}

/** Loads the session and the user's CURRENT record; rejects missing/expired sessions and inactive users. */
export function requireAuth(deps: AppDeps): MiddlewareHandler<AppEnv> {
  const secure = deps.config.isProduction;
  return async (c, next) => {
    const reject = () => {
      clearSessionCookie(c, secure);
      return jsonError(c, 'UNAUTHENTICATED', 'Nicht angemeldet oder Sitzung abgelaufen');
    };
    const token = readSessionCookie(c, secure);
    if (!token) return reject();
    const session = await deps.sessions.lookup(token);
    if (!session) return reject();
    const record = await deps.records.get('User', session.userId);
    if (!record || !isActiveUser(record)) {
      await deps.sessions.delete(session.tokenHash);
      return reject();
    }
    c.set('user', toSessionUser(record));
    c.set('sessionTokenHash', session.tokenHash);
    await next();
  };
}

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('user').isAdmin) throw new ApiError('FORBIDDEN', 'Nur für Admins');
  await next();
};
