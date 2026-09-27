# ERP Hero Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Node/TypeScript backend on Railway that replaces the Val.town proxy and all direct Airtable access. It stores ERP Hero's data in SQLite on a Railway volume, serves the unchanged `index.html` from the same origin, and includes a read-only Airtable importer for cutover.

**Architecture:** One Hono app (single instance) with cookie sessions. It exposes an Airtable-shaped data API over one SQLite table per ERP table (JSON `fields` column), and third-party routes that mirror the old proxy's paths under `/api`. All writes go through an in-process write queue, which makes document numbering and locks race-free. All outbound HTTP goes through an injected `fetch`, so every test runs offline.

**Tech Stack:** Node 22, TypeScript 6.0, Hono 4.13 + @hono/node-server 2.1, @libsql/client 0.18 (local SQLite file), zod 4, tar 7, vitest 5, eslint 10 + typescript-eslint 8.

**Spec:** `docs/superpowers/specs/2026-09-25-erp-hero-backend-design.md` (read it first; this plan argues from it).

> **How this plan was checked:** every code block below was run while writing the plan. The
> whole plan was replayed step by step into a fresh clone of this branch:
> - each "verify it fails" step failed;
> - each "verify it passes" step passed with the stated test counts (157 in total);
> - typecheck and lint were clean after every task;
> - every commit left a clean tree.
>
> If a step does not behave as stated, stop and investigate (superpowers:systematic-debugging)
> instead of changing tests to fit.

## Global Constraints

- Node 22: `package.json` `"engines": { "node": ">=22 <23" }`, `.nvmrc` = `22`. ESM only (`"type": "module"`), relative imports end in `.js`, type-only imports use `import type` (`verbatimModuleSyntax`).
- **Exact dependency versions:**
  - runtime: `hono@4.13.9`, `@hono/node-server@2.1.1`, `@libsql/client@0.18.0`, `zod@4.6.5`, `tar@7.5.22`;
  - dev: `typescript@6.0.3`, `vitest@5.0.2`, `tsx@4.23.15`, `@types/node@22.20.4`, `eslint@10.11.0`, `typescript-eslint@8.70.1`, `@eslint/js@10.0.1`.
  - Do not use TypeScript 7: typescript-eslint supports `<6.1.0`.
- **Do not touch** `index.html`, `loader.html`, `loader-admin.html` or `sw.js`. Never push to `main`. Push only to `claude/confident-pascal-b6b330`, and ask before opening a PR.
- **No secrets in the repo, ever.** `.env` is git-ignored; `.env.example` has placeholders only. Never use the Airtable token embedded in `index.html`.
- **No live calls** to Airtable, Freshdesk, Freshsales, Mailchimp or Anthropic.
  - All upstream HTTP goes through `deps.fetch` (the importer: `AirtableReader`'s `fetch`).
  - Tests use `FakeFetch`, and `test/setup.ts` makes any real `fetch` throw.
- **SQL:** table names come only from `TABLE_NAMES` and are always double-quoted (`"Order"` is a keyword). All writes go through `db.write(...)`; there are no ad-hoc write transactions.
- **Errors:** our own errors are `{ error: { type, message } }` with German messages. Upstream (Freshdesk/Freshsales/Mailchimp/Anthropic) status and body pass through unchanged. Never return stack traces; never log bodies, cookies or keys.
- **Secrets never leave the server:** login-key hashes, Freshdesk keys and Mailchimp keys live only in `user_secrets` / `company_secrets`, never in record `fields`.
- **Company separation is a working context (spec D8):** all logged-in users may read and write business tables. Admin-only: `User`/`Company` writes, `AiUsageLog` reads, settings writes, `/api/admin/*`, session revocation.
- **Commits** end with these trailers (already included in every commit step):
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01FVrKcG5sQkpYKqUZGYjujR`.

## Review Focus

Inputs and conditions a real user will hit, each with a test pinned in the owning task:

1. **Freshdesk search queries with encoded quotes, colons and spaces** (e.g. `query="(group_id:123) AND (status:2 OR status:3)"`) must reach Freshdesk byte-for-byte. Otherwise the Anfragen list silently shows wrong tickets.
   - Pinned in Task 12: *passes the search query string through byte-for-byte*.
2. **German umlauts and special characters in file names** (`Angebot Müller & Söhne.pdf`) must upload, download and show correctly (RFC 5987 `filename*`). Path tricks (`../../etc/passwd`) must be neutralised.
   - Pinned in Task 10: *…umlaut-safe headers* and *…sanitized name*.
3. **Sorting and filtering German data:** `Ärzte AG` sorts next to `A…` rather than after `Z`, case-insensitively, with empty values last. Filter values containing apostrophes (`O'Neil`) work.
   - Pinned in Task 4: *sorts German strings with umlauts…* and *parses AND with escaped quotes…*.
   - Pinned in Task 7: *supports the restricted formula…*.
4. **Oversized payloads** answer a clean `413 PAYLOAD_TOO_LARGE` JSON instead of crashing or hanging. The limits are data 5 MB, uploads 5 MB, Freshdesk JSON 5 MB, and Anthropic 32 MB. A 20 MB image request still succeeds.
   - Pinned in Tasks 7, 10, 12 and 13.
5. **A session that expires, or a user deactivated mid-work,** gets `401 UNAUTHENTICATED` JSON and a cleared cookie on the next click, never a 500. Admin rights removed mid-session apply immediately.
   - Pinned in Task 6: *expires short sessions…* and *applies deactivation and admin changes on the very next request*.

## File Structure

| Path | Responsibility |
|---|---|
| `package.json`, `tsconfig*.json`, `vitest.config.ts`, `eslint.config.js`, `.nvmrc` | tooling |
| `server/config.ts` | env parsing and validation, attachment allowlist parsing |
| `server/types.ts` | `AppEnv`, `SessionUser`, `AirtableRecord` |
| `server/deps.ts` | `AppDeps` and `buildDeps()`, the single place services are constructed |
| `server/app.ts` | `createApp(deps)`: middleware order and route mounting |
| `server/main.ts` | entry point: config → activation → DB → migrations → serve |
| `server/activation.ts` | swap in an imported database at startup |
| `server/util/{errors,ids,mutex}.ts` | `ApiError`, Airtable-style ids and login keys, write queue |
| `server/db/{database,migrations}.ts` | libsql client wrapper (`query`, queued `write`), schema |
| `server/data/tables.ts` | the 30 tables, number formats, lockable tables, attachment fields |
| `server/data/fields.ts` | Airtable field semantics, secret detection, restricted formula, sort |
| `server/data/records.ts` | `RecordStore`: storage of Airtable-shaped records |
| `server/data/{permissions,public}.ts` | who may read/write what; the only way records leave the server |
| `server/data/routes.ts` | `/api/data/*` CRUD and `/api/schema/*` no-ops |
| `server/data/numbers.ts` | document numbers (assign on save, peek, duplicate guard) |
| `server/data/locks.ts` | advisory record locks |
| `server/data/files.ts` | file storage, upload/download routes, attachment-field validation |
| `server/secrets/{crypto,store}.ts` | AES-256-GCM, `SecretStore` for login-key hashes and service keys |
| `server/auth/*.ts` | scrypt, sessions, rate limit, middleware, `/api/auth` & co. |
| `server/settings/*.ts` | allowlisted non-secret settings |
| `server/admin/{routes,backup}.ts` | admin secret endpoints, backup download |
| `server/proxy/*.ts` | allowlist matcher, passthrough, Freshdesk/Freshsales/Mailchimp/Anthropic/attachment routes |
| `server/import/{airtable,importer,report}.ts` | read-only Airtable reader, importer, report |
| `server/cli/*.ts` | `user:create`, `db:activate`, `import:airtable` |
| `test/helpers/{fakeFetch,context}.ts` | fake upstreams; in-process app on a temp DB with a controllable clock |
| `railway.json`, `.env.example`, `DEPLOY.md` | deployment |

## Tasks

### Task 1: Tooling, test harness and configuration

**Files:**
- Create: package.json, package-lock.json (generated), tsconfig.json, tsconfig.build.json, vitest.config.ts, eslint.config.js, .nvmrc
- Modify: .gitignore
- Create: server/config.ts
- Create: test/setup.ts
- Test: test/config.test.ts

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `loadConfig(env: NodeJS.ProcessEnv, rootDir: string): Config`; `interface Config { nodeEnv; isProduction; port; publicOrigin; dataDir; rootDir; secretsKey: Buffer; anthropicApiKey; freshdeskDomain; freshdeskApiKey; freshsalesSubdomain; freshsalesApiKey; attachmentAllow: AllowEntry[]; logLevel }`; `interface AllowEntry { host: string; pathPrefix: string }`; `parseAttachmentAllow(raw, freshdeskDomain): AllowEntry[]`; `normalizeFreshdeskDomain`, `normalizeFreshsalesSubdomain`, `defaultAttachmentAllow`. npm scripts `test`, `typecheck`, `lint`, `build`, `start`, `dev`, `user:create`, `db:activate`, `import:airtable`.

- [ ] **Step 1: Create `package.json` with pinned dependencies and install**

TypeScript is pinned to 6.0.x on purpose: typescript-eslint 8.70 supports TypeScript `>=4.8.4 <6.1.0` (TypeScript 7 exists but is not supported yet).

Create `package.json`:

```json
{
  "name": "erp-hero-backend",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22 <23"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/server/main.js",
    "dev": "tsx watch server/main.ts",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json",
    "lint": "eslint server test vitest.config.ts",
    "user:create": "node dist/server/cli/user-create.js",
    "db:activate": "node dist/server/cli/db-activate.js",
    "import:airtable": "node dist/server/cli/import-airtable.js"
  },
  "dependencies": {
    "@hono/node-server": "^2.1.1",
    "@libsql/client": "^0.18.0",
    "hono": "^4.13.9",
    "tar": "^7.5.22",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@eslint/js": "^10.0.1",
    "@types/node": "^22.20.4",
    "eslint": "^10.11.0",
    "tsx": "^4.23.15",
    "typescript": "^6.0.3",
    "typescript-eslint": "^8.70.1",
    "vitest": "^5.0.2"
  }
}
```

Run:

```bash
npm install
```

Expected: installs without errors and writes `package-lock.json`. `node --version` must print v22.x.


- [ ] **Step 2: Add TypeScript, vitest and eslint configuration**

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023", "DOM"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": ".",
    "noEmit": true
  },
  "include": ["server", "test", "vitest.config.ts"]
}
```

`tsconfig.json` is used for type-checking only (`noEmit`). The build uses:

Create `tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false
  },
  "include": ["server"]
}
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    testTimeout: 20_000,
  },
});
```

Create `eslint.config.js`:

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
);
```

Create `.nvmrc`:

```
22
```

Replace `.gitignore` (keep the existing `.superpowers/` entry):

Replace the whole content of `.gitignore` with:

```
# Superpowers skill working files (brainstorm server session tokens, plan workspaces)
.superpowers/

# Backend
node_modules/
dist/
.data/
.env
.env.*
!.env.example
*.log
```


- [ ] **Step 3: Add the network guard used by every test**

All upstream HTTP in the server goes through an injected `fetch`. This setup file makes any accidental real network call fail the test.

Create `test/setup.ts`:

```ts
import { beforeEach } from 'vitest';

// Any real network call from a test is a bug: all upstream HTTP must go through FakeFetch.
beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    throw new Error(`Live network access is disabled in tests (attempted: ${String(input)})`);
  }) as typeof fetch;
});
```


- [ ] **Step 4: Write the failing config test**

Create `test/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig, parseAttachmentAllow } from '../server/config.js';

const KEY = Buffer.alloc(32, 1).toString('base64');
const base = { PUBLIC_ORIGIN: 'https://erp.example.com/', DATA_DIR: '/data', SECRETS_KEY: KEY };

describe('loadConfig', () => {
  it('parses a minimal valid environment with defaults', () => {
    const c = loadConfig(base, '/repo');
    expect(c.nodeEnv).toBe('development');
    expect(c.isProduction).toBe(false);
    expect(c.port).toBe(3000);
    expect(c.publicOrigin).toBe('https://erp.example.com');
    expect(c.dataDir).toBe('/data');
    expect(c.rootDir).toBe('/repo');
    expect(c.secretsKey.length).toBe(32);
    expect(c.anthropicApiKey).toBeUndefined();
    expect(c.logLevel).toBe('info');
  });

  it('reads PORT and NODE_ENV', () => {
    const c = loadConfig({ ...base, PORT: '8080', NODE_ENV: 'production' }, '/repo');
    expect(c.port).toBe(8080);
    expect(c.isProduction).toBe(true);
  });

  it('treats empty optional variables as unset', () => {
    const c = loadConfig({ ...base, FRESHDESK_API_KEY: '', ANTHROPIC_API_KEY: '   ' }, '/repo');
    expect(c.freshdeskApiKey).toBeUndefined();
    expect(c.anthropicApiKey).toBeUndefined();
  });

  it('normalizes Freshdesk and Freshsales hosts', () => {
    const c = loadConfig(
      { ...base, FRESHDESK_DOMAIN: 'https://FLPliftparts.freshdesk.com/', FRESHSALES_SUBDOMAIN: 'gilt.freshworks.com/crm' },
      '/repo',
    );
    expect(c.freshdeskDomain).toBe('flpliftparts');
    expect(c.freshsalesSubdomain).toBe('gilt');
  });

  it('rejects a missing PUBLIC_ORIGIN and a wrong-sized SECRETS_KEY with a readable message', () => {
    expect(() => loadConfig({ DATA_DIR: '/data', SECRETS_KEY: 'c2hvcnQ=' }, '/repo')).toThrow(
      /PUBLIC_ORIGIN[\s\S]*SECRETS_KEY must be 32 random bytes/,
    );
  });

  it('builds the default attachment allowlist from the Freshdesk domain', () => {
    const c = loadConfig({ ...base, FRESHDESK_DOMAIN: 'flpliftparts' }, '/repo');
    expect(c.attachmentAllow).toEqual([
      { host: 'flpliftparts.freshdesk.com', pathPrefix: '/' },
      { host: 'flpliftparts.attachments.freshdesk.com', pathPrefix: '/' },
      { host: 'attachment.freshdesk.com', pathPrefix: '/' },
      { host: 'attachment.freshdeskusercontent.com', pathPrefix: '/' },
      { host: 's3.amazonaws.com', pathPrefix: '/cdn.freshdesk.com/' },
      { host: 's3.eu-central-1.amazonaws.com', pathPrefix: '/euc-cdn.freshdesk.com/' },
    ]);
  });

  it('lets ATTACHMENT_PROXY_ALLOW override the default list', () => {
    expect(parseAttachmentAllow('Files.Example.com, s3.amazonaws.com/bucket/', 'x')).toEqual([
      { host: 'files.example.com', pathPrefix: '/' },
      { host: 's3.amazonaws.com', pathPrefix: '/bucket/' },
    ]);
  });
});
```


- [ ] **Step 5: Run it to verify it fails**

Run:

```bash
npx vitest run test/config.test.ts
```

Expected: FAIL — `../server/config.js` cannot be resolved (module does not exist yet).


- [ ] **Step 6: Implement `server/config.ts`**

Create `server/config.ts`:

```ts
import { z } from 'zod';

export interface AllowEntry {
  host: string;
  pathPrefix: string;
}

export interface Config {
  nodeEnv: 'development' | 'production' | 'test';
  isProduction: boolean;
  port: number;
  publicOrigin: string;
  dataDir: string;
  rootDir: string;
  secretsKey: Buffer;
  anthropicApiKey: string | undefined;
  freshdeskDomain: string | undefined;
  freshdeskApiKey: string | undefined;
  freshsalesSubdomain: string | undefined;
  freshsalesApiKey: string | undefined;
  attachmentAllow: AllowEntry[];
  logLevel: 'info' | 'debug';
}

const optionalString = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().trim().optional(),
);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_ORIGIN: z.url(),
  DATA_DIR: z.string().trim().min(1),
  SECRETS_KEY: z
    .string()
    .trim()
    .refine((v) => Buffer.from(v, 'base64').length === 32, {
      message: 'SECRETS_KEY must be 32 random bytes, base64-encoded',
    }),
  ANTHROPIC_API_KEY: optionalString,
  FRESHDESK_DOMAIN: optionalString,
  FRESHDESK_API_KEY: optionalString,
  FRESHSALES_SUBDOMAIN: optionalString,
  FRESHSALES_API_KEY: optionalString,
  ATTACHMENT_PROXY_ALLOW: optionalString,
  LOG_LEVEL: z.enum(['info', 'debug']).default('info'),
});

export function normalizeFreshdeskDomain(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const clean = raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\.freshdesk\.com\/?$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  return clean || undefined;
}

export function normalizeFreshsalesSubdomain(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const clean = raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\.freshworks\.com.*$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  return clean || undefined;
}

export function defaultAttachmentAllow(freshdeskDomain: string | undefined): string[] {
  const list = [
    'attachment.freshdesk.com',
    'attachment.freshdeskusercontent.com',
    's3.amazonaws.com/cdn.freshdesk.com/',
    's3.eu-central-1.amazonaws.com/euc-cdn.freshdesk.com/',
  ];
  if (freshdeskDomain) {
    list.unshift(`${freshdeskDomain}.freshdesk.com`, `${freshdeskDomain}.attachments.freshdesk.com`);
  }
  return list;
}

export function parseAttachmentAllow(raw: string | undefined, freshdeskDomain: string | undefined): AllowEntry[] {
  const entries = raw
    ? raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : defaultAttachmentAllow(freshdeskDomain);
  return entries.map((entry) => {
    const slash = entry.indexOf('/');
    if (slash < 0) return { host: entry.toLowerCase(), pathPrefix: '/' };
    return { host: entry.slice(0, slash).toLowerCase(), pathPrefix: entry.slice(slash) };
  });
}

export function loadConfig(env: NodeJS.ProcessEnv, rootDir: string): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new Error(`Invalid configuration:\n  ${problems.join('\n  ')}`);
  }
  const e = parsed.data;
  const freshdeskDomain = normalizeFreshdeskDomain(e.FRESHDESK_DOMAIN);
  return {
    nodeEnv: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    port: e.PORT,
    publicOrigin: new URL(e.PUBLIC_ORIGIN).origin,
    dataDir: e.DATA_DIR,
    rootDir,
    secretsKey: Buffer.from(e.SECRETS_KEY, 'base64'),
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    freshdeskDomain,
    freshdeskApiKey: e.FRESHDESK_API_KEY,
    freshsalesSubdomain: normalizeFreshsalesSubdomain(e.FRESHSALES_SUBDOMAIN),
    freshsalesApiKey: e.FRESHSALES_API_KEY,
    attachmentAllow: parseAttachmentAllow(e.ATTACHMENT_PROXY_ALLOW, freshdeskDomain),
    logLevel: e.LOG_LEVEL,
  };
}
```


- [ ] **Step 7: Run the test to verify it passes**

Run:

```bash
npx vitest run test/config.test.ts
```

Expected: 7 tests pass.


- [ ] **Step 8: Typecheck and lint**

Run:

```bash
npm run typecheck && npm run lint
```

Expected: both exit 0 with no output from eslint.


- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.build.json vitest.config.ts eslint.config.js .nvmrc .gitignore test/setup.ts test/config.test.ts server/config.ts
git commit -F - <<'EOF'
chore(server): add TypeScript/vitest/eslint tooling and config loader

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FVrKcG5sQkpYKqUZGYjujR
EOF
```


---

### Task 2: Database layer: SQLite, write queue, migrations, table registry

**Files:**
- Create: server/util/mutex.ts, server/util/ids.ts
- Create: server/data/tables.ts
- Create: server/db/database.ts, server/db/migrations.ts
- Test: test/db.test.ts

**Interfaces:**
- Consumes: nothing.
- Produces: `openDatabase(filePath): Promise<Database>`; `interface Database { client: Client; query(sql, args?): Promise<Row[]>; write<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>; close(): void }`; `interface Executor { execute(stmt: InStatement): Promise<ResultSet> }`; `runMigrations(db)`; `TABLE_NAMES`, `type TableName`, `isTableName`, `NUMBER_SPECS`, `NumberSpec`, `numberSpecForTable`, `numberSpecForType`, `LOCKABLE_TABLES`, `ATTACHMENT_FIELDS`, `attachmentFieldRule`; `newRecordId`, `newAttachmentId`, `newLoginKey`, `newSessionToken`, `isRecordId`; `class Mutex { run(fn) }`.

- [ ] **Step 1: Write the failing test**

Create `test/db.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '../server/db/database.js';
import { runMigrations } from '../server/db/migrations.js';
import { TABLE_NAMES } from '../server/data/tables.js';
import { isRecordId, newAttachmentId, newLoginKey, newRecordId, newSessionToken } from '../server/util/ids.js';
import { Mutex } from '../server/util/mutex.js';

let dir: string;
let db: Database;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'erp-db-'));
  db = await openDatabase(path.join(dir, 'erp.db'));
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('migrations', () => {
  it('creates all 30 ERP tables and the system tables, and is idempotent', async () => {
    await runMigrations(db);
    await runMigrations(db);
    const names = (await db.query("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => String(r.name));
    for (const t of TABLE_NAMES) expect(names).toContain(t);
    for (const t of ['sessions', 'user_secrets', 'company_secrets', 'settings', 'files', 'schema_migrations']) {
      expect(names).toContain(t);
    }
    expect(await db.query('SELECT version FROM schema_migrations')).toHaveLength(1);
  });

  it('uses WAL journal mode', async () => {
    const rows = await db.query('PRAGMA journal_mode');
    expect(rows[0]?.journal_mode).toBe('wal');
  });
});

describe('write transactions', () => {
  it('serializes concurrent writes instead of failing with SQLITE_BUSY', async () => {
    await runMigrations(db);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        db.write(async (tx) => {
          const rs = await tx.execute('SELECT count(*) AS n FROM settings');
          const n = Number(rs.rows[0]?.n);
          await tx.execute({
            sql: 'INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)',
            args: [`k${i}`, String(n), 'now', 'test'],
          });
        }),
      ),
    );
    const values = (await db.query('SELECT value FROM settings')).map((r) => Number(r.value)).sort((a, b) => a - b);
    expect(values).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it('rolls back when the function throws', async () => {
    await runMigrations(db);
    await expect(
      db.write(async (tx) => {
        await tx.execute("INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('a', 'b', 'c', 'd')");
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await db.query('SELECT * FROM settings')).toHaveLength(0);
  });
});

describe('ids and mutex', () => {
  it('generates Airtable-shaped ids and 24-char login keys', () => {
    expect(isRecordId(newRecordId())).toBe(true);
    expect(newAttachmentId()).toMatch(/^att[A-Za-z0-9]{14}$/);
    expect(newLoginKey()).toMatch(/^[a-z0-9]{24}$/);
    expect(newSessionToken().length).toBeGreaterThanOrEqual(43);
    expect(isRecordId('recABC')).toBe(false);
  });

  it('runs tasks in order even when an earlier one fails', async () => {
    const m = new Mutex();
    const order: number[] = [];
    const a = m.run(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
      throw new Error('x');
    });
    const b = m.run(async () => {
      order.push(2);
    });
    await expect(a).rejects.toThrow('x');
    await b;
    expect(order).toEqual([1, 2]);
  });
});
```


- [ ] **Step 2: Run it to verify it fails**

Run:

```bash
npx vitest run test/db.test.ts
```

Expected: FAIL — the imported modules do not exist yet.


- [ ] **Step 3: Implement the mutex and id helpers**

`Mutex` is the in-process write queue. libsql cannot hold two write transactions open at once (a second one fails with `SQLITE_BUSY`), and the server runs as a single instance, so queueing writes in-process makes read-then-write sequences (document numbers, locks) race-free.

Create `server/util/mutex.ts`:

```ts
/** Runs async functions strictly one after another (FIFO). */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
```

Create `server/util/ids.ts`:

```ts
import { randomBytes, randomInt } from 'node:crypto';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const LOWER_ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomString(alphabet: string, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet.charAt(randomInt(alphabet.length));
  return out;
}

/** Airtable-style record id: "rec" + 14 alphanumerics. */
export const newRecordId = (): string => 'rec' + randomString(ALNUM, 14);
/** Airtable-style attachment id: "att" + 14 alphanumerics. */
export const newAttachmentId = (): string => 'att' + randomString(ALNUM, 14);
/** Login key in the format the old app generated: 24 chars [a-z0-9], unbiased. */
export const newLoginKey = (): string => randomString(LOWER_ALNUM, 24);
/** Opaque session token for the cookie. */
export const newSessionToken = (): string => randomBytes(32).toString('base64url');

export const isRecordId = (value: unknown): value is string =>
  typeof value === 'string' && /^rec[A-Za-z0-9]{14}$/.test(value);
```


- [ ] **Step 4: Implement the table registry**

Create `server/data/tables.ts`:

```ts
export const TABLE_NAMES = [
  'Customer',
  'Contact',
  'Article',
  'Quote',
  'QuoteItem',
  'QuoteBundle',
  'Order',
  'OrderItem',
  'Address',
  'Supplier',
  'Textemplate',
  'Attachment',
  'Layout',
  'Invoice',
  'InvoiceItem',
  'ArticleSupplier',
  'SupplierOrder',
  'SupplierOrderItem',
  'DeliveryNote',
  'DeliveryNoteItem',
  'CustomField',
  'Inquiry',
  'PaymentTerm',
  'DeliveryTerm',
  'AiUsageLog',
  'AiQuoteChatLearning',
  'Manufacturer',
  'Category',
  'Company',
  'User',
] as const;

export type TableName = (typeof TABLE_NAMES)[number];

const TABLE_SET: ReadonlySet<string> = new Set(TABLE_NAMES);
export const isTableName = (value: string): value is TableName => TABLE_SET.has(value);

export type NumberType =
  | 'customer'
  | 'supplier'
  | 'article'
  | 'inquiry'
  | 'quote'
  | 'order'
  | 'purchase'
  | 'delivery'
  | 'invoice';

export interface NumberSpec {
  type: NumberType;
  table: TableName;
  field: string;
  prefix: string;
  /** The first number handed out is floor + 1. */
  floor: number;
}

export const NUMBER_SPECS: readonly NumberSpec[] = [
  { type: 'customer', table: 'Customer', field: 'customer_no', prefix: 'K-', floor: 1000 },
  { type: 'supplier', table: 'Supplier', field: 'supplier_no', prefix: 'L-', floor: 1000 },
  { type: 'article', table: 'Article', field: 'article_no', prefix: 'A-', floor: 10000 },
  { type: 'inquiry', table: 'Inquiry', field: 'inquiry_no', prefix: 'AN-', floor: 1000 },
  { type: 'quote', table: 'Quote', field: 'quote_no', prefix: 'Q-', floor: 1000 },
  { type: 'order', table: 'Order', field: 'order_no', prefix: 'AB-', floor: 1000 },
  { type: 'purchase', table: 'SupplierOrder', field: 'purchase_no', prefix: 'B-', floor: 1000 },
  { type: 'delivery', table: 'DeliveryNote', field: 'delivery_no', prefix: 'L-', floor: 1000 },
  { type: 'invoice', table: 'Invoice', field: 'invoice_no', prefix: 'R-', floor: 1000 },
];

export const numberSpecForTable = (table: TableName): NumberSpec | undefined =>
  NUMBER_SPECS.find((s) => s.table === table);
export const numberSpecForType = (type: string): NumberSpec | undefined => NUMBER_SPECS.find((s) => s.type === type);

export const LOCKABLE_TABLES: ReadonlySet<TableName> = new Set<TableName>([
  'Customer',
  'Supplier',
  'Article',
  'Inquiry',
  'Quote',
  'Order',
  'SupplierOrder',
  'DeliveryNote',
  'Invoice',
]);

export interface AttachmentFieldRule {
  adminOnly: boolean;
}

/** Fields that hold uploaded files, keyed "Table.field". */
export const ATTACHMENT_FIELDS: Readonly<Record<string, AttachmentFieldRule>> = {
  'Company.logo': { adminOnly: true },
  'Company.secondary_logo': { adminOnly: true },
  'Company.sub_logo': { adminOnly: true },
  'Attachment.file': { adminOnly: false },
};

export const attachmentFieldRule = (table: TableName, field: string): AttachmentFieldRule | undefined =>
  ATTACHMENT_FIELDS[`${table}.${field}`];
```


- [ ] **Step 5: Implement the database wrapper and migrations**

Create `server/db/database.ts`:

```ts
import { createClient, type Client, type InArgs, type InStatement, type ResultSet, type Row, type Transaction } from '@libsql/client';
import { Mutex } from '../util/mutex.js';

/** Anything that can run a statement: the client or an open transaction. */
export interface Executor {
  execute(stmt: InStatement): Promise<ResultSet>;
}

export interface Database {
  readonly client: Client;
  /** Read query on committed data. */
  query(sql: string, args?: InArgs): Promise<Row[]>;
  /**
   * Runs fn inside one SQLite write transaction. Write transactions are queued
   * in-process, so they never overlap (libsql cannot hold two open at once).
   */
  write<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  close(): void;
}

export async function openDatabase(filePath: string): Promise<Database> {
  const client = createClient({ url: `file:${filePath}` });
  await client.execute('PRAGMA journal_mode = WAL');
  await client.execute('PRAGMA busy_timeout = 5000');
  const mutex = new Mutex();

  return {
    client,
    async query(sql, args = []) {
      const rs = await client.execute({ sql, args });
      return rs.rows;
    },
    write(fn) {
      return mutex.run(async () => {
        // The transaction takes over the client's current connection, so set the
        // busy timeout on it first (matters only if a CLI writes at the same time).
        await client.execute('PRAGMA busy_timeout = 5000');
        const tx = await client.transaction('write');
        try {
          const result = await fn(tx);
          await tx.commit();
          return result;
        } catch (err) {
          await tx.rollback().catch(() => undefined);
          throw err;
        } finally {
          tx.close();
        }
      });
    },
    close() {
      client.close();
    },
  };
}
```

Create `server/db/migrations.ts`:

```ts
import { TABLE_NAMES } from '../data/tables.js';
import type { Database } from './database.js';

interface Migration {
  version: number;
  statements: string[];
}

const erpTable = (name: string): string =>
  `CREATE TABLE IF NOT EXISTS "${name}" (
     id TEXT PRIMARY KEY,
     created_time TEXT NOT NULL,
     updated_time TEXT NOT NULL,
     fields TEXT NOT NULL CHECK (json_valid(fields))
   )`;

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    statements: [
      ...TABLE_NAMES.map(erpTable),
      `CREATE TABLE IF NOT EXISTS sessions (
         token_hash TEXT PRIMARY KEY,
         user_id TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         expires_at INTEGER NOT NULL,
         long_lived INTEGER NOT NULL,
         user_agent TEXT NOT NULL DEFAULT ''
       )`,
      'CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id)',
      `CREATE TABLE IF NOT EXISTS user_secrets (
         user_id TEXT PRIMARY KEY,
         api_key_hash TEXT,
         freshdesk_api_key_enc TEXT,
         freshdesk_keys_enc TEXT
       )`,
      `CREATE TABLE IF NOT EXISTS company_secrets (
         company_id TEXT PRIMARY KEY,
         mailchimp_api_key_enc TEXT
       )`,
      `CREATE TABLE IF NOT EXISTS settings (
         key TEXT PRIMARY KEY,
         value TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         updated_by TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS files (
         id TEXT PRIMARY KEY,
         table_name TEXT NOT NULL,
         record_id TEXT NOT NULL,
         field TEXT NOT NULL,
         filename TEXT NOT NULL,
         content_type TEXT NOT NULL,
         size INTEGER NOT NULL,
         sha256 TEXT NOT NULL,
         path TEXT NOT NULL,
         created_at TEXT NOT NULL,
         created_by TEXT NOT NULL
       )`,
    ],
  },
];

export async function runMigrations(db: Database): Promise<void> {
  await db.client.execute(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const applied = new Set((await db.query('SELECT version FROM schema_migrations')).map((r) => Number(r.version)));
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    await db.write(async (tx) => {
      for (const sql of migration.statements) await tx.execute(sql);
      await tx.execute({
        sql: 'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
        args: [migration.version, new Date().toISOString()],
      });
    });
  }
}
```


- [ ] **Step 6: Run the test to verify it passes**

Run:

```bash
npx vitest run test/db.test.ts
```

Expected: 6 tests pass, including 20 concurrent writes without `SQLITE_BUSY`.


- [ ] **Step 7: Typecheck and lint**

Run:

```bash
npm run typecheck && npm run lint
```


- [ ] **Step 8: Commit**

```bash
git add server/util server/data/tables.ts server/db test/db.test.ts
git commit -F - <<'EOF'
feat(server): add SQLite database layer, write queue and table registry

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FVrKcG5sQkpYKqUZGYjujR
EOF
```


---

### Task 3: HTTP skeleton: errors, request log, security headers, static files, /healthz

**Files:**
- Create: server/types.ts, server/util/errors.ts
- Create: server/http/logger.ts, server/http/requestContext.ts, server/http/body.ts, server/http/securityHeaders.ts, server/http/static.ts, server/http/health.ts
- Create: server/deps.ts, server/app.ts, server/main.ts
- Create: test/helpers/fakeFetch.ts, test/helpers/context.ts
- Test: test/http.test.ts

**Interfaces:**
- Consumes: `loadConfig`, `Config`, `AllowEntry` (Task 1); `openDatabase`, `Database`, `runMigrations` (Task 2).
- Produces: `type AppEnv` (Hono variables `requestId`, `user: SessionUser`, `sessionTokenHash`); `interface SessionUser { id; name; role; isAdmin; allowedCompanies }`; `interface AirtableRecord { id; createdTime; fields }`; `class ApiError(type: ErrorType, message, status?)`, `jsonError(c, type, message, status?)`; `interface Logger { info; error }`, `jsonLogger`; `limit(maxBytes)`, `MB`, `readJsonBody(c)`, `isPlainObject(v)`; `buildCsp`, `securityHeaders`; `staticRoutes(rootDir)`; `healthRoutes(db)`; `buildDeps(o): AppDeps` with `FetchFn`, `Timeouts { upstreamMs; anthropicMs }`; `createApp(deps)`. Test helpers: `FakeFetch` (`.on(method, urlPrefix, responder)`, `.calls`, `.fetch`), `jsonResponse`, `hang`; `createTestContext({ env?, timeouts? })` → `{ app, deps, fake, logs, dataDir, clock, req(path, {method, body, cookie, headers}), close() }`, `testEnv`, `ROOT_DIR`, `TEST_ORIGIN`, `TEST_SECRETS_KEY`.

- [ ] **Step 1: Create the test helpers**

`FakeFetch` stands in for every upstream service. `createTestContext` builds the whole app on a temp-dir database with a controllable clock.

Create `test/helpers/fakeFetch.ts`:

```ts
export interface FakeCall {
  method: string;
  url: string;
  headers: Headers;
  body: Buffer | null;
  signal: AbortSignal | null;
}

type Responder = (call: FakeCall) => Response | Promise<Response>;

/** Scriptable stand-in for fetch: records every call, answers from registered routes. */
export class FakeFetch {
  readonly calls: FakeCall[] = [];
  private readonly routes: { method: string; prefix: string; respond: Responder }[] = [];

  on(method: string, urlPrefix: string, respond: Responder): this {
    this.routes.push({ method, prefix: urlPrefix, respond });
    return this;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : null;
    const call: FakeCall = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body,
      signal: init?.signal ?? null,
    };
    this.calls.push(call);
    const route = this.routes.find((r) => r.method === call.method && call.url.startsWith(r.prefix));
    if (!route) throw new Error(`Unexpected upstream call: ${call.method} ${call.url}`);
    return route.respond(call);
  };
}

