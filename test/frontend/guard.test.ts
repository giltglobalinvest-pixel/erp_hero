// test/frontend/guard.test.ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (file: string): string => readFileSync(path.join(ROOT, file), 'utf8');
// Airtable personal access token: "pat" + 14 alphanumerics + "." + 64 hex characters.
const TOKEN_PATTERN = /pat[A-Za-z0-9]{14}\.[0-9a-f]{64}/;

// Assertions are booleans on purpose: a failing toMatch/toContain would print the whole file.
describe('index.html', () => {
  const html = read('index.html');

  it('contains no Airtable token', () => {
    expect(TOKEN_PATTERN.test(html)).toBe(false);
    expect(html.includes('_TKP')).toBe(false);
    expect(/AIRTABLE_READ_KEY\s*:/.test(html)).toBe(false);
  });

  it('has no Val.town setup or Master-Base code left', () => {
    for (const name of [
      'VALTOWN_PROXY_CODE', '_fetchMasterBaseKeys', '_writeMasterBaseKey', '_deleteMasterBaseKey', '_valtownEnvVars',
      '_applyKeyToAppState', 'api.val.town', 'valtownStartSetup', 'valtownAutoSetup', 'valtownSetEnvVar',
      '_bearerForProxy', 'settingsFsApiKey',
    ]) {
      expect(html.includes(name), name).toBe(false);
    }
  });

  it('has none of the old hosts, keys and token fields (spec §14)', () => {
    for (const name of [
      'api.airtable.com', 'content.airtable.com', 'val.town', 'val.run', 'esm.town',
      'AIRTABLE_READ_KEY', 'airtableWriteKey', 'sessionToken',
    ]) {
      expect(html.includes(name), name).toBe(false);
    }
  });

  it('has no Airtable or Val.town config and no Airtable table setup left', () => {
    for (const name of [
      'MASTER_BASE_ID', 'APP_BASE_ID', 'appBaseId', 'anthropicKey', 'apiProxyUrl', 'freshdeskProxyUrl',
      'freshdeskProxyToken', 'AI_USAGE_LOG_SCHEMA', '_createAiUsageLogTableManually',
    ]) {
      expect(html.includes(name), name).toBe(false);
    }
  });
});

describe('sw.js', () => {
  const sw = read('sw.js');

  it('is version 2 and leaves /api/ and /healthz to the network', () => {
    expect(sw.includes("const SW_VERSION = 'erp-hero-sw-v2';")).toBe(true);
    expect(sw.includes("if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return;")).toBe(true);
  });
});
