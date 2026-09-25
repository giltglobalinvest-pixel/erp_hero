import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LONG_TTL_MS, SHORT_TTL_MS } from '../server/auth/sessions.js';
import { SecretStore } from '../server/secrets/store.js';
import { createTestContext, type TestContext } from './helpers/context.js';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.close();
});

const login = (key: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  ctx.req('/api/auth', { method: 'POST', body: { user_key: key, ...extra }, headers });

describe('POST /api/auth', () => {
  it('logs in with a valid key and returns the proxy-compatible user object', async () => {
    const u = await ctx.createUser({ name: 'Anna', role: 'Vertrieb', companies: ['recC1'] });
    await ctx.deps.db.write((tx) => ctx.deps.secrets.mergeFreshdeskKeys(tx, u.id, { recC1: 'k1' }));
    const res = await login(`  ${u.key}  `);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      expires_in: SHORT_TTL_MS / 1000,
      user: {
        id: u.id,
        name: 'Anna',
        role: 'Vertrieb',
        is_admin: false,
        allowed_companies: ['recC1'],
        has_freshdesk_key: false,
        freshdesk_company_keys: ['recC1'],
      },
    });
    expect(JSON.stringify(body)).not.toContain(u.key);
  });

  it('sets an httpOnly SameSite=Strict session cookie (session cookie unless long_lived)', async () => {
    const u = await ctx.createUser();
    const short = (await login(u.key)).headers.get('set-cookie') ?? '';
    expect(short).toMatch(/^erp_session=/);
    expect(short).toContain('HttpOnly');
    expect(short).toContain('SameSite=Strict');
    expect(short).toContain('Path=/');
    expect(short).not.toContain('Max-Age');
    const long = await login(u.key, { long_lived: true });
    expect((await long.json()).expires_in).toBe(LONG_TTL_MS / 1000);
    expect(long.headers.get('set-cookie')).toContain(`Max-Age=${LONG_TTL_MS / 1000}`);
  });

  it('uses a __Host- Secure cookie in production', async () => {
    const prod = await createTestContext({ env: { NODE_ENV: 'production' } });
    try {
      const u = await prod.createUser();
      const res = await prod.req('/api/auth', { method: 'POST', body: { user_key: u.key } });
      const cookie = res.headers.get('set-cookie') ?? '';
      expect(cookie).toMatch(/^__Host-erp_session=/);
      expect(cookie).toContain('Secure');
      const me = await prod.req('/api/me', { cookie: cookie.split(';')[0] });
      expect(me.status).toBe(200);
    } finally {
      await prod.close();
    }
  });

  it('still logs in after SECRETS_KEY changed; keys that no longer decrypt count as not set and are logged', async () => {
    const u = await ctx.createUser({ name: 'Rita' });
    const previous = new SecretStore(ctx.deps.db, Buffer.alloc(32, 1));
    await ctx.deps.db.write(async (tx) => {
      await previous.setFreshdeskDefault(tx, u.id, 'old-default');
      await previous.mergeFreshdeskKeys(tx, u.id, { recC1: 'old-c1' });
    });
    const res = await login(u.key);
    expect(res.status).toBe(200);
    expect((await res.json()).user).toMatchObject({ name: 'Rita', has_freshdesk_key: false, freshdesk_company_keys: [] });
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect((await ctx.req('/api/me', { cookie })).status).toBe(200);
    expect(ctx.logs.some((entry) => String(entry.secret ?? '').includes(u.id))).toBe(true);
    expect(JSON.stringify(ctx.logs)).not.toMatch(/old-default|old-c1|v1:/);
  });

  it('refuses oversized login bodies with 413 instead of buffering them', async () => {
    const res = await login('x', { pad: 'x'.repeat(64 * 1024) });
    expect(res.status).toBe(413);
    expect((await res.json()).error.type).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects wrong keys, inactive users and missing keys', async () => {
    const inactive = await ctx.createUser({ status: 'inaktiv' });
    expect((await login('wrong-key-wrong-key')).status).toBe(401);
    const res = await login(inactive.key);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { type: 'UNAUTHENTICATED', message: 'Ungültiger Login-Key oder Account inaktiv' },
    });
    expect((await login('')).status).toBe(400);
    expect((await ctx.req('/api/auth', { method: 'POST', body: 'not json' })).status).toBe(400);
  });

  it('rate-limits after 5 failures per IP within 15 minutes, then recovers', async () => {
    const u = await ctx.createUser();
    const ip = { 'x-forwarded-for': '1.1.1.1, 203.0.113.9' };
    for (let i = 0; i < 5; i++) expect((await login('bad-bad-bad-bad', {}, ip)).status).toBe(401);
    const blocked = await login(u.key, {}, ip);
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error.type).toBe('RATE_LIMITED');
    // A different client IP (right-most X-Forwarded-For entry) is not blocked.
    expect((await login(u.key, {}, { 'x-forwarded-for': '203.0.113.10' })).status).toBe(200);
    ctx.clock.now += 15 * 60 * 1000 + 1;
    expect((await login(u.key, {}, ip)).status).toBe(200);
  });

  it('rate-limits globally after 30 failures from many IPs', async () => {
    const u = await ctx.createUser();
    for (let i = 0; i < 30; i++) await login('bad-bad-bad-bad', {}, { 'x-forwarded-for': `10.0.0.${i}` });
    expect((await login(u.key, {}, { 'x-forwarded-for': '10.9.9.9' })).status).toBe(429);
  });

  it('rejects requests from a foreign origin', async () => {
    const u = await ctx.createUser();
    expect((await login(u.key, {}, { origin: 'https://evil.example' })).status).toBe(403);
    const noOrigin = await ctx.app.request('/api/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_key: u.key }),
    });
    expect(noOrigin.status).toBe(403);
    const sameOrigin = await ctx.app.request('/api/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ user_key: u.key }),
    });
    expect(sameOrigin.status).toBe(200);
  });
});

