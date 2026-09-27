import { Hono } from 'hono';
import type { AppDeps } from '../deps.js';
import type { AppEnv } from '../types.js';
import { ApiError } from '../util/errors.js';
import { compileRules, type Rule } from './allowlist.js';
import { forward } from './passthrough.js';

export const MAILCHIMP_RULES: readonly Rule[] = [
  ['GET', 'ping'],
  ['GET', 'lists'],
];

const SERVER_PREFIX = /^[a-z]{2,3}\d{1,2}$/;

export function mailchimpRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const allowed = compileRules(MAILCHIMP_RULES);

  app.all('/mailchimp/3.0/*', async (c) => {
    const method = c.req.method;
    const subPath = c.req.path.replace(/^.*?\/mailchimp\/3\.0\//, '');
    if (!allowed(method, subPath)) throw new ApiError('FORBIDDEN', 'Endpoint nicht freigegeben');

    const companyId = c.req.header('x-company-id')?.trim();
    if (!companyId) throw new ApiError('INVALID_REQUEST', 'X-Company-Id fehlt');
    const company = await deps.records.get('Company', companyId);
    if (!company) throw new ApiError('NOT_FOUND', 'Firma nicht gefunden');

    // Admins may test values typed into the settings form before saving them.
    const overrideKey = c.req.header('x-mailchimp-key')?.trim();
    const overrideServer = c.req.header('x-mailchimp-server')?.trim().toLowerCase();
    if ((overrideKey || overrideServer) && !c.get('user').isAdmin) throw new ApiError('FORBIDDEN', 'Nur für Admins');

    const apiKey = overrideKey || (await deps.secrets.mailchimpKey(companyId));
    if (!apiKey) throw new ApiError('INVALID_REQUEST', 'Mailchimp ist für diesen Mandanten nicht konfiguriert');
    const storedPrefix = typeof company.fields.mailchimp_server_prefix === 'string' ? company.fields.mailchimp_server_prefix : '';
    const server = (overrideServer || storedPrefix || /-([a-z]{2,3}\d{1,2})$/i.exec(apiKey)?.[1] || '').toLowerCase();
    if (!SERVER_PREFIX.test(server)) throw new ApiError('INVALID_REQUEST', `Ungültiger Mailchimp-Server-Prefix: ${server}`);

    return forward(deps.fetch, {
      url: `https://${server}.api.mailchimp.com/3.0/${subPath}${new URL(c.req.url).search}`,
      method,
      headers: {
        authorization: `Basic ${Buffer.from(`anystring:${apiKey}`).toString('base64')}`,
        accept: 'application/json',
      },
      timeoutMs: deps.timeouts.upstreamMs,
      label: 'Mailchimp',
    });
  });

  return app;
}
