import { z } from 'zod';

export interface AllowEntry {
  host: string;
  pathPrefix: string;
}

export interface Config {
  nodeEnv: 'development' | 'production' | 'test';
  isProduction: boolean;
  port: number;
  publicOrigin: string;
  dataDir: string;
  rootDir: string;
  secretsKey: Buffer;
  anthropicApiKey: string | undefined;
  freshdeskDomain: string | undefined;
  freshdeskApiKey: string | undefined;
  freshsalesSubdomain: string | undefined;
  freshsalesApiKey: string | undefined;
  attachmentAllow: AllowEntry[];
  logLevel: 'info' | 'debug';
}

const optionalString = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().trim().optional(),
);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_ORIGIN: z.url(),
  DATA_DIR: z.string().trim().min(1),
  SECRETS_KEY: z
    .string()
    .trim()
    .refine((v) => Buffer.from(v, 'base64').length === 32, {
      message: 'SECRETS_KEY must be 32 random bytes, base64-encoded',
    }),
  ANTHROPIC_API_KEY: optionalString,
  FRESHDESK_DOMAIN: optionalString,
  FRESHDESK_API_KEY: optionalString,
  FRESHSALES_SUBDOMAIN: optionalString,
  FRESHSALES_API_KEY: optionalString,
  ATTACHMENT_PROXY_ALLOW: optionalString,
  LOG_LEVEL: z.enum(['info', 'debug']).default('info'),
});

export function normalizeFreshdeskDomain(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const clean = raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\.freshdesk\.com\/?$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  return clean || undefined;
}

export function normalizeFreshsalesSubdomain(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const clean = raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\.freshworks\.com.*$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  return clean || undefined;
}

export function defaultAttachmentAllow(freshdeskDomain: string | undefined): string[] {
  const list = [
    'attachment.freshdesk.com',
    'attachment.freshdeskusercontent.com',
    's3.amazonaws.com/cdn.freshdesk.com/',
    's3.eu-central-1.amazonaws.com/euc-cdn.freshdesk.com/',
  ];
  if (freshdeskDomain) {
    list.unshift(`${freshdeskDomain}.freshdesk.com`, `${freshdeskDomain}.attachments.freshdesk.com`);
  }
  return list;
}

export function parseAttachmentAllow(raw: string | undefined, freshdeskDomain: string | undefined): AllowEntry[] {
  const entries = raw
    ? raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : defaultAttachmentAllow(freshdeskDomain);
  return entries.map((entry) => {
    const slash = entry.indexOf('/');
    if (slash < 0) return { host: entry.toLowerCase(), pathPrefix: '/' };
    return { host: entry.slice(0, slash).toLowerCase(), pathPrefix: entry.slice(slash) };
  });
}

export function loadConfig(env: NodeJS.ProcessEnv, rootDir: string): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new Error(`Invalid configuration:\n  ${problems.join('\n  ')}`);
  }
  const e = parsed.data;
  const freshdeskDomain = normalizeFreshdeskDomain(e.FRESHDESK_DOMAIN);
  return {
    nodeEnv: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    port: e.PORT,
    publicOrigin: new URL(e.PUBLIC_ORIGIN).origin,
    dataDir: e.DATA_DIR,
    rootDir,
    secretsKey: Buffer.from(e.SECRETS_KEY, 'base64'),
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    freshdeskDomain,
    freshdeskApiKey: e.FRESHDESK_API_KEY,
    freshsalesSubdomain: normalizeFreshsalesSubdomain(e.FRESHSALES_SUBDOMAIN),
    freshsalesApiKey: e.FRESHSALES_API_KEY,
    attachmentAllow: parseAttachmentAllow(e.ATTACHMENT_PROXY_ALLOW, freshdeskDomain),
    logLevel: e.LOG_LEVEL,
  };
}