export const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** Never settles until the request is aborted (for timeout tests). */
export const hang = (call: FakeCall): Promise<Response> =>
  new Promise((_resolve, reject) => {
    call.signal?.addEventListener('abort', () => reject(call.signal?.reason));
  });
```

Create `test/helpers/context.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';
import { createApp } from '../../server/app.js';
import { loadConfig } from '../../server/config.js';
import { openDatabase } from '../../server/db/database.js';
import { runMigrations } from '../../server/db/migrations.js';
import { buildDeps, type AppDeps, type Timeouts } from '../../server/deps.js';
import type { Logger } from '../../server/http/logger.js';
import type { AppEnv } from '../../server/types.js';
import { FakeFetch } from './fakeFetch.js';

export const ROOT_DIR = fileURLToPath(new URL('../../', import.meta.url));
export const TEST_ORIGIN = 'http://localhost:3000';
export const TEST_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');

export function testEnv(dataDir: string, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: TEST_ORIGIN,
    DATA_DIR: dataDir,
    SECRETS_KEY: TEST_SECRETS_KEY,
    ANTHROPIC_API_KEY: 'test-anthropic-key',
    FRESHDESK_DOMAIN: 'flptest',
    FRESHDESK_API_KEY: 'env-freshdesk-key',
    FRESHSALES_SUBDOMAIN: 'gilt',
    FRESHSALES_API_KEY: 'test-freshsales-key',
    ...extra,
  };
}

export interface ReqOptions {
  method?: string;
  body?: unknown;
  cookie?: string;
  headers?: Record<string, string>;
}

export interface TestContext {
  app: Hono<AppEnv>;
  deps: AppDeps;
  fake: FakeFetch;
  logs: Record<string, unknown>[];
  dataDir: string;
  clock: { now: number };
  req(pathname: string, options?: ReqOptions): Promise<Response>;
  close(): Promise<void>;
}

export interface ContextOptions {
  env?: Record<string, string | undefined>;
  timeouts?: Partial<Timeouts>;
}

export async function createTestContext(options: ContextOptions = {}): Promise<TestContext> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'erp-test-'));
  const config = loadConfig(testEnv(dataDir, options.env), ROOT_DIR);
  const db = await openDatabase(path.join(dataDir, 'erp.db'));
  await runMigrations(db);
  const fake = new FakeFetch();
  const logs: Record<string, unknown>[] = [];
  const logger: Logger = { info: (e) => logs.push(e), error: (e) => logs.push(e) };
  const clock = { now: Date.parse('2026-01-05T08:00:00.000Z') };
  const deps = buildDeps({ config, db, fetch: fake.fetch, logger, now: () => clock.now, timeouts: options.timeouts });
  const app = createApp(deps);

  const req = (pathname: string, o: ReqOptions = {}): Promise<Response> => {
    const headers: Record<string, string> = { origin: TEST_ORIGIN, ...o.headers };
    if (o.cookie) headers.cookie = o.cookie;
    let body: BodyInit | undefined;
    if (typeof o.body === 'string' || o.body instanceof Uint8Array) {
      body = o.body as BodyInit;
    } else if (o.body !== undefined) {
      body = JSON.stringify(o.body);
      headers['content-type'] ??= 'application/json';
    }
    return Promise.resolve(app.request(pathname, { method: o.method ?? 'GET', headers, body }));
  };

  return {
    app,
    deps,
    fake,
    logs,
    dataDir,
    clock,
    req,
    async close() {
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
```


- [ ] **Step 2: Write the failing test**

Create `test/http.test.ts`:

```ts
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
```


- [ ] **Step 3: Run it to verify it fails**

Run:

```bash
npx vitest run test/http.test.ts
```

Expected: FAIL — `server/app.js`, `server/deps.js` etc. do not exist yet.


- [ ] **Step 4: Implement shared types and errors**

Create `server/types.ts`:

```ts
/** A record in Airtable's API shape. */
export interface AirtableRecord {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
}

/** The logged-in user as seen by request handlers (read fresh on every request). */
export interface SessionUser {
  id: string;
  name: string;
  role: string;
  isAdmin: boolean;
  allowedCompanies: string[];
}

export type AppEnv = {
  Variables: {
    requestId: string;
    user: SessionUser;
    sessionTokenHash: string;
  };
};
```

Create `server/util/errors.ts`:

```ts
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export type ErrorType =
  | 'INVALID_REQUEST'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'DUPLICATE_NUMBER'
  | 'KEY_IN_USE'
  | 'PAYLOAD_TOO_LARGE'
  | 'VALIDATION_FAILED'
  | 'RATE_LIMITED'
  | 'NOT_CONFIGURED'
  | 'INTERNAL'
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_TIMEOUT';

const STATUS: Record<ErrorType, ContentfulStatusCode> = {
  INVALID_REQUEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  DUPLICATE_NUMBER: 409,
  KEY_IN_USE: 409,
  PAYLOAD_TOO_LARGE: 413,
  VALIDATION_FAILED: 422,
  RATE_LIMITED: 429,
  NOT_CONFIGURED: 500,
  INTERNAL: 500,
  UPSTREAM_ERROR: 502,
  UPSTREAM_UNAVAILABLE: 502,
  UPSTREAM_TIMEOUT: 504,
};

export class ApiError extends Error {
  readonly status: ContentfulStatusCode;

  constructor(
    readonly type: ErrorType,
    message: string,
    status?: number,
  ) {
    super(message);
    this.status = (status ?? STATUS[type]) as ContentfulStatusCode;
  }
}

export const errorBody = (type: ErrorType, message: string) => ({ error: { type, message } });

export function jsonError(c: Context, type: ErrorType, message: string, status?: number): Response {
  return c.json(errorBody(type, message), (status ?? STATUS[type]) as ContentfulStatusCode);
}
```


- [ ] **Step 5: Implement logging, request context and body helpers**

Create `server/http/logger.ts`:

```ts
export interface Logger {
  info(entry: Record<string, unknown>): void;
  error(entry: Record<string, unknown>): void;
}

/** One JSON object per line on stdout/stderr. Never pass bodies, cookies or keys. */
export const jsonLogger: Logger = {
  info: (entry) => console.log(JSON.stringify({ level: 'info', time: new Date().toISOString(), ...entry })),
  error: (entry) => console.error(JSON.stringify({ level: 'error', time: new Date().toISOString(), ...entry })),
};
```

Create `server/http/requestContext.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { ErrorHandler, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv, SessionUser } from '../types.js';
import { ApiError, jsonError } from '../util/errors.js';
import type { Logger } from './logger.js';

/** Assigns a request id, logs one line per request, and adds X-Request-Id. */
export function requestContext(logger: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const requestId = randomUUID();
    c.set('requestId', requestId);
    const started = performance.now();
    await next();
    c.res.headers.set('x-request-id', requestId);
    const user = c.var.user as SessionUser | undefined;
    logger.info({
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Math.round(performance.now() - started),
      userId: user?.id ?? null,
    });
  };
}

export function errorHandler(logger: Logger): ErrorHandler<AppEnv> {
  return (err, c) => {
    if (err instanceof ApiError) return jsonError(c, err.type, err.message, err.status);
    if (err instanceof HTTPException && err.status < 500) {
      return jsonError(c, 'INVALID_REQUEST', err.message || 'Ungültige Anfrage', err.status);
    }
    const requestId = c.var.requestId as string | undefined;
    logger.error({ requestId, message: err.message, stack: err.stack });
    return jsonError(c, 'INTERNAL', `Interner Fehler (Referenz ${requestId ?? 'unbekannt'})`);
  };
}
```

Create `server/http/body.ts`:

```ts
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { ApiError, jsonError } from '../util/errors.js';

export const MB = 1024 * 1024;

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Rejects request bodies above maxBytes with a 413 JSON error. */
export const limit = (maxBytes: number) =>
  bodyLimit({
    maxSize: maxBytes,
    onError: (c) => jsonError(c, 'PAYLOAD_TOO_LARGE', 'Anfrage zu groß'),
  });

export async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ApiError('INVALID_REQUEST', 'Ungültiger JSON-Body');
  }
  if (!isPlainObject(body)) throw new ApiError('INVALID_REQUEST', 'JSON-Objekt erwartet');
  return body;
}
```


- [ ] **Step 6: Implement security headers, static files and health**

`'unsafe-inline'` for scripts is required: `index.html` has ~560 inline `onclick`/`onchange` handlers. `connect-src` deliberately omits `api.airtable.com` and Val.town, so the unchanged page served here cannot talk to the old backends.

Create `server/http/securityHeaders.ts`:

```ts
import type { MiddlewareHandler } from 'hono';
import type { AllowEntry } from '../config.js';

export function buildCsp(attachmentAllow: AllowEntry[]): string {
  const hosts = [...new Set(attachmentAllow.map((e) => `https://${e.host}`))].join(' ');
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://unpkg.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    `connect-src 'self' ${hosts}`.trim(),
    `frame-src 'self' blob: ${hosts}`.trim(),
    "worker-src 'self'",
    "manifest-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function securityHeaders(opts: { isProduction: boolean; attachmentAllow: AllowEntry[] }): MiddlewareHandler {
  const csp = buildCsp(opts.attachmentAllow);
  return async (c, next) => {
    await next();
    const h = c.res.headers;
    h.set('content-security-policy', csp);
    h.set('x-content-type-options', 'nosniff');
    h.set('x-frame-options', 'DENY');
    h.set('referrer-policy', 'strict-origin-when-cross-origin');
    h.set('permissions-policy', 'microphone=(self), camera=(), geolocation=(), payment=()');
    h.set('cross-origin-opener-policy', 'same-origin');
    if (opts.isProduction) h.set('strict-transport-security', 'max-age=31536000');
  };
}
```

Create `server/http/static.ts`:

```ts
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Hono, type Handler } from 'hono';
import type { AppEnv } from '../types.js';

/** Serves only index.html and sw.js from the repo root, byte-for-byte. */
export function staticRoutes(rootDir: string): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const serveFile =
    (file: string, contentType: string): Handler<AppEnv> =>
    async (c) => {
      const data = await readFile(path.join(rootDir, file));
      const etag = `"${createHash('sha256').update(data).digest('base64url').slice(0, 27)}"`;
      const headers = { 'content-type': contentType, 'cache-control': 'no-cache', etag };
      if (c.req.header('if-none-match') === etag) return c.body(null, 304, headers);
      return c.body(data, 200, headers);
    };

  const html = serveFile('index.html', 'text/html; charset=utf-8');
  app.get('/', html);
  app.get('/index.html', html);
  app.get('/sw.js', serveFile('sw.js', 'application/javascript; charset=utf-8'));
  // The app's "load newest version" button navigates to loader.html.
  app.get('/loader.html', (c) => c.redirect('/', 302));
  app.get('/loader-admin.html', (c) => c.redirect('/', 302));
  return app;
}
```

Create `server/http/health.ts`:

```ts
import { Hono } from 'hono';
import type { Database } from '../db/database.js';
import type { AppEnv } from '../types.js';

export function healthRoutes(db: Database): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get('/healthz', async (c) => {
    try {
      await db.query('SELECT 1');
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });
  return app;
}
```


- [ ] **Step 7: Implement dependencies, the app and the entry point**

Create `server/deps.ts`:

```ts
import type { Config } from './config.js';
import type { Database } from './db/database.js';
import { jsonLogger, type Logger } from './http/logger.js';

export type FetchFn = typeof fetch;

export interface Timeouts {
  upstreamMs: number;
  anthropicMs: number;
}

export interface AppDeps {
  config: Config;
  db: Database;
  fetch: FetchFn;
  logger: Logger;
  now: () => number;
  timeouts: Timeouts;
}

export interface BuildDepsOptions {
  config: Config;
  db: Database;
  fetch?: FetchFn;
  logger?: Logger;
  now?: () => number;
  timeouts?: Partial<Timeouts>;
}

export function buildDeps(o: BuildDepsOptions): AppDeps {
  const now = o.now ?? Date.now;
  return {
    config: o.config,
    db: o.db,
    // Resolve globalThis.fetch lazily so tests can replace it.
    fetch: o.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    logger: o.logger ?? jsonLogger,
    now,
    timeouts: { upstreamMs: 60_000, anthropicMs: 300_000, ...o.timeouts },
  };
}
```

Create `server/app.ts`:

```ts
import { Hono } from 'hono';
import type { AppDeps } from './deps.js';
import { healthRoutes } from './http/health.js';
import { errorHandler, requestContext } from './http/requestContext.js';
import { securityHeaders } from './http/securityHeaders.js';
import { staticRoutes } from './http/static.js';
import type { AppEnv } from './types.js';
import { jsonError } from './util/errors.js';

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', requestContext(deps.logger));
  app.use('*', securityHeaders(deps.config));
  app.onError(errorHandler(deps.logger));
  app.notFound((c) => (c.req.path.startsWith('/api/') ? jsonError(c, 'NOT_FOUND', 'Nicht gefunden') : c.text('Not Found', 404)));

  app.route('/', healthRoutes(deps.db));
  app.route('/', staticRoutes(deps.config.rootDir));

  const api = new Hono<AppEnv>();
  api.use('*', async (c, next) => {
    await next();
    if (!c.res.headers.has('cache-control')) c.res.headers.set('cache-control', 'no-store');
  });
  app.route('/api', api);
  return app;
}
```

Create `server/main.ts`:

```ts
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { runMigrations } from './db/migrations.js';
import { buildDeps } from './deps.js';
import { jsonLogger } from './http/logger.js';

async function main(): Promise<void> {
  // Railway (and local dev) start the server from the repository root.
  const config = loadConfig(process.env, process.cwd());
  await mkdir(config.dataDir, { recursive: true });
  const db = await openDatabase(path.join(config.dataDir, 'erp.db'));
  await runMigrations(db);
  const deps = buildDeps({ config, db });
  const app = createApp(deps);

  const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) =>
    jsonLogger.info({ message: 'listening', port: info.port }),
  );
  const shutdown = () => {
    server.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  jsonLogger.error({ message: 'startup failed', error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
```


- [ ] **Step 8: Run the test to verify it passes**

Run:

```bash
npx vitest run test/http.test.ts
```

Expected: 10 tests pass.


- [ ] **Step 9: Typecheck and lint**

Run:

```bash
npm run typecheck && npm run lint
```


- [ ] **Step 10: Start the server locally and check it serves index.html unchanged**

Run:

```bash
npm run build && (PUBLIC_ORIGIN=http://localhost:3999 DATA_DIR=./.data SECRETS_KEY=$(node -e "console.log(Buffer.alloc(32,3).toString('base64'))") PORT=3999 node dist/server/main.js & echo $! > .server.pid) && sleep 2 && curl -s -o /dev/null -w "%{http_code} %{size_download}\n" http://localhost:3999/ && curl -s http://localhost:3999/healthz; kill $(cat .server.pid); rm -f .server.pid
```

Expected: `200 1855857` (the byte size of index.html) and `{"ok":true}`.


- [ ] **Step 11: Commit**

```bash
git add server/types.ts server/util/errors.ts server/http server/deps.ts server/app.ts server/main.ts test/helpers test/http.test.ts
git commit -F - <<'EOF'
feat(server): add HTTP skeleton with security headers, static files and healthz

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FVrKcG5sQkpYKqUZGYjujR
EOF
```


---

### Task 4: Record storage and Airtable field rules

**Files:**
- Create: server/data/fields.ts, server/data/records.ts
- Test: test/fields.test.ts, test/records.test.ts

**Interfaces:**
- Consumes: `Database`, `Executor` (Task 2); `TableName` (Task 2); `ApiError` (Task 3); `isPlainObject` (Task 3); `AirtableRecord` (Task 3); `newRecordId` (Task 2).
- Produces: `prepareWriteFields(input): { set; clear }`, `isSecretField(name)`, `stripSecretFields(fields)`, `isEmptyValue(v)`, `LOCK_FIELDS`, `DERIVED_FIELDS`, `SECRET_FIELD_NAMES`; `parseFormula(formula): Condition[]`, `matchesConditions(fields, conditions)`; `parseSort(params): SortSpec[]`, `sortRecords(records, specs)`; `projectFields(record, names)`; `parseMaxRecords(raw)`. `class RecordStore(db, now)` with `list(table)`, `get(table, id, exec?)`, `count(table)`, `insert(tx, table, fields, {id?, createdTime?})`, `update(tx, table, id, set, clear)`, `remove(tx, table, id)`; `interface StoredRecord { id; createdTime; updatedTime; fields }`.

- [ ] **Step 1: Write the failing tests**

Create `test/fields.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  isSecretField,
  matchesConditions,
  parseFormula,
  parseMaxRecords,
  parseSort,
  prepareWriteFields,
  projectFields,
  sortRecords,
  stripSecretFields,
} from '../server/data/fields.js';
import type { AirtableRecord } from '../server/types.js';

const rec = (id: string, fields: Record<string, unknown>): AirtableRecord => ({ id, createdTime: 't', fields });

describe('prepareWriteFields', () => {
  it('splits values into set and clear using Airtable empty-value rules', () => {
    const r = prepareWriteFields({ name: 'A', zero: 0, zeroStr: '0', empty: '', no: false, none: null, list: [], links: ['recX'] });
    expect(r.set).toEqual({ name: 'A', zero: 0, zeroStr: '0', links: ['recX'] });
    expect(r.clear.sort()).toEqual(['empty', 'list', 'no', 'none']);
  });

  it('silently ignores lock and derived fields', () => {
    const r = prepareWriteFields({ lock_user_id: 'recU', lock_until: 'x', has_mailchimp_key: true, name: 'B' });
    expect(r.set).toEqual({ name: 'B' });
    expect(r.clear).toEqual([]);
  });

  it('rejects secret fields', () => {
    for (const name of ['api_key', 'freshdesk_api_key', 'freshdesk_keys_json', 'mailchimp_api_key', 'refresh_token', 'password']) {
      expect(() => prepareWriteFields({ [name]: 'x' })).toThrow(/Geheime Felder/);
    }
  });

  it('does not treat token counters as secrets', () => {
    expect(isSecretField('input_tokens')).toBe(false);
    expect(isSecretField('cache_read_input_tokens')).toBe(false);
    expect(prepareWriteFields({ input_tokens: 10, output_tokens: 5 }).set).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it('rejects non-objects and dangerous keys', () => {
    expect(() => prepareWriteFields(['a'])).toThrow(/fields muss ein Objekt sein/);
    expect(() => prepareWriteFields(JSON.parse('{"__proto__": {"x": 1}}'))).toThrow(/Ungültiger Feldname/);
  });

  it('strips secret fields from stored data', () => {
    expect(stripSecretFields({ name: 'A', api_key: 'k', some_secret: 's' })).toEqual({ name: 'A' });
  });
});

describe('parseFormula / matchesConditions', () => {
  it('parses the formula the app uses', () => {
    expect(parseFormula("{status}='aktiv'")).toEqual([{ field: 'status', value: 'aktiv' }]);
  });

  it('parses AND with escaped quotes and double-quoted values', () => {
    expect(parseFormula(`AND({name}='O\\'Brien, GmbH', {status}="aktiv")`)).toEqual([
      { field: 'name', value: "O'Brien, GmbH" },
      { field: 'status', value: 'aktiv' },
    ]);
  });

  it('rejects anything else', () => {
    for (const f of ['FIND("x",{name})', "{a}!='b'", "OR({a}='b',{c}='d')", "{a}='b' AND {c}='d'"]) {
      expect(() => parseFormula(f)).toThrow(/Formel nicht unterstützt/);
    }
  });

  it('matches scalars, arrays (contains) and missing fields', () => {
    const f = { status: 'aktiv', company_id: ['recA', 'recB'], n: 5 };
    expect(matchesConditions(f, [{ field: 'status', value: 'aktiv' }])).toBe(true);
    expect(matchesConditions(f, [{ field: 'company_id', value: 'recB' }])).toBe(true);
    expect(matchesConditions(f, [{ field: 'n', value: '5' }])).toBe(true);
    expect(matchesConditions(f, [{ field: 'missing', value: '' }])).toBe(true);
    expect(matchesConditions(f, [{ field: 'status', value: 'inaktiv' }])).toBe(false);
  });
});

describe('sorting and projection', () => {
  it('sorts German strings with umlauts next to their base letter, case-insensitively, empties last', () => {
    const records = [rec('1', { name: 'Zahnrad' }), rec('2', { name: 'Ärzte AG' }), rec('3', {}), rec('4', { name: 'apfel' })];
    const asc = sortRecords(records, [{ field: 'name', direction: 'asc' }]).map((r) => r.id);
    expect(asc).toEqual(['4', '2', '1', '3']);
    const desc = sortRecords(records, [{ field: 'name', direction: 'desc' }]).map((r) => r.id);
    expect(desc).toEqual(['1', '2', '4', '3']);
  });

  it('sorts numbers numerically and supports multiple keys', () => {
    const records = [rec('a', { g: 'x', n: 10 }), rec('b', { g: 'x', n: 9 }), rec('c', { g: 'a', n: 50 })];
    const out = sortRecords(records, [
      { field: 'g', direction: 'asc' },
      { field: 'n', direction: 'asc' },
    ]).map((r) => r.id);
    expect(out).toEqual(['c', 'b', 'a']);
  });

  it('parses Airtable sort query params', () => {
    const p = new URLSearchParams('sort[0][field]=name&sort[0][direction]=desc&sort[1][field]=created');
    expect(parseSort(p)).toEqual([
      { field: 'name', direction: 'desc' },
      { field: 'created', direction: 'asc' },
    ]);
    expect(() => parseSort(new URLSearchParams('sort[0][field]=a&sort[0][direction]=up'))).toThrow();
  });

  it('projects fields and validates maxRecords', () => {
    expect(projectFields(rec('1', { a: 1, b: 2 }), ['b']).fields).toEqual({ b: 2 });
    expect(parseMaxRecords('3')).toBe(3);
    expect(parseMaxRecords(null)).toBeUndefined();
    expect(() => parseMaxRecords('0')).toThrow();
  });
});
```

Create `test/records.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecordStore } from '../server/data/records.js';
import { openDatabase, type Database } from '../server/db/database.js';
import { runMigrations } from '../server/db/migrations.js';
import { isRecordId } from '../server/util/ids.js';

let dir: string;
let db: Database;
let store: RecordStore;
let t = Date.parse('2026-02-01T10:00:00.000Z');

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'erp-rec-'));
  db = await openDatabase(path.join(dir, 'erp.db'));
  await runMigrations(db);
  store = new RecordStore(db, () => t);
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('RecordStore', () => {
  it('inserts with a fresh rec id and lists in creation order', async () => {
    const a = await db.write((tx) => store.insert(tx, 'Order', { order_no: 'AB-1001' }));
    t += 1000;
    const b = await db.write((tx) => store.insert(tx, 'Order', { order_no: 'AB-1002' }));
    expect(isRecordId(a.id)).toBe(true);
    expect(a.createdTime).toBe('2026-02-01T10:00:00.000Z');
    expect((await store.list('Order')).map((r) => r.id)).toEqual([a.id, b.id]);
    expect(await store.count('Order')).toBe(2);
  });

  it('keeps imported ids and createdTime', async () => {
    await db.write((tx) =>
      store.insert(tx, 'Customer', { name: 'X' }, { id: 'recAAAAAAAAAAAAAA', createdTime: '2024-01-01T00:00:00.000Z' }),
    );
    const r = await store.get('Customer', 'recAAAAAAAAAAAAAA');
    expect(r?.createdTime).toBe('2024-01-01T00:00:00.000Z');
    expect(r?.fields).toEqual({ name: 'X' });
  });

  it('merges updates and removes cleared fields', async () => {
    const a = await db.write((tx) => store.insert(tx, 'Customer', { name: 'A', city: 'Fellbach' }));
    t += 5000;
    const u = await db.write((tx) => store.update(tx, 'Customer', a.id, { phone: '123' }, ['city']));
    expect(u?.fields).toEqual({ name: 'A', phone: '123' });
    expect(u?.updatedTime).toBe(new Date(t).toISOString());
    expect(await db.write((tx) => store.update(tx, 'Customer', 'recMISSINGMISSING', {}, []))).toBeNull();
  });

  it('removes records', async () => {
    const a = await db.write((tx) => store.insert(tx, 'Customer', {}));
    expect(await db.write((tx) => store.remove(tx, 'Customer', a.id))).toBe(true);
    expect(await db.write((tx) => store.remove(tx, 'Customer', a.id))).toBe(false);
    expect(await store.get('Customer', a.id)).toBeNull();
  });
});
```


- [ ] **Step 2: Run them to verify they fail**

Run:

```bash
npx vitest run test/fields.test.ts test/records.test.ts
```

Expected: FAIL — modules not found.


- [ ] **Step 3: Implement the field rules**

The secret-field pattern is anchored at the end (`/(^|_)(api_?key|token|secret|password)$/i`), so `AiUsageLog.input_tokens` / `output_tokens` are not treated as secrets.

Create `server/data/fields.ts`:

```ts
import { isPlainObject } from '../http/body.js';
import type { AirtableRecord } from '../types.js';
import { ApiError } from '../util/errors.js';

/** Secret fields that may exist in Airtable data; never stored in records, never returned. */
export const SECRET_FIELD_NAMES: ReadonlySet<string> = new Set([
  'api_key',
  'freshdesk_api_key',
  'freshdesk_keys_json',
  'mailchimp_api_key',
]);
// Anchored at the end on purpose: "input_tokens" / "output_tokens" are NOT secrets.
const SECRET_PATTERN = /(^|_)(api_?key|token|secret|password)$/i;

export const isSecretField = (name: string): boolean => SECRET_FIELD_NAMES.has(name) || SECRET_PATTERN.test(name);

/** Set only by the lock endpoints. */
export const LOCK_FIELDS: ReadonlySet<string> = new Set(['lock_user_id', 'lock_until']);
/** Computed by the server when responding. */
export const DERIVED_FIELDS: ReadonlySet<string> = new Set([
  'has_api_key',
  'has_freshdesk_key',
  'freshdesk_company_keys',
  'has_mailchimp_key',
]);

/** Airtable omits these values, so we drop them too. */
export const isEmptyValue = (v: unknown): boolean =>
  v === null || v === undefined || v === '' || v === false || (Array.isArray(v) && v.length === 0);

export interface WriteFields {
  set: Record<string, unknown>;
  clear: string[];
}

/** Validates a client `fields` object for a create/update. */
export function prepareWriteFields(input: unknown): WriteFields {
  if (!isPlainObject(input)) throw new ApiError('INVALID_REQUEST', 'fields muss ein Objekt sein');
  const set: [string, unknown][] = [];
  const clear: string[] = [];
  for (const [name, value] of Object.entries(input)) {
    if (name.length === 0 || name.length > 200 || name === '__proto__') {
      throw new ApiError('INVALID_REQUEST', 'Ungültiger Feldname');
    }
    if (LOCK_FIELDS.has(name) || DERIVED_FIELDS.has(name)) continue;
    if (isSecretField(name)) throw new ApiError('INVALID_REQUEST', `Geheime Felder nur über Admin-Funktion (${name})`);
    if (isEmptyValue(value)) clear.push(name);
    else set.push([name, value]);
  }
  return { set: Object.fromEntries(set), clear };
}

export function stripSecretFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([name]) => !isSecretField(name)));
}

// ---------- restricted filterByFormula ----------

export interface Condition {
  field: string;
  value: string;
}

const CONDITION = /^\{([^{}]+)\}\s*=\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")$/s;

function parseCondition(text: string): Condition {
  const m = CONDITION.exec(text.trim());
  if (!m || m[1] === undefined) throw new ApiError('INVALID_REQUEST', 'Formel nicht unterstützt');
  const raw = m[2] ?? m[3] ?? '';
  return { field: m[1], value: raw.replace(/\\(.)/gs, '$1') };
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (quote) {
      current += ch;
      if (ch === '\\') {
        current += text.charAt(i + 1);
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '(' || ch === '{') depth++;
    else if (ch === ')' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/** Supports `{field}='value'` and `AND({a}='x', {b}='y')` — the only formulas the app uses. */
export function parseFormula(formula: string): Condition[] {
  const text = formula.trim();
  if (text === '') return [];
  const and = /^AND\s*\((.*)\)$/is.exec(text);
  if (!and || and[1] === undefined) return [parseCondition(text)];
  return splitTopLevel(and[1]).map(parseCondition);
}

export function matchesConditions(fields: Record<string, unknown>, conditions: Condition[]): boolean {
  return conditions.every(({ field, value }) => {
    const v = fields[field];
    if (Array.isArray(v)) return v.some((item) => String(item) === value);
    if (v === undefined || v === null) return value === '';
    return String(v) === value;
  });
}

// ---------- sorting ----------

export interface SortSpec {
  field: string;
  direction: 'asc' | 'desc';
}

export function parseSort(params: URLSearchParams): SortSpec[] {
  const specs: SortSpec[] = [];
  for (let i = 0; params.has(`sort[${i}][field]`); i++) {
    const field = params.get(`sort[${i}][field]`) ?? '';
    const dir = params.get(`sort[${i}][direction]`) ?? 'asc';
    if (!field || (dir !== 'asc' && dir !== 'desc')) throw new ApiError('INVALID_REQUEST', 'Ungültige Sortierung');
    specs.push({ field, direction: dir });
  }
  return specs;
}

const collator = new Intl.Collator('de', { sensitivity: 'base', numeric: true });

function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = Array.isArray(a) ? a.join(', ') : String(a);
  const sb = Array.isArray(b) ? b.join(', ') : String(b);
  return collator.compare(sa, sb);
}

/** Stable sort; empty values always last. */
export function sortRecords(records: AirtableRecord[], specs: SortSpec[]): AirtableRecord[] {
  if (specs.length === 0) return records;
  return [...records].sort((ra, rb) => {
    for (const { field, direction } of specs) {
      const a = ra.fields[field];
      const b = rb.fields[field];
      const ea = isEmptyValue(a);
      const eb = isEmptyValue(b);
      if (ea && eb) continue;
      if (ea) return 1;
      if (eb) return -1;
      const c = compareValues(a, b);
      if (c !== 0) return direction === 'asc' ? c : -c;
    }
    return 0;
  });
}

export function projectFields(record: AirtableRecord, names: string[]): AirtableRecord {
  const wanted = new Set(names);
  return { ...record, fields: Object.fromEntries(Object.entries(record.fields).filter(([k]) => wanted.has(k))) };
}

export function parseMaxRecords(raw: string | null): number | undefined {
  if (raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new ApiError('INVALID_REQUEST', 'maxRecords muss eine positive Zahl sein');
  return n;
}
```


- [ ] **Step 4: Implement the record store**

Create `server/data/records.ts`:

```ts
import type { Row } from '@libsql/client';
import type { Database, Executor } from '../db/database.js';
import { newRecordId } from '../util/ids.js';
import type { TableName } from './tables.js';

export interface StoredRecord {
  id: string;
  createdTime: string;
  updatedTime: string;
  fields: Record<string, unknown>;
}

const COLUMNS = 'id, created_time, updated_time, fields';

function toRecord(row: Row): StoredRecord {
  return {
    id: String(row.id),
    createdTime: String(row.created_time),
    updatedTime: String(row.updated_time),
    fields: JSON.parse(String(row.fields)) as Record<string, unknown>,
  };
}

/** Storage for the ERP tables. Table names come only from the registry, never from input. */
export class RecordStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  async list(table: TableName): Promise<StoredRecord[]> {
    const rows = await this.db.query(`SELECT ${COLUMNS} FROM "${table}" ORDER BY created_time, id`);
    return rows.map(toRecord);
  }

  async get(table: TableName, id: string, exec: Executor = this.db.client): Promise<StoredRecord | null> {
    const rs = await exec.execute({ sql: `SELECT ${COLUMNS} FROM "${table}" WHERE id = ?`, args: [id] });
    const row = rs.rows[0];
    return row ? toRecord(row) : null;
  }

  async count(table: TableName): Promise<number> {
    const rows = await this.db.query(`SELECT count(*) AS n FROM "${table}"`);
    return Number(rows[0]?.n ?? 0);
  }

  async insert(
    tx: Executor,
    table: TableName,
    fields: Record<string, unknown>,
    opts: { id?: string; createdTime?: string } = {},
  ): Promise<StoredRecord> {
    const id = opts.id ?? newRecordId();
    const now = this.iso();
    const createdTime = opts.createdTime ?? now;
    await tx.execute({
      sql: `INSERT INTO "${table}" (${COLUMNS}) VALUES (?, ?, ?, ?)`,
      args: [id, createdTime, now, JSON.stringify(fields)],
    });
    return { id, createdTime, updatedTime: now, fields };
  }

  /** Airtable PATCH semantics: merge `set`, delete `clear`. Returns null if the record is missing. */
  async update(
    tx: Executor,
    table: TableName,
    id: string,
    set: Record<string, unknown>,
    clear: string[],
  ): Promise<StoredRecord | null> {
    const existing = await this.get(table, id, tx);
    if (!existing) return null;
    const fields: Record<string, unknown> = { ...existing.fields, ...set };
    for (const name of clear) delete fields[name];
    const now = this.iso();
    await tx.execute({
      sql: `UPDATE "${table}" SET fields = ?, updated_time = ? WHERE id = ?`,
      args: [JSON.stringify(fields), now, id],
    });
    return { ...existing, updatedTime: now, fields };
  }

  async remove(tx: Executor, table: TableName, id: string): Promise<boolean> {
    const rs = await tx.execute({ sql: `DELETE FROM "${table}" WHERE id = ?`, args: [id] });
    return rs.rowsAffected > 0;
  }
}
```


- [ ] **Step 5: Run the tests to verify they pass**

Run:

```bash
npx vitest run test/fields.test.ts test/records.test.ts
```

Expected: 18 tests pass.


- [ ] **Step 6: Typecheck and lint**

Run:

```bash
npm run typecheck && npm run lint
```


- [ ] **Step 7: Commit**

```bash
git add server/data/fields.ts server/data/records.ts test/fields.test.ts test/records.test.ts
git commit -F - <<'EOF'
feat(server): add record store with Airtable field semantics

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FVrKcG5sQkpYKqUZGYjujR
EOF
```


---

### Task 5: Secrets: encryption, login-key hashing, secret store

**Files:**
- Create: server/secrets/crypto.ts, server/auth/passwords.ts, server/secrets/store.ts
- Test: test/secrets.test.ts

**Interfaces:**
- Consumes: `Database`, `Executor`, `runMigrations` (Task 2); `isPlainObject` (Task 3).
- Produces: `encryptSecret(key: Buffer, plaintext): string`, `decryptSecret(key, blob): string`; `hashLoginKey(key): Promise<string>`, `verifyLoginKey(key, stored): Promise<boolean>`; `class SecretStore(db, key)` with `userInfo(userId): Promise<UserSecretInfo>`, `allUserInfo()`, `apiKeyHashes(): Promise<Map<userId, hash>>`, `setApiKeyHash(tx, userId, hash|null)`, `setFreshdeskDefault(tx, userId, key|null)`, `mergeFreshdeskKeys(tx, userId, patch)`, `freshdeskKeyFor(userId, companyId|null)`, `companiesWithMailchimpKey()`, `mailchimpKey(companyId)`, `setMailchimpKey(tx, companyId, key|null)`; `interface UserSecretInfo { hasApiKey; hasFreshdeskKey; freshdeskCompanyKeys: string[] }`.

- [ ] **Step 1: Write the failing test**

Create `test/secrets.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashLoginKey, verifyLoginKey } from '../server/auth/passwords.js';
import { openDatabase, type Database } from '../server/db/database.js';
import { runMigrations } from '../server/db/migrations.js';
import { decryptSecret, encryptSecret } from '../server/secrets/crypto.js';
import { SecretStore } from '../server/secrets/store.js';

const KEY = Buffer.alloc(32, 9);

describe('encryptSecret / decryptSecret', () => {
  it('round-trips and uses a fresh IV each time', () => {
    const a = encryptSecret(KEY, 'fd-key-123');
    const b = encryptSecret(KEY, 'fd-key-123');
    expect(a).not.toBe(b);
    expect(a.startsWith('v1:')).toBe(true);
    expect(a).not.toContain('fd-key-123');
    expect(decryptSecret(KEY, a)).toBe('fd-key-123');
  });

  it('fails with the wrong key or tampered data', () => {
    const blob = encryptSecret(KEY, 'x');
    expect(() => decryptSecret(Buffer.alloc(32, 1), blob)).toThrow();
    const parts = blob.split(':');
    parts[2] = Buffer.from('tampered').toString('base64');
    expect(() => decryptSecret(KEY, parts.join(':'))).toThrow();
  });
});

describe('login key hashing', () => {
  it('verifies the right key and rejects others', async () => {
    const stored = await hashLoginKey('abcdefghijklmnopqrstuvwx');
    expect(stored).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(stored).not.toContain('abcdefghijklmnopqrstuvwx');
    expect(await verifyLoginKey('abcdefghijklmnopqrstuvwx', stored)).toBe(true);
    expect(await verifyLoginKey('abcdefghijklmnopqrstuvwy', stored)).toBe(false);
    expect(await verifyLoginKey('x', 'garbage')).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashLoginKey('same-key-same-key')).not.toBe(await hashLoginKey('same-key-same-key'));
  });
});

