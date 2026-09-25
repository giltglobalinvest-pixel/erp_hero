import { Hono } from 'hono';
import type { AllowEntry } from '../config.js';
import type { AppDeps } from '../deps.js';
import { MB } from '../http/body.js';
import type { AppEnv } from '../types.js';
import { ApiError } from '../util/errors.js';

export const MAX_ATTACHMENT_BYTES = 5 * MB;
const MAX_REDIRECTS = 3;

/** Exact host plus path prefix; https only; no credentials or custom ports. */
export function isAllowedAttachmentUrl(url: URL, allow: AllowEntry[]): boolean {
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return allow.some((entry) => entry.host === host && url.pathname.startsWith(entry.pathPrefix));
}

/** Timeouts become 504, other network failures 502 (spec §13), without internal detail. */
function upstreamFailure(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  const name = err instanceof Error ? err.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new ApiError('UPSTREAM_TIMEOUT', 'Anhang-Server antwortet nicht (Zeitüberschreitung)');
  }
  return new ApiError('UPSTREAM_UNAVAILABLE', 'Anhang konnte nicht geladen werden');
}

async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new ApiError('PAYLOAD_TOO_LARGE', 'Anhang zu groß (max 5 MB)');
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ApiError('PAYLOAD_TOO_LARGE', 'Anhang zu groß (max 5 MB)');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function attachmentProxyRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/attachment-proxy', async (c) => {
    const raw = c.req.query('url');
    if (!raw) throw new ApiError('INVALID_REQUEST', 'url fehlt');
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ApiError('INVALID_REQUEST', 'Ungültige URL');
    }

    let upstream: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isAllowedAttachmentUrl(url, deps.config.attachmentAllow)) {
        throw new ApiError('FORBIDDEN', `Domain nicht erlaubt: ${url.hostname}`);
      }
      let res: Response;
      try {
        res = await deps.fetch(url.toString(), {
          redirect: 'manual',
          signal: AbortSignal.timeout(deps.timeouts.upstreamMs),
        });
      } catch (err) {
        throw upstreamFailure(err);
      }
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        url = new URL(location, url);
        continue;
      }
      upstream = res;
      break;
    }
    if (!upstream) throw new ApiError('UPSTREAM_ERROR', 'Zu viele Weiterleitungen');
    if (!upstream.ok) {
      const status = upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502;
      throw new ApiError('UPSTREAM_ERROR', `Upstream ${upstream.status}`, status);
    }
    const data = await readCapped(upstream, MAX_ATTACHMENT_BYTES).catch((err: unknown) => {
      throw upstreamFailure(err);
    });
    return new Response(new Uint8Array(data), {
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        'cache-control': 'private, max-age=300',
      },
    });
  });

  return app;
}
