import { Hono } from 'hono';
import type { AppDeps } from '../deps.js';
import { limit, MB } from '../http/body.js';
import type { AppEnv } from '../types.js';
import { ApiError } from '../util/errors.js';
import { forward } from './passthrough.js';

export function anthropicRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // 32 MB is Anthropic's own request limit (base64 images and PDFs are large).
  app.all('/anthropic/v1/messages', limit(32 * MB), async (c) => {
    if (c.req.method !== 'POST') throw new ApiError('METHOD_NOT_ALLOWED', 'Nur POST erlaubt');
    const apiKey = deps.config.anthropicApiKey;
    if (!apiKey) throw new ApiError('NOT_CONFIGURED', 'ANTHROPIC_API_KEY fehlt in der Server-Konfiguration');
    return forward(deps.fetch, {
      url: 'https://api.anthropic.com/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: await c.req.text(),
      timeoutMs: deps.timeouts.anthropicMs,
      label: 'Anthropic',
    });
  });

  return app;
}
