import { Hono } from 'hono';
import type { AppDeps } from '../deps.js';
import { limit, MB } from '../http/body.js';
import type { AppEnv } from '../types.js';
import { ApiError } from '../util/errors.js';
import { compileRules, type Rule } from './allowlist.js';
import { forward } from './passthrough.js';

export const FRESHSALES_RULES: readonly Rule[] = [
  ['GET', 'sales_accounts/{id}'],
  ['PUT', 'sales_accounts/{id}'],
  ['POST', 'sales_accounts'],
  ['POST', 'sales_accounts/{id}/contacts'],
  ['GET', 'contacts/{id}'],
  ['PUT', 'contacts/{id}'],
  ['POST', 'contacts'],
  ['POST', 'contacts/{id}/sales_accounts'],
  ['GET', 'lookup'],
  ['GET', 'search'],
  ['POST', 'notes'],
];

export function freshsalesRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const allowed = compileRules(FRESHSALES_RULES);

  app.all('/freshsales/api/*', limit(1 * MB), async (c) => {
    const method = c.req.method;
    const subPath = c.req.path.replace(/^.*?\/freshsales\/api\//, '');
    if (!allowed(method, subPath)) throw new ApiError('FORBIDDEN', 'Endpoint nicht freigegeben');
    const subdomain = deps.config.freshsalesSubdomain;
    if (!subdomain) throw new ApiError('NOT_CONFIGURED', 'FRESHSALES_SUBDOMAIN fehlt in der Server-Konfiguration');
    const apiKey = deps.config.freshsalesApiKey;
    if (!apiKey) throw new ApiError('NOT_CONFIGURED', 'FRESHSALES_API_KEY fehlt in der Server-Konfiguration');

    const hasBody = method !== 'GET' && method !== 'HEAD';
    return forward(deps.fetch, {
      url: `https://${subdomain}.freshworks.com/crm/sales/api/${subPath}${new URL(c.req.url).search}`,
      method,
      headers: {
        authorization: `Token token=${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: hasBody ? await c.req.text() : undefined,
      timeoutMs: deps.timeouts.upstreamMs,
      label: 'Freshsales',
    });
  });

  return app;
}
