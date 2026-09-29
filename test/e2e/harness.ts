import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { expect } from 'vitest';
import { createApp } from '../../server/app.js';
import { hashLoginKey } from '../../server/auth/passwords.js';
import { loadConfig } from '../../server/config.js';
import { openDatabase } from '../../server/db/database.js';
import { runMigrations } from '../../server/db/migrations.js';
import { buildDeps, type AppDeps } from '../../server/deps.js';
import type { Logger } from '../../server/http/logger.js';
import { newLoginKey } from '../../server/util/ids.js';
import { ROOT_DIR, testEnv } from '../helpers/context.js';
import { FakeFetch } from '../helpers/fakeFetch.js';

export type Who = 'admin' | 'vera';
export interface SeededUser {
  id: string;
  key: string;
  name: string;
}

export interface Harness {
  baseUrl: string;
  deps: AppDeps;
  fake: FakeFetch;
  logs: Record<string, unknown>[];
  companies: { alpha: string; beta: string };
  users: Record<Who, SeededUser>;
  newPage(opts?: { serviceWorkers?: 'allow' | 'block' }): Promise<Page>;
  login(page: Page, who: Who, longLived?: boolean): Promise<void>;
  openApp(page: Page, who?: Who): Promise<void>;
  apiAs<T = unknown>(who: Who, method: string, path: string, body?: unknown): Promise<T>;
  run<T>(page: Page, body: string): Promise<T>;
  runError(page: Page, body: string): Promise<{ message: string; status?: number; type?: string }>;
  assertClean(page: Page): Promise<void>;
  resetContexts(): Promise<void>;
  close(): Promise<void>;
}

// Tailwind is replaced by the few classes that decide visibility.
const TAILWIND_STUB = `window.tailwind = { config: {} };
(function () {
  var s = document.createElement('style');
  s.textContent = '.hidden{display:none!important}.invisible{visibility:hidden!important}';
  document.head.appendChild(s);
})();`;
const LUCIDE_STUB = 'window.lucide = { createIcons: function () {} };';
// Lazily loaded editor/PDF libraries and fonts: aborted without failing the test.
const QUIET_ABORT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com']);
const CSP_REPORTER = `document.addEventListener('securitypolicyviolation', function (e) {
  try { window.__e2eCsp(e.violatedDirective + ' ' + e.blockedURI); } catch (_) {}
});`;

interface PageState {
  forbidden: string[];
  csp: string[];
  errors: string[];
}

