import { describe, expect, it } from 'vitest';
import { loadConfig, parseAttachmentAllow } from '../server/config.js';

const KEY = Buffer.alloc(32, 1).toString('base64');
const base = { PUBLIC_ORIGIN: 'https://erp.example.com/', DATA_DIR: '/data', SECRETS_KEY: KEY };

describe('loadConfig', () => {
  it('parses a minimal valid environment with defaults', () => {
    const c = loadConfig(base, '/repo');
    expect(c.nodeEnv).toBe('development');
    expect(c.isProduction).toBe(false);
    expect(c.port).toBe(3000);
    expect(c.publicOrigin).toBe('https://erp.example.com');
    expect(c.dataDir).toBe('/data');
    expect(c.rootDir).toBe('/repo');
    expect(c.secretsKey.length).toBe(32);
    expect(c.anthropicApiKey).toBeUndefined();
    expect(c.logLevel).toBe('info');
  });

  it('reads PORT and NODE_ENV', () => {
    const c = loadConfig({ ...base, PORT: '8080', NODE_ENV: 'production' }, '/repo');
    expect(c.port).toBe(8080);
    expect(c.isProduction).toBe(true);
  });

  it('treats empty optional variables as unset', () => {
    const c = loadConfig({ ...base, FRESHDESK_API_KEY: '', ANTHROPIC_API_KEY: '   ' }, '/repo');
    expect(c.freshdeskApiKey).toBeUndefined();
    expect(c.anthropicApiKey).toBeUndefined();
  });

  it('normalizes Freshdesk and Freshsales hosts', () => {
    const c = loadConfig(
      { ...base, FRESHDESK_DOMAIN: 'https://FLPliftparts.freshdesk.com/', FRESHSALES_SUBDOMAIN: 'gilt.freshworks.com/crm' },
      '/repo',
    );
    expect(c.freshdeskDomain).toBe('flpliftparts');
    expect(c.freshsalesSubdomain).toBe('gilt');
  });

  it('rejects a missing PUBLIC_ORIGIN and a wrong-sized SECRETS_KEY with a readable message', () => {
    expect(() => loadConfig({ DATA_DIR: '/data', SECRETS_KEY: 'c2hvcnQ=' }, '/repo')).toThrow(
      /PUBLIC_ORIGIN[\s\S]*SECRETS_KEY must be 32 random bytes/,
    );
  });

  it('builds the default attachment allowlist from the Freshdesk domain', () => {
    const c = loadConfig({ ...base, FRESHDESK_DOMAIN: 'flpliftparts' }, '/repo');
    expect(c.attachmentAllow).toEqual([
      { host: 'flpliftparts.freshdesk.com', pathPrefix: '/' },
      { host: 'flpliftparts.attachments.freshdesk.com', pathPrefix: '/' },
      { host: 'attachment.freshdesk.com', pathPrefix: '/' },
      { host: 'attachment.freshdeskusercontent.com', pathPrefix: '/' },
      { host: 's3.amazonaws.com', pathPrefix: '/cdn.freshdesk.com/' },
      { host: 's3.eu-central-1.amazonaws.com', pathPrefix: '/euc-cdn.freshdesk.com/' },
    ]);
  });

  it('lets ATTACHMENT_PROXY_ALLOW override the default list', () => {
    expect(parseAttachmentAllow('Files.Example.com, s3.amazonaws.com/bucket/', 'x')).toEqual([
      { host: 'files.example.com', pathPrefix: '/' },
      { host: 's3.amazonaws.com', pathPrefix: '/bucket/' },
    ]);
  });
});
