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
