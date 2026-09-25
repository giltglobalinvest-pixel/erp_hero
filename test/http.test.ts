import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, ROOT_DIR, type TestContext } from './helpers/context.js';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.close();
});

describe('static files', () => {
  it('serves index.html byte-for-byte at / and /index.html', async () => {
    const original = await readFile(path.join(ROOT_DIR, 'index.html'));
    for (const p of ['/', '/index.html']) {
      const res = await ctx.req(p);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(Buffer.from(await res.arrayBuffer()).equals(original)).toBe(true);
    }
  });

  it('answers a matching If-None-Match with 304', async () => {
    const first = await ctx.req('/');
    const etag = first.headers.get('etag') ?? '';
    expect(etag).not.toBe('');
    const second = await ctx.req('/', { headers: { 'if-none-match': etag } });
    expect(second.status).toBe(304);
  });

  it('serves sw.js as JavaScript', async () => {
    const res = await ctx.req('/sw.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/javascript; charset=utf-8');
    expect(await res.text()).toContain('erp-hero-sw-v1');
  });

  it('redirects the loaders to /', async () => {
    for (const p of ['/loader.html', '/loader-admin.html']) {
      const res = await ctx.req(p);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/');
    }
  });

  it('does not serve other repository files', async () => {
    for (const p of ['/package.json', '/.env', '/server/main.ts', '/README.md']) {
      expect((await ctx.req(p)).status).toBe(404);
    }
  });
});

describe('health and errors', () => {
  it('GET /healthz reports ok without auth', async () => {
    const res = await ctx.req('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('unknown /api paths return a JSON 404 with no-store', async () => {
    const res = await ctx.req('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: { type: 'NOT_FOUND', message: 'Nicht gefunden' } });
  });

  it('logs one line per request with an id, and sets X-Request-Id', async () => {
    const res = await ctx.req('/healthz');
    const id = res.headers.get('x-request-id');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ctx.logs).toContainEqual(expect.objectContaining({ requestId: id, method: 'GET', path: '/healthz', status: 200 }));
  });
});

describe('security headers', () => {
  it('sets CSP and hardening headers on every response', async () => {
    const res = await ctx.req('/');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain('https://cdn.tailwindcss.com');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain('connect-src \'self\' https://flptest.freshdesk.com');
    expect(csp).not.toContain('api.airtable.com');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('permissions-policy')).toContain('microphone=(self)');
    expect(res.headers.get('strict-transport-security')).toBeNull();
  });

  it('adds HSTS in production', async () => {
    const prod = await createTestContext({ env: { NODE_ENV: 'production' } });
    try {
      const res = await prod.req('/healthz');
      expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000');
    } finally {
      await prod.close();
    }
  });
});