describe('SecretStore', () => {
  let dir: string;
  let db: Database;
  let store: SecretStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'erp-sec-'));
    db = await openDatabase(path.join(dir, 'erp.db'));
    await runMigrations(db);
    store = new SecretStore(db, KEY);
  });
  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('reports nothing for unknown users', async () => {
    expect(await store.userInfo('recU')).toEqual({ hasApiKey: false, hasFreshdeskKey: false, freshdeskCompanyKeys: [] });
    expect(await store.freshdeskKeyFor('recU', 'recC')).toBeNull();
  });

  it('stores api key hashes', async () => {
    await db.write((tx) => store.setApiKeyHash(tx, 'recU', 'scrypt$hash'));
    expect((await store.apiKeyHashes()).get('recU')).toBe('scrypt$hash');
    expect((await store.userInfo('recU')).hasApiKey).toBe(true);
    await db.write((tx) => store.setApiKeyHash(tx, 'recU', null));
    expect((await store.apiKeyHashes()).has('recU')).toBe(false);
  });

  it('selects the per-company Freshdesk key, then the default', async () => {
    await db.write(async (tx) => {
      await store.setFreshdeskDefault(tx, 'recU', 'default-key');
      await store.mergeFreshdeskKeys(tx, 'recU', { recC1: 'company-1-key', recC2: 'company-2-key' });
    });
    expect(await store.freshdeskKeyFor('recU', 'recC1')).toBe('company-1-key');
    expect(await store.freshdeskKeyFor('recU', 'recC9')).toBe('default-key');
    expect(await store.freshdeskKeyFor('recU', null)).toBe('default-key');
    expect(await store.userInfo('recU')).toEqual({
      hasApiKey: false,
      hasFreshdeskKey: true,
      freshdeskCompanyKeys: ['recC1', 'recC2'],
    });
    const raw = await db.query('SELECT freshdesk_api_key_enc, freshdesk_keys_enc FROM user_secrets');
    expect(JSON.stringify(raw)).not.toContain('company-1-key');
  });

  it('merges company keys: null removes, other companies stay', async () => {
    await db.write((tx) => store.mergeFreshdeskKeys(tx, 'recU', { recC1: 'a', recC2: 'b' }));
    await db.write((tx) => store.mergeFreshdeskKeys(tx, 'recU', { recC1: null, recC3: 'c' }));
    expect((await store.userInfo('recU')).freshdeskCompanyKeys).toEqual(['recC2', 'recC3']);
    expect((await store.allUserInfo()).get('recU')?.freshdeskCompanyKeys).toEqual(['recC2', 'recC3']);
  });

  it('stores Mailchimp keys per company', async () => {
    await db.write((tx) => store.setMailchimpKey(tx, 'recC1', 'mc-key-us21'));
    expect(await store.mailchimpKey('recC1')).toBe('mc-key-us21');
    expect([...(await store.companiesWithMailchimpKey())]).toEqual(['recC1']);
    await db.write((tx) => store.setMailchimpKey(tx, 'recC1', null));
    expect(await store.mailchimpKey('recC1')).toBeNull();
  });
});
```


- [ ] **Step 2: Run it to verify it fails**

Run:

```bash
npx vitest run test/secrets.test.ts
```

Expected: FAIL — modules not found.


- [ ] **Step 3: Implement encryption and login-key hashing**

Create `server/secrets/crypto.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** AES-256-GCM; stored as "v1:<iv>:<ciphertext>:<tag>" (base64 parts). */
export function encryptSecret(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), ciphertext.toString('base64'), tag.toString('base64')].join(':');
}

export function decryptSecret(key: Buffer, blob: string): string {
  const [version, iv, ciphertext, tag] = blob.split(':');
  if (version !== 'v1' || iv === undefined || ciphertext === undefined || tag === undefined) {
    throw new Error('Unknown secret format');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}
```

Create `server/auth/passwords.ts`:

```ts
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;

function derive(key: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(key, salt, KEY_LENGTH, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, derived) =>
      err ? reject(err) : resolve(derived),
    );
  });
}

