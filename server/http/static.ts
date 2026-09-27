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
