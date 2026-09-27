import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { hang, jsonResponse } from './helpers/fakeFetch.js';

const FD = 'https://flptest.freshdesk.com/api/v2/';
const basic = (key: string) => `Basic ${Buffer.from(`${key}:X`).toString('base64')}`;

let ctx: TestContext;
let user: { id: string; cookie: string };

beforeEach(async () => {
  ctx = await createTestContext({ timeouts: { upstreamMs: 50 } });
  user = await ctx.loginAs({ companies: ['recC1'] });
});
afterEach(async () => {
  await ctx.close();
});

const fd = (path: string, o: { method?: string; body?: unknown; headers?: Record<string, string>; cookie?: string } = {}) =>
  ctx.req(`/api/freshdesk/api/v2/${path}`, { cookie: user.cookie, ...o });

describe('Freshdesk proxy', () => {
  it('forwards an allowed call with the right URL, auth and passthrough response', async () => {
    ctx.fake.on('GET', FD, () => jsonResponse({ id: 42, subject: 'Anfrage' }, 200, { 'x-internal': 'drop-me' }));
    const res = await fd('tickets/42?include=requester', { headers: { 'x-company-id': 'recC1', authorization: 'Bearer leak' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 42, subject: 'Anfrage' });
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('x-internal')).toBeNull();
    const call = ctx.fake.calls[0];
    expect(call?.url).toBe(`${FD}tickets/42?include=requester`);
    expect(call?.headers.get('authorization')).toBe(basic('env-freshdesk-key'));
    expect(call?.headers.get('cookie')).toBeNull();
  });

  it('chooses user×company key, then user default, then FRESHDESK_API_KEY', async () => {
    ctx.fake.on('GET', FD, () => jsonResponse([]));
    await ctx.deps.db.write(async (tx) => {
      await ctx.deps.secrets.setFreshdeskDefault(tx, user.id, 'user-default');
      await ctx.deps.secrets.mergeFreshdeskKeys(tx, user.id, { recC1: 'user-c1', recC2: 'user-c2' });
    });
    await fd('groups', { headers: { 'x-company-id': 'recC1' } });
    // recC2 is not in the user's allowed_companies → its key must not be used.
    await fd('groups', { headers: { 'x-company-id': 'recC2' } });
    await fd('groups');
    expect(ctx.fake.calls.map((c) => c.headers.get('authorization'))).toEqual([
      basic('user-c1'),
      basic('user-default'),
      basic('user-default'),
    ]);
  });

  it('lets admins use their key for any company', async () => {
    ctx.fake.on('GET', FD, () => jsonResponse([]));
    const admin = await ctx.loginAs({ isAdmin: true });
    await ctx.deps.db.write((tx) => ctx.deps.secrets.mergeFreshdeskKeys(tx, admin.id, { recC9: 'admin-c9' }));
    await fd('groups', { cookie: admin.cookie, headers: { 'x-company-id': 'recC9' } });
    expect(ctx.fake.calls[0]?.headers.get('authorization')).toBe(basic('admin-c9'));
  });

  it('blocks endpoints and methods that the app does not use', async () => {
    for (const [method, path] of [
      ['DELETE', 'tickets/1'],
      ['GET', 'tickets/abc'],
      ['GET', 'settings/helpdesk'],
      ['POST', 'agents'],
      ['GET', 'tickets/1/../../admin'],
    ]) {
      const res = await fd(path as string, { method: method as string });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    expect(ctx.fake.calls).toHaveLength(0);
  });

  it('passes the search query string through byte-for-byte', async () => {
    ctx.fake.on('GET', FD, () => jsonResponse({ results: [] }));
    const query = 'query=%22(group_id%3A123)%20AND%20(status%3A2%20OR%20status%3A3)%22&page=2';
    await fd(`search/tickets?${query}`);
    expect(ctx.fake.calls[0]?.url).toBe(`${FD}search/tickets?${query}`);
  });

  it('passes raw upstream errors through unchanged (the frontend parses them)', async () => {
    const body = {
      description: 'Validation failed',
      errors: [{ field: 'type', message: "It should be one of these values: 'Question,Problem'", code: 'invalid_value' }],
    };
    ctx.fake.on('GET', FD, () => jsonResponse(body, 400));
    const res = await fd('search/tickets?query=x');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(body);
  });

  it('returns 204 without a body or JSON content type', async () => {
    ctx.fake.on('DELETE', FD, () => new Response(null, { status: 204 }));
    const res = await fd('conversations/77', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(res.headers.get('content-type')).toBeNull();
    expect(await res.text()).toBe('');
  });

  it('forwards JSON bodies and multipart uploads intact', async () => {
    ctx.fake.on('PUT', FD, () => jsonResponse({ ok: true })).on('POST', FD, () => jsonResponse({ id: 1 }, 201));
    await fd('tickets/5', { method: 'PUT', body: { status: 4 } });
    expect(ctx.fake.calls[0]?.body?.toString()).toBe('{"status":4}');
    expect(ctx.fake.calls[0]?.headers.get('content-type')).toBe('application/json');

    const form = new FormData();
    form.append('subject', 'Angebot Q-1024');
    form.append('attachments[]', new Blob([Buffer.from('%PDF-1.4')], { type: 'application/pdf' }), 'Angebot Q-1024.pdf');
    const multipart = new Request('http://x', { method: 'POST', body: form });
    const contentType = multipart.headers.get('content-type') ?? '';
    const bytes = Buffer.from(await multipart.arrayBuffer());
    const res = await fd('tickets/outbound_email', { method: 'POST', body: bytes, headers: { 'content-type': contentType } });
    expect(res.status).toBe(201);
    const call = ctx.fake.calls[1];
    expect(call?.headers.get('content-type')).toBe(contentType);
    expect(call?.body?.equals(bytes)).toBe(true);
  });

  it('reports missing configuration by variable name', async () => {
    const bare = await createTestContext({ env: { FRESHDESK_API_KEY: '', FRESHDESK_DOMAIN: '' } });
    try {
      const { cookie } = await bare.loginAs();
      const noDomain = await bare.req('/api/freshdesk/api/v2/groups', { cookie });
      expect(noDomain.status).toBe(500);
      expect((await noDomain.json()).error.message).toContain('FRESHDESK_DOMAIN');
    } finally {
      await bare.close();
    }
    const noKey = await createTestContext({ env: { FRESHDESK_API_KEY: '' } });
    try {
      const { cookie } = await noKey.loginAs();
      const res = await noKey.req('/api/freshdesk/api/v2/groups', { cookie });
      expect((await res.json()).error).toMatchObject({ type: 'NOT_CONFIGURED', message: expect.stringContaining('FRESHDESK_API_KEY') });
    } finally {
      await noKey.close();
    }
  });

  it('maps network failures and timeouts to 502/504 without details', async () => {
    ctx.fake.on('GET', `${FD}groups`, () => {
      throw new TypeError('fetch failed: getaddrinfo ENOTFOUND internal-host');
    });
    ctx.fake.on('GET', `${FD}agents`, hang);
    const down = await fd('groups');
    expect(down.status).toBe(502);
    expect(await down.json()).toEqual({ error: { type: 'UPSTREAM_UNAVAILABLE', message: 'Freshdesk nicht erreichbar' } });
    const slow = await fd('agents?per_page=100');
    expect(slow.status).toBe(504);
  });

  it('requires a session and limits JSON bodies to 5 MB', async () => {
    expect((await ctx.req('/api/freshdesk/api/v2/groups')).status).toBe(401);
    const big = await fd('tickets', { method: 'POST', body: { description: 'x'.repeat(5 * 1024 * 1024 + 1) } });
    expect(big.status).toBe(413);
  });
});