/** Returns "scrypt$N$r$p$<salt b64>$<hash b64>". */
export async function hashLoginKey(key: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(key, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyLoginKey(key: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await derive(key, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
```


- [ ] **Step 4: Implement the secret store**

Create `server/secrets/store.ts`:

```ts
import type { Row } from '@libsql/client';
import type { Database, Executor } from '../db/database.js';
import { isPlainObject } from '../http/body.js';
import { decryptSecret, encryptSecret } from './crypto.js';

export interface UserSecretInfo {
  hasApiKey: boolean;
  hasFreshdeskKey: boolean;
  /** Company ids for which the user has a personal Freshdesk key. */
  freshdeskCompanyKeys: string[];
}

type UserColumn = 'api_key_hash' | 'freshdesk_api_key_enc' | 'freshdesk_keys_enc';

const present = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** Login-key hashes and encrypted third-party keys. Nothing here is ever sent to a browser. */
export class SecretStore {
  constructor(
    private readonly db: Database,
    private readonly key: Buffer,
  ) {}

  private async userRow(userId: string, exec: Executor = this.db.client): Promise<Row | undefined> {
    const rs = await exec.execute({
      sql: 'SELECT user_id, api_key_hash, freshdesk_api_key_enc, freshdesk_keys_enc FROM user_secrets WHERE user_id = ?',
      args: [userId],
    });
    return rs.rows[0];
  }

  private decryptMap(enc: unknown): Record<string, string> {
    if (!present(enc)) return {};
    const parsed: unknown = JSON.parse(decryptSecret(this.key, enc));
    if (!isPlainObject(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => present(entry[1])),
    );
  }

  private toInfo(row: Row | undefined): UserSecretInfo {
    return {
      hasApiKey: present(row?.api_key_hash),
      hasFreshdeskKey: present(row?.freshdesk_api_key_enc),
      freshdeskCompanyKeys: Object.keys(this.decryptMap(row?.freshdesk_keys_enc)).sort(),
    };
  }

  private async upsertUser(tx: Executor, userId: string, column: UserColumn, value: string | null): Promise<void> {
    await tx.execute({
      sql: `INSERT INTO user_secrets (user_id, ${column}) VALUES (?, ?)
            ON CONFLICT(user_id) DO UPDATE SET ${column} = excluded.${column}`,
      args: [userId, value],
    });
  }

  async userInfo(userId: string): Promise<UserSecretInfo> {
    return this.toInfo(await this.userRow(userId));
  }

  async allUserInfo(): Promise<Map<string, UserSecretInfo>> {
    const rows = await this.db.query(
      'SELECT user_id, api_key_hash, freshdesk_api_key_enc, freshdesk_keys_enc FROM user_secrets',
    );
    return new Map(rows.map((row) => [String(row.user_id), this.toInfo(row)]));
  }

  /** userId -> scrypt hash, for users that have a login key. */
  async apiKeyHashes(): Promise<Map<string, string>> {
    const rows = await this.db.query(
      "SELECT user_id, api_key_hash FROM user_secrets WHERE api_key_hash IS NOT NULL AND api_key_hash <> ''",
    );
    return new Map(rows.map((row) => [String(row.user_id), String(row.api_key_hash)]));
  }

  setApiKeyHash(tx: Executor, userId: string, hash: string | null): Promise<void> {
    return this.upsertUser(tx, userId, 'api_key_hash', hash);
  }

  setFreshdeskDefault(tx: Executor, userId: string, apiKey: string | null): Promise<void> {
    return this.upsertUser(tx, userId, 'freshdesk_api_key_enc', apiKey ? encryptSecret(this.key, apiKey) : null);
  }

  /** Merges per-company Freshdesk keys; null removes a company's key. */
  async mergeFreshdeskKeys(tx: Executor, userId: string, patch: Record<string, string | null>): Promise<void> {
    const map = this.decryptMap((await this.userRow(userId, tx))?.freshdesk_keys_enc);
    for (const [companyId, apiKey] of Object.entries(patch)) {
      if (apiKey) map[companyId] = apiKey;
      else delete map[companyId];
    }
    const enc = Object.keys(map).length > 0 ? encryptSecret(this.key, JSON.stringify(map)) : null;
    await this.upsertUser(tx, userId, 'freshdesk_keys_enc', enc);
  }

  /** The user's key for companyId if given and present, else the user's default key. */
  async freshdeskKeyFor(userId: string, companyId: string | null): Promise<string | null> {
    const row = await this.userRow(userId);
    if (companyId) {
      const companyKey = this.decryptMap(row?.freshdesk_keys_enc)[companyId];
      if (companyKey) return companyKey;
    }
    return present(row?.freshdesk_api_key_enc) ? decryptSecret(this.key, row.freshdesk_api_key_enc) : null;
  }

  async companiesWithMailchimpKey(): Promise<Set<string>> {
    const rows = await this.db.query(
      "SELECT company_id FROM company_secrets WHERE mailchimp_api_key_enc IS NOT NULL AND mailchimp_api_key_enc <> ''",
    );
    return new Set(rows.map((row) => String(row.company_id)));
  }

  async mailchimpKey(companyId: string): Promise<string | null> {
    const rows = await this.db.query('SELECT mailchimp_api_key_enc FROM company_secrets WHERE company_id = ?', [
      companyId,
    ]);
    const enc = rows[0]?.mailchimp_api_key_enc;
    return present(enc) ? decryptSecret(this.key, enc) : null;
  }

  async setMailchimpKey(tx: Executor, companyId: string, apiKey: string | null): Promise<void> {
    await tx.execute({
      sql: `INSERT INTO company_secrets (company_id, mailchimp_api_key_enc) VALUES (?, ?)
            ON CONFLICT(company_id) DO UPDATE SET mailchimp_api_key_enc = excluded.mailchimp_api_key_enc`,
      args: [companyId, apiKey ? encryptSecret(this.key, apiKey) : null],
    });
  }
}
```


- [ ] **Step 5: Run the test to verify it passes**

Run:

```bash
npx vitest run test/secrets.test.ts
```

Expected: 9 tests pass.


- [ ] **Step 6: Typecheck and lint**

Run:

```bash
npm run typecheck && npm run lint
```


- [ ] **Step 7: Commit**

```bash
git add server/secrets server/auth/passwords.ts test/secrets.test.ts
git commit -F - <<'EOF'
feat(server): add encrypted secret store and scrypt login-key hashing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FVrKcG5sQkpYKqUZGYjujR
EOF
```


---

### Task 6: Login, sessions, rate limit and origin check

**Files:**
- Create: server/auth/sessions.ts, server/auth/rateLimit.ts, server/auth/users.ts, server/auth/middleware.ts, server/auth/routes.ts
- Modify: server/deps.ts, server/app.ts (full replacements below)
- Modify: test/helpers/context.ts, test/http.test.ts (full replacements below)
- Test: test/auth.test.ts

**Interfaces:**
- Consumes: `RecordStore`, `StoredRecord` (Task 4); `SecretStore`, `UserSecretInfo`, `verifyLoginKey`, `hashLoginKey` (Task 5); `ApiError`, `jsonError`, `readJsonBody` (Task 3); `newSessionToken`, `newLoginKey` (Task 2).
- Produces: `class SessionStore(db, now)` with `create(userId, longLived, userAgent): { token; ttlMs }`, `lookup(token)`, `delete(tokenHash)`, `deleteForUser(userId)`, `purgeExpired()`; `SHORT_TTL_MS`, `LONG_TTL_MS`, `hashToken`; `class LoginRateLimiter(opts, now)` with `isBlocked(ip)`, `recordFailure(ip)`; `toSessionUser(record)`, `isActiveUser(record)`, `userPayload(user, info)`; `requireAuth(deps)`, `requireAdmin`, `originCheck(publicOrigin)`, `clientIp(c)`, `COOKIE_NAME`; `publicAuthRoutes(deps)`, `sessionRoutes(deps)`, `findUserIdByKey(deps, key)`. `AppDeps` gains `records`, `sessions`, `secrets`, `limiter`. Test context gains `createUser({name, role, isAdmin, companies, status, key})`, `login(key, longLived?)` → cookie pair, `loginAs(options)` → `{ id, key, cookie }`.

- [ ] **Step 1: Extend the test context with users and login**

Replace the whole content of `test/helpers/context.ts` with:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';
import { createApp } from '../../server/app.js';
import { loadConfig } from '../../server/config.js';
import { openDatabase } from '../../server/db/database.js';
import { runMigrations } from '../../server/db/migrations.js';
import { buildDeps, type AppDeps, type Timeouts } from '../../server/deps.js';
import type { Logger } from '../../server/http/logger.js';
import type { AppEnv } from '../../server/types.js';
import { hashLoginKey } from '../../server/auth/passwords.js';
import { newLoginKey } from '../../server/util/ids.js';
import { FakeFetch } from './fakeFetch.js';

export const ROOT_DIR = fileURLToPath(new URL('../../', import.meta.url));
export const TEST_ORIGIN = 'http://localhost:3000';
export const TEST_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');

export function testEnv(dataDir: string, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: TEST_ORIGIN,
    DATA_DIR: dataDir,
    SECRETS_KEY: TEST_SECRETS_KEY,
    ANTHROPIC_API_KEY: 'test-anthropic-key',
    FRESHDESK_DOMAIN: 'flptest',
    FRESHDESK_API_KEY: 'env-freshdesk-key',
    FRESHSALES_SUBDOMAIN: 'gilt',
    FRESHSALES_API_KEY: 'test-freshsales-key',
    ...extra,
  };
}

export interface ReqOptions {
  method?: string;
  body?: unknown;
  cookie?: string;
  headers?: Record<string, string>;
}

export interface CreateUserOptions {
  name?: string;
  role?: string;
  isAdmin?: boolean;
  companies?: string[];
  status?: string;
  key?: string;
}

export interface TestUser {
  id: string;
  key: string;
}

export interface TestContext {
  app: Hono<AppEnv>;
  deps: AppDeps;
  fake: FakeFetch;
  logs: Record<string, unknown>[];
  dataDir: string;
  clock: { now: number };
  req(pathname: string, options?: ReqOptions): Promise<Response>;
  createUser(options?: CreateUserOptions): Promise<TestUser>;
  /** Logs in and returns the "name=value" cookie pair. */
  login(key: string, longLived?: boolean): Promise<string>;
  /** Creates a user and logs in; returns the user and cookie. */
  loginAs(options?: CreateUserOptions): Promise<TestUser & { cookie: string }>;
  close(): Promise<void>;
}

export interface ContextOptions {
  env?: Record<string, string | undefined>;
  timeouts?: Partial<Timeouts>;
}

export async function createTestContext(options: ContextOptions = {}): Promise<TestContext> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'erp-test-'));
  const config = loadConfig(testEnv(dataDir, options.env), ROOT_DIR);
  const db = await openDatabase(path.join(dataDir, 'erp.db'));
  await runMigrations(db);
  const fake = new FakeFetch();
  const logs: Record<string, unknown>[] = [];
  const logger: Logger = { info: (e) => logs.push(e), error: (e) => logs.push(e) };
  const clock = { now: Date.parse('2026-01-05T08:00:00.000Z') };
  const deps = buildDeps({ config, db, fetch: fake.fetch, logger, now: () => clock.now, timeouts: options.timeouts });
  const app = createApp(deps);

  const req = (pathname: string, o: ReqOptions = {}): Promise<Response> => {
    const headers: Record<string, string> = { origin: TEST_ORIGIN, ...o.headers };
    if (o.cookie) headers.cookie = o.cookie;
    let body: BodyInit | undefined;
    if (typeof o.body === 'string' || o.body instanceof Uint8Array) {
      body = o.body as BodyInit;
    } else if (o.body !== undefined) {
      body = JSON.stringify(o.body);
      headers['content-type'] ??= 'application/json';
    }
    return Promise.resolve(app.request(pathname, { method: o.method ?? 'GET', headers, body }));
  };

  const createUser = async (o: CreateUserOptions = {}): Promise<TestUser> => {
    const key = o.key ?? newLoginKey();
    const hash = await hashLoginKey(key);
    const fields: Record<string, unknown> = { name: o.name ?? 'Test User', role: o.role ?? 'Vertrieb', status: o.status ?? 'aktiv' };
    if (o.isAdmin) fields.is_admin = true;
    if (o.companies?.length) fields.allowed_companies = o.companies;
    const record = await db.write(async (tx) => {
      const r = await deps.records.insert(tx, 'User', fields);
      await deps.secrets.setApiKeyHash(tx, r.id, hash);
      return r;
    });
    return { id: record.id, key };
  };

  const login = async (key: string, longLived = false): Promise<string> => {
    const res = await req('/api/auth', { method: 'POST', body: { user_key: key, long_lived: longLived } });
    if (res.status !== 200) throw new Error(`login failed: ${res.status} ${await res.text()}`);
    return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  };

  return {
    app,
    deps,
    fake,
    logs,
    dataDir,
    clock,
    req,
    createUser,
    login,
    async loginAs(o: CreateUserOptions = {}) {
      const user = await createUser(o);
      return { ...user, cookie: await login(user.key) };
    },
    async close() {
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
```


- [ ] **Step 2: Write the failing test**

Create `test/auth.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LONG_TTL_MS, SHORT_TTL_MS } from '../server/auth/sessions.js';
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
```

Also update the unknown-path test in `test/http.test.ts`: once auth exists, unknown `/api` paths answer 401 when logged out and 404 when logged in.

Replace the whole content of `test/http.test.ts` with:

```ts
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

  it('unknown /api paths return JSON 401 when logged out and JSON 404 with no-store when logged in', async () => {
    expect((await ctx.req('/api/does-not-exist')).status).toBe(401);
    const { cookie } = await ctx.loginAs();
    const res = await ctx.req('/api/does-not-exist', { cookie });
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
```


- [ ] **Step 3: Run them to verify they fail**

Run:

```bash
npx vitest run test/auth.test.ts test/http.test.ts
```

Expected: FAIL — `test/auth.test.ts` cannot import `../server/auth/sessions.js`, and the updated unknown-path test in `test/http.test.ts` fails (1 of 10: the path still answers 404 instead of 401 when logged out).


- [ ] **Step 4: Implement sessions, rate limiting and user helpers**

Create `server/auth/sessions.ts`:

```ts
import { createHash } from 'node:crypto';
import type { Database } from '../db/database.js';
import { newSessionToken } from '../util/ids.js';

export const SHORT_TTL_MS = 8 * 60 * 60 * 1000;
export const LONG_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export interface SessionInfo {
  tokenHash: string;
  userId: string;
  expiresAt: number;
}

/** Sessions are stored by token hash only; the token itself lives only in the cookie. */
export class SessionStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  async create(userId: string, longLived: boolean, userAgent: string): Promise<{ token: string; ttlMs: number }> {
    const token = newSessionToken();
    const ttlMs = longLived ? LONG_TTL_MS : SHORT_TTL_MS;
    const now = this.now();
    await this.db.write((tx) =>
      tx.execute({
        sql: 'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, long_lived, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
        args: [hashToken(token), userId, now, now + ttlMs, longLived ? 1 : 0, userAgent.slice(0, 200)],
      }),
    );
    return { token, ttlMs };
  }

  /** Returns the session if it exists and has not expired (expired ones are deleted). */
  async lookup(token: string): Promise<SessionInfo | null> {
    const tokenHash = hashToken(token);
    const rows = await this.db.query('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?', [tokenHash]);
    const row = rows[0];
    if (!row) return null;
    const expiresAt = Number(row.expires_at);
    if (expiresAt <= this.now()) {
      await this.delete(tokenHash);
      return null;
    }
    return { tokenHash, userId: String(row.user_id), expiresAt };
  }

  async delete(tokenHash: string): Promise<void> {
    await this.db.write((tx) => tx.execute({ sql: 'DELETE FROM sessions WHERE token_hash = ?', args: [tokenHash] }));
  }

  async deleteForUser(userId: string): Promise<number> {
    const rs = await this.db.write((tx) => tx.execute({ sql: 'DELETE FROM sessions WHERE user_id = ?', args: [userId] }));
    return rs.rowsAffected;
  }

  async purgeExpired(): Promise<number> {
    const rs = await this.db.write((tx) =>
      tx.execute({ sql: 'DELETE FROM sessions WHERE expires_at <= ?', args: [this.now()] }),
    );
    return rs.rowsAffected;
  }
}
```

Create `server/auth/rateLimit.ts`:

```ts
export interface RateLimitOptions {
  perIp: number;
  global: number;
  windowMs: number;
}

const DEFAULTS: RateLimitOptions = { perIp: 5, global: 30, windowMs: 15 * 60 * 1000 };

/** Counts failed logins in memory (single server instance). */
export class LoginRateLimiter {
  private readonly byIp = new Map<string, number[]>();
  private all: number[] = [];
  private readonly opts: RateLimitOptions;

  constructor(
    opts: Partial<RateLimitOptions> = {},
    private readonly now: () => number = Date.now,
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  private recent(times: number[]): number[] {
    const cutoff = this.now() - this.opts.windowMs;
    return times.filter((t) => t > cutoff);
  }

  isBlocked(ip: string): boolean {
    this.all = this.recent(this.all);
    const mine = this.recent(this.byIp.get(ip) ?? []);
    if (mine.length === 0) this.byIp.delete(ip);
    else this.byIp.set(ip, mine);
    return mine.length >= this.opts.perIp || this.all.length >= this.opts.global;
  }

  recordFailure(ip: string): void {
    const t = this.now();
    this.all.push(t);
    this.byIp.set(ip, [...(this.byIp.get(ip) ?? []), t]);
  }
}
```

Create `server/auth/users.ts`:

```ts
import type { StoredRecord } from '../data/records.js';
import type { UserSecretInfo } from '../secrets/store.js';
import type { SessionUser } from '../types.js';

export const isActiveUser = (record: StoredRecord): boolean => record.fields.status === 'aktiv';

export function toSessionUser(record: StoredRecord): SessionUser {
  const f = record.fields;
  const companies = Array.isArray(f.allowed_companies) ? f.allowed_companies.filter((c) => typeof c === 'string') : [];
  return {
    id: record.id,
    name: typeof f.name === 'string' ? f.name : '',
    role: typeof f.role === 'string' ? f.role : '',
    isAdmin: f.is_admin === true,
    allowedCompanies: companies,
  };
}

/** Same shape as the old Val.town proxy's /auth and /me "user" object (minus the token). */
export function userPayload(user: SessionUser, info: UserSecretInfo) {
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    is_admin: user.isAdmin,
    allowed_companies: user.allowedCompanies,
    has_freshdesk_key: info.hasFreshdeskKey,
    freshdesk_company_keys: info.freshdeskCompanyKeys,
  };
}
```


- [ ] **Step 5: Implement the auth middleware and routes**

The cookie is `__Host-erp_session` (Secure) in production and `erp_session` otherwise, because browsers reject `Secure` cookies over plain http. The raw login key is accepted only by `POST /api/auth`. There is no Bearer fallback.

Create `server/auth/middleware.ts`:

```ts
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
```

Create `server/auth/routes.ts`:

```ts
import { Hono } from 'hono';
import type { AppDeps } from '../deps.js';
import { readJsonBody } from '../http/body.js';
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

  app.post('/auth', async (c) => {
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
```


- [ ] **Step 6: Wire them into the dependencies and the app**

Replace the whole content of `server/deps.ts` with:

```ts
import { LoginRateLimiter } from './auth/rateLimit.js';
import { SessionStore } from './auth/sessions.js';
import type { Config } from './config.js';
import { RecordStore } from './data/records.js';
import type { Database } from './db/database.js';
import { jsonLogger, type Logger } from './http/logger.js';
import { SecretStore } from './secrets/store.js';

export type FetchFn = typeof fetch;

export interface Timeouts {
  upstreamMs: number;
  anthropicMs: number;
}

export interface AppDeps {
  config: Config;
  db: Database;
  fetch: FetchFn;
  logger: Logger;
  now: () => number;
  timeouts: Timeouts;
  records: RecordStore;
  sessions: SessionStore;
  secrets: SecretStore;
  limiter: LoginRateLimiter;
}

export interface BuildDepsOptions {
  config: Config;
  db: Database;
  fetch?: FetchFn;
  logger?: Logger;
  now?: () => number;
  timeouts?: Partial<Timeouts>;
}

export function buildDeps(o: BuildDepsOptions): AppDeps {
  const now = o.now ?? Date.now;
  const records = new RecordStore(o.db, now);
  return {
    config: o.config,
    db: o.db,
    // Resolve globalThis.fetch lazily so tests can replace it.
    fetch: o.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    logger: o.logger ?? jsonLogger,
    now,
    timeouts: { upstreamMs: 60_000, anthropicMs: 300_000, ...o.timeouts },
    records,
    sessions: new SessionStore(o.db, now),
    secrets: new SecretStore(o.db, o.config.secretsKey),
    limiter: new LoginRateLimiter({}, now),
  };
}
```

Replace the whole content of `server/app.ts` with:

```ts
import { Hono } from 'hono';
import { originCheck, requireAuth } from './auth/middleware.js';
import { publicAuthRoutes, sessionRoutes } from './auth/routes.js';
import type { AppDeps } from './deps.js';
import { healthRoutes } from './http/health.js';
import { errorHandler, requestContext } from './http/requestContext.js';
import { securityHeaders } from './http/securityHeaders.js';
import { staticRoutes } from './http/static.js';
import type { AppEnv } from './types.js';
import { jsonError } from './util/errors.js';

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', requestContext(deps.logger));
  app.use('*', securityHeaders(deps.config));
  app.onError(errorHandler(deps.logger));
  app.notFound((c) => (c.req.path.startsWith('/api/') ? jsonError(c, 'NOT_FOUND', 'Nicht gefunden') : c.text('Not Found', 404)));

  app.route('/', healthRoutes(deps.db));
  app.route('/', staticRoutes(deps.config.rootDir));

  const api = new Hono<AppEnv>();
  api.use('*', async (c, next) => {
    await next();
    if (!c.res.headers.has('cache-control')) c.res.headers.set('cache-control', 'no-store');
  });
  api.use('*', originCheck(deps.config.publicOrigin));
  api.route('/', publicAuthRoutes(deps));
  // Everything registered below requires a valid session.
  api.use('*', requireAuth(deps));
  api.route('/', sessionRoutes(deps));
  app.route('/api', api);
  return app;
}
```


- [ ] **Step 7: Run the tests to verify they pass**

Run:

```bash
npx vitest run test/auth.test.ts test/http.test.ts
```

Expected: 27 tests pass.


- [ ] **Step 8: Run the whole suite, typecheck and lint**

Run:

```bash
npm test && npm run typecheck && npm run lint
```


- [ ] **Step 9: Commit**

```bash
git add server/auth server/deps.ts server/app.ts test/helpers/context.ts test/http.test.ts test/auth.test.ts
git commit -F - <<'EOF'
feat(server): add login, cookie sessions, login rate limit and origin check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FVrKcG5sQkpYKqUZGYjujR
EOF
```


---

### Task 7: Data API: Airtable-shaped CRUD, permissions, secret stripping, schema no-ops

**Files:**
- Create: server/data/permissions.ts, server/data/public.ts, server/data/routes.ts
- Modify: server/app.ts
- Test: test/data.test.ts

**Interfaces:**
- Consumes: `RecordStore`, field helpers (Task 4); `SecretStore` (Task 5); `requireAuth` mounting in `createApp` (Task 6); `limit`, `MB`, `readJsonBody` (Task 3).
- Produces: `assertCanRead(table, user)`, `assertCanWrite(table, user, op)`; `loadPublicExtras(deps, table, viewer)`, `toPublicRecord(table, record, viewer, extras): AirtableRecord`; `tableParam(c)`; `dataRoutes(deps)` serving `GET/POST /data/:table`, `GET/PATCH/DELETE /data/:table/:id`, `POST /schema/ensure-table`, `POST /schema/ensure-fields`.

- [ ] **Step 1: Write the failing test**

Create `test/data.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';

let ctx: TestContext;
let user: { id: string; cookie: string };
let admin: { id: string; cookie: string };

beforeEach(async () => {
  ctx = await createTestContext();
  user = await ctx.loginAs({ name: 'Nora' });
  admin = await ctx.loginAs({ name: 'Adam', isAdmin: true });
});
afterEach(async () => {
  await ctx.close();
});

const create = (table: string, fields: Record<string, unknown>, cookie = user.cookie) =>
  ctx.req(`/api/data/${table}`, { method: 'POST', cookie, body: { fields } });

describe('records CRUD in Airtable shape', () => {
  it('creates, reads, lists, updates and deletes', async () => {
    const created = await (await create('Customer', { name: 'Müller GmbH', company_id: ['recC1'], city: 'Fellbach' })).json();
    expect(created.id).toMatch(/^rec[A-Za-z0-9]{14}$/);
    expect(created.createdTime).toBe('2026-01-05T08:00:00.000Z');
    expect(created.fields).toEqual({ name: 'Müller GmbH', company_id: ['recC1'], city: 'Fellbach' });

    const one = await ctx.req(`/api/data/Customer/${created.id}`, { cookie: user.cookie });
    expect(await one.json()).toEqual(created);

    const list = await (await ctx.req('/api/data/Customer', { cookie: user.cookie })).json();
    expect(list).toEqual({ records: [created] });

    const patched = await ctx.req(`/api/data/Customer/${created.id}`, {
      method: 'PATCH',
      cookie: user.cookie,
      body: { fields: { city: '', phone: '0711' } },
    });
    expect((await patched.json()).fields).toEqual({ name: 'Müller GmbH', company_id: ['recC1'], phone: '0711' });

    const del = await ctx.req(`/api/data/Customer/${created.id}`, { method: 'DELETE', cookie: user.cookie });
    expect(await del.json()).toEqual({ id: created.id, deleted: true });
    expect((await ctx.req(`/api/data/Customer/${created.id}`, { cookie: user.cookie })).status).toBe(404);
  });

  it('returns all records, not just 100', async () => {
    await ctx.deps.db.write(async (tx) => {
      for (let i = 0; i < 250; i++) await ctx.deps.records.insert(tx, 'Article', { name: `A${i}` });
    });
    const list = await (await ctx.req('/api/data/Article', { cookie: user.cookie })).json();
    expect(list.records).toHaveLength(250);
  });

  it('supports the restricted formula, sort, maxRecords and fields[]', async () => {
    for (const [name, status] of [
      ['Beta', 'aktiv'],
      ['alpha', 'aktiv'],
      ['Gamma', 'archiviert'],
      ["O'Neil", 'aktiv'],
    ]) {
      await create('Supplier', { name, status });
    }
    const q = new URLSearchParams({
      filterByFormula: "{status}='aktiv'",
      'sort[0][field]': 'name',
      'sort[0][direction]': 'asc',
      maxRecords: '2',
    });
    q.append('fields[]', 'name');
    const res = await (await ctx.req(`/api/data/Supplier?${q.toString()}`, { cookie: user.cookie })).json();
    expect(res.records.map((r: { fields: unknown }) => r.fields)).toEqual([{ name: 'alpha' }, { name: 'Beta' }]);

    const quoted = new URLSearchParams({ filterByFormula: "{name}='O\\'Neil'" });
    const one = await (await ctx.req(`/api/data/Supplier?${quoted.toString()}`, { cookie: user.cookie })).json();
    expect(one.records).toHaveLength(1);

    const bad = await ctx.req(`/api/data/Supplier?${new URLSearchParams({ filterByFormula: 'FIND("a",{name})' })}`, {
      cookie: user.cookie,
    });
    expect(bad.status).toBe(400);
  });

  it('rejects unknown tables and missing records', async () => {
    expect((await ctx.req('/api/data/Secrets', { cookie: user.cookie })).status).toBe(404);
    expect((await ctx.req('/api/data/Customer/recNOPENOPENOPE12', { cookie: user.cookie })).status).toBe(404);
    const patch = await ctx.req('/api/data/Customer/recNOPENOPENOPE12', { method: 'PATCH', cookie: user.cookie, body: { fields: {} } });
    expect(patch.status).toBe(404);
    const del = await ctx.req('/api/data/Customer/recNOPENOPENOPE12', { method: 'DELETE', cookie: user.cookie });
    expect(del.status).toBe(404);
  });

  it('requires a session', async () => {
    expect((await ctx.req('/api/data/Customer')).status).toBe(401);
    expect((await ctx.req('/api/data/Customer', { method: 'POST', body: { fields: {} } })).status).toBe(401);
  });

  it('rejects secret fields, ignores lock fields, and limits the body to 5 MB', async () => {
    const secret = await create('Customer', { name: 'X', api_key: 'k' });
    expect(secret.status).toBe(400);
    expect((await secret.json()).error.message).toContain('Geheime Felder');
    const lock = await (await create('Customer', { name: 'Y', lock_user_id: 'recEVIL', lock_until: '2099-01-01' })).json();
    expect(lock.fields).toEqual({ name: 'Y' });
    const big = await create('Customer', { notes: 'x'.repeat(5 * 1024 * 1024 + 10) });
    expect(big.status).toBe(413);
    expect((await big.json()).error.type).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('permissions and secret removal', () => {
  it('lets every user read and write business records across companies', async () => {
    const a = await (await create('Customer', { name: 'A', company_id: ['recOTHERCOMPANY1'] })).json();
    const res = await ctx.req(`/api/data/Customer/${a.id}`, {
      method: 'PATCH',
      cookie: user.cookie,
      body: { fields: { name: 'A2' } },
    });
    expect(res.status).toBe(200);
  });

  it('shows non-admins only names of users; admins get everything except secrets', async () => {
    await ctx.deps.db.write((tx) => ctx.deps.secrets.mergeFreshdeskKeys(tx, user.id, { recC1: 'fd' }));
    const asUser = await (await ctx.req('/api/data/User', { cookie: user.cookie })).json();
    expect(asUser.records.map((r: { fields: unknown }) => r.fields)).toHaveLength(2);
    expect(asUser.records.map((r: { fields: unknown }) => r.fields)).toEqual(
      expect.arrayContaining([{ name: 'Nora' }, { name: 'Adam' }]),
    );

    const asAdmin = await (await ctx.req('/api/data/User', { cookie: admin.cookie })).json();
    const nora = asAdmin.records.find((r: { id: string }) => r.id === user.id);
    expect(nora.fields).toEqual({
      name: 'Nora',
      role: 'Vertrieb',
      status: 'aktiv',
      has_api_key: true,
      has_freshdesk_key: false,
      freshdesk_company_keys: ['recC1'],
    });
    expect(JSON.stringify(asAdmin)).not.toMatch(/scrypt|fd"/);
  });

  it('does not let non-admins probe hidden user fields through filters', async () => {
    const q = new URLSearchParams({ filterByFormula: "{status}='aktiv'" });
    const res = await (await ctx.req(`/api/data/User?${q}`, { cookie: user.cookie })).json();
    expect(res.records).toEqual([]);
  });

  it('allows only admins to write User and Company', async () => {
    expect((await create('User', { name: 'Hacker', is_admin: true })).status).toBe(403);
    expect((await create('Company', { name: 'NewCo' })).status).toBe(403);
    expect((await create('Company', { name: 'NewCo' }, admin.cookie)).status).toBe(200);
  });

  it('adds has_mailchimp_key to companies for everyone and never returns the key', async () => {
    const co = await (await create('Company', { name: 'FLP', status: 'aktiv', iban: 'DE38' }, admin.cookie)).json();
    await ctx.deps.db.write((tx) => ctx.deps.secrets.setMailchimpKey(tx, co.id, 'mc-secret-us21'));
    const list = await (await ctx.req('/api/data/Company', { cookie: user.cookie })).json();
    expect(list.records[0].fields).toEqual({ name: 'FLP', status: 'aktiv', iban: 'DE38', has_mailchimp_key: true });
    expect(JSON.stringify(list)).not.toContain('mc-secret');
  });

  it('strips secret-looking fields that exist in stored data', async () => {
    const r = await ctx.deps.db.write((tx) =>
      ctx.deps.records.insert(tx, 'Company', { name: 'Old', mailchimp_api_key: 'leak', webhook_secret: 'leak2' }),
    );
    const res = await (await ctx.req(`/api/data/Company/${r.id}`, { cookie: admin.cookie })).json();
    expect(JSON.stringify(res)).not.toContain('leak');
  });

  it('keeps the AI cost log write-only for non-admins', async () => {
    const entry = await create('AiUsageLog', { model: 'claude', input_tokens: 10, company_id: '' });
    expect(entry.status).toBe(200);
    expect((await entry.json()).fields).toEqual({ model: 'claude', input_tokens: 10 });
    expect((await ctx.req('/api/data/AiUsageLog', { cookie: user.cookie })).status).toBe(403);
    expect((await ctx.req('/api/data/AiUsageLog', { cookie: admin.cookie })).status).toBe(200);
  });
});

describe('schema no-ops', () => {
  it('accepts ensureTable/ensureFields for known tables and rejects unknown ones', async () => {
    const ok = await ctx.req('/api/schema/ensure-fields', {
      method: 'POST',
      cookie: user.cookie,
      body: { table: 'Company', fields: [{ name: 'brand_color', type: 'singleLineText' }] },
    });
    expect(await ok.json()).toEqual({ ok: true });
    const table = await ctx.req('/api/schema/ensure-table', { method: 'POST', cookie: user.cookie, body: { name: 'Order', fields: [] } });
    expect(table.status).toBe(200);
    const unknown = await ctx.req('/api/schema/ensure-table', { method: 'POST', cookie: user.cookie, body: { name: 'Hack', fields: [] } });
    expect(unknown.status).toBe(404);
  });
});
```


- [ ] **Step 2: Run it to verify it fails**

Run:

```bash
npx vitest run test/data.test.ts
```

Expected: FAIL — 11 of 14 tests fail because `/api/data/...` answers 404 (the routes are not mounted yet).


- [ ] **Step 3: Implement permissions and the public record view**

Company separation is a working context (spec D8): every logged-in user may read and write business tables. Only `Company`/`User` writes are admin-only, and `AiUsageLog` is write-only for non-admins. Filtering and sorting run on the *public* view, so non-admins cannot probe hidden `User` fields through `filterByFormula`.

Create `server/data/permissions.ts`:

```ts
import type { SessionUser } from '../types.js';
import { ApiError } from '../util/errors.js';
import type { TableName } from './tables.js';

export type WriteOperation = 'create' | 'update' | 'delete';

const forbidden = () => new ApiError('FORBIDDEN', 'Nur für Admins');

/** Business tables are open to every logged-in user (company separation is a UI working context). */
export function assertCanRead(table: TableName, user: SessionUser): void {
  if (table === 'AiUsageLog' && !user.isAdmin) throw forbidden();
}

export function assertCanWrite(table: TableName, user: SessionUser, op: WriteOperation): void {
  if (user.isAdmin) return;
  if (table === 'Company' || table === 'User') throw forbidden();
  if (table === 'AiUsageLog' && op !== 'create') throw forbidden();
}
```

Create `server/data/public.ts`:

```ts
import type { AppDeps } from '../deps.js';
import type { UserSecretInfo } from '../secrets/store.js';
import type { AirtableRecord, SessionUser } from '../types.js';
import { stripSecretFields } from './fields.js';
import type { StoredRecord } from './records.js';
import type { TableName } from './tables.js';

export interface PublicExtras {
  userSecrets?: Map<string, UserSecretInfo>;
  companiesWithMailchimp?: Set<string>;
}

export async function loadPublicExtras(deps: AppDeps, table: TableName, viewer: SessionUser): Promise<PublicExtras> {
  if (table === 'User' && viewer.isAdmin) return { userSecrets: await deps.secrets.allUserInfo() };
  if (table === 'Company') return { companiesWithMailchimp: await deps.secrets.companiesWithMailchimpKey() };
  return {};
}

/** The only way records leave the server: secrets removed, User restricted for non-admins, derived flags added. */
export function toPublicRecord(
  table: TableName,
  record: StoredRecord,
  viewer: SessionUser,
  extras: PublicExtras,
): AirtableRecord {
  let fields = stripSecretFields(record.fields);
  if (table === 'User') {
    if (!viewer.isAdmin) {
      fields = typeof fields.name === 'string' ? { name: fields.name } : {};
    } else {
      const info = extras.userSecrets?.get(record.id);
      fields = {
        ...fields,
        has_api_key: info?.hasApiKey ?? false,
        has_freshdesk_key: info?.hasFreshdeskKey ?? false,
        freshdesk_company_keys: info?.freshdeskCompanyKeys ?? [],
      };
    }
  }
  if (table === 'Company') {
    fields = { ...fields, has_mailchimp_key: extras.companiesWithMailchimp?.has(record.id) ?? false };
  }
  return { id: record.id, createdTime: record.createdTime, fields };
}
```


- [ ] **Step 4: Implement the data routes**

Create `server/data/routes.ts`:

```ts
import { Hono, type Context } from 'hono';
import type { AppDeps } from '../deps.js';
import { limit, MB, readJsonBody } from '../http/body.js';
import type { AppEnv } from '../types.js';
import { ApiError } from '../util/errors.js';
import {
  matchesConditions,
  parseFormula,
  parseMaxRecords,
  parseSort,
  prepareWriteFields,
  projectFields,
  sortRecords,
} from './fields.js';
import { assertCanRead, assertCanWrite } from './permissions.js';
import { loadPublicExtras, toPublicRecord } from './public.js';
import type { StoredRecord } from './records.js';
import { isTableName, type TableName } from './tables.js';

export function tableParam(c: Context<AppEnv>): TableName {
  const table = c.req.param('table') ?? '';
  if (!isTableName(table)) throw new ApiError('NOT_FOUND', `Unbekannte Tabelle: ${table}`);
  return table;
}

export function dataRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const present = async (c: Context<AppEnv>, table: TableName, record: StoredRecord) => {
    const user = c.get('user');
    return toPublicRecord(table, record, user, await loadPublicExtras(deps, table, user));
  };

  app.get('/data/:table', async (c) => {
    const table = tableParam(c);
    const user = c.get('user');
    assertCanRead(table, user);
    const params = new URL(c.req.url).searchParams;
    const conditions = parseFormula(params.get('filterByFormula') ?? '');
    const sorts = parseSort(params);
    const maxRecords = parseMaxRecords(params.get('maxRecords'));
    const onlyFields = params.getAll('fields[]');

    const extras = await loadPublicExtras(deps, table, user);
    // Filter and sort on the public view, so hidden fields can never be probed.
    let records = (await deps.records.list(table)).map((r) => toPublicRecord(table, r, user, extras));
    records = sortRecords(
      records.filter((r) => matchesConditions(r.fields, conditions)),
      sorts,
    );
    if (maxRecords !== undefined) records = records.slice(0, maxRecords);
    if (onlyFields.length > 0) records = records.map((r) => projectFields(r, onlyFields));
    return c.json({ records });
  });

  app.get('/data/:table/:id', async (c) => {
    const table = tableParam(c);
    assertCanRead(table, c.get('user'));
    const record = await deps.records.get(table, c.req.param('id'));
    if (!record) throw new ApiError('NOT_FOUND', 'Datensatz nicht gefunden');
    return c.json(await present(c, table, record));
  });

  app.post('/data/:table', limit(5 * MB), async (c) => {
    const table = tableParam(c);
    assertCanWrite(table, c.get('user'), 'create');
    const body = await readJsonBody(c);
    const { set } = prepareWriteFields(body.fields ?? {});
    const record = await deps.db.write((tx) => deps.records.insert(tx, table, set));
    return c.json(await present(c, table, record));
  });

  app.patch('/data/:table/:id', limit(5 * MB), async (c) => {
    const table = tableParam(c);
    assertCanWrite(table, c.get('user'), 'update');
    const id = c.req.param('id');
    const body = await readJsonBody(c);
    const { set, clear } = prepareWriteFields(body.fields ?? {});
    const record = await deps.db.write((tx) => deps.records.update(tx, table, id, set, clear));
    if (!record) throw new ApiError('NOT_FOUND', 'Datensatz nicht gefunden');
    return c.json(await present(c, table, record));
  });

  app.delete('/data/:table/:id', async (c) => {
    const table = tableParam(c);
    assertCanWrite(table, c.get('user'), 'delete');
    const id = c.req.param('id');
    const removed = await deps.db.write((tx) => deps.records.remove(tx, table, id));
    if (!removed) throw new ApiError('NOT_FOUND', 'Datensatz nicht gefunden');
    return c.json({ id, deleted: true });
  });

  // ensureTable / ensureFields are no-ops: every known table exists and fields need no schema.
  app.post('/schema/ensure-table', async (c) => {
    const body = await readJsonBody(c);
    if (typeof body.name !== 'string' || !isTableName(body.name)) {
      throw new ApiError('NOT_FOUND', 'Unbekannte Tabelle');
    }
    return c.json({ ok: true });
  });

  app.post('/schema/ensure-fields', async (c) => {
    const body = await readJsonBody(c);
    if (typeof body.table !== 'string' || !isTableName(body.table)) {
      throw new ApiError('NOT_FOUND', 'Unbekannte Tabelle');
    }
    return c.json({ ok: true });
  });

  return app;
}
```


- [ ] **Step 5: Mount the routes in `server/app.ts`**

In `server/app.ts`, replace:

```ts
import type { AppDeps } from './deps.js';
```

with:

```ts
import { dataRoutes } from './data/routes.js';
import type { AppDeps } from './deps.js';
```

In `server/app.ts`, replace:

```ts
  api.route('/', sessionRoutes(deps));
```

with:

```ts
  api.route('/', sessionRoutes(deps));
  api.route('/', dataRoutes(deps));
```


- [ ] **Step 6: Run the test to verify it passes**

Run:

```bash
npx vitest run test/data.test.ts
```

Expected: 14 tests pass.


- [ ] **Step 7: Run the whole suite, typecheck and lint**

Run:

```bash
npm test && npm run typecheck && npm run lint
```


- [ ] **Step 8: Commit**

```bash
git add server/data/permissions.ts server/data/public.ts server/data/routes.ts server/app.ts test/data.test.ts
git commit -F - <<'EOF'
feat(server): add Airtable-shaped data API with permissions and secret stripping

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FVrKcG5sQkpYKqUZGYjujR
EOF
```


---

### Task 8: Document numbers assigned on save

**Files:**
- Create: server/data/numbers.ts
- Modify: server/deps.ts, server/app.ts, server/data/routes.ts
- Test: test/numbers.test.ts

**Interfaces:**
- Consumes: `NUMBER_SPECS`, `numberSpecForTable`, `numberSpecForType` (Task 2); `Executor` (Task 2); `StoredRecord` (Task 4); data routes (Task 7).
- Produces: `companyOf(fields): string | null`; `class NumberService` with `next(exec, spec, companyId)`, `nextVariant(exec, companyId, variantOf)`, `applyOnCreate(exec, table, set, { assignNumber, variantOf })`, `checkOnUpdate(exec, table, existing, set)`; `numberRoutes(deps)` serving `GET /numbers/:type/next?company=…[&base=…]`. `AppDeps.numbers`. `POST /api/data/:table` accepts `{ fields, assignNumber?: true, variantOf?: "Q-1024" }`.

- [ ] **Step 1: Write the failing test**

Create `test/numbers.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';

let ctx: TestContext;
let cookie: string;

beforeEach(async () => {
  ctx = await createTestContext();
  ({ cookie } = await ctx.loginAs());
});
afterEach(async () => {
  await ctx.close();
});

const create = (table: string, body: Record<string, unknown>) => ctx.req(`/api/data/${table}`, { method: 'POST', cookie, body });
const seed = (table: 'Invoice' | 'Order' | 'Quote' | 'Customer', fields: Record<string, unknown>) =>
  ctx.deps.db.write((tx) => ctx.deps.records.insert(tx, table, fields));

describe('number assignment on create', () => {
  it('starts each type at its floor + 1 with the right prefix', async () => {
    const cases: [string, string, string, Record<string, unknown>][] = [
      ['Customer', 'customer_no', 'K-1001', { company_id: ['recC1'] }],
      ['Supplier', 'supplier_no', 'L-1001', { company_id: ['recC1'] }],
      ['Article', 'article_no', 'A-10001', { company_id: ['recC1'] }],
      ['Inquiry', 'inquiry_no', 'AN-1001', { company_id: ['recC1'] }],
      ['Quote', 'quote_no', 'Q-1001', { company_id: ['recC1'] }],
      ['Order', 'order_no', 'AB-1001', { company_id: 'recC1' }],
      ['SupplierOrder', 'purchase_no', 'B-1001', { company_id: 'recC1' }],
      ['DeliveryNote', 'delivery_no', 'L-1001', { company_id: 'recC1' }],
      ['Invoice', 'invoice_no', 'R-1001', { company_id: 'recC1' }],
    ];
    for (const [table, field, expected, fields] of cases) {
      const res = await create(table, { fields, assignNumber: true });
      expect(res.status).toBe(200);
      expect((await res.json()).fields[field]).toBe(expected);
    }
  });

  it('continues after the highest existing number of the same company, matching string and array company_id', async () => {
    await seed('Order', { company_id: 'recC1', order_no: 'AB-1041' });
    await seed('Order', { company_id: ['recC1'], order_no: 'AB-1099' });
    await seed('Order', { company_id: 'recC2', order_no: 'AB-5000' });
    await seed('Order', { company_id: 'recC1', order_no: 'AB-99999-alt' });
    const res = await create('Order', { fields: { company_id: ['recC1'], customer_id: 'recK' }, assignNumber: true });
    expect((await res.json()).fields.order_no).toBe('AB-1100');
    const other = await create('Order', { fields: { company_id: 'recC3' }, assignNumber: true });
    expect((await other.json()).fields.order_no).toBe('AB-1001');
  });

  it('overwrites a client-supplied number when assignNumber is set', async () => {
    const res = await create('Invoice', { fields: { company_id: 'recC1', invoice_no: 'R-1' }, assignNumber: true });
    expect((await res.json()).fields.invoice_no).toBe('R-1001');
  });

  it('gives 20 simultaneous invoices 20 unique consecutive numbers', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => create('Invoice', { fields: { company_id: 'recC1' }, assignNumber: true })),
    );
    const numbers = await Promise.all(results.map(async (r) => (await r.json()).fields.invoice_no as string));
    const sorted = [...numbers].sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
    expect(sorted).toEqual(Array.from({ length: 20 }, (_, i) => `R-${1001 + i}`));
  });

  it('creates quote variants', async () => {
    await seed('Quote', { company_id: ['recC1'], quote_no: 'Q-1024' });
    await seed('Quote', { company_id: ['recC1'], quote_no: 'Q-1024.1' });
    await seed('Quote', { company_id: ['recC1'], quote_no: 'Q-1024.2' });
    await seed('Quote', { company_id: ['recC2'], quote_no: 'Q-1024.7' });
    const res = await create('Quote', { fields: { company_id: ['recC1'] }, variantOf: 'Q-1024.1' });
    expect((await res.json()).fields.quote_no).toBe('Q-1024.3');
    expect((await create('Order', { fields: { company_id: 'recC1' }, variantOf: 'Q-1' })).status).toBe(400);
    expect((await create('Quote', { fields: { company_id: ['recC1'] }, variantOf: 'nonsense' })).status).toBe(400);
  });

  it('requires a company and a numbered table', async () => {
    expect((await create('Invoice', { fields: {}, assignNumber: true })).status).toBe(400);
    expect((await create('Contact', { fields: { company_id: ['recC1'] }, assignNumber: true })).status).toBe(400);
  });
});

describe('duplicate guard', () => {
  it('refuses a hand-typed duplicate on create and update within the same company', async () => {
    await seed('Invoice', { company_id: 'recC1', invoice_no: 'R-1005' });
    const dup = await create('Invoice', { fields: { company_id: 'recC1', invoice_no: 'R-1005' } });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({ error: { type: 'DUPLICATE_NUMBER', message: 'Nummer bereits vergeben: R-1005' } });
    expect((await create('Invoice', { fields: { company_id: 'recC2', invoice_no: 'R-1005' } })).status).toBe(200);

    const other = await seed('Invoice', { company_id: 'recC1', invoice_no: 'R-1006' });
    const upd = await ctx.req(`/api/data/Invoice/${other.id}`, {
      method: 'PATCH',
      cookie,
      body: { fields: { invoice_no: 'R-1005' } },
    });
    expect(upd.status).toBe(409);
  });

  it('leaves legacy duplicates alone unless the number is changed', async () => {
    const a = await seed('Invoice', { company_id: 'recC1', invoice_no: 'R-1010' });
    await seed('Invoice', { company_id: 'recC1', invoice_no: 'R-1010' });
    const res = await ctx.req(`/api/data/Invoice/${a.id}`, {
      method: 'PATCH',
      cookie,
      body: { fields: { invoice_no: 'R-1010', status: 'Bezahlt' } },
    });
    expect(res.status).toBe(200);
  });
});

describe('GET /api/numbers/:type/next', () => {
  it('previews without reserving', async () => {
    await seed('Invoice', { company_id: 'recC1', invoice_no: 'R-1200' });
    const peek = async () => (await (await ctx.req('/api/numbers/invoice/next?company=recC1', { cookie })).json()).number;
    expect(await peek()).toBe('R-1201');
    expect(await peek()).toBe('R-1201');
    await seed('Quote', { company_id: ['recC1'], quote_no: 'Q-2000' });
    const variant = await ctx.req('/api/numbers/quote/next?company=recC1&base=Q-2000', { cookie });
    expect(await variant.json()).toEqual({ number: 'Q-2000.1' });
  });

  it('validates type, company and base', async () => {
    expect((await ctx.req('/api/numbers/foo/next?company=recC1', { cookie })).status).toBe(404);
    expect((await ctx.req('/api/numbers/invoice/next', { cookie })).status).toBe(400);
    expect((await ctx.req('/api/numbers/invoice/next?company=recC1&base=Q-1', { cookie })).status).toBe(400);
  });
});
```


- [ ] **Step 2: Run it to verify it fails**

Run:

```bash
npx vitest run test/numbers.test.ts
```

Expected: FAIL — 9 of 10 tests fail: no number is assigned (`expected undefined to be 'K-1001'`) and `/api/numbers/...` answers 404.


- [ ] **Step 3: Implement the number service**

Numbers are computed inside the same write transaction as the insert. Write transactions are queued in-process (Task 2), so "read the highest number, add one, insert" cannot interleave. `company_id` is a string on some tables and an array on others, and `json_each` matches both.

Create `server/data/numbers.ts`:

```ts
import { Hono } from 'hono';
import type { Executor } from '../db/database.js';
import type { AppDeps } from '../deps.js';
import type { AppEnv } from '../types.js';
import { ApiError } from '../util/errors.js';
import type { StoredRecord } from './records.js';
import { numberSpecForTable, numberSpecForType, type NumberSpec, type TableName } from './tables.js';

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** company_id is a plain string on some tables and an array of record ids on others. */
export function companyOf(fields: Record<string, unknown>): string | null {
  const v = fields.company_id;
  if (typeof v === 'string' && v !== '') return v;
  if (Array.isArray(v)) {
    const first = v.find((x): x is string => typeof x === 'string' && x !== '');
    return first ?? null;
  }
  return null;
}

export interface CreateNumberOptions {
  assignNumber: boolean;
  variantOf: unknown;
}

/**
 * Document numbers. Every method runs inside the caller's write transaction; write
 * transactions are serialized, so "read highest, add one, insert" cannot race.
 */
export class NumberService {
  private async valuesForCompany(exec: Executor, spec: NumberSpec, companyId: string) {
    const rs = await exec.execute({
      sql: `SELECT id, json_extract(fields, '$.${spec.field}') AS value FROM "${spec.table}"
            WHERE EXISTS (SELECT 1 FROM json_each("${spec.table}".fields, '$.company_id') WHERE json_each.value = ?)`,
      args: [companyId],
    });
    return rs.rows
      .filter((row) => row.value !== null && row.value !== undefined)
      .map((row) => ({ id: String(row.id), value: String(row.value) }));
  }

  async next(exec: Executor, spec: NumberSpec, companyId: string): Promise<string> {
    const pattern = new RegExp(`^${escapeRegex(spec.prefix)}(\\d+)$`);
    let highest = spec.floor;
    for (const { value } of await this.valuesForCompany(exec, spec, companyId)) {
      const m = pattern.exec(value);
      if (m?.[1]) highest = Math.max(highest, Number(m[1]));
    }
    return `${spec.prefix}${highest + 1}`;
  }

  /** "Q-1024" or "Q-1024.2" -> "Q-1024.<highest existing variant + 1>". */
  async nextVariant(exec: Executor, companyId: string, variantOf: string): Promise<string> {
    const base = /^(Q-\d+)(?:\.\d+)?$/.exec(variantOf.trim())?.[1];
    if (!base) throw new ApiError('INVALID_REQUEST', `Ungültige Angebotsnummer für Variante: ${variantOf}`);
    const spec = numberSpecForType('quote');
    if (!spec) throw new Error('quote number spec missing');
    const pattern = new RegExp(`^${escapeRegex(base)}\\.(\\d+)$`);
    let highest = 0;
    for (const { value } of await this.valuesForCompany(exec, spec, companyId)) {
      const m = pattern.exec(value);
      if (m?.[1]) highest = Math.max(highest, Number(m[1]));
    }
    return `${base}.${highest + 1}`;
  }

  private async assertUnique(exec: Executor, spec: NumberSpec, companyId: string, value: string, excludeId: string | null) {
    const clash = (await this.valuesForCompany(exec, spec, companyId)).some(
      (row) => row.value === value && row.id !== excludeId,
    );
    if (clash) throw new ApiError('DUPLICATE_NUMBER', `Nummer bereits vergeben: ${value}`);
  }

  /** Assigns a number (assignNumber / variantOf) or checks a client-supplied one. Mutates `set`. */
  async applyOnCreate(exec: Executor, table: TableName, set: Record<string, unknown>, opts: CreateNumberOptions): Promise<void> {
    const spec = numberSpecForTable(table);
    const wantsVariant = typeof opts.variantOf === 'string' && opts.variantOf !== '';
    if (opts.assignNumber || wantsVariant) {
      if (!spec) throw new ApiError('INVALID_REQUEST', 'Diese Tabelle hat keine Belegnummern');
      if (wantsVariant && spec.type !== 'quote') throw new ApiError('INVALID_REQUEST', 'Varianten gibt es nur für Angebote');
      const companyId = companyOf(set);
      if (!companyId) throw new ApiError('INVALID_REQUEST', 'company_id fehlt für die Nummernvergabe');
      set[spec.field] = wantsVariant
        ? await this.nextVariant(exec, companyId, String(opts.variantOf))
        : await this.next(exec, spec, companyId);
      return;
    }
    if (spec && set[spec.field] !== undefined) {
      const companyId = companyOf(set);
      if (companyId) await this.assertUnique(exec, spec, companyId, String(set[spec.field]), null);
    }
  }

  /** Refuses changing a number to one that already exists in the same company. */
  async checkOnUpdate(exec: Executor, table: TableName, existing: StoredRecord, set: Record<string, unknown>): Promise<void> {
    const spec = numberSpecForTable(table);
    if (!spec || set[spec.field] === undefined) return;
    const value = String(set[spec.field]);
    if (value === String(existing.fields[spec.field] ?? '')) return;
    const companyId = companyOf({ ...existing.fields, ...set });
    if (companyId) await this.assertUnique(exec, spec, companyId, value, existing.id);
  }
}

/** GET /numbers/:type/next — preview only, nothing is reserved. */
export function numberRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get('/numbers/:type/next', async (c) => {
    const spec = numberSpecForType(c.req.param('type'));
    if (!spec) throw new ApiError('NOT_FOUND', 'Unbekannter Nummerntyp');
    const companyId = c.req.query('company') ?? '';
    if (!companyId) throw new ApiError('INVALID_REQUEST', 'company fehlt');
    const base = c.req.query('base');
    if (base && spec.type !== 'quote') throw new ApiError('INVALID_REQUEST', 'Varianten gibt es nur für Angebote');
    const number = base
      ? await deps.numbers.nextVariant(deps.db.client, companyId, base)
      : await deps.numbers.next(deps.db.client, spec, companyId);
    return c.json({ number });
  });
  return app;
}
```


- [ ] **Step 4: Add the service to `server/deps.ts`**

In `server/deps.ts`, replace:

```ts
import { RecordStore } from './data/records.js';
```

with:

```ts
import { NumberService } from './data/numbers.js';
import { RecordStore } from './data/records.js';
```

In `server/deps.ts`, replace:

```ts
  limiter: LoginRateLimiter;
}
```

with:

```ts
  limiter: LoginRateLimiter;
  numbers: NumberService;
}
```

In `server/deps.ts`, replace:

```ts
    limiter: new LoginRateLimiter({}, now),
  };
```

with:

```ts
    limiter: new LoginRateLimiter({}, now),
    numbers: new NumberService(),
  };
```


- [ ] **Step 5: Use it in the create and update handlers of `server/data/routes.ts`**

In `server/data/routes.ts`, replace:

```ts
    const record = await deps.db.write((tx) => deps.records.insert(tx, table, set));
```

with:

```ts
    const record = await deps.db.write(async (tx) => {
      await deps.numbers.applyOnCreate(tx, table, set, { assignNumber: body.assignNumber === true, variantOf: body.variantOf });
      return deps.records.insert(tx, table, set);
    });
```

In `server/data/routes.ts`, replace:

```ts
    const record = await deps.db.write((tx) => deps.records.update(tx, table, id, set, clear));
```

with:

```ts
    const record = await deps.db.write(async (tx) => {
      const existing = await deps.records.get(table, id, tx);
      if (!existing) return null;
      await deps.numbers.checkOnUpdate(tx, table, existing, set);
      return deps.records.update(tx, table, id, set, clear);
    });
```


- [ ] **Step 6: Mount the preview route in `server/app.ts`**

In `server/app.ts`, replace:

```ts
import { dataRoutes } from './data/routes.js';
```

with:

```ts
import { numberRoutes } from './data/numbers.js';
import { dataRoutes } from './data/routes.js';
```

In `server/app.ts`, replace:

```ts
  api.route('/', dataRoutes(deps));
```

with:

```ts
  api.route('/', dataRoutes(deps));
  api.route('/', numberRoutes(deps));
```


- [ ] **Step 7: Run the test to verify it passes**

Run:

```bash
npx vitest run test/numbers.test.ts
```

Expected: 10 tests pass, including 20 simultaneous invoices → R-1001 … R-1020.


- [ ] **Step 8: Run the whole suite, typecheck and lint**

Run:

```bash
npm test && npm run typecheck && npm run lint
```


- [ ] **Step 9: Commit**

```bash
git add server/data/numbers.ts server/deps.ts server/app.ts server/data/routes.ts test/numbers.test.ts
git commit -F - <<'EOF'
feat(server): assign document numbers on save without duplicates

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FVrKcG5sQkpYKqUZGYjujR
EOF
```


---

### Task 9: Record locks

**Files:**
- Create: server/data/locks.ts
- Modify: server/deps.ts, server/app.ts
- Test: test/locks.test.ts

**Interfaces:**
- Consumes: `LOCKABLE_TABLES`, `isTableName` (Task 2); `RecordStore` (Task 4); `SessionUser` (Task 3).
- Produces: `LOCK_TTL_MS`; `class LockService(db, records, now)` with `acquire(table, id, user): Promise<LockResult>`, `release(table, id, user)`; `type LockResult = { ok: true; until } | { ok: false; locked_by: { id; name }; until }`; `lockRoutes(deps)` serving `POST /locks/:table/:id`, `…/refresh`, `…/release`. `AppDeps.locks`.

- [ ] **Step 1: Write the failing test**

Create `test/locks.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOCK_TTL_MS } from '../server/data/locks.js';
import { createTestContext, type TestContext } from './helpers/context.js';

let ctx: TestContext;
let anna: { id: string; cookie: string };
let ben: { id: string; cookie: string };
let quoteId: string;

beforeEach(async () => {
  ctx = await createTestContext();
  anna = await ctx.loginAs({ name: 'Anna' });
  ben = await ctx.loginAs({ name: 'Ben' });
  quoteId = (await ctx.deps.db.write((tx) => ctx.deps.records.insert(tx, 'Quote', { quote_no: 'Q-1001' }))).id;
});
afterEach(async () => {
  await ctx.close();
});

const lock = (cookie: string, suffix = '', table = 'Quote', id = quoteId) =>
  ctx.req(`/api/locks/${table}/${id}${suffix}`, { method: 'POST', cookie });
const lockFields = async () => (await ctx.deps.records.get('Quote', quoteId))?.fields;

describe('record locks', () => {
  it('lets the first user lock for 5 minutes and tells others who holds it', async () => {
    const res = await (await lock(anna.cookie)).json();
    const until = new Date(ctx.clock.now + LOCK_TTL_MS).toISOString();
    expect(res).toEqual({ ok: true, until });
    expect(await lockFields()).toMatchObject({ lock_user_id: anna.id, lock_until: until });

    expect(await (await lock(ben.cookie)).json()).toEqual({ ok: false, locked_by: { id: anna.id, name: 'Anna' }, until });
  });

  it('refresh extends the holder lock; others can take over after expiry', async () => {
    await lock(anna.cookie);
    ctx.clock.now += 2 * 60 * 1000;
    const refreshed = await (await lock(anna.cookie, '/refresh')).json();
    expect(refreshed.until).toBe(new Date(ctx.clock.now + LOCK_TTL_MS).toISOString());
    ctx.clock.now += LOCK_TTL_MS + 1;
    expect((await (await lock(ben.cookie)).json()).ok).toBe(true);
    expect((await lockFields())?.lock_user_id).toBe(ben.id);
  });

  it('release clears only your own or expired locks, and accepts beacon requests', async () => {
    await lock(anna.cookie);
    const beacon = await ctx.req(`/api/locks/Quote/${quoteId}/release`, {
      method: 'POST',
      cookie: ben.cookie,
      body: 'ignored',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
    });
    expect(await beacon.json()).toEqual({ ok: true });
    expect((await lockFields())?.lock_user_id).toBe(anna.id);

    await lock(anna.cookie, '/release');
    expect(await lockFields()).toEqual({ quote_no: 'Q-1001' });
    expect((await ctx.req('/api/locks/Quote/recGONEGONEGONE12/release', { method: 'POST', cookie: anna.cookie })).status).toBe(200);
  });

  it('never lets the normal data API set lock fields', async () => {
    await lock(anna.cookie);
    await ctx.req(`/api/data/Quote/${quoteId}`, {
      method: 'PATCH',
      cookie: ben.cookie,
      body: { fields: { lock_user_id: ben.id, lock_until: '2099-01-01T00:00:00.000Z', quote_title: 'X' } },
    });
    expect(await lockFields()).toMatchObject({ lock_user_id: anna.id, quote_title: 'X' });
  });

  it('keeps locks advisory: saving a record locked by someone else still works', async () => {
    await lock(anna.cookie);
    const res = await ctx.req(`/api/data/Quote/${quoteId}`, { method: 'PATCH', cookie: ben.cookie, body: { fields: { status: 'x' } } });
    expect(res.status).toBe(200);
  });

  it('rejects non-lockable tables and missing records', async () => {
    const item = await ctx.deps.db.write((tx) => ctx.deps.records.insert(tx, 'QuoteItem', {}));
    expect((await lock(anna.cookie, '', 'QuoteItem', item.id)).status).toBe(400);
    expect((await lock(anna.cookie, '', 'Quote', 'recGONEGONEGONE12')).status).toBe(404);
    expect((await lock(anna.cookie, '', 'Nope', quoteId)).status).toBe(404);
  });
});
```


- [ ] **Step 2: Run it to verify it fails**

Run:

```bash
npx vitest run test/locks.test.ts
```

Expected: FAIL — `server/data/locks.js` not found.


- [ ] **Step 3: Implement the lock service and routes**

Create `server/data/locks.ts`:

```ts
import { Hono, type Handler } from 'hono';
import type { Database } from '../db/database.js';
import type { AppDeps } from '../deps.js';
import type { AppEnv, SessionUser } from '../types.js';
import { ApiError } from '../util/errors.js';
import type { RecordStore } from './records.js';
import { isTableName, LOCKABLE_TABLES, type TableName } from './tables.js';

export const LOCK_TTL_MS = 5 * 60 * 1000;

export type LockResult =
  | { ok: true; until: string }
  | { ok: false; locked_by: { id: string; name: string }; until: string };

/** Advisory record locks stored in the record's lock_user_id / lock_until fields (as today). */
export class LockService {
  constructor(
    private readonly db: Database,
    private readonly records: RecordStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** Takes or extends the lock unless another user holds a valid one. */
  acquire(table: TableName, id: string, user: SessionUser): Promise<LockResult> {
    return this.db.write(async (tx) => {
      const record = await this.records.get(table, id, tx);
      if (!record) throw new ApiError('NOT_FOUND', 'Datensatz nicht gefunden');
      const holder = record.fields.lock_user_id;
      const until = Date.parse(String(record.fields.lock_until ?? ''));
      if (typeof holder === 'string' && holder !== '' && holder !== user.id && until > this.now()) {
        const holderRecord = await this.records.get('User', holder, tx);
        const name = typeof holderRecord?.fields.name === 'string' ? holderRecord.fields.name : 'einem anderen Benutzer';
        return { ok: false, locked_by: { id: holder, name }, until: new Date(until).toISOString() };
      }
      const newUntil = new Date(this.now() + LOCK_TTL_MS).toISOString();
      await this.records.update(tx, table, id, { lock_user_id: user.id, lock_until: newUntil }, []);
      return { ok: true, until: newUntil };
    });
  }

  /** Clears the lock if the caller holds it or it has expired. Missing records are fine. */
  release(table: TableName, id: string, user: SessionUser): Promise<void> {
    return this.db.write(async (tx) => {
      const record = await this.records.get(table, id, tx);
      if (!record) return;
      const holder = record.fields.lock_user_id;
      const until = Date.parse(String(record.fields.lock_until ?? ''));
      const expired = !(until > this.now());
      if (holder === undefined || holder === user.id || expired) {
        await this.records.update(tx, table, id, {}, ['lock_user_id', 'lock_until']);
      }
    });
  }
}

function lockableTable(name: string): TableName {
  if (!isTableName(name)) throw new ApiError('NOT_FOUND', `Unbekannte Tabelle: ${name}`);
  if (!LOCKABLE_TABLES.has(name)) throw new ApiError('INVALID_REQUEST', 'Diese Tabelle unterstützt keine Sperren');
  return name;
}

export function lockRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const acquire: Handler<AppEnv> = async (c) =>
    c.json(await deps.locks.acquire(lockableTable(c.req.param('table') ?? ''), c.req.param('id') ?? '', c.get('user')));

  app.post('/locks/:table/:id', acquire);
  app.post('/locks/:table/:id/refresh', acquire);
  // Works with navigator.sendBeacon: the body is ignored.
  app.post('/locks/:table/:id/release', async (c) => {
    await deps.locks.release(lockableTable(c.req.param('table')), c.req.param('id'), c.get('user'));
    return c.json({ ok: true });
  });
  return app;
}
```


- [ ] **Step 4: Add the service to `server/deps.ts`**

In `server/deps.ts`, replace:

```ts
import { NumberService } from './data/numbers.js';
```

with:

```ts
import { LockService } from './data/locks.js';
import { NumberService } from './data/numbers.js';
```

In `server/deps.ts`, replace:

```ts
  numbers: NumberService;
}
```

with:

```ts
  numbers: NumberService;
  locks: LockService;
}
```

In `server/deps.ts`, replace:

```ts
    numbers: new NumberService(),
  };
```

with:

```ts
    numbers: new NumberService(),
    locks: new LockService(o.db, records, now),
  };
```


- [ ] **Step 5: Mount the routes in `server/app.ts`**

In `server/app.ts`, replace:

```ts
import { numberRoutes } from './data/numbers.js';
```

with:

```ts
import { lockRoutes } from './data/locks.js';
import { numberRoutes } from './data/numbers.js';
```

In `server/app.ts`, replace:

```ts
  api.route('/', numberRoutes(deps));
```

with:

```ts
  api.route('/', numberRoutes(deps));
  api.route('/', lockRoutes(deps));
```


- [ ] **Step 6: Run the test to verify it passes**

Run:

```bash
npx vitest run test/locks.test.ts
```

Expected: 6 tests pass.


- [ ] **Step 7: Run the whole suite, typecheck and lint**

Run:

```bash
npm test && npm run typecheck && npm run lint
```


- [ ] **Step 8: Commit**

```bash
git add server/data/locks.ts server/deps.ts server/app.ts test/locks.test.ts
git commit -F - <<'EOF'
feat(server): add server-side record locks with beacon-friendly release

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FVrKcG5sQkpYKqUZGYjujR
EOF
```


---

### Task 10: File uploads and downloads

**Files:**
- Create: server/data/files.ts
- Modify: server/deps.ts, server/app.ts, server/data/routes.ts
- Test: test/files.test.ts

**Interfaces:**
- Consumes: `attachmentFieldRule` (Task 2); `newAttachmentId` (Task 2); `loadPublicExtras`, `toPublicRecord` (Task 7); `limit`, `MB`, `readJsonBody`, `isPlainObject` (Task 3).
- Produces: `MAX_FILE_BYTES`; `interface AttachmentValue { id; url; filename; size; type }`; `sanitizeFilename(name)`; `class FileStore(db, dataDir, now)` with `save(tx, { table, recordId, field, filename, contentType, data, createdBy, id? })`, `get(id)`, `absolutePath(file)`, `normalizeAttachmentFields(exec, table, recordId|null, set)`; `fileRoutes(deps)` serving `POST /data/:table/:id/files/:field` and `GET /files/:id/:filename`. `AppDeps.files`.

- [ ] **Step 1: Write the failing test**

Create `test/files.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sanitizeFilename } from '../server/data/files.js';
import { createTestContext, type TestContext } from './helpers/context.js';

let ctx: TestContext;
let user: { id: string; cookie: string };
let admin: { id: string; cookie: string };
let attachmentId: string;
let companyId: string;

const PDF = Buffer.from('%PDF-1.4 test file');

beforeEach(async () => {
  ctx = await createTestContext();
  user = await ctx.loginAs();
  admin = await ctx.loginAs({ isAdmin: true });
  attachmentId = (await ctx.deps.db.write((tx) => ctx.deps.records.insert(tx, 'Attachment', { name: 'Datenblatt' }))).id;
  companyId = (await ctx.deps.db.write((tx) => ctx.deps.records.insert(tx, 'Company', { name: 'FLP' }))).id;
});
afterEach(async () => {
  await ctx.close();
});

const upload = (cookie: string, table: string, id: string, field: string, data: Buffer, filename: string, contentType = 'application/pdf') =>
  ctx.req(`/api/data/${table}/${id}/files/${field}`, {
    method: 'POST',
    cookie,
    body: { contentType, file: data.toString('base64'), filename },
  });

describe('file upload and download', () => {
  it('stores the file, appends it to the field and serves it back with umlaut-safe headers', async () => {
    const res = await upload(user.cookie, 'Attachment', attachmentId, 'file', PDF, 'Angebot Müller & Söhne.pdf');
    expect(res.status).toBe(200);
    const record = await res.json();
    const [att] = record.fields.file;
    expect(att).toEqual({
      id: expect.stringMatching(/^att[A-Za-z0-9]{14}$/),
      url: `/api/files/${att.id}/${encodeURIComponent('Angebot Müller & Söhne.pdf')}`,
      filename: 'Angebot Müller & Söhne.pdf',
      size: PDF.length,
      type: 'application/pdf',
    });

    const file = await ctx.req(att.url, { cookie: user.cookie });
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer()).equals(PDF)).toBe(true);
    expect(file.headers.get('content-type')).toBe('application/pdf');
    expect(file.headers.get('content-disposition')).toBe(
      `inline; filename="Angebot M_ller & S_hne.pdf"; filename*=UTF-8''${encodeURIComponent('Angebot Müller & Söhne.pdf')}`,
    );
    expect(file.headers.get('cache-control')).toBe('private, max-age=300');
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await ctx.req(att.url)).status).toBe(401);
  });

  it('keeps earlier files when uploading more and allows removing via PATCH [{id}]', async () => {
    const a = (await (await upload(user.cookie, 'Attachment', attachmentId, 'file', PDF, 'a.pdf')).json()).fields.file[0];
    const both = (await (await upload(user.cookie, 'Attachment', attachmentId, 'file', PDF, 'b.pdf')).json()).fields.file;
    expect(both.map((f: { filename: string }) => f.filename)).toEqual(['a.pdf', 'b.pdf']);
    const patched = await ctx.req(`/api/data/Attachment/${attachmentId}`, {
      method: 'PATCH',
      cookie: user.cookie,
      body: { fields: { file: [{ id: a.id }] } },
    });
    expect((await patched.json()).fields.file).toEqual([a]);
    // Removed files stay on disk.
    const stored = await ctx.deps.files.get(both[1].id);
    expect(stored).not.toBeNull();
  });

  it('rejects forged attachment values', async () => {
    const forged = await ctx.req(`/api/data/Attachment/${attachmentId}`, {
      method: 'PATCH',
      cookie: user.cookie,
      body: { fields: { file: [{ id: 'attFAKEFAKEFAKE12', url: 'https://evil.example/x.pdf' }] } },
    });
    expect(forged.status).toBe(422);
    const onCreate = await ctx.req('/api/data/Attachment', {
      method: 'POST',
      cookie: user.cookie,
      body: { fields: { name: 'x', file: [{ url: 'https://evil.example/x.pdf' }] } },
    });
    expect(onCreate.status).toBe(422);
  });

  it('enforces the field allowlist, admin-only logos and the 5 MB limit', async () => {
    expect((await upload(user.cookie, 'Customer', attachmentId, 'file', PDF, 'x.pdf')).status).toBe(400);
    expect((await upload(user.cookie, 'Company', companyId, 'logo', PDF, 'logo.png', 'image/png')).status).toBe(403);
    expect((await upload(admin.cookie, 'Company', companyId, 'logo', PDF, 'logo.png', 'image/png')).status).toBe(200);
    const big = await upload(user.cookie, 'Attachment', attachmentId, 'file', Buffer.alloc(5 * 1024 * 1024 + 1), 'big.pdf');
    expect(big.status).toBe(413);
    expect((await upload(user.cookie, 'Attachment', 'recGONEGONEGONE12', 'file', PDF, 'x.pdf')).status).toBe(404);
  });

  it('writes files under DATA_DIR/files/<id>/ with a sanitized name', async () => {
    const att = (await (await upload(user.cookie, 'Attachment', attachmentId, 'file', PDF, '../../etc/passwd')).json()).fields.file[0];
    expect(att.filename).toBe('_.._etc_passwd');
    const onDisk = await readFile(path.join(ctx.dataDir, 'files', att.id, '_.._etc_passwd'));
    expect(onDisk.equals(PDF)).toBe(true);
    expect(sanitizeFilename('')).toBe('datei');
    expect(sanitizeFilename('..hidden')).toBe('hidden');
  });

  it('serves unknown ids as 404 and non-image files as attachment downloads', async () => {
    expect((await ctx.req('/api/files/attNOPENOPENOPE12/x', { cookie: user.cookie })).status).toBe(404);
    const att = (await (await upload(user.cookie, 'Attachment', attachmentId, 'file', Buffer.from('a;b'), 'liste.csv', 'text/csv')).json()).fields.file[0];
    const res = await ctx.req(att.url, { cookie: user.cookie });
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; /);
  });
});
```


- [ ] **Step 2: Run it to verify it fails**

Run:

```bash
npx vitest run test/files.test.ts
```

Expected: FAIL — `server/data/files.js` not found.


- [ ] **Step 3: Implement the file store and routes**

Create `server/data/files.ts`:

```ts
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Row } from '@libsql/client';
import { Hono } from 'hono';
import type { Database, Executor } from '../db/database.js';
import type { AppDeps } from '../deps.js';
import { isPlainObject, limit, MB, readJsonBody } from '../http/body.js';
import type { AppEnv } from '../types.js';
import { ApiError } from '../util/errors.js';
import { newAttachmentId } from '../util/ids.js';
import { loadPublicExtras, toPublicRecord } from './public.js';
import { attachmentFieldRule, isTableName, type TableName } from './tables.js';

export const MAX_FILE_BYTES = 5 * MB;

/** Airtable's attachment object shape, pointing at our own download route. */
export interface AttachmentValue {
  id: string;
  url: string;
  filename: string;
  size: number;
  type: string;
}

interface FileRow {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  path: string;
}

const isControlChar = (ch: string): boolean => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f;

export function sanitizeFilename(name: string): string {
  const cleaned = [...name.replace(/[/\\]/g, '_')]
    .filter((ch) => !isControlChar(ch))
    .join('')
    .trim()
    .replace(/^\.+/, '');
  return (cleaned || 'datei').slice(0, 150);
}

const safeContentType = (value: string): string =>
  /^[\w.+-]+\/[\w.+-]+$/.test(value) ? value.toLowerCase() : 'application/octet-stream';

const toRow = (row: Row): FileRow => ({
  id: String(row.id),
  filename: String(row.filename),
  contentType: String(row.content_type),
  size: Number(row.size),
  path: String(row.path),
});

const toValue = (f: FileRow): AttachmentValue => ({
  id: f.id,
  url: `/api/files/${f.id}/${encodeURIComponent(f.filename)}`,
  filename: f.filename,
  size: f.size,
  type: f.contentType,
});

export interface SaveFileInput {
  table: TableName;
  recordId: string;
  field: string;
  filename: string;
  contentType: string;
  data: Buffer;
  createdBy: string;
  /** Keep an existing id (used by the Airtable import). */
  id?: string;
}

export class FileStore {
  constructor(
    private readonly db: Database,
    private readonly dataDir: string,
    private readonly now: () => number = Date.now,
  ) {}

  async save(tx: Executor, input: SaveFileInput): Promise<AttachmentValue> {
    const id = input.id ?? newAttachmentId();
    const filename = sanitizeFilename(input.filename);
    const relative = path.posix.join('files', id, filename);
    await mkdir(path.join(this.dataDir, 'files', id), { recursive: true });
    await writeFile(path.join(this.dataDir, relative), input.data);
    const row: FileRow = { id, filename, contentType: safeContentType(input.contentType), size: input.data.length, path: relative };
    await tx.execute({
      sql: `INSERT INTO files (id, table_name, record_id, field, filename, content_type, size, sha256, path, created_at, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        input.table,
        input.recordId,
        input.field,
        row.filename,
        row.contentType,
        row.size,
        createHash('sha256').update(input.data).digest('hex'),
        relative,
        new Date(this.now()).toISOString(),
        input.createdBy,
      ],
    });
    return toValue(row);
  }

  async get(id: string): Promise<FileRow | null> {
    const rows = await this.db.query('SELECT id, filename, content_type, size, path FROM files WHERE id = ?', [id]);
    return rows[0] ? toRow(rows[0]) : null;
  }

  absolutePath(file: FileRow): string {
    return path.join(this.dataDir, file.path);
  }

  /**
   * Attachment fields may only be written as [{id}, ...] referring to files already
   * uploaded for this record and field. Entries are replaced by the stored metadata.
   */
  async normalizeAttachmentFields(
    exec: Executor,
    table: TableName,
    recordId: string | null,
    set: Record<string, unknown>,
  ): Promise<void> {
    for (const [field, value] of Object.entries(set)) {
      if (!attachmentFieldRule(table, field)) continue;
      if (!Array.isArray(value)) throw new ApiError('VALIDATION_FAILED', `${field}: Liste von Dateien erwartet`);
      const normalized: AttachmentValue[] = [];
      for (const item of value) {
        const id = isPlainObject(item) && typeof item.id === 'string' ? item.id : null;
        const rs = id && recordId
          ? await exec.execute({
              sql: 'SELECT id, filename, content_type, size, path FROM files WHERE id = ? AND table_name = ? AND record_id = ? AND field = ?',
              args: [id, table, recordId, field],
            })
          : null;
        const row = rs?.rows[0];
        if (!row) throw new ApiError('VALIDATION_FAILED', `${field}: unbekannte Datei`);
        normalized.push(toValue(toRow(row)));
      }
      set[field] = normalized;
    }
  }
}

