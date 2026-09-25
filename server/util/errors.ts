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
