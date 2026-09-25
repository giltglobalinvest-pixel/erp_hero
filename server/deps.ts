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
