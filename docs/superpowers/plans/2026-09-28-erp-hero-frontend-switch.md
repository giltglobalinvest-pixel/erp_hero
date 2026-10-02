# ERP Hero Frontend Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `index.html` talks only to its own origin under `/api`, so a user opens the Railway URL, logs in with a login key and works on the SQLite data.

**Architecture:** One HTTP helper, `_api`, is added to `index.html`. The existing helpers (`readData`, `writeData`, `updateData`, `deleteData`, `proxyFetch`, `freshdeskFetch`, `mailchimpFetch`, `acquireLock`, `releaseLock`, `next*No`, `uploadFileToRecord`) are rewritten on top of it and keep their names, so the ~500 call sites stay untouched. A browser end-to-end suite (`playwright-core` driven from vitest) loads the real `index.html` from an in-process backend with `FakeFetch` for every upstream. A static guard test keeps Airtable, Val.town and tokens out of the file.

**Tech Stack:** plain browser JavaScript inside `index.html` (no build step); Node 22, TypeScript 6, Hono 4 with `@hono/node-server`, vitest 5, `playwright-core` 1.56.1 with the Chromium preinstalled at `/opt/pw-browsers`.

**Spec:** `docs/superpowers/specs/2026-09-28-erp-hero-frontend-switch-design.md` (read it before starting a task; section numbers below refer to it).

## Global Constraints

- The Airtable base is never written to. After Task 4 the app makes no Airtable call at all. No test reaches a real upstream: the backend uses `FakeFetch`, the page's network is filtered by the harness.
- **Never print, copy or use the embedded Airtable token.** Until Task 1 is committed, `index.html` contains it, and the Task 1 commit's diff still shows it. Every command that prints `index.html` content (`grep`, `sed -n`, `cat`, `git diff`, `git show`, `git log -p`) must end with `| mask`, defined as:
  `mask() { sed -E -e 's/pat[A-Za-z0-9]{8,}(\.[0-9a-fA-F]+)?/pat***/g' -e 's/[0-9a-fA-F]{20,}/<hex>/g' -e "/_TKP/ s/'[^']*'/'***'/g" | cut -c1-400; }`
  Define it in the same shell command that uses it, because shell functions do not persist between tool calls. Never run `git show`/`git diff` on the Task 1 commit without it.
- No secrets in the repo. Keys in tests are obvious fakes (`fd-key-alpha`, `mc-key-beta-us21`) or generated at runtime.
- Keep the existing function names and signatures (spec D3). The only exception is `uploadFileToRecord(table, recordId, field, file)`.
- `/api` requests use `credentials: 'same-origin'` and never send an `Authorization` header.
- Error prefixes, exactly: `'Lesen fehlgeschlagen: '`, `'Schreiben fehlgeschlagen: '`, `'Update fehlgeschlagen: '`, `'Löschen fehlgeschlagen: '`. The network error text is `'Server nicht erreichbar – bitte Verbindung prüfen'` (with an en dash, U+2013).
- The app's only home is `https://erp-hero-production.up.railway.app/`.
- `APP_VERSION` becomes `'v6.0'` (Task 13).
- The backend stays unchanged. If a backend bug blocks a task, make the minimal fix with a unit test under `test/`, and name it in the task report.
- `index.html` style: plain browser JavaScript (no modules, no build step), German UI texts and comments, 2-space indentation. Make targeted edits and never reformat code you do not change.
- Test assertions on whole-file text never use `toMatch`/`toContain`, because a failure would print the file. Use `expect(re.test(text)).toBe(false)` or `expect(text.includes(x)).toBe(false)`.
- `playwright-core` is pinned exactly to `1.56.1`. Never run `playwright install`, `npx playwright` or anything that downloads a browser. The browser path is `process.env.CHROMIUM_PATH || undefined`; the environment's `PLAYWRIGHT_BROWSERS_PATH` points Playwright at `/opt/pw-browsers`.
- Commands: `npm test` (unit + guard), `npm run test:e2e` (browser suite, from Task 2), `npm run typecheck`, `npm run lint`. All four must pass at the end of every task.
- Work on branch `claude/awesome-faraday-jjwsxl`. Commit once per task and push (`git push -u origin claude/awesome-faraday-jjwsxl`). Never push to `main`, never open a PR. Commit messages end with the attribution trailers the controller gives you.

## Review Focus

These are the inputs and conditions most likely to hurt a user that the scenario list in spec §14 does not pin down. Each has a test in the task that owns the code.

1. **Editing an existing user without typing a new login key** must keep that user's key working. The key field is empty for existing users, and an empty field must not send `api_key`. Test in Task 10.
2. **Mailchimp with a stored key and an empty key input** in the settings row must use the stored key. "Verbindung testen" sends `X-Company-Id` and no `x-mailchimp-key` header. Test in Task 9.
3. **Closing the browser tab while a record is open** must release the lock (through `sendBeacon`), so a colleague is not locked out for five minutes. Test in Task 6.
4. **Upstream error texts are parsed by callers.** For example, `_tcmCreateFdCompany` matches `/409/` and `"company_id"` in the message of a Freshdesk 409. So `proxyFetch` must keep the old message format exactly (`'Proxy 409: ' + <first 200 characters of the upstream body>`), and a Freshdesk `204 No Content` must resolve. Test in Task 8.
5. **File names with umlauts and spaces** ("Übersicht Q3.pdf") must upload, and their `/api/files/...` URL must download them. Test in Task 7.

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `index.html` | The app. Gets `_api`, the rewritten helpers, the re-login overlay, and loses the Airtable/Val.town code. | 1–13 |
| `sw.js` | Service worker v2: never touches `/api/` or `/healthz`. | 12 |
| `loader.html`, `loader-admin.html` | Redirect pages to the Railway URL. | 12 |
| `test/frontend/guard.test.ts` | Static guard over `index.html` and `sw.js` (unit suite). | 1, 9, 12, 13 |
| `test/e2e/harness.ts` | Starts the backend on a free port, seeds data, launches Chromium, filters page network, helpers. | 2 |
| `test/e2e/*.e2e.ts` | Browser scenarios, one file per area. | 2–13 |
| `vitest.e2e.config.ts` | Separate vitest config for the browser suite. | 2 |
| `package.json`, `tsconfig.json` | `playwright-core` devDependency, `test:e2e` script, lint and typecheck coverage. | 2 |
| `README.md` | How to run the e2e suite. | 2 |
| `DEPLOY.md` | Browser smoke test, cutover and known limitations after the switch. | 14 |

`index.html` stays one file (splitting it is out of scope). Its sections are marked by header comments of the form `/* ===… */` followed by an indented title line. Tasks name sections by that title (for example "the `AUTH: Session-Token-basiert via Val.town-Proxy` section") and functions by name. Line numbers are only given as orientation and drift as tasks land.

## Shared test conventions (used from Task 2 on)

Every e2e file starts like this:

```ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.resetContexts();
});
afterAll(async () => {
  await h.close();
});
```

- `h.run<T>(page, body)` runs `body` as the body of an async function in the page and returns its result. It can see the app's top-level `const`/`let` bindings (`APP_KEYS`, `_currentLock`, …).
- `h.runError(page, body)` runs `body` and returns `{message, status, type}` of what it threw. It fails the test if nothing was thrown.
- `h.apiAs(who, method, path, body?)` calls the backend in-process as `'admin'` or `'vera'` (never through `fetch`, which `test/setup.ts` disables).
- Every test that opens a page ends with `await h.assertClean(page)`: no request to a foreign host, no CSP violation, no uncaught page error.
- The login rate limit allows 5 failed logins per 15 minutes per IP, and the whole browser suite shares one IP per file. Keep wrong-key attempts to 2 or fewer per file.

---

### Task 1: Remove the embedded Airtable read token

The controller runs this task itself, without a subagent, so the token is never printed into a subagent's context.

**Files:**
- Modify: `index.html` (the `APP CONFIG` section: 5 lines)
- Create: `test/frontend/guard.test.ts`
- Scratch (not committed): `<scratchpad>/remove-token.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `test/frontend/guard.test.ts` with `const html = read('index.html')` and a `describe('index.html', …)` block that Tasks 9 and 13 extend.

- [ ] **Step 1: Write the failing guard test**

```ts
// test/frontend/guard.test.ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (file: string): string => readFileSync(path.join(ROOT, file), 'utf8');
// Airtable personal access token: "pat" + 14 alphanumerics + "." + 64 hex characters.
const TOKEN_PATTERN = /pat[A-Za-z0-9]{14}\.[0-9a-f]{64}/;

