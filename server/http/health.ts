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