export async function startHarness(): Promise<Harness> {
  // The handler is attached once the port is known, so PUBLIC_ORIGIN matches the page's Origin exactly.
  let handler: ((request: Request, env: unknown) => Response | Promise<Response>) | null = null;
  let server!: ServerType;
  const port = await new Promise<number>((resolve) => {
    server = serve(
      {
        fetch: (request, env) => (handler ? handler(request, env) : new Response('starting', { status: 503 })),
        port: 0,
        hostname: '127.0.0.1',
      },
      (info) => resolve(info.port),
    );
  });
  const baseUrl = `http://127.0.0.1:${port}`;

  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'erp-e2e-'));
  const config = loadConfig(testEnv(dataDir, { PUBLIC_ORIGIN: baseUrl }), ROOT_DIR);
  const db = await openDatabase(path.join(dataDir, 'erp.db'));
  await runMigrations(db);
  const fake = new FakeFetch();
  const logs: Record<string, unknown>[] = [];
  const logger: Logger = { info: (e) => logs.push(e), error: (e) => logs.push(e) };
  const deps = buildDeps({ config, db, fetch: fake.fetch, logger });
  const app = createApp(deps);
  handler = (request, env) => app.fetch(request, env);

  const insert = (table: 'Company' | 'User', fields: Record<string, unknown>) =>
    deps.db.write((tx) => deps.records.insert(tx, table, fields));
  const alpha = await insert('Company', { name: 'Alpha GmbH', status: 'aktiv' });
  const beta = await insert('Company', { name: 'Beta AG', status: 'aktiv' });

  const seedUser = async (fields: Record<string, unknown>, freshdesk?: Record<string, string>): Promise<SeededUser> => {
    const key = newLoginKey();
    const hash = await hashLoginKey(key);
    const record = await deps.db.write(async (tx) => {
      const r = await deps.records.insert(tx, 'User', { status: 'aktiv', ...fields });
      await deps.secrets.setApiKeyHash(tx, r.id, hash);
      if (freshdesk) await deps.secrets.mergeFreshdeskKeys(tx, r.id, freshdesk);
      return r;
    });
    return { id: record.id, key, name: String(fields.name) };
  };
  const users: Record<Who, SeededUser> = {
    admin: await seedUser({ name: 'Ada Admin', role: 'Geschäftsführung', is_admin: true }),
    vera: await seedUser(
      { name: 'Vera Vertrieb', role: 'Vertrieb', allowed_companies: [alpha.id, beta.id] },
      { [alpha.id]: 'fd-key-alpha' },
    ),
  };

  const browser: Browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const contexts: BrowserContext[] = [];
  const states = new WeakMap<Page, PageState>();

  const newPage = async (opts: { serviceWorkers?: 'allow' | 'block' } = {}): Promise<Page> => {
    const context = await browser.newContext({ serviceWorkers: opts.serviceWorkers ?? 'block' });
    contexts.push(context);
    const state: PageState = { forbidden: [], csp: [], errors: [] };
    await context.exposeBinding('__e2eCsp', (_source, text: string) => {
      state.csp.push(text);
    });
    await context.addInitScript(CSP_REPORTER);
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === baseUrl) return route.continue();
      if (url.hostname === 'cdn.tailwindcss.com') {
        return route.fulfill({ contentType: 'application/javascript', body: TAILWIND_STUB });
      }
      if (url.hostname === 'unpkg.com') return route.fulfill({ contentType: 'application/javascript', body: LUCIDE_STUB });
      if (QUIET_ABORT_HOSTS.has(url.hostname)) return route.abort();
      state.forbidden.push(`${request.method()} ${url.origin}${url.pathname}`);
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => state.errors.push(e.message));
    states.set(page, state);
    return page;
  };

  const login = async (page: Page, who: Who, longLived = false): Promise<void> => {
    const res = await page.context().request.post(`${baseUrl}/api/auth`, {
      data: { user_key: users[who].key, long_lived: longLived },
      headers: { origin: baseUrl },
    });
    if (res.status() !== 200) throw new Error(`login as ${who} failed: ${res.status()}`);
  };

  const openApp = async (page: Page, who?: Who): Promise<void> => {
    if (who) await login(page, who);
    await page.goto(`${baseUrl}/`);
    await page.waitForSelector('#loginScreen:not(.hidden), #appShell:not(.hidden)', { state: 'visible' });
  };

  // In-process calls: test/setup.ts disables fetch, and app.request needs no network.
  const apiAs = async <T = unknown>(who: Who, method: string, apiPath: string, body?: unknown): Promise<T> => {
    const auth = await app.request('/api/auth', {
      method: 'POST',
      headers: { origin: baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ user_key: users[who].key }),
    });
    if (auth.status !== 200) throw new Error(`apiAs login as ${who} failed: ${auth.status}`);
    const cookie = (auth.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const headers: Record<string, string> = { origin: baseUrl, cookie };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await app.request(apiPath, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`apiAs ${method} ${apiPath} -> ${res.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : null) as T;
  };

  const run = <T>(page: Page, body: string): Promise<T> =>
    page.evaluate(`(async () => { ${body}\n})()`) as Promise<T>;

  const runError = async (page: Page, body: string) => {
    const result = await page.evaluate(`(async () => {
      try { await (async () => { ${body}\n})(); return null; }
      catch (e) { return { message: String(e && e.message), status: e && e.status, type: e && e.type }; }
    })()`);
    if (result === null) throw new Error('expected the page script to throw');
    return result as { message: string; status?: number; type?: string };
  };

  const assertClean = async (page: Page): Promise<void> => {
    const state = states.get(page);
    if (!state) throw new Error('page was not created by the harness');
    expect({ forbidden: state.forbidden, csp: state.csp, pageErrors: state.errors }).toEqual({
      forbidden: [],
      csp: [],
      pageErrors: [],
    });
  };

  const resetContexts = async (): Promise<void> => {
    for (const context of contexts.splice(0)) await context.close();
  };

  const close = async (): Promise<void> => {
    await resetContexts();
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  };

  return {
    baseUrl,
    deps,
    fake,
    logs,
    companies: { alpha: alpha.id, beta: beta.id },
    users,
    newPage,
    login,
    openApp,
    apiAs,
    run,
    runError,
    assertClean,
    resetContexts,
    close,
  };
}
