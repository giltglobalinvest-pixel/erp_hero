import type { FetchFn } from '../deps.js';
import { ApiError } from '../util/errors.js';

export interface UpstreamRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: BodyInit;
  timeoutMs: number;
  /** Human-readable service name for error messages, e.g. "Freshdesk". */
  label: string;
}

const NO_BODY_STATUSES = new Set([204, 205, 304]);

/** Returns the upstream status and body unchanged (the frontend parses raw upstream errors). */
export function passthroughResponse(upstream: Response): Response {
  const headers = new Headers();
  const noBody = NO_BODY_STATUSES.has(upstream.status);
  const contentType = upstream.headers.get('content-type');
  if (contentType && !noBody) headers.set('content-type', contentType);
  const retryAfter = upstream.headers.get('retry-after');
  if (retryAfter) headers.set('retry-after', retryAfter);
  return new Response(noBody ? null : upstream.body, { status: upstream.status, headers });
}

export async function forward(fetchFn: FetchFn, req: UpstreamRequest): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetchFn(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(req.timeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new ApiError('UPSTREAM_TIMEOUT', `${req.label} antwortet nicht (Zeitüberschreitung)`);
    }
    throw new ApiError('UPSTREAM_UNAVAILABLE', `${req.label} nicht erreichbar`);
  }
  return passthroughResponse(upstream);
}
