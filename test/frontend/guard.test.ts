// test/frontend/guard.test.ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
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

// What the old app left in the storage of giltglobalinvest-pixel.github.io: its Val.town session and, after a
// bootstrap login, the raw login key (APP_CONFIG.PROJECT_ID is p_1778057282571).
const LEGACY_KEYS = ['session_token_p_1778057282571', 'user_key_p_1778057282571'];
const PAGES_HOST = 'giltglobalinvest-pixel.github.io';
const RAILWAY_LINK = 'https://erp-hero-production.up.railway.app/#quote/rec123';

interface FakeStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
}
// In-memory storage whose items are own enumerable properties, so Object.keys() lists them as on a real Storage.
function fakeStorage(seed: Record<string, string>): FakeStorage {
  const items: Record<string, string> = {};
  Object.defineProperties(items, {
    getItem: { value: (key: string) => (Object.hasOwn(items, key) ? items[key] : null) },
    removeItem: {
      value: (key: string) => {
        delete items[key];
      },
    },
  });
  Object.assign(items, seed);
  return items as unknown as FakeStorage;
}

// The page's first inline script without attributes: the guard in index.html, the redirect in the loaders.
const firstInlineScript = (file: string): string => /<script>([\s\S]*?)<\/script>/.exec(read(file))?.[1] ?? '';

// Runs a page script in node:vm on the given host, with a stub location, window.stop() and storages that hold what
// the old app left there. Nothing is loaded and no host is contacted. With blockStorage, every access to
// localStorage or sessionStorage throws, as it does in a browser that blocks site data.
function runOn(hostname: string, script: string, { blockStorage = false } = {}) {
  const localStorage = fakeStorage({
    [LEGACY_KEYS[0]!]: 'alte-valtown-sitzung',
    [LEGACY_KEYS[1]!]: 'alter-login-key',
    voice_mode: 'on',
  });
  const sessionStorage = fakeStorage({ [LEGACY_KEYS[0]!]: 'alte-valtown-sitzung-tab' });
  const left = () => ({
    localStorage: LEGACY_KEYS.filter((key) => localStorage.getItem(key) !== null),
    sessionStorage: LEGACY_KEYS.filter((key) => sessionStorage.getItem(key) !== null),
  });
  // Each redirect with the old keys that were still there when it started.
  const redirects: { url: string; left: ReturnType<typeof left> }[] = [];
  let stopped = 0;
  const location = {
    hostname,
    hash: '#quote/rec123',
    replace: (url: string) => {
      redirects.push({ url, left: left() });
    },
  };
  const window = {
    stop: () => {
      stopped++;
    },
  };
  const context = vm.createContext({ window, location });
  for (const [name, storage] of [['localStorage', localStorage], ['sessionStorage', sessionStorage]] as const) {
    Object.defineProperty(context, name, {
      get: () => {
        if (blockStorage) throw new Error('storage blocked');
        return storage;
      },
    });
  }
  vm.runInContext(script, context, { timeout: 1000 });
  return { redirects, stopped, left: left(), voiceMode: localStorage.getItem('voice_mode') };
}

describe('leaving github.io', () => {
  for (const file of ['index.html', 'loader.html', 'loader-admin.html']) {
    it(`${file} removes the old login keys from both storages before it redirects to Railway`, () => {
      const run = runOn(PAGES_HOST, firstInlineScript(file));
      expect(run.redirects).toEqual([{ url: RAILWAY_LINK, left: { localStorage: [], sessionStorage: [] } }]);
      // Only the login keys: preferences stay.
      expect(run.voiceMode).toBe('on');
    });

    it(`${file} still redirects when the browser blocks the storage`, () => {
      const run = runOn(PAGES_HOST, firstInlineScript(file), { blockStorage: true });
      expect(run.redirects.map((r) => r.url)).toEqual([RAILWAY_LINK]);
    });
  }

  it('the guard in index.html changes nothing on any other host', () => {
    const run = runOn('erp-hero-production.up.railway.app', firstInlineScript('index.html'));
    expect([run.redirects, run.stopped]).toEqual([[], 0]);
    expect(run.left).toEqual({ localStorage: LEGACY_KEYS, sessionStorage: [LEGACY_KEYS[0]] });
  });
});