function contentDisposition(file: FileRow): string {
  const inline = file.contentType.startsWith('image/') || file.contentType === 'application/pdf';
  const ascii = file.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`;
}

export function fileRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/data/:table/:id/files/:field', limit(7 * MB), async (c) => {
    const tableName = c.req.param('table');
    if (!isTableName(tableName)) throw new ApiError('NOT_FOUND', `Unbekannte Tabelle: ${tableName}`);
    const table: TableName = tableName;
    const { id, field } = c.req.param();
    const rule = attachmentFieldRule(table, field);
    if (!rule) throw new ApiError('INVALID_REQUEST', 'Upload für dieses Feld nicht erlaubt');
    const user = c.get('user');
    if (rule.adminOnly && !user.isAdmin) throw new ApiError('FORBIDDEN', 'Nur für Admins');

    const body = await readJsonBody(c);
    if (typeof body.file !== 'string' || typeof body.filename !== 'string') {
      throw new ApiError('INVALID_REQUEST', 'file und filename erforderlich');
    }
    const data = Buffer.from(body.file, 'base64');
    if (data.length > MAX_FILE_BYTES) throw new ApiError('PAYLOAD_TOO_LARGE', 'Datei zu groß (max 5 MB)');
    const contentType = typeof body.contentType === 'string' ? body.contentType : 'application/octet-stream';

    const record = await deps.db.write(async (tx) => {
      const existing = await deps.records.get(table, id, tx);
      if (!existing) throw new ApiError('NOT_FOUND', 'Datensatz nicht gefunden');
      const saved = await deps.files.save(tx, {
        table,
        recordId: id,
        field,
        filename: body.filename as string,
        contentType,
        data,
        createdBy: user.id,
      });
      const current = Array.isArray(existing.fields[field]) ? (existing.fields[field] as unknown[]) : [];
      return deps.records.update(tx, table, id, { [field]: [...current, saved] }, []);
    });
    if (!record) throw new ApiError('NOT_FOUND', 'Datensatz nicht gefunden');
    return c.json(toPublicRecord(table, record, user, await loadPublicExtras(deps, table, user)));
  });

  app.get('/files/:id/:filename', async (c) => {
    const file = await deps.files.get(c.req.param('id'));
    if (!file) throw new ApiError('NOT_FOUND', 'Datei nicht gefunden');
    const absolute = deps.files.absolutePath(file);
    const info = await stat(absolute).catch(() => null);
    if (!info) throw new ApiError('NOT_FOUND', 'Datei nicht gefunden');
    const stream = Readable.toWeb(createReadStream(absolute)) as ReadableStream<Uint8Array>;
    return new Response(stream, {
      headers: {
        'content-type': file.contentType,
        'content-length': String(info.size),
        'content-disposition': contentDisposition(file),
        'cache-control': 'private, max-age=300',
      },
    });
  });

  return app;
}
```


- [ ] **Step 4: Add the store to `server/deps.ts`**

In `server/deps.ts`, replace:

```ts
import { LockService } from './data/locks.js';
```

with:

```ts
import { FileStore } from './data/files.js';
import { LockService } from './data/locks.js';
```

In `server/deps.ts`, replace:

```ts
  locks: LockService;
}
```

with:

```ts
  locks: LockService;
  files: FileStore;
}
```

In `server/deps.ts`, replace:

```ts
    locks: new LockService(o.db, records, now),
  };
```

with:

```ts
    locks: new LockService(o.db, records, now),
    files: new FileStore(o.db, o.config.dataDir, now),
  };
```


- [ ] **Step 5: Validate attachment fields in the create and update handlers of `server/data/routes.ts`**

In `server/data/routes.ts`, replace:

```ts
      await deps.numbers.applyOnCreate(tx, table, set, { assignNumber: body.assignNumber === true, variantOf: body.variantOf });
      return deps.records.insert(tx, table, set);
```

with:

```ts
      await deps.numbers.applyOnCreate(tx, table, set, { assignNumber: body.assignNumber === true, variantOf: body.variantOf });
      await deps.files.normalizeAttachmentFields(tx, table, null, set);
      return deps.records.insert(tx, table, set);
```

In `server/data/routes.ts`, replace:

```ts
      await deps.numbers.checkOnUpdate(tx, table, existing, set);
      return deps.records.update(tx, table, id, set, clear);
```

with:

```ts
      await deps.numbers.checkOnUpdate(tx, table, existing, set);
      await deps.files.normalizeAttachmentFields(tx, table, id, set);
      return deps.records.update(tx, table, id, set, clear);
```


- [ ] **Step 6: Mount the routes in `server/app.ts`**

In `server/app.ts`, replace:

```ts
import { lockRoutes } from './data/locks.js';
```

with:

```ts
import { fileRoutes } from './data/files.js';
import { lockRoutes } from './data/locks.js';
```

In `server/app.ts`, replace:

```ts
  api.route('/', lockRoutes(deps));
```

with:

```ts
  api.route('/', lockRoutes(deps));
  api.route('/', fileRoutes(deps));
```


- [ ] **Step 7: Run the test to verify it passes**

Run:

```bash
npx vitest run test/files.test.ts
```

Expected: 6 tests pass.


- [ ] **Step 8: Run the whole suite, typecheck and lint**

Run:

```bash
npm test && npm run typecheck && npm run lint
```


- [ ] **Step 9: Commit**

```bash
git add server/data/files.ts server/deps.ts server/app.ts server/data/routes.ts test/files.test.ts
git commit -F - <<'EOF'
feat(server): add attachment uploads and authenticated file downloads

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FVrKcG5sQkpYKqUZGYjujR
EOF
```


---

### Task 11: Settings and admin secret management

**Files:**
- Create: server/settings/store.ts, server/settings/routes.ts, server/admin/routes.ts
- Modify: server/app.ts
- Test: test/settings-admin.test.ts

**Interfaces:**
- Consumes: `requireAdmin` (Task 6); `hashLoginKey`, `verifyLoginKey`, `SecretStore` (Task 5); `newLoginKey` (Task 2); `readJsonBody`, `isPlainObject` (Task 3).
- Produces: `SETTING_KEYS`, `isSettingKey`, `readSettings(db)`, `upsertSetting(exec, key, value, updatedBy, at)`, `deleteSetting(exec, key)`; `settingsRoutes(deps)` serving `GET /settings`, `PUT/DELETE /settings/:key`; `adminRoutes(deps)` (mounted at `/api/admin`) serving `PATCH /users/:id/secrets` and `PATCH /companies/:id/secrets`.

- [ ] **Step 1: Write the failing test**

Create `test/settings-admin.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyLoginKey } from '../server/auth/passwords.js';
import { createTestContext, type TestContext } from './helpers/context.js';

let ctx: TestContext;
let user: { id: string; key: string; cookie: string };
let admin: { id: string; cookie: string };

beforeEach(async () => {
  ctx = await createTestContext();
  user = await ctx.loginAs({ name: 'Nora' });
  admin = await ctx.loginAs({ name: 'Adam', isAdmin: true });
});
afterEach(async () => {
  await ctx.close();
});

describe('settings', () => {
  it('lets everyone read and only admins change allowlisted settings', async () => {
    const put = (cookie: string, key: string, value: unknown) =>
      ctx.req(`/api/settings/${key}`, { method: 'PUT', cookie, body: { value } });
    expect((await put(user.cookie, 'freshdeskDomain', 'flp')).status).toBe(403);
    expect(await (await put(admin.cookie, 'freshdeskDomain', ' flpliftparts ')).json()).toEqual({
      settings: { freshdeskDomain: 'flpliftparts' },
    });
    await put(admin.cookie, 'freshdeskTicketTypes', 'FLP Lift Parts GmbH, FLP Traction Drives GmbH');
    expect(await (await ctx.req('/api/settings', { cookie: user.cookie })).json()).toEqual({
      settings: { freshdeskDomain: 'flpliftparts', freshdeskTicketTypes: 'FLP Lift Parts GmbH, FLP Traction Drives GmbH' },
    });
    expect((await put(admin.cookie, 'anthropicKey', 'sk-ant')).status).toBe(400);
    expect((await put(admin.cookie, 'freshdeskDomain', 5)).status).toBe(400);
    expect(await (await put(admin.cookie, 'freshdeskDomain', '')).json()).toEqual({
      settings: { freshdeskTicketTypes: 'FLP Lift Parts GmbH, FLP Traction Drives GmbH' },
    });
    const del = await ctx.req('/api/settings/freshdeskTicketTypes', { method: 'DELETE', cookie: admin.cookie });
    expect(await del.json()).toEqual({ settings: {} });
  });

  it('requires a session', async () => {
    expect((await ctx.req('/api/settings')).status).toBe(401);
  });
});

describe('admin: user secrets', () => {
  const patch = (cookie: string, userId: string, body: unknown) =>
    ctx.req(`/api/admin/users/${userId}/secrets`, { method: 'PATCH', cookie, body });

  it('is admin-only', async () => {
    expect((await patch(user.cookie, user.id, { generate_api_key: true })).status).toBe(403);
  });

  it('generates a new 24-char key once, replacing the old one', async () => {
    const res = await (await patch(admin.cookie, user.id, { generate_api_key: true })).json();
    expect(res.api_key).toMatch(/^[a-z0-9]{24}$/);
    expect(res).toMatchObject({ has_api_key: true, has_freshdesk_key: false, freshdesk_company_keys: [] });
    expect((await ctx.req('/api/auth', { method: 'POST', body: { user_key: user.key } })).status).toBe(401);
    expect((await ctx.req('/api/auth', { method: 'POST', body: { user_key: res.api_key } })).status).toBe(200);
  });

  it('sets a manual key (min 12 chars, unique) without echoing it, or removes it', async () => {
    expect((await patch(admin.cookie, user.id, { api_key: 'short' })).status).toBe(422);
    const other = await ctx.createUser({ key: 'already-used-key-123' });
    expect(other.id).toBeTruthy();
    const dup = await patch(admin.cookie, user.id, { api_key: 'already-used-key-123' });
    expect(dup.status).toBe(409);
    expect((await dup.json()).error.type).toBe('KEY_IN_USE');
    const ok = await (await patch(admin.cookie, user.id, { api_key: 'nora-new-key-2026' })).json();
    expect(ok.api_key).toBeUndefined();
    const hash = (await ctx.deps.secrets.apiKeyHashes()).get(user.id) ?? '';
    expect(await verifyLoginKey('nora-new-key-2026', hash)).toBe(true);
    const removed = await (await patch(admin.cookie, user.id, { api_key: null })).json();
    expect(removed.has_api_key).toBe(false);
  });

  it('sets, merges and clears Freshdesk keys server-side', async () => {
    let res = await (
      await patch(admin.cookie, user.id, { freshdesk_api_key: 'default-fd', freshdesk_keys: { recC1: 'k1', recC2: 'k2' } })
    ).json();
    expect(res).toEqual({ has_api_key: true, has_freshdesk_key: true, freshdesk_company_keys: ['recC1', 'recC2'] });
    res = await (await patch(admin.cookie, user.id, { freshdesk_keys: { recC1: null, recC3: 'k3' } })).json();
    expect(res.freshdesk_company_keys).toEqual(['recC2', 'recC3']);
    res = await (await patch(admin.cookie, user.id, { freshdesk_api_key: '' })).json();
    expect(res.has_freshdesk_key).toBe(false);
    expect(await ctx.deps.secrets.freshdeskKeyFor(user.id, 'recC3')).toBe('k3');
    expect((await patch(admin.cookie, user.id, { freshdesk_keys: 'x' })).status).toBe(400);
  });

  it('404s for unknown users', async () => {
    expect((await patch(admin.cookie, 'recGONEGONEGONE12', { generate_api_key: true })).status).toBe(404);
  });
});

describe('admin: company secrets', () => {
  it('sets and clears the Mailchimp key without ever returning it', async () => {
    const co = await ctx.deps.db.write((tx) => ctx.deps.records.insert(tx, 'Company', { name: 'FLP' }));
    const url = `/api/admin/companies/${co.id}/secrets`;
    expect((await ctx.req(url, { method: 'PATCH', cookie: user.cookie, body: { mailchimp_api_key: 'x' } })).status).toBe(403);
    const set = await ctx.req(url, { method: 'PATCH', cookie: admin.cookie, body: { mailchimp_api_key: 'abc-us21' } });
    expect(await set.json()).toEqual({ has_mailchimp_key: true });
    expect(await ctx.deps.secrets.mailchimpKey(co.id)).toBe('abc-us21');
    const cleared = await ctx.req(url, { method: 'PATCH', cookie: admin.cookie, body: { mailchimp_api_key: null } });
    expect(await cleared.json()).toEqual({ has_mailchimp_key: false });
    expect((await ctx.req(url, { method: 'PATCH', cookie: admin.cookie, body: {} })).status).toBe(400);
    expect(
      (await ctx.req('/api/admin/companies/recGONEGONEGONE12/secrets', { method: 'PATCH', cookie: admin.cookie, body: { mailchimp_api_key: 'x' } }))
        .status,
    ).toBe(404);
  });
});
```


- [ ] **Step 2: Run it to verify it fails**

Run:

```bash
npx vitest run test/settings-admin.test.ts
```

Expected: FAIL — 6 of 8 tests fail because `/api/settings` and `/api/admin/...` answer 404.


- [ ] **Step 3: Implement the settings store and routes**

Create `server/settings/store.ts`:

```ts
import type { Database, Executor } from '../db/database.js';

/** Non-secret settings the browser may read. Everything else from the old Keys table is gone. */
export const SETTING_KEYS = [
  'freshdeskSalesGroupId',
  'freshdeskOrderGroupId',
  'freshdeskTicketTypes',
  'freshdeskDomain',
  'freshsalesSubdomain',
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

const KEY_SET: ReadonlySet<string> = new Set(SETTING_KEYS);
export const isSettingKey = (key: string): key is SettingKey => KEY_SET.has(key);

export async function readSettings(db: Database): Promise<Record<string, string>> {
  const rows = await db.query('SELECT key, value FROM settings ORDER BY key');
  return Object.fromEntries(rows.map((row) => [String(row.key), String(row.value)]));
}

export async function upsertSetting(exec: Executor, key: SettingKey, value: string, updatedBy: string, at: string): Promise<void> {
  await exec.execute({
    sql: `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    args: [key, value, at, updatedBy],
  });
}

export async function deleteSetting(exec: Executor, key: SettingKey): Promise<void> {
  await exec.execute({ sql: 'DELETE FROM settings WHERE key = ?', args: [key] });
}
```

Create `server/settings/routes.ts`:

```ts
import { Hono } from 'hono';
import { requireAdmin } from '../auth/middleware.js';
import type { AppDeps } from '../deps.js';
import { readJsonBody } from '../http/body.js';
import type { AppEnv } from '../types.js';
import { ApiError } from '../util/errors.js';
import { deleteSetting, isSettingKey, readSettings, upsertSetting, type SettingKey } from './store.js';

function settingKey(raw: string): SettingKey {
  if (!isSettingKey(raw)) throw new ApiError('INVALID_REQUEST', `Unbekannte Einstellung: ${raw}`);
  return raw;
}

export function settingsRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/settings', async (c) => c.json({ settings: await readSettings(deps.db) }));

  app.put('/settings/:key', requireAdmin, async (c) => {
    const key = settingKey(c.req.param('key'));
    const body = await readJsonBody(c);
    if (typeof body.value !== 'string' || body.value.length > 2000) {
      throw new ApiError('INVALID_REQUEST', 'value muss ein Text (max. 2000 Zeichen) sein');
    }
    const value = body.value.trim();
    await deps.db.write((tx) =>
      value === ''
        ? deleteSetting(tx, key)
        : upsertSetting(tx, key, value, c.get('user').id, new Date(deps.now()).toISOString()),
    );
    return c.json({ settings: await readSettings(deps.db) });
  });

  app.delete('/settings/:key', requireAdmin, async (c) => {
    const key = settingKey(c.req.param('key'));
    await deps.db.write((tx) => deleteSetting(tx, key));
    return c.json({ settings: await readSettings(deps.db) });
  });

  return app;
}
```


- [ ] **Step 4: Implement the admin secret routes**

`requireAdmin` is applied with `app.use('*')` here. That is safe only because this sub-app is mounted under `/admin`. Never add `use('*')` to a sub-app mounted at `/`, because it would apply to every API route.

Create `server/admin/routes.ts`:

```ts
import { Hono } from 'hono';
import { requireAdmin } from '../auth/middleware.js';
import { hashLoginKey, verifyLoginKey } from '../auth/passwords.js';
import type { AppDeps } from '../deps.js';
import { isPlainObject, readJsonBody } from '../http/body.js';
import type { AppEnv } from '../types.js';
import { ApiError } from '../util/errors.js';
import { newLoginKey } from '../util/ids.js';

const optionalSecret = (value: unknown, name: string): string | null => {
  if (value === null) return null;
  if (typeof value !== 'string') throw new ApiError('INVALID_REQUEST', `${name} muss Text oder null sein`);
  return value.trim() === '' ? null : value.trim();
};

async function keyInUseByOther(deps: AppDeps, key: string, userId: string): Promise<boolean> {
  for (const [otherId, hash] of await deps.secrets.apiKeyHashes()) {
    if (otherId !== userId && (await verifyLoginKey(key, hash))) return true;
  }
  return false;
}

/** Mounted at /api/admin. Everything here is admin-only. */
export function adminRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', requireAdmin);

  app.patch('/users/:id/secrets', async (c) => {
    const userId = c.req.param('id');
    if (!(await deps.records.get('User', userId))) throw new ApiError('NOT_FOUND', 'Benutzer nicht gefunden');
    const body = await readJsonBody(c);

    let newKey: string | null | undefined;
    let generated = false;
    if (body.generate_api_key === true) {
      newKey = newLoginKey();
      generated = true;
    } else if (body.api_key === null) {
      newKey = null;
    } else if (body.api_key !== undefined) {
      if (typeof body.api_key !== 'string' || body.api_key.trim().length < 12) {
        throw new ApiError('VALIDATION_FAILED', 'Login-Key muss mindestens 12 Zeichen haben');
      }
      newKey = body.api_key.trim();
    }
    if (newKey && (await keyInUseByOther(deps, newKey, userId))) {
      throw new ApiError('KEY_IN_USE', 'Dieser Login-Key wird bereits verwendet');
    }
    const hash = newKey ? await hashLoginKey(newKey) : null;

    let companyPatch: Record<string, string | null> | undefined;
    if (body.freshdesk_keys !== undefined) {
      if (!isPlainObject(body.freshdesk_keys)) throw new ApiError('INVALID_REQUEST', 'freshdesk_keys muss ein Objekt sein');
      companyPatch = Object.fromEntries(
        Object.entries(body.freshdesk_keys).map(([companyId, v]) => [companyId, optionalSecret(v, 'freshdesk_keys')]),
      );
    }
    const defaultKey = body.freshdesk_api_key === undefined ? undefined : optionalSecret(body.freshdesk_api_key, 'freshdesk_api_key');

    await deps.db.write(async (tx) => {
      if (newKey !== undefined) await deps.secrets.setApiKeyHash(tx, userId, hash);
      if (defaultKey !== undefined) await deps.secrets.setFreshdeskDefault(tx, userId, defaultKey);
      if (companyPatch) await deps.secrets.mergeFreshdeskKeys(tx, userId, companyPatch);
    });

    const info = await deps.secrets.userInfo(userId);
    return c.json({
      ...(generated && newKey ? { api_key: newKey } : {}),
      has_api_key: info.hasApiKey,
      has_freshdesk_key: info.hasFreshdeskKey,
      freshdesk_company_keys: info.freshdeskCompanyKeys,
    });
  });

  app.patch('/companies/:id/secrets', async (c) => {
    const companyId = c.req.param('id');
    if (!(await deps.records.get('Company', companyId))) throw new ApiError('NOT_FOUND', 'Firma nicht gefunden');
    const body = await readJsonBody(c);
    if (body.mailchimp_api_key === undefined) throw new ApiError('INVALID_REQUEST', 'mailchimp_api_key fehlt');
    const key = optionalSecret(body.mailchimp_api_key, 'mailchimp_api_key');
    await deps.db.write((tx) => deps.secrets.setMailchimpKey(tx, companyId, key));
    return c.json({ has_mailchimp_key: key !== null });
  });

  return app;
}
```


- [ ] **Step 5: Mount both in `server/app.ts`**

In `server/app.ts`, replace:

```ts
import { originCheck, requireAuth } from './auth/middleware.js';
```

with:

```ts
import { adminRoutes } from './admin/routes.js';
import { originCheck, requireAuth } from './auth/middleware.js';
```

In `server/app.ts`, replace:

```ts
import { staticRoutes } from './http/static.js';
```

with:

```ts
import { staticRoutes } from './http/static.js';
import { settingsRoutes } from './settings/routes.js';
```

In `server/app.ts`, replace:

```ts
  api.route('/', fileRoutes(deps));
```

with:

```ts
  api.route('/', fileRoutes(deps));
  api.route('/', settingsRoutes(deps));
  api.route('/admin', adminRoutes(deps));
