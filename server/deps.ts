import { LoginRateLimiter } from './auth/rateLimit.js';
import { SessionStore } from './auth/sessions.js';
import type { Config } from './config.js';
import { FileStore } from './data/files.js';
import { LockService } from './data/locks.js';
import { NumberService } from './data/numbers.js';
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
  numbers: NumberService;
  locks: LockService;
  files: FileStore;
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
  const logger = o.logger ?? jsonLogger;
  const records = new RecordStore(o.db, now);
  return {
    config: o.config,
    db: o.db,
    // Resolve globalThis.fetch lazily so tests can replace it.
    fetch: o.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    logger,
    now,
    timeouts: { upstreamMs: 60_000, anthropicMs: 300_000, ...o.timeouts },
    records,
    sessions: new SessionStore(o.db, now),
    secrets: new SecretStore(o.db, o.config.secretsKey, (ref) =>
      logger.error({ message: 'stored secret cannot be decrypted (SECRETS_KEY changed?); treated as not set', secret: ref }),
    ),
    limiter: new LoginRateLimiter({}, now),
    numbers: new NumberService(),
    locks: new LockService(o.db, records, now),
    files: new FileStore(o.db, o.config.dataDir, now),
  };
}
