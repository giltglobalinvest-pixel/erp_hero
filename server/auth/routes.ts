import { Hono } from 'hono';
import type { AppDeps } from '../deps.js';
import { limit, readJsonBody } from '../http/body.js';
import type { AppEnv } from '../types.js';
import { ApiError } from '../util/errors.js';
import { clearSessionCookie, clientIp, readSessionCookie, requireAdmin, writeSessionCookie } from './middleware.js';
import { verifyLoginKey } from './passwords.js';
import { hashToken } from './sessions.js';
import { isActiveUser, toSessionUser, userPayload } from './users.js';

/** Checks the key against every active user's hash, without stopping early. */
export async function findUserIdByKey(deps: AppDeps, key: string): Promise<string | null> {
  const users = (await deps.records.list('User')).filter(isActiveUser);
  const hashes = await deps.secrets.apiKeyHashes();
  let match: string | null = null;
  for (const user of users) {
    const hash = hashes.get(user.id);
    if (!hash) continue;
    if ((await verifyLoginKey(key, hash)) && match === null) match = user.id;
  }
  return match;
}

/** POST /auth and POST /logout work without a session. */
export function publicAuthRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const secure = deps.config.isProduction;

  // The only route that reads a body before authentication: keep it small ({user_key, long_lived}).
  app.post('/auth', limit(16 * 1024), async (c) => {
    const ip = clientIp(c);
    if (deps.limiter.isBlocked(ip)) {
      throw new ApiError('RATE_LIMITED', 'Zu viele Fehlversuche. Bitte in einigen Minuten erneut versuchen.');
    }
    const body = await readJsonBody(c);
    const key = typeof body.user_key === 'string' ? body.user_key.trim() : '';
    if (!key) throw new ApiError('INVALID_REQUEST', 'user_key fehlt');
    const userId = await findUserIdByKey(deps, key);
    const record = userId ? await deps.records.get('User', userId) : null;
    if (!record) {
      deps.limiter.recordFailure(ip);
      throw new ApiError('UNAUTHENTICATED', 'Ungültiger Login-Key oder Account inaktiv');
    }
    const longLived = body.long_lived === true;
    const session = await deps.sessions.create(record.id, longLived, c.req.header('user-agent') ?? '');
    const ttlSeconds = Math.floor(session.ttlMs / 1000);
    writeSessionCookie(c, secure, session.token, longLived ? ttlSeconds : undefined);
    const user = toSessionUser(record);
    return c.json({ expires_in: ttlSeconds, user: userPayload(user, await deps.secrets.userInfo(user.id)) });
  });

  app.post('/logout', async (c) => {
    const token = readSessionCookie(c, secure);
    if (token) await deps.sessions.delete(hashToken(token));
    clearSessionCookie(c, secure);
    return c.json({ ok: true });
  });

  return app;
}

/** Routes that need a session (mounted after requireAuth). */
export function sessionRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/me', async (c) => {
    const user = c.get('user');
    return c.json({ user: userPayload(user, await deps.secrets.userInfo(user.id)) });
  });

  app.get('/health', async (c) => {
    const user = c.get('user');
    const info = await deps.secrets.userInfo(user.id);
    return c.json({
      ok: true,
      auth_kind: 'session',
      user: {
        name: user.name,
        is_admin: user.isAdmin,
        has_freshdesk_key: info.hasFreshdeskKey,
        freshdesk_company_keys: info.freshdeskCompanyKeys,
      },
    });
  });

  app.post('/sessions/revoke-user', requireAdmin, async (c) => {
    const body = await readJsonBody(c);
    const userId = typeof body.user_id === 'string' ? body.user_id : '';
    if (!userId) throw new ApiError('INVALID_REQUEST', 'user_id fehlt');
    return c.json({ revoked: await deps.sessions.deleteForUser(userId) });
  });

  return app;
}