```


- [ ] **Step 6: Run the test to verify it passes**

Run:

```bash
npx vitest run test/settings-admin.test.ts
```

Expected: 8 tests pass.


- [ ] **Step 7: Run the whole suite, typecheck and lint**

Run:

```bash
npm test && npm run typecheck && npm run lint
```


- [ ] **Step 8: Commit**

```bash
git add server/settings server/admin/routes.ts server/app.ts test/settings-admin.test.ts
git commit -F - <<'EOF'
feat(server): add settings API and admin endpoints for login and service keys

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FVrKcG5sQkpYKqUZGYjujR
EOF
```


---

### Task 12: Upstream passthrough core and the Freshdesk route

**Files:**
- Create: server/proxy/allowlist.ts, server/proxy/passthrough.ts, server/proxy/freshdesk.ts
- Modify: server/app.ts
- Test: test/freshdesk.test.ts

**Interfaces:**
- Consumes: `SecretStore.freshdeskKeyFor` (Task 5); `SessionUser.allowedCompanies`, `isAdmin` (Task 6); `limit`, `MB` (Task 3); `AppDeps.fetch`, `timeouts` (Task 3).
- Produces: `type Rule = [method, pattern]`, `compileRules(rules)`; `interface UpstreamRequest`, `forward(fetchFn, req)`, `passthroughResponse(res)`; `FRESHDESK_RULES`; `freshdeskRoutes(deps)` serving `ALL /freshdesk/api/v2/*`.

- [ ] **Step 1: Write the failing test**

Create `test/freshdesk.test.ts`:

```ts
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
```


- [ ] **Step 2: Run it to verify it fails**

Run:

```bash
npx vitest run test/freshdesk.test.ts
```

Expected: FAIL — all 11 tests fail because `/api/freshdesk/...` answers 404.


- [ ] **Step 3: Implement the allowlist matcher and passthrough**

Upstream status codes and bodies pass through unchanged, because `index.html` regex-matches raw Freshdesk/Freshsales error bodies (e.g. `one of these values`, `409 duplicate`). Only our own failures (network, timeout, config) become `{error:{type,message}}` without internal detail.

Create `server/proxy/allowlist.ts`:

```ts
/** [method, path pattern]; "{id}" matches digits only, everything else must match literally. */
export type Rule = readonly [method: string, pattern: string];

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function compileRules(rules: readonly Rule[]): (method: string, path: string) => boolean {
  const compiled = rules.map(([method, pattern]) => ({
    method,
    re: new RegExp(`^${pattern.split('/').map((seg) => (seg === '{id}' ? '\\d+' : escapeRegex(seg))).join('/')}$`),
  }));
  return (method, path) => compiled.some((r) => r.method === method && r.re.test(path));
}
```

Create `server/proxy/passthrough.ts`:

```ts
import type { FetchFn } from '../deps.js';
import { ApiError } from '../util/errors.js';

export interface UpstreamRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: BodyInit;
  timeoutMs: number;
  /** Human-readable service name for error messages, e.g. "Freshdesk". */
  label: string;
}

const NO_BODY_STATUSES = new Set([204, 205, 304]);

/** Returns the upstream status and body unchanged (the frontend parses raw upstream errors). */
export function passthroughResponse(upstream: Response): Response {
  const headers = new Headers();
  const noBody = NO_BODY_STATUSES.has(upstream.status);
  const contentType = upstream.headers.get('content-type');
  if (contentType && !noBody) headers.set('content-type', contentType);
  const retryAfter = upstream.headers.get('retry-after');
  if (retryAfter) headers.set('retry-after', retryAfter);
  return new Response(noBody ? null : upstream.body, { status: upstream.status, headers });
}

export async function forward(fetchFn: FetchFn, req: UpstreamRequest): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetchFn(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(req.timeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new ApiError('UPSTREAM_TIMEOUT', `${req.label} antwortet nicht (Zeitüberschreitung)`);
    }
    throw new ApiError('UPSTREAM_UNAVAILABLE', `${req.label} nicht erreichbar`);
  }
  return passthroughResponse(upstream);
}
```


- [ ] **Step 4: Implement the Freshdesk route**

Create `server/proxy/freshdesk.ts`:

```ts
import { Hono } from 'hono';
import type { AppDeps } from '../deps.js';
import { limit, MB } from '../http/body.js';
import type { AppEnv } from '../types.js';
import { ApiError } from '../util/errors.js';
import { compileRules, type Rule } from './allowlist.js';
import { forward } from './passthrough.js';

/** Every Freshdesk call index.html makes, and nothing else. */
export const FRESHDESK_RULES: readonly Rule[] = [
  ['GET', 'tickets/{id}'],
  ['PUT', 'tickets/{id}'],
  ['POST', 'tickets'],
  ['POST', 'tickets/outbound_email'],
  ['GET', 'tickets/{id}/conversations'],
  ['POST', 'tickets/{id}/notes'],
  ['POST', 'tickets/{id}/forward'],
  ['GET', 'search/tickets'],
  ['GET', 'agents'],
  ['GET', 'contacts'],
  ['POST', 'contacts'],
  ['GET', 'contacts/{id}'],
  ['PUT', 'contacts/{id}'],
  ['GET', 'contacts/{id}/tickets'],
  ['GET', 'companies/{id}'],
  ['PUT', 'companies/{id}'],
  ['POST', 'companies'],
  ['GET', 'companies/autocomplete'],
  ['GET', 'search/companies'],
  ['GET', 'canned_response_folders'],
  ['GET', 'canned_response_folders/{id}/responses'],
  ['GET', 'conversations/{id}'],
  ['PUT', 'conversations/{id}'],
  ['DELETE', 'conversations/{id}'],
  ['GET', 'groups'],
  ['GET', 'email_configs'],
  ['GET', 'ticket_fields'],
];

const MAX_JSON_BYTES = 5 * MB;
const MAX_MULTIPART_BYTES = 25 * MB;

export function freshdeskRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const allowed = compileRules(FRESHDESK_RULES);

  app.all('/freshdesk/api/v2/*', limit(MAX_MULTIPART_BYTES), async (c) => {
    const method = c.req.method;
    const subPath = c.req.path.replace(/^.*?\/freshdesk\/api\/v2\//, '');
    if (!allowed(method, subPath)) throw new ApiError('FORBIDDEN', 'Endpoint nicht freigegeben');

    const domain = deps.config.freshdeskDomain;
    if (!domain) throw new ApiError('NOT_CONFIGURED', 'FRESHDESK_DOMAIN fehlt in der Server-Konfiguration');

    // Key order: user × current company (only an allowed company) → user default → FRESHDESK_API_KEY.
    const user = c.get('user');
    const companyId = c.req.header('x-company-id')?.trim() || null;
    const companyAllowed = companyId !== null && (user.isAdmin || user.allowedCompanies.includes(companyId));
    const apiKey = (await deps.secrets.freshdeskKeyFor(user.id, companyAllowed ? companyId : null)) ?? deps.config.freshdeskApiKey;
    if (!apiKey) {
      throw new ApiError(
        'NOT_CONFIGURED',
        'Kein Freshdesk-Key verfügbar: beim Benutzer hinterlegen (Admin → Benutzer) oder FRESHDESK_API_KEY setzen',
      );
    }

    const headers: Record<string, string> = {
      authorization: `Basic ${Buffer.from(`${apiKey}:X`).toString('base64')}`,
      accept: 'application/json',
    };
    let body: BodyInit | undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      const contentType = c.req.header('content-type') ?? 'application/json';
      headers['content-type'] = contentType;
      if (contentType.toLowerCase().startsWith('multipart/')) {
        body = await c.req.arrayBuffer(); // keeps the boundary intact
      } else {
        const text = await c.req.text();
        if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw new ApiError('PAYLOAD_TOO_LARGE', 'Anfrage zu groß');
        body = text;
      }
    }

    const search = new URL(c.req.url).search;
    return forward(deps.fetch, {
      url: `https://${domain}.freshdesk.com/api/v2/${subPath}${search}`,
      method,
      headers,
      body,
      timeoutMs: deps.timeouts.upstreamMs,
      label: 'Freshdesk',
    });
  });

  return app;
}
```


- [ ] **Step 5: Mount it in `server/app.ts`**

In `server/app.ts`, replace:

```ts
import { securityHeaders } from './http/securityHeaders.js';
```

with:

```ts
import { securityHeaders } from './http/securityHeaders.js';
import { freshdeskRoutes } from './proxy/freshdesk.js';
```

In `server/app.ts`, replace:

```ts
  api.route('/admin', adminRoutes(deps));
```

with:

```ts
  api.route('/admin', adminRoutes(deps));
  api.route('/', freshdeskRoutes(deps));
```


- [ ] **Step 6: Run the test to verify it passes**

Run:

```bash
npx vitest run test/freshdesk.test.ts
```

Expected: 11 tests pass.


- [ ] **Step 7: Run the whole suite, typecheck and lint**

Run:

```bash
npm test && npm run typecheck && npm run lint
```


- [ ] **Step 8: Commit**

```bash
git add server/proxy/allowlist.ts server/proxy/passthrough.ts server/proxy/freshdesk.ts server/app.ts test/freshdesk.test.ts
git commit -F - <<'EOF'
feat(server): add Freshdesk proxy with endpoint allowlist and per-company keys

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FVrKcG5sQkpYKqUZGYjujR
EOF
```


---

### Task 13: Freshsales, Mailchimp and Anthropic routes

**Files:**
- Create: server/proxy/freshsales.ts, server/proxy/mailchimp.ts, server/proxy/anthropic.ts
- Modify: server/app.ts
- Test: test/services.test.ts

**Interfaces:**
- Consumes: `compileRules`, `forward` (Task 12); `SecretStore.mailchimpKey` (Task 5); `RecordStore.get` (Task 4).
- Produces: `FRESHSALES_RULES`, `freshsalesRoutes(deps)` (`ALL /freshsales/api/*`); `MAILCHIMP_RULES`, `mailchimpRoutes(deps)` (`ALL /mailchimp/3.0/*`, requires `X-Company-Id`); `anthropicRoutes(deps)` (`ALL /anthropic/v1/messages`, POST only).

- [ ] **Step 1: Write the failing test**

Create `test/services.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { jsonResponse } from './helpers/fakeFetch.js';

let ctx: TestContext;
let user: { id: string; cookie: string };
let admin: { id: string; cookie: string };

beforeEach(async () => {
  ctx = await createTestContext();
  user = await ctx.loginAs();
  admin = await ctx.loginAs({ isAdmin: true });
});
afterEach(async () => {
  await ctx.close();
});

describe('Freshsales proxy', () => {
  const FS = 'https://gilt.freshworks.com/crm/sales/api/';

  it('forwards allowed calls with the token header and passes errors through', async () => {
    ctx.fake
      .on('GET', `${FS}lookup`, () => jsonResponse({ contacts: { contacts: [] } }))
      .on('PUT', `${FS}sales_accounts/`, () => jsonResponse({ errors: { message: ['Company is not unique'] } }, 400));
    const ok = await ctx.req('/api/freshsales/api/lookup?q=a%40b.de&f=email&entities=contact', { cookie: user.cookie });
    expect(ok.status).toBe(200);
    expect(ctx.fake.calls[0]?.url).toBe(`${FS}lookup?q=a%40b.de&f=email&entities=contact`);
    expect(ctx.fake.calls[0]?.headers.get('authorization')).toBe('Token token=test-freshsales-key');

    const err = await ctx.req('/api/freshsales/api/sales_accounts/77', {
      method: 'PUT',
      cookie: user.cookie,
      body: { sales_account: { name: 'X' } },
    });
    expect(err.status).toBe(400);
    expect(await err.json()).toEqual({ errors: { message: ['Company is not unique'] } });
    expect(ctx.fake.calls[1]?.body?.toString()).toBe('{"sales_account":{"name":"X"}}');
  });

  it('blocks everything else and reports missing config by name', async () => {
    expect((await ctx.req('/api/freshsales/api/contacts/5', { method: 'DELETE', cookie: user.cookie })).status).toBe(403);
    expect((await ctx.req('/api/freshsales/api/settings/sales_accounts/fields', { cookie: user.cookie })).status).toBe(403);
    const bare = await createTestContext({ env: { FRESHSALES_API_KEY: '' } });
    try {
      const { cookie } = await bare.loginAs();
      const res = await bare.req('/api/freshsales/api/lookup?q=x', { cookie });
      expect((await res.json()).error.message).toContain('FRESHSALES_API_KEY');
    } finally {
      await bare.close();
    }
  });
});

describe('Mailchimp proxy', () => {
  let companyId: string;
  beforeEach(async () => {
    companyId = (
      await ctx.deps.db.write((tx) => ctx.deps.records.insert(tx, 'Company', { name: 'FLP', mailchimp_server_prefix: 'us21' }))
    ).id;
    await ctx.deps.db.write((tx) => ctx.deps.secrets.setMailchimpKey(tx, companyId, 'saved-key-us21'));
  });

  it('uses the company key and server prefix from the database', async () => {
    ctx.fake.on('GET', 'https://us21.api.mailchimp.com/3.0/', () => jsonResponse({ health_status: "Everything's Chimpy!" }));
    const res = await ctx.req('/api/mailchimp/3.0/ping', { cookie: user.cookie, headers: { 'x-company-id': companyId } });
    expect(await res.json()).toEqual({ health_status: "Everything's Chimpy!" });
    expect(ctx.fake.calls[0]?.headers.get('authorization')).toBe(
      `Basic ${Buffer.from('anystring:saved-key-us21').toString('base64')}`,
    );
  });

  it('lets only admins test unsaved values, and validates the server prefix', async () => {
    ctx.fake.on('GET', 'https://eu1.api.mailchimp.com/3.0/lists', () => jsonResponse({ lists: [] }));
    const headers = { 'x-company-id': companyId, 'x-mailchimp-key': 'typed-key-eu1', 'x-mailchimp-server': 'eu1' };
    expect((await ctx.req('/api/mailchimp/3.0/lists?count=50', { cookie: user.cookie, headers })).status).toBe(403);
    const ok = await ctx.req('/api/mailchimp/3.0/lists?count=50', { cookie: admin.cookie, headers });
    expect(ok.status).toBe(200);
    expect(ctx.fake.calls[0]?.url).toBe('https://eu1.api.mailchimp.com/3.0/lists?count=50');
    const bad = await ctx.req('/api/mailchimp/3.0/ping', {
      cookie: admin.cookie,
      headers: { ...headers, 'x-mailchimp-server': 'evil.com#' },
    });
    expect(bad.status).toBe(400);
  });

  it('requires a company, a configured key and an allowed endpoint', async () => {
    expect((await ctx.req('/api/mailchimp/3.0/ping', { cookie: user.cookie })).status).toBe(400);
    const other = await ctx.deps.db.write((tx) => ctx.deps.records.insert(tx, 'Company', { name: 'Other' }));
    const unconfigured = await ctx.req('/api/mailchimp/3.0/ping', { cookie: user.cookie, headers: { 'x-company-id': other.id } });
    expect(unconfigured.status).toBe(400);
    expect(
      (await ctx.req('/api/mailchimp/3.0/lists/abc/members', { cookie: user.cookie, headers: { 'x-company-id': companyId } }))
        .status,
    ).toBe(403);
  });
});

describe('Anthropic proxy', () => {
  it('forwards POST /v1/messages with the server key and passes the response through', async () => {
    ctx.fake.on('POST', 'https://api.anthropic.com/v1/messages', () =>
      jsonResponse({ id: 'msg_1', content: [{ type: 'text', text: 'Hallo' }], usage: { input_tokens: 3, output_tokens: 1 } }),
    );
    const payload = { model: 'claude-sonnet-4-5-20250929', max_tokens: 100, messages: [{ role: 'user', content: 'Hi' }] };
    const res = await ctx.req('/api/anthropic/v1/messages', { method: 'POST', cookie: user.cookie, body: payload });
    expect((await res.json()).content[0].text).toBe('Hallo');
    const call = ctx.fake.calls[0];
    expect(call?.headers.get('x-api-key')).toBe('test-anthropic-key');
    expect(call?.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(JSON.parse(call?.body?.toString() ?? '')).toEqual(payload);
  });

  it('accepts large image payloads up to 32 MB and rejects bigger ones with 413 JSON', async () => {
    ctx.fake.on('POST', 'https://api.anthropic.com/v1/messages', () => jsonResponse({ ok: true }));
    const image = 'A'.repeat(20 * 1024 * 1024);
    const ok = await ctx.req('/api/anthropic/v1/messages', { method: 'POST', cookie: user.cookie, body: { image } });
    expect(ok.status).toBe(200);
    const tooBig = await ctx.req('/api/anthropic/v1/messages', {
      method: 'POST',
      cookie: user.cookie,
      body: { image: 'A'.repeat(33 * 1024 * 1024) },
    });
    expect(tooBig.status).toBe(413);
    expect((await tooBig.json()).error.type).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects other methods and reports a missing key by name', async () => {
    expect((await ctx.req('/api/anthropic/v1/messages', { cookie: user.cookie })).status).toBe(405);
    const bare = await createTestContext({ env: { ANTHROPIC_API_KEY: '' } });
    try {
      const { cookie } = await bare.loginAs();
      const res = await bare.req('/api/anthropic/v1/messages', { method: 'POST', cookie, body: {} });
      expect((await res.json()).error.message).toContain('ANTHROPIC_API_KEY');
    } finally {
      await bare.close();
    }
  });
});
```


- [ ] **Step 2: Run it to verify it fails**

Run:

```bash
npx vitest run test/services.test.ts
```

Expected: FAIL — all 8 tests fail because the three route groups answer 404.


- [ ] **Step 3: Implement the three routes**

Create `server/proxy/freshsales.ts`:

```ts
import { Hono } from 'hono';
import type { AppDeps } from '../deps.js';
import { limit, MB } from '../http/body.js';
import type { AppEnv } from '../types.js';
import { ApiError } from '../util/errors.js';
import { compileRules, type Rule } from './allowlist.js';
import { forward } from './passthrough.js';

export const FRESHSALES_RULES: readonly Rule[] = [
  ['GET', 'sales_accounts/{id}'],
  ['PUT', 'sales_accounts/{id}'],
  ['POST', 'sales_accounts'],
  ['POST', 'sales_accounts/{id}/contacts'],
  ['GET', 'contacts/{id}'],
  ['PUT', 'contacts/{id}'],
  ['POST', 'contacts'],
  ['POST', 'contacts/{id}/sales_accounts'],
  ['GET', 'lookup'],
  ['GET', 'search'],
  ['POST', 'notes'],
];

export function freshsalesRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const allowed = compileRules(FRESHSALES_RULES);

  app.all('/freshsales/api/*', limit(1 * MB), async (c) => {
    const method = c.req.method;
    const subPath = c.req.path.replace(/^.*?\/freshsales\/api\//, '');
    if (!allowed(method, subPath)) throw new ApiError('FORBIDDEN', 'Endpoint nicht freigegeben');
    const subdomain = deps.config.freshsalesSubdomain;
    if (!subdomain) throw new ApiError('NOT_CONFIGURED', 'FRESHSALES_SUBDOMAIN fehlt in der Server-Konfiguration');
    const apiKey = deps.config.freshsalesApiKey;
    if (!apiKey) throw new ApiError('NOT_CONFIGURED', 'FRESHSALES_API_KEY fehlt in der Server-Konfiguration');

    const hasBody = method !== 'GET' && method !== 'HEAD';
    return forward(deps.fetch, {
      url: `https://${subdomain}.freshworks.com/crm/sales/api/${subPath}${new URL(c.req.url).search}`,
      method,
      headers: {
        authorization: `Token token=${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: hasBody ? await c.req.text() : undefined,
      timeoutMs: deps.timeouts.upstreamMs,
      label: 'Freshsales',
    });
  });

  return app;
}
```

Create `server/proxy/mailchimp.ts`:

```ts
import { Hono } from 'hono';
import type { AppDeps } from '../deps.js';
import type { AppEnv } from '../types.js';
import { ApiError } from '../util/errors.js';
import { compileRules, type Rule } from './allowlist.js';
import { forward } from './passthrough.js';

export const MAILCHIMP_RULES: readonly Rule[] = [
  ['GET', 'ping'],
  ['GET', 'lists'],
];

const SERVER_PREFIX = /^[a-z]{2,3}\d{1,2}$/;

export function mailchimpRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const allowed = compileRules(MAILCHIMP_RULES);

  app.all('/mailchimp/3.0/*', async (c) => {
    const method = c.req.method;
    const subPath = c.req.path.replace(/^.*?\/mailchimp\/3\.0\//, '');
    if (!allowed(method, subPath)) throw new ApiError('FORBIDDEN', 'Endpoint nicht freigegeben');

    const companyId = c.req.header('x-company-id')?.trim();
    if (!companyId) throw new ApiError('INVALID_REQUEST', 'X-Company-Id fehlt');
    const company = await deps.records.get('Company', companyId);
    if (!company) throw new ApiError('NOT_FOUND', 'Firma nicht gefunden');

    // Admins may test values typed into the settings form before saving them.
    const overrideKey = c.req.header('x-mailchimp-key')?.trim();
    const overrideServer = c.req.header('x-mailchimp-server')?.trim().toLowerCase();
    if ((overrideKey || overrideServer) && !c.get('user').isAdmin) throw new ApiError('FORBIDDEN', 'Nur für Admins');

    const apiKey = overrideKey || (await deps.secrets.mailchimpKey(companyId));
    if (!apiKey) throw new ApiError('INVALID_REQUEST', 'Mailchimp ist für diesen Mandanten nicht konfiguriert');
    const storedPrefix = typeof company.fields.mailchimp_server_prefix === 'string' ? company.fields.mailchimp_server_prefix : '';
    const server = (overrideServer || storedPrefix || /-([a-z]{2,3}\d{1,2})$/i.exec(apiKey)?.[1] || '').toLowerCase();
    if (!SERVER_PREFIX.test(server)) throw new ApiError('INVALID_REQUEST', `Ungültiger Mailchimp-Server-Prefix: ${server}`);

    return forward(deps.fetch, {
      url: `https://${server}.api.mailchimp.com/3.0/${subPath}${new URL(c.req.url).search}`,
      method,
      headers: {
        authorization: `Basic ${Buffer.from(`anystring:${apiKey}`).toString('base64')}`,
        accept: 'application/json',
      },
      timeoutMs: deps.timeouts.upstreamMs,
      label: 'Mailchimp',
    });
  });

  return app;
}
```

Create `server/proxy/anthropic.ts`:

```ts
import { Hono } from 'hono';
import type { AppDeps } from '../deps.js';
import { limit, MB } from '../http/body.js';
import type { AppEnv } from '../types.js';
import { ApiError } from '../util/errors.js';
import { forward } from './passthrough.js';

export function anthropicRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // 32 MB is Anthropic's own request limit (base64 images and PDFs are large).
  app.all('/anthropic/v1/messages', limit(32 * MB), async (c) => {
    if (c.req.method !== 'POST') throw new ApiError('METHOD_NOT_ALLOWED', 'Nur POST erlaubt');
    const apiKey = deps.config.anthropicApiKey;
    if (!apiKey) throw new ApiError('NOT_CONFIGURED', 'ANTHROPIC_API_KEY fehlt in der Server-Konfiguration');
    return forward(deps.fetch, {
      url: 'https://api.anthropic.com/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: await c.req.text(),
      timeoutMs: deps.timeouts.anthropicMs,
      label: 'Anthropic',
    });
  });

  return app;
}
```


- [ ] **Step 4: Mount them in `server/app.ts`**

In `server/app.ts`, replace:

```ts
import { freshdeskRoutes } from './proxy/freshdesk.js';
```

with:

```ts
import { anthropicRoutes } from './proxy/anthropic.js';
import { freshdeskRoutes } from './proxy/freshdesk.js';
import { freshsalesRoutes } from './proxy/freshsales.js';
import { mailchimpRoutes } from './proxy/mailchimp.js';
```

In `server/app.ts`, replace:

```ts
  api.route('/', freshdeskRoutes(deps));
```

with:

```ts
  api.route('/', freshdeskRoutes(deps));
  api.route('/', freshsalesRoutes(deps));
  api.route('/', mailchimpRoutes(deps));
  api.route('/', anthropicRoutes(deps));
```


- [ ] **Step 5: Run the test to verify it passes**

Run:

```bash
npx vitest run test/services.test.ts
```

Expected: 8 tests pass.


- [ ] **Step 6: Run the whole suite, typecheck and lint**

Run:

```bash
npm test && npm run typecheck && npm run lint
```


- [ ] **Step 7: Commit**

```bash
git add server/proxy/freshsales.ts server/proxy/mailchimp.ts server/proxy/anthropic.ts server/app.ts test/services.test.ts
git commit -F - <<'EOF'
feat(server): add Freshsales, Mailchimp and Anthropic proxy routes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FVrKcG5sQkpYKqUZGYjujR
EOF
```


---

### Task 14: Attachment proxy with exact host allowlist

**Files:**
- Create: server/proxy/attachmentProxy.ts
- Modify: server/app.ts
- Test: test/attachment-proxy.test.ts

**Interfaces:**
- Consumes: `Config.attachmentAllow`, `AllowEntry` (Task 1); `AppDeps.fetch`, `timeouts` (Task 3).
- Produces: `MAX_ATTACHMENT_BYTES`; `isAllowedAttachmentUrl(url: URL, allow: AllowEntry[])`; `attachmentProxyRoutes(deps)` serving `GET /attachment-proxy?url=…`.

- [ ] **Step 1: Write the failing test**

Create `test/attachment-proxy.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAllowedAttachmentUrl } from '../server/proxy/attachmentProxy.js';
import { createTestContext, type TestContext } from './helpers/context.js';

let ctx: TestContext;
let cookie: string;

beforeEach(async () => {
  ctx = await createTestContext();
  ({ cookie } = await ctx.loginAs());
});
afterEach(async () => {
  await ctx.close();
});

const proxy = (url: string) => ctx.req(`/api/attachment-proxy?url=${encodeURIComponent(url)}`, { cookie });
const S3 = 'https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/5000/original/foto.jpg?X-Amz-Signature=abc';

describe('isAllowedAttachmentUrl', () => {
  it('accepts only exact hosts and path prefixes over https', () => {
    const allow = ctx.deps.config.attachmentAllow;
    const ok = (u: string) => isAllowedAttachmentUrl(new URL(u), allow);
    expect(ok(S3)).toBe(true);
    expect(ok('https://flptest.freshdesk.com/helpdesk/attachments/1')).toBe(true);
    expect(ok('https://attachment.freshdesk.com/inline/attachment?token=x')).toBe(true);
    expect(ok('https://s3.amazonaws.com/some-other-bucket/secret.txt')).toBe(false);
    expect(ok('https://s3-eu-west-1.amazonaws.com/cdn.freshdesk.com/x')).toBe(false);
    expect(ok('http://attachment.freshdesk.com/x')).toBe(false);
    expect(ok('https://attachment.freshdesk.com.evil.com/x')).toBe(false);
    expect(ok('https://other.freshdesk.com/x')).toBe(false);
    expect(ok('https://user:pw@attachment.freshdesk.com/x')).toBe(false);
    expect(ok('https://attachment.freshdesk.com:8443/x')).toBe(false);
  });
});

describe('GET /api/attachment-proxy', () => {
  it('fetches an allowed attachment without credentials and returns it', async () => {
    ctx.fake.on('GET', 'https://s3.amazonaws.com/cdn.freshdesk.com/', () =>
      new Response(Buffer.from('JPEGDATA'), { headers: { 'content-type': 'image/jpeg' } }),
    );
    const res = await proxy(S3);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('JPEGDATA');
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');
    expect(ctx.fake.calls[0]?.url).toBe(S3);
    expect(ctx.fake.calls[0]?.headers.get('authorization')).toBeNull();
  });

  it('refuses disallowed hosts before any request is made', async () => {
    const res = await proxy('https://169.254.169.254/latest/meta-data');
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toBe('Domain nicht erlaubt: 169.254.169.254');
    expect((await proxy('not a url')).status).toBe(400);
    expect((await ctx.req('/api/attachment-proxy', { cookie })).status).toBe(400);
    expect(ctx.fake.calls).toHaveLength(0);
  });

  it('re-checks every redirect hop', async () => {
    ctx.fake
      .on('GET', 'https://attachment.freshdesk.com/', () =>
        new Response(null, { status: 302, headers: { location: 'https://s3.amazonaws.com/cdn.freshdesk.com/ok.png' } }),
      )
      .on('GET', 'https://s3.amazonaws.com/cdn.freshdesk.com/ok.png', () =>
        new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }),
      );
    const res = await proxy('https://attachment.freshdesk.com/inline/attachment?token=t');
    expect(res.status).toBe(403);
    expect(ctx.fake.calls.map((c) => c.url)).toEqual([
      'https://attachment.freshdesk.com/inline/attachment?token=t',
      'https://s3.amazonaws.com/cdn.freshdesk.com/ok.png',
    ]);
  });

  it('caps the size at 5 MB and maps upstream errors', async () => {
    ctx.fake
      .on('GET', 'https://attachment.freshdesk.com/big', () => new Response(Buffer.alloc(5 * 1024 * 1024 + 1)))
      .on('GET', 'https://attachment.freshdesk.com/gone', () => new Response('nope', { status: 404 }));
    expect((await proxy('https://attachment.freshdesk.com/big')).status).toBe(413);
    const gone = await proxy('https://attachment.freshdesk.com/gone');
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: { type: 'UPSTREAM_ERROR', message: 'Upstream 404' } });
  });

  it('requires a session', async () => {
    expect((await ctx.req(`/api/attachment-proxy?url=${encodeURIComponent(S3)}`)).status).toBe(401);
  });
});
```


- [ ] **Step 2: Run it to verify it fails**

Run:

```bash
npx vitest run test/attachment-proxy.test.ts
```

Expected: FAIL — `server/proxy/attachmentProxy.js` not found.


- [ ] **Step 3: Implement the attachment proxy**

Unlike the old proxy's `^s3.*\.amazonaws\.com$` wildcard, S3 is only allowed for Freshdesk's own bucket paths, and every redirect hop is re-checked. The default list is verified against a real attachment URL at the first deploy (DEPLOY.md §8); `ATTACHMENT_PROXY_ALLOW` overrides it.

Create `server/proxy/attachmentProxy.ts`:

```ts
import { Hono } from 'hono';
import type { AllowEntry } from '../config.js';
import type { AppDeps } from '../deps.js';
import { MB } from '../http/body.js';
import type { AppEnv } from '../types.js';
import { ApiError } from '../util/errors.js';

export const MAX_ATTACHMENT_BYTES = 5 * MB;
const MAX_REDIRECTS = 3;

/** Exact host plus path prefix; https only; no credentials or custom ports. */
export function isAllowedAttachmentUrl(url: URL, allow: AllowEntry[]): boolean {
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return allow.some((entry) => entry.host === host && url.pathname.startsWith(entry.pathPrefix));
}

async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new ApiError('PAYLOAD_TOO_LARGE', 'Anhang zu groß (max 5 MB)');
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ApiError('PAYLOAD_TOO_LARGE', 'Anhang zu groß (max 5 MB)');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function attachmentProxyRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/attachment-proxy', async (c) => {
    const raw = c.req.query('url');
    if (!raw) throw new ApiError('INVALID_REQUEST', 'url fehlt');
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ApiError('INVALID_REQUEST', 'Ungültige URL');
    }

    let upstream: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isAllowedAttachmentUrl(url, deps.config.attachmentAllow)) {
        throw new ApiError('FORBIDDEN', `Domain nicht erlaubt: ${url.hostname}`);
      }
      let res: Response;
      try {
        res = await deps.fetch(url.toString(), {
          redirect: 'manual',
          signal: AbortSignal.timeout(deps.timeouts.upstreamMs),
        });
      } catch {
        throw new ApiError('UPSTREAM_UNAVAILABLE', 'Anhang konnte nicht geladen werden');
      }
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        url = new URL(location, url);
        continue;
      }
      upstream = res;
      break;
    }
    if (!upstream) throw new ApiError('UPSTREAM_ERROR', 'Zu viele Weiterleitungen');
    if (!upstream.ok) {
      const status = upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502;
      throw new ApiError('UPSTREAM_ERROR', `Upstream ${upstream.status}`, status);
    }
    const data = await readCapped(upstream, MAX_ATTACHMENT_BYTES);
    return new Response(new Uint8Array(data), {
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        'cache-control': 'private, max-age=300',
      },
    });
  });

  return app;
}
```


- [ ] **Step 4: Mount it in `server/app.ts`**

In `server/app.ts`, replace:

```ts
import { anthropicRoutes } from './proxy/anthropic.js';
```

with:

```ts
import { anthropicRoutes } from './proxy/anthropic.js';
import { attachmentProxyRoutes } from './proxy/attachmentProxy.js';
```

In `server/app.ts`, replace:

```ts
  api.route('/', anthropicRoutes(deps));
```

with:

```ts
  api.route('/', anthropicRoutes(deps));
  api.route('/', attachmentProxyRoutes(deps));
```


- [ ] **Step 5: Run the test to verify it passes**

Run:

```bash
npx vitest run test/attachment-proxy.test.ts
```

Expected: 6 tests pass.


- [ ] **Step 6: Run the whole suite, typecheck and lint**

Run:

```bash
npm test && npm run typecheck && npm run lint
```


- [ ] **Step 7: Commit**

```bash
git add server/proxy/attachmentProxy.ts server/app.ts test/attachment-proxy.test.ts
git commit -F - <<'EOF'
feat(server): add attachment proxy restricted to exact Freshdesk file hosts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FVrKcG5sQkpYKqUZGYjujR
EOF
```


---

### Task 15: Admin backup download

**Files:**
- Create: server/admin/backup.ts
- Modify: server/admin/routes.ts (full replacement below)
- Test: test/backup.test.ts

**Interfaces:**
- Consumes: `TABLE_NAMES` (Task 2); `RecordStore.count` (Task 4); `adminRoutes` (Task 11).
- Produces: `createBackupArchive(db, records, dataDir, now): Promise<{ file; filename; cleanup() }>`; `GET /api/admin/backup` (admin-only) streaming `erp-backup-<timestamp>.tar.gz` with `erp.db` (VACUUM INTO snapshot), `files/…`, `manifest.json`.

- [ ] **Step 1: Write the failing test**

Create `test/backup.test.ts`:

```ts
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { list, extract } from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../server/db/database.js';
import { createTestContext, type TestContext } from './helpers/context.js';

let ctx: TestContext;
let admin: { cookie: string };
let out: string;

beforeEach(async () => {
  ctx = await createTestContext();
  admin = await ctx.loginAs({ isAdmin: true });
  out = await mkdtemp(path.join(os.tmpdir(), 'erp-backup-out-'));
});
afterEach(async () => {
  await ctx.close();
  await rm(out, { recursive: true, force: true });
});

