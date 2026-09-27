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
