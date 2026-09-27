import type { MiddlewareHandler } from 'hono';
import type { AllowEntry } from '../config.js';

export function buildCsp(attachmentAllow: AllowEntry[]): string {
  const hosts = [...new Set(attachmentAllow.map((e) => `https://${e.host}`))].join(' ');
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://unpkg.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    `connect-src 'self' ${hosts}`.trim(),
    `frame-src 'self' blob: ${hosts}`.trim(),
    "worker-src 'self'",
    "manifest-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function securityHeaders(opts: { isProduction: boolean; attachmentAllow: AllowEntry[] }): MiddlewareHandler {
  const csp = buildCsp(opts.attachmentAllow);
  return async (c, next) => {
    await next();
    const h = c.res.headers;
    h.set('content-security-policy', csp);
    h.set('x-content-type-options', 'nosniff');
    h.set('x-frame-options', 'DENY');
    h.set('referrer-policy', 'strict-origin-when-cross-origin');
    h.set('permissions-policy', 'microphone=(self), camera=(), geolocation=(), payment=()');
    h.set('cross-origin-opener-policy', 'same-origin');
    if (opts.isProduction) h.set('strict-transport-security', 'max-age=31536000');
  };
}