describe('GET /api/admin/backup', () => {
  it('downloads a tar.gz with a DB snapshot, the files and a manifest, then cleans up', async () => {
    const att = await ctx.deps.db.write((tx) => ctx.deps.records.insert(tx, 'Attachment', { name: 'Datenblatt' }));
    await ctx.deps.db.write((tx) => ctx.deps.records.insert(tx, 'Invoice', { invoice_no: 'R-1001' }));
    await ctx.req(`/api/data/Attachment/${att.id}/files/file`, {
      method: 'POST',
      cookie: admin.cookie,
      body: { contentType: 'application/pdf', file: Buffer.from('%PDF').toString('base64'), filename: 'blatt.pdf' },
    });

    const res = await ctx.req('/api/admin/backup', { cookie: admin.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/gzip');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="erp-backup-2026-01-05T08-00-00-000Z.tar.gz"');
    const archive = path.join(out, 'backup.tar.gz');
    await writeFile(archive, Buffer.from(await res.arrayBuffer()));

    const entries: string[] = [];
    await list({ file: archive, onReadEntry: (e) => entries.push(e.path) });
    expect(entries).toContain('erp.db');
    expect(entries).toContain('manifest.json');
    expect(entries.some((e) => /^files\/att[A-Za-z0-9]{14}\/blatt\.pdf$/.test(e))).toBe(true);

    await extract({ file: archive, cwd: out });
    const manifest = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8'));
    expect(manifest.created_at).toBe('2026-01-05T08:00:00.000Z');
    expect(manifest.tables).toMatchObject({ Invoice: 1, Attachment: 1, User: 1 });
    const snapshot = await openDatabase(path.join(out, 'erp.db'));
    expect((await snapshot.query('SELECT count(*) AS n FROM "Invoice"'))[0]?.n).toBe(1);
    snapshot.close();

    await new Promise((r) => setTimeout(r, 50));
    expect((await readdir(ctx.dataDir)).filter((n) => n.startsWith('tmp-backup-'))).toEqual([]);
  });

  it('is admin-only', async () => {
    const { cookie } = await ctx.loginAs();
    expect((await ctx.req('/api/admin/backup', { cookie })).status).toBe(403);
  });
});
```


- [ ] **Step 2: Run it to verify it fails**

Run:

```bash
npx vitest run test/backup.test.ts
```

Expected: FAIL — 1 of 2 tests fails: `/api/admin/backup` answers 404 (the admin-only test already passes because `/api/admin/*` is admin-guarded).


- [ ] **Step 3: Implement the archive builder**

The archive is written to a temp dir on the same volume first (node-tar's stream is not a Node `Readable`, so it cannot be handed to `Readable.toWeb` directly). The route streams the file and deletes the temp dir when the stream closes.

Create `server/admin/backup.ts`:

```ts
import { mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { create } from 'tar';
import { TABLE_NAMES } from '../data/tables.js';
import type { RecordStore } from '../data/records.js';
import type { Database } from '../db/database.js';

export interface BackupArchive {
  file: string;
  filename: string;
  cleanup: () => Promise<void>;
}

/**
 * Consistent snapshot of the database (VACUUM INTO) plus all uploaded files and a
 * manifest, packed as .tar.gz in a temp dir on the same volume. Call cleanup() when done.
 */
export async function createBackupArchive(db: Database, records: RecordStore, dataDir: string, now: Date): Promise<BackupArchive> {
  const tmp = await mkdtemp(path.join(dataDir, 'tmp-backup-'));
  try {
    await db.client.execute({ sql: 'VACUUM INTO ?', args: [path.join(tmp, 'erp.db')] });
    const tables: Record<string, number> = {};
    for (const table of TABLE_NAMES) tables[table] = await records.count(table);
    await writeFile(path.join(tmp, 'manifest.json'), JSON.stringify({ created_at: now.toISOString(), tables }, null, 2));

    const entries = ['erp.db', 'manifest.json'];
    const filesDir = path.join(dataDir, 'files');
    if (await stat(filesDir).catch(() => null)) {
      await symlink(filesDir, path.join(tmp, 'files'), 'dir');
      entries.push('files');
    }
    const filename = `erp-backup-${now.toISOString().replace(/[:.]/g, '-')}.tar.gz`;
    const file = path.join(tmp, filename);
    await create({ gzip: true, cwd: tmp, file, follow: true, portable: true }, entries);
    return { file, filename, cleanup: () => rm(tmp, { recursive: true, force: true }) };
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }
}
```


- [ ] **Step 4: Add the route: replace `server/admin/routes.ts`**

Replace the whole content of `server/admin/routes.ts` with:

```ts
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { requireAdmin } from '../auth/middleware.js';
import { hashLoginKey, verifyLoginKey } from '../auth/passwords.js';
import type { AppDeps } from '../deps.js';
import { isPlainObject, readJsonBody } from '../http/body.js';
import type { AppEnv } from '../types.js';
import { ApiError } from '../util/errors.js';
import { newLoginKey } from '../util/ids.js';
import { createBackupArchive } from './backup.js';

const optionalSecret = (value: unknown, name: string): string | null => {
  if (value === null) return null;
  if (typeof value !== 'string') throw new ApiError('INVALID_REQUEST', `${name} muss Text oder null sein`);
  return value.trim() === '' ? null : value.trim();
};

async function keyInUseByOther(deps: AppDeps, key: string, userId: string): Promise<boolean> {
  for (const [otherId, hash] of await deps.secrets.apiKeyHashes()) {
    if (otherId !== userId && (await verifyLoginKey(key, hash))) return true;
  }
  return false;
}

/** Mounted at /api/admin. Everything here is admin-only. */
export function adminRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', requireAdmin);

  app.patch('/users/:id/secrets', async (c) => {
    const userId = c.req.param('id');
    if (!(await deps.records.get('User', userId))) throw new ApiError('NOT_FOUND', 'Benutzer nicht gefunden');
    const body = await readJsonBody(c);

    let newKey: string | null | undefined;
    let generated = false;
    if (body.generate_api_key === true) {
      newKey = newLoginKey();
      generated = true;
    } else if (body.api_key === null) {
      newKey = null;
    } else if (body.api_key !== undefined) {
      if (typeof body.api_key !== 'string' || body.api_key.trim().length < 12) {
        throw new ApiError('VALIDATION_FAILED', 'Login-Key muss mindestens 12 Zeichen haben');
      }
      newKey = body.api_key.trim();
    }
    if (newKey && (await keyInUseByOther(deps, newKey, userId))) {
      throw new ApiError('KEY_IN_USE', 'Dieser Login-Key wird bereits verwendet');
    }
    const hash = newKey ? await hashLoginKey(newKey) : null;

    let companyPatch: Record<string, string | null> | undefined;
    if (body.freshdesk_keys !== undefined) {
      if (!isPlainObject(body.freshdesk_keys)) throw new ApiError('INVALID_REQUEST', 'freshdesk_keys muss ein Objekt sein');
      companyPatch = Object.fromEntries(
        Object.entries(body.freshdesk_keys).map(([companyId, v]) => [companyId, optionalSecret(v, 'freshdesk_keys')]),
      );
    }
    const defaultKey = body.freshdesk_api_key === undefined ? undefined : optionalSecret(body.freshdesk_api_key, 'freshdesk_api_key');

    await deps.db.write(async (tx) => {
      if (newKey !== undefined) await deps.secrets.setApiKeyHash(tx, userId, hash);
      if (defaultKey !== undefined) await deps.secrets.setFreshdeskDefault(tx, userId, defaultKey);
      if (companyPatch) await deps.secrets.mergeFreshdeskKeys(tx, userId, companyPatch);
    });

    const info = await deps.secrets.userInfo(userId);
    return c.json({
      ...(generated && newKey ? { api_key: newKey } : {}),
      has_api_key: info.hasApiKey,
      has_freshdesk_key: info.hasFreshdeskKey,
      freshdesk_company_keys: info.freshdeskCompanyKeys,
    });
  });

  app.patch('/companies/:id/secrets', async (c) => {
    const companyId = c.req.param('id');
    if (!(await deps.records.get('Company', companyId))) throw new ApiError('NOT_FOUND', 'Firma nicht gefunden');
    const body = await readJsonBody(c);
    if (body.mailchimp_api_key === undefined) throw new ApiError('INVALID_REQUEST', 'mailchimp_api_key fehlt');
    const key = optionalSecret(body.mailchimp_api_key, 'mailchimp_api_key');
    await deps.db.write((tx) => deps.secrets.setMailchimpKey(tx, companyId, key));
    return c.json({ has_mailchimp_key: key !== null });
  });

  app.get('/backup', async () => {
    const archive = await createBackupArchive(deps.db, deps.records, deps.config.dataDir, new Date(deps.now()));
    const { size } = await stat(archive.file);
    const stream = createReadStream(archive.file);
    stream.on('close', () => void archive.cleanup());
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      headers: {
        'content-type': 'application/gzip',
        'content-length': String(size),
        'content-disposition': `attachment; filename="${archive.filename}"`,
        'cache-control': 'no-store',
      },
    });
  });

  return app;
}
```


- [ ] **Step 5: Run the test to verify it passes**

Run:

```bash
npx vitest run test/backup.test.ts
```

Expected: 2 tests pass.


- [ ] **Step 6: Run the whole suite, typecheck and lint**

Run:

```bash
npm test && npm run typecheck && npm run lint
```


- [ ] **Step 7: Commit**

```bash
git add server/admin test/backup.test.ts
git commit -F - <<'EOF'
feat(server): add admin backup download (database snapshot and files)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FVrKcG5sQkpYKqUZGYjujR
EOF
```


---

### Task 16: Read-only Airtable reader for the import

**Files:**
- Create: server/import/airtable.ts
- Test: test/airtable-reader.test.ts

**Interfaces:**
- Consumes: `FetchFn` (Task 3); `isPlainObject` (Task 3).
- Produces: `class AirtableReader({ token, fetch, sleep?, now?, minIntervalMs?, retryWaitMs?, maxRetries? })` with `listTables(baseId): Promise<AirtableTable[]>`, `listRecords(baseId, table, { filterByFormula? }): Promise<AirtableApiRecord[]>`, `download(url): Promise<{ data: Buffer; contentType }>`; types `AirtableTable`, `AirtableField`, `AirtableApiRecord`.

- [ ] **Step 1: Write the failing test**

Create `test/airtable-reader.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AirtableReader } from '../server/import/airtable.js';
import { FakeFetch, jsonResponse } from './helpers/fakeFetch.js';

function setup() {
  const fake = new FakeFetch();
  let now = 0;
  const sleeps: number[] = [];
  const reader = new AirtableReader({
    token: 'pat-read-only',
    fetch: fake.fetch,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });
  return { fake, reader, sleeps };
}

describe('AirtableReader', () => {
  it('follows offset pagination and sends only GET with the bearer token', async () => {
    const { fake, reader } = setup();
    fake.on('GET', 'https://api.airtable.com/v0/appX/Customer', (call) => {
      const offset = new URL(call.url).searchParams.get('offset');
      if (!offset) return jsonResponse({ records: [{ id: 'rec1', createdTime: 't1', fields: {} }], offset: 'o1' });
      if (offset === 'o1') return jsonResponse({ records: [{ id: 'rec2', createdTime: 't2', fields: {} }], offset: 'o2' });
      return jsonResponse({ records: [{ id: 'rec3', createdTime: 't3', fields: {} }] });
    });
    const records = await reader.listRecords('appX', 'Customer');
    expect(records.map((r) => r.id)).toEqual(['rec1', 'rec2', 'rec3']);
    expect(fake.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(fake.calls[0]?.headers.get('authorization')).toBe('Bearer pat-read-only');
    expect(new URL(fake.calls[0]?.url ?? '').searchParams.get('pageSize')).toBe('100');
  });

  it('passes filterByFormula and encodes table names', async () => {
    const { fake, reader } = setup();
    fake.on('GET', 'https://api.airtable.com/v0/appM/Keys', () => jsonResponse({ records: [] }));
    await reader.listRecords('appM', 'Keys', { filterByFormula: "{project_id}='p_1'" });
    expect(new URL(fake.calls[0]?.url ?? '').searchParams.get('filterByFormula')).toBe("{project_id}='p_1'");
  });

  it('stays at or below 5 requests per second', async () => {
    const { fake, reader, sleeps } = setup();
    fake.on('GET', 'https://api.airtable.com/v0/', () => jsonResponse({ records: [] }));
    for (let i = 0; i < 4; i++) await reader.listRecords('appX', `T${i}`);
    expect(sleeps).toEqual([200, 200, 200]);
  });

  it('waits 30 s and retries on 429, up to 3 times, then fails', async () => {
    const { fake, reader, sleeps } = setup();
    let hits = 0;
    fake.on('GET', 'https://api.airtable.com/v0/appX/A', () => (++hits < 3 ? jsonResponse({}, 429) : jsonResponse({ records: [] })));
    await reader.listRecords('appX', 'A');
    expect(sleeps.filter((s) => s === 30_000)).toHaveLength(2);

    fake.on('GET', 'https://api.airtable.com/v0/appX/B', () => jsonResponse({}, 429));
    await expect(reader.listRecords('appX', 'B')).rejects.toThrow('Airtable GET /v0/appX/B failed with HTTP 429');
  });

  it('reads the schema and fails clearly on errors without leaking the token', async () => {
    const { fake, reader } = setup();
    fake
      .on('GET', 'https://api.airtable.com/v0/meta/bases/appX/tables', () =>
        jsonResponse({ tables: [{ id: 'tbl1', name: 'Customer', fields: [{ id: 'fld1', name: 'name', type: 'singleLineText' }] }] }),
      )
      .on('GET', 'https://api.airtable.com/v0/meta/bases/appBAD/tables', () => jsonResponse({ error: 'x' }, 403));
    expect((await reader.listTables('appX'))[0]?.name).toBe('Customer');
    const err = await reader.listTables('appBAD').catch((e: Error) => e);
    expect(String(err)).toContain('HTTP 403');
    expect(String(err)).not.toContain('pat-read-only');
  });

  it('downloads attachments', async () => {
    const { fake, reader } = setup();
    fake
      .on('GET', 'https://v5.airtableusercontent.com/ok', () => new Response(Buffer.from('PNG'), { headers: { 'content-type': 'image/png' } }))
      .on('GET', 'https://v5.airtableusercontent.com/expired', () => new Response('gone', { status: 410 }));
    const file = await reader.download('https://v5.airtableusercontent.com/ok');
    expect(file.data.toString()).toBe('PNG');
    expect(file.contentType).toBe('image/png');
    await expect(reader.download('https://v5.airtableusercontent.com/expired')).rejects.toThrow('HTTP 410');
  });
});
```


- [ ] **Step 2: Run it to verify it fails**

Run:

```bash
npx vitest run test/airtable-reader.test.ts
```

Expected: FAIL — `server/import/airtable.js` not found.


- [ ] **Step 3: Implement the reader**

It only ever sends GET. It keeps ≤5 requests/second (Airtable's per-base limit), waits 30 s after a 429 (as Airtable asks), and never puts the token into error messages.

Create `server/import/airtable.ts`:

```ts
import type { FetchFn } from '../deps.js';
import { isPlainObject } from '../http/body.js';

export interface AirtableField {
  id: string;
  name: string;
  type: string;
}

export interface AirtableTable {
  id: string;
  name: string;
  fields: AirtableField[];
}

export interface AirtableApiRecord {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
}

export interface AirtableReaderOptions {
  token: string;
  fetch: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** 200 ms between API requests = at most 5 requests/second (Airtable's per-base limit). */
  minIntervalMs?: number;
  /** Airtable asks clients to wait 30 s after a 429. */
  retryWaitMs?: number;
  maxRetries?: number;
}

const API = 'https://api.airtable.com/v0';

/** Read-only Airtable client for the one-time import. It only ever sends GET requests. */
export class AirtableReader {
  private lastRequestAt = Number.NEGATIVE_INFINITY;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly o: AirtableReaderOptions) {
    this.sleep = o.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = o.now ?? Date.now;
  }

  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + (this.o.minIntervalMs ?? 200) - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();
  }

  private async getJson(url: string): Promise<Record<string, unknown>> {
    const maxRetries = this.o.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      const res = await this.o.fetch(url, { method: 'GET', headers: { authorization: `Bearer ${this.o.token}` } });
      if (res.status === 429 && attempt < maxRetries) {
        await this.sleep(this.o.retryWaitMs ?? 30_000);
        continue;
      }
      if (!res.ok) throw new Error(`Airtable GET ${new URL(url).pathname} failed with HTTP ${res.status}`);
      const data: unknown = await res.json();
      if (!isPlainObject(data)) throw new Error(`Airtable GET ${new URL(url).pathname} returned unexpected data`);
      return data;
    }
  }

  async listTables(baseId: string): Promise<AirtableTable[]> {
    const data = await this.getJson(`${API}/meta/bases/${encodeURIComponent(baseId)}/tables`);
    if (!Array.isArray(data.tables)) throw new Error('Airtable schema response has no tables');
    return data.tables as AirtableTable[];
  }

  /** All records of a table, following Airtable's `offset` pagination. */
  async listRecords(baseId: string, table: string, opts: { filterByFormula?: string } = {}): Promise<AirtableApiRecord[]> {
    const records: AirtableApiRecord[] = [];
    let offset: string | undefined;
    do {
      const params = new URLSearchParams({ pageSize: '100' });
      if (opts.filterByFormula) params.set('filterByFormula', opts.filterByFormula);
      if (offset) params.set('offset', offset);
      const data = await this.getJson(`${API}/${encodeURIComponent(baseId)}/${encodeURIComponent(table)}?${params.toString()}`);
      if (!Array.isArray(data.records)) throw new Error(`Airtable table ${table} returned no records array`);
      records.push(...(data.records as AirtableApiRecord[]));
      offset = typeof data.offset === 'string' ? data.offset : undefined;
    } while (offset);
    return records;
  }

  /** Downloads an attachment from its (expiring) Airtable URL. */
  async download(url: string): Promise<{ data: Buffer; contentType: string }> {
    const res = await this.o.fetch(url, { method: 'GET' });
    if (!res.ok) throw new Error(`Download failed with HTTP ${res.status}`);
    return {
      data: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    };
  }
}
```


- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
npx vitest run test/airtable-reader.test.ts
```

Expected: 6 tests pass.


- [ ] **Step 5: Typecheck and lint**

Run:

```bash
npm run typecheck && npm run lint
```


- [ ] **Step 6: Commit**

```bash
git add server/import/airtable.ts test/airtable-reader.test.ts
git commit -F - <<'EOF'
feat(server): add read-only Airtable reader with pagination and rate limiting

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FVrKcG5sQkpYKqUZGYjujR
EOF
```


---

### Task 17: Airtable → SQLite importer and report

**Files:**
- Create: server/import/report.ts, server/import/importer.ts
- Test: test/importer.test.ts

**Interfaces:**
- Consumes: `AirtableReader` (Task 16); `RecordStore` (Task 4); `SecretStore`, `hashLoginKey` (Task 5); `FileStore` (Task 10); `companyOf` (Task 8); `isSettingKey`, `upsertSetting` (Task 11); `isSecretField` (Task 4); `TABLE_NAMES`, `NUMBER_SPECS`, `attachmentFieldRule`, `isTableName` (Task 2); `openDatabase`, `runMigrations` (Task 2).
- Produces: `runImport({ reader, appBaseId, masterBaseId, projectId, stagingDir, secretsKey, now?, log? }): Promise<ImportReport>`; `COMPUTED_FIELD_TYPES`; `interface ImportReport` (see file); `emptyReport(startedAt)`, `formatReport(report): string`. Writes `<stagingDir>/erp.db`, `<stagingDir>/files/…`, `<stagingDir>/import-report.json`.

- [ ] **Step 1: Write the failing test**

Create `test/importer.test.ts`:

```ts
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyLoginKey } from '../server/auth/passwords.js';
import { RecordStore } from '../server/data/records.js';
import { TABLE_NAMES } from '../server/data/tables.js';
import { openDatabase } from '../server/db/database.js';
import { AirtableReader, type AirtableApiRecord } from '../server/import/airtable.js';
import { runImport } from '../server/import/importer.js';
import { SecretStore } from '../server/secrets/store.js';
import { readSettings } from '../server/settings/store.js';
import { FakeFetch, jsonResponse } from './helpers/fakeFetch.js';

const KEY = Buffer.alloc(32, 5);
const APP = 'appAPPAPPAPPAPP12';
const MASTER = 'appMASTERMASTER12';
const PROJECT = 'p_1778057282571';
const rid = (n: number) => `rec${String(n).padStart(14, '0')}`;

const extraFields: Record<string, { name: string; type: string }[]> = {
  Customer: [
    { name: 'name', type: 'singleLineText' },
    { name: 'display_name', type: 'formula' },
    { name: 'photo', type: 'multipleAttachments' },
  ],
  Attachment: [
    { name: 'name', type: 'singleLineText' },
    { name: 'file', type: 'multipleAttachments' },
  ],
  Invoice: [{ name: 'order_count', type: 'count' }],
};

const tableData: Record<string, AirtableApiRecord[]> = {
  Customer: Array.from({ length: 150 }, (_, i) => ({
    id: rid(i + 1),
    createdTime: `2024-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
    fields: i === 0 ? { name: 'Müller GmbH', company_id: [rid(900)], portal_password: 'hunter2' } : { name: `K${i}` },
  })),
  Company: [{ id: rid(900), createdTime: '2023-01-01T00:00:00.000Z', fields: { name: 'FLP', mailchimp_api_key: 'mc-us21', status: 'aktiv' } }],
  User: [
    {
      id: rid(800),
      createdTime: '2023-01-01T00:00:00.000Z',
      fields: {
        name: 'Anna',
        status: 'aktiv',
        api_key: 'annaoldkey1234567890abcd',
        freshdesk_api_key: 'fd-default',
        freshdesk_keys_json: JSON.stringify({ [rid(900)]: 'fd-flp' }),
      },
    },
    { id: rid(801), createdTime: '2023-01-01T00:00:00.000Z', fields: { name: 'NoKey', status: 'aktiv', freshdesk_keys_json: '{broken' } },
  ],
  Invoice: [
    { id: rid(700), createdTime: '2025-01-01T00:00:00.000Z', fields: { invoice_no: 'R-1001', company_id: rid(900), customer_id: rid(999) } },
    { id: rid(701), createdTime: '2025-01-02T00:00:00.000Z', fields: { invoice_no: 'R-1001', company_id: rid(900) } },
  ],
  Attachment: [
    {
      id: rid(600),
      createdTime: '2025-01-01T00:00:00.000Z',
      fields: {
        name: 'Datenblatt',
        file: [{ id: 'attAAAAAAAAAAAAAA', url: 'https://v5.airtableusercontent.com/ok', filename: 'blatt.pdf', size: 3, type: 'application/pdf' }],
      },
    },
  ],
};

function fakeAirtable(options: { failDownload?: boolean } = {}) {
  const fake = new FakeFetch();
  fake.on('GET', `https://api.airtable.com/v0/meta/bases/${APP}/tables`, () =>
    jsonResponse({
      tables: [
        ...TABLE_NAMES.map((name, i) => ({ id: `tbl${i}`, name, fields: extraFields[name] ?? [] })),
        { id: 'tblX', name: 'Projects', fields: [] },
      ],
    }),
  );
  fake.on('GET', `https://api.airtable.com/v0/${APP}/`, (call) => {
    const url = new URL(call.url);
    const table = decodeURIComponent(url.pathname.split('/').pop() ?? '');
    const rows = tableData[table] ?? [];
    const start = Number(url.searchParams.get('offset') ?? '0');
    const page = rows.slice(start, start + 100);
    return jsonResponse({ records: page, ...(start + 100 < rows.length ? { offset: String(start + 100) } : {}) });
  });
  fake.on('GET', `https://api.airtable.com/v0/${MASTER}/Keys`, () =>
    jsonResponse({
      records: [
        { id: 'recK1', createdTime: 't', fields: { project_id: PROJECT, key_name: 'freshdeskDomain', key_value: 'flpliftparts' } },
        { id: 'recK2', createdTime: 't', fields: { project_id: PROJECT, key_name: 'anthropicKey', key_value: 'sk-ant-SECRET' } },
        { id: 'recK3', createdTime: 't', fields: { project_id: 'p_other', key_name: 'freshdeskTicketTypes', key_value: 'x' } },
      ],
    }),
  );
  fake.on('GET', 'https://v5.airtableusercontent.com/ok', () =>
    options.failDownload ? new Response('expired', { status: 410 }) : new Response(Buffer.from('PDF'), { headers: { 'content-type': 'application/pdf' } }),
  );
  return fake;
}

let base: string;
let staging: string;
beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'erp-import-'));
  staging = path.join(base, 'import-1');
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const run = (fake: FakeFetch) =>
  runImport({
    reader: new AirtableReader({ token: 'pat', fetch: fake.fetch, minIntervalMs: 0 }),
    appBaseId: APP,
    masterBaseId: MASTER,
    projectId: PROJECT,
    stagingDir: staging,
    secretsKey: KEY,
    now: () => Date.parse('2026-03-01T12:00:00.000Z'),
  });

describe('runImport', () => {
  it('copies every record with its id and createdTime, using only GET requests', async () => {
    const fake = fakeAirtable();
    const report = await run(fake);
    expect(fake.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(report.tables.Customer).toEqual({ airtable: 150, imported: 150 });
    expect(report.countMismatches).toEqual([]);

    const db = await openDatabase(path.join(staging, 'erp.db'));
    const records = new RecordStore(db);
    const first = await records.get('Customer', rid(1));
    expect(first?.createdTime).toBe('2024-01-01T00:00:00.000Z');
    expect(first?.fields).toEqual({ name: 'Müller GmbH', company_id: [rid(900)] });
    db.close();
  });

  it('moves secrets out of records: hashed login keys, encrypted Freshdesk and Mailchimp keys', async () => {
    const report = await run(fakeAirtable());
    const db = await openDatabase(path.join(staging, 'erp.db'));
    const records = new RecordStore(db);
    const secrets = new SecretStore(db, KEY);
    expect((await records.get('User', rid(800)))?.fields).toEqual({ name: 'Anna', status: 'aktiv' });
    const hash = (await secrets.apiKeyHashes()).get(rid(800)) ?? '';
    expect(await verifyLoginKey('annaoldkey1234567890abcd', hash)).toBe(true);
    expect(await secrets.freshdeskKeyFor(rid(800), rid(900))).toBe('fd-flp');
    expect(await secrets.freshdeskKeyFor(rid(800), null)).toBe('fd-default');
    expect(await secrets.mailchimpKey(rid(900))).toBe('mc-us21');
    expect((await records.get('Company', rid(900)))?.fields).toEqual({ name: 'FLP', status: 'aktiv' });
    expect(report.strippedSecretFields).toEqual(['Customer.portal_password']);
    expect(report.usersWithoutKey).toEqual([rid(801)]);
    expect(report.warnings).toEqual([`User ${rid(801)}: freshdesk_keys_json ist kein gültiges JSON – übersprungen`]);
    const dump = JSON.stringify(await db.query('SELECT * FROM user_secrets')) + JSON.stringify(await db.query('SELECT * FROM company_secrets'));
    expect(dump).not.toMatch(/annaoldkey|fd-flp|fd-default|mc-us21/);
    db.close();
  });

  it('downloads attachments and rewrites them to our file URLs, keeping the attachment id', async () => {
    const report = await run(fakeAirtable());
    expect(report.attachments).toEqual({ downloaded: 1, bytes: 3, failed: [] });
    const db = await openDatabase(path.join(staging, 'erp.db'));
    const att = (await new RecordStore(db).get('Attachment', rid(600)))?.fields.file;
    expect(att).toEqual([
      { id: 'attAAAAAAAAAAAAAA', url: '/api/files/attAAAAAAAAAAAAAA/blatt.pdf', filename: 'blatt.pdf', size: 3, type: 'application/pdf' },
    ]);
    expect((await readFile(path.join(staging, 'files', 'attAAAAAAAAAAAAAA', 'blatt.pdf'))).toString()).toBe('PDF');
    db.close();
  });

  it('imports only allowlisted settings from ERP Hero rows of the Master base', async () => {
    const report = await run(fakeAirtable());
    const db = await openDatabase(path.join(staging, 'erp.db'));
    expect(await readSettings(db)).toEqual({ freshdeskDomain: 'flpliftparts' });
    db.close();
    expect(report.importedSettings).toEqual(['freshdeskDomain']);
    expect(report.skippedSettingKeys).toEqual(['anthropicKey']);
    expect(JSON.stringify(report)).not.toContain('sk-ant-SECRET');
  });

  it('reports computed fields, unknown tables, unregistered attachment fields, dangling links and duplicate numbers', async () => {
    const report = await run(fakeAirtable());
    expect(report.computedFields).toEqual({ Customer: ['display_name'], Invoice: ['order_count'] });
    expect(report.unknownTables).toEqual(['Projects']);
    expect(report.unregisteredAttachmentFields).toEqual(['Customer.photo']);
    expect(report.danglingLinks).toEqual({ 'Invoice.customer_id': { count: 1, sample: [rid(999)] } });
    expect(report.duplicateNumbers).toEqual([{ type: 'invoice', companyId: rid(900), number: 'R-1001', recordIds: [rid(700), rid(701)] }]);
    expect(report.ok).toBe(true);
    const saved = JSON.parse(await readFile(path.join(staging, 'import-report.json'), 'utf8'));
    expect(saved.tables.Customer).toEqual({ airtable: 150, imported: 150 });
  });

  it('marks the import as not ok when an attachment cannot be downloaded', async () => {
    const report = await run(fakeAirtable({ failDownload: true }));
    expect(report.ok).toBe(false);
    expect(report.attachments.failed).toEqual([{ table: 'Attachment', recordId: rid(600), field: 'file', filename: 'blatt.pdf' }]);
  });

  it('refuses to reuse an existing staging directory', async () => {
    await run(fakeAirtable());
    await expect(run(fakeAirtable())).rejects.toThrow('Staging directory already exists');
    await access(path.join(staging, 'erp.db'));
  });
});
```


- [ ] **Step 2: Run it to verify it fails**

Run:

```bash
npx vitest run test/importer.test.ts
```

Expected: FAIL — `server/import/importer.js` not found.


- [ ] **Step 3: Implement the report type and formatter**

Create `server/import/report.ts`:

```ts
export interface FailedAttachment {
  table: string;
  recordId: string;
  field: string;
  filename: string;
}

export interface DuplicateNumber {
  type: string;
  companyId: string;
  number: string;
  recordIds: string[];
}

export interface ImportReport {
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  tables: Record<string, { airtable: number; imported: number }>;
  countMismatches: string[];
  missingTables: string[];
  unknownTables: string[];
  computedFields: Record<string, string[]>;
  unregisteredAttachmentFields: string[];
  attachments: { downloaded: number; bytes: number; failed: FailedAttachment[] };
  danglingLinks: Record<string, { count: number; sample: string[] }>;
  duplicateNumbers: DuplicateNumber[];
  usersWithoutKey: string[];
  strippedSecretFields: string[];
  importedSettings: string[];
  skippedSettingKeys: string[];
  warnings: string[];
}

export function emptyReport(startedAt: string): ImportReport {
  return {
    startedAt,
    finishedAt: startedAt,
    ok: false,
    tables: {},
    countMismatches: [],
    missingTables: [],
    unknownTables: [],
    computedFields: {},
    unregisteredAttachmentFields: [],
    attachments: { downloaded: 0, bytes: 0, failed: [] },
    danglingLinks: {},
    duplicateNumbers: [],
    usersWithoutKey: [],
    strippedSecretFields: [],
    importedSettings: [],
    skippedSettingKeys: [],
    warnings: [],
  };
}

/** Short human-readable summary for the terminal; the full report is saved as JSON. */
export function formatReport(r: ImportReport): string {
  const lines = [`Import ${r.ok ? 'OK' : 'MIT PROBLEMEN'} (${r.startedAt} → ${r.finishedAt})`, '', 'Tabellen (Airtable → SQLite):'];
  for (const [table, c] of Object.entries(r.tables)) {
    lines.push(`  ${table.padEnd(20)} ${String(c.airtable).padStart(6)} → ${String(c.imported).padStart(6)}${c.airtable === c.imported ? '' : '  ✗'}`);
  }
  const section = (title: string, items: string[]) => {
    if (items.length > 0) lines.push('', `${title}:`, ...items.map((i) => `  - ${i}`));
  };
  section('Tabellen fehlen in Airtable', r.missingTables);
  section('Unbekannte Airtable-Tabellen (nicht importiert)', r.unknownTables);
  section(
    'Berechnete Felder (als feste Werte übernommen)',
    Object.entries(r.computedFields).map(([t, f]) => `${t}: ${f.join(', ')}`),
  );
  section('Anhangsfelder ohne Upload-Freigabe', r.unregisteredAttachmentFields);
  lines.push('', `Anhänge: ${r.attachments.downloaded} Dateien, ${(r.attachments.bytes / 1024 / 1024).toFixed(1)} MB`);
  section('Fehlgeschlagene Anhänge', r.attachments.failed.map((f) => `${f.table}.${f.field} ${f.recordId}: ${f.filename}`));
  section(
    'Verweise auf fehlende Datensätze',
    Object.entries(r.danglingLinks).map(([k, v]) => `${k}: ${v.count} (z.B. ${v.sample.join(', ')})`),
  );
  section(
    'Doppelte Belegnummern',
    r.duplicateNumbers.map((d) => `${d.type} ${d.number} (Firma ${d.companyId}): ${d.recordIds.join(', ')}`),
  );
  section('Benutzer ohne Login-Key', r.usersWithoutKey);
  section('Entfernte geheime Felder', r.strippedSecretFields);
  section('Übernommene Einstellungen', r.importedSettings);
  section('Nicht übernommene Keys (Secrets → Railway-Variablen bzw. entfallen)', r.skippedSettingKeys);
  section('Warnungen', r.warnings);
  return lines.join('\n');
}
```


- [ ] **Step 4: Implement the importer**

It writes into a new staging directory and never touches the live database. It moves every secret out of the records: login keys are hashed; Freshdesk and Mailchimp keys are encrypted. From the shared Master base it only reads rows whose `project_id` is ERP Hero's, and only imports allowlisted non-secret settings. Secret key **names** go into the report; values never do.

Create `server/import/importer.ts`:

```ts
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hashLoginKey } from '../auth/passwords.js';
import { isSecretField } from '../data/fields.js';
import { FileStore, type AttachmentValue } from '../data/files.js';
import { companyOf } from '../data/numbers.js';
import { RecordStore } from '../data/records.js';
import { attachmentFieldRule, isTableName, NUMBER_SPECS, TABLE_NAMES, type TableName } from '../data/tables.js';
import { openDatabase, type Executor } from '../db/database.js';
import { runMigrations } from '../db/migrations.js';
import { isPlainObject } from '../http/body.js';
import { SecretStore } from '../secrets/store.js';
import { isSettingKey, upsertSetting } from '../settings/store.js';
import { isRecordId } from '../util/ids.js';
import type { AirtableReader } from './airtable.js';
import { emptyReport, type ImportReport } from './report.js';

export const COMPUTED_FIELD_TYPES: ReadonlySet<string> = new Set([
  'formula',
  'rollup',
  'multipleLookupValues',
  'count',
  'autoNumber',
  'createdTime',
  'lastModifiedTime',
  'createdBy',
  'lastModifiedBy',
  'button',
  'aiText',
]);

export interface ImportOptions {
  reader: AirtableReader;
  appBaseId: string;
  masterBaseId: string;
  projectId: string;
  stagingDir: string;
  secretsKey: Buffer;
  now?: () => number;
  log?: (line: string) => void;
}

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

/**
 * Copies Airtable into a NEW SQLite database in stagingDir (read-only towards Airtable).
 * The live database is untouched; activation is a separate step (db:activate + restart).
 */