// Assertions are booleans on purpose: a failing toMatch/toContain would print the whole file.
describe('index.html', () => {
  const html = read('index.html');

  it('contains no Airtable token', () => {
    expect(TOKEN_PATTERN.test(html)).toBe(false);
    expect(html.includes('_TKP')).toBe(false);
    expect(/AIRTABLE_READ_KEY\s*:/.test(html)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run test/frontend/guard.test.ts`
Expected: FAIL, `expected true to be false` (the `_TKP` check).

- [ ] **Step 3: Delete the token lines with a count-only script**

```js
// <scratchpad>/remove-token.mjs — run from the repo root. Prints counts only, never line content.
import { readFileSync, writeFileSync } from 'node:fs';

const file = 'index.html';
const lines = readFileSync(file, 'utf8').split('\n');
const patterns = [
  /^\s*\/\/ Read-Token wird zur Laufzeit zusammengesetzt/,
  /^\s*\/\/ das Muster nicht als Secret erkennt/,
  /^\s*const _TKP1 = /,
  /^\s*const _TKP2 = /,
  /^\s*AIRTABLE_READ_KEY: _TKP1 \+ '\.' \+ _TKP2,\s*$/,
];
const hits = patterns.map((re) => lines.filter((l) => re.test(l)).length);
if (hits.some((n) => n !== 1)) {
  console.log('abort: expected exactly one match per pattern, got ' + hits.join(','));
  process.exit(1);
}
const kept = lines.filter((l) => !patterns.some((re) => re.test(l)));
writeFileSync(file, kept.join('\n'));
console.log('removed ' + (lines.length - kept.length) + ' lines');
```

Run: `node <scratchpad>/remove-token.mjs`
Expected: `removed 5 lines`

Then check by counts only:
`grep -c '_TKP' index.html` → `0`; `grep -cE 'AIRTABLE_READ_KEY\s*:' index.html` → `0`; `grep -c 'AIRTABLE_READ_KEY' index.html` → `11`.

The 11 remaining `APP_CONFIG.AIRTABLE_READ_KEY` references now read `undefined`. They sit inside functions that Tasks 3, 4 and 9 delete; Task 13's guard asserts that none is left. The app is not usable between Task 1 and Task 4, which is fine: nobody uses it (spec D1).

- [ ] **Step 4: Run the guard and the unit suite**

Run: `npx vitest run test/frontend/guard.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit and push**

Check the change with `git diff --stat` only (the full diff shows the removed token lines).

```bash
git add index.html test/frontend/guard.test.ts
git commit -m "fix(frontend): remove the embedded Airtable read token"
git push -u origin claude/awesome-faraday-jjwsxl
```

---

### Task 2: Browser e2e harness and a clean boot

**Files:**
- Modify: `package.json` (devDependency, `test:e2e` script, `lint` script)
- Modify: `tsconfig.json` (`include`)
- Create: `vitest.e2e.config.ts`
- Create: `test/e2e/harness.ts`
- Create: `test/e2e/boot.e2e.ts`
- Modify: `index.html` (`init()` in the `INIT` section; `showLoginScreen()` in the `UI: LOGIN HANDLER` section)
- Modify: `README.md`

**Interfaces:**
- Consumes: `createApp` (`server/app.ts`), `buildDeps`/`AppDeps` (`server/deps.ts`), `loadConfig` (`server/config.ts`), `openDatabase` (`server/db/database.ts`), `runMigrations` (`server/db/migrations.ts`), `hashLoginKey` (`server/auth/passwords.ts`), `newLoginKey` (`server/util/ids.ts`), `ROOT_DIR`/`testEnv` (`test/helpers/context.ts`), `FakeFetch` (`test/helpers/fakeFetch.ts`).
- Produces (`test/e2e/harness.ts`), used by every later task:

```ts
export type Who = 'admin' | 'vera';
export interface SeededUser { id: string; key: string; name: string }
export interface Harness {
  baseUrl: string;                                   // 'http://127.0.0.1:<port>'
  deps: AppDeps;
  fake: FakeFetch;
  logs: Record<string, unknown>[];
  companies: { alpha: string; beta: string };        // record ids of "Alpha GmbH", "Beta AG"
  users: Record<Who, SeededUser>;                    // "Ada Admin" (admin), "Vera Vertrieb" (Vertrieb, both companies, Freshdesk key for alpha)
  newPage(opts?: { serviceWorkers?: 'allow' | 'block' }): Promise<Page>;
  login(page: Page, who: Who, longLived?: boolean): Promise<void>;   // cookie via the page's context
  openApp(page: Page, who?: Who): Promise<void>;     // optional login, goto '/', wait for login screen or app shell
  apiAs<T = unknown>(who: Who, method: string, path: string, body?: unknown): Promise<T>;
  run<T>(page: Page, body: string): Promise<T>;
  runError(page: Page, body: string): Promise<{ message: string; status?: number; type?: string }>;
  assertClean(page: Page): Promise<void>;
  resetContexts(): Promise<void>;
  close(): Promise<void>;
}
export function startHarness(): Promise<Harness>;
```

- [ ] **Step 1: Add the dependency, scripts and configs**

Run: `npm install --save-dev --save-exact playwright-core@1.56.1`
(It has no install script and downloads nothing.)

In `package.json` `scripts`, add `"test:e2e": "vitest run --config vitest.e2e.config.ts"` and change `lint` to `"eslint server test vitest.config.ts vitest.e2e.config.ts"`.

In `tsconfig.json`, change `include` to `["server", "test", "vitest.config.ts", "vitest.e2e.config.ts"]`.

```ts
// vitest.e2e.config.ts
import { defineConfig } from 'vitest/config';

// Browser end-to-end suite: real index.html in headless Chromium against an in-process backend.
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.e2e.ts'],
    setupFiles: ['test/setup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
```

- [ ] **Step 2: Write the harness**

```ts
// test/e2e/harness.ts
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
```

If `deps.records.insert` has a different signature than `(tx, table, fields)`, or `serve`'s callback gives no `port`, read `test/helpers/context.ts` and `node_modules/@hono/node-server/dist/index.d.ts` and adapt; do not change the backend.

- [ ] **Step 3: Write the failing boot test**

```ts
// test/e2e/boot.e2e.ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.resetContexts();
});
afterAll(async () => {
  await h.close();
});

describe('boot', () => {
  it('shows the login screen with the admin hint and never calls Airtable', async () => {
    const page = await h.newPage();
    await h.openApp(page);
    expect(await page.locator('#loginScreen').isVisible()).toBe(true);
    expect((await page.locator('#loginHint').textContent())?.trim()).toBe('Den Key bekommst du vom Admin.');
    await h.assertClean(page);
  });
});
```

- [ ] **Step 4: Run it and see it fail**

Run: `npm run test:e2e -- test/e2e/boot.e2e.ts`
Expected: FAIL. The hint shows the "Setup-Modus" text, and `assertClean` reports a CSP violation (`connect-src https://api.airtable.com/...`) from `loadProjectKeys()`.
If Chromium fails to launch instead, check `ls /opt/pw-browsers` and `echo $PLAYWRIGHT_BROWSERS_PATH`; never download a browser.

- [ ] **Step 5: Stop loading Master-base keys at boot and fix the hint**

In `init()` (section `INIT`), delete these three lines:

```js
  // 1) Master-Base Keys laden (read-only, kein User nötig). Liefert vor allem
  //    apiProxyUrl, ohne die kein /me-Call gegen Val.town möglich wäre.
  await loadProjectKeys();
```

and renumber the two remaining step comments: `// 2) Default-Status …` becomes `// 1) Default-Status …`, and `// 3) Auto-Login …` becomes `// 2) Auto-Login …`.

In `showLoginScreen()`, replace the comment line `// Hinweis im Login-Hint, wenn Proxy noch nicht eingerichtet ist` and the `if (hintEl) { if (!APP_KEYS.apiProxyUrl) { … } else { … } }` block with:

```js
  const hintEl = document.getElementById('loginHint');
  if (hintEl) hintEl.textContent = 'Den Key bekommst du vom Admin.';
```

(`loadProjectKeys` itself is deleted with the auth section in Task 4.)

- [ ] **Step 6: Run the boot test, then everything**

Run: `npm run test:e2e -- test/e2e/boot.e2e.ts` → PASS.
Run: `npm test && npm run typecheck && npm run lint` → PASS.

- [ ] **Step 7: Document the suite in README.md**

`README.md` has only its title so far. Append this section at its end:

````markdown
### Browser end-to-end tests

`npm run test:e2e` loads the real `index.html` in headless Chromium against an in-process backend
(temporary SQLite database, fake upstreams). Third-party CDNs are stubbed and every request to a
foreign host fails the test, so the suite never touches Airtable, Freshdesk, Freshsales, Mailchimp
or Anthropic.

It uses `playwright-core` (no bundled browser). Playwright finds the browser through
`PLAYWRIGHT_BROWSERS_PATH`; to use another Chromium, set `CHROMIUM_PATH`:

```bash
CHROMIUM_PATH=/usr/bin/chromium npm run test:e2e
```
````

- [ ] **Step 8: Commit and push**

```bash
git add package.json package-lock.json tsconfig.json vitest.e2e.config.ts test/e2e/harness.ts test/e2e/boot.e2e.ts index.html README.md
git commit -m "test(e2e): browser harness; boot without Master-base keys"
git push -u origin claude/awesome-faraday-jjwsxl
```

---

### Task 3: The API client and the data helpers

**Files:**
- Modify: `index.html`: the section `AIRTABLE: CRUD (Helpers für nächste Phasen)` (functions `readData`, `writeData`, `updateData`, `deleteData`, `ensureTable`, `ensureFields`; `_stripEmptyDateFields` stays; `uploadFileToRecord` stays until Task 7), and `loadCompanies()` in the section `COMPANY (MANDANT) STATE`.
- Create: `test/e2e/data.e2e.ts`

**Interfaces:**
- Consumes: the harness (Task 2).
- Produces (in `index.html`, used by every later task):
  - `_api(method, path, { body, headers, keepalive, reauth = true } = {})` → parsed JSON (content type `application/json`) or text. Throws `Error(message)` with `.status`, `.type`, `.body` (parsed JSON or `null`) and `.text` (raw body).
  - `_reauth()` → `Promise<void>`. In this task a stub that throws `Error('Sitzung abgelaufen')`; Task 11 replaces it with the overlay.
  - `_prefixError(prefix, e)` → a new `Error(prefix + e.message)` that keeps `.status`, `.type`, `.body`, `.text`.
  - `_dataPath(table, id?)` → `'/data/<table>'` or `'/data/<table>/<id>'`, both URI-encoded.
  - `_writeBody(fields, opts)` → `{fields, assignNumber?: true, variantOf?: string}`.
  - `readData(table, filter, opts)`, `writeData(table, fields, opts = {})`, `updateData(table, id, fields)`, `deleteData(table, id)` with the error prefixes from Global Constraints.
  - Company objects in `APP_KEYS.companies` gain `has_mailchimp_key` (boolean) and lose `mailchimp_api_key`.

- [ ] **Step 1: Write the failing data tests**

Before Task 4 the page still shows the login screen after a cookie login (the old auto-login looks for a stored token), but `_api` already works with the cookie. The tests therefore log in with `h.openApp(page, 'vera')` and call the helpers directly.

```ts
// test/e2e/data.e2e.ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.resetContexts();
});
afterAll(async () => {
  await h.close();
});

describe('data helpers', () => {
  it('readData filters, sorts and sends no Authorization header', async () => {
    const page = await h.newPage();
    const authHeaders: string[] = [];
    page.on('request', (r) => {
      const a = r.headers()['authorization'];
      if (r.url().includes('/api/') && a) authHeaders.push(a);
    });
    await h.openApp(page, 'vera');
    const names = await h.run<string[]>(
      page,
      `const recs = await readData('Company', "{status}='aktiv'", { sort: [{ field: 'name', direction: 'desc' }] });
       return recs.map(r => r.fields.name);`,
    );
    expect(names).toEqual(['Beta AG', 'Alpha GmbH']);
    expect(authHeaders).toEqual([]);
    await h.assertClean(page);
  });

  it('writeData, updateData and deleteData round-trip through /api/data', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    const result = await h.run<{ created: string; updated: string; deleted: boolean; left: number }>(
      page,
      `const c = await writeData('Supplier', { name1: 'Rundreise KG', company_id: [${JSON.stringify(h.companies.alpha)}] });
       const u = await updateData('Supplier', c.id, { name1: 'Rundreise KG & Co' });
       const d = await deleteData('Supplier', c.id);
       const left = (await readData('Supplier')).filter(r => r.id === c.id).length;
       return { created: c.fields.name1, updated: u.fields.name1, deleted: d.deleted, left };`,
    );
    expect(result).toEqual({ created: 'Rundreise KG', updated: 'Rundreise KG & Co', deleted: true, left: 0 });
    await h.assertClean(page);
  });

  it('prefixes server errors and keeps status and type', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    expect(await h.runError(page, `await readData('Nope')`)).toEqual({
      message: 'Lesen fehlgeschlagen: Unbekannte Tabelle: Nope',
      status: 404,
      type: 'NOT_FOUND',
    });
    expect(await h.runError(page, `await writeData('Company', { name: 'Gamma' })`)).toEqual({
      message: 'Schreiben fehlgeschlagen: Nur für Admins',
      status: 403,
      type: 'FORBIDDEN',
    });
    await h.assertClean(page);
  });

  it('reports an unreachable server with the operation prefix', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    await page.route('**/api/data/**', (route) => route.abort());
    const err = await h.runError(page, `await readData('Customer')`);
    expect(err.message).toBe('Lesen fehlgeschlagen: Server nicht erreichbar – bitte Verbindung prüfen');
    await h.assertClean(page);
  });

  it('loadCompanies exposes has_mailchimp_key instead of the key', async () => {
    await h.apiAs('admin', 'PATCH', `/api/admin/companies/${h.companies.beta}/secrets`, { mailchimp_api_key: 'mc-key-beta-us21' });
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    const companies = await h.run<Record<string, unknown>[]>(
      page,
      `APP_KEYS.user = { _id: ${JSON.stringify(h.users.vera.id)}, name: 'Vera Vertrieb', is_admin: false,
         allowed_companies: [${JSON.stringify(h.companies.alpha)}, ${JSON.stringify(h.companies.beta)}] };
       await loadCompanies();
       return APP_KEYS.companies;`,
    );
    expect(companies.map((c) => [c.name, c.has_mailchimp_key, 'mailchimp_api_key' in c])).toEqual([
      ['Alpha GmbH', false, false],
      ['Beta AG', true, false],
    ]);
    await h.assertClean(page);
  });
});
```

(`Supplier` is used for the round trip because Vera may write it and no number is involved: `supplier_no` is only checked when present.)

- [ ] **Step 2: Run them and see them fail**

Run: `npm run test:e2e -- test/e2e/data.e2e.ts`
Expected: FAIL. `readData` still calls Airtable (CSP violation, `Lesen fehlgeschlagen: …`), `writeData` throws `Bitte einloggen`.

- [ ] **Step 3: Add the API client**

Insert this block directly before the section header `AIRTABLE: CRUD (Helpers für nächste Phasen)` (that is, before its `/* ===` line):

```js
/* ============================================================
   API-CLIENT: alle Server-Aufrufe laufen über _api (same-origin, Session-Cookie)
   ============================================================ */
const API_BASE = '/api';
const NETWORK_ERROR_TEXT = 'Server nicht erreichbar – bitte Verbindung prüfen';

// Fehlertext aus einer Server- oder Upstream-Antwort, in dieser Reihenfolge:
// {error:{message}} (unser Server) · {error:"…"} · {message} · {description} (Freshdesk) · Rohtext · HTTP-Status
function _errorMessageFrom(data, text, status) {
  if (data && typeof data === 'object') {
    if (data.error && typeof data.error === 'object' && data.error.message) return String(data.error.message);
    if (typeof data.error === 'string' && data.error) return data.error;
    if (typeof data.message === 'string' && data.message) return data.message;
    if (typeof data.description === 'string' && data.description) return data.description;
  }
  if (text) return text.slice(0, 200);
  return 'HTTP ' + status;
}

// Zentraler HTTP-Helper. Auth läuft über das HttpOnly-Session-Cookie — kein Token im Browser.
// Fehler: Error(message) mit .status, .type (Server-Fehlertyp), .body (JSON) und .text (Rohtext).
async function _api(method, path, { body, headers, keepalive, reauth = true } = {}) {
  const h = Object.assign({ 'Accept': 'application/json' }, headers || {});
  let payload;
  if (body instanceof FormData || typeof body === 'string') {
    payload = body;
  } else if (body !== undefined && body !== null) {
    payload = JSON.stringify(body);
    if (!h['Content-Type']) h['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers: h,
      body: payload,
      credentials: 'same-origin',
      ...(keepalive ? { keepalive: true } : {})
    });
  } catch (_) {
    throw new Error(NETWORK_ERROR_TEXT);
  }
  const ct = res.headers.get('content-type') || '';
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
  if (!res.ok) {
    const type = data && data.error && typeof data.error === 'object' ? data.error.type : undefined;
    // Sitzung abgelaufen: neu anmelden (Overlay) und den Aufruf genau einmal wiederholen.
    // Ein 401 vom Upstream (z.B. Freshdesk lehnt den Key ab) hat keinen Typ und wird normal geworfen.
    if (res.status === 401 && type === 'UNAUTHENTICATED' && reauth) {
      await _reauth();
      return _api(method, path, { body, headers, keepalive, reauth: false });
    }
    const err = new Error(_errorMessageFrom(data, text, res.status));
    err.status = res.status;
    err.type = type;
    err.body = data;
    err.text = text;
    throw err;
  }
  return ct.includes('application/json') ? data : text;
}

// Platzhalter bis zum Re-Login-Overlay: eine abgelaufene Sitzung ist ein normaler Fehler.
async function _reauth() {
  throw new Error('Sitzung abgelaufen');
}

function _prefixError(prefix, e) {
  const err = new Error(prefix + (e && e.message ? e.message : String(e)));
  if (e) { err.status = e.status; err.type = e.type; err.body = e.body; err.text = e.text; }
  return err;
}

function _dataPath(table, id) {
  return '/data/' + encodeURIComponent(table) + (id ? '/' + encodeURIComponent(id) : '');
}

function _writeBody(fields, opts) {
  const body = { fields };
  if (opts && opts.assignNumber) body.assignNumber = true;
  if (opts && opts.variantOf) body.variantOf = opts.variantOf;
  return body;
}
```

- [ ] **Step 4: Rewrite the CRUD helpers**

Change the section title line `AIRTABLE: CRUD (Helpers für nächste Phasen)` to `DATEN: CRUD über /api (Server)`. Replace `readData`, `writeData`, `updateData`, `deleteData`, `ensureTable` and `ensureFields` (keep `_stripEmptyDateFields` and `uploadFileToRecord` as they are) with:

```js
async function readData(table, filter, opts = {}) {
  const params = new URLSearchParams();
  if (filter) params.set('filterByFormula', filter);
  if (opts.sort) opts.sort.forEach((s, i) => {
    params.set(`sort[${i}][field]`, s.field);
    if (s.direction) params.set(`sort[${i}][direction]`, s.direction);
  });
  if (opts.maxRecords) params.set('maxRecords', String(opts.maxRecords));
  if (opts.fields) opts.fields.forEach(f => params.append('fields[]', f));
  const qs = params.toString();
  try {
    const data = await _api('GET', _dataPath(table) + (qs ? '?' + qs : ''));
    return (data && data.records) || [];
  } catch (e) {
    throw _prefixError('Lesen fehlgeschlagen: ', e);
  }
}
```

(The server returns all matching records; `opts.pageSize` is no longer needed and is ignored.)

```js
async function writeData(table, fields, opts = {}) {
  let created;
  try {
    created = await _api('POST', _dataPath(table), { body: _writeBody(fields, opts) });
  } catch (e) {
    throw _prefixError('Schreiben fehlgeschlagen: ', e);
  }
```

followed by the unchanged `// === Lazy-Push-Trigger ===` comment block and `try { const USAGE_TABLES = … } catch (_) { /* never throw */ }` and `return created;` of the old function.

```js
async function updateData(table, recordId, fields) {
  try {
    return await _api('PATCH', _dataPath(table, recordId), { body: { fields } });
  } catch (e) {
    throw _prefixError('Update fehlgeschlagen: ', e);
  }
}

async function deleteData(table, recordId) {
  try {
    return await _api('DELETE', _dataPath(table, recordId));
  } catch (e) {
    throw _prefixError('Löschen fehlgeschlagen: ', e);
  }
}

// Alle Tabellen existieren serverseitig, Felder brauchen kein Schema: nichts zu tun.
async function ensureTable(tableName, fields) {}

// Siehe ensureTable. Bleibt als No-op, damit die Aufrufer unverändert bleiben.
async function ensureFields(tableName, fieldDefs) {}
```

Also delete the old comment above `ensureFields` (`/* ensureFields: stellt sicher, … */`).

- [ ] **Step 5: Load companies through readData**

In `loadCompanies()`, replace the first four lines (`const headers …`, `const url …`, `const res …`, `if (!res.ok) …`) and the `const data = await res.json();` line with:

```js
  let records;
  try {
    records = await readData('Company', "{status}='aktiv'");
  } catch (e) {
    console.warn('Firmen konnten nicht geladen werden:', e.message);
    APP_KEYS.companies = [];
    APP_KEYS.currentCompanyId = null;
    return;
  }
```

change `const all = (data.records || []).map(r => ({` to `const all = records.map(r => ({`, and replace the line `mailchimp_api_key:       String(r.fields.mailchimp_api_key || '').trim(),` with `has_mailchimp_key:       !!r.fields.has_mailchimp_key,`. The rest of the function stays.

Mailchimp consumers (`getMailchimpConfig`, the settings page) still read `mailchimp_api_key` and treat Mailchimp as not configured until Tasks 8 and 9 switch them. That is expected in between.

- [ ] **Step 6: Run the data tests, then everything**

Run: `npm run test:e2e -- test/e2e/data.e2e.ts` → PASS.
Run: `npm test && npm run test:e2e && npm run typecheck && npm run lint` → PASS.

- [ ] **Step 7: Commit and push**

```bash
git add index.html test/e2e/data.e2e.ts
git commit -m "feat(frontend): _api client; data helpers and companies via /api"
git push -u origin claude/awesome-faraday-jjwsxl
```

---

### Task 4: Login, auto-login, logout and server settings

**Files:**
- Modify: `index.html`:
  - the whole section `AUTH: Session-Token-basiert via Val.town-Proxy` (header comment included), which is replaced;
  - the `APP_KEYS` literal (section `APP CONFIG`);
  - `logout()` in the section `RECORD LOCKING`;
  - one comment in `init()`.
- Create: `test/e2e/auth.e2e.ts`

**Interfaces:**
- Consumes: `_api` (Task 3); `loadCompanies()`, `loadUsersCache()` (unchanged); the harness.
- Produces (in `index.html`):
  - `_applyServerUser(u)`: sets and returns `APP_KEYS.user = {_id, name, role, is_admin, allowed_companies, freshdesk_company_keys, has_freshdesk_key}` from the server's `user` object (`{id, name, role, is_admin, allowed_companies, has_freshdesk_key, freshdesk_company_keys}`).
  - `_afterLogin()`: `Promise<void>`; loads companies, the user cache and the settings in parallel.
  - `loginWithUserKey(userKey, longLived = false)` → `APP_KEYS.user`; throws the server's message.
  - `tryAutoLogin()` → `true` when the session cookie is valid, else `false`. Never throws.
  - `_SETTING_KEYS` (the five setting names), `_applySettings(settings)` (sets each of the five `APP_KEYS` fields to its string value or `null`), `loadSettings()` (`GET /api/settings`; logs and keeps the old values on error). Task 9 adds `saveSetting` on top.
  - `APP_KEYS.proxyV2` is always `true`.
  - `logout()`: releases `_currentLock`, `POST /api/logout`, clears `APP_KEYS`, reloads.

The server's `/api/auth` and `/api/me` return `{user: {id, name, role, is_admin, allowed_companies, has_freshdesk_key, freshdesk_company_keys}}`. `has_freshdesk_key` means the user has a *default* Freshdesk key; `freshdesk_company_keys` lists the company ids with their own key. The seeded Vera has only a key for Alpha, so she gets `has_freshdesk_key: false` and `freshdesk_company_keys: [alpha]`.

- [ ] **Step 1: Write the failing auth tests**

```ts
// test/e2e/auth.e2e.ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.resetContexts();
});
afterAll(async () => {
  await h.close();
});

// APP_CONFIG.PROJECT_ID in index.html; the old token keys were named after it.
const PROJECT_ID = 'p_1778057282571';

describe('login and session', () => {
  it('logs in through the form and keeps a long-lived cookie when asked', async () => {
    const page = await h.newPage();
    await h.openApp(page);
    await page.fill('#loginKey', h.users.vera.key);
    await page.check('#loginRememberMe');
    await page.click('#loginBtn');
    await page.waitForSelector('#appShell:not(.hidden)', { state: 'visible' });
    expect(await page.locator('#sidebarUserName').textContent()).toBe('Vera Vertrieb');
    expect(await page.inputValue('#loginKey')).toBe('');
    const cookie = (await page.context().cookies()).find((c) => c.name === 'erp_session');
    // Playwright reports a session cookie as expires -1 and a persistent one as a timestamp.
    expect(cookie !== undefined && cookie.expires > 0).toBe(true);
    await h.assertClean(page);
  });

  it('shows the server message for a wrong key', async () => {
    const page = await h.newPage();
    await h.openApp(page);
    await page.fill('#loginKey', 'kein-gueltiger-key');
    await page.click('#loginBtn');
    await page.waitForSelector('#loginError:not(.hidden)', { state: 'visible' });
    expect(await page.locator('#loginError').textContent()).toBe('Ungültiger Login-Key oder Account inaktiv');
    expect(await page.locator('#appShell').isVisible()).toBe(false);
    // The login itself never opens the re-login overlay (Task 11).
    expect(await page.locator('#reauthOverlay').count()).toBe(0);
    await h.assertClean(page);
  });

  it('survives a reload, and logout returns to the login screen', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    expect(await page.locator('#appShell').isVisible()).toBe(true);
    await page.reload();
    await page.waitForSelector('#appShell:not(.hidden)', { state: 'visible' });
    expect(await page.locator('#sidebarUserName').textContent()).toBe('Vera Vertrieb');
    // logout() reloads the page, so it is started from a timer instead of being awaited.
    await page.evaluate('setTimeout(logout, 0)');
    await page.waitForSelector('#loginScreen:not(.hidden)', { state: 'visible' });
    const me = await page.context().request.get(`${h.baseUrl}/api/me`);
    expect(me.status()).toBe(401);
    await h.assertClean(page);
  });

  it('removes the old token keys from browser storage', async () => {
    const page = await h.newPage();
    // Any page of the origin will do to prepare the storage before the app starts.
    await page.goto(`${h.baseUrl}/healthz`);
    await h.run(
      page,
      `localStorage.setItem('session_token_${PROJECT_ID}', 'alt');
       sessionStorage.setItem('session_token_${PROJECT_ID}', 'alt');
       localStorage.setItem('user_key_${PROJECT_ID}', 'alt');`,
    );
    await h.openApp(page);
    const left = await h.run<unknown[]>(
      page,
      `return [
         localStorage.getItem('session_token_${PROJECT_ID}'),
         sessionStorage.getItem('session_token_${PROJECT_ID}'),
         localStorage.getItem('user_key_${PROJECT_ID}'),
       ];`,
    );
    expect(left).toEqual([null, null, null]);
    await h.assertClean(page);
  });

  it('takes the user from the server and loads companies, user names and settings', async () => {
    await h.apiAs('admin', 'PUT', '/api/settings/freshdeskTicketTypes', { value: 'Anfrage,Bestellung' });
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    const state = await h.run<Record<string, unknown>>(
      page,
      `return {
         user: APP_KEYS.user,
         proxyV2: APP_KEYS.proxyV2,
         companies: APP_KEYS.companies.map(c => c.name),
         users: Object.values(APP_KEYS.usersById).map(u => u.name).sort(),
         ticketTypes: APP_KEYS.freshdeskTicketTypes,
         domain: APP_KEYS.freshdeskDomain,
       };`,
    );
    expect(state).toEqual({
      user: {
        _id: h.users.vera.id,
        name: 'Vera Vertrieb',
        role: 'Vertrieb',
        is_admin: false,
        allowed_companies: [h.companies.alpha, h.companies.beta],
        freshdesk_company_keys: [h.companies.alpha],
        has_freshdesk_key: false,
      },
      proxyV2: true,
      companies: ['Alpha GmbH', 'Beta AG'],
      users: ['Ada Admin', 'Vera Vertrieb'],
      ticketTypes: 'Anfrage,Bestellung',
      domain: null,
    });
    await h.assertClean(page);
  });
});
```

This file makes one failed login, well below the rate limit.

- [ ] **Step 2: Run them and see them fail**

Run: `npm run test:e2e -- test/e2e/auth.e2e.ts`
Expected: FAIL. The old `loginWithUserKey` falls back to `_bootstrapLogin`, which calls Airtable (CSP violation; the app shell never appears). The old `tryAutoLogin` looks for a stored token, so a cookie login still shows the login screen, and it leaves `session_token_…` in storage.

- [ ] **Step 3: Replace the auth section**

Delete the whole section from its header comment (`AUTH: Session-Token-basiert via Val.town-Proxy`, including the `/* ===` line above the title and the bullet lines below it) down to the end of `tryAutoLogin()`, that is, up to the `/* ===` line of the `COMPANY (MANDANT) STATE` header. This removes `SESSION_STORAGE_KEY`, `LEGACY_USER_KEY`, `_getStoredToken`, `_setStoredToken`, `_clearStoredToken`, `loadProjectKeys`, `_bootstrapLogin`, the old `loginWithUserKey` and the old `tryAutoLogin`. Insert in their place:

```js
/* ============================================================
   AUTH: Login-Key → Session-Cookie (Server)
   - Login: User gibt Login-Key ein → POST /api/auth → HttpOnly-Session-Cookie
   - Der Browser speichert weder Key noch Token (das Cookie ist für JS unsichtbar)
   - „Angemeldet bleiben" → langlebige Sitzung (Cookie mit Ablaufdatum)
   - Auto-Login beim Start: GET /api/me
   ============================================================ */

// Speicherorte der alten Val.town-Anmeldung — werden beim Start entfernt.
const _LEGACY_STORAGE_KEYS = ['session_token_' + APP_CONFIG.PROJECT_ID, 'user_key_' + APP_CONFIG.PROJECT_ID];

function _clearLegacyAuthStorage() {
  _LEGACY_STORAGE_KEYS.forEach(k => {
    try { localStorage.removeItem(k); } catch (_) {}
    try { sessionStorage.removeItem(k); } catch (_) {}
  });
}

// User aus der Server-Antwort (/api/auth, /api/me) übernehmen.
function _applyServerUser(u) {
  APP_KEYS.user = {
    _id: u.id,
    name: u.name,
    role: u.role,
    is_admin: !!u.is_admin,
    allowed_companies: u.allowed_companies || [],
    freshdesk_company_keys: u.freshdesk_company_keys || [],
    has_freshdesk_key: !!u.has_freshdesk_key
  };
  return APP_KEYS.user;
}

// Nach Login und Auto-Login: Mandanten, User-Namen und Einstellungen laden.
async function _afterLogin() {
  await Promise.all([loadCompanies(), loadUsersCache(), loadSettings()]);
}

// Login mit dem persönlichen Key. Fehler tragen den Text des Servers
// (z.B. „Ungültiger Login-Key oder Account inaktiv" oder das Rate-Limit).
async function loginWithUserKey(userKey, longLived = false) {
  const data = await _api('POST', '/auth', {
    body: { user_key: userKey, long_lived: !!longLived },
    reauth: false
  });
  _applyServerUser(data.user);
  await _afterLogin();
  return APP_KEYS.user;
}

// Auto-Login beim App-Start: gültiges Session-Cookie → User laden.
async function tryAutoLogin() {
  _clearLegacyAuthStorage();
  let data;
  try {
    data = await _api('GET', '/me', { reauth: false });
  } catch (_) {
    return false;
  }
  _applyServerUser(data.user);
  await _afterLogin();
  return true;
}

/* ============================================================
   SERVER-EINSTELLUNGEN (nicht geheim; früher in der Master-Base)
   ============================================================ */
const _SETTING_KEYS = ['freshdeskSalesGroupId', 'freshdeskOrderGroupId', 'freshdeskTicketTypes', 'freshdeskDomain', 'freshsalesSubdomain'];

function _applySettings(settings) {
  const s = settings || {};
  _SETTING_KEYS.forEach(k => { APP_KEYS[k] = (typeof s[k] === 'string' && s[k]) ? s[k] : null; });
}

async function loadSettings() {
  try {
    const data = await _api('GET', '/settings');
    _applySettings(data && data.settings);
  } catch (e) {
    console.warn('Einstellungen konnten nicht geladen werden:', e.message);
  }
}
```

Section header lines in `index.html` are exactly `/* ` plus 60 `=` and `   ` plus 60 `=` plus ` */`; copy an existing header if in doubt.

`_bearerForProxy()` (section `API-PROXY (Val.town)`) and `revokeAllSessions()` still name the removed helpers. They cannot run before Tasks 8 and 10 rewrite them: `proxyFetch` throws "API-Proxy nicht konfiguriert" first, because `_proxyBase()` is `null` until Task 8.

- [ ] **Step 4: Mark the proxy as v2 for good**

In the `APP_KEYS` literal, after the line `usersById: {},`, add:

```js
  // Der Server kennt Freshdesk-Keys pro Mandant (X-Company-Id) — immer an.
  proxyV2: true,
```

- [ ] **Step 5: Rewrite logout()**

Replace the whole `async function logout() { … }` in the section `RECORD LOCKING` with:

```js
async function logout() {
  // Offene Sperre freigeben, Sitzung serverseitig beenden (best effort), dann neu laden.
  if (_currentLock) {
    try { await releaseLock(_currentLock.table, _currentLock.recordId); } catch (_) {}
  }
  try { await _api('POST', '/logout', { keepalive: true, reauth: false }); } catch (_) {}
  for (const k in APP_KEYS) APP_KEYS[k] = null;
  location.reload();
}
```

- [ ] **Step 6: Update the init() comment**

In `init()`, change the comment `// 2) Auto-Login: Session-Token validieren oder legacy User-Key migrieren` to `// 2) Auto-Login: Session-Cookie über /api/me prüfen`. The code below it stays.

- [ ] **Step 7: Run the auth tests, then everything**

Run: `npm run test:e2e -- test/e2e/auth.e2e.ts` → PASS.
Run: `npm test && npm run test:e2e && npm run typecheck && npm run lint` → PASS. (`data.e2e.ts` now starts in the app shell instead of the login screen; its tests do not depend on either.)

- [ ] **Step 8: Commit and push**

```bash
git add index.html test/e2e/auth.e2e.ts
git commit -m "feat(frontend): login, auto-login and logout through the session cookie"
git push -u origin claude/awesome-faraday-jjwsxl
```

---

### Task 5: Document numbers from the server, with recovery on a clash

**Files:**
- Modify: `index.html`:
  - a new section `BELEGNUMMERN (Server)`, inserted directly before the section header `ANTHROPIC AI (für spätere Phasen)`;
  - `writeData()` in the section `DATEN: CRUD über /api (Server)`;
  - the ten generators `nextCustomerNo` (section `STAMMDATEN: KUNDEN`), `nextSupplierNo` (`STAMMDATEN: LIEFERANTEN`), `nextArticleNo` (`STAMMDATEN: ARTIKEL`), `nextInquiryNo` (`VERKAUF: ANFRAGEN (Inquiry)`), `nextQuoteNo` and `nextQuoteVariantNo` (next to `_extractQuoteBase`), `nextOrderNo` (`AUFTRÄGE (Order) — Auftragsbestätigung`), `nextPurchaseNo` (`BESTELLUNGEN (Lieferantenbestellung) — SupplierOrder`), `nextDeliveryNo` (`LIEFERSCHEINE — DeliveryNote`), `nextInvoiceNo` (`RECHNUNGEN — Invoice`);
  - twelve call sites that reuse a number after saving (table in Step 6).
- Create: `test/e2e/numbers.e2e.ts`

**Interfaces:**
- Consumes: `_api`, `_dataPath`, `_writeBody`, `_prefixError` (Task 3); `toast(msg, type, timeout)` and `escapeHtml(s)` (existing; `toast` inserts `msg` as HTML, so every value in it is escaped).
- Produces (in `index.html`):
  - `NUMBER_FIELDS`: table name → number field (`Customer: 'customer_no'`, …, `SupplierOrder: 'purchase_no'`, `DeliveryNote: 'delivery_no'`, `Invoice: 'invoice_no'`).
  - `_peekNumber(type, companyId, base?)` → `Promise<string>`. `type` is the server's number type (`customer`, `supplier`, `article`, `inquiry`, `quote`, `order`, `purchase`, `delivery`, `invoice`). Throws `Error('Kein Mandant ausgewählt')` without a company. Records `'<Table>|<number>'` in `_peekedNumbers`.
  - `_recoverNumberConflict(table, fields, opts, e)` → the created record, or `null` when `e` is not a clash on a peeked number.
  - `_localQuoteVariantNo(base, companyId)`: the old browser-side variant logic, kept for quote numbers that do not start with `Q-`.
  - The ten generators keep their names and parameters and return the server's proposal.

The server proposes numbers with `GET /api/numbers/:type/next?company=<id>[&base=<quote no>]` → `{number}`. Nothing is reserved. When the record is saved, the server checks the number again inside its write transaction and answers a clash with `409 {error: {type: 'DUPLICATE_NUMBER', message: 'Nummer bereits vergeben: K-1001'}}`. `writeData` then saves once more with `assignNumber: true` (or `variantOf: <number>` for a quote variant `Q-<n>.<m>`), and the server takes the next free number. It does that only for a number that came from a generator in this page (`_peekedNumbers`). A number the user typed by hand is never replaced. Entries stay in `_peekedNumbers` after a save on purpose: two quick saves can share one proposal, and the second one must still be recovered.

- [ ] **Step 1: Write the failing tests**

```ts
// test/e2e/numbers.e2e.ts
import type { Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.resetContexts();
});
afterAll(async () => {
  await h.close();
});

interface Rec {
  id: string;
  fields: Record<string, unknown>;
}
const list = async (table: string): Promise<Rec[]> =>
  (await h.apiAs<{ records: Rec[] }>('admin', 'GET', `/api/data/${table}`)).records;
// A colleague (the admin) saving a record while the page is working.
const create = (table: string, fields: Record<string, unknown>): Promise<Rec> =>
  h.apiAs<Rec>('admin', 'POST', `/api/data/${table}`, { fields });
const toasts = async (page: Page): Promise<string> => (await page.locator('#toastWrap').textContent()) ?? '';
const numberRequests = (page: Page): string[] => {
  const seen: string[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith('/api/numbers/')) seen.push(url.pathname + url.search);
  });
  return seen;
};

describe('document numbers', () => {
  it('a customer created through the form gets the server number and the current company', async () => {
    const page = await h.newPage();
    const peeks = numberRequests(page);
    await h.openApp(page, 'vera');
    await h.run(page, 'await openCustomerModal();');
    expect(await page.inputValue('#modalBox input[name="customer_no"]')).toBe('K-1001');
    expect(peeks).toEqual([`/api/numbers/customer/next?company=${h.companies.alpha}`]);
    await page.fill('#modalBox input[name="name1"]', 'Erste Kundin GmbH');
    await page.click('#modalBox button[type="submit"]');
    await page.locator('#toastWrap', { hasText: 'Gespeichert' }).waitFor();
    const saved = (await list('Customer')).find((r) => r.fields.name1 === 'Erste Kundin GmbH');
    expect([saved?.fields.customer_no, saved?.fields.company_id]).toEqual(['K-1001', [h.companies.alpha]]);
    await h.assertClean(page);
  });

  it('saves under the next free number when a proposed number was taken meanwhile', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    const beta = JSON.stringify(h.companies.beta);
    expect(await h.run<string>(page, `return await nextCustomerNo(${beta});`)).toBe('K-1001');
    await create('Customer', { name1: 'Schneller AG', customer_no: 'K-1001', company_id: [h.companies.beta] });
    const stored = await h.run<string>(
      page,
      `const c = await writeData('Customer', { name1: 'Langsam GmbH', customer_no: 'K-1001', company_id: [${beta}] });
       return c.fields.customer_no;`,
    );
    expect(stored).toBe('K-1002');
    expect((await toasts(page)).includes('Nummer K-1001 war inzwischen vergeben – gespeichert als K-1002')).toBe(true);
    await h.assertClean(page);
  });

  it('keeps a variant a variant, and the variant flow reports the stored number', async () => {
    const alpha = h.companies.alpha;
    const original = await create('Quote', { quote_no: 'Q-2001', status: 'Entwurf', company_id: [alpha] });
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    let raced = false;
    await page.route('**/api/data/Quote', async (route) => {
      if (route.request().method() === 'POST' && !raced) {
        raced = true;
        // Between the proposal and the save, a colleague saves the same variant number.
        await create('Quote', { quote_no: 'Q-2001.1', company_id: [alpha] });
      }
      await route.continue();
    });
    const result = await h.run<{ quote_no: string } | null>(
      page,
      `return await createQuoteVariant(${JSON.stringify(original.id)}, { silent: true, skipModalActions: true });`,
    );
    expect(result?.quote_no).toBe('Q-2001.2');
    const text = await toasts(page);
    expect(text.includes('Nummer Q-2001.1 war inzwischen vergeben – gespeichert als Q-2001.2')).toBe(true);
    expect(text.includes('✓ Variante Q-2001.2 angelegt')).toBe(true);
    const numbers = (await list('Quote')).map((r) => String(r.fields.quote_no)).filter((n) => n.startsWith('Q-2001'));
    expect(numbers.sort()).toEqual(['Q-2001', 'Q-2001.1', 'Q-2001.2']);
    await h.assertClean(page);
  });

  it('reports a duplicate number typed by hand instead of replacing it', async () => {
    await create('Customer', { name1: 'Vorhanden KG', customer_no: 'K-5000', company_id: [h.companies.alpha] });
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    const err = await h.runError(
      page,
      `await writeData('Customer', { name1: 'Doppelt GmbH', customer_no: 'K-5000', company_id: [${JSON.stringify(h.companies.alpha)}] });`,
    );
    expect(err).toEqual({
      message: 'Schreiben fehlgeschlagen: Nummer bereits vergeben: K-5000',
      status: 409,
      type: 'DUPLICATE_NUMBER',
    });
    expect((await list('Customer')).some((r) => r.fields.name1 === 'Doppelt GmbH')).toBe(false);
    await h.assertClean(page);
  });

  it('proposes variants on the server and keeps computing old non-Q variants in the browser', async () => {
    const beta = h.companies.beta;
    for (const quote_no of ['Q-3001', 'Q-3001.1', 'ALT-7', 'ALT-7.1']) await create('Quote', { quote_no, company_id: [beta] });
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    const b = JSON.stringify(beta);
    expect(
      await h.run<string[]>(
        page,
        `return [await nextQuoteVariantNo('Q-3001', ${b}), await nextQuoteVariantNo('Q-3001.1', ${b}), await nextQuoteNo(${b})];`,
      ),
    ).toEqual(['Q-3001.2', 'Q-3001.2', 'Q-3002']);
    const peeks = numberRequests(page);
    expect(await h.run<string>(page, `return await nextQuoteVariantNo('ALT-7', ${b});`)).toBe('ALT-7.2');
    expect(peeks).toEqual([]);
    await h.assertClean(page);
  });

  it('starts every number type at its floor in a new company and needs a company', async () => {
    const gamma = await create('Company', { name: 'Gamma KG', status: 'aktiv' });
    const page = await h.newPage();
    const peeks = numberRequests(page);
    await h.openApp(page, 'admin');
    const g = JSON.stringify(gamma.id);
    const numbers = await h.run<string[]>(
      page,
      `return [
         await nextCustomerNo(${g}), await nextSupplierNo(${g}), await nextArticleNo(${g}),
         await nextInquiryNo(${g}), await nextQuoteNo(${g}), await nextOrderNo(${g}),
         await nextPurchaseNo(${g}), await nextDeliveryNo(${g}), await nextInvoiceNo(${g}),
       ];`,
    );
    expect(numbers).toEqual(['K-1001', 'L-1001', 'A-10001', 'AN-1001', 'Q-1001', 'AB-1001', 'B-1001', 'L-1001', 'R-1001']);
    expect(peeks.length).toBe(9);
    expect((await h.runError(page, 'await nextCustomerNo(null);')).message).toBe('Kein Mandant ausgewählt');
    await h.assertClean(page);
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npm run test:e2e -- test/e2e/numbers.e2e.ts`
Expected: FAIL in four tests. The first and the last see no `/api/numbers/` request (the old generators read the table and count in the browser). The second gets `Schreiben fehlgeschlagen: Nummer bereits vergeben: K-1001`. The third gets `null` from `createQuoteVariant` (it toasts "Variante fehlgeschlagen"). The other two already pass and pin behaviour that must not change.

- [ ] **Step 3: Add the numbers section**

Insert directly before the section header `ANTHROPIC AI (für spätere Phasen)` (before its `/* ===` line):

```js
/* ============================================================
   BELEGNUMMERN (Server)
   - Vorschlag: GET /api/numbers/:typ/next (nichts wird reserviert)
   - Beim Speichern prüft der Server die Nummer erneut. Ist ein Vorschlag
     inzwischen vergeben, speichert writeData mit der nächsten freien Nummer.
   ============================================================ */
// Nummernfeld je Tabelle (wie NUMBER_SPECS auf dem Server).
const NUMBER_FIELDS = {
  Customer: 'customer_no', Supplier: 'supplier_no', Article: 'article_no',
  Inquiry: 'inquiry_no', Quote: 'quote_no', Order: 'order_no',
  SupplierOrder: 'purchase_no', DeliveryNote: 'delivery_no', Invoice: 'invoice_no'
};
// Nummerntyp der API → Tabelle.
const _NUMBER_TABLES = {
  customer: 'Customer', supplier: 'Supplier', article: 'Article',
  inquiry: 'Inquiry', quote: 'Quote', order: 'Order',
  purchase: 'SupplierOrder', delivery: 'DeliveryNote', invoice: 'Invoice'
};
// Vorschläge dieser Sitzung als "Tabelle|Nummer". Nur für sie vergibt writeData bei einer
// Kollision eine neue Nummer — eine von Hand eingetippte Nummer wird nie ersetzt.
const _peekedNumbers = new Set();

async function _peekNumber(type, companyId, base) {
  if (!companyId) throw new Error('Kein Mandant ausgewählt');
  const params = new URLSearchParams({ company: companyId });
  if (base) params.set('base', base);
  const data = await _api('GET', '/numbers/' + type + '/next?' + params.toString());
  _peekedNumbers.add(_NUMBER_TABLES[type] + '|' + data.number);
  return data.number;
}

// 409 DUPLICATE_NUMBER auf einen Vorschlag: einmal neu speichern, der Server vergibt die
// nächste freie Nummer (eine Variante Q-n.m bleibt eine Variante derselben Basis).
// Liefert den neuen Datensatz oder null, wenn der Fehler nicht dazu passt.
async function _recoverNumberConflict(table, fields, opts, e) {
  if (!e || e.status !== 409 || e.type !== 'DUPLICATE_NUMBER') return null;
  if (opts && (opts.assignNumber || opts.variantOf)) return null;
  const field = NUMBER_FIELDS[table];
  const value = field && fields ? fields[field] : undefined;
  if (typeof value !== 'string' || !_peekedNumbers.has(table + '|' + value)) return null;
  const retry = /^Q-\d+\.\d+$/.test(value) ? { variantOf: value } : { assignNumber: true };
  const created = await _api('POST', _dataPath(table), { body: _writeBody(fields, retry) });
  const stored = created && created.fields ? String(created.fields[field] || '') : '';
  toast('Nummer ' + escapeHtml(value) + ' war inzwischen vergeben – gespeichert als ' + escapeHtml(stored), 'warn', 8000);
  return created;
}
```

- [ ] **Step 4: Recover in writeData**

In `writeData()`, replace

```js
  } catch (e) {
    throw _prefixError('Schreiben fehlgeschlagen: ', e);
  }
```

with

```js
  } catch (e) {
    let recovered = null;
    try {
      recovered = await _recoverNumberConflict(table, fields, opts, e);
    } catch (e2) {
      throw _prefixError('Schreiben fehlgeschlagen: ', e2);
    }
    if (!recovered) throw _prefixError('Schreiben fehlgeschlagen: ', e);
    created = recovered;
  }
```

The lazy customer sync below it then runs for the recovered record as well.

- [ ] **Step 5: Replace the generators**

Replace the body of each generator; keep the function where it is:

```js
async function nextCustomerNo(companyId) {
  return _peekNumber('customer', companyId);
}
```

and likewise `nextSupplierNo` → `'supplier'`, `nextArticleNo` → `'article'`, `nextInquiryNo` → `'inquiry'`, `nextQuoteNo` → `'quote'`, `nextOrderNo` → `'order'`, `nextPurchaseNo` → `'purchase'`, `nextDeliveryNo` → `'delivery'`, `nextInvoiceNo` → `'invoice'`. The server uses the same prefixes and floors as the old code (`K-`/1000, `L-`/1000, `A-`/10000, `AN-`, `Q-`, `AB-`, `B-`, `L-`, `R-`, each 1000).

Keep `_extractQuoteBase` unchanged. Replace `nextQuoteVariantNo` (with its comment) by:

```js
// Nächste freie Varianten-Nummer für eine Basis.
// Beispiel: Basis "Q-1024" mit Q-1024.1 und Q-1024.2 → "Q-1024.3"
// Der Server kennt nur Q-Nummern; ältere Nummernkreise rechnet der Browser wie bisher.
async function nextQuoteVariantNo(baseQuoteNo, companyId) {
  const base = _extractQuoteBase(baseQuoteNo);
  if (/^Q-\d+$/.test(base)) return _peekNumber('quote', companyId, base);
  return _localQuoteVariantNo(base, companyId);
}

async function _localQuoteVariantNo(base, companyId) {
  const all = await readData('Quote');
  const inCo = all.filter(q => (q.fields.company_id || []).includes(companyId));
  const reg = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.(\\d+)$');
  let maxVariant = 0;
  inCo.forEach(q => {
    const m = (q.fields.quote_no || '').match(reg);
    if (m) { const n = parseInt(m[1], 10); if (n > maxVariant) maxVariant = n; }
  });
  return base + '.' + (maxVariant + 1);
}
```

- [ ] **Step 6: Use the stored number after saving**

After a recovery the record carries a different number than the local variable. These twelve sites use the variable *after* the save (in a toast, a follow-up record or a chat line), so each reads it back from the created record. In each function: if the variable is declared with `const`, make it `let`; then add the statement directly after the line named in "After". Text built into the record *before* the save keeps the proposal (spec §8).

| # | Function | Declaration | After | Add |
|---|---|---|---|---|
| 1 | `_tcmCreateErpForMandant` | `const customerNo = await nextCustomerNo(mandantId).catch(()=>'');` | `const newCustomer = await writeData('Customer', customerFields);` | `customerNo = newCustomer?.fields?.customer_no \|\| customerNo;` |
| 2 | `_aocCreateOrder` | `const orderNo = await nextOrderNo(cur.id);` | `if (!created) throw lastErr \|\| new Error('Order-Anlage fehlgeschlagen');` | `orderNo = created.fields?.order_no \|\| orderNo;` |
| 3 | `_eaCreateQuote` | `const quoteNo = await nextQuoteNo(cur.id);` | `if (!created) throw lastErr \|\| new Error('Quote-Anlage fehlgeschlagen');` | `quoteNo = created.fields?.quote_no \|\| quoteNo;` |
| 4 | `_aqcCreateQuote` | `let quoteNo, parentQuoteNoForVariant = '';` (already `let`) | `if (!created) throw lastErr \|\| new Error('Quote-Write fehlgeschlagen ohne konkreten Fehler');` | `quoteNo = created.fields?.quote_no \|\| quoteNo;` |
| 5 | `_fdQuickCreateArticle` | `const articleNo = await nextArticleNo(cur.id).catch(()=>'');` | `const created = await writeData('Article', fields);` | `articleNo = created?.fields?.article_no \|\| articleNo;` |
| 6 | `aiCreateQuoteFromEdits` | `const quoteNo = await nextQuoteNo(cur.id);` | `const created = await writeData('Quote', fields);` | `quoteNo = created?.fields?.quote_no \|\| quoteNo;` |
| 7 | `prepareQuoteFromVoice` | `const quoteNo = await nextQuoteNo(cur.id);` | `const created = await writeData('Quote', fields);` | `quoteNo = created?.fields?.quote_no \|\| quoteNo;` |
| 8 | `createQuoteVariant` | `const newQuoteNo = await nextQuoteVariantNo(of.quote_no, cur.id);` | `if (!created) throw lastErr \|\| new Error('Variante konnte nicht angelegt werden');` | `newQuoteNo = created.fields?.quote_no \|\| newQuoteNo;` |
| 9 | `inqWizCreateQuote` | `const quoteNo = await nextQuoteNo(cur.id);` | `const created = await writeData('Quote', quoteFields);` | `quoteNo = created?.fields?.quote_no \|\| quoteNo;` |
| 10 | `launchPoFromOrderForSupplier` | `const purchaseNo = await nextPurchaseNo(cur.id);` | `const created = await writeData('SupplierOrder', purchaseFields);` | `purchaseNo = created?.fields?.purchase_no \|\| purchaseNo;` |
| 11 | `launchDnFromOrder` | `const deliveryNo = await nextDeliveryNo(cur.id);` | `const created = await writeData('DeliveryNote', deliveryFields);` | `deliveryNo = created?.fields?.delivery_no \|\| deliveryNo;` |
| 12 | `launchInvoiceFromOrder` | `const invoiceNo = await nextInvoiceNo(cur.id);` | `const created = await writeData('Invoice', invoiceFields);` | `invoiceNo = created?.fields?.invoice_no \|\| invoiceNo;` |

(`\|\|` in the table is `||`.) The same declaration text occurs in several functions, so edit inside the named function only. The other generator calls (form prefills such as `f.customer_no = await nextCustomerNo(cur.id)`, and creations that do not use the number after saving) need no change: a prefilled number is a proposal, so a clash on it is recovered.

The "Resilient write" loops in sites 2, 3, 4 and 8 retry only on Airtable schema messages (`/array of record|record id|invalid value|cannot accept/i`); a 409 is not one of them, and `writeData` has already recovered it inside the attempt.

- [ ] **Step 7: Run the number tests, then everything**

Run: `npm run test:e2e -- test/e2e/numbers.e2e.ts` → PASS.
Run: `npm test && npm run test:e2e && npm run typecheck && npm run lint` → PASS.

- [ ] **Step 8: Commit and push**

```bash
git add index.html test/e2e/numbers.e2e.ts
git commit -m "feat(frontend): document numbers from the server with recovery on a clash"
git push -u origin claude/awesome-faraday-jjwsxl
```

---

### Task 6: Record locks through /api/locks

**Files:**
- Modify: `index.html`:
  - the section `RECORD LOCKING`: the two constants, `acquireLock`, `releaseLock`, `startLockHeartbeat` and the `beforeunload` listener are replaced; `getLockInfo`, `isLockedByOther`, `stopLockHeartbeat` and `logout` stay;
  - `updateData()` in the section `DATEN: CRUD über /api (Server)`.
- Create: `test/e2e/locks.e2e.ts`

**Interfaces:**
- Consumes: `_api`, `API_BASE`, `_dataPath`, `_prefixError` (Task 3); `toast`, `escapeHtml`, `closeModal()` (existing; `closeModal` sets `_currentLock = null` and calls `releaseLock` for the lock it held); `openCustomerModal(id)` and `saveCustomer(e, id)` (existing, unchanged).
- Produces (in `index.html`):
  - `_lockPath(table, recordId)` → `'/locks/<table>/<recordId>'`, both URI-encoded.
  - `_isCurrentLock(table, recordId)` → `true` when `_currentLock` is that record.
  - `acquireLock(table, recordId, currentRecord)` → `{ok: true}` or `{ok: false, lockedBy}`. `currentRecord` is ignored; `lockedBy` is the holder's name, HTML-escaped, because every caller puts it into `toast()`.
  - `releaseLock(table, recordId)` → `Promise<void>`; never throws.
  - `_lockHeartbeatTick(table, recordId)` → `Promise<void>`; never throws.
  - `startLockHeartbeat(table, recordId)`, `stopLockHeartbeat()`, `_currentLock`, `_lockRefreshTimer`: same names and meaning as before.

The server keeps the lock in the record's own `lock_user_id`/`lock_until` fields and decides who gets it:
- `POST /api/locks/:table/:id` and `POST /api/locks/:table/:id/refresh` both take or extend the lock. They answer `{ok: true, until}`, or `{ok: false, locked_by: {id, name}, until}` when another user holds a valid lock.
- `POST /api/locks/:table/:id/release` → `{ok: true}`. It clears the lock if the caller holds it or it has expired, and ignores the request body, so `navigator.sendBeacon` works.
- A lock expires 5 minutes after its last refresh. Data `PATCH`es silently ignore `lock_user_id` and `lock_until`, which is why the save handlers need the shim in Step 4.

- [ ] **Step 1: Write the failing tests**

```ts
// test/e2e/locks.e2e.ts
import type { Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.resetContexts();
});
afterAll(async () => {
  await h.close();
});

const newCustomer = async (name1: string): Promise<string> =>
  (
    await h.apiAs<{ id: string }>('admin', 'POST', '/api/data/Customer', {
      fields: { name1, status: 'aktiv', company_id: [h.companies.alpha] },
    })
  ).id;
const lockHolder = async (id: string): Promise<unknown> => (await h.deps.records.get('Customer', id))?.fields.lock_user_id;
const toasts = async (page: Page): Promise<string> => (await page.locator('#toastWrap').textContent()) ?? '';
// Nobody awaits the release from closeModal() or from the unload beacon, so the tests poll.
const eventually = async (check: () => Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('condition not met within 5 s');
};
// Vera logs in (Alpha is her current company) and opens the customer.
const openAsVera = async (id: string): Promise<Page> => {
  const page = await h.newPage();
  await h.openApp(page, 'vera');
  await h.run(page, `await openCustomerModal(${JSON.stringify(id)});`);
  return page;
};

describe('record locks', () => {
  it('opening a customer takes the lock on the server and closing the modal releases it', async () => {
    const id = await newCustomer('Sperr GmbH');
    const page = await openAsVera(id);
    expect(await lockHolder(id)).toBe(h.users.vera.id);
    expect(await h.run(page, 'return { lock: _currentLock, timer: _lockRefreshTimer !== null };')).toEqual({
      lock: { table: 'Customer', recordId: id },
      timer: true,
    });
    await h.run(page, 'closeModal();');
    await eventually(async () => (await lockHolder(id)) === undefined);
    await h.assertClean(page);
  });

  it('saving through the form releases the lock', async () => {
    const id = await newCustomer('Speicher GmbH');
    const page = await openAsVera(id);
    expect(await lockHolder(id)).toBe(h.users.vera.id);
    await page.fill('#modalBox input[name="name1"]', 'Speicher GmbH & Co');
    await page.click('#modalBox button[type="submit"]');
    await page.locator('#toastWrap', { hasText: 'Gespeichert' }).waitFor();
    const stored = await h.deps.records.get('Customer', id);
    expect([stored?.fields.name1, stored?.fields.lock_user_id]).toEqual(['Speicher GmbH & Co', undefined]);
    expect(await h.run(page, 'return { lock: _currentLock, timer: _lockRefreshTimer };')).toEqual({ lock: null, timer: null });
    await h.assertClean(page);
  });

  it('a customer locked by someone else names that user and opens nothing', async () => {
    const id = await newCustomer('Besetzt KG');
    await h.apiAs('admin', 'POST', `/api/locks/Customer/${id}`);
    const page = await openAsVera(id);
    expect((await toasts(page)).includes('Wird gerade von Ada Admin bearbeitet — bitte später nochmal')).toBe(true);
    expect(await page.locator('#modalBackdrop').isVisible()).toBe(false);
    expect(await h.run(page, 'return _currentLock;')).toBe(null);
    expect(await lockHolder(id)).toBe(h.users.admin.id);
    await h.assertClean(page);
  });

  it('closing the tab releases the lock through sendBeacon', async () => {
    const id = await newCustomer('Tab GmbH');
    const page = await openAsVera(id);
    expect(await lockHolder(id)).toBe(h.users.vera.id);
    await h.assertClean(page);
    // With routes active, Playwright drops the requests a closing page makes. A real browser sends
    // the beacon (checked by hand: without routes the release arrives), so the routes go first.
    await page.context().unrouteAll({ behavior: 'wait' });
    await page.close({ runBeforeUnload: true });
    await eventually(async () => (await lockHolder(id)) === undefined);
  });

  it('the heartbeat ignores network errors and reports a lock that someone else took over', async () => {
    const id = await newCustomer('Herzschlag AG');
    const page = await openAsVera(id);
    const idJson = JSON.stringify(id);

    await page.route('**/api/locks/**', (route) => route.abort());
    await h.run(page, `await _lockHeartbeatTick('Customer', ${idJson});`);
    await page.unroute('**/api/locks/**');
    expect(await h.run(page, 'return _currentLock;')).toEqual({ table: 'Customer', recordId: id });
    expect((await toasts(page)).includes('Sperre verloren')).toBe(false);

    // Vera's laptop slept longer than the lock lives, and the admin took the record over.
    const until = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    await h.deps.db.write((tx) =>
      h.deps.records.update(tx, 'Customer', id, { lock_user_id: h.users.admin.id, lock_until: until }, []),
    );
    await h.run(page, `await _lockHeartbeatTick('Customer', ${idJson});`);
    expect((await toasts(page)).includes('Sperre verloren – der Datensatz wird jetzt von Ada Admin bearbeitet')).toBe(true);
    expect(await h.run(page, 'return { lock: _currentLock, timer: _lockRefreshTimer };')).toEqual({ lock: null, timer: null });
    expect(await lockHolder(id)).toBe(h.users.admin.id);
    await h.assertClean(page);
  });
});
```

`h.deps.records.update(tx, table, id, set, clear)` is the store call the server's own `LockService` uses. If its signature differs, read `server/data/records.ts` and adapt the test, not the store.

- [ ] **Step 2: Run them and see them fail**

Run: `npm run test:e2e -- test/e2e/locks.e2e.ts`
Expected: FAIL in four tests. The old `acquireLock` writes the lock through `updateData`, and the data `PATCH` ignores lock fields, so no lock is stored (the first, second and fourth tests fail on `expected undefined to be '<vera id>'`; the fourth would also get no beacon, because the old unload handler needs `APP_KEYS.airtableWriteKey`). The old heartbeat has no `_lockHeartbeatTick` (the fifth test: `ReferenceError`). The third test already passes, because the admin's server lock shows up in the record fields that the old `acquireLock` checks. It pins that behaviour.

Without the shim of Step 4, the second test still fails after Step 3: the server ignores the lock fields in the save `PATCH`, and the handler sets `_currentLock = null` before `closeModal()` could release it, so Vera keeps the lock.

- [ ] **Step 3: Replace the lock functions**

In the section `RECORD LOCKING`, replace the two lines

```js
const LOCK_TTL_MS = 5 * 60 * 1000;     // 5 Minuten
const LOCK_REFRESH_MS = 2 * 60 * 1000; // alle 2 Minuten verlängern
```

with

```js
// Der Server entscheidet über Sperren; eine Sperre läuft 5 Minuten nach der letzten Verlängerung ab.
const LOCK_REFRESH_MS = 2 * 60 * 1000; // alle 2 Minuten verlängern
```

Keep `let _currentLock`, `let _lockRefreshTimer`, `getLockInfo` and `isLockedByOther` (the lists use them to show lock badges; the server returns the lock fields). Replace `acquireLock`, `releaseLock` and `startLockHeartbeat` with the code below, keep `stopLockHeartbeat` unchanged between them, and replace the whole `window.addEventListener('beforeunload', …)` block (with its comment line) by the last block below:

```js
function _lockPath(table, recordId) {
  return '/locks/' + encodeURIComponent(table) + '/' + encodeURIComponent(recordId);
}

function _isCurrentLock(table, recordId) {
  return !!_currentLock && _currentLock.table === table && _currentLock.recordId === recordId;
}

// currentRecord bleibt für die Aufrufer im Parameter, der Server kennt den aktuellen Stand selbst.
async function acquireLock(table, recordId, currentRecord) {
  const res = await _api('POST', _lockPath(table, recordId));
  if (!res || !res.ok) {
    // Alle Aufrufer zeigen lockedBy per toast() an, also als HTML: deshalb escaped.
    const who = (res && res.locked_by && res.locked_by.name) || 'einem anderen Benutzer';
    return { ok: false, lockedBy: escapeHtml(who) };
  }
  startLockHeartbeat(table, recordId);
  return { ok: true };
}

async function releaseLock(table, recordId) {
  stopLockHeartbeat();
  if (_isCurrentLock(table, recordId)) _currentLock = null;
  try { await _api('POST', _lockPath(table, recordId) + '/release', { reauth: false }); } catch (e) {}
}

// Ein Heartbeat-Takt. refresh nimmt die Sperre auch neu, falls sie inzwischen frei war.
// Netzwerkfehler werden ignoriert. Hat jemand anderes übernommen (z.B. nach Standby),
// endet der Heartbeat mit einer Warnung; das Formular bleibt offen.
async function _lockHeartbeatTick(table, recordId) {
  let res;
  try {
    res = await _api('POST', _lockPath(table, recordId) + '/refresh', { reauth: false });
  } catch (e) {
    return;
  }
  if (!res || res.ok !== false) return;
  stopLockHeartbeat();
  if (_isCurrentLock(table, recordId)) _currentLock = null;
  const who = (res.locked_by && res.locked_by.name) || 'einem anderen Benutzer';
  toast('Sperre verloren – der Datensatz wird jetzt von ' + escapeHtml(who) + ' bearbeitet', 'warn', 8000);
}

function startLockHeartbeat(table, recordId) {
  stopLockHeartbeat();
  _currentLock = { table, recordId };
  _lockRefreshTimer = setInterval(() => { _lockHeartbeatTick(table, recordId); }, LOCK_REFRESH_MS);
}
```

```js
// Sperre auch beim Schließen des Tabs freigeben (Best-Effort). sendBeacon schickt das
// Session-Cookie mit und überlebt das Schließen; der Server ignoriert den leeren Body.
window.addEventListener('beforeunload', () => {
  if (!_currentLock || !navigator.sendBeacon) return;
  try { navigator.sendBeacon(API_BASE + _lockPath(_currentLock.table, _currentLock.recordId) + '/release'); } catch (e) {}
});
```

`API_BASE` is declared further down the file (section `API-CLIENT`). That is fine: the listener runs long after the script has been evaluated.

The Order, SupplierOrder, DeliveryNote and Invoice modals set `_currentLock` and call `startLockHeartbeat` a second time after `openModal`. That stays: `startLockHeartbeat` stops the first timer, so one heartbeat remains.

- [ ] **Step 4: Add the lock shim to updateData**

Replace `updateData()` (section `DATEN: CRUD über /api (Server)`) with:

```js
async function updateData(table, recordId, fields) {
  // Sperr-Shim: Die Speichern-Handler geben die Sperre im selben PATCH frei
  // (lock_user_id = '', lock_until = ''). Sperrfelder schreibt nur noch der Server,
  // deshalb gehen sie nicht mit, und die Sperre wird nach dem Speichern freigegeben.
  let body = fields;
  let releaseAfter = false;
  if (fields && ('lock_user_id' in fields || 'lock_until' in fields)) {
    releaseAfter = 'lock_user_id' in fields && 'lock_until' in fields && !fields.lock_user_id && !fields.lock_until;
    body = Object.assign({}, fields);
    delete body.lock_user_id;
    delete body.lock_until;
  }
  let updated;
  try {
    updated = await _api('PATCH', _dataPath(table, recordId), { body: { fields: body } });
  } catch (e) {
    throw _prefixError('Update fehlgeschlagen: ', e);
  }
  if (releaseAfter) {
    if (_isCurrentLock(table, recordId)) {
      stopLockHeartbeat();
      _currentLock = null;
    }
    try { await _api('POST', _lockPath(table, recordId) + '/release', { reauth: false }); } catch (e) {}
  }
  return updated;
}
```

The nine save handlers (`saveCustomer`, `saveSupplier`, `saveArticle`, `saveInquiry`, `saveQuote`, `saveOrder`, `saveSupplierOrder`, `saveDeliveryNote`, `saveInvoice`) stay as they are. Their `if (_currentLock) { stopLockHeartbeat(); _currentLock = null; }` after the save now finds nothing left to do. If the `PATCH` fails, the lock and its heartbeat stay, and the user can save again.

- [ ] **Step 5: Run the lock tests, then everything**

Run: `npm run test:e2e -- test/e2e/locks.e2e.ts` → PASS.
Run: `npm test && npm run test:e2e && npm run typecheck && npm run lint` → PASS.

- [ ] **Step 6: Commit and push**

```bash
git add index.html test/e2e/locks.e2e.ts
git commit -m "feat(frontend): record locks through /api/locks with an unload beacon"
git push -u origin claude/awesome-faraday-jjwsxl
```

---

### Task 7: File uploads, stored files and the attachment proxy

**Files:**
- Modify: `index.html`:
  - `uploadFileToRecord()` in the section `DATEN: CRUD über /api (Server)`;
  - its six callers: `uploadCompanyLogo`, `uploadCompanySecondaryLogo`, `uploadCompanySubLogo` (section `ADMIN: FIRMEN`), `_adminAddAttachment`, `addAttachmentWithFile`, `addAttachmentFile` (section `ANHÄNGE (Attachment) — Verwaltung + Auswahl`);
  - `_downloadAttachmentAsBase64()` in the section `FRESHDESK ATTACHMENTS — Sammeln + Base64-Download für KI-Vision`.
- Create: `test/e2e/files.e2e.ts`

**Interfaces:**
- Consumes: `_api`, `_dataPath`, `API_BASE` (Task 3); `openCompanyEdit(id)`, `removeCompanyLogo(id)` (existing; `removeCompanyLogo` asks `confirm()` and sends `updateData('Company', id, {logo: []})`).
- Produces (in `index.html`):
  - `uploadFileToRecord(table, recordId, attachmentField, file)` → the updated record (`{id, createdTime, fields}`). Throws `Error('Datei zu groß (max 5 MB)')` for a file over 5 MB without a request, otherwise the server's message with `.status`/`.type` (no prefix: the callers add their own, for example `'Upload fehlgeschlagen: '`).
  - `_downloadAttachmentAsBase64(att)` keeps its contract: base64 string or `null`.

The server side:
- `POST /api/data/:table/:id/files/:field {file: <base64>, filename, contentType}` appends the file to the field and returns the record. Only four fields take files: `Company.logo`, `Company.secondary_logo`, `Company.sub_logo` (admins only: `403 'Nur für Admins'`) and `Attachment.file`.
- A stored file is `{id: 'att…', url: '/api/files/<id>/<encodeURIComponent(filename)>', filename, size, type}`. `GET /api/files/<id>/<name>` needs the session cookie and serves raster images and PDFs inline, everything else as a download.
- `GET /api/attachment-proxy?url=<https URL>` fetches a file from an allowed Freshdesk host (5 MB at most). The allowed hosts are also in the page's CSP `connect-src`, so the browser may try them directly first.

- [ ] **Step 1: Write the failing tests**

```ts
// test/e2e/files.e2e.ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.resetContexts();
});
afterAll(async () => {
  await h.close();
});

// A 1×1 PNG (70 bytes).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('files', () => {
  it('an admin uploads a company logo through the form, its URL serves the image, and removing it works', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'admin');
    await h.run(page, `await openCompanyEdit(${JSON.stringify(h.companies.alpha)});`);
    await page.setInputFiles('#logoUpload', { name: 'logo.png', mimeType: 'image/png', buffer: PNG });
    await page.locator('#toastWrap', { hasText: 'Logo hochgeladen' }).waitFor();
    // uploadCompanyLogo reopens the form after 80 ms; the preview shows the stored file.
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>('#modalBox img[alt="Logo"]');
      return !!img && img.complete && img.naturalWidth > 0;
    });
    const src = (await page.locator('#modalBox img[alt="Logo"]').getAttribute('src')) ?? '';
    expect(/^\/api\/files\/att[A-Za-z0-9]{14}\/logo\.png$/.test(src)).toBe(true);
    const res = await page.context().request.get(h.baseUrl + src);
    expect([res.status(), res.headers()['content-type']]).toEqual([200, 'image/png']);
    expect(Buffer.from(await res.body()).equals(PNG)).toBe(true);

    page.once('dialog', (dialog) => void dialog.accept());
    await page.click('#modalBox button:has-text("Logo entfernen")');
    await page.locator('#toastWrap', { hasText: 'Logo entfernt' }).waitFor();
    expect((await h.deps.records.get('Company', h.companies.alpha))?.fields.logo).toBe(undefined);
    await h.assertClean(page);
  });

  it('a file name with umlauts and spaces uploads and downloads', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    const result = await h.run<Record<string, unknown>>(
      page,
      `const att = await writeData('Attachment', { name: 'Quartal', company_id: [${JSON.stringify(h.companies.alpha)}], status: 'aktiv' });
       const file = new File(['%PDF-1.4 Testinhalt'], 'Übersicht Q3.pdf', { type: 'application/pdf' });
       const rec = await uploadFileToRecord('Attachment', att.id, 'file', file);
       const stored = rec.fields.file[0];
       const res = await fetch(stored.url);
       return {
         urlOk: /^\\/api\\/files\\/att[A-Za-z0-9]{14}\\/%C3%9Cbersicht%20Q3\\.pdf$/.test(stored.url),
         filename: stored.filename, size: stored.size, type: stored.type,
         status: res.status, contentType: res.headers.get('content-type'),
         disposition: res.headers.get('content-disposition'), body: await res.text(),
       };`,
    );
    expect(result).toEqual({
      urlOk: true,
      filename: 'Übersicht Q3.pdf',
      size: 19,
      type: 'application/pdf',
      status: 200,
      contentType: 'application/pdf',
      disposition: `inline; filename="_bersicht Q3.pdf"; filename*=UTF-8''%C3%9Cbersicht%20Q3.pdf`,
      body: '%PDF-1.4 Testinhalt',
    });
    await h.assertClean(page);
  });

  it('refuses a logo upload by a non-admin with the server message, and a file over 5 MB without a request', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    const uploads: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/files/')) uploads.push(r.url());
    });
    expect(
      await h.runError(
        page,
        `await uploadFileToRecord('Company', ${JSON.stringify(h.companies.alpha)}, 'logo', new File(['x'], 'logo.png', { type: 'image/png' }));`,
      ),
    ).toEqual({ message: 'Nur für Admins', status: 403, type: 'FORBIDDEN' });
    const tooBig = await h.runError(
      page,
      `await uploadFileToRecord('Attachment', 'recNichtVorhanden0', 'file', new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'gross.bin'));`,
    );
    expect(tooBig.message).toBe('Datei zu groß (max 5 MB)');
    expect(uploads.length).toBe(1);
    await h.assertClean(page);
  });

  it('downloads a Freshdesk attachment for the AI through the server when the direct fetch fails', async () => {
    h.fake.on('GET', 'https://attachment.freshdesk.com/inline/', () =>
      new Response(Buffer.from('GIF89a'), { headers: { 'content-type': 'image/gif' } }),
    );
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    const proxyAuth: (string | undefined)[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/attachment-proxy')) proxyAuth.push(r.headers()['authorization']);
    });
    // The CDN sends no CORS headers for the app's origin: the direct attempt fails in a real browser too.
    await page.route('https://attachment.freshdesk.com/**', (route) => route.abort());
    const b64 = await h.run<string | null>(
      page,
      `return await _downloadAttachmentAsBase64({ attachment_url: 'https://attachment.freshdesk.com/inline/attachment?token=t1', size: 6 });`,
    );
    expect(b64).toBe(Buffer.from('GIF89a').toString('base64'));
    expect(proxyAuth).toEqual([undefined]);
    expect(h.fake.calls.map((c) => c.url)).toEqual(['https://attachment.freshdesk.com/inline/attachment?token=t1']);
    await h.assertClean(page);
  });
});
```

The first test drives the real form; `#logoUpload` is the logo's file input in `openCompanyEdit`, and `removeCompanyLogo` asks `confirm()`, which the dialog handler accepts. The third test sends exactly one upload request (the refused logo): the size check runs before any request.

- [ ] **Step 2: Run them and see them fail**

Run: `npm run test:e2e -- test/e2e/files.e2e.ts`
Expected: FAIL in all four tests. The old `uploadFileToRecord(recordId, field, file)` throws `Bitte einloggen` before anything else, so the first test never sees "Logo hochgeladen" (it times out waiting), and the second and third get the wrong error. The old `_downloadAttachmentAsBase64` finds no proxy (`_proxyBase()` is `null`) and returns `null`.

- [ ] **Step 3: Rewrite uploadFileToRecord**

Replace `uploadFileToRecord()` (section `DATEN: CRUD über /api (Server)`) with:

```js
// Datei an ein Anhangsfeld hängen: Company.logo / secondary_logo / sub_logo (nur Admins) und Attachment.file.
// Liefert den aktualisierten Datensatz. Fehler tragen den Text des Servers, ohne Präfix:
// die Aufrufer setzen ihr eigenes davor (z.B. 'Upload fehlgeschlagen: ').
async function uploadFileToRecord(table, recordId, attachmentField, file) {
  if (file.size > 5 * 1024 * 1024) throw new Error('Datei zu groß (max 5 MB)');
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  return _api('POST', _dataPath(table, recordId) + '/files/' + encodeURIComponent(attachmentField), {
    body: { file: base64, filename: file.name, contentType: file.type || 'application/octet-stream' }
  });
}
```

- [ ] **Step 4: Pass the table at the six call sites**

| Function | Old call | New call |
|---|---|---|
| `uploadCompanyLogo` | `await uploadFileToRecord(id, 'logo', file);` | `await uploadFileToRecord('Company', id, 'logo', file);` |
| `uploadCompanySecondaryLogo` | `await uploadFileToRecord(id, 'secondary_logo', file);` | `await uploadFileToRecord('Company', id, 'secondary_logo', file);` |
| `uploadCompanySubLogo` | `await uploadFileToRecord(id, 'sub_logo', file);` | `await uploadFileToRecord('Company', id, 'sub_logo', file);` |
| `_adminAddAttachment` | `await uploadFileToRecord(created.id, 'file', file);` | `await uploadFileToRecord('Attachment', created.id, 'file', file);` |
| `addAttachmentWithFile` | `await uploadFileToRecord(created.id, 'file', file);` | `await uploadFileToRecord('Attachment', created.id, 'file', file);` |
| `addAttachmentFile` | `await uploadFileToRecord(attachmentId, 'file', file);` | `await uploadFileToRecord('Attachment', attachmentId, 'file', file);` |

Check: `grep -c "uploadFileToRecord('Company'" index.html` → `3`; `grep -c "uploadFileToRecord('Attachment'" index.html` → `3`; `grep -c "uploadFileToRecord(" index.html` → `7` (six calls and the definition).

Nothing else about stored files changes: the previews (`<img src="${escapeHtml(f.logo[0].url)}">`), `removeCompanyLogo` and its two siblings (`{logo: []}`), `removeAttachmentFile` (`{file: [{id}, …]}`) and the bundle download in `_emailQuoteDoSend` (`fetch(f.url)`) all work with the same-origin URLs.

- [ ] **Step 5: Use the server's attachment proxy**

In `_downloadAttachmentAsBase64()`, change the comment line `//   2. Über Val.town-Proxy /attachment-proxy (CORS-Bypass)` to `//   2. Über den Server: /api/attachment-proxy (CORS-Bypass, nur erlaubte Freshdesk-Hosts)` and replace the whole `const tryProxy = async () => { … };` with:

```js
  const tryProxy = async () => {
    try {
      const r = await fetch(API_BASE + '/attachment-proxy?url=' + encodeURIComponent(att.attachment_url), { credentials: 'same-origin' });
      if (!r.ok) return null;
      const b = await r.blob();
      return b.size <= MAX_SIZE ? b : null;
    } catch (_) { return null; }
  };
```

(It uses `fetch` rather than `_api` because it needs the body as a `Blob`; `_api` returns text or JSON. An expired session only makes the download return `null`, as any other failure does.)

- [ ] **Step 6: Run the file tests, then everything**

Run: `npm run test:e2e -- test/e2e/files.e2e.ts` → PASS.
Run: `npm test && npm run test:e2e && npm run typecheck && npm run lint` → PASS.

- [ ] **Step 7: Commit and push**

```bash
git add index.html test/e2e/files.e2e.ts
git commit -m "feat(frontend): file uploads and the attachment proxy through /api"
git push -u origin claude/awesome-faraday-jjwsxl
```

---

### Task 8: Freshdesk, Freshsales, Mailchimp and Anthropic through the server

**Files:**
- Modify: `index.html`:
  - the section `API-PROXY (Val.town)`: its header comment, `_proxyBase`, `_bearerForProxy` (deleted) and `proxyFetch`; `freshdeskFetch` stays as it is;
  - `getMailchimpConfig()` and `mailchimpFetch()` in the section `COMPANY (MANDANT) STATE`;
  - one condition in `_renderFreshdeskTicket()` and one hint in `loadFreshdeskTicketsPreview()`.
- Create: `test/e2e/proxies.e2e.ts`

**Interfaces:**
- Consumes: `_api`, `API_BASE` (Task 3; `_api` errors carry `.status`, `.type`, `.body`, `.text`); `APP_KEYS.currentCompanyId` and `APP_KEYS.companies[].has_mailchimp_key` (Task 3, `loadCompanies()`); `askAI(prompt, opts)` (existing, unchanged).
- Produces (in `index.html`):
  - `_proxyBase()` → `'/api'` (always truthy, so the existing "is the proxy configured?" checks pass).
  - `_proxyErrorMessage(e)` → the old proxy's error text for an `_api` error: `'Proxy <status>: ' + error.message` (or `error` when it is a string) from a JSON body with an `error` key, otherwise `'Proxy <status>: ' + <first 200 characters of the body>`; `'Proxy <status>'` for an empty body; `e.message` unchanged when there is no status (network error, cancelled re-login).
  - `proxyFetch(path, { method, headers, body } = {})` → parsed JSON, or text (`''` for a `204`). `path` is relative to `/api`: `freshdesk/api/v2/…`, `freshsales/api/…`, `mailchimp/3.0/…`, `anthropic/v1/messages`, `health`. Adds `X-Company-Id: APP_KEYS.currentCompanyId` to `freshdesk/` paths unless the caller set it. Throws the `_api` error with its message replaced by `_proxyErrorMessage(e)`, keeping `.status`, `.type`, `.body`, `.text`.
  - `getMailchimpConfig(mandantId)` → `{mandantId, mandantName, has_key, server_prefix, list_id, list_name}` or `null` (`api_key` is gone).
  - `mailchimpFetch(path, opts = {}, mandantId = null)`: requires `has_key`, sends `X-Company-Id: <mandantId>` and no key headers.

The server side (all under `/api`, session cookie required):
- `/api/freshdesk/api/v2/<path>` forwards to `https://<FRESHDESK_DOMAIN>.freshdesk.com/api/v2/<path>` for the endpoints `index.html` uses (anything else: `403 {error: {type: 'FORBIDDEN', message: 'Endpoint nicht freigegeben'}}`). The key is the user's key for the company in `X-Company-Id` (only a company the user may use), else the user's default key, else `FRESHDESK_API_KEY`. Multipart bodies are forwarded byte for byte.
- `/api/freshsales/api/<path>` uses `FRESHSALES_SUBDOMAIN` and `FRESHSALES_API_KEY`; `/api/anthropic/v1/messages` (POST only) uses `ANTHROPIC_API_KEY`.
- `/api/mailchimp/3.0/ping` and `/lists` need `X-Company-Id` and use that company's stored key. The server prefix comes from the company's `mailchimp_server_prefix`, else from the key's suffix (`…-us21`). Admins may send `x-mailchimp-key`/`x-mailchimp-server` to test unsaved values (Task 9).
- Upstream answers pass through unchanged (status, body, content type; no body for `204`). `GET /api/health` returns `{ok: true, auth_kind: 'session', user: {name, is_admin, has_freshdesk_key, freshdesk_company_keys}}`.
- The e2e harness's `testEnv` sets `FRESHDESK_DOMAIN=flptest`, `FRESHDESK_API_KEY=env-freshdesk-key`, `FRESHSALES_SUBDOMAIN=gilt`, `FRESHSALES_API_KEY=test-freshsales-key` and `ANTHROPIC_API_KEY=test-anthropic-key`.

- [ ] **Step 1: Write the failing tests**

`h.fake.on(method, urlPrefix, responder)` routes stay registered for the whole file and the first match wins, so every test uses its own URLs. `h.fake.calls` also collects across the file; the tests filter it by URL.

```ts
// test/e2e/proxies.e2e.ts
import type { Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { jsonResponse } from '../helpers/fakeFetch.js';
import { startHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.resetContexts();
});
afterAll(async () => {
  await h.close();
});

const FD = 'https://flptest.freshdesk.com/api/v2/';
const basic = (user: string, password: string): string => 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
const callsTo = (prefix: string) => h.fake.calls.filter((c) => c.url.startsWith(prefix));
// Headers of the page's own /api requests whose URL contains `part`, collected from now on.
const apiRequests = (page: Page, part: string): Record<string, string>[] => {
  const seen: Record<string, string>[] = [];
  page.on('request', (r) => {
    if (r.url().startsWith(h.baseUrl + '/api/') && r.url().includes(part)) seen.push(r.headers());
  });
  return seen;
};
// askAI logs its usage without awaiting it, so the test polls for the row.
const eventually = async (check: () => Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('condition not met within 5 s');
};

describe('upstream proxies', () => {
  it("freshdeskFetch sends the current company, and the server uses that company's Freshdesk key", async () => {
    h.fake.on('GET', FD + 'tickets/101', () => jsonResponse({ id: 101, subject: 'Anfrage Alpha' }));
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    const sent = apiRequests(page, '/freshdesk/');
    const subjects = await h.run<string[]>(
      page,
      `APP_KEYS.currentCompanyId = ${JSON.stringify(h.companies.alpha)};
       const a = await freshdeskFetch('tickets/101');
       APP_KEYS.currentCompanyId = ${JSON.stringify(h.companies.beta)};
       const b = await freshdeskFetch('/api/v2/tickets/101');
       return [a.subject, b.subject];`,
    );
    expect(subjects).toEqual(['Anfrage Alpha', 'Anfrage Alpha']);
    expect(sent.map((s) => [s['x-company-id'], s['authorization']])).toEqual([
      [h.companies.alpha, undefined],
      [h.companies.beta, undefined],
    ]);
    // Vera has a key for Alpha only; for Beta the server falls back to FRESHDESK_API_KEY.
    expect(callsTo(FD + 'tickets/101').map((c) => c.headers.get('authorization'))).toEqual([
      basic('fd-key-alpha', 'X'),
      basic('env-freshdesk-key', 'X'),
    ]);
    await h.assertClean(page);
  });

  it('Freshsales, Anthropic and the health check go through the server with its keys', async () => {
    h.fake.on('GET', 'https://gilt.freshworks.com/crm/sales/api/sales_accounts/77', () =>
      jsonResponse({ sales_account: { id: 77, name: 'Alpha Kunde' } }),
    );
    h.fake.on('POST', 'https://api.anthropic.com/v1/messages', () =>
      jsonResponse({
        id: 'msg_e2e',
        model: 'claude-sonnet-4-5-20250929',
        content: [{ type: 'text', text: 'Hallo zurück' }],
        usage: { input_tokens: 12, output_tokens: 4 },
      }),
    );
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    const result = await h.run<Record<string, unknown>>(
      page,
      `const fs = await proxyFetch('freshsales/api/sales_accounts/77');
       const ai = await askAI('Hallo KI', { purpose: 'e2e-test' });
       const health = await proxyFetch('health');
       return { fs: fs.sales_account.name, ai, health };`,
    );
    expect(result).toEqual({
      fs: 'Alpha Kunde',
      ai: 'Hallo zurück',
      health: {
        ok: true,
        auth_kind: 'session',
        user: { name: 'Vera Vertrieb', is_admin: false, has_freshdesk_key: false, freshdesk_company_keys: [h.companies.alpha] },
      },
    });
    const [fsCall] = callsTo('https://gilt.freshworks.com/');
    expect(fsCall?.headers.get('authorization')).toBe('Token token=test-freshsales-key');
    const [aiCall] = callsTo('https://api.anthropic.com/');
    expect(aiCall?.headers.get('x-api-key')).toBe('test-anthropic-key');
    expect(JSON.parse(String(aiCall?.body)).messages).toEqual([{ role: 'user', content: 'Hallo KI' }]);
    // askAI logs the usage with writeData('AiUsageLog', …), which every user may create.
    await eventually(async () =>
      (await h.deps.records.list('AiUsageLog')).some((r) => r.fields.purpose === 'e2e-test' && r.fields.input_tokens === 12),
    );
    await h.assertClean(page);
  });

  it('keeps the old error format "Proxy <status>: …" and resolves a 204', async () => {
    // Freshdesk's answer to a duplicate company name. _tcmCreateFdCompany reads the id out of the message.
    // The body is shorter than 200 characters, so the message carries all of it.
    const duplicate = {
      description: 'Validation failed',
      errors: [{ field: 'name', additional_info: { company_id: 4711 }, message: 'It should be a unique value', code: 'duplicate_value' }],
    };
    h.fake.on('POST', FD + 'companies', () => jsonResponse(duplicate, 409));
    h.fake.on('DELETE', FD + 'conversations/555', () => new Response(null, { status: 204 }));
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    const dup = await h.runError(page, `await proxyFetch('freshdesk/api/v2/companies', { method: 'POST', body: { name: 'Alpha GmbH' } });`);
    expect(dup).toEqual({ message: 'Proxy 409: ' + JSON.stringify(duplicate), status: 409 });
    expect(/"company_id"\s*:\s*(\d+)/.exec(dup.message)?.[1]).toBe('4711');
    // The server refuses a path outside its allowlist itself; the text comes from {error: {message}}.
    expect(await h.runError(page, `await proxyFetch('freshdesk/api/v2/admin/secrets');`)).toEqual({
      message: 'Proxy 403: Endpoint nicht freigegeben',
      status: 403,
      type: 'FORBIDDEN',
    });
    expect(await h.run(page, `return await proxyFetch('freshdesk/api/v2/conversations/555', { method: 'DELETE' });`)).toBe('');
    expect(callsTo(FD + 'admin/')).toEqual([]);
    await h.assertClean(page);
  });

  it('an upstream 401 is an error for the caller, not an expired session', async () => {
    const rejected = { code: 'invalid_credentials', message: 'You have to be logged in to perform this action.' };
    h.fake.on('GET', FD + 'tickets/401', () => jsonResponse(rejected, 401));
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    expect(await h.runError(page, `await freshdeskFetch('tickets/401');`)).toEqual({
      message: 'Proxy 401: ' + JSON.stringify(rejected),
      status: 401,
    });
    // No re-login overlay (Task 11), and the session still works.
    expect(await page.locator('#reauthOverlay').count()).toBe(0);
    expect(await h.run(page, `return (await _api('GET', '/me')).user.name;`)).toBe('Vera Vertrieb');
    await h.assertClean(page);
  });

  it('sends a multipart body (an e-mail with a PDF) to Freshdesk with its boundary intact', async () => {
    h.fake.on('POST', FD + 'tickets/outbound_email', () => jsonResponse({ id: 9001 }, 201));
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    const id = await h.run<number>(
      page,
      `const fd = new FormData();
       fd.append('subject', 'Angebot Q-1001');
       fd.append('email', 'kunde@example.com');
       fd.append('attachments[]', new Blob(['%PDF-1.4 Angebot'], { type: 'application/pdf' }), 'Angebot Q-1001.pdf');
       const res = await proxyFetch('freshdesk/api/v2/tickets/outbound_email', { method: 'POST', body: fd });
       return res.id;`,
    );
    expect(id).toBe(9001);
    const [call] = callsTo(FD + 'tickets/outbound_email');
    const contentType = call?.headers.get('content-type') ?? '';
    expect(contentType.startsWith('multipart/form-data; boundary=')).toBe(true);
    const form = await new Response(new Uint8Array(call?.body ?? Buffer.alloc(0)), {
      headers: { 'content-type': contentType },
    }).formData();
    const file = form.get('attachments[]') as File | null;
    expect([form.get('subject'), form.get('email'), file?.name, file?.type, await file?.text()]).toEqual([
      'Angebot Q-1001',
      'kunde@example.com',
      'Angebot Q-1001.pdf',
      'application/pdf',
      '%PDF-1.4 Angebot',
    ]);
    await h.assertClean(page);
  });

  it('mailchimpFetch needs a stored key and sends only the company id', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    const sent = apiRequests(page, '/mailchimp/');
    const beta = JSON.stringify(h.companies.beta);
    expect((await h.runError(page, `await mailchimpFetch('3.0/ping', {}, ${beta});`)).message).toBe(
      'Mailchimp ist nicht konfiguriert für Mandant „Beta AG" (Admin → Einstellungen)',
    );
    expect(sent).toEqual([]);

    await h.apiAs('admin', 'PATCH', `/api/admin/companies/${h.companies.beta}/secrets`, { mailchimp_api_key: 'mc-key-beta-us21' });
    h.fake.on('GET', 'https://us21.api.mailchimp.com/3.0/ping', () => jsonResponse({ health_status: "Everything's Chimpy!" }));
    const result = await h.run<unknown[]>(
      page,
      `await loadCompanies();
       const c = APP_KEYS.companies.find(x => x.id === ${beta});
       const r = await mailchimpFetch('3.0/ping', {}, ${beta});
       return [c.has_mailchimp_key, r.health_status];`,
    );
    expect(result).toEqual([true, "Everything's Chimpy!"]);
    expect(sent.map((s) => [s['x-company-id'], s['x-mailchimp-key'], s['x-mailchimp-server']])).toEqual([
      [h.companies.beta, undefined, undefined],
    ]);
    const [call] = callsTo('https://us21.api.mailchimp.com/');
    expect(call?.headers.get('authorization')).toBe(basic('anystring', 'mc-key-beta-us21'));
    await h.assertClean(page);
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npm run test:e2e -- test/e2e/proxies.e2e.ts`
Expected: FAIL in all six tests. The first five get `API-Proxy nicht konfiguriert. Bitte Admin → Einstellungen → Val.town-Setup ausführen.` from the old `proxyFetch`, because `_proxyBase()` is `null`. In the sixth the first assertion passes (no key, same message) and the call after saving the key still fails, because the old `mailchimpFetch` wants `mailchimp_api_key` in the browser.

- [ ] **Step 3: Rewrite the proxy section**

Replace everything from the `/* ===` line above `API-PROXY (Val.town)` down to the closing `}` of `proxyFetch` (that is, the header comment, `_proxyBase`, the comment and body of `_bearerForProxy`, and `proxyFetch`; stop before `async function freshdeskFetch`) with:

```js
/* ============================================================
   API-PROXY: Freshdesk, Freshsales, Mailchimp, Anthropic über den Server
   Die Keys liegen auf dem Server; der Browser schickt nur das Session-Cookie.
   Pfade (unter /api):  freshdesk/api/v2/…   freshsales/api/…
                        mailchimp/3.0/…      anthropic/v1/messages   health
   ============================================================ */
// Basis der Proxy-Routen. Mit dem Server ist der Proxy immer da; die Funktion
// bleibt, weil viele Stellen „ist der Proxy konfiguriert?" fragen.
function _proxyBase() {
  return API_BASE;
}

// Fehlertext im Format des alten Proxys — Aufrufer werten ihn aus
// (z.B. sucht _tcmCreateFdCompany /409/ und "company_id" in einem Freshdesk-409):
// 'Proxy <Status>: ' + error.message bzw. error aus JSON, sonst die ersten 200 Zeichen der Antwort.
function _proxyErrorMessage(e) {
  if (!e.status) return e.message;
  let msg = 'Proxy ' + e.status;
  if (e.text) {
    const j = e.body;
    if (j && typeof j === 'object' && j.error) msg += ': ' + (j.error.message || j.error);
    else msg += ': ' + e.text.slice(0, 200);
  }
  return msg;
}

async function proxyFetch(path, opts = {}) {
  const p = String(path).replace(/^\/+/, '');
  const headers = Object.assign({}, opts.headers || {});
  // Aktuelle Firma NUR für Freshdesk-Pfade mitsenden: der Server nimmt damit
  // den Freshdesk-Key des Users für diese Firma (sonst dessen Default-Key).
  if (p.startsWith('freshdesk/') && !headers['X-Company-Id'] && APP_KEYS.currentCompanyId) {
    headers['X-Company-Id'] = APP_KEYS.currentCompanyId;
  }
  // Bei FormData setzt der Browser Content-Type samt Boundary selbst.
  const isFormData = opts.body instanceof FormData;
  if (isFormData) delete headers['Content-Type'];
  else if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  try {
    return await _api(opts.method || 'GET', '/' + p, { body: opts.body || undefined, headers });
  } catch (e) {
    e.message = _proxyErrorMessage(e);
    throw e;
  }
}
```

Copy the two `=` lines of the header from an existing section header (60 `=` each). `freshdeskFetch` below stays unchanged.

- [ ] **Step 4: Mailchimp through the stored key**

In the section `COMPANY (MANDANT) STATE`, replace `getMailchimpConfig()` and `mailchimpFetch()`, with the comment lines directly above each (`// Mailchimp-Config pro Mandant …` and `// Mailchimp-API-Call ueber den Val.town-Proxy …` with its `// path: …` line), by:

```js
// Mailchimp-Config pro Mandant (Default: aktueller Mandant). Der Key liegt auf dem Server.
function getMailchimpConfig(mandantId) {
  const cur = mandantId
    ? APP_KEYS.companies.find(c => c.id === mandantId)
    : getCurrentCompany();
  if (!cur) return null;
  return {
    mandantId:     cur.id,
    mandantName:   cur.name,
    has_key:       !!cur.has_mailchimp_key,
    server_prefix: (cur.mailchimp_server_prefix || '').trim().toLowerCase(),
    list_id:       (cur.mailchimp_list_id || '').trim(),
    list_name:     (cur.mailchimp_list_name || '').trim()
  };
}

// Mailchimp-API-Call über den Server: er nimmt Key und Server-Prefix des Mandanten (X-Company-Id).
// path: z.B. '3.0/ping', '3.0/lists'
async function mailchimpFetch(path, opts = {}, mandantId = null) {
  const cfg = getMailchimpConfig(mandantId);
  if (!cfg) throw new Error('Kein Mandant ausgewählt');
  if (!cfg.has_key) {
    throw new Error('Mailchimp ist nicht konfiguriert für Mandant „' + cfg.mandantName + '" (Admin → Einstellungen)');
  }
  const headers = Object.assign({ 'X-Company-Id': cfg.mandantId }, opts.headers || {});
  return await proxyFetch('mailchimp/' + String(path).replace(/^\/+/, ''), {
    method: opts.method || 'GET',
    headers,
    body: opts.body
  });
}
```

(The server derives the prefix from the key when `mailchimp_server_prefix` is empty, so only the key is required.)

- [ ] **Step 5: Two leftovers of the old proxy in the ticket views**

In `_renderFreshdeskTicket()`, change the footer condition `${APP_KEYS.freshdeskProxyUrl || _proxyBase() ? \`` to `${_proxyBase() ? \``.

In `loadFreshdeskTicketsPreview()`, in the "Group-ID fehlt" box, replace the two lines

```js
        <p class="mt-2">ID herausfinden via Curl:</p>
        <code class="block mt-1 bg-amber-100 p-2 rounded text-[10px] break-all">curl -H "Authorization: Bearer DEIN_USER_KEY" ${escapeHtml(_proxyBase() || '')}/freshdesk/api/v2/groups</code>
```

with

```js
        <p class="mt-2">Die Gruppen wählst du unter Admin → <strong>Einstellungen</strong> → „Freshdesk-Gruppen für Anfragen + Bestellungen" aus.</p>
```

Check by counts: `grep -c "_bearerForProxy" index.html` → `1` (inside `valtownStartSetup`, in a `try`/`catch`; Task 9 deletes that function); `grep -c "DEIN_USER_KEY" index.html` → `0`; `grep -c "freshdeskProxyUrl ||" index.html` → `0`; `grep -c "x-mailchimp-key" index.html` → `6` (the two settings-page calls and the Mailchimp hint box, which Task 9 rewrites and deletes, and three lines inside `VALTOWN_PROXY_CODE`, which Task 9 deletes).

- [ ] **Step 6: Run the proxy tests, then everything**

Run: `npm run test:e2e -- test/e2e/proxies.e2e.ts` → PASS.
Run: `npm test && npm run test:e2e && npm run typecheck && npm run lint` → PASS.

- [ ] **Step 7: Commit and push**

```bash
git add index.html test/e2e/proxies.e2e.ts
git commit -m "feat(frontend): Freshdesk, Freshsales, Mailchimp and Anthropic through the server"
git push -u origin claude/awesome-faraday-jjwsxl
```

---

### Task 9: Settings on the server, settings page without Val.town

**Files:**
- Modify: `index.html`:
  - the section `SERVER-EINSTELLUNGEN (nicht geheim; früher in der Master-Base)` (from Task 4): add `saveSetting()`;
  - the section `ADMIN: EINSTELLUNGEN — Val.town Setup-Wizard`: its header comment;
  - the section `FRESHSALES CUSTOM FIELDS · Status-Check + Auto-Setup-Versuch`, which holds `renderAdminSettings()`, the save and test handlers and the Mailchimp helpers;
  - 15 Val.town and Master-Base blocks, deleted by a script: the Val.town constants in `APP CONFIG`, `APP_KEYS.valtownKey`/`valtownValId`, the sections `VAL.TOWN MANAGEMENT API` and `VAL.TOWN SCHNELL-SETUP`, `VALTOWN_PROXY_CODE`, the Master-Base helpers, the wizard steps 1–4 of the settings page and their handlers;
  - step numbers in texts of `_memSend`, `openNewTicketModal`, `_newTicketSubmit`, `_tcmPushFdToFs`, `_fsCheckCustomFieldsStatus`, `syncCustomerToFreshdesk` and `syncCustomerToFreshsales`.
- Modify: `test/frontend/guard.test.ts`
- Create: `test/e2e/settings.e2e.ts`
- Scratch (not committed): `<scratchpad>/delete-valtown.mjs`

**Interfaces:**
- Consumes:
  - `_api(method, path, { body, headers, keepalive, reauth })` (Task 3). Its errors carry `.status`, `.type`, `.body`, `.text`, and the server's message as `.message`.
  - `updateData(table, id, fields)` (Task 3). A secret field throws; an empty value clears the field.
  - `_applySettings(settings)`, `loadSettings()` and `APP_KEYS.freshdeskSalesGroupId`, `freshdeskOrderGroupId`, `freshdeskTicketTypes`, `freshdeskDomain`, `freshsalesSubdomain` (Task 4; `null` when not set).
  - `proxyFetch(path, opts)` (Task 8; errors read `'Proxy <status>: …'`).
  - `APP_KEYS.companies[].has_mailchimp_key` (Task 3; there is no `mailchimp_api_key` in the browser).
  - `toast(html, type, ms)` and `escapeHtml(s)` (existing). `toast` puts its text into `innerHTML`, so a text that can contain `<` or server text must be escaped.
- Produces (in `index.html`):
  - `saveSetting(key, value)` → `Promise<Record<string, string>>`. It sends `PUT /api/settings/<key>` with `{value}`, where an empty value deletes the setting. It applies the returned settings to `APP_KEYS` and returns them. Errors are the `_api` error: a non-admin gets status `403`, type `FORBIDDEN`, message `Nur für Admins`.
  - `_saveSettingFromForm(key, val, savedText, removedText)` → `Promise<boolean>`: the shared flow of the settings page's save buttons.
  - `_mcCallValues(companyId)` and `_mcRequestHeaders(companyId, vals)`: the values and headers of the Mailchimp test and list calls.
  - The settings page's steps are numbered 1–7: 1 Freshdesk-Gruppen, 2 Ticket-Typen, 3 Freshdesk-Subdomain, 4 Email-Inbox-ID, 5 Mailchimp, 6 Freshsales, 7 Freshsales Custom Fields. Texts elsewhere in the app refer to these numbers.
  - These element ids stay: `settingsSalesGroupId`, `settingsOrderGroupId`, `settingsTicketTypes`, `settingsFdDomain`, `settingsFdEmailConfigId`, `settingsFsDomain`, `proxyTestResult`, and the `data-mc-*` attributes of the Mailchimp rows. `settingsFsApiKey` and all wizard ids are gone.

The server side (unchanged):
- `GET /api/settings` → `{settings}` with the keys that are set. `PUT /api/settings/:key` with `{value}` is admin-only (`403 FORBIDDEN 'Nur für Admins'`). It takes a string of at most 2000 characters, trims it, deletes the key for an empty value and returns `{settings}` with all settings. An unknown key gets `400 INVALID_REQUEST 'Unbekannte Einstellung: <key>'`.
- `PATCH /api/admin/companies/:id/secrets` with `{mailchimp_api_key}` stores the key encrypted (`null` or `''` removes it) and returns `{has_mailchimp_key}`. `updateData` refuses the field: `INVALID_REQUEST 'Geheime Felder nur über Admin-Funktion (mailchimp_api_key)'`.
- `/api/mailchimp/3.0/ping` and `/api/mailchimp/3.0/lists` need `X-Company-Id`. Only admins may send `x-mailchimp-key`/`x-mailchimp-server`, to test values that are not saved. Without them the server takes the company's stored key, and the server prefix from `mailchimp_server_prefix`, else from the key's suffix (`…-us21`). The prefix must match `/^[a-z]{2,3}\d{1,2}$/`.
- The Freshsales proxy uses `FRESHSALES_SUBDOMAIN` and `FRESHSALES_API_KEY` (the harness sets `gilt` and `test-freshsales-key`) and allows `GET lookup`. Without them it answers `NOT_CONFIGURED` with `FRESHSALES_SUBDOMAIN fehlt in der Server-Konfiguration`.

- [ ] **Step 1: Extend the guard test**

In `test/frontend/guard.test.ts`, add inside `describe('index.html', …)`:

```ts
  it('has no Val.town setup or Master-Base code left', () => {
    for (const name of [
      'VALTOWN_PROXY_CODE', '_fetchMasterBaseKeys', '_writeMasterBaseKey', '_deleteMasterBaseKey', '_valtownEnvVars',
      '_applyKeyToAppState', 'api.val.town', 'valtownStartSetup', 'valtownAutoSetup', 'valtownSetEnvVar',
      '_bearerForProxy', 'settingsFsApiKey',
    ]) {
      expect(html.includes(name), name).toBe(false);
    }
  });
```

- [ ] **Step 2: Write the failing e2e tests**

`renderAdminSettings()` is async: it writes "Lade Einstellungen…" at once, loads the settings and the Freshdesk groups, then writes the page. The save buttons call it again without waiting, so the tests wait for the toast and then for the freshly rendered input.

```ts
// test/e2e/settings.e2e.ts
import type { Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { jsonResponse } from '../helpers/fakeFetch.js';
import { startHarness, type Harness } from './harness.js';

const FD = 'https://flptest.freshdesk.com/api/v2/';
const basic = (user: string, password: string): string => 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
  // Every render of the settings page loads the Freshdesk groups for the dropdowns.
  h.fake.on('GET', FD + 'groups', () => jsonResponse([{ id: 11, name: 'Vertrieb' }, { id: 12, name: 'Bestellungen' }]));
});
afterEach(async () => {
  await h.resetContexts();
});
afterAll(async () => {
  await h.close();
});

const callsTo = (prefix: string) => h.fake.calls.filter((c) => c.url.startsWith(prefix));
const settings = async (): Promise<Record<string, string>> =>
  (await h.apiAs<{ settings: Record<string, string> }>('admin', 'GET', '/api/settings')).settings;
const companyFields = async (id: string): Promise<Record<string, unknown>> =>
  (await h.deps.records.get('Company', id))?.fields ?? {};
// Headers of the page's own /api requests whose URL contains `part`, collected from now on.
const apiRequests = (page: Page, part: string): Record<string, string>[] => {
  const seen: Record<string, string>[] = [];
  page.on('request', (r) => {
    if (r.url().startsWith(h.baseUrl + '/api/') && r.url().includes(part)) seen.push(r.headers());
  });
  return seen;
};
const toast = (page: Page, text: string): Promise<void> => page.locator('#toastWrap', { hasText: text }).waitFor();
// Opens the settings page as the admin. showApp() renders the start page synchronously, so nothing
// overwrites the settings page afterwards. The 5 s limit lets a page that never renders fail fast.
const openSettings = async (page: Page): Promise<void> => {
  await h.openApp(page, 'admin');
  await h.run(page, 'await renderAdminSettings();');
  await page.locator('#settingsFdDomain').waitFor({ timeout: 5_000 });
};
// A save re-renders the page. The toast appears in the same task that starts the re-render,
// so after the toast the old input is gone, and this waits for the fresh one.
const inputShows = (page: Page, selector: string, value: string): Promise<unknown> =>
  page.waitForFunction(
    ([sel, want]) => document.querySelector<HTMLInputElement | HTMLSelectElement>(sel)?.value === want,
    [selector, value] as const,
  );

describe('settings page', () => {
  it('saves the Freshdesk domain on the server, and it survives a reload (scenario 9)', async () => {
    const page = await h.newPage();
    await openSettings(page);
    await page.fill('#settingsFdDomain', 'https://flpliftparts.freshdesk.com/');
    await page.click('button[onclick="saveFreshdeskDomain()"]');
    await toast(page, 'Freshdesk-Domain gespeichert');
    expect((await settings()).freshdeskDomain).toBe('flpliftparts');
    expect(await h.run(page, 'return APP_KEYS.freshdeskDomain;')).toBe('flpliftparts');
    // Let the re-render finish before reloading, so no request is cut off.
    await inputShows(page, '#settingsFdDomain', 'flpliftparts');

    await page.reload();
    await page.waitForSelector('#appShell:not(.hidden)', { state: 'visible' });
    // The boot loads the settings before it shows the app shell.
    expect(await h.run(page, 'return APP_KEYS.freshdeskDomain;')).toBe('flpliftparts');
    await h.run(page, 'await renderAdminSettings();');
    expect(await page.inputValue('#settingsFdDomain')).toBe('flpliftparts');
    await h.assertClean(page);
  });

  it('shows no Val.town setup, offers the Freshdesk groups and tests the connection to the server', async () => {
    const page = await h.newPage();
    await openSettings(page);
    const text = await page.locator('#pageContent').innerText();
    expect(/val\.?town|Master-Base|Proxy-URL/i.test(text)).toBe(false);
    expect(await page.locator('#valtownCodeBlock, #valtownKeyInput, #settingsProxyUrl, #settingsFsApiKey').count()).toBe(0);
    expect(await page.locator('#settingsSalesGroupId option').allTextContents()).toEqual([
      '— keine Default-Sales-Gruppe —',
      'Bestellungen (#12)',
      'Vertrieb (#11)',
    ]);
    await page.selectOption('#settingsSalesGroupId', '11');
    await page.click('button[onclick="saveSalesGroupId()"]');
    await toast(page, 'Sales-Group-ID gespeichert');
    expect((await settings()).freshdeskSalesGroupId).toBe('11');
    await inputShows(page, '#settingsSalesGroupId', '11');

    await page.click('button[onclick="testProxyConnection()"]');
    const result = page.locator('#proxyTestResult', { hasText: 'Verbindung erfolgreich' });
    await result.waitFor();
    const resultText = await result.innerText();
    expect(resultText.includes('Authentifiziert als Ada Admin (admin).')).toBe(true);
    // The admin has no Freshdesk key, so the page points to the server's fallback key.
    expect(resultText.includes('FRESHDESK_API_KEY')).toBe(true);
    await h.assertClean(page);
  });

  it('normalizes the ticket types, deletes the setting when emptied, and skips a save without change', async () => {
    const page = await h.newPage();
    await openSettings(page);
    await page.fill('#settingsTicketTypes', ' Anfrage ,, Bestellung ');
    await page.click('button[onclick="saveTicketTypes()"]');
    await toast(page, 'Ticket-Typen-Filter gespeichert');
    expect((await settings()).freshdeskTicketTypes).toBe('Anfrage, Bestellung');
    await inputShows(page, '#settingsTicketTypes', 'Anfrage, Bestellung');

    await page.fill('#settingsTicketTypes', '');
    await page.click('button[onclick="saveTicketTypes()"]');
    await toast(page, 'Filter entfernt — alle Tickettypen');
    expect('freshdeskTicketTypes' in (await settings())).toBe(false);
    expect(await h.run(page, 'return APP_KEYS.freshdeskTicketTypes;')).toBe(null);
    await inputShows(page, '#settingsTicketTypes', '');

    // Nothing set and nothing typed: no request at all.
    const puts = apiRequests(page, '/settings/');
    await page.click('button[onclick="saveTicketTypes()"]');
    await toast(page, 'Kein Filter (alle Tickettypen)');
    expect(puts).toEqual([]);
    await h.assertClean(page);
  });

  it('refuses settings changes by a non-admin', async () => {
    const before = (await settings()).freshdeskDomain;
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    expect(await h.runError(page, "await saveSetting('freshdeskDomain', 'fremd');")).toEqual({
      message: 'Nur für Admins',
      status: 403,
      type: 'FORBIDDEN',
    });
    expect((await settings()).freshdeskDomain).toBe(before);
    await h.run(page, 'await renderAdminSettings();');
    expect((await page.locator('#pageContent').innerText()).includes('Nur für Admins.')).toBe(true);
    await h.assertClean(page);
  });

  it('stores a Mailchimp key encrypted on the server and never shows it again (scenario 11)', async () => {
    h.fake.on('GET', 'https://us21.api.mailchimp.com/3.0/ping', () => jsonResponse({ health_status: "Everything's Chimpy!" }));
    h.fake.on('GET', 'https://us21.api.mailchimp.com/3.0/lists', () =>
      jsonResponse({ lists: [{ id: 'l1', name: 'Newsletter', stats: { member_count: 3 } }] }),
    );
    const alpha = h.companies.alpha;
    const row = `[data-mc-row-company="${alpha}"]`;
    const page = await h.newPage();
    await openSettings(page);
    const secretCalls = apiRequests(page, '/admin/companies/');
    const mailchimpCalls = apiRequests(page, '/mailchimp/');
    const statusShows = (text: string) => page.locator(`[data-mc-status="${alpha}"]`, { hasText: text }).waitFor();

    await page.fill(`${row} [data-mc-input="api_key"]`, 'mc-key-alpha-us21');
    await page.fill(`${row} [data-mc-input="list_id"]`, 'list-alpha');
    await page.click(`${row} button[onclick^="_mcSaveCompany"]`);
    await statusShows('✓ Gespeichert');
    const fields = await companyFields(alpha);
    expect([fields.mailchimp_server_prefix, fields.mailchimp_list_id, 'mailchimp_api_key' in fields]).toEqual([
      'us21',
      'list-alpha',
      false,
    ]);
    expect(await h.deps.secrets.mailchimpKey(alpha)).toBe('mc-key-alpha-us21');
    expect(secretCalls.length).toBe(1);
    // The browser keeps no key: the cache has the flag only, and the input is empty again.
    expect(
      await h.run(
        page,
        `const c = APP_KEYS.companies.find(x => x.id === ${JSON.stringify(alpha)});
         return [c.has_mailchimp_key, 'mailchimp_api_key' in c];`,
      ),
    ).toEqual([true, false]);
    expect(await page.inputValue(`${row} [data-mc-input="api_key"]`)).toBe('');
    expect(await page.getAttribute(`${row} [data-mc-input="api_key"]`, 'placeholder')).toBe('leer = unverändert');
    expect(await page.inputValue(`${row} [data-mc-input="server_prefix"]`)).toBe('us21');

    // Test and audience list use the stored key; a second save keeps it.
    await page.click(`${row} button[onclick^="_mcTestConnection"]`);
    await statusShows("Verbindung OK: Everything's Chimpy!");
    await page.click(`${row} button[onclick^="_mcLoadAudiences"]`);
    await page.click(`${row} [data-mc-pick-list-id="l1"]`);
    // The status reads "Verbindung OK" now, so "Gespeichert" comes from this save.
    await page.click(`${row} button[onclick^="_mcSaveCompany"]`);
    await statusShows('✓ Gespeichert');
    const after = await companyFields(alpha);
    expect([after.mailchimp_server_prefix, after.mailchimp_list_id, after.mailchimp_list_name]).toEqual([
      'us21',
      'l1',
      'Newsletter',
    ]);
    expect(await h.deps.secrets.mailchimpKey(alpha)).toBe('mc-key-alpha-us21');
    expect(secretCalls.length).toBe(1);
    expect(mailchimpCalls.map((s) => [s['x-company-id'], s['x-mailchimp-key'], s['x-mailchimp-server']])).toEqual([
      [alpha, undefined, undefined],
      [alpha, undefined, undefined],
    ]);
    expect(callsTo('https://us21.api.mailchimp.com/3.0/').map((c) => c.headers.get('authorization'))).toEqual([
      basic('anystring', 'mc-key-alpha-us21'),
      basic('anystring', 'mc-key-alpha-us21'),
    ]);
    await h.assertClean(page);
  });

  it('tests Mailchimp with the stored key while the key input is empty, and with a typed key without saving it', async () => {
    const beta = h.companies.beta;
    await h.apiAs('admin', 'PATCH', `/api/admin/companies/${beta}/secrets`, { mailchimp_api_key: 'mc-key-beta-us19' });
    h.fake.on('GET', 'https://us19.api.mailchimp.com/3.0/ping', () => jsonResponse({ health_status: 'Gespeicherter Key OK' }));
    h.fake.on('GET', 'https://us5.api.mailchimp.com/3.0/ping', () => jsonResponse({ health_status: 'Neuer Key OK' }));
    const row = `[data-mc-row-company="${beta}"]`;
    const page = await h.newPage();
    await openSettings(page);
    const sent = apiRequests(page, '/mailchimp/');
    const statusShows = (text: string) => page.locator(`[data-mc-status="${beta}"]`, { hasText: text }).waitFor();
    expect(await page.inputValue(`${row} [data-mc-input="api_key"]`)).toBe('');

    await page.click(`${row} button[onclick^="_mcTestConnection"]`);
    await statusShows('Verbindung OK: Gespeicherter Key OK');
    await page.fill(`${row} [data-mc-input="api_key"]`, 'mc-key-neu-us5');
    await page.click(`${row} button[onclick^="_mcTestConnection"]`);
    await statusShows('Verbindung OK: Neuer Key OK');

    expect(sent.map((s) => [s['x-company-id'], s['x-mailchimp-key'], s['x-mailchimp-server']])).toEqual([
      [beta, undefined, undefined],
      [beta, 'mc-key-neu-us5', 'us5'],
    ]);
    expect(callsTo('https://us19.api.mailchimp.com/').map((c) => c.headers.get('authorization'))).toEqual([
      basic('anystring', 'mc-key-beta-us19'),
    ]);
    expect(callsTo('https://us5.api.mailchimp.com/').map((c) => c.headers.get('authorization'))).toEqual([
      basic('anystring', 'mc-key-neu-us5'),
    ]);
    // Testing saves nothing.
    expect(await h.deps.secrets.mailchimpKey(beta)).toBe('mc-key-beta-us19');
    await h.assertClean(page);
  });

  it('saves the Freshsales subdomain without a token field and tests the server key', async () => {
    h.fake.on('GET', 'https://gilt.freshworks.com/crm/sales/api/lookup', () => jsonResponse({}));
    const page = await h.newPage();
    await openSettings(page);
    expect(await page.locator('#settingsFsApiKey').count()).toBe(0);
    await page.fill('#settingsFsDomain', 'https://gilt.freshworks.com/crm/sales/');
    await page.click('button[onclick="saveFreshsalesSetup(this)"]');
    await toast(page, 'Freshsales-Subdomain gespeichert');
    expect((await settings()).freshsalesSubdomain).toBe('gilt');
    // The test button is rendered once a subdomain is set; click waits for the re-render.
    await page.click('button[onclick="testFreshsalesConnection(this)"]');
    await toast(page, '✓ Freshsales-API erreichbar · Auth + Subdomain OK');
    const [lookup] = callsTo('https://gilt.freshworks.com/crm/sales/api/lookup');
    expect(lookup?.headers.get('authorization')).toBe('Token token=test-freshsales-key');
    expect((await page.locator('#pageContent').innerText()).includes('FRESHSALES_API_KEY')).toBe(true);
    await h.assertClean(page);
  });
});
```

- [ ] **Step 3: Run both and see them fail**

Run: `npx vitest run test/frontend/guard.test.ts`
Expected: FAIL, `VALTOWN_PROXY_CODE: expected true to be false`.

Run: `npm run test:e2e -- test/e2e/settings.e2e.ts`
Expected: FAIL in all seven tests. Six time out in `openSettings` (`locator.waitFor: Timeout 5000ms exceeded`): the old page still reads the Master base from Airtable, that request is blocked, and the page shows "Fehler beim Laden: …" instead of the form. The non-admin test gets `saveSetting is not defined`.

- [ ] **Step 4: Delete the Val.town and Master-Base blocks with a script**

The script finds each block by its first and last line and deletes it. It prints only block names and line counts, never file content. It stops without writing if any anchor is missing or found twice.

```js
// delete-valtown.mjs — run from the repo root. Deletes the Val.town and Master-Base blocks of
// index.html by anchor lines. Prints block names and line counts only, never line content.
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2] || 'index.html';
const lines = readFileSync(file, 'utf8').split('\n');
const HEADER = /^\/\* ={60}$/;

// start: must match exactly one line. end: the first matching line after start.
// single: the block is the start line alone. endExclusive: stop before the end line.
// header: also delete the `/* ===` line above start. plusOne: the end line is followed by `}`.
// blankAfter: also delete one blank line directly after the block.
const BLOCKS = [
  { name: 'Val.town constants (APP CONFIG)', start: /^\/\/ Val\.town Auto-Setup Konstanten/, end: /^const VALTOWN_FILE_PATH = /, blankAfter: true },
  { name: 'APP_KEYS valtownKey/valtownValId', start: /^ {2}\/\/ Val\.town Auto-Setup: Token \+ ID des Vals/, end: /^ {2}valtownValId: null,$/ },
  { name: 'section VAL.TOWN MANAGEMENT API', start: /^ {3}VAL\.TOWN MANAGEMENT API — Auto-Setup \+ Re-Deploy$/, header: true, end: /^ {2}return \{ valId, endpointUrl: cleanUrl, isUpdate \};$/, plusOne: true, blankAfter: true },
  { name: 'VALTOWN_PROXY_CODE', start: /^\/\/ Der komplette Val\.town-Code als Copy-Paste-Vorlage/, end: /^`;$/, blankAfter: true },
  { name: '_valtownEnvVars + Master-Base helpers', start: /^\/\/ Definitionen für Env-Vars-Tabelle im Wizard/, end: /^function _maskSecret\(val\) \{$/, endExclusive: true },
  { name: '_applyKeyToAppState + _settingsWizState', start: /^\/\/ Spiegelt einen geänderten Key in APP_KEYS, damit er sofort wirkt$/, end: /^let _settingsWizState = /, blankAfter: true },
  { name: 'settings page: architecture diagram', start: /^ {6}<!-- Architektur-Diagramm -->$/, end: /^ {6}<!-- Setup-Status -->$/, endExclusive: true },
  { name: 'settings page: steps 1-4', start: /^ {6}<!-- =+ STEP 1 =+ -->$/, end: /^ {6}<!-- =+ STEP 5 — Freshdesk-Gruppen/, endExclusive: true },
  { name: 'settings page: Mailchimp Val.town box', start: /^ {12}<div class="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-900 mb-3">$/, startNext: /Damit das funktioniert, muss der Val\.town-Proxy/, end: /^ {12}<\/div>$/ },
  { name: 'settings page: Schnell-Setup + Master-Base list', start: /^ {6}<!-- =+ SCHNELL-SETUP \(Auto via Val\.town API\) =+ -->$/, end: /^ {6}<\/details>$/ },
  { name: 'settings page: code block fill', start: /^ {2}\/\/ Code-Block befüllen \(textContent damit kein HTML interpretiert wird\)$/, end: /^ {2}if \(codeEl\) codeEl\.textContent = VALTOWN_PROXY_CODE;$/, blankAfter: true },
  { name: 'copyValTownCode + saveProxyUrl', start: /^async function copyValTownCode\(btnEl\) \{$/, end: /^async function saveSalesGroupId\(\) \{$/, endExclusive: true },
  { name: 'stray groups comment', start: /^\/\/ Helper: holt alle Gruppen aus Freshdesk und listet sie zur Auswahl auf\.$/, single: true },
  { name: 'loadFreshdeskGroupsList', start: /^async function loadFreshdeskGroupsList\(btnEl\) \{$/, end: /^\}$/, blankAfter: true },
  { name: 'section VAL.TOWN SCHNELL-SETUP', start: /^ {3}VAL\.TOWN SCHNELL-SETUP — Single-Click-Action$/, header: true, end: /^async function saveTicketTypes\(\) \{$/, endExclusive: true },
];

const ranges = [];
for (const b of BLOCKS) {
  const starts = [];
  lines.forEach((l, i) => {
    if (b.start.test(l) && (!b.startNext || b.startNext.test(lines[i + 1] ?? ''))) starts.push(i);
  });
  if (starts.length !== 1) {
    console.log(`abort: "${b.name}": expected one start line, found ${starts.length}`);
    process.exit(1);
  }
  let from = starts[0];
  if (b.header) {
    if (!HEADER.test(lines[from - 1] ?? '')) {
      console.log(`abort: "${b.name}": no section header above the start line`);
      process.exit(1);
    }
    from -= 1;
  }
  let to = b.single ? starts[0] : -1;
  for (let i = starts[0] + 1; !b.single && i < lines.length; i++) {
    if (b.end.test(lines[i])) { to = i; break; }
  }
  if (to < 0) {
    console.log(`abort: "${b.name}": end line not found`);
    process.exit(1);
  }
  if (b.endExclusive) to -= 1;
  if (b.plusOne) {
    if (lines[to + 1] !== '}') { console.log(`abort: "${b.name}": expected "}" after the end line`); process.exit(1); }
    to += 1;
  }
  if (b.blankAfter && lines[to + 1] === '') to += 1;
  ranges.push({ name: b.name, from, to });
}
ranges.sort((a, b) => a.from - b.from);
for (let i = 1; i < ranges.length; i++) {
  if (ranges[i].from <= ranges[i - 1].to) {
    console.log(`abort: "${ranges[i].name}" overlaps "${ranges[i - 1].name}"`);
    process.exit(1);
  }
}
const drop = new Set();
for (const r of ranges) {
  for (let i = r.from; i <= r.to; i++) drop.add(i);
  console.log(`${r.name}: ${r.to - r.from + 1} lines`);
}
writeFileSync(file, lines.filter((_, i) => !drop.has(i)).join('\n'));
console.log(`removed ${drop.size} lines in ${ranges.length} blocks`);
```

Run from the repo root: `node <scratchpad>/delete-valtown.mjs index.html`

Expected output, exactly:

```
Val.town constants (APP CONFIG): 7 lines
APP_KEYS valtownKey/valtownValId: 5 lines
section VAL.TOWN MANAGEMENT API: 160 lines
VALTOWN_PROXY_CODE: 472 lines
_valtownEnvVars + Master-Base helpers: 63 lines
_applyKeyToAppState + _settingsWizState: 13 lines
settings page: architecture diagram: 23 lines
settings page: steps 1-4: 76 lines
settings page: Mailchimp Val.town box: 3 lines
settings page: Schnell-Setup + Master-Base list: 51 lines
settings page: code block fill: 4 lines
copyValTownCode + saveProxyUrl: 22 lines
stray groups comment: 1 lines
loadFreshdeskGroupsList: 32 lines
section VAL.TOWN SCHNELL-SETUP: 49 lines
removed 981 lines in 15 blocks
```

If the script aborts or a count differs, stop and report its output. Don't change the anchors: a different count means an earlier task touched one of these blocks.

Then check by counts only: `grep -c VALTOWN_PROXY_CODE index.html` → `0`, `grep -c _valtownEnvVars index.html` → `1`, `grep -c _fetchMasterBaseKeys index.html` → `6`, `grep -c _writeMasterBaseKey index.html` → `5`, `grep -c _deleteMasterBaseKey index.html` → `5`, `grep -c valtownSetEnvVar index.html` → `3`. These leftovers sit in `renderAdminSettings()` and the save handlers, which Steps 7 and 8 rewrite.

The edits below are exact: each "Replace" text occurs once in `index.html` (twice where it says "both occurrences"). "The whole function `name()`" runs from its `function` line to the first line after it that is exactly `}`.

- [ ] **Step 5: Rewrite the section header**

In the header of the section `ADMIN: EINSTELLUNGEN — Val.town Setup-Wizard` (the `/* ===` and `=== */` lines stay), replace:

```js
   ADMIN: EINSTELLUNGEN — Val.town Setup-Wizard
   Der Val.town-Proxy ist die einzige Stelle, an der API-Keys für
   Anthropic + Freshdesk leben. Browser hält keine externen Keys mehr.
   Auth zum Proxy = User-API-Key (Bearer). Val.town validiert ihn
   gegen Airtable User-Tabelle (mit In-Memory-Cache).
```

with:

```js
   ADMIN: EINSTELLUNGEN
   Nicht geheime Einstellungen liegen auf dem Server (/api/settings, nur
   Admins schreiben). API-Keys sind Railway-Variablen; Mailchimp-Keys liegen
   verschlüsselt am Mandanten auf dem Server. Der Browser sieht keinen Key.
```

`_maskSecret()` directly below stays; Task 10 removes it together with its last callers in the user admin.

- [ ] **Step 6: Add `saveSetting()`**

In the section `SERVER-EINSTELLUNGEN (nicht geheim; früher in der Master-Base)` from Task 4, add directly after the function `loadSettings()`:

```js
// Speichert eine Einstellung auf dem Server (nur Admins). Leerer Wert = Einstellung löschen.
// Übernimmt die Antwort (alle Einstellungen) in APP_KEYS.
async function saveSetting(key, value) {
  const data = await _api('PUT', '/settings/' + encodeURIComponent(key), {
    body: { value: value == null ? '' : String(value) }
  });
  _applySettings(data && data.settings);
  return (data && data.settings) || {};
}
```

- [ ] **Step 7: Build the settings page from the server settings**

All edits of this step are inside `renderAdminSettings()`.

(a) The page no longer reads the Master base. The settings come from the server, and the Freshdesk groups are always loaded. Replace:

```js
  // Aktuelle Master-Base-Keys laden für Statusanzeige
  let keys = [];
  try { keys = await _fetchMasterBaseKeys(); }
  catch (e) {
    document.getElementById('pageContent').innerHTML = `
      <div class="max-w-3xl mx-auto"><div class="bg-red-50 border border-red-200 rounded-2xl p-6 text-red-900">Fehler beim Laden: ${escapeHtml(e.message)}</div></div>`;
    return;
  }
  const byName = {};
  keys.forEach(rec => { byName[rec.fields.key_name] = rec; });
  const proxyRec     = byName['apiProxyUrl'];
  const proxyUrl     = proxyRec?.fields?.key_value || '';
  const salesRec     = byName['freshdeskSalesGroupId'];
  const salesGroupId = salesRec?.fields?.key_value || '';
  const typesRec     = byName['freshdeskTicketTypes'];
  const ticketTypes  = typesRec?.fields?.key_value || '';
  const domainRec    = byName['freshdeskDomain'];
  const fdDomain     = domainRec?.fields?.key_value || '';

  const isProxySet = !!proxyUrl;
  const envVars = _valtownEnvVars();

  // Freshdesk-Gruppen vorab laden, damit Sales/Order-Group-IDs als Dropdown auswählbar sind.
  // Bei Fehler (kein Proxy, kein FD-Key) wird auf Text-Input zurückgefallen.
  let fdGroups = null;
  if (isProxySet) {
    try {
      const list = await proxyFetch('freshdesk/api/v2/groups', { method: 'GET' });
      if (Array.isArray(list)) {
        fdGroups = list
          .map(g => ({ id: String(g.id), name: g.name || ('Gruppe ' + g.id), description: g.description || '' }))
          .sort((a, b) => a.name.localeCompare(b.name, 'de'));
      }
    } catch (e) {
      console.warn('[AdminSettings] FD-Gruppen konnten nicht geladen werden:', e.message);
    }
  }
  window._fdGroupsCache = fdGroups;
```

with:

```js
  // Einstellungen frisch vom Server holen (auch für die Anzeige unten)
  await loadSettings();
  const salesGroupId = APP_KEYS.freshdeskSalesGroupId || '';
  const orderGroupId = APP_KEYS.freshdeskOrderGroupId || '';
  const ticketTypes  = APP_KEYS.freshdeskTicketTypes || '';
  const fdDomain     = APP_KEYS.freshdeskDomain || '';

  // Freshdesk-Gruppen vorab laden, damit Sales/Order-Group-IDs als Dropdown auswählbar sind.
  // Bei Fehler (Server-Key fehlt o.ä.) wird auf Text-Input zurückgefallen.
  let fdGroups = null;
  try {
    const list = await proxyFetch('freshdesk/api/v2/groups', { method: 'GET' });
    if (Array.isArray(list)) {
      fdGroups = list
        .map(g => ({ id: String(g.id), name: g.name || ('Gruppe ' + g.id), description: g.description || '' }))
        .sort((a, b) => a.name.localeCompare(b.name, 'de'));
    }
  } catch (e) {
    console.warn('[AdminSettings] FD-Gruppen konnten nicht geladen werden:', e.message);
  }
  window._fdGroupsCache = fdGroups;
```

(b) Page header. Replace:

```js
          <h2 class="text-xl font-bold text-ink-900">Einstellungen · Val.town-Setup</h2>
          <p class="text-xs text-ink-500 mt-0.5">Externe API-Keys (Anthropic, Freshdesk) liegen ausschließlich serverseitig in Val.town. Im Browser bleibt nur der User-API-Key für die Auth.</p>
```

with:

```js
          <h2 class="text-xl font-bold text-ink-900">Einstellungen</h2>
          <p class="text-xs text-ink-500 mt-0.5">API-Keys sind Railway-Variablen auf dem Server (<code>ANTHROPIC_API_KEY</code>, <code>FRESHDESK_DOMAIN</code>/<code>FRESHDESK_API_KEY</code>, <code>FRESHSALES_SUBDOMAIN</code>/<code>FRESHSALES_API_KEY</code>). Mailchimp-Keys liegen verschlüsselt am Mandanten auf dem Server. Der Browser sieht keinen Key.</p>
```

(c) Status tile. Replace:

```js
            <span class="text-ink-700">Proxy-URL gesetzt</span>
            ${statusBadge(isProxySet, isProxySet ? 'OK' : 'fehlt')}
```

with:

```js
            <span class="text-ink-700">API-Keys</span>
            ${statusBadge(true, 'auf dem Server')}
```

Replace:

```js
            <button type="button" onclick="testProxyConnection()" class="text-xs text-brand-600 hover:text-brand-700 font-medium flex items-center gap-1" ${!isProxySet ? 'disabled' : ''}>
```

with:

```js
            <button type="button" onclick="testProxyConnection()" class="text-xs text-brand-600 hover:text-brand-700 font-medium flex items-center gap-1">
```

(d) Old step 5 becomes step 1. Replace:

```js
      <!-- ============ STEP 5 — Freshdesk-Gruppen (Anfragen + Bestellungen, pro Mandant) ============ -->
```

with:

```js
      <!-- ============ STEP 1 — Freshdesk-Gruppen (Anfragen + Bestellungen, pro Mandant) ============ -->
```

`orderGroupId` is now read at the top of the function. Delete:

```js
        const orderRec = byName['freshdeskOrderGroupId'];
        const orderGroupId = orderRec?.fields?.key_value || '';
```

Replace:

```js
          ${stepHeader(5, 'Freshdesk-Gruppen für Anfragen + Bestellungen',
```

with:

```js
          ${stepHeader(1, 'Freshdesk-Gruppen für Anfragen + Bestellungen',
```

Replace:

```js
                  <span>Freshdesk-Gruppen konnten nicht geladen werden — IDs bitte manuell eintragen. Proxy + FD-Key prüfen.</span>
```

with:

```js
                  <span>Freshdesk-Gruppen konnten nicht geladen werden — IDs bitte manuell eintragen. Server-Variablen <code>FRESHDESK_DOMAIN</code>/<code>FRESHDESK_API_KEY</code> bzw. deinen Freshdesk-Key prüfen.</span>
```

Replace:

```js
Die Felder werden bei Bedarf automatisch auf der Company-Tabelle angelegt (<code>fd_sales_group_id</code>, <code>fd_order_group_id</code>).
```

with:

```js
Die Werte werden am Mandanten gespeichert (<code>fd_sales_group_id</code>, <code>fd_order_group_id</code>).
```

(e) Old step 6 becomes step 2. Replace:

```js
      <!-- ============ STEP 6 ============ -->
```

with:

```js
      <!-- ============ STEP 2 ============ -->
```

Replace:

```js
        ${stepHeader(6, 'Ticket-Typen filtern (optional)',
```

with:

```js
        ${stepHeader(2, 'Ticket-Typen filtern (optional)',
```

(f) Old step 7 becomes step 3, with a hint that the domain is only used for links. Replace:

```js
      <!-- ============ STEP 7 ============ -->
```

with:

```js
      <!-- ============ STEP 3 ============ -->
```

Replace:

```js
        ${stepHeader(7, 'Freshdesk-Subdomain (für Direktlinks)',
```

with:

```js
        ${stepHeader(3, 'Freshdesk-Subdomain (für Direktlinks)',
```

Replace:

```js
          <p class="text-sm text-ink-700 mb-2">Damit die App Tickets direkt in Freshdesk öffnen kann (Klick aufs Link-Icon in der Anfragen-Liste), brauche ich deine Freshdesk-Subdomain.</p>
```

with:

```js
          <p class="text-sm text-ink-700 mb-2">Damit die App Tickets direkt in Freshdesk öffnen kann (Klick aufs Link-Icon in der Anfragen-Liste), brauche ich deine Freshdesk-Subdomain.</p>
          <p class="text-[11px] text-ink-500 mb-2">Nur für Links: API-Aufrufe gehen immer an die Freshdesk-Domain aus der Server-Variable <code>FRESHDESK_DOMAIN</code>.</p>
```

(g) Old step 8 becomes step 4. The Email-Inbox-ID stays in `localStorage`. Replace:

```js
      <!-- ============ STEP 8 — Freshdesk Email-Inbox-ID (für Outbound-Email) ============ -->
```

with:

```js
      <!-- ============ STEP 4 — Freshdesk Email-Inbox-ID (für Outbound-Email) ============ -->
```

Replace:

```js
          ${stepHeader(8, 'Freshdesk Email-Inbox-ID (für Email-Versand)',
```

with:

```js
          ${stepHeader(4, 'Freshdesk Email-Inbox-ID (für Email-Versand)',
```

(h) Old step 8b becomes step 5. The browser knows only whether a Mailchimp key is stored (`has_mailchimp_key`), never the key. Replace:

```js
      <!-- ============ STEP 8b — Mailchimp pro Mandant ============ -->
```

with:

```js
      <!-- ============ STEP 5 — Mailchimp pro Mandant ============ -->
```

Replace:

```js
        const anySet = companies.some(c => c.mailchimp_api_key && c.mailchimp_server_prefix);
```

with:

```js
        const linked = companies.filter(c => c.has_mailchimp_key).length;
```

Replace:

```js
          ${stepHeader(9, 'Mailchimp pro Mandant (optional)', anySet ? statusBadge(true, companies.filter(c => c.mailchimp_api_key && c.mailchimp_server_prefix).length + '/' + companies.length + ' Mandanten verknüpft') : statusBadge(false, 'nicht konfiguriert'))}
```

with:

```js
          ${stepHeader(5, 'Mailchimp pro Mandant (optional)', linked ? statusBadge(true, linked + '/' + companies.length + ' Mandanten verknüpft') : statusBadge(false, 'nicht konfiguriert'))}
```

Replace:

```js
Jeder Mandant kann mit einem eigenen Mailchimp-Account verbunden werden. Die API-Daten liegen am Mandanten in Airtable, der Val.town-Proxy verwendet sie pro Request (kein env var je Firma notwendig).
```

with:

```js
Jeder Mandant kann mit einem eigenen Mailchimp-Account verbunden werden. Der API-Key wird verschlüsselt auf dem Server gespeichert und danach nicht mehr angezeigt; Server-Prefix und Audience liegen am Mandanten.
```

Replace:

```js
                const hasKey = !!c.mailchimp_api_key;
```

with:

```js
                const hasKey = !!c.has_mailchimp_key;
```

Replace:

```js
                      <label class="block text-[10px] text-ink-500 mb-0.5">API-Key</label>
```

with:

```js
                      <label class="block text-[10px] text-ink-500 mb-0.5">API-Key${hasKey ? ' <span class="text-emerald-700">· gespeichert</span>' : ''}</label>
```

Replace:

```js
value="${escapeHtml(c.mailchimp_api_key || '')}" placeholder="xxxxx-us21"
```

with:

```js
value="" placeholder="${hasKey ? 'leer = unverändert' : 'xxxxx-us21'}" autocomplete="new-password"
```

(i) Old step 9 becomes step 6. The Freshsales token field goes; the token is a Railway variable. Replace:

```js
      <!-- ============ STEP 9 — Freshsales-CRM (optional) ============ -->
```

with:

```js
      <!-- ============ STEP 6 — Freshsales-CRM (optional) ============ -->
```

Delete:

```js
        const canPushEnv = !!(APP_KEYS.valtownKey && APP_KEYS.valtownValId);
        const sameAsFd = fsDomain && APP_KEYS.freshdeskDomain && fsDomain === APP_KEYS.freshdeskDomain;
```

Replace:

```js
          ${stepHeader(9, 'Freshsales-CRM-Sync (optional)',
```

with:

```js
          ${stepHeader(6, 'Freshsales-CRM-Sync (optional)',
```

Replace:

```js
(bei Verwendung in einem Quote/Auftrag), braucht es Subdomain + API-Token.</p>
```

with:

```js
(bei Verwendung in einem Quote/Auftrag), braucht es die Freshsales-Subdomain; den API-Token kennt nur der Server.</p>
```

Replace:

```js
              ${canPushEnv
                ? '✓ Beim Speichern wird der Token automatisch als Val.town-Env-Var <code>FRESHSALES_API_KEY</code> abgelegt (per Val.town-API) — wir speichern ihn NICHT in der App-Master-Base.'
                : '⚠ Val.town-Auto-Setup oben durchführen, damit Token automatisch in Val.town gespeichert werden kann. Sonst musst du <code>FRESHSALES_API_KEY</code> manuell in Val.town setzen.'}
```

with:

```js
              Der Token ist die Railway-Variable <code>FRESHSALES_API_KEY</code>, die Subdomain für die API-Aufrufe <code>FRESHSALES_SUBDOMAIN</code> (beide in Railway unter Variables setzen). Die Subdomain hier dient den Links und schaltet den Sync in der App ein.
```

Delete (the API-Token column; the Subdomain column with `#settingsFsDomain` stays):

```js
              <div>
                <label class="block text-xs font-medium text-ink-700 mb-1">API-Token ${canPushEnv ? '(landet in Val.town)' : '(noch nicht zustellbar)'}</label>
                <input type="password" id="settingsFsApiKey" value="" placeholder="${fsDomain ? 'leer = beibehalten' : 'aus Freshsales Settings'}" class="w-full px-3 py-2 border border-ink-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/30 text-sm font-mono" autocomplete="off">
                <p class="text-[10px] text-ink-500 mt-0.5">${canPushEnv ? 'wird beim Speichern direkt in Val.town gepusht' : 'nicht in App speichern — manuell in Val.town setzen'}</p>
              </div>
```

The "Verbindung testen" button stays as it is: it is rendered once a subdomain is saved.

(j) Old step 10 becomes step 7. Replace:

```js
      <!-- ============ STEP 10 — Freshsales Custom Fields (für ERP-Sync) ============ -->
```

with:

```js
      <!-- ============ STEP 7 — Freshsales Custom Fields (für ERP-Sync) ============ -->
```

Replace:

```js
   // Step 10 nur anzeigen wenn Step 9 erledigt
```

with:

```js
   // Step 7 nur anzeigen wenn Step 6 erledigt
```

Replace:

```js
          ${stepHeader(10, 'Freshsales Custom Fields (ERP-Integration)',
```

with:

```js
          ${stepHeader(7, 'Freshsales Custom Fields (ERP-Integration)',
```

- [ ] **Step 8: Save handlers through `saveSetting()`**

`copyToClipboard()` stays. Add directly before the function `saveSalesGroupId()`:

```js
// Gemeinsamer Ablauf der Speichern-Buttons: Wert auf dem Server speichern (leer = löschen),
// passenden Toast zeigen, Seite neu aufbauen.
async function _saveSettingFromForm(key, val, savedText, removedText) {
  const had = !!APP_KEYS[key];
  try {
    if (val || had) await saveSetting(key, val);
    if (val) toast(savedText, 'success');
    else if (had) toast(removedText, 'success');
    renderAdminSettings();
    return true;
  } catch (e) {
    toast(escapeHtml(e.message), 'error', 7000);
    return false;
  }
}
```

Replace the whole function `saveSalesGroupId()` with:

```js
async function saveSalesGroupId() {
  const inp = document.getElementById('settingsSalesGroupId');
  if (!inp) return;
  const val = (inp.value || '').trim();
  await _saveSettingFromForm('freshdeskSalesGroupId', val, 'Sales-Group-ID gespeichert', 'Sales-Group-ID entfernt');
}
```

Replace the whole function `saveOrderGroupId()` (its comment line above stays) with:

```js
async function saveOrderGroupId() {
  const inp = document.getElementById('settingsOrderGroupId');
  if (!inp) return;
  const val = (inp.value || '').trim();
  await _saveSettingFromForm('freshdeskOrderGroupId', val, 'Bestellungen-Group-ID gespeichert', 'Bestellungen-Group-ID entfernt');
}
```

Replace the whole function `saveFreshdeskDomain()` with:

```js
async function saveFreshdeskDomain() {
  const inp = document.getElementById('settingsFdDomain');
  if (!inp) return;
  // Bereinige: https://, .freshdesk.com, trailing slash entfernen
  const val = (inp.value || '').trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\.freshdesk\.com\/?$/i, '')
    .replace(/\/+$/, '');
  await _saveSettingFromForm('freshdeskDomain', val, 'Freshdesk-Domain gespeichert', 'Domain entfernt');
}
```

Replace the whole function `saveTicketTypes()` with:

```js
async function saveTicketTypes() {
  const inp = document.getElementById('settingsTicketTypes');
  if (!inp) return;
  // Eingabe normalisieren: Whitespace trimmen, leere Einträge raus, Komma-getrennt
  const val = String(inp.value || '')
    .split(',').map(s => s.trim()).filter(Boolean).join(', ');
  if (!val && !APP_KEYS.freshdeskTicketTypes) { toast('Kein Filter (alle Tickettypen)', 'info', 1500); return; }
  await _saveSettingFromForm('freshdeskTicketTypes', val, 'Ticket-Typen-Filter gespeichert', 'Filter entfernt — alle Tickettypen');
}
```

The Freshsales setup saves only the subdomain. Replace:

```js
// Speichert Subdomain in Master-Base + optional API-Token direkt als Val.town-Env-Var.
```

with:

```js
// Speichert die Freshsales-Subdomain auf dem Server. Der API-Token ist die Railway-Variable FRESHSALES_API_KEY.
```

Replace the whole function `saveFreshsalesSetup()` with:

```js
async function saveFreshsalesSetup(btnEl) {
  const inp = document.getElementById('settingsFsDomain');
  if (!inp) return;
  const subdomain = (inp.value || '').trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\.freshworks\.com\/?.*$/i, '')
    .replace(/\/+$/, '');
  const origHtml = btnEl?.innerHTML;
  if (btnEl) { btnEl.disabled = true; btnEl.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> Speichere…'; if (window.lucide) lucide.createIcons(); }
  try {
    await _saveSettingFromForm('freshsalesSubdomain', subdomain, 'Freshsales-Subdomain gespeichert', 'Subdomain entfernt');
  } finally {
    if (btnEl && origHtml) { btnEl.disabled = false; btnEl.innerHTML = origHtml; if (window.lucide) lucide.createIcons(); }
  }
}
```

`saveFreshsalesSubdomain()` (the legacy helper above it) stays.

In `testFreshsalesConnection()`, the hints name the Railway variables. Replace:

```js
      msg = 'Env-Vars in Val.town fehlen — Subdomain + Token im Step 9 unten neu eintragen und „Speichern".';
```

with:

```js
      msg = 'Freshsales ist auf dem Server nicht eingerichtet — Railway-Variablen FRESHSALES_SUBDOMAIN und FRESHSALES_API_KEY setzen.';
```

Replace:

```js
      msg = 'Token ungültig oder abgelaufen — neuen Token aus Freshsales (Profil → API-Einstellungen) holen und in Step 9 eintragen.';
```

with:

```js
      msg = 'Token ungültig oder abgelaufen — neuen Token aus Freshsales (Profil → API-Einstellungen) holen und als Railway-Variable FRESHSALES_API_KEY setzen.';
```

The message can contain the server's text, here and in `_memSend()`. Replace both occurrences of:

```js
    toast(msg, 'error', 10000);
```

with:

```js
    toast(escapeHtml(msg), 'error', 10000);
```

Replace:

```js
// FD Email-Inbox-ID (für Outbound-Email) speichern — nur localStorage, kein Master-Base-Key
```

with:

```js
// FD Email-Inbox-ID (für Outbound-Email) speichern — nur localStorage
```

In `testProxyConnection()`, the server is always there, and the hint names the server's fallback key. Delete:

```js
  if (!_proxyBase()) {
    wrap.innerHTML = '<p class="text-xs text-amber-700 italic">Bitte erst Proxy-URL eintragen (Step 4).</p>';
    return;
  }
```

Replace:

```js
    const fdInfo = data?.user?.has_freshdesk_key
      ? '<span class="inline-flex items-center gap-1 mt-1.5 text-[10px] uppercase tracking-wider bg-emerald-200 text-emerald-800 px-1.5 py-0.5 rounded font-semibold"><i data-lucide="headphones" class="w-3 h-3"></i> persönlicher Freshdesk-Key gesetzt</span>'
      : '<p class="text-[11px] mt-1.5 text-emerald-700">Hinweis: Du hast keinen persönlichen Freshdesk-Key am User-Record — Calls laufen über den env-var-Fallback (sofern gesetzt).</p>';
```

with:

```js
    const fdCompanies = (data?.user?.freshdesk_company_keys || []).length;
    const fdInfo = data?.user?.has_freshdesk_key
      ? '<span class="inline-flex items-center gap-1 mt-1.5 text-[10px] uppercase tracking-wider bg-emerald-200 text-emerald-800 px-1.5 py-0.5 rounded font-semibold"><i data-lucide="headphones" class="w-3 h-3"></i> persönlicher Freshdesk-Key gesetzt</span>'
      : fdCompanies
        ? '<span class="inline-flex items-center gap-1 mt-1.5 text-[10px] uppercase tracking-wider bg-emerald-200 text-emerald-800 px-1.5 py-0.5 rounded font-semibold"><i data-lucide="headphones" class="w-3 h-3"></i> Freshdesk-Keys für ' + fdCompanies + ' Mandant(en)</span>'
        : '<p class="text-[11px] mt-1.5 text-emerald-700">Hinweis: Du hast keinen persönlichen Freshdesk-Key — Freshdesk-Aufrufe laufen über den Server-Fallback <code>FRESHDESK_API_KEY</code> (sofern gesetzt).</p>';
```

Replace:

```js
        <p class="mt-2 text-red-700">Mögliche Ursachen: URL falsch, Code in Val.town fehlt/alt, Env-Vars fehlen, Read-Key hat keinen Scope auf User-Tabelle.</p>
```

with:

```js
        <p class="mt-2 text-red-700">Mögliche Ursachen: Server nicht erreichbar oder Sitzung abgelaufen.</p>
```

`saveCompanyFdGroups()` stays as it is.

- [ ] **Step 9: Mailchimp without a key in the browser**

Add directly after the function `_mcReadRowInputs()`:

```js
// Werte für Test/Listen: ein eingegebener Key wird probeweise mitgeschickt (nur Admins),
// sonst nimmt der Server den gespeicherten Key des Mandanten.
function _mcCallValues(companyId) {
  const vals = _mcReadRowInputs(companyId);
  if (!vals) return null;
  const c = APP_KEYS.companies.find(x => x.id === companyId);
  if (!vals.api_key && !(c && c.has_mailchimp_key)) { toast('API-Key fehlt', 'warn'); return null; }
  if (vals.api_key && !vals.server_prefix) {
    const m = vals.api_key.match(/-([a-z]{2,3}\d{1,2})$/i);
    if (m) vals.server_prefix = m[1].toLowerCase();
    else { toast('Server-Prefix fehlt (oder im Key nicht erkennbar)', 'warn'); return null; }
  }
  return vals;
}

// Header für die Mailchimp-Aufrufe der Einstellungsseite. Mit eingegebenem Key immer auch den
// Server-Prefix mitsenden: sonst nähme der Server den gespeicherten Prefix.
function _mcRequestHeaders(companyId, vals) {
  const c = APP_KEYS.companies.find(x => x.id === companyId);
  const headers = { 'X-Company-Id': companyId };
  if (vals.api_key) headers['x-mailchimp-key'] = vals.api_key;
  if (vals.server_prefix && (vals.api_key || vals.server_prefix !== ((c && c.mailchimp_server_prefix) || ''))) headers['x-mailchimp-server'] = vals.server_prefix;
  return headers;
}
```

`_mcSaveCompany()` writes the prefix and the audience to the record and a typed key through the admin secrets route. Replace:

```js
// Schreibt die Mailchimp-Felder am Company-Record. Ensure'd das Schema beim ersten Save.
```

with:

```js
// Speichert die Mailchimp-Daten eines Mandanten: Server-Prefix und Audience am Company-Record, einen neu
// eingegebenen API-Key verschlüsselt auf dem Server (nie im Record, nie im Browser-Cache).
```

Replace the whole function `_mcSaveCompany()` with:

```js
async function _mcSaveCompany(companyId, btnEl) {
  if (!companyId) return;
  const vals = _mcReadRowInputs(companyId);
  if (!vals) return;
  const status = document.querySelector('[data-mc-status="' + companyId + '"]');
  // Validierung
  if (vals.api_key && !vals.server_prefix) {
    // versuche Server aus dem Key zu extrahieren (Format xxxx-usNN)
    const m = vals.api_key.match(/-([a-z]{2,3}\d{1,2})$/i);
    if (m) vals.server_prefix = m[1].toLowerCase();
  }
  if ((vals.api_key || vals.server_prefix) && !/^[a-z]{2,3}\d{1,2}$/.test(vals.server_prefix)) {
    if (status) status.innerHTML = '<span class="text-red-700">Server-Prefix ungültig (Erwartet z.B. us21, eu1)</span>';
    return;
  }
  const c = APP_KEYS.companies.find(x => x.id === companyId);
  // Der Name kommt aus der Audience-Auswahl; bei unveränderter List-ID bleibt der gespeicherte Name.
  const listName = vals.list_name || (c && vals.list_id === c.mailchimp_list_id ? (c.mailchimp_list_name || '') : '');
  const origHtml = btnEl?.innerHTML;
  if (btnEl) { btnEl.disabled = true; btnEl.innerHTML = '<i data-lucide="loader-2" class="w-3 h-3 animate-spin"></i> Speichere…'; if (window.lucide) lucide.createIcons(); }
  try {
    await updateData('Company', companyId, {
      mailchimp_server_prefix: vals.server_prefix,
      mailchimp_list_id:       vals.list_id,
      mailchimp_list_name:     listName
    });
    let hasKey = !!(c && c.has_mailchimp_key);
    if (vals.api_key) {
      const r = await _api('PATCH', '/admin/companies/' + encodeURIComponent(companyId) + '/secrets', {
        body: { mailchimp_api_key: vals.api_key }
      });
      hasKey = !!(r && r.has_mailchimp_key);
    }
    // Lokalen Cache updaten (ohne Key)
    if (c) {
      c.has_mailchimp_key = hasKey;
      c.mailchimp_server_prefix = vals.server_prefix;
      c.mailchimp_list_id = vals.list_id;
      c.mailchimp_list_name = listName;
    }
    // Key-Feld leeren: der Key wird nicht mehr angezeigt
    const row = document.querySelector('[data-mc-row-company="' + companyId + '"]');
    const keyInp = row?.querySelector('[data-mc-input="api_key"]');
    if (keyInp && vals.api_key) { keyInp.value = ''; keyInp.placeholder = 'leer = unverändert'; }
    const prefixInp = row?.querySelector('[data-mc-input="server_prefix"]');
    if (prefixInp) prefixInp.value = vals.server_prefix;
    toast('Mailchimp-Config gespeichert', 'success', 2500);
    if (status) status.innerHTML = '<span class="text-emerald-700">✓ Gespeichert</span>';
  } catch (e) {
    toast(escapeHtml(e.message), 'error', 7000);
    if (status) status.innerHTML = '<span class="text-red-700">' + escapeHtml(e.message) + '</span>';
  } finally {
    if (btnEl) { btnEl.disabled = false; btnEl.innerHTML = origHtml || '<i data-lucide="save" class="w-3 h-3"></i> Speichern'; if (window.lucide) lucide.createIcons(); }
  }
}
```

The prefix goes back into its input because a second save reads the inputs again: an empty prefix input would clear the stored prefix.

In `_mcTestConnection()`, replace:

```js
  const vals = _mcReadRowInputs(companyId);
  if (!vals) return;
  if (!vals.api_key) { toast('API-Key fehlt', 'warn'); return; }
  if (vals.api_key && !vals.server_prefix) {
    const m = vals.api_key.match(/-([a-z]{2,3}\d{1,2})$/i);
    if (m) vals.server_prefix = m[1].toLowerCase();
  }
  if (!vals.server_prefix) { toast('Server-Prefix fehlt (oder im Key nicht erkennbar)', 'warn'); return; }
```

with:

```js
  const vals = _mcCallValues(companyId);
  if (!vals) return;
```

Replace:

```js
    const res = await proxyFetch('mailchimp/3.0/ping', {
      method: 'GET',
      headers: { 'x-mailchimp-key': vals.api_key, 'x-mailchimp-server': vals.server_prefix }
```

with:

```js
    const res = await proxyFetch('mailchimp/3.0/ping', {
      method: 'GET',
      headers: _mcRequestHeaders(companyId, vals)
```

Replace:

```js
    toast('Verbindung fehlgeschlagen: ' + (e.message || e), 'error', 7000);
```

with:

```js
    toast('Verbindung fehlgeschlagen: ' + escapeHtml(e.message || String(e)), 'error', 7000);
```

In `_mcLoadAudiences()`, replace:

```js
  const vals = _mcReadRowInputs(companyId);
  if (!vals) return;
  if (!vals.api_key) { toast('API-Key fehlt', 'warn'); return; }
  if (vals.api_key && !vals.server_prefix) {
    const m = vals.api_key.match(/-([a-z]{2,3}\d{1,2})$/i);
    if (m) vals.server_prefix = m[1].toLowerCase();
  }
  const wrap = document.querySelector('[data-mc-audiences="' + companyId + '"]');
```

with:

```js
  const vals = _mcCallValues(companyId);
  if (!vals) return;
  const wrap = document.querySelector('[data-mc-audiences="' + companyId + '"]');
```

Replace:

```js
    const res = await proxyFetch('mailchimp/3.0/lists?count=50&fields=lists.id,lists.name,lists.stats.member_count', {
      method: 'GET',
      headers: { 'x-mailchimp-key': vals.api_key, 'x-mailchimp-server': vals.server_prefix }
```

with:

```js
    const res = await proxyFetch('mailchimp/3.0/lists?count=50&fields=lists.id,lists.name,lists.stats.member_count', {
      method: 'GET',
      headers: _mcRequestHeaders(companyId, vals)
```

In `_mcSelectAudienceFromButton()`, the audience name comes from Mailchimp. Replace:

```js
  toast('Audience „' + (listName || listId) + '" übernommen — bitte Speichern klicken', 'info', 3500);
```

with:

```js
  toast('Audience „' + escapeHtml(listName || listId) + '" übernommen — bitte Speichern klicken', 'info', 3500);
```

- [ ] **Step 10: Texts elsewhere that name step numbers or Val.town setup**

In `_memSend()`, replace:

```js
Admin → Einstellungen → Step 8: Freshdesk Email-Inbox-ID setzen.
```

with:

```js
Admin → Einstellungen → Step 4: Freshdesk Email-Inbox-ID setzen.
```

In `openNewTicketModal()`, replace:

```js
toast('Keine Group-ID konfiguriert — Admin → Einstellungen → Step 5', 'error', 7000)
```

with:

```js
toast('Keine Group-ID konfiguriert — Admin → Einstellungen → Step 1', 'error', 7000)
```

In `_newTicketSubmit()`, replace:

```js
Bitte Admin → Einstellungen → Step 5 prüfen.
```

with:

```js
Bitte Admin → Einstellungen → Step 1 prüfen.
```

In `_tcmPushFdToFs()`, replace:

```js
toast('Freshsales nicht konfiguriert (Step 9)', 'warn', 6000)
```

with:

```js
toast('Freshsales nicht konfiguriert (Step 6)', 'warn', 6000)
```

In `_fsCheckCustomFieldsStatus()`, replace:

```js
'Freshsales nicht konfiguriert (Step 9 zuerst)'
```

with:

```js
'Freshsales nicht konfiguriert (Step 6 zuerst)'
```

In `syncCustomerToFreshdesk()`, replace:

```js
      userMsg = 'Freshdesk-Setup unvollständig — Admin → Einstellungen → Step 7 (Subdomain) prüfen + Freshdesk-API-Key im User-Profil.';
```

with:

```js
      userMsg = 'Freshdesk ist auf dem Server nicht eingerichtet — Railway-Variablen FRESHDESK_DOMAIN und FRESHDESK_API_KEY setzen oder unter Admin → Benutzer einen eigenen Freshdesk-Key eintragen.';
```

Replace:

```js
      userMsg = 'Freshdesk 404 — bitte prüfe ob die Freshdesk-Subdomain in Step 7 stimmt. Volle Antwort: ' + m;
```

with:

```js
      userMsg = 'Freshdesk 404 — bitte prüfe, ob die Railway-Variable FRESHDESK_DOMAIN stimmt. Volle Antwort: ' + m;
```

In `syncCustomerToFreshsales()`, replace:

```js
toast('Freshsales nicht konfiguriert — Admin → Einstellungen → Step 9', 'error', 8000)
```

with:

```js
toast('Freshsales nicht konfiguriert — Admin → Einstellungen → Step 6', 'error', 8000)
```

Replace:

```js
      userMsg = 'Freshsales-Setup unvollständig — Admin → Einstellungen → Step 9: Subdomain + API-Token eintragen.';
```

with:

```js
      userMsg = 'Freshsales ist auf dem Server nicht eingerichtet — Railway-Variablen FRESHSALES_SUBDOMAIN und FRESHSALES_API_KEY setzen.';
```

Replace:

```js
korrigiere die Subdomain in Admin → Einstellungen → Step 9.';
```

with:

```js
korrigiere die Subdomain in Admin → Einstellungen → Step 6 (für die API-Aufrufe: Railway-Variable FRESHSALES_SUBDOMAIN).';
```

Replace:

```js
— neuen Token in Freshsales generieren und in Step 9 eintragen.';
```

with:

```js
— neuen Token in Freshsales generieren und als Railway-Variable FRESHSALES_API_KEY setzen.';
```

Both sync functions put the message, which can carry server text and the literal `<bundle>`, into a toast. Replace both occurrences of:

```js
    if (!silent) toast(userMsg, 'error', 12000);
```

with:

```js
    if (!silent) toast(escapeHtml(userMsg), 'error', 12000);
```

- [ ] **Step 11: Check by counts**

Run:

```bash
for n in VALTOWN_PROXY_CODE _fetchMasterBaseKeys _writeMasterBaseKey _deleteMasterBaseKey _valtownEnvVars _applyKeyToAppState valtownSetEnvVar _bearerForProxy api.val.town VALTOWN_ valtownKey valtownValId AIRTABLE_READ_KEY settingsFsApiKey isProxySet canPushEnv sameAsFd 'byName['; do printf '%s %s\n' "$n" "$(grep -c -F "$n" index.html)"; done
```

Expected: every name `0`.

Then: `grep -c _maskSecret index.html` → `3`; `grep -c x-mailchimp-key index.html` → `1`; `grep -c mailchimp_api_key index.html` → `1`; `grep -cE 'Step (5|8|9|10)([^0-9]|$)' index.html` → `0`; `grep -oE 'stepHeader\([0-9]+' index.html | tr '\n' ' '` → `stepHeader(1 stepHeader(2 stepHeader(3 stepHeader(4 stepHeader(5 stepHeader(6 stepHeader(7 `.

Other "Master-Base" and "Val.town" mentions (comments and dead fields elsewhere) are Task 13's sweep; don't chase them here.

- [ ] **Step 12: Run the tests**

Run: `npx vitest run test/frontend/guard.test.ts` → PASS.
Run: `npm run test:e2e -- test/e2e/settings.e2e.ts` → PASS (7 tests).
Run: `npm test && npm run test:e2e && npm run typecheck && npm run lint` → PASS.

- [ ] **Step 13: Commit and push**

```bash
git add index.html test/frontend/guard.test.ts test/e2e/settings.e2e.ts
git commit -m "feat(frontend): settings on the server, settings page without Val.town"
git push -u origin claude/awesome-faraday-jjwsxl
```

---

### Task 10: User admin with login keys and Freshdesk keys on the server

**Files:**
- Modify: `index.html`:
  - the section `ADMIN: BENUTZER`: `renderAdminUsers()`, `userRow()`, `openUserModal()`, `saveUser()`, `toggleUserStatus()`, `revokeAllSessions()` and its comment;
  - the section `ADMIN: EINSTELLUNGEN` (header rewritten in Task 9): delete `_maskSecret()`.
- Create: `test/e2e/users.e2e.ts`

**Interfaces:**
- Consumes:
  - `_api(method, path, { body })` (Task 3). Its errors carry the server's message as `.message`, plus `.status` and `.type`.
  - `readData`, `updateData`, `deleteData` and `writeData(table, fields)`, which returns the created record `{id, createdTime, fields}` (Task 3).
  - `APP_KEYS.user.is_admin` (Task 4).
  - Existing and unchanged: `generateApiKey()` (24 characters `a-z0-9`), `copyToClipboard(text, btnEl)`, `openModal`, `closeModal`, `escapeHtml`, and `toast(html, type, ms)`, which puts its text into `innerHTML`, so server text must be escaped.
- Produces (in `index.html`):
  - `saveUser(e, id)` and `revokeAllSessions(userId, userName)`, with the same signatures as before.
  - Element ids in the user form: `#userApiKey` (the key input, as before), `#userApiKeyState`, `#userApiKeyNew`, `#userApiKeyCopy`, `#userRevokeSessions`.
  - Attributes: `data-user-row="<user id>"` on each row of the list, `data-fd-company="<company id>"` on each per-company Freshdesk block of the form, and `data-fd-default` on the default-key block when a default key is stored.
  - `_maskSecret` is gone. Spec §11 keeps it, but after this task nothing calls it any more.

The server side (unchanged):
- For an admin, `GET /api/data/User` adds three fields to every user:
  - `has_api_key`;
  - `has_freshdesk_key`, which means a *default* Freshdesk key is stored;
  - `freshdesk_company_keys`, the sorted ids of the companies with their own key.
- Keys never leave the server. `writeData`/`updateData` refuse them with `INVALID_REQUEST 'Geheime Felder nur über Admin-Funktion (<field>)'`.
- `PATCH /api/admin/users/:id/secrets` (admin only) takes any of these fields:
  - `api_key`: a string of at least 12 characters after trimming, or `null` to remove the key;
  - `freshdesk_api_key`: a string, or `null` to remove the default key;
  - `freshdesk_keys`: an object `{companyId: key | null}`, merged into the stored keys, where `null` removes that company's key.
- The PATCH stores all fields or none. It answers `{has_api_key, has_freshdesk_key, freshdesk_company_keys}`.
- The PATCH's errors are:
  - `422 VALIDATION_FAILED 'Login-Key muss mindestens 12 Zeichen haben'`;
  - `409 KEY_IN_USE 'Dieser Login-Key wird bereits verwendet'`, when another user has that key;
  - `404 NOT_FOUND 'Benutzer nicht gefunden'`.
  The record must therefore exist before its keys are sent.
- `POST /api/sessions/revoke-user` with `{user_id}` (admin only) deletes that user's sessions and answers `{revoked: <count>}`.

- [ ] **Step 1: Write the failing e2e tests**

```ts
// test/e2e/users.e2e.ts
import type { Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';

interface UserRecord {
  id: string;
  fields: Record<string, unknown>;
}

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.resetContexts();
});
afterAll(async () => {
  await h.close();
});

const toast = (page: Page, text: string): Promise<void> => page.locator('#toastWrap', { hasText: text }).waitFor();
// All users as the admin sees them, with has_api_key and the Freshdesk flags.
const allUsers = async (): Promise<UserRecord[]> =>
  (await h.apiAs<{ records: UserRecord[] }>('admin', 'GET', '/api/data/User')).records;
const userNamed = async (name: string): Promise<UserRecord> => {
  const found = (await allUsers()).find((u) => u.fields.name === name);
  if (!found) throw new Error(`no user named ${name}`);
  return found;
};
// Creates a user through the API; it has no login key unless `secrets` sets one.
const createUser = async (fields: Record<string, unknown>, secrets?: Record<string, unknown>): Promise<string> => {
  const { id } = await h.apiAs<UserRecord>('admin', 'POST', '/api/data/User', { fields: { status: 'aktiv', ...fields } });
  if (secrets) await h.apiAs('admin', 'PATCH', `/api/admin/users/${id}/secrets`, secrets);
  return id;
};
// Method and JSON body of the page's requests to URLs starting with baseUrl + prefix, collected from now on.
const requestsTo = (page: Page, prefix: string): { method: string; body: unknown }[] => {
  const seen: { method: string; body: unknown }[] = [];
  page.on('request', (r) => {
    if (r.url().startsWith(h.baseUrl + prefix)) seen.push({ method: r.method(), body: r.postDataJSON() });
  });
  return seen;
};
// The user list as the admin. The 5 s limit lets a list without row markers fail fast.
const openUsers = async (page: Page): Promise<void> => {
  await h.openApp(page, 'admin');
  await h.run(page, 'await renderAdminUsers();');
  await page.locator(`[data-user-row="${h.users.admin.id}"]`).waitFor({ timeout: 5_000 });
};
// Opens the form of an existing user (id) or of a new user (no id).
const openForm = async (page: Page, id?: string): Promise<void> => {
  await page.click(id ? `[data-user-row="${id}"] button[title="Bearbeiten"]` : 'button[onclick="openUserModal()"]');
  await page.locator('#modalBox #userApiKey').waitFor();
};
const save = (page: Page): Promise<void> => page.click('#modalBox button[type="submit"]');
// A successful save closes the form before it shows its toast.
const saved = async (page: Page): Promise<void> => {
  await save(page);
  await page.locator('#modalBackdrop').waitFor({ state: 'hidden' });
};
// The badges of a user's row, left to right.
const badges = async (page: Page, id: string): Promise<string[]> =>
  (await page.locator(`[data-user-row="${id}"] span`).allInnerTexts()).map((t) => t.trim());
// Logs in through the login form of a fresh page and returns the name in the sidebar.
const loginWithKey = async (key: string): Promise<string | null> => {
  const page = await h.newPage();
  await h.openApp(page);
  await page.fill('#loginKey', key);
  await page.click('#loginBtn');
  await page.waitForSelector('#appShell:not(.hidden)', { state: 'visible' });
  const name = await page.locator('#sidebarUserName').textContent();
  await h.assertClean(page);
  return name;
};

describe('user admin', () => {
  it('creates a user with the generated key, and that key logs in (scenario 8)', async () => {
    const { alpha } = h.companies;
    const page = await h.newPage();
    await openUsers(page);
    const dataCalls = requestsTo(page, '/api/data/User');
    const secretCalls = requestsTo(page, '/api/admin/users/');
    await openForm(page);
    expect(await page.innerText('#userApiKeyState')).toBe('(für Login in der App)');
    const key = await page.inputValue('#userApiKey');
    expect(/^[a-z0-9]{24}$/.test(key)).toBe(true);
    await page.fill('#modalBox [name="name"]', 'Nina Neu');
    await page.fill('#modalBox [name="role"]', 'Buchhaltung');
    await page.check(`#modalBox [name="allowed_companies"][value="${alpha}"]`);
    await page.fill(`#modalBox [name="fd_key__${alpha}"]`, 'fd-key-nina-alpha');
    await saved(page);
    await toast(page, 'Gespeichert');

    // The record goes to /api/data without a key; the keys go to the admin function.
    const writes = dataCalls.filter((c) => c.method !== 'GET');
    expect(writes.map((c) => [c.method, Object.keys((c.body as { fields: object }).fields).sort()])).toEqual([
      ['POST', ['allowed_companies', 'created', 'is_admin', 'name', 'role', 'status']],
    ]);
    expect(secretCalls).toEqual([
      { method: 'PATCH', body: { api_key: key, freshdesk_keys: { [alpha]: 'fd-key-nina-alpha' } } },
    ]);
    const nina = await userNamed('Nina Neu');
    expect(nina.fields).toEqual({
      name: 'Nina Neu',
      role: 'Buchhaltung',
      status: 'aktiv',
      allowed_companies: [alpha],
      created: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      has_api_key: true,
      has_freshdesk_key: false,
      freshdesk_company_keys: [alpha],
    });
    expect(await h.deps.secrets.freshdeskKeyFor(nina.id, alpha)).toBe('fd-key-nina-alpha');
    await page.locator(`[data-user-row="${nina.id}"]`).waitFor();
    await h.assertClean(page);

    expect(await loginWithKey(key)).toBe('Nina Neu');
  });

  it('keeps the login key when an existing user is saved with the key field left empty (review focus 1)', async () => {
    const { alpha, beta } = h.companies;
    const vera = h.users.vera;
    const page = await h.newPage();
    await openUsers(page);
    const recordCalls = requestsTo(page, '/api/data/User/');
    const secretCalls = requestsTo(page, '/api/admin/users/');
    await openForm(page, vera.id);
    expect(await page.inputValue('#userApiKey')).toBe('');
    expect(await page.getAttribute('#userApiKey', 'placeholder')).toBe('leer = unverändert');
    expect(await page.getAttribute('#userApiKey', 'required')).toBe(null);
    expect(await page.innerText('#userApiKeyState')).toBe('· gespeichert');
    // A stored Freshdesk key shows as "Key gespeichert", never as the key or a part of it.
    const block = (companyId: string) => page.locator(`#modalBox [data-fd-company="${companyId}"]`).innerText();
    expect((await block(alpha)).includes('Key gespeichert')).toBe(true);
    expect((await block(beta)).includes('Key gespeichert')).toBe(false);
    expect((await page.content()).includes('fd-key-alpha')).toBe(false);

    await page.fill('#modalBox [name="role"]', 'Vertrieb Nord');
    await saved(page);
    await toast(page, 'Gespeichert');
    expect(recordCalls.map((c) => c.method)).toEqual(['PATCH']);
    expect(secretCalls).toEqual([]);
    expect((await userNamed('Vera Vertrieb')).fields.role).toBe('Vertrieb Nord');
    expect(await h.deps.secrets.freshdeskKeyFor(vera.id, alpha)).toBe('fd-key-alpha');
    await h.assertClean(page);

    expect(await loginWithKey(vera.key)).toBe('Vera Vertrieb');
  });

  it('refuses a short login key and a key that is in use, for a new and for an existing user', async () => {
    const page = await h.newPage();
    await openUsers(page);
    const writes = requestsTo(page, '/api/data/User');
    await openForm(page);
    await page.fill('#modalBox [name="name"]', 'Doppelt Dora');
    await page.fill('#userApiKey', 'kurz-123');
    await save(page);
    await toast(page, 'Login-Key muss mindestens 12 Zeichen haben');
    expect(writes.filter((c) => c.method !== 'GET')).toEqual([]);

    // Vera's key belongs to Vera: the new record is removed again, and the form stays open.
    await page.fill('#userApiKey', h.users.vera.key);
    await save(page);
    await toast(page, 'Benutzer nicht angelegt: Dieser Login-Key wird bereits verwendet');
    expect(writes.filter((c) => c.method !== 'GET').map((c) => c.method)).toEqual(['POST', 'DELETE']);
    expect(await page.inputValue('#modalBox [name="name"]')).toBe('Doppelt Dora');
    expect((await allUsers()).some((u) => u.fields.name === 'Doppelt Dora')).toBe(false);

    // An existing user is saved, but keeps the old key.
    await page.click('#modalBox button[onclick="closeModal()"]');
    await openForm(page, h.users.vera.id);
    await page.fill('#userApiKey', h.users.admin.key);
    await save(page);
    await toast(page, 'Benutzer gespeichert, Keys aber nicht: Dieser Login-Key wird bereits verwendet');
    expect(await page.locator('#modalBackdrop').isVisible()).toBe(true);
    // apiAs logs in with Vera's key, so this fails if the key was changed.
    await h.apiAs('vera', 'GET', '/api/me');
    await h.assertClean(page);
  });

  it('removes a Freshdesk key, sets and removes the default key, and never shows a key', async () => {
    const { alpha } = h.companies;
    const id = await createUser(
      { name: 'Fred Freshdesk' },
      { generate_api_key: true, freshdesk_keys: { [alpha]: 'fd-key-fred-alpha' } },
    );
    const page = await h.newPage();
    await openUsers(page);
    const secretCalls = requestsTo(page, '/api/admin/users/');
    await openForm(page, id);
    expect((await page.content()).includes('fd-key-fred-alpha')).toBe(false);
    expect(await page.locator('#modalBox [data-fd-default]').count()).toBe(0);
    await page.click(`#modalBox [data-fd-company="${alpha}"] button`);
    await page.fill('#modalBox [name="freshdesk_api_key"]', 'fd-default-fred');
    await saved(page);
    expect(secretCalls.map((c) => c.body)).toEqual([
      { freshdesk_api_key: 'fd-default-fred', freshdesk_keys: { [alpha]: null } },
    ]);
    expect(await h.deps.secrets.userInfo(id)).toEqual({ hasApiKey: true, hasFreshdeskKey: true, freshdeskCompanyKeys: [] });
    expect(await h.deps.secrets.freshdeskKeyFor(id, alpha)).toBe('fd-default-fred');

    // The list is rendered again after a save; the default key is removed the same way.
    await page.locator(`[data-user-row="${id}"]`).waitFor();
    await openForm(page, id);
    expect((await page.content()).includes('fd-default-fred')).toBe(false);
    await page.click('#modalBox [data-fd-default] button');
    await saved(page);
    expect(secretCalls.map((c) => c.body)[1]).toEqual({ freshdesk_api_key: null });
    expect(await h.deps.secrets.userInfo(id)).toEqual({ hasApiKey: true, hasFreshdeskKey: false, freshdeskCompanyKeys: [] });
    await h.assertClean(page);
  });

  it('marks a user without a login key, counts Freshdesk keys, and "Neu" gives the user a key', async () => {
    const { alpha, beta } = h.companies;
    const id = await createUser(
      { name: 'Otto Ohnekey', allowed_companies: [alpha] },
      { freshdesk_api_key: 'fd-default-otto', freshdesk_keys: { [alpha]: 'fd-key-otto-alpha', [beta]: 'fd-key-otto-beta' } },
    );
    const page = await h.newPage();
    await openUsers(page);
    expect(await badges(page, id)).toEqual(['FD 2×+D', 'kein Login-Key']);
    expect(await badges(page, h.users.vera.id)).toEqual(['FD 1×']);
    expect(await badges(page, h.users.admin.id)).toEqual(['admin']);

    const secretCalls = requestsTo(page, '/api/admin/users/');
    await openForm(page, id);
    expect(await page.innerText('#userApiKeyState')).toBe('· keiner hinterlegt');
    await page.click('#userApiKeyNew');
    const key = await page.inputValue('#userApiKey');
    expect(/^[a-z0-9]{24}$/.test(key)).toBe(true);
    await saved(page);
    await toast(page, 'Gespeichert');
    expect(secretCalls.map((c) => c.body)).toEqual([{ api_key: key }]);
    await page.locator(`[data-user-row="${id}"]`).waitFor();
    expect(await badges(page, id)).toEqual(['FD 2×+D']);
    await h.assertClean(page);

    expect(await loginWithKey(key)).toBe('Otto Ohnekey');
  });

  it('ends all sessions of a user with "Alle Sitzungen abmelden"', async () => {
    const vera = h.users.vera;
    const sessionsOf = async (userId: string): Promise<number> =>
      Number((await h.deps.db.query('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', [userId]))[0]?.n);
    const veraPage = await h.newPage();
    await h.openApp(veraPage, 'vera');
    // Earlier tests of this file left sessions of Vera too (apiAs and openApp log in each time).
    const before = await sessionsOf(vera.id);
    expect(before > 0).toBe(true);

    const page = await h.newPage();
    await openUsers(page);
    await openForm(page, vera.id);
    page.once('dialog', (d) => void d.accept());
    await page.click('#userRevokeSessions');
    await toast(page, `${before} Sitzung(en) abgemeldet`);
    expect(await sessionsOf(vera.id)).toBe(0);
    expect((await veraPage.context().request.get(`${h.baseUrl}/api/me`)).status()).toBe(401);
    // The admin's own session stays.
    expect((await page.context().request.get(`${h.baseUrl}/api/me`)).status()).toBe(200);
    await h.assertClean(page);
    await h.assertClean(veraPage);
  });
});
```

This file makes no failed login.

- [ ] **Step 2: Run them and see them fail**

Run: `npm run test:e2e -- test/e2e/users.e2e.ts`
Expected: FAIL in all six tests, each in `openUsers` (`locator.waitFor: Timeout 5000ms exceeded`), because the rows have no `data-user-row` yet. Behind that, the old `saveUser` puts `api_key` into the record, and the server refuses it with `Schreiben fehlgeschlagen: Geheime Felder nur über Admin-Funktion (api_key)`.

- [ ] **Step 3: The list reads the key flags**

In `renderAdminUsers()`, replace:

```js
    all = await readData('User', null, { sort: [{ field: 'name', direction: 'asc' }] });
  } catch (e) { toast(e.message, 'error'); }
```

with:

```js
    all = await readData('User', null, { sort: [{ field: 'name', direction: 'asc' }] });
  } catch (e) { toast(escapeHtml(e.message), 'error'); }
```

Replace the whole function `userRow()` with:

```js
function userRow(rec) {
  const f = rec.fields || {};
  const inactive = f.status !== 'aktiv';
  const isAdmin = !!f.is_admin;
  const cnt = (f.allowed_companies || []).length;
  // Der Server schickt keine Keys, nur ob sie gesetzt sind.
  const hasFreshdeskDefault = !!f.has_freshdesk_key;
  const fdCompanyCount = (f.freshdesk_company_keys || []).length;
  const fdBadge = (fdCompanyCount > 0 || hasFreshdeskDefault)
    ? `<span class="text-[10px] uppercase font-bold tracking-wider bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded inline-flex items-center gap-0.5" title="Freshdesk-Keys: ${fdCompanyCount} pro Firma${hasFreshdeskDefault ? ' + Default' : ''}"><i data-lucide="headphones" class="w-2.5 h-2.5"></i> FD${fdCompanyCount > 0 ? ' ' + fdCompanyCount + '×' : ''}${hasFreshdeskDefault ? '+D' : ''}</span>`
    : '';
  const keyBadge = f.has_api_key
    ? ''
    : '<span class="text-[10px] uppercase font-bold tracking-wider bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded" title="Ohne Login-Key kann sich dieser Benutzer nicht anmelden">kein Login-Key</span>';
  return `
    <div class="flex items-center justify-between p-4" data-user-row="${rec.id}">
      <div class="min-w-0">
        <div class="flex items-center gap-2 flex-wrap">
          <p class="font-medium ${inactive ? 'text-ink-500' : 'text-ink-900'} truncate">${escapeHtml(f.name || '–')}</p>
          ${isAdmin ? '<span class="text-[10px] uppercase font-bold tracking-wider bg-red-100 text-red-700 px-1.5 py-0.5 rounded">admin</span>' : ''}
          ${fdBadge}
          ${keyBadge}
        </div>
        <p class="text-xs text-ink-500 mt-0.5 truncate">
          ${escapeHtml(f.role || '—')} · ${cnt} Firma${cnt===1?'':'n'} · ${escapeHtml(f.status || '—')}
        </p>
      </div>
      <div class="flex gap-1 shrink-0">
        <button onclick="openUserModal('${rec.id}')" class="p-2 text-ink-500 hover:text-ink-900 hover:bg-ink-100 rounded" title="Bearbeiten">
          <i data-lucide="pencil" class="w-4 h-4"></i>
        </button>
        <button onclick="toggleUserStatus('${rec.id}', ${inactive})" class="p-2 text-ink-500 hover:text-ink-900 hover:bg-ink-100 rounded" title="${inactive ? 'Aktivieren' : 'Deaktivieren'}">
          <i data-lucide="${inactive ? 'user-check' : 'user-x'}" class="w-4 h-4"></i>
        </button>
      </div>
    </div>
  `;
}
```

- [ ] **Step 4: The form shows which keys are stored, never a key**

All edits of this step are inside `openUserModal()`.

(a) The server has no schema to extend. Replace:

```js
async function openUserModal(id) {
  // Sicherstellen, dass die FD-Key-Felder in der User-Tabelle existieren
  // (idempotent — legt nur an, wenn nicht vorhanden)
  await ensureFields('User', [
    { name: 'freshdesk_api_key',   type: 'singleLineText' },
    { name: 'freshdesk_keys_json', type: 'multilineText'  }
  ]).catch(()=>{});

  let f = {};
```

with:

```js
async function openUserModal(id) {
  let f = {};
```

(b) The server sends flags instead of keys. Replace:

```js
  // Per-Firma-Keys aus JSON parsen (robust gegen leeren / kaputten String)
  let fdKeysByCompany = {};
  try {
    const raw = (f.freshdesk_keys_json || '').toString().trim();
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object' && !Array.isArray(p)) fdKeysByCompany = p;
    }
  } catch (_) { /* ignorieren */ }
  const apiKey = id ? (f.api_key || '') : generateApiKey();
```

with:

```js
  // Der Server schickt keine Keys, nur ob sie gesetzt sind (Firmen-IDs mit eigenem Freshdesk-Key).
  const fdCompanyKeys = new Set(f.freshdesk_company_keys || []);
  // Neuer Benutzer: Key vorbelegen. Bestehender Benutzer: Feld leer = Key bleibt.
  const apiKey = id ? '' : generateApiKey();
```

(c) The login key field. For an existing user it starts empty and is optional. Replace:

```js
      <label class="block text-sm font-medium text-ink-700 mb-1">API-Key <span class="text-ink-500 font-normal text-xs">(für Login in der App)</span></label>
      <div class="flex gap-2 mb-3">
        <input id="userApiKey" name="api_key" required value="${escapeHtml(apiKey)}" class="flex-1 px-3 py-2 border border-ink-200 rounded-lg font-mono text-xs">
        <button type="button" onclick="document.getElementById('userApiKey').value=generateApiKey()" class="px-3 py-2 text-xs rounded-lg border border-ink-200 hover:bg-ink-50">Neu</button>
      </div>
```

with:

```js
      <label class="block text-sm font-medium text-ink-700 mb-1">Login-Key <span id="userApiKeyState" class="text-ink-500 font-normal text-xs">${id ? (f.has_api_key ? '· gespeichert' : '· keiner hinterlegt') : '(für Login in der App)'}</span></label>
      <div class="flex gap-2 mb-1">
        <input id="userApiKey" name="api_key" ${id ? '' : 'required'} value="${escapeHtml(apiKey)}" placeholder="${id ? 'leer = unverändert' : ''}" autocomplete="off" class="flex-1 px-3 py-2 border border-ink-200 rounded-lg font-mono text-xs">
        <button type="button" id="userApiKeyNew" onclick="document.getElementById('userApiKey').value=generateApiKey()" class="px-3 py-2 text-xs rounded-lg border border-ink-200 hover:bg-ink-50">Neu</button>
        <button type="button" id="userApiKeyCopy" onclick="copyToClipboard(document.getElementById('userApiKey').value, this)" class="px-3 py-2 text-xs rounded-lg border border-ink-200 hover:bg-ink-50">Kopieren</button>
      </div>
      <p class="text-[11px] text-ink-500 mb-3 leading-snug">Der Server speichert nur einen Hash. Den Key jetzt kopieren und dem Benutzer geben — nach dem Speichern ist er nicht mehr zu sehen. Mindestens 12 Zeichen.</p>
```

(d) The per-company Freshdesk keys. Replace:

```js
          const existing = (fdKeysByCompany[c.id] || '').toString().trim();
          const masked = existing ? _maskSecret(existing) : '';
          return `
            <div class="mb-2">
              <label class="block text-[11px] font-medium text-ink-700 mb-0.5">${escapeHtml(c.fields.name || '–')}</label>
              ${existing ? `<p class="text-[10px] text-ink-500 font-mono mb-1">aktuell: ${escapeHtml(masked)}</p>` : ''}
```

with:

```js
          const existing = fdCompanyKeys.has(c.id);
          return `
            <div class="mb-2" data-fd-company="${c.id}">
              <label class="block text-[11px] font-medium text-ink-700 mb-0.5">${escapeHtml(c.fields.name || '–')}</label>
              ${existing ? '<p class="text-[10px] text-emerald-700 mb-1">Key gespeichert</p>' : ''}
```

The input and the "Diesen Key entfernen" button below stay as they are. `existing` is a boolean now, and they only test it for truth.

(e) The default key. Until now there was no way to remove it; it gets the same button. Replace:

```js
          ${id && (f.freshdesk_api_key || '').trim() ? `
            <p class="text-[10px] text-ink-500 font-mono mb-1">aktuell: ${escapeHtml(_maskSecret(f.freshdesk_api_key))}</p>
            <input type="password" name="freshdesk_api_key" value="" placeholder="leer = beibehalten" class="w-full px-3 py-1.5 border border-ink-200 rounded-lg font-mono text-xs bg-white">
          ` : `
```

with:

```js
          ${id && f.has_freshdesk_key ? `
            <div data-fd-default>
              <p class="text-[10px] text-emerald-700 mb-1">Key gespeichert</p>
              <input type="password" name="freshdesk_api_key" value="" placeholder="leer = beibehalten · neuer Wert überschreibt" class="w-full px-3 py-1.5 border border-ink-200 rounded-lg font-mono text-xs bg-white">
              <button type="button" onclick="this.closest('div').querySelector('input').value='__CLEAR__'; this.textContent='✓ wird beim Speichern gelöscht'; this.disabled=true;" class="text-[10px] text-red-600 hover:text-red-700 mt-0.5 underline">Diesen Key entfernen</button>
            </div>
          ` : `
```

(f) The revoke button. Replace:

```js
          ${id ? `<button type="button" onclick="revokeAllSessions('${id}', '${escapeHtml((f.name || '').replace(/'/g, ''))}')" class="text-xs text-red-600 hover:text-red-800 flex items-center gap-1" title="Alle aktiven Browser-Sessions dieses Users im Val.town-Proxy invalidieren"><i data-lucide="log-out" class="w-3.5 h-3.5"></i> Alle Sessions abmelden</button>` : ''}
```

with:

```js
          ${id ? `<button type="button" id="userRevokeSessions" onclick="revokeAllSessions('${id}', '${escapeHtml((f.name || '').replace(/'/g, ''))}')" class="text-xs text-red-600 hover:text-red-800 flex items-center gap-1" title="Alle Sitzungen dieses Benutzers auf dem Server beenden"><i data-lucide="log-out" class="w-3.5 h-3.5"></i> Alle Sitzungen abmelden</button>` : ''}
```

- [ ] **Step 5: Save the record first, then the keys**

The record must exist before its keys can be stored. When the keys fail (for example `KEY_IN_USE`), a new record is deleted again, because a user without a login key cannot log in. The form stays open in both cases, so the admin can correct the key and save again.

Replace the whole function `saveUser()` with:

```js
async function saveUser(e, id) {
  e.preventDefault();
  const fd = new FormData(e.target);
  // Nicht geheime Felder: normaler Datensatz über /api/data.
  const fields = {
    name:      (fd.get('name') || '').trim(),
    role:      (fd.get('role') || '').trim(),
    status:    fd.get('status') || 'aktiv',
    is_admin:  fd.get('is_admin') === 'on',
    allowed_companies: fd.getAll('allowed_companies')
  };
  if (!fields.name) return toast('Name fehlt', 'error');

  // Keys: getrennt an die Admin-Funktion (der Server speichert Hash bzw. verschlüsselt).
  // Leeres Feld = unverändert, "__CLEAR__" = Key entfernen.
  const secrets = {};
  const apiKey = (fd.get('api_key') || '').trim();
  if (!id && !apiKey) return toast('Login-Key fehlt', 'error');
  if (apiKey) {
    if (apiKey.length < 12) return toast('Login-Key muss mindestens 12 Zeichen haben', 'error');
    secrets.api_key = apiKey;
  }
  const fdDefault = (fd.get('freshdesk_api_key') || '').trim();
  if (fdDefault) secrets.freshdesk_api_key = fdDefault === '__CLEAR__' ? null : fdDefault;
  const fdKeys = {};
  for (const [name, value] of fd.entries()) {
    if (!name.startsWith('fd_key__')) continue;
    const v = (value || '').toString().trim();
    if (v) fdKeys[name.slice('fd_key__'.length)] = v === '__CLEAR__' ? null : v;
  }
  if (Object.keys(fdKeys).length > 0) secrets.freshdesk_keys = fdKeys;

  if (!id) fields.created = new Date().toISOString().slice(0,10);
  let userId = id;
  try {
    if (id) await updateData('User', id, fields);
    else    userId = (await writeData('User', fields)).id;
  } catch (err) { return toast(escapeHtml(err.message), 'error'); }

  if (Object.keys(secrets).length > 0) {
    try {
      await _api('PATCH', '/admin/users/' + encodeURIComponent(userId) + '/secrets', { body: secrets });
    } catch (err) {
      if (!id) {
        await deleteData('User', userId).catch(() => {});
        return toast('Benutzer nicht angelegt: ' + escapeHtml(err.message), 'error', 8000);
      }
      return toast('Benutzer gespeichert, Keys aber nicht: ' + escapeHtml(err.message), 'error', 8000);
    }
  }
  closeModal();
  renderAdminUsers();
  toast('Gespeichert', 'success');
}
```

- [ ] **Step 6: Status toggle and session revoke through the server**

In `toggleUserStatus()`, replace:

```js
    toast(currentlyInactive ? 'Aktiviert' : 'Deaktiviert', 'success');
  } catch (err) { toast(err.message, 'error'); }
```

with:

```js
    toast(currentlyInactive ? 'Aktiviert' : 'Deaktiviert', 'success');
  } catch (err) { toast(escapeHtml(err.message), 'error'); }
```

Above `revokeAllSessions()`, replace:

```js
// Alle aktiven Browser-Sessions eines Users im Val.town-Proxy invalidieren.
```

with:

```js
// Alle Sitzungen eines Benutzers auf dem Server beenden.
```

Replace the whole function `revokeAllSessions()` with:

```js
async function revokeAllSessions(userId, userName) {
  if (!APP_KEYS.user?.is_admin) return toast('Nur für Admins', 'error');
  const label = userName ? '"' + userName + '"' : 'diesem Benutzer';
  if (!confirm('Alle Sitzungen von ' + label + ' beenden?\n\n• Alle offenen Browser-Tabs/Handys werden beim nächsten Aufruf abgemeldet.\n• Login-Key bleibt unverändert — der Benutzer kann sich danach normal neu anmelden.\n• Bei Mitarbeiter-Austritt zusätzlich Status auf "inaktiv" setzen.')) return;
  try {
    const data = await _api('POST', '/sessions/revoke-user', { body: { user_id: userId } });
    toast(data.revoked + ' Sitzung(en) abgemeldet', 'success');
  } catch (e) {
    toast(escapeHtml(e.message), 'error', 6000);
  }
}
```

- [ ] **Step 7: Delete `_maskSecret()`**

The user admin was its last caller. In the section `ADMIN: EINSTELLUNGEN`, replace:

```js
function _maskSecret(val) {
  if (!val) return '';
  if (val.length <= 10) return '••••••••';
  return val.substring(0, 4) + '••••••••' + val.substring(val.length - 4);
}

/* ============================================================
   ADMIN: API-KOSTEN (AiUsageLog Dashboard)
```

with:

```js
/* ============================================================
   ADMIN: API-KOSTEN (AiUsageLog Dashboard)
```

The section `ADMIN: EINSTELLUNGEN` then consists of its header comment only, which says where the settings live now.

- [ ] **Step 8: Check by counts**

Run:

```bash
for n in _maskSecret fdKeysByCompany existingFdKeys freshdesk_keys_json 'Session(s)' 'Sessions abmelden' 'f.api_key'; do printf '%s %s\n' "$n" "$(grep -c -F -- "$n" index.html)"; done
```

Expected: every name `0`.

Then: `grep -c -F 'copyToClipboard(' index.html` → `2`; `grep -c -F 'data-user-row' index.html` → `1`; `grep -c -F "'/admin/users/'" index.html` → `1`.

- [ ] **Step 9: Run the tests**

Run: `npm run test:e2e -- test/e2e/users.e2e.ts` → PASS (6 tests).
Run: `npm test && npm run test:e2e && npm run typecheck && npm run lint` → PASS.

- [ ] **Step 10: Commit and push**

```bash
git add index.html test/e2e/users.e2e.ts
git commit -m "feat(frontend): user admin with login keys and Freshdesk keys on the server"
git push -u origin claude/awesome-faraday-jjwsxl
```

---

### Task 11: Re-login overlay when the session expires

**Files:**
- Modify: `index.html`, the section `API-CLIENT: alle Server-Aufrufe laufen über _api (same-origin, Session-Cookie)` (added in Task 3): `_api()` and the `_reauth()` stub.
- Create: `test/e2e/reauth.e2e.ts`

**Interfaces:**
- Consumes:
  - `_api(method, path, { body, headers, keepalive, reauth = true })` (Task 3). On a `401` whose body has the type `UNAUTHENTICATED` it awaits `_reauth()` and repeats the call once with `reauth: false`. A `401` from an upstream (no type) is thrown as usual. Calls with `reauth: false` (login, auto-login, logout, lock heartbeat and release) never open the overlay.
  - `_applyServerUser(u)` and `APP_KEYS.user._id` (Task 4).
  - `writeData` with the number recovery of Task 5. A failed call is thrown as `'Schreiben fehlgeschlagen: ' + message`, and `saveCustomer` shows that text with `toast(err.message, 'error')` and keeps the form open.
  - Unchanged: the login form's checkbox `#loginRememberMe`, `openCustomerModal()`, `saveCustomer(e, id)`.
  - Backend: `POST /api/auth` with `{user_key, long_lived}` answers `{user: {id, …}}`. A wrong key gives `401 UNAUTHENTICATED 'Ungültiger Login-Key oder Account inaktiv'`. `h.deps.sessions.deleteForUser(userId)` deletes a user's sessions, so the next request with the old cookie gets `401 UNAUTHENTICATED`.
- Produces (in `index.html`):
  - `_reauth()` → `Promise<void>`:
    - resolves after the same user has logged in again;
    - rejects with `Error('Sitzung abgelaufen')` on "Abbrechen";
    - reloads the page when a different user logs in.
    All callers waiting at the same time share one overlay and one promise.
  - `_loginGeneration`: the number of successful re-logins. `_api` reads it when it sends a request and again when that request comes back with a `401`. If a re-login happened in between, `_api` repeats the request without a new overlay.
  - Element ids: `#reauthOverlay` (the overlay, `z-index: 100000`), `#reauthForm`, `#reauthKey`, `#reauthRemember`, `#reauthError`, `#reauthCancel`, `#reauthSubmit`.

The overlay lies above everything else, including the loading overlays (`z-index: 99999`) and both modal layers. The form below it stays open with what was typed, and the call that hit the `401` continues once the login succeeds. That is spec scenario 12.

- [ ] **Step 1: Write the failing e2e tests**

```ts
// test/e2e/reauth.e2e.ts
import type { Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness, type Who } from './harness.js';

interface CustomerRecord {
  id: string;
  fields: Record<string, unknown>;
}

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.resetContexts();
});
afterAll(async () => {
  await h.close();
});

const OVERLAY_TEXT = 'Sitzung abgelaufen – bitte Login-Key erneut eingeben';
// The server forgets the user's sessions; the browser keeps its now useless cookie.
const expireSessions = async (who: Who): Promise<void> => {
  await h.deps.sessions.deleteForUser(h.users[who].id);
};
// The 5 s limit lets a missing overlay fail fast.
const overlayShown = (page: Page): Promise<void> =>
  page.locator('#reauthOverlay', { hasText: OVERLAY_TEXT }).waitFor({ timeout: 5_000 });
const customerNamed = async (name: string): Promise<CustomerRecord | undefined> =>
  (await h.apiAs<{ records: CustomerRecord[] }>('admin', 'GET', '/api/data/Customer')).records.find(
    (r) => r.fields.name1 === name,
  );
// Status codes of the page's responses whose URL matches, collected from now on.
// The harness logs in through the context's request API, which does not show up here.
const statuses = (page: Page, match: (url: URL) => boolean): number[] => {
  const seen: number[] = [];
  page.on('response', (r) => {
    if (match(new URL(r.url()))) seen.push(r.status());
  });
  return seen;
};
const isLogin = (url: URL): boolean => url.pathname === '/api/auth';
// readData('Company', "{name}='<name>'") and nothing else.
const isRead =
  (name: string) =>
  (url: URL): boolean =>
    url.pathname === '/api/data/Company' && url.searchParams.get('filterByFormula') === `{name}='${name}'`;
const sessionCookie = async (page: Page) => (await page.context().cookies()).find((c) => c.name === 'erp_session');
// Vera logs in (Alpha is her current company), opens the form for a new customer and fills it in.
const fillNewCustomer = async (page: Page, name: string): Promise<void> => {
  await h.openApp(page, 'vera');
  await h.run(page, 'await openCustomerModal();');
  await page.fill('#modalBox input[name="name1"]', name);
  await page.fill('#modalBox input[name="city"]', 'Köln');
};
const save = (page: Page): Promise<void> => page.click('#modalBox button[type="submit"]');
const toast = (page: Page, text: string): Promise<void> => page.locator('#toastWrap', { hasText: text }).waitFor();
const reLogin = async (page: Page, key: string): Promise<void> => {
  await page.fill('#reauthKey', key);
  await page.click('#reauthSubmit');
};

describe('re-login when the session expires', () => {
  it('keeps the open form, asks for the key again and then saves (scenario 12)', async () => {
    const page = await h.newPage();
    const logins = statuses(page, isLogin);
    await fillNewCustomer(page, 'Nach Pause GmbH');
    await expireSessions('vera');
    await save(page);
    await overlayShown(page);
    // Vera did not tick "Angemeldet bleiben" at the login.
    expect(await page.isChecked('#reauthRemember')).toBe(false);
    // The form stays open behind the overlay, with what was typed.
    expect(await page.locator('#modalBackdrop').isVisible()).toBe(true);
    expect(await page.inputValue('#modalBox input[name="name1"]')).toBe('Nach Pause GmbH');

    await reLogin(page, 'falscher-key-123');
    await page.locator('#reauthError', { hasText: 'Ungültiger Login-Key oder Account inaktiv' }).waitFor();
    expect(await page.locator('#reauthOverlay').count()).toBe(1);

    await reLogin(page, h.users.vera.key);
    await toast(page, 'Gespeichert');
    expect(await page.locator('#reauthOverlay').count()).toBe(0);
    const saved = await customerNamed('Nach Pause GmbH');
    expect([saved?.fields.city, saved?.fields.company_id]).toEqual(['Köln', [h.companies.alpha]]);
    expect(await h.run(page, 'return APP_KEYS.user._id;')).toBe(h.users.vera.id);
    await expect.poll(() => logins).toEqual([401, 200]);
    // Without "Angemeldet bleiben" the new cookie ends with the browser session.
    expect((await sessionCookie(page))?.expires).toBe(-1);
    await h.assertClean(page);
  });

  it('parallel requests share one overlay and all go through after the login', async () => {
    const page = await h.newPage();
    const reads = statuses(page, isRead('Alpha GmbH'));
    const logins = statuses(page, isLogin);
    await h.openApp(page, 'vera');
    // As if Vera had ticked "Angemeldet bleiben" at the login.
    await h.run(page, "document.getElementById('loginRememberMe').checked = true;");
    await expireSessions('vera');
    await h.run(
      page,
      `window.__parallel = Promise.all([1, 2, 3].map(() => readData('Company', "{name}='Alpha GmbH'").then(r => r.length)));`,
    );
    await expect.poll(() => reads, { timeout: 5_000 }).toEqual([401, 401, 401]);
    await overlayShown(page);
    expect(await page.locator('#reauthOverlay').count()).toBe(1);
    expect(await page.isChecked('#reauthRemember')).toBe(true);

    await reLogin(page, h.users.vera.key);
    expect(await h.run(page, 'return await window.__parallel;')).toEqual([1, 1, 1]);
    await expect.poll(() => reads).toEqual([401, 401, 401, 200, 200, 200]);
    await expect.poll(() => logins).toEqual([200]);
    // "Angemeldet bleiben" makes the new cookie outlive the browser session.
    expect(((await sessionCookie(page))?.expires ?? 0) > 0).toBe(true);
    await h.assertClean(page);
  });

  it('"Abbrechen" keeps the form with a clear error, and saving again asks again', async () => {
    const page = await h.newPage();
    await fillNewCustomer(page, 'Abbruch GmbH');
    await expireSessions('vera');
    await save(page);
    await overlayShown(page);
    await page.click('#reauthCancel');
    await toast(page, 'Schreiben fehlgeschlagen: Sitzung abgelaufen');
    expect(await page.locator('#reauthOverlay').count()).toBe(0);
    expect(await page.inputValue('#modalBox input[name="name1"]')).toBe('Abbruch GmbH');
    expect(await customerNamed('Abbruch GmbH')).toBeUndefined();

    await save(page);
    await overlayShown(page);
    await reLogin(page, h.users.vera.key);
    await toast(page, 'Gespeichert');
    expect((await customerNamed('Abbruch GmbH'))?.fields.city).toBe('Köln');
    await h.assertClean(page);
  });

  it('the key of a different user reloads the app for that user instead of continuing', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    await expireSessions('vera');
    // The read is not awaited: it waits for the overlay, which then reloads the page.
    await h.run(page, "window.__before = 'alt'; readData('Company').catch(() => {});");
    await overlayShown(page);
    const reloaded = page.waitForEvent('load');
    await reLogin(page, h.users.admin.key);
    await reloaded;
    await page.waitForSelector('#appShell:not(.hidden)', { state: 'visible' });
    expect(await page.locator('#sidebarUserName').textContent()).toBe('Ada Admin');
    // A new page: nothing of Vera's state is left.
    expect(await h.run(page, 'return window.__before;')).toBeUndefined();
    await h.assertClean(page);
  });

  it('a request whose 401 arrives after the re-login is repeated without a second overlay', async () => {
    const page = await h.newPage();
    const betaReads = statuses(page, isRead('Beta AG'));
    const logins = statuses(page, isLogin);
    await h.openApp(page, 'vera');
    // Holds every response for a URL with "Beta" in the page until __release() is called.
    await h.run(
      page,
      `const realFetch = window.fetch;
       let release;
       const gate = new Promise((resolve) => { release = resolve; });
       window.__release = release;
       window.fetch = async (...args) => {
         const res = await realFetch(...args);
         if (String(args[0]).includes('Beta')) await gate;
         return res;
       };`,
    );
    await expireSessions('vera');
    await h.run(page, `window.__slow = readData('Company', "{name}='Beta AG'").then(r => r.length);`);
    // The server has answered 401, but the app does not see it yet.
    await expect.poll(() => betaReads, { timeout: 5_000 }).toEqual([401]);
    await h.run(page, `window.__fast = readData('Company', "{name}='Alpha GmbH'").then(r => r.length);`);
    await overlayShown(page);
    await reLogin(page, h.users.vera.key);
    expect(await h.run(page, 'return await window.__fast;')).toBe(1);

    // Now the old 401 for Beta reaches the app, after the re-login.
    const outcome = await h.run(
      page,
      `window.__release();
       let timer;
       const overlay = new Promise((resolve) => {
         timer = setInterval(() => {
           if (document.getElementById('reauthOverlay')) resolve('second overlay');
         }, 20);
       });
       const first = await Promise.race([window.__slow.then((n) => 'resolved ' + n), overlay]);
       clearInterval(timer);
       return first;`,
    );
    expect(outcome).toBe('resolved 1');
    expect(await page.locator('#reauthOverlay').count()).toBe(0);
    await expect.poll(() => betaReads).toEqual([401, 200]);
    await expect.poll(() => logins).toEqual([200]);
    await h.assertClean(page);
  });
});
```

This file makes one failed login, well below the rate limit.

- [ ] **Step 2: Run them and see them fail**

Run: `npm run test:e2e -- test/e2e/reauth.e2e.ts`
Expected: FAIL in all five tests, each in `overlayShown` (`locator.waitFor: Timeout 5000ms exceeded`). The stub `_reauth()` throws, so no overlay appears. In the first and third test the page shows the toast `Schreiben fehlgeschlagen: Sitzung abgelaufen` instead.

- [ ] **Step 3: Replace the stub with the overlay**

In the section `API-CLIENT: alle Server-Aufrufe laufen über _api (same-origin, Session-Cookie)`, replace:

```js
// Platzhalter bis zum Re-Login-Overlay: eine abgelaufene Sitzung ist ein normaler Fehler.
async function _reauth() {
  throw new Error('Sitzung abgelaufen');
}
```

with:

```js
/* Re-Login bei abgelaufener Sitzung: ein Overlay über allem, das offene Formular bleibt stehen.
   Alle Aufrufe, die gerade auf die Anmeldung warten, teilen sich ein Promise. */
let _reauthPromise = null;
// Zählt erfolgreiche Re-Logins. Eine 401 auf eine Anfrage, die vor dem letzten
// Re-Login abgeschickt wurde, wird ohne neues Overlay wiederholt (siehe _api).
let _loginGeneration = 0;

function _reauth() {
  if (!_reauthPromise) {
    _reauthPromise = _showReauthOverlay().finally(() => { _reauthPromise = null; });
  }
  return _reauthPromise;
}

// Erfüllt sich nach dem Login desselben Users; „Abbrechen" lehnt ab.
// Meldet sich ein anderer User an, lädt die App neu (nichts vom alten Stand bleibt).
function _showReauthOverlay() {
  return new Promise((resolve, reject) => {
    const el = document.createElement('div');
    el.id = 'reauthOverlay';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    // Über den Lade-Overlays (z-index 99999) und beiden Modal-Ebenen.
    el.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(15,23,42,0.55);display:flex;align-items:center;justify-content:center;padding:16px;';
    el.innerHTML = `
      <form id="reauthForm" autocomplete="off" style="background:#fff;border-radius:16px;padding:24px;width:100%;max-width:380px;box-shadow:0 20px 50px rgba(15,23,42,0.35);">
        <p style="font-weight:600;font-size:16px;margin:0 0 6px;">Sitzung abgelaufen – bitte Login-Key erneut eingeben</p>
        <p style="font-size:13px;color:#64748b;margin:0 0 16px;">Deine Eingaben bleiben erhalten. Nach dem Anmelden geht es an derselben Stelle weiter.</p>
        <input id="reauthKey" type="password" autocomplete="current-password" placeholder="Login-Key" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cbd5e1;border-radius:10px;font-size:14px;">
        <label style="display:flex;align-items:center;gap:8px;margin-top:12px;font-size:13px;color:#334155;">
          <input id="reauthRemember" type="checkbox"> Angemeldet bleiben
        </label>
        <p id="reauthError" class="hidden" style="color:#b91c1c;font-size:13px;margin:12px 0 0;"></p>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px;">
          <button id="reauthCancel" type="button" style="padding:8px 14px;border-radius:10px;border:1px solid #cbd5e1;background:#fff;font-size:14px;">Abbrechen</button>
          <button id="reauthSubmit" type="submit" style="padding:8px 14px;border-radius:10px;border:0;background:#0f172a;color:#fff;font-size:14px;">Anmelden</button>
        </div>
      </form>`;
    document.body.appendChild(el);
    const keyEl = el.querySelector('#reauthKey');
    const rememberEl = el.querySelector('#reauthRemember');
    const errEl = el.querySelector('#reauthError');
    const submitEl = el.querySelector('#reauthSubmit');
    // Wie beim letzten Login: „Angemeldet bleiben" aus dem Login-Formular übernehmen.
    rememberEl.checked = !!document.getElementById('loginRememberMe')?.checked;
    const showError = (msg) => { errEl.textContent = msg; errEl.classList.remove('hidden'); };
    el.querySelector('#reauthCancel').addEventListener('click', () => {
      el.remove();
      reject(new Error('Sitzung abgelaufen'));
    });
    el.querySelector('#reauthForm').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const key = keyEl.value.trim();
      if (!key) { showError('Bitte Key eingeben.'); return; }
      submitEl.disabled = true;
      try {
        const data = await _api('POST', '/auth', {
          body: { user_key: key, long_lived: rememberEl.checked },
          reauth: false
        });
        keyEl.value = '';
        if (!APP_KEYS.user || data.user.id !== APP_KEYS.user._id) { location.reload(); return; }
        _applyServerUser(data.user);
        _loginGeneration++;
        el.remove();
        resolve();
      } catch (e) {
        showError(e.message);
      } finally {
        submitEl.disabled = false;
      }
    });
    setTimeout(() => keyEl.focus(), 50);
  });
}
```

The overlay uses inline styles, so it looks the same whatever Tailwind generates. Only `#reauthError` uses the class `hidden`, which the page already relies on everywhere. Its text is set through `textContent`, never `innerHTML`, because it is the server's message.

- [ ] **Step 4: Repeat a late 401 without a second overlay**

In `_api()`, replace:

```js
async function _api(method, path, { body, headers, keepalive, reauth = true } = {}) {
  const h = Object.assign({ 'Accept': 'application/json' }, headers || {});
```

with:

```js
async function _api(method, path, { body, headers, keepalive, reauth = true } = {}) {
  // Anmeldestand beim Absenden (siehe _reauth).
  const loginGeneration = _loginGeneration;
  const h = Object.assign({ 'Accept': 'application/json' }, headers || {});
```

Then replace:

```js
    if (res.status === 401 && type === 'UNAUTHENTICATED' && reauth) {
      await _reauth();
```

with:

```js
    if (res.status === 401 && type === 'UNAUTHENTICATED' && reauth) {
      // Wurde seit dem Absenden schon neu angemeldet, reicht die Wiederholung.
      if (loginGeneration === _loginGeneration) await _reauth();
```

`_loginGeneration` is declared with `let` below `_api`. That is fine, for the same reason as `API_BASE`: the script has been fully evaluated before any call reaches `_api`.

- [ ] **Step 5: Check by counts**

Run:

```bash
for n in "throw new Error('Sitzung abgelaufen')" "new Error('Sitzung abgelaufen')" reauthOverlay _loginGeneration; do printf '%s %s\n' "$n" "$(grep -c -F -- "$n" index.html)"; done
```

Expected: `0`, `1`, `1` and `4`, in that order.

- [ ] **Step 6: Run the tests**

Run: `npm run test:e2e -- test/e2e/reauth.e2e.ts` → PASS (5 tests).
Run: `npm test && npm run test:e2e && npm run typecheck && npm run lint` → PASS.

- [ ] **Step 7: Commit and push**

```bash
git add index.html test/e2e/reauth.e2e.ts
git commit -m "feat(frontend): re-login overlay when the session expires"
git push -u origin claude/awesome-faraday-jjwsxl
```

---

### Task 12: Service worker v2, loader redirects and the GitHub Pages guard

**Files:**
- Modify: `sw.js`
- Modify: `index.html`:
  - `<head>`: a new first script directly after `<meta charset="utf-8" />`, and one comment in the PWA setup script below it;
  - `forceAppUpdate()` in the section `PULL-TO-REFRESH (Mobile)`;
  - delete the section `UPDATE-CHECK (raw.githubusercontent.com — bypasst GitHub-Pages-CDN)` and its four calls at the end of `init()` (section `INIT`).
- Replace: `loader.html`, `loader-admin.html` (the whole file each)
- Modify: `test/frontend/guard.test.ts`
- Create: `test/e2e/pwa.e2e.ts`

**Interfaces:**
- Consumes:
  - The harness (Task 2): `newPage({ serviceWorkers: 'allow' })`, `openApp`, `run`, `assertClean`. Its context route lets the harness origin through, stubs Tailwind and lucide, and records every other host. A `page.route()` takes precedence over it, so a test can play GitHub Pages and Railway itself.
  - `readData(table)` (Task 3).
  - `ROOT_DIR` from `test/helpers/context.ts`: the repo root.
  - Backend (unchanged): `/` and `/sw.js` are served with `cache-control: no-cache`. On Railway, `/loader.html` and `/loader-admin.html` answer `302` to `/`, so the two files are only ever served by GitHub Pages.
- Produces:
  - `sw.js` with `SW_VERSION = 'erp-hero-sw-v2'`:
    - its fetch handler returns without `respondWith` for `/api/…` and `/healthz`;
    - activation deletes every other cache, v1's included.
  - `forceAppUpdate()` → `Promise<void>`:
    - it removes the `app_cache_*` and `cache_*` localStorage keys and every Cache Storage entry;
    - then it navigates to `/?t=<milliseconds>`.
  - The GitHub Pages guard: the first script in `index.html`.
  - `loader.html` and `loader-admin.html`: two identical redirect pages.

The old home was GitHub Pages:
- `loader.html` fetched `index.html` from `raw.githubusercontent.com`, kept a copy in localStorage under `app_cache_giltglobalinvest-pixel/erp_hero` (plus `…_at`, `…_seen_sha` and `…_suppress`), and wrote it into its own page with `document.write`.
- `loader-admin.html` could load any older version, including the ones with the embedded token.

After this task, both lead only to Railway, and a copy of `index.html` opened on any `github.io` page leaves before the app starts. The v1 service worker stored every same-origin `GET` answer, including `/api/…` data of one session. v2 leaves those to the network (spec scenario 13).

- [ ] **Step 1: Extend the guard test**

Append to `test/frontend/guard.test.ts`, after the `describe('index.html', …)` block:

```ts
describe('sw.js', () => {
  const sw = read('sw.js');

  it('is version 2 and leaves /api/ and /healthz to the network', () => {
    expect(sw.includes("const SW_VERSION = 'erp-hero-sw-v2';")).toBe(true);
    expect(sw.includes("if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return;")).toBe(true);
  });
});
```

- [ ] **Step 2: Write the failing e2e tests**

```ts
// test/e2e/pwa.e2e.ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ROOT_DIR } from '../helpers/context.js';
import { startHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.resetContexts();
});
afterAll(async () => {
  await h.close();
});

const RAILWAY = 'https://erp-hero-production.up.railway.app/';
// The old home on GitHub Pages, and the localStorage key of the old loader's copy of index.html.
const PAGES = 'https://giltglobalinvest-pixel.github.io';
const LOADER_CACHE_KEY = 'app_cache_giltglobalinvest-pixel/erp_hero';

// What the service worker must leave to the network.
const isApi = (pathname: string): boolean => pathname.startsWith('/api/') || pathname === '/healthz';

// Plays GitHub Pages (pathname → HTML, else 404) and Railway (a stand-in page) for this page.
// page.route() takes precedence over the harness's context route.
// Returns the GitHub Pages pathnames the page asked for.
const playPagesAndRailway = async (page: Page, pages: Record<string, string>): Promise<string[]> => {
  const requested: string[] = [];
  await page.route(`${PAGES}/**`, (route) => {
    const pathname = new URL(route.request().url()).pathname;
    requested.push(pathname);
    const body = pages[pathname];
    return body === undefined
      ? route.fulfill({ status: 404, contentType: 'text/plain', body: 'nicht gefunden' })
      : route.fulfill({ contentType: 'text/html; charset=utf-8', body });
  });
  await page.route(`${RAILWAY}**`, (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<p id="railway">Railway</p>' }),
  );
  return requested;
};

const controlled = (page: Page): Promise<boolean> =>
  h.run<boolean>(page, 'return !!navigator.serviceWorker.controller;');

// Cache Storage of the page's origin: cache name → cached pathnames.
const cacheContents = (page: Page): Promise<Record<string, string[]>> =>
  h.run<Record<string, string[]>>(
    page,
    `const out = {};
     for (const name of await caches.keys()) {
       out[name] = (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname);
     }
     return out;`,
  );

describe('service worker', () => {
  it('scenario 13: v2 never answers or stores /api/ and /healthz, and drops the v1 cache', async () => {
    const page = await h.newPage({ serviceWorkers: 'allow' });
    // An old installation: a v1 cache with a stored API answer. Any page of the origin can create it.
    await page.goto(`${h.baseUrl}/healthz`);
    await h.run(page, `await (await caches.open('erp-hero-sw-v1')).put('/api/me', new Response('{}'));`);
    const fromWorker: string[] = [];
    page.on('response', (res) => {
      const url = new URL(res.url());
      if (url.origin === h.baseUrl && res.fromServiceWorker()) fromWorker.push(url.pathname);
    });

    await h.openApp(page, 'vera');
    await expect.poll(() => controlled(page), { timeout: 10_000 }).toBe(true);
    await h.run(page, `await readData('Company'); await fetch('/healthz');`);
    // From the second visit on, the worker sees every request, the page itself included.
    await page.reload();
    await page.waitForSelector('#appShell:not(.hidden)', { state: 'visible' });
    await h.run(page, `await readData('Customer');`);

    expect(fromWorker.includes('/')).toBe(true);
    expect(fromWorker.filter(isApi)).toEqual([]);
    await expect.poll(async () => Object.keys(await cacheContents(page)), { timeout: 5_000 }).toEqual(['erp-hero-sw-v2']);
    await expect
      .poll(async () => (await cacheContents(page))['erp-hero-sw-v2']?.includes('/'), { timeout: 5_000 })
      .toBe(true);
    expect(((await cacheContents(page))['erp-hero-sw-v2'] ?? []).filter(isApi)).toEqual([]);
    await h.assertClean(page);
  });
});

describe('GitHub Pages', () => {
  const indexHtml = readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');

  it('a copy of index.html there moves on to Railway before the app starts', async () => {
    const page = await h.newPage();
    const requested = await playPagesAndRailway(page, { '/erp_hero/': indexHtml });
    await page.goto(`${PAGES}/erp_hero/`, { waitUntil: 'commit' });
    await page.waitForURL(RAILWAY, { timeout: 5_000 });
    expect(await page.locator('#railway').textContent()).toBe('Railway');
    // Once started, the app would ask github.io for /api/me at once.
    expect(requested.filter(isApi)).toEqual([]);
    await h.assertClean(page);
  });

  it('so does the old loader, which writes index.html into its own page', async () => {
    const page = await h.newPage();
    // Like the old loader.html, which fetched the file from raw.githubusercontent.com.
    const oldLoader = `<!DOCTYPE html><html><body><script>
      fetch('index.html').then((r) => r.text()).then((t) => { document.open(); document.write(t); document.close(); });
    </script></body></html>`;
    const requested = await playPagesAndRailway(page, {
      '/erp_hero/loader.html': oldLoader,
      '/erp_hero/index.html': indexHtml,
    });
    await page.goto(`${PAGES}/erp_hero/loader.html`, { waitUntil: 'commit' });
    await page.waitForURL(RAILWAY, { timeout: 5_000 });
    expect(requested.filter(isApi)).toEqual([]);
    await h.assertClean(page);
  });

  it.each(['loader.html', 'loader-admin.html'])('%s deletes the old copy of the app and moves on to Railway', async (file) => {
    const loader = readFileSync(path.join(ROOT_DIR, file), 'utf8');
    // The fallback when the redirect does not run.
    expect(loader.includes('<a href="https://erp-hero-production.up.railway.app/">Weiter zu ERP Hero</a>')).toBe(true);
    const page = await h.newPage();
    await playPagesAndRailway(page, { '/erp_hero/': '<!DOCTYPE html><title>leer</title>', [`/erp_hero/${file}`]: loader });
    await page.goto(`${PAGES}/erp_hero/`);
    await h.run(
      page,
      `localStorage.setItem('${LOADER_CACHE_KEY}', '<html>alt</html>');
       localStorage.setItem('${LOADER_CACHE_KEY}_at', '2026-01-01T00:00:00.000Z');
       localStorage.setItem('e2e_bleibt', '1');`,
    );
    await page.goto(`${PAGES}/erp_hero/${file}`, { waitUntil: 'commit' });
    await page.waitForURL(RAILWAY, { timeout: 5_000 });
    await page.goto(`${PAGES}/erp_hero/`);
    expect(await h.run<string[]>(page, 'return Object.keys(localStorage);')).toEqual(['e2e_bleibt']);
    await h.assertClean(page);
  });
});

describe('forceAppUpdate', () => {
  it('clears the old copies and Cache Storage, then loads / again', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    await h.run(
      page,
      `localStorage.setItem('${LOADER_CACHE_KEY}', '<html>alt</html>');
       localStorage.setItem('cache_Company', '[]');
       localStorage.setItem('e2e_bleibt', '1');
       await (await caches.open('erp-hero-sw-v1')).put('/', new Response('alt'));`,
    );
    // It navigates away, so it is started and not awaited.
    await h.run(page, 'forceAppUpdate();');
    await page.waitForURL(/\/\?t=\d+$/, { timeout: 5_000 });
    await page.waitForSelector('#appShell:not(.hidden)', { state: 'visible' });
    const left = await h.run<Record<string, unknown>>(
      page,
      `return {
         cacheKeys: Object.keys(localStorage).filter((k) => k.startsWith('app_cache_') || k.startsWith('cache_')),
         kept: localStorage.getItem('e2e_bleibt'),
         cacheStorage: await caches.keys(),
       };`,
    );
    expect(left).toEqual({ cacheKeys: [], kept: '1', cacheStorage: [] });
    await h.assertClean(page);
  });
});
```

`fromServiceWorker()` is true only for answers the worker gave through `respondWith`. So `fromWorker` shows exactly what v1 intercepted and v2 must leave alone. Checking only the cache would depend on timing, because the worker stores its copy after it has answered.

- [ ] **Step 3: Run them and see them fail**

Run: `npx vitest run test/frontend/guard.test.ts`
Expected: FAIL in `sw.js` (`expected false to be true`).

Run: `npm run test:e2e -- test/e2e/pwa.e2e.ts`
Expected: FAIL, 6 of 6.
- Scenario 13: `fromWorker.filter(isApi)` lists `/api/…` paths, because v1 answers every same-origin `GET`.
- Both GitHub Pages tests: `waitForURL` times out after 5000 ms, because the app stays on github.io.
- Both loader tests: the fallback link check fails (`expected false to be true`); the old loaders have no such link.
- `forceAppUpdate`: `waitForURL` times out. The old code goes to `loader.html?t=…`, and the server redirects that to `/`.

- [ ] **Step 4: Service worker v2**

In `sw.js`, replace:

```js
// Minimaler SW fuer PWA-Installierbarkeit + Network-first mit Offline-Fallback.
// Bewusst klein gehalten — die App lebt von Live-Daten (Airtable, Freshdesk),
// daher kein aggressives Caching von API-Calls. Nur Shell (HTML/JS-CDNs) wird
// optional bei wiederholten Aufrufen schneller dank Browser-Cache.
```

with:

```js
// Minimaler SW fuer PWA-Installierbarkeit + Network-first mit Offline-Fallback.
// Bewusst klein gehalten — die App lebt von Live-Daten ueber den eigenen Server.
// Anfragen an /api/ und /healthz gehen immer direkt ans Netz und werden nie
// gespeichert; gecacht wird nur die App-Shell (index.html) fuer den Offline-Fall.
```

Replace:

```js
const SW_VERSION = 'erp-hero-sw-v1';
```

with:

```js
const SW_VERSION = 'erp-hero-sw-v2';
```

Replace:

```js
  // Alte Caches aufraeumen (falls jemals welche entstanden sind)
```

with:

```js
  // Alte Caches aufraeumen — v1 hat auch API-Antworten gespeichert
```

Replace:

```js
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
```

with:

```js
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // API und Healthcheck nie abfangen: Die Antworten gehoeren zu einer Sitzung und sind Live-Daten.
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return;
```

The browser checks `/sw.js` on every visit (the server sends `no-cache`). A changed file installs at once (`skipWaiting`), and activation removes the v1 cache and takes over open tabs (`clients.claim()`).

- [ ] **Step 5: The GitHub Pages guard**

In `index.html`, replace:

```html
<meta charset="utf-8" />
```

with:

```html
<meta charset="utf-8" />
<!-- Die App lebt nur auf Railway. Kopien auf GitHub Pages (direkt oder über den alten Loader) leiten sofort dorthin um. -->
<script>
  if (/(^|\.)github\.io$/i.test(location.hostname)) {
    window.stop();
    location.replace('https://erp-hero-production.up.railway.app/');
  }
</script>
```

`window.stop()` ends the parsing of the page. So on github.io neither the rest of `<head>` nor the app script runs, and the app makes no request before the redirect. Only the preload scanner may already have asked for Tailwind; the harness stubs it. The old loader writes the fetched file into its own github.io page with `document.write`, so the same check catches that path too.

In the PWA setup script below, replace:

```js
  // 2) Service Worker registrieren — sw.js liegt im selben Verzeichnis (per gitdeploy hochgeladen).
```

with:

```js
  // 2) Service Worker registrieren — sw.js liefert der Server neben index.html aus.
```

- [ ] **Step 6: forceAppUpdate without the loader**

In the section `PULL-TO-REFRESH (Mobile)`, replace the whole function `forceAppUpdate()` with:

```js
async function forceAppUpdate() {
  toast('Lade neueste Version…', 'info', 1500);
  // Alte Loader-Kopie, App-Caches und den Service-Worker-Cache leeren, damit auch der Offline-Fallback keine alte Version zeigt
  try {
    Object.keys(localStorage).forEach(k => {
      if (k.startsWith('app_cache_') || k.startsWith('cache_')) localStorage.removeItem(k);
    });
  } catch (e) {}
  try {
    if (window.caches) {
      const names = await caches.keys();
      await Promise.all(names.map(n => caches.delete(n)));
    }
  } catch (e) {}
  // Der Server liefert index.html mit no-cache aus; ?t= macht das Neuladen trotzdem eindeutig.
  setTimeout(() => location.replace('/?t=' + Date.now()), 250);
}
```

The button calls it as `onclick="forceAppUpdate()"` and ignores the promise, which is fine.

- [ ] **Step 7: Delete the dead update check**

`checkForUpdate()` has been a no-op since the loader took over update detection, and the loader is gone now.

Replace:

```js
/* ============================================================
   UPDATE-CHECK (raw.githubusercontent.com — bypasst GitHub-Pages-CDN)
   ============================================================ */
async function checkForUpdate() {
  // App-eigenes Update-Banner entfernt — der Loader übernimmt Update-Erkennung + UI.
  // Funktion bleibt als No-Op für die Init-Aufrufe.
}

/* ============================================================
   PWA: APP-ICON (FLP Hero-Maskottchen, SVG → Canvas → PNG)
```

with:

```js
/* ============================================================
   PWA: APP-ICON (FLP Hero-Maskottchen, SVG → Canvas → PNG)
```

At the end of `init()` (section `INIT`), replace:

```js
  else showLoginScreen();

  // Update-Check: einmal nach UI ready, dann alle 3 Min + bei Tab-Wechsel/Fokus
  setTimeout(checkForUpdate, 1500);
  setInterval(checkForUpdate, 3 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });
  window.addEventListener('focus', checkForUpdate);
}
```

with:

```js
  else showLoginScreen();
}
```

- [ ] **Step 8: The loaders become redirect pages**

Replace the whole content of `loader.html` with:

```html
<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ERP Hero</title>
<style>
html,body{height:100%;margin:0;font-family:-apple-system,system-ui,Segoe UI,Roboto,sans-serif;}
body{display:flex;align-items:center;justify-content:center;background:#0d0d0d;color:#fff;text-align:center;}
a{color:#00e676;font-weight:700;}
</style>
</head>
<body>
<div>
<p>ERP Hero ist umgezogen.</p>
<p><a href="https://erp-hero-production.up.railway.app/">Weiter zu ERP Hero</a></p>
</div>
<script>
// ERP Hero läuft nur noch auf Railway. Die alte Kopie von index.html aus dem Loader-Cache wird gelöscht.
try {
  Object.keys(localStorage).forEach(function (k) {
    if (k.indexOf('app_cache_') === 0) localStorage.removeItem(k);
  });
} catch (e) {}
location.replace('https://erp-hero-production.up.railway.app/');
</script>
</body>
</html>
```

Then make `loader-admin.html` the same page. Its version picker loaded old `index.html` versions, which still contain the old token and talk to Airtable directly.

```bash
cp loader.html loader-admin.html
```

- [ ] **Step 9: Check by counts**

Run:

```bash
for n in erp-hero-sw-v2 erp-hero-sw-v1 "url.pathname.startsWith('/api/')" Airtable; do printf '%s %s\n' "$n" "$(grep -c -F -- "$n" sw.js)"; done
for n in 'window.stop()' "location.replace('https://erp-hero-production.up.railway.app/')" "location.replace('/?t=' + Date.now())" loader.html raw.githubusercontent checkForUpdate gitdeploy; do printf '%s %s\n' "$n" "$(grep -c -F -- "$n" index.html)"; done
cmp loader.html loader-admin.html && grep -c -F -e raw.githubusercontent -e document.write loader.html
```

Expected:
- `sw.js`: `1`, `0`, `1` and `0`, in that order.
- `index.html`: `1`, `1`, `1`, `0`, `0`, `0` and `0`.
- `cmp` prints nothing, and the last `grep` prints `0`.

- [ ] **Step 10: Run the tests**

Run: `npx vitest run test/frontend/guard.test.ts` → PASS.
Run: `npm run test:e2e -- test/e2e/pwa.e2e.ts` → PASS (6 tests).
Run: `npm test && npm run test:e2e && npm run typecheck && npm run lint` → PASS.

- [ ] **Step 11: Commit and push**

```bash
git add sw.js index.html loader.html loader-admin.html test/frontend/guard.test.ts test/e2e/pwa.e2e.ts
git commit -m "feat(frontend): service worker v2, loader redirects and GitHub Pages guard"
git push -u origin claude/awesome-faraday-jjwsxl
```

---

### Task 13: Start page, AI costs page, version v6.0 and the full guard

**Files:**
- Modify: `index.html`:
  - the section `APP CONFIG`: `APP_VERSION`, `APP_CONFIG` and the `APP_KEYS` literal;
  - `renderWelcome()` in the section `UI: SHELL (Sidebar / Drawer / Sections)`;
  - the section `AI USAGE LOGGING & COST TRACKING`: `AI_USAGE_LOG_SCHEMA` (deleted) and `_logAiUsage()`;
  - the section `ADMIN: API-KOSTEN (AiUsageLog Dashboard)`: `renderAdminAiCosts()`, and `_createAiUsageLogTableManually()` (deleted).
- Modify: `test/frontend/guard.test.ts`
- Create: `test/e2e/start-and-costs.e2e.ts`

**Interfaces:**
- Consumes:
  - The harness (Task 2): `openApp`, `run`, `deps.records.list(table)`, `users`, `companies`, `assertClean`. A `page.route()` takes precedence over the harness's own route.
  - `readData` with the error prefix `'Lesen fehlgeschlagen: '` (Task 3). `ensureTable` has been a no-op since Task 3.
  - `APP_KEYS.user = {_id, name, …}` (Task 4). `APP_KEYS.proxyV2` is always `true` (Task 4), and `_proxyBase()` always returns `'/api'` (Task 8).
  - Backend (unchanged): `AiUsageLog` is one of the server's fixed tables. Every user may create entries; only admins may read them. Empty field values are not stored.
- Produces:
  - `APP_VERSION === 'v6.0'`.
  - `APP_KEYS` without `airtableWriteKey`, `anthropicKey`, `appBaseId`, `apiProxyUrl`, `freshdeskProxyUrl` and `freshdeskProxyToken`. `APP_CONFIG` without `MASTER_BASE_ID` and `APP_BASE_ID`.
  - `_logAiUsage(data, opts)` stores `user_id` (the user's record id) and `company_name`.
  - `renderAdminAiCosts()` shows a load error in `#aiCostsError`.
  - `test/frontend/guard.test.ts` covers the whole list of spec §14, together with the checks from Tasks 1 and 9.

Tasks 3 to 12 removed every Airtable and Val.town call. What is left are texts and dead fields that still describe the old setup:
- The start page shows the status tiles "Airtable", "Schreibrechte" (active only with the old Airtable write key) and "KI · Proxy", and the roadmap card says "Auth via Airtable".
- The AI costs page offers to create the `AiUsageLog` table "in der Airtable-Base". On the server the table always exists, so a load error is a real error and is shown as such.
- `_logAiUsage` has two old bugs. It reads `APP_KEYS.user?.id`, but the user object has `_id`. It reads `cur?.fields?.name`, but company objects have `name`. So every entry lacks the user id and the company name, and the page's user and company filters show nothing or "(unbekannt)".

Deliberately left alone: the words "Val.town" and "Airtable" in comments, in AI prompt texts, and in branches that no longer run (`if (!APP_KEYS.proxyV2) …`, `if (!_proxyBase()) …`). Those call sites stay unchanged (spec D3). The guard checks host names, key names and code, not words.

- [ ] **Step 1: Extend the guard test**

In `test/frontend/guard.test.ts`, add inside `describe('index.html', …)`:

```ts
  it('has none of the old hosts, keys and token fields (spec §14)', () => {
    for (const name of [
      'api.airtable.com', 'content.airtable.com', 'val.town', 'val.run', 'esm.town',
      'AIRTABLE_READ_KEY', 'airtableWriteKey', 'sessionToken',
    ]) {
      expect(html.includes(name), name).toBe(false);
    }
  });

  it('has no Airtable or Val.town config and no Airtable table setup left', () => {
    for (const name of [
      'MASTER_BASE_ID', 'APP_BASE_ID', 'appBaseId', 'anthropicKey', 'apiProxyUrl', 'freshdeskProxyUrl',
      'freshdeskProxyToken', 'AI_USAGE_LOG_SCHEMA', '_createAiUsageLogTableManually',
    ]) {
      expect(html.includes(name), name).toBe(false);
    }
  });
```

- [ ] **Step 2: Write the failing e2e tests**

```ts
// test/e2e/start-and-costs.e2e.ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.resetContexts();
});
afterAll(async () => {
  await h.close();
});

describe('start page', () => {
  it('shows version v6.0 on the login screen', async () => {
    const page = await h.newPage();
    await h.openApp(page);
    expect(await page.locator('#loginVersionLabel').textContent()).toBe('v6.0');
    await h.assertClean(page);
  });

  it('shows the server status tiles and the roadmap without Airtable', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    expect(await page.locator('#topbarVersion').textContent()).toBe('v6.0');
    const tiles = await h.run<string[]>(
      page,
      `const status = [...document.querySelectorAll('#pageContent h3')].find((e) => e.textContent.trim() === 'Status');
       return [...status.nextElementSibling.children].map((tile) => tile.innerText.replace(/\\s+/g, ' ').trim());`,
    );
    expect(tiles).toEqual(['Server verbunden', 'Schreibrechte aktiv', 'KI über Server']);
    const text = await page.locator('#pageContent').innerText();
    expect(text.includes('Auth via Server')).toBe(true);
    expect(text.includes('Airtable')).toBe(false);
    await h.assertClean(page);
  });
});

describe('AI costs page', () => {
  it('logs the user id and the company name, and offers both as filters', async () => {
    const vera = await h.newPage();
    await h.openApp(vera, 'vera');
    await h.run(
      vera,
      `await _logAiUsage(
         { id: 'msg_e2e', model: 'claude-sonnet-4-5-20250929', usage: { input_tokens: 1000, output_tokens: 200 } },
         { purpose: 'e2e-kosten' },
       );`,
    );
    const [entry] = await h.deps.records.list('AiUsageLog');
    expect(entry?.fields).toEqual(
      expect.objectContaining({
        created_at: expect.any(String),
        user_id: h.users.vera.id,
        user_name: 'Vera Vertrieb',
        company_id: h.companies.alpha,
        company_name: 'Alpha GmbH',
        model: 'claude-sonnet-4-5-20250929',
        purpose: 'e2e-kosten',
        input_tokens: 1000,
        output_tokens: 200,
        cost_usd: 0.006,
        request_id: 'msg_e2e',
      }),
    );
    await h.assertClean(vera);

    const admin = await h.newPage();
    await h.openApp(admin, 'admin');
    const filters = await h.run<{ users: string[][]; companies: string[][] }>(
      admin,
      `await renderAdminAiCosts();
       const options = (label) => {
         const field = [...document.querySelectorAll('#pageContent label')].find((l) => l.textContent.trim() === label);
         return [...field.nextElementSibling.options].filter((o) => o.value).map((o) => [o.value, o.textContent.trim()]);
       };
       return { users: options('Benutzer'), companies: options('Firma') };`,
    );
    expect(filters).toEqual({
      users: [[h.users.vera.id, 'Vera Vertrieb']],
      companies: [[h.companies.alpha, 'Alpha GmbH']],
    });
    await h.assertClean(admin);
  });

  it('shows the server error when the logs cannot be loaded', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'admin');
    await page.route(/\/api\/data\/AiUsageLog(\?|$)/, (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { type: 'INTERNAL', message: 'Datenbank nicht lesbar' } }),
      }),
    );
    const shown = await h.run<{ error: string | null; text: string }>(
      page,
      `await renderAdminAiCosts();
       return {
         error: document.getElementById('aiCostsError')?.textContent ?? null,
         text: document.getElementById('pageContent').innerText,
       };`,
    );
    expect(shown.error).toBe('Lesen fehlgeschlagen: Datenbank nicht lesbar');
    expect(shown.text.includes('Airtable')).toBe(false);
    expect(shown.text.includes('Tabelle jetzt anlegen')).toBe(false);
    await h.assertClean(page);
  });
});
```

- [ ] **Step 3: Run the tests and see them fail**

Run: `npx vitest run test/frontend/guard.test.ts`
Expected: FAIL in the two new tests, with `airtableWriteKey: expected true to be false` and `MASTER_BASE_ID: expected true to be false`.

Run: `npm run test:e2e -- test/e2e/start-and-costs.e2e.ts`
Expected: FAIL in all four tests:
- both start page tests get `'v5.20'` instead of `'v6.0'`;
- the log entry has no `user_id` and no `company_name`;
- `shown.error` is `null`, because the old error box has no `#aiCostsError`.

- [ ] **Step 4: Version and config**

In the section `APP CONFIG`, replace:

```js
const APP_VERSION = 'v5.20';
```

with:

```js
const APP_VERSION = 'v6.0';
```

Replace:

```js
const APP_CONFIG = {
  MASTER_BASE_ID: 'app…',
  APP_BASE_ID: 'app…',
  PROJECT_ID: 'p_1778057282571',
```

with:

```js
const APP_CONFIG = {
  PROJECT_ID: 'p_1778057282571',
```

In the `APP_KEYS` literal, replace:

```js
const APP_KEYS = {
  airtableWriteKey: null,
  anthropicKey: null,
  appBaseId: null,
  user: null,
```

with:

```js
const APP_KEYS = {
  user: null,
```

Replace:

```js
  // Val.town-Proxy: zentraler Endpoint für Anthropic + Freshdesk.
  // Auth zum Proxy = User-API-Key (jeder Mitarbeiter hat eigenen).
  apiProxyUrl: null,
  // Freshdesk-Anbindung (nur Sales-Group-ID bleibt clientseitig — der API-Key
  // liegt in Val.town als env var). Legacy-Felder bleiben für Migration.
  freshdeskProxyUrl: null,
  freshdeskProxyToken: null,
  freshdeskSalesGroupId: null,
```

with:

```js
  // Freshdesk-Anbindung: im Browser liegen nur Einstellungen (Gruppen, Typen,
  // Domain) — die API-Keys verwaltet der Server.
  freshdeskSalesGroupId: null,
```

Replace:

```js
  // Freshsales-CRM: Subdomain (z.B. "gilt" für gilt.freshworks.com)
  // + API-Key liegt in Val.town als env var, NICHT im Browser
```

with:

```js
  // Freshsales-CRM: Subdomain (z.B. "gilt" für gilt.freshworks.com);
  // der API-Key liegt auf dem Server, NICHT im Browser
```

The `proxyV2: true` line that Task 4 added after `usersById: {},` stays.

- [ ] **Step 5: Start page**

In `renderWelcome()` (section `UI: SHELL (Sidebar / Drawer / Sections)`), replace:

```js
        ${roadmapCard('v1.0', 'Login & Shell', 'check', 'done', 'Mandantenfähig, Auth via Airtable')}
```

with:

```js
        ${roadmapCard('v1.0', 'Login & Shell', 'check', 'done', 'Mandantenfähig, Auth via Server')}
```

Replace:

```js
        ${statusTile('Airtable', 'plug', APP_CONFIG.APP_BASE_ID ? 'verbunden' : 'nicht verbunden', !!APP_CONFIG.APP_BASE_ID)}
        ${statusTile('Schreibrechte', 'pencil', APP_KEYS.airtableWriteKey ? 'aktiv' : 'fehlt', !!APP_KEYS.airtableWriteKey)}
        ${statusTile('KI · Proxy', 'sparkles', _proxyBase() ? 'verbunden' : 'nicht konfiguriert', !!_proxyBase())}
```

with:

```js
        ${statusTile('Server', 'plug', 'verbunden', true)}
        ${statusTile('Schreibrechte', 'pencil', APP_KEYS.user ? 'aktiv' : 'fehlt', !!APP_KEYS.user)}
        ${statusTile('KI', 'sparkles', 'über Server', true)}
```

The start page is only rendered for a logged-in user, and every logged-in user may write.

- [ ] **Step 6: AI usage logging**

In the section `AI USAGE LOGGING & COST TRACKING`, delete the Airtable table schema. Replace:

```js
// Schema für die AiUsageLog-Tabelle. Airtable Meta-API erwartet vollständige
// Options bei dateTime + number — ohne die schlägt das Anlegen still fehl.
const AI_USAGE_LOG_SCHEMA = [
  { name: 'created_at', type: 'dateTime', options: {
      dateFormat: { name: 'iso' },
      timeFormat: { name: '24hour' },
      timeZone: 'client'
    } },
  { name: 'user_id',                     type: 'singleLineText' },
  { name: 'user_name',                   type: 'singleLineText' },
  { name: 'company_id',                  type: 'singleLineText' },
  { name: 'company_name',                type: 'singleLineText' },
  { name: 'model',                       type: 'singleLineText' },
  { name: 'purpose',                     type: 'singleLineText' },
  { name: 'input_tokens',                type: 'number', options: { precision: 0 } },
  { name: 'output_tokens',               type: 'number', options: { precision: 0 } },
  { name: 'cache_creation_input_tokens', type: 'number', options: { precision: 0 } },
  { name: 'cache_read_input_tokens',     type: 'number', options: { precision: 0 } },
  { name: 'cost_usd',                    type: 'number', options: { precision: 6 } },
  { name: 'request_id',                  type: 'singleLineText' }
];

function _aiPricingFor(model) {
```

with:

```js
function _aiPricingFor(model) {
```

Then fix `_logAiUsage()` and its comment. Replace:

```js
// Schreibt einen Eintrag in die AiUsageLog-Tabelle in Airtable.
```

with:

```js
// Schreibt einen Eintrag in die AiUsageLog-Tabelle auf dem Server.
```

Replace:

```js
    const userId = APP_KEYS.user?.id || '';
```

with:

```js
    const userId = APP_KEYS.user?._id || '';
```

Replace:

```js
    const now = new Date();
    // Tabelle lazy anlegen (idempotent) — Fehler stumm (Logging darf den
    // eigentlichen AI-Call nicht stören; Admin-Dashboard zeigt den Fehler später)
    await ensureTable('AiUsageLog', AI_USAGE_LOG_SCHEMA).catch(()=>{});
    await writeData('AiUsageLog', {
```

with:

```js
    const now = new Date();
    await writeData('AiUsageLog', {
```

Replace:

```js
      company_name: cur?.fields?.name || '',
```

with:

```js
      company_name: cur?.name || '',
```

- [ ] **Step 7: AI costs page**

In the section `ADMIN: API-KOSTEN (AiUsageLog Dashboard)`, replace the whole function `renderAdminAiCosts()` with:

```js
async function renderAdminAiCosts() {
  setPageTitle('API-Kosten');
  if (!APP_KEYS.user?.is_admin) {
    document.getElementById('pageContent').innerHTML = `
      <div class="max-w-3xl mx-auto"><div class="bg-amber-50 border border-amber-200 rounded-2xl p-6 text-amber-900">Nur für Admins.</div></div>`;
    return;
  }

  document.getElementById('pageContent').innerHTML = '<p class="text-ink-500 text-sm">Lade Logs…</p>';
  let logs = [];
  try {
    logs = await readData('AiUsageLog', null, { sort: [{ field: 'created_at', direction: 'desc' }] });
  } catch (e) {
    // Die Tabelle gibt es auf dem Server immer — ein Fehler hier ist echt und wird angezeigt.
    document.getElementById('pageContent').innerHTML = `
      <div class="max-w-3xl mx-auto">
        <div class="bg-amber-50 border border-amber-200 rounded-2xl p-6 text-amber-900">
          <p class="font-semibold mb-2 flex items-center gap-2">
            <i data-lucide="alert-triangle" class="w-5 h-5"></i>
            Fehler beim Laden
          </p>
          <p id="aiCostsError" class="text-sm">${escapeHtml(e.message || String(e))}</p>
        </div>
      </div>`;
    if (window.lucide) lucide.createIcons();
    return;
  }
  _aiCostsState.rows = logs.map(r => r.fields || {});
  _aiCostsState.loaded = true;
  _renderAdminAiCosts();
}
```

Then delete `_createAiUsageLogTableManually()`, whose only caller was the button in the old error box. Replace:

```js
async function _createAiUsageLogTableManually() {
  try {
    await ensureTable('AiUsageLog', AI_USAGE_LOG_SCHEMA);
    toast('Tabelle erfolgreich angelegt', 'success');
    renderAdminAiCosts();
  } catch (e) {
    toast('Anlegen fehlgeschlagen: ' + (e.message || e), 'error', 9000);
  }
}

function _renderAdminAiCosts() {
```

with:

```js
function _renderAdminAiCosts() {
```

- [ ] **Step 8: Check by counts**

Run:

```bash
for n in "const APP_VERSION = 'v6.0';" v5.20 'Auth via Airtable' 'Auth via Server' "statusTile('Airtable'" "ensureTable('AiUsageLog'" 'id="aiCostsError"' 'APP_KEYS.user?.id ' 'cur?.fields?.name'; do printf '%s %s\n' "$n" "$(grep -c -F -- "$n" index.html)"; done
```

Expected: `1`, `0`, `0`, `1`, `0`, `0`, `1`, `0` and `0`, in that order.

- [ ] **Step 9: Run the tests**

Run: `npx vitest run test/frontend/guard.test.ts` → PASS.
Run: `npm run test:e2e -- test/e2e/start-and-costs.e2e.ts` → PASS (4 tests).
Run: `npm test && npm run test:e2e && npm run typecheck && npm run lint` → PASS.

- [ ] **Step 10: Commit and push**

```bash
git add index.html test/frontend/guard.test.ts test/e2e/start-and-costs.e2e.ts
git commit -m "feat(frontend): v6.0 start page and AI costs page on the server, full static guard"
git push -u origin claude/awesome-faraday-jjwsxl
```

---

### Task 14: DEPLOY.md for the switched app: smoke test, cutover and known limitations

**Files:**
- Modify: `DEPLOY.md`: the intro note, section 1 step 3, section 4, sections 6 to 9, and a new section 10 before "Local development".

**Interfaces:**
- Consumes: the UI labels of the switched app (Tasks 4, 5, 10 and 13):
  - sidebar groups "Stammdaten" (with "Kunden") and "Administration" (with "Firmen" and "Benutzer");
  - buttons "Firma anlegen", "Neuer Kunde", "Benutzer anlegen";
  - in the user form: "Neu", "Kopieren" and "Alle Sitzungen abmelden";
  - the login page footer "ERP Hero v6.0".
- Produces: `DEPLOY.md` as the operator's guide after the switch. The controller's deploy steps after the final review (below) follow its sections 6 to 8.

`DEPLOY.md` was written before the switch. It says the page "cannot work yet", sends the smoke test to a REST client, and still names the backend branch from before PR #1. This task brings it up to date (spec §15.3) and adds the result of the computed-field audit (spec §17).

**The audit (spec §17), done while writing this plan.** Every field that `index.html` reads from a record was compared with the fields it writes, on the tables where it creates records. The check parsed the app script into a syntax tree. It counted as written every object key and every string in a field-name list inside a function that calls `writeData` or `updateData`, and inside the helpers those functions call. The result:
- **No core flow depends on a field the app does not write.** Totals, line totals and document numbers are computed and saved by the app itself; the server assigns numbers (Task 5). Lookup entries are created by the app (`addLookup`, `addTerm`), and a company's letterhead fields come from its form.
- **Four smaller gaps remain.** Section 10 below lists them as follow-ups:
  - `Article.manufacturer` and `Article.category` are old text fields. Lists fall back to them, but the app now writes the links `manufacturer_id` and `category_id`. Only the article picker in the quote item form (`showQuoteItemInlineForm`) shows `manufacturer` without the fallback.
  - `Company.archived` is never written. The app archives a company with `status: 'archiviert'`, but `_listActiveMandants` (the Mandant list of the contact dialog on a Freshdesk ticket) filters on `archived`.
  - `CustomField.field_type` is never written. It is only a hint in the prompt of the AI quote assistant (`_aqcBuildSystemPrompt`).
  - Formula, lookup and rollup fields are copied as fixed values by the import. `import-report.json` lists them per table under `computedFields`.

- [ ] **Step 1: Edit DEPLOY.md**

Make each replacement below in `DEPLOY.md`. Each old text occurs exactly once.

In the intro, replace:

```markdown
> Until the frontend switch (next development step) is merged, the old GitHub Pages app stays
> the one your team uses. The page served by this backend loads, but cannot work yet: its old
> Airtable/Val.town calls are blocked on purpose by the new security policy.
```

with:

```markdown
> The page served here is the app itself (ERP Hero v6.0). It talks only to this server, under
> `/api`, and contains no Airtable or Val.town code. Once this version is on `main`, the GitHub
> Pages copy and the old loader pages send everyone to this address (section 9).

> **Revoke the old keys.** The Airtable token that was embedded in the old `index.html` stays
> readable in the git history. Revoke it in Airtable, together with the old Airtable write key.
> Revoke the Val.town API token too, and delete the Val.town proxy (`erpHeroProxy`). The app uses
> none of them anymore, and the import in section 9 uses its own read-only token.
```

In section 1, replace:

```markdown
3. Open the service → **Settings → Source** and set the **branch** to the branch with the
   backend: `claude/confident-pascal-b6b330` until it is merged, then `main`.
```

with:

```markdown
3. Open the service → **Settings → Source** and set the **branch** to `main`.
```

In section 4, replace:

```markdown
- Never paste the Airtable token that is embedded in `index.html`. The backend does not need
  Airtable at all, except on import day (section 9).
```

with:

```markdown
- Never paste the Airtable token that was embedded in the old `index.html`. The backend does not
  need Airtable at all, except on import day (section 9).
```

In section 6, replace:

```markdown
- `https://<domain>/` → the ERP Hero page. Until the frontend switch, the login cannot work yet.
```

with:

```markdown
- `https://<domain>/` → the login page, with "ERP Hero v6.0" below the form.
```

In section 7, replace:

```markdown
3. The command prints the new login key once. Store it safely.

Use this admin to smoke-test the deployment. The import in section 9 replaces all users with the users from Airtable.
```

with:

```markdown
3. The command prints the new login key once. Store it safely.

`railway ssh` needs an SSH key registered with your Railway account; the CLI offers to register one
the first time. Without SSH, use a one-time start command instead: set **Settings → Deploy → Custom
Start Command** to `npm run user:create -- --name "Patrizio" --admin && npm start`, deploy, and
read the key in that deployment's logs. Then set the start command back to `npm start` and deploy
again, so that a restart does not create another admin. The key stays readable in the logs, so give
yourself a new one after the first login (section 8, step 6).

Log in with this admin in the browser (section 8). The import in section 9 replaces all users with
the users from Airtable.
```

At the start of section 8, replace:

```markdown
## 8. Smoke test with real services (needs a logged-in session)

After the frontend switch, or with a REST client and the session cookie:
```

with:

```markdown
## 8. Smoke test in the browser

1. Open `https://<domain>/` and log in with the key from section 7.
2. **Administration → Firmen → Firma anlegen:** enter a name and save. This is your first Mandant,
   and the switcher at the top of the sidebar now shows it. With several Mandanten, pick one there.
3. **Stammdaten → Kunden → Neuer Kunde:** the form already shows the number `K-1001` (each Mandant
   starts there). Enter a name and save.
4. Close the customer, open it again, close it, and reload the page. You are still logged in, and
   the customer is still there.
5. **Administration → Benutzer → Benutzer anlegen** creates a login key for each colleague. The
   form fills in a new key: copy it with **Kopieren** before you save, because it is not shown
   again.
6. To replace a key, yours included, open the user, click **Neu**, copy the key and save. Saving a
   new key does not end open sessions; **Alle Sitzungen abmelden** in the same form does.

Then check, with real data, the areas that the automated tests do not cover:

- **PDF:** open a quote and create its PDF.
- **Quotes:** create a quote with an article item, then change the item's quantity.
- **KI-Angebot:** start one from a Freshdesk ticket (uses `ANTHROPIC_API_KEY`).
- **Freshdesk:** open a ticket in the app. This needs a Freshdesk key: your own, entered under
  Administration → Benutzer ("Freshdesk API-Keys"), or the server's fallback `FRESHDESK_API_KEY`.
- **Attachment proxy:** open a ticket with an image attachment and use an AI summary that needs
  the image. If the server answers `403 Domain nicht erlaubt: <host>`, add that host to
  `ATTACHMENT_PROXY_ALLOW` (for example `ATTACHMENT_PROXY_ALLOW=<host>,…plus the defaults`) and
  tell the developer, so the default list gets updated.
- **Freshsales, Mailchimp:** use one feature each (Freshsales sync, Mailchimp "Verbindung testen").

The API also works from a REST client with the session cookie:
```

At the end of section 8 and the start of section 9, replace:

```markdown
- **Freshdesk:** open a ticket in the app. Check that `GET /api/freshdesk/api/v2/tickets/<id>` works.
- **Attachment proxy:** open a ticket with an image attachment and use an AI summary that needs
  the image. If the server answers `403 Domain nicht erlaubt: <host>`, add that host to
  `ATTACHMENT_PROXY_ALLOW` (for example `ATTACHMENT_PROXY_ALLOW=<host>,…plus the defaults`) and
  tell the developer, so the default list gets updated.
- **Anthropic, Freshsales, Mailchimp:** use one feature each ("KI-Angebot", Freshsales sync,
  Mailchimp "Verbindung testen").

## 9. Cutover from Airtable (after the frontend switch is merged)
```

with:

```markdown
## 9. Cutover from Airtable

The app is already switched: it talks only to this server, and the loader pages redirect here.
The cutover moves the data and retires the old setup.
```

Replacing the first old text (the section 8 start) adds a second copy of the attachment proxy bullet, so make the replacements in the order given. The section 9 replacement above then matches only the original bullets, because they alone are followed by the old section 9 heading.

In section 9, step 6, replace:

```markdown
6. Everyone logs in at the new address with their existing login key (replaced in step 8).
```

with:

```markdown
6. Everyone logs in at the new address with their existing login key (replaced in step 8). Old
   bookmarks of the GitHub Pages address and of the loader pages lead here too.
```

In section 9, step 8, replace:

```markdown
   - revoke the Airtable token embedded in `index.html` and the old Airtable write key;
```

with:

```markdown
   - revoke the Airtable token that was embedded in the old `index.html`, and the old Airtable
     write key, if not done yet (see the note at the top);
```

Replace:

```markdown
   - have each user regenerate their Freshdesk API key, then enter it again under Admin → Benutzer;
```

with:

```markdown
   - have each user regenerate their Freshdesk API key, then enter it again under
     Administration → Benutzer;
```

Replace:

```markdown
   - **give every user a new login key.** The imported keys were readable through the Airtable
     token in `index.html`, and the old proxy sent them to every logged-in user. As admin, generate
     a new key for each user, yourself included, under Admin → Benutzer
     (`PATCH /api/admin/users/<id>/secrets` with `{"generate_api_key": true}`), then end that
     user's sessions (`POST /api/sessions/revoke-user` with `{"user_id": "<id>"}`). Hand each new
     key over in person or by phone. From a REST client, both calls need the session cookie and the
     `Origin: https://<domain>` header (see section 8), for example:
```

with:

```markdown
   - **give every user a new login key.** The imported keys were readable through the Airtable
     token in the old `index.html`, and the old proxy sent them to every logged-in user. As admin,
     open each user under Administration → Benutzer, yourself included: click **Neu**, copy the
     key and save, then open the user again and click **Alle Sitzungen abmelden**. Hand each new
     key over in person or by phone. A REST client does the same with
     `PATCH /api/admin/users/<id>/secrets` and `{"generate_api_key": true}`, then
     `POST /api/sessions/revoke-user` and `{"user_id": "<id>"}`. Both calls need the session cookie
     and the `Origin: https://<domain>` header (see section 8), for example:
```

At the end of section 9, replace:

```markdown
9. Keep the Airtable bases untouched as an archive.

## Local development
```

with:

```markdown
9. Keep the Airtable bases untouched as an archive.
10. GitHub Pages is no longer needed. Leave it on until nobody uses the old address anymore, so old
    bookmarks still redirect, then turn it off in GitHub under **Settings → Pages**.

## 10. Known limitations after the switch

The app computes and saves its own totals, line totals and document numbers, so no core flow
depends on an Airtable formula. These smaller gaps remain:

- **Calculated Airtable fields are frozen by the import.** Formula, lookup and rollup values are
  copied as fixed values and never recalculated. `import-report.json` lists them per table under
  `computedFields`; read that list after the import (section 9, step 4).
- **Manufacturer in the quote item's article picker.** The picker shows the old text field
  `manufacturer`, which the app no longer writes, so new articles show only their article number
  there. The article list itself uses the linked manufacturer and category.
- **Archived Mandanten in a Freshdesk ticket's contact dialog.** Its Mandant list hides companies
  by the Airtable field `archived`, but the app archives a company by setting its status to
  "archiviert". A company archived in the app still appears in that list.
- **Custom field types.** The AI quote assistant uses a custom field's Airtable field `field_type`
  as a hint. The app does not edit that field, so custom fields created in the app give no hint.
- **Every record is loaded.** Lists now load all records of a table instead of the first 100, so
  large tables can take longer to open.
- **A document number taken meanwhile.** If a colleague saves the same number first, the record is
  saved with the next free number, and a warning says so. Text that was generated before saving
  still shows the first number.

## Local development
```

- [ ] **Step 2: Check by counts**

Run:

```bash
for n in 'Until the frontend switch' 'cannot work yet' 'after the frontend switch is merged' 'confident-pascal' 'Admin → Benutzer' 'that is embedded' '## 8. Smoke test in the browser' '## 9. Cutover from Airtable' '## 10. Known limitations after the switch' 'ERP Hero v6.0' 'Revoke the old keys.' 'Custom' 'computedFields' '**Freshdesk:**' '**Attachment proxy:**' 'Administration → Benutzer' 'Alle Sitzungen abmelden'; do printf '%s %s\n' "$n" "$(grep -c -F -- "$n" DEPLOY.md)"; done
```

Expected: `0`, `0`, `0`, `0`, `0`, `0`, `1`, `1`, `1`, `2`, `1`, `2`, `1`, `1`, `1`, `4` and `2`, in that order (`grep -c` counts lines, and "Custom" appears in section 7 and section 10).

- [ ] **Step 3: Read the result once**

Read `DEPLOY.md` from the intro to section 10. The numbered lists must be continuous (section 8: 1 to 6; section 9: 1 to 10), and the REST note with its two `curl` lines must still close section 8.

- [ ] **Step 4: Run the checks**

Run: `npm test && npm run test:e2e && npm run typecheck && npm run lint` → PASS. This task changes no code, so a failure here comes from an earlier task. Report it and do not change code to fix it in this task.

- [ ] **Step 5: Commit and push**

```bash
git add DEPLOY.md
git commit -m "docs(deploy): browser smoke test, cutover and known limitations after the frontend switch"
git push -u origin claude/awesome-faraday-jjwsxl
```

---

## After the final review: deploy to Railway and first login (controller only)

The controller runs these steps itself, after the final whole-branch review and its fixes are pushed. They act on the live service, and they need values that exist only in the conversation: the user's Railway token and the project, environment and service IDs. So they are never handed to a subagent.

- The token goes only into the environment of the one command that needs it (`RAILWAY_API_TOKEN=<token> railway up …`). It is never written to a file, a commit, a log or a subagent prompt.
- The IDs stay out of the repo.
- Replace `<scratchpad>`, `<token>`, `<project>`, `<environment>` and `<service>` below with those values.
- Nothing in these steps reads from or writes to Airtable.

`railway ssh` does not work from the controller's container. It connects to `ssh.railway.com` on port 22, which the container's proxy does not pass. It also needs an SSH key registered on the user's Railway account. So the first admin is created with a one-time start command, the way `DEPLOY.md` section 7 describes. Railway's docs recommend the start command for any task that needs the volume, because the pre-deploy command runs without it.

- [ ] **Step 1: Export the pushed branch head**

```bash
S=<scratchpad>; R=/home/user/erp_hero
git -C $R status --short
git -C $R fetch origin claude/awesome-faraday-jjwsxl
test "$(git -C $R rev-parse HEAD)" = "$(git -C $R rev-parse origin/claude/awesome-faraday-jjwsxl)" && echo pushed
rm -rf $S/deploy-fs && mkdir -p $S/deploy-fs && git -C $R archive HEAD | tar -x -C $S/deploy-fs
grep -c -F "const APP_VERSION = 'v6.0';" $S/deploy-fs/index.html
grep -c -E 'api\.airtable\.com|val\.town|_TKP|AIRTABLE_READ_KEY' $S/deploy-fs/index.html
```

Expected: no output from `git status`, then `pushed`, `1` and `0`.

- [ ] **Step 2: Set the one-time start command**

With the Railway MCP tool `update-service` (the project, environment and service IDs), set `startCommand` to:

```text
npm run user:create -- --name "Admin" --admin && npm start
```

The admin is named "Admin" because the user never gave a name for it. The user renames it under Administration → Benutzer.

- [ ] **Step 3: Deploy**

```bash
cd $S/deploy-fs && RAILWAY_API_TOKEN=<token> timeout 900 railway up --ci -p <project> -e <environment> -s <service> > $S/railway-up-fs.log 2>&1; echo "exit=$?"
grep -v 'Login-Key' $S/railway-up-fs.log | tail -5
```

Expected: `exit=0`, and the last lines report a successful deploy.

- [ ] **Step 4: Read the login key**

With the Railway MCP tools, find the new deployment with `list-deployments` (limit 1, status `SUCCESS`). Then read its deploy logs with `get-logs` (type `deploy`, filter `Login-Key`). Expected: exactly one line, `Login-Key (wird nur jetzt angezeigt): <key>`, after `Benutzer angelegt: Admin (<id>) [Admin]`. Keep the key only in the conversation.

If the lines are missing, the start command did not apply. Then restore it (Step 5) and tell the user to run DEPLOY.md section 7 themselves.

- [ ] **Step 5: Restore the start command and deploy again**

Set `startCommand` back to `npm start` with `update-service`. Then deploy exactly as in Step 3, logging to `$S/railway-up-fs2.log`. A restart then never creates another admin.

Expected: `exit=0`. `get-logs` of the newest deployment with the filter `Benutzer angelegt` returns nothing.

- [ ] **Step 6: Check the live site**

```bash
U=https://erp-hero-production.up.railway.app
curl -sS $U/healthz; echo
curl -sS $U/ > $S/live-index.html
grep -c -F "const APP_VERSION = 'v6.0';" $S/live-index.html
grep -c -E 'api\.airtable\.com|val\.town|_TKP|AIRTABLE_READ_KEY' $S/live-index.html
curl -sS $U/sw.js | grep -c -F "const SW_VERSION = 'erp-hero-sw-v2';"
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' $U/loader.html
curl -sS -o /dev/null -w '%{http_code}\n' $U/api/me
```

Expected, in order:
- `{"ok":true}`
- `1`
- `0`
- `1`
- `302 https://erp-hero-production.up.railway.app/`
- `401`

- [ ] **Step 7: Live smoke test in the browser**

This runs the manual check of spec §14 on Railway: log in, create a Mandant and a customer, open and close the customer, and reload. It then deletes both records, so the user starts on an empty database, and logs out.

The browser goes through the container's proxy (`HTTPS_PROXY`), whose CA is already in the browser's trust store. The key stays in the environment (`ERP_KEY`). Real CDNs load here, so the script checks visibility by class names and not by layout. Failed CDN requests are listed but do not count as errors.

Write `$S/live-smoke.mjs`:

```js
// Live smoke test against Railway. Run: ERP_KEY=<key> node live-smoke.mjs
import { createRequire } from 'node:module';

const require = createRequire('/home/user/erp_hero/package.json');
const { chromium } = require('playwright-core');

const URL = 'https://erp-hero-production.up.railway.app/';
const COMPANY = 'Smoke-Test Firma (wird gelöscht)';
const CUSTOMER = 'Smoke-Test Kunde';
const key = process.env.ERP_KEY;
if (!key) throw new Error('ERP_KEY fehlt');

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined,
});
const page = await browser.newPage();
const errors = [];
const failed = new Set();
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('requestfailed', (r) => failed.add(new globalThis.URL(r.url()).host));
page.on('response', (r) => {
  if (r.url().startsWith(URL + 'api/') && r.status() >= 500) errors.push(`HTTP ${r.status()} ${r.url()}`);
});
await page.addInitScript(() => {
  document.addEventListener('securitypolicyviolation', (e) => console.error('CSP ' + e.violatedDirective + ' ' + e.blockedURI));
});
page.on('console', (m) => {
  if (m.type() === 'error' && m.text().startsWith('CSP ')) errors.push(m.text());
});
const run = (body) => page.evaluate(`(async () => { ${body} })()`);
const shown = (sel) => page.waitForSelector(`${sel}:not(.hidden)`, { state: 'attached', timeout: 30000 });
const eventually = async (body) => {
  for (let i = 0; i < 50; i++) {
    if (await run(body)) return;
    await page.waitForTimeout(200);
  }
  throw new Error('Bedingung nicht erfüllt: ' + body);
};
const lockHolder = (id) =>
  `const r = await fetch('/api/data/Customer/${id}', { credentials: 'same-origin' }); return (await r.json()).fields.lock_user_id ?? null;`;
const toast = (text) => page.locator('#toastWrap', { hasText: text }).waitFor({ timeout: 30000 });

try {
  await page.goto(URL);
  await shown('#loginScreen');
  await page.fill('#loginKey', key);
  await page.click('#loginBtn');
  await shown('#appShell');
  console.log('login ok', await run('return APP_VERSION + " " + APP_KEYS.user.name + " admin=" + APP_KEYS.user.is_admin;'));

  await run('await openCompanyModal();');
  await page.fill('#modalBox input[name="name"]', COMPANY);
  await page.click('#modalBox button[type="submit"]');
  await toast('Gespeichert');
  const companyId = await run(`const c = APP_KEYS.companies.find((x) => x.name === ${JSON.stringify(COMPANY)}); setCurrentCompany(c.id); return c.id;`);
  console.log('company ok');

  await run('closeModal(); await openCustomerModal();');
  console.log('customer no', await page.inputValue('#modalBox input[name="customer_no"]'));
  await page.fill('#modalBox input[name="name1"]', CUSTOMER);
  await page.click('#modalBox button[type="submit"]');
  await toast('Gespeichert');
  const customerId = await run(`return (await readData('Customer')).find((r) => r.fields.name1 === ${JSON.stringify(CUSTOMER)}).id;`);
  await run('closeModal();');
  await eventually(`return (await (async () => { ${lockHolder(customerId)} })()) === null;`);
  await run(`await openCustomerModal(${JSON.stringify(customerId)});`);
  console.log('lock taken', (await run(lockHolder(customerId))) === (await run('return APP_KEYS.user._id;')));
  await run('closeModal();');
  await eventually(`return (await (async () => { ${lockHolder(customerId)} })()) === null;`);
  console.log('lock released');

  await page.reload();
  await shown('#appShell');
  console.log('reload ok', await run(`return (await readData('Customer')).some((r) => r.id === ${JSON.stringify(customerId)});`));

  await run(`await deleteData('Customer', ${JSON.stringify(customerId)}); await deleteData('Company', ${JSON.stringify(companyId)});`);
  console.log('cleanup ok', await run(`return [(await fetch('/api/data/Customer/${customerId}')).status, (await fetch('/api/data/Company/${companyId}')).status].join(' ');`));

  await run('logout();');
  await shown('#loginScreen');
  console.log('logout ok', await run(`return (await fetch('/api/me')).status;`));
} finally {
  console.log('errors', errors.length, errors.join(' | ').slice(0, 600));
  console.log('failed hosts', [...failed].join(', '));
  await browser.close();
}
```

Run: `cd $S && ERP_KEY=<key from Step 4> node live-smoke.mjs`

Expected:
- `login ok v6.0 Admin admin=true`
- `company ok`
- `customer no K-1001`
- `lock taken true`
- `lock released`
- `reload ok true`
- `cleanup ok 404 404`
- `logout ok 401`
- `errors 0`

`failed hosts` may list CDN hosts that the container's proxy blocks; that is not an app error. A failure anywhere else is a real bug: find its root cause, fix it on the branch with a test, push, and deploy again (Steps 1 to 6, without the start command).

- [ ] **Step 8: Clean up the scratch copies**

Delete the local copies that held the embedded token during planning and implementation (every `work*.html`, `w*-*.js` and `orig.html` in the scratchpad). Delete `$S/deploy-fs`, `$S/live-index.html` and both deploy logs.

- [ ] **Step 9: Report to the user**

The report says, briefly:
- the URL, and that the site serves v6.0;
- the admin's login key from Step 4, with the advice to rename the admin and give it a new key right after the first login (DEPLOY.md section 8, step 6), because the key also sits in Railway's deploy log;
- that the smoke test ran and left no data behind;
- the manual checks of DEPLOY.md section 8 (PDF, quotes, KI-Angebot, Freshdesk, attachments, Freshsales, Mailchimp) and the known limitations of section 10;
- that `main` still serves the old app on GitHub Pages until the branch is merged, and that the old keys should be revoked (the note at the top of DEPLOY.md).

It ends by asking whether to open the PR. The controller never opens one without that answer.
