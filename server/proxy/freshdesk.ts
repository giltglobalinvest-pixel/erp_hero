import { Hono } from 'hono';
import type { AppDeps } from '../deps.js';
import { limit, MB } from '../http/body.js';
import type { AppEnv } from '../types.js';
import { ApiError } from '../util/errors.js';
import { compileRules, type Rule } from './allowlist.js';
import { forward } from './passthrough.js';

/** Every Freshdesk call index.html makes, and nothing else. */
export const FRESHDESK_RULES: readonly Rule[] = [
  ['GET', 'tickets/{id}'],
  ['PUT', 'tickets/{id}'],
  ['POST', 'tickets'],
  ['POST', 'tickets/outbound_email'],
  ['GET', 'tickets/{id}/conversations'],
  ['POST', 'tickets/{id}/notes'],
  ['POST', 'tickets/{id}/forward'],
  ['GET', 'search/tickets'],
  ['GET', 'agents'],
  ['GET', 'contacts'],
  ['POST', 'contacts'],
  ['GET', 'contacts/{id}'],
  ['PUT', 'contacts/{id}'],
  ['GET', 'contacts/{id}/tickets'],
  ['GET', 'companies/{id}'],
  ['PUT', 'companies/{id}'],
  ['POST', 'companies'],
  ['GET', 'companies/autocomplete'],
  ['GET', 'search/companies'],
  ['GET', 'canned_response_folders'],
  ['GET', 'canned_response_folders/{id}/responses'],
  ['GET', 'conversations/{id}'],
  ['PUT', 'conversations/{id}'],
  ['DELETE', 'conversations/{id}'],
  ['GET', 'groups'],
  ['GET', 'email_configs'],
  ['GET', 'ticket_fields'],
];

const MAX_JSON_BYTES = 5 * MB;
const MAX_MULTIPART_BYTES = 25 * MB;

export function freshdeskRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const allowed = compileRules(FRESHDESK_RULES);

  app.all('/freshdesk/api/v2/*', limit(MAX_MULTIPART_BYTES), async (c) => {
    const method = c.req.method;
    const subPath = c.req.path.replace(/^.*?\/freshdesk\/api\/v2\//, '');
    if (!allowed(method, subPath)) throw new ApiError('FORBIDDEN', 'Endpoint nicht freigegeben');

    const domain = deps.config.freshdeskDomain;
    if (!domain) throw new ApiError('NOT_CONFIGURED', 'FRESHDESK_DOMAIN fehlt in der Server-Konfiguration');

    // Key order: user × current company (only an allowed company) → user default → FRESHDESK_API_KEY.
    const user = c.get('user');
    const companyId = c.req.header('x-company-id')?.trim() || null;
    const companyAllowed = companyId !== null && (user.isAdmin || user.allowedCompanies.includes(companyId));
    const apiKey = (await deps.secrets.freshdeskKeyFor(user.id, companyAllowed ? companyId : null)) ?? deps.config.freshdeskApiKey;
    if (!apiKey) {
      throw new ApiError(
        'NOT_CONFIGURED',
        'Kein Freshdesk-Key verfügbar: beim Benutzer hinterlegen (Admin → Benutzer) oder FRESHDESK_API_KEY setzen',
      );
    }

    const headers: Record<string, string> = {
      authorization: `Basic ${Buffer.from(`${apiKey}:X`).toString('base64')}`,
      accept: 'application/json',
    };
    let body: BodyInit | undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      const contentType = c.req.header('content-type') ?? 'application/json';
      headers['content-type'] = contentType;
      if (contentType.toLowerCase().startsWith('multipart/')) {
        body = await c.req.arrayBuffer(); // keeps the boundary intact
      } else {
        const text = await c.req.text();
        if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw new ApiError('PAYLOAD_TOO_LARGE', 'Anfrage zu groß');
        body = text;
      }
    }

    const search = new URL(c.req.url).search;
    return forward(deps.fetch, {
      url: `https://${domain}.freshdesk.com/api/v2/${subPath}${search}`,
      method,
      headers,
      body,
      timeoutMs: deps.timeouts.upstreamMs,
      label: 'Freshdesk',
    });
  });

  return app;
}
