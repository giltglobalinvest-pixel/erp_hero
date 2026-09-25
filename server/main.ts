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