describe('sessions', () => {
  it('GET /api/me returns the current user; no cookie means 401', async () => {
    const { id, cookie } = await ctx.loginAs({ name: 'Ben', isAdmin: true });
    const me = await ctx.req('/api/me', { cookie });
    expect(me.status).toBe(200);
    expect((await me.json()).user).toMatchObject({ id, name: 'Ben', is_admin: true, freshdesk_company_keys: [] });
    const anon = await ctx.req('/api/me');
    expect(anon.status).toBe(401);
    expect(await anon.json()).toEqual({
      error: { type: 'UNAUTHENTICATED', message: 'Nicht angemeldet oder Sitzung abgelaufen' },
    });
  });

  it('does not accept the raw login key as a bearer token or cookie', async () => {
    const u = await ctx.createUser();
    expect((await ctx.req('/api/me', { headers: { authorization: `Bearer ${u.key}` } })).status).toBe(401);
    expect((await ctx.req('/api/me', { cookie: `erp_session=${u.key}` })).status).toBe(401);
  });

  it('expires short sessions after 8 hours and clears the cookie', async () => {
    const { cookie } = await ctx.loginAs();
    ctx.clock.now += SHORT_TTL_MS - 1000;
    expect((await ctx.req('/api/me', { cookie })).status).toBe(200);
    ctx.clock.now += 2000;
    const res = await ctx.req('/api/me', { cookie });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toMatch(/erp_session=;/);
  });

  it('keeps long-lived sessions for 30 days', async () => {
    const u = await ctx.createUser();
    const cookie = await ctx.login(u.key, true);
    ctx.clock.now += LONG_TTL_MS - 1000;
    expect((await ctx.req('/api/me', { cookie })).status).toBe(200);
    ctx.clock.now += 2000;
    expect((await ctx.req('/api/me', { cookie })).status).toBe(401);
  });

  it('applies deactivation and admin changes on the very next request', async () => {
    const { id, cookie } = await ctx.loginAs({ isAdmin: true });
    await ctx.deps.db.write((tx) => ctx.deps.records.update(tx, 'User', id, {}, ['is_admin']));
    expect((await (await ctx.req('/api/me', { cookie })).json()).user.is_admin).toBe(false);
    await ctx.deps.db.write((tx) => ctx.deps.records.update(tx, 'User', id, { status: 'inaktiv' }, []));
    expect((await ctx.req('/api/me', { cookie })).status).toBe(401);
    await ctx.deps.db.write((tx) => ctx.deps.records.update(tx, 'User', id, { status: 'aktiv' }, []));
    expect((await ctx.req('/api/me', { cookie })).status).toBe(401); // the session was deleted
  });

  it('POST /api/logout deletes the session and is idempotent', async () => {
    const { cookie } = await ctx.loginAs();
    const out = await ctx.req('/api/logout', { method: 'POST', cookie });
    expect(out.status).toBe(200);
    expect(await out.json()).toEqual({ ok: true });
    expect((await ctx.req('/api/me', { cookie })).status).toBe(401);
    expect((await ctx.req('/api/logout', { method: 'POST' })).status).toBe(200);
  });

  it('GET /api/health mirrors the proxy health response', async () => {
    const { cookie } = await ctx.loginAs({ name: 'Cara' });
    expect(await (await ctx.req('/api/health', { cookie })).json()).toEqual({
      ok: true,
      auth_kind: 'session',
      user: { name: 'Cara', is_admin: false, has_freshdesk_key: false, freshdesk_company_keys: [] },
    });
  });

  it('POST /api/sessions/revoke-user is admin-only and kills all sessions of a user', async () => {
    const victim = await ctx.createUser();
    const c1 = await ctx.login(victim.key);
    const c2 = await ctx.login(victim.key);
    const nonAdmin = await ctx.loginAs();
    const denied = await ctx.req('/api/sessions/revoke-user', {
      method: 'POST',
      cookie: nonAdmin.cookie,
      body: { user_id: victim.id },
    });
    expect(denied.status).toBe(403);
    const admin = await ctx.loginAs({ isAdmin: true });
    const res = await ctx.req('/api/sessions/revoke-user', { method: 'POST', cookie: admin.cookie, body: { user_id: victim.id } });
    expect(await res.json()).toEqual({ revoked: 2 });
    expect((await ctx.req('/api/me', { cookie: c1 })).status).toBe(401);
    expect((await ctx.req('/api/me', { cookie: c2 })).status).toBe(401);
  });

  it('stores only token hashes in the database', async () => {
    const { cookie } = await ctx.loginAs();
    const token = cookie.split('=')[1] ?? '';
    const rows = await ctx.deps.db.query('SELECT * FROM sessions');
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('purges expired sessions', async () => {
    await ctx.loginAs();
    ctx.clock.now += SHORT_TTL_MS + 1;
    expect(await ctx.deps.sessions.purgeExpired()).toBe(1);
  });
});
