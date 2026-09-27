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
