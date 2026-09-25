import { Hono } from 'hono';
import { originCheck, requireAuth } from './auth/middleware.js';
import { publicAuthRoutes, sessionRoutes } from './auth/routes.js';
import { dataRoutes } from './data/routes.js';
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
  api.route('/', dataRoutes(deps));
  app.route('/api', api);
  return app;
}