export async function runImport(o: ImportOptions): Promise<ImportReport> {
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => undefined);
  if (await exists(o.stagingDir)) throw new Error(`Staging directory already exists: ${o.stagingDir}`);
  await mkdir(o.stagingDir, { recursive: true });

  const report = emptyReport(new Date(now()).toISOString());
  const db = await openDatabase(path.join(o.stagingDir, 'erp.db'));
  try {
    await runMigrations(db);
    const records = new RecordStore(db, now);
    const secrets = new SecretStore(db, o.secretsKey);
    const files = new FileStore(db, o.stagingDir, now);
    const stripped = new Set<string>();

    const importUserSecrets = async (tx: Executor, userId: string, fields: Record<string, unknown>) => {
      const apiKey = fields.api_key;
      if (typeof apiKey === 'string' && apiKey.trim() !== '') {
        await secrets.setApiKeyHash(tx, userId, await hashLoginKey(apiKey.trim()));
      }
      const fdDefault = fields.freshdesk_api_key;
      if (typeof fdDefault === 'string' && fdDefault.trim() !== '') {
        await secrets.setFreshdeskDefault(tx, userId, fdDefault.trim());
      }
      const fdJson = fields.freshdesk_keys_json;
      if (typeof fdJson === 'string' && fdJson.trim() !== '') {
        try {
          const parsed: unknown = JSON.parse(fdJson);
          if (!isPlainObject(parsed)) throw new Error('not an object');
          const patch = Object.fromEntries(
            Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].trim() !== ''),
          );
          await secrets.mergeFreshdeskKeys(tx, userId, patch);
        } catch {
          report.warnings.push(`User ${userId}: freshdesk_keys_json ist kein gültiges JSON – übersprungen`);
        }
      }
      delete fields.api_key;
      delete fields.freshdesk_api_key;
      delete fields.freshdesk_keys_json;
    };

    const importAttachments = async (
      tx: Executor,
      table: TableName,
      recordId: string,
      field: string,
      value: unknown[],
    ): Promise<AttachmentValue[]> => {
      const out: AttachmentValue[] = [];
      for (const item of value) {
        if (!isPlainObject(item) || typeof item.url !== 'string') continue;
        const filename = typeof item.filename === 'string' ? item.filename : 'datei';
        try {
          const { data, contentType } = await o.reader.download(item.url);
          out.push(
            await files.save(tx, {
              table,
              recordId,
              field,
              filename,
              contentType: typeof item.type === 'string' ? item.type : contentType,
              data,
              createdBy: 'import',
              ...(typeof item.id === 'string' ? { id: item.id } : {}),
            }),
          );
          report.attachments.downloaded++;
          report.attachments.bytes += data.length;
        } catch {
          report.attachments.failed.push({ table, recordId, field, filename });
        }
      }
      return out;
    };

    // 1. Schema
    const schema = await o.reader.listTables(o.appBaseId);
    report.unknownTables = schema.map((t) => t.name).filter((name) => !isTableName(name));

    // 2. Records, secrets and attachments
    for (const table of TABLE_NAMES) {
      const tableSchema = schema.find((t) => t.name === table);
      if (!tableSchema) {
        report.missingTables.push(table);
        continue;
      }
      const computed = tableSchema.fields.filter((f) => COMPUTED_FIELD_TYPES.has(f.type)).map((f) => f.name);
      if (computed.length > 0) report.computedFields[table] = computed;
      const attachmentFields = tableSchema.fields.filter((f) => f.type === 'multipleAttachments').map((f) => f.name);
      for (const f of attachmentFields) {
        if (!attachmentFieldRule(table, f)) report.unregisteredAttachmentFields.push(`${table}.${f}`);
      }

      const source = await o.reader.listRecords(o.appBaseId, table);
      log(`${table}: ${source.length} Datensätze`);
      for (const rec of source) {
        const fields: Record<string, unknown> = { ...rec.fields };
        await db.write(async (tx) => {
          if (table === 'User') await importUserSecrets(tx, rec.id, fields);
          if (table === 'Company') {
            const mc = fields.mailchimp_api_key;
            if (typeof mc === 'string' && mc.trim() !== '') await secrets.setMailchimpKey(tx, rec.id, mc.trim());
            delete fields.mailchimp_api_key;
          }
          for (const name of Object.keys(fields)) {
            if (isSecretField(name)) {
              delete fields[name];
              stripped.add(`${table}.${name}`);
            }
          }
          for (const f of attachmentFields) {
            const value = fields[f];
            if (Array.isArray(value)) fields[f] = await importAttachments(tx, table, rec.id, f, value);
          }
          await records.insert(tx, table, fields, { id: rec.id, createdTime: rec.createdTime });
        });
      }
      const imported = await records.count(table);
      report.tables[table] = { airtable: source.length, imported };
      if (imported !== source.length) report.countMismatches.push(table);
    }
    report.strippedSecretFields = [...stripped].sort();

    // 3. Settings: only ERP Hero's rows of the shared Master base, only non-secret keys.
    const keyRows = await o.reader.listRecords(o.masterBaseId, 'Keys', {
      filterByFormula: `{project_id}='${o.projectId.replace(/'/g, "\\'")}'`,
    });
    await db.write(async (tx) => {
      for (const row of keyRows) {
        if (row.fields.project_id !== o.projectId) continue;
        const name = row.fields.key_name;
        const value = row.fields.key_value;
        if (typeof name !== 'string') continue;
        if (isSettingKey(name) && typeof value === 'string' && value.trim() !== '') {
          await upsertSetting(tx, name, value.trim(), 'import', new Date(now()).toISOString());
          report.importedSettings.push(name);
        } else {
          report.skippedSettingKeys.push(name);
        }
      }
    });

    // 4. Verification
    const allIds = new Set<string>();
    const all = new Map<TableName, Awaited<ReturnType<RecordStore['list']>>>();
    for (const table of TABLE_NAMES) {
      const list = await records.list(table);
      all.set(table, list);
      for (const r of list) allIds.add(r.id);
    }
    for (const [table, list] of all) {
      for (const r of list) {
        for (const [field, value] of Object.entries(r.fields)) {
          const ids = (Array.isArray(value) ? value : [value]).filter(isRecordId);
          for (const id of ids) {
            if (allIds.has(id)) continue;
            const key = `${table}.${field}`;
            const entry = (report.danglingLinks[key] ??= { count: 0, sample: [] });
            entry.count++;
            if (entry.sample.length < 5) entry.sample.push(id);
          }
        }
      }
    }
    for (const spec of NUMBER_SPECS) {
      const groups = new Map<string, string[]>();
      for (const r of all.get(spec.table) ?? []) {
        const value = r.fields[spec.field];
        if (value === undefined) continue;
        const key = `${companyOf(r.fields) ?? '(ohne Firma)'}\u0000${String(value)}`;
        groups.set(key, [...(groups.get(key) ?? []), r.id]);
      }
      for (const [key, ids] of groups) {
        if (ids.length < 2) continue;
        const [companyId = '', number = ''] = key.split('\u0000');
        report.duplicateNumbers.push({ type: spec.type, companyId, number, recordIds: ids });
      }
    }
    const hashes = await secrets.apiKeyHashes();
    report.usersWithoutKey = (all.get('User') ?? []).filter((u) => !hashes.has(u.id)).map((u) => u.id);

    report.finishedAt = new Date(now()).toISOString();
    report.ok = report.countMismatches.length === 0 && report.attachments.failed.length === 0;
    await db.client.execute('PRAGMA wal_checkpoint(TRUNCATE)');
    return report;
  } finally {
    db.close();
    await writeFile(path.join(o.stagingDir, 'import-report.json'), JSON.stringify(report, null, 2));
  }
}
```


- [ ] **Step 5: Run the test to verify it passes**

Run:

```bash
npx vitest run test/importer.test.ts
```

Expected: 7 tests pass.


- [ ] **Step 6: Typecheck and lint**

Run:

```bash
npm run typecheck && npm run lint
```


- [ ] **Step 7: Commit**

```bash
git add server/import/report.ts server/import/importer.ts test/importer.test.ts
git commit -F - <<'EOF'
feat(server): add Airtable to SQLite importer with verification report

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FVrKcG5sQkpYKqUZGYjujR
EOF
```


---

### Task 18: Activation on restart, CLI commands, final entry point

**Files:**
- Create: server/activation.ts, server/cli/commands.ts, server/cli/user-create.ts, server/cli/db-activate.ts, server/cli/import-airtable.ts
- Modify: server/main.ts (full replacement below)
- Test: test/cli.test.ts

**Interfaces:**
- Consumes: `runImport`, `formatReport` (Task 17); `AirtableReader` (Task 16); `hashLoginKey` (Task 5); `RecordStore` (Task 4); `SecretStore` (Task 5); `loadConfig` (Task 1); `SessionStore.purgeExpired` (Task 6).
- Produces: `ACTIVATION_MARKER`, `scheduleActivation(dataDir, stagingDir)`, `applyPendingActivation(dataDir, logger, now?)`; `runUserCreateCli(argv, env, out)`, `runDbActivateCli(argv, env, out)`, `runImportCli(argv, env, fetchFn, out)`; npm scripts `user:create`, `db:activate`, `import:airtable` run the compiled `dist/server/cli/*.js`.

- [ ] **Step 1: Write the failing test**

Create `test/cli.test.ts`:

```ts
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACTIVATION_MARKER, applyPendingActivation, scheduleActivation } from '../server/activation.js';
import { verifyLoginKey } from '../server/auth/passwords.js';
import { runDbActivateCli, runImportCli, runUserCreateCli } from '../server/cli/commands.js';
import { RecordStore } from '../server/data/records.js';
import { openDatabase } from '../server/db/database.js';
import { SecretStore } from '../server/secrets/store.js';
import { testEnv } from './helpers/context.js';
import { FakeFetch, jsonResponse } from './helpers/fakeFetch.js';

let dataDir: string;
let out: string[];
const print = (line: string) => out.push(line);
const silent = { info: () => undefined, error: () => undefined };

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'erp-cli-'));
  out = [];
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('user:create', () => {
  it('creates an active admin with a hashed key and prints the key once', async () => {
    const code = await runUserCreateCli(['--name', 'Patrizio', '--admin', '--companies', 'recA,recB'], testEnv(dataDir), print);
    expect(code).toBe(0);
    const key = /Login-Key \(wird nur jetzt angezeigt\): ([a-z0-9]{24})/.exec(out.join('\n'))?.[1] ?? '';
    const db = await openDatabase(path.join(dataDir, 'erp.db'));
    const [user] = await new RecordStore(db).list('User');
    expect(user?.fields).toMatchObject({ name: 'Patrizio', status: 'aktiv', is_admin: true, allowed_companies: ['recA', 'recB'] });
    const hash = (await new SecretStore(db, Buffer.alloc(32, 7)).apiKeyHashes()).get(user?.id ?? '') ?? '';
    expect(await verifyLoginKey(key, hash)).toBe(true);
    db.close();
  });

  it('requires --name', async () => {
    expect(await runUserCreateCli([], testEnv(dataDir), print)).toBe(1);
    expect(out[0]).toContain('--name');
  });
});

describe('activation', () => {
  it('swaps in the staged database on the next start and keeps the old one as backup', async () => {
    await writeFile(path.join(dataDir, 'erp.db'), 'OLD');
    await mkdir(path.join(dataDir, 'files', 'attOLD'), { recursive: true });
    const staging = path.join(dataDir, 'import-1');
    await mkdir(path.join(staging, 'files', 'attNEW'), { recursive: true });
    await writeFile(path.join(staging, 'erp.db'), 'NEW');

    expect(await runDbActivateCli([staging], testEnv(dataDir), print)).toBe(0);
    expect(await readFile(path.join(dataDir, ACTIVATION_MARKER), 'utf8')).toBe(staging);

    const result = await applyPendingActivation(dataDir, silent, new Date('2026-03-01T12:00:00.000Z'));
    expect(result).toEqual({ activated: true, backupDir: path.join(dataDir, 'backup-2026-03-01T12-00-00-000Z') });
    expect(await readFile(path.join(dataDir, 'erp.db'), 'utf8')).toBe('NEW');
    expect(await readdir(path.join(dataDir, 'files'))).toEqual(['attNEW']);
    expect(await readFile(path.join(result.backupDir ?? '', 'erp.db'), 'utf8')).toBe('OLD');
    expect(await readdir(path.join(result.backupDir ?? '', 'files'))).toEqual(['attOLD']);
    expect((await readdir(dataDir)).includes(ACTIVATION_MARKER)).toBe(false);
  });

  it('does nothing without a marker and refuses staging dirs without a database', async () => {
    expect(await applyPendingActivation(dataDir, silent)).toEqual({ activated: false });
    await expect(scheduleActivation(dataDir, path.join(dataDir, 'nope'))).rejects.toThrow('No erp.db');
    await writeFile(path.join(dataDir, ACTIVATION_MARKER), path.join(dataDir, 'gone'));
    expect(await applyPendingActivation(dataDir, silent)).toEqual({ activated: false });
    expect(await runDbActivateCli([], testEnv(dataDir), print)).toBe(1);
  });
});

describe('import:airtable', () => {
  it('requires the Airtable variables', async () => {
    expect(await runImportCli([], testEnv(dataDir), new FakeFetch().fetch, print)).toBe(1);
    expect(out[0]).toBe('Fehler: fehlende Variablen: AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_MASTER_BASE_ID, ERP_PROJECT_ID');
  });

  it('runs the import into a staging dir and prints the report and next step', async () => {
    const fake = new FakeFetch()
      .on('GET', 'https://api.airtable.com/v0/meta/bases/appA/tables', () => jsonResponse({ tables: [] }))
      .on('GET', 'https://api.airtable.com/v0/appM/Keys', () => jsonResponse({ records: [] }));
    const env = testEnv(dataDir, {
      AIRTABLE_TOKEN: 'pat',
      AIRTABLE_BASE_ID: 'appA',
      AIRTABLE_MASTER_BASE_ID: 'appM',
      ERP_PROJECT_ID: 'p_1',
    });
    const staging = path.join(dataDir, 'import-x');
    const code = await runImportCli(['--staging', staging], env, fake.fetch, print);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain(`Aktivieren mit: npm run db:activate -- ${staging}`);
    expect(out.join('\n')).toContain('Import OK');
  });
});
```


- [ ] **Step 2: Run it to verify it fails**

Run:

```bash
npx vitest run test/cli.test.ts
```

Expected: FAIL — `server/activation.js` / `server/cli/commands.js` not found.


- [ ] **Step 3: Implement activation**

Activation never swaps files under an open database. `db:activate` only writes a marker; the swap happens at the next startup, before the database is opened. The previous database and files are moved (never deleted) to `backup-<timestamp>/`.

Create `server/activation.ts`:

```ts
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from './http/logger.js';

export const ACTIVATION_MARKER = 'activate-pending';
const DB_FILES = ['erp.db', 'erp.db-wal', 'erp.db-shm'];

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

/** Marks an import staging directory for activation on the next server start. */
export async function scheduleActivation(dataDir: string, stagingDir: string): Promise<string> {
  const staging = path.resolve(stagingDir);
  if (!(await exists(path.join(staging, 'erp.db')))) throw new Error(`No erp.db in ${staging}`);
  await writeFile(path.join(dataDir, ACTIVATION_MARKER), staging);
  return staging;
}

/**
 * Runs at startup BEFORE the database is opened: moves the current database and files
 * into backup-<timestamp>/ and the staged import into place. Never deletes anything.
 */
export async function applyPendingActivation(
  dataDir: string,
  logger: Logger,
  now: Date = new Date(),
): Promise<{ activated: boolean; backupDir?: string }> {
  const marker = path.join(dataDir, ACTIVATION_MARKER);
  const staging = (await readFile(marker, 'utf8').catch(() => '')).trim();
  if (!staging) return { activated: false };
  if (!(await exists(path.join(staging, 'erp.db')))) {
    logger.error({ message: 'activation skipped: staging database missing', staging });
    await rm(marker, { force: true });
    return { activated: false };
  }

  const backupDir = path.join(dataDir, `backup-${now.toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(backupDir, { recursive: true });
  for (const name of [...DB_FILES, 'files']) {
    if (await exists(path.join(dataDir, name))) await rename(path.join(dataDir, name), path.join(backupDir, name));
  }
  for (const name of [...DB_FILES, 'files']) {
    if (await exists(path.join(staging, name))) await rename(path.join(staging, name), path.join(dataDir, name));
  }
  await rm(marker, { force: true });
  logger.info({ message: 'activated imported database', staging, backupDir });
  return { activated: true, backupDir };
}
```


- [ ] **Step 4: Implement the CLI commands and their entry points**

Create `server/cli/commands.ts`:

```ts
import path from 'node:path';
import { parseArgs } from 'node:util';
import { scheduleActivation } from '../activation.js';
import { hashLoginKey } from '../auth/passwords.js';
import { loadConfig } from '../config.js';
import { RecordStore } from '../data/records.js';
import { openDatabase } from '../db/database.js';
import { runMigrations } from '../db/migrations.js';
import type { FetchFn } from '../deps.js';
import { AirtableReader } from '../import/airtable.js';
import { runImport } from '../import/importer.js';
import { formatReport } from '../import/report.js';
import { SecretStore } from '../secrets/store.js';
import { newLoginKey } from '../util/ids.js';

export type Output = (line: string) => void;

/** npm run user:create -- --name "Anna" [--admin] [--role Vertrieb] [--companies recA,recB] */
export async function runUserCreateCli(argv: string[], env: NodeJS.ProcessEnv, out: Output): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      name: { type: 'string' },
      role: { type: 'string' },
      admin: { type: 'boolean', default: false },
      companies: { type: 'string' },
    },
  });
  const name = values.name?.trim();
  if (!name) {
    out('Fehler: --name ist erforderlich');
    return 1;
  }
  const config = loadConfig(env, process.cwd());
  const db = await openDatabase(path.join(config.dataDir, 'erp.db'));
  try {
    await runMigrations(db);
    const records = new RecordStore(db);
    const secrets = new SecretStore(db, config.secretsKey);
    const key = newLoginKey();
    const hash = await hashLoginKey(key);
    const fields: Record<string, unknown> = { name, status: 'aktiv', created: new Date().toISOString().slice(0, 10) };
    if (values.role) fields.role = values.role;
    if (values.admin) fields.is_admin = true;
    const companies = (values.companies ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (companies.length > 0) fields.allowed_companies = companies;
    const user = await db.write(async (tx) => {
      const record = await records.insert(tx, 'User', fields);
      await secrets.setApiKeyHash(tx, record.id, hash);
      return record;
    });
    out(`Benutzer angelegt: ${name} (${user.id})${values.admin ? ' [Admin]' : ''}`);
    out(`Login-Key (wird nur jetzt angezeigt): ${key}`);
    return 0;
  } finally {
    db.close();
  }
}

/** npm run db:activate -- <staging-dir> ; takes effect on the next restart. */
export async function runDbActivateCli(argv: string[], env: NodeJS.ProcessEnv, out: Output): Promise<number> {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true });
  const stagingDir = positionals[0];
  if (!stagingDir) {
    out('Fehler: Pfad zum Import-Verzeichnis fehlt (npm run db:activate -- /data/import-...)');
    return 1;
  }
  const config = loadConfig(env, process.cwd());
  const staging = await scheduleActivation(config.dataDir, stagingDir);
  out(`Aktivierung vorgemerkt: ${staging}`);
  out('Jetzt den Service im Railway-Dashboard neu starten (Restart). Die bisherige Datenbank wird dabei in backup-<Zeitstempel>/ verschoben.');
  return 0;
}

/** npm run import:airtable [-- --staging /data/import-2026-...] */
export async function runImportCli(argv: string[], env: NodeJS.ProcessEnv, fetchFn: FetchFn, out: Output): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { staging: { type: 'string' } } });
  const missing = ['AIRTABLE_TOKEN', 'AIRTABLE_BASE_ID', 'AIRTABLE_MASTER_BASE_ID', 'ERP_PROJECT_ID'].filter((k) => !env[k]?.trim());
  if (missing.length > 0) {
    out(`Fehler: fehlende Variablen: ${missing.join(', ')}`);
    return 1;
  }
  const config = loadConfig(env, process.cwd());
  const stagingDir = values.staging ?? path.join(config.dataDir, `import-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const report = await runImport({
    reader: new AirtableReader({ token: String(env.AIRTABLE_TOKEN).trim(), fetch: fetchFn }),
    appBaseId: String(env.AIRTABLE_BASE_ID).trim(),
    masterBaseId: String(env.AIRTABLE_MASTER_BASE_ID).trim(),
    projectId: String(env.ERP_PROJECT_ID).trim(),
    stagingDir,
    secretsKey: config.secretsKey,
    log: out,
  });
  out(formatReport(report));
  out('');
  out(`Datenbank und Bericht: ${stagingDir}`);
  out(`Aktivieren mit: npm run db:activate -- ${stagingDir}`);
  return report.ok ? 0 : 1;
}
```

Create `server/cli/user-create.ts`:

```ts
import { runUserCreateCli } from './commands.js';

process.exitCode = await runUserCreateCli(process.argv.slice(2), process.env, (line) => console.log(line));
```

Create `server/cli/db-activate.ts`:

```ts
import { runDbActivateCli } from './commands.js';

process.exitCode = await runDbActivateCli(process.argv.slice(2), process.env, (line) => console.log(line));
```

Create `server/cli/import-airtable.ts`:

```ts
import { runImportCli } from './commands.js';

process.exitCode = await runImportCli(process.argv.slice(2), process.env, globalThis.fetch, (line) => console.log(line));
```


- [ ] **Step 5: Apply pending activations and purge sessions at startup: replace `server/main.ts`**

Replace the whole content of `server/main.ts` with:

```ts
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { applyPendingActivation } from './activation.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { runMigrations } from './db/migrations.js';
import { buildDeps } from './deps.js';
import { jsonLogger } from './http/logger.js';

async function main(): Promise<void> {
  // Railway (and local dev) start the server from the repository root.
  const config = loadConfig(process.env, process.cwd());
  await mkdir(config.dataDir, { recursive: true });
  await applyPendingActivation(config.dataDir, jsonLogger);
  const db = await openDatabase(path.join(config.dataDir, 'erp.db'));
  await runMigrations(db);
  const deps = buildDeps({ config, db });
  await deps.sessions.purgeExpired();
  setInterval(() => void deps.sessions.purgeExpired().catch(() => undefined), 60 * 60 * 1000).unref();
  const app = createApp(deps);

  const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) =>
    jsonLogger.info({ message: 'listening', port: info.port }),
  );
  const shutdown = () => {
    server.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  jsonLogger.error({ message: 'startup failed', error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
```


- [ ] **Step 6: Run the test to verify it passes**

Run:

```bash
npx vitest run test/cli.test.ts
```

Expected: 6 tests pass.


- [ ] **Step 7: Run the whole suite, typecheck and lint**

Run:

```bash
npm test && npm run typecheck && npm run lint
```


- [ ] **Step 8: Check the built CLI end to end**

Run:

```bash
npm run build && mkdir -p .data && PUBLIC_ORIGIN=http://localhost:3999 DATA_DIR=./.data SECRETS_KEY=$(node -e "console.log(Buffer.alloc(32,3).toString('base64'))") npm run -s user:create -- --name "Admin Test" --admin
```

Expected: `Benutzer angelegt: Admin Test (rec…) [Admin]` and a 24-character login key. Then delete the local test data with `rm -rf .data`.


- [ ] **Step 9: Commit**

```bash
git add server/activation.ts server/cli server/main.ts test/cli.test.ts
git commit -F - <<'EOF'
feat(server): add import activation on restart and user/import CLI commands

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FVrKcG5sQkpYKqUZGYjujR
EOF
```


---

### Task 19: Railway configuration, .env.example, DEPLOY.md and final verification

**Files:**
- Create: railway.json, .env.example, DEPLOY.md

**Interfaces:**
- Consumes: everything above.
- Produces: deployable repository: `railway.json` (Railpack build, `npm start`, healthcheck `/healthz`, restart on failure), `.env.example` listing every variable with placeholders, `DEPLOY.md` with the dashboard steps and the cutover checklist.

- [ ] **Step 1: Add the Railway config-as-code**

Keys per Railway's current config-as-code reference (`$schema`, `build.builder: RAILPACK`, `deploy.healthcheckPath`, `restartPolicyType`). Healthchecks only run at deploy time; 120 s covers the volume re-mount and a pending DB activation.

Create `railway.json`:

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": {
    "builder": "RAILPACK",
    "buildCommand": "npm run build"
  },
  "deploy": {
    "startCommand": "npm start",
    "healthcheckPath": "/healthz",
    "healthcheckTimeout": 120,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
```


- [ ] **Step 2: Add `.env.example` (placeholders only, no real values)**

Create `.env.example`:

```
# ERP Hero backend — copy to .env for local development. Never commit .env.
# On Railway, set these as service variables instead (see DEPLOY.md).

# development | production | test  (Railway: production)
NODE_ENV=development
# Railway injects PORT automatically; 3000 is the local default.
PORT=3000
# The public URL of the app, without a trailing slash. Used to reject cross-site requests.
PUBLIC_ORIGIN=http://localhost:3000
# Where the SQLite database and uploaded files live. Railway: the volume mount path (/data).
DATA_DIR=./.data
# 32 random bytes, base64. Encrypts stored Freshdesk/Mailchimp keys. Generate with:
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# Keep a copy in a password manager: without it, stored third-party keys cannot be decrypted.
SECRETS_KEY=REPLACE_WITH_32_RANDOM_BYTES_BASE64

# --- Third-party services ---
ANTHROPIC_API_KEY=sk-ant-REPLACE_ME
# Freshdesk subdomain only, e.g. "flpliftparts" for flpliftparts.freshdesk.com
FRESHDESK_DOMAIN=REPLACE_ME
# Optional fallback key, used only when a user has no personal Freshdesk key.
FRESHDESK_API_KEY=
# Freshsales subdomain only, e.g. "gilt" for gilt.freshworks.com
FRESHSALES_SUBDOMAIN=REPLACE_ME
FRESHSALES_API_KEY=REPLACE_ME

# Optional: override the attachment-proxy allowlist (comma-separated "host" or "host/pathprefix").
# Default: <FRESHDESK_DOMAIN>.freshdesk.com, <FRESHDESK_DOMAIN>.attachments.freshdesk.com,
#          attachment.freshdesk.com, attachment.freshdeskusercontent.com,
#          s3.amazonaws.com/cdn.freshdesk.com/, s3.eu-central-1.amazonaws.com/euc-cdn.freshdesk.com/
ATTACHMENT_PROXY_ALLOW=

# info | debug
LOG_LEVEL=info

# --- Only on import day (npm run import:airtable). Remove afterwards. ---
# A NEW read-only Airtable token (scopes data.records:read + schema.bases:read on both bases).
# Never the token embedded in index.html.
AIRTABLE_TOKEN=
AIRTABLE_BASE_ID=
AIRTABLE_MASTER_BASE_ID=
ERP_PROJECT_ID=
```


- [ ] **Step 3: Add `DEPLOY.md`**

Create `DEPLOY.md`:

````markdown
# Deploying the ERP Hero backend on Railway

This backend serves `index.html` and `/api/*` from one origin and stores all data in a SQLite
file on a Railway volume. For the design, see `docs/superpowers/specs/2026-09-25-erp-hero-backend-design.md`.

> Until the frontend switch (next development step) is merged, the old GitHub Pages app stays
> the one your team uses. The page served by this backend loads, but cannot work yet: its old
> Airtable/Val.town calls are blocked on purpose by the new security policy.

## 1. Create the project from GitHub

1. In the Railway dashboard, click **New Project → Deploy from GitHub repo**.
2. Pick `giltglobalinvest-pixel/erp_hero`. Railway creates a service and starts a first deploy.
   That first deploy will fail its healthcheck until the variables in step 4 are set. That's expected.
3. Open the service → **Settings → Source** and set the **branch** to the branch with the
   backend: `claude/confident-pascal-b6b330` until it is merged, then `main`.
   `railway.json` in the repo sets the build, start command, healthcheck (`/healthz`) and restart policy.
4. **Settings → Deploy → Regions:** choose **EU West (Amsterdam)**.

> **When the repository becomes private:** Railway's GitHub app must be allowed to read it.
> In GitHub, open **Settings → Applications → Installed GitHub Apps → Railway → Configure** (for
> the organization or account that owns the repo). Under **Repository access**, add `erp_hero`,
> or allow all repositories. Otherwise deploys stop with a "repository not found / no access" error.

## 2. Add the volume

1. Press `⌘K` (or right-click the project canvas) → **Create Volume** → select the ERP Hero service.
2. Set the **mount path** to `/data`.
3. Railway redeploys the service with the volume attached. A service with a volume runs as a
   single instance and has a few seconds of downtime on each redeploy. That's fine for this app.

## 3. Turn on backups

Open the service → **Backups** tab and enable the **Daily**, **Weekly** and **Monthly** schedules.
They are kept for 6, 27 and 89 days respectively.

For long-term retention, an admin can also download a full backup at any time
(database + files, `.tar.gz`) from `GET /api/admin/backup` while logged in. Store those somewhere you control.

## 4. Set the variables

Open the service → **Variables** → **Raw Editor** and paste the list below, filling in real values.
`.env.example` in the repo explains every variable.

```
NODE_ENV=production
PUBLIC_ORIGIN=https://<your-domain>          # set after step 5, then redeploy
DATA_DIR=/data
SECRETS_KEY=<32 random bytes, base64>
ANTHROPIC_API_KEY=<key>
FRESHDESK_DOMAIN=<subdomain, e.g. flpliftparts>
FRESHDESK_API_KEY=<optional fallback key>
FRESHSALES_SUBDOMAIN=<subdomain, e.g. gilt>
FRESHSALES_API_KEY=<key>
```

- Generate `SECRETS_KEY` once with
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
  and **store a copy in your password manager**. Without it, the stored Freshdesk/Mailchimp keys
  cannot be decrypted (they would have to be re-entered; login keys are not affected).
- Do not set `PORT`; Railway injects it.
- Never paste the Airtable token that is embedded in `index.html`. The backend does not need
  Airtable at all, except on import day (section 8).

## 5. Generate a domain

Open the service → **Settings → Networking → Generate Domain**. Copy the URL (for example
`https://erp-hero-production.up.railway.app`), set `PUBLIC_ORIGIN` to exactly that value (no
trailing slash), and redeploy. `PUBLIC_ORIGIN` must match the address in the browser, otherwise
every login and save is rejected as a cross-site request.

## 6. Check the deployment

- `https://<domain>/healthz` → `{"ok":true}`
- `https://<domain>/` → the ERP Hero page. Until the frontend switch, the login cannot work yet.
- The deploy logs show one JSON line per request, never bodies, cookies or keys.

## 7. Create the first admin (before the import)

1. Install the Railway CLI, then run `railway login` and `railway link` (select the project and service).
2. Run `railway ssh`, then inside the container:

   ```
   npm run user:create -- --name "Patrizio" --admin
   ```

3. The command prints the new login key once. Store it safely.

Use this admin to smoke-test the deployment. The import in step 8 replaces all users with the users from Airtable.

## 8. Smoke test with real services (needs a logged-in session)

After the frontend switch, or with a REST client and the session cookie:

- **Freshdesk:** open a ticket in the app. Check that `GET /api/freshdesk/api/v2/tickets/<id>` works.
- **Attachment proxy:** open a ticket with an image attachment and use an AI summary that needs
  the image. If the server answers `403 Domain nicht erlaubt: <host>`, add that host to
  `ATTACHMENT_PROXY_ALLOW` (for example `ATTACHMENT_PROXY_ALLOW=<host>,…plus the defaults`) and
  tell the developer, so the default list gets updated.
- **Anthropic, Freshsales, Mailchimp:** use one feature each ("KI-Angebot", Freshsales sync,
  Mailchimp "Verbindung testen").

## 9. Cutover from Airtable (after the frontend switch is merged)

1. Tell everyone to stop using the old app, and wait until nobody is editing anymore.
2. In Airtable, create a **new read-only token** with scopes `data.records:read` and
   `schema.bases:read` on the App base and the Master base.
3. Set the import variables on the service (`AIRTABLE_TOKEN`, `AIRTABLE_BASE_ID`,
   `AIRTABLE_MASTER_BASE_ID`, `ERP_PROJECT_ID=p_1778057282571`). This redeploys.
4. Run `railway ssh`, then:

   ```
   npm run import:airtable
   ```

   The import reads everything from Airtable (GET only) into a new folder `/data/import-<timestamp>/`,
   downloads all attachments, and prints a report. It is also saved as `import-report.json`.
   Read the report:
   - record counts must match;
   - failed attachments must be zero;
   - review duplicate document numbers, links to missing records, and calculated Airtable fields
     (copied as fixed values).
5. Activate the import. The old database is kept in `/data/backup-<timestamp>/`.

   ```
   npm run db:activate -- /data/import-<timestamp>
   ```

   Then **Restart** the service in the dashboard.
6. Everyone logs in at the new address with their existing login key.
7. Remove the four import variables again, and delete the read-only Airtable token.
8. **Rotate every key the old setup exposed.** The old `index.html` is public, including in the git history:
   - revoke the Airtable token embedded in `index.html` and the old Airtable write key;
   - create a new Anthropic key (update `ANTHROPIC_API_KEY`);
   - have each user regenerate their Freshdesk API key, then enter it again under Admin → Benutzer;
   - rotate Mailchimp keys;
   - revoke the Val.town API token and delete the Val.town proxy (`erpHeroProxy`).
9. Keep the Airtable bases untouched as an archive.

## Local development

```
cp .env.example .env        # fill in SECRETS_KEY; the other keys are optional locally
npm install
npm run dev                 # http://localhost:3000 (tsx watch)
npm test                    # all upstream HTTP is faked; no network access needed
npm run typecheck && npm run lint
npm run build && npm start  # production build
```

Load `.env` into your shell before `npm run dev` (for example `set -a; . ./.env; set +a`).
The server does not read `.env` by itself.
````


- [ ] **Step 4: Verify no secrets are tracked**

Run:

```bash
git ls-files | grep -E '(^|/)\.env$' ; git grep -nE 'pat[A-Za-z0-9]{14}\.[0-9a-f]{20}|sk-ant-api[0-9]{2}-' -- ':!index.html' ; echo done
```

Expected: only `done`. No `.env` is tracked, and no real key appears outside the untouched `index.html`.


- [ ] **Step 5: Run the full verification**

Run:

```bash
npm test && npm run typecheck && npm run lint && npm run build
```

Expected: all test files pass (157 tests), typecheck and lint are clean, and the build writes `dist/`.


- [ ] **Step 6: Start the built server and exercise it with curl**

Run:

```bash
rm -rf .data && mkdir -p .data
export PUBLIC_ORIGIN=http://127.0.0.1:3999 DATA_DIR=./.data SECRETS_KEY=$(node -e "console.log(Buffer.alloc(32,3).toString('base64'))")
KEY=$(npm run -s user:create -- --name "Smoke Admin" --admin | grep -oE '[a-z0-9]{24}$')
(PORT=3999 node dist/server/main.js & echo $! > .server.pid); sleep 2
curl -s -o /dev/null -w "index %{http_code} %{size_download}\n" http://127.0.0.1:3999/
curl -s http://127.0.0.1:3999/healthz; echo
curl -s -c .cj -H "origin: http://127.0.0.1:3999" -H "content-type: application/json" -d "{\"user_key\":\"$KEY\"}" http://127.0.0.1:3999/api/auth; echo
curl -s -b .cj -H "origin: http://127.0.0.1:3999" -H "content-type: application/json" -d '{"fields":{"company_id":"recC1"},"assignNumber":true}' http://127.0.0.1:3999/api/data/Invoice; echo
kill $(cat .server.pid); rm -rf .server.pid .cj .data
```

Expected: `index 200 1855857`, `{"ok":true}`, a login response with `"is_admin":true`, and an Invoice with `"invoice_no":"R-1001"`.


- [ ] **Step 7: Check the served page against the CSP in headless Chromium (optional, needs Playwright)**

Load `http://127.0.0.1:3999/` in Chromium with the server running (same env as above) and read the console. Expected: Tailwind and lucide load with **no** CSP violations. The only blocked requests are the old `api.airtable.com` calls, blocked on purpose until the frontend switch. This was verified while writing this plan.


- [ ] **Step 8: Commit and push**

```bash
git add railway.json .env.example DEPLOY.md
git commit -F - <<'EOF'
docs(server): add Railway config, env template and deployment guide

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FVrKcG5sQkpYKqUZGYjujR
EOF
```

Run:

```bash
git push -u origin claude/confident-pascal-b6b330
```

Expected: the branch updates on GitHub. Do not open a PR without asking.


---

## After Task 19

Report to the user with:
- the verification output (test count, typecheck, lint, local start);
- the endpoint list mapped to the frontend functions each replaces (spec §7.1 and §21);
- the open items that need their input (spec §20: attachment-host check at first deploy, computed Airtable fields from the import report).

Then ask before opening a PR.
