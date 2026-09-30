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

// Inline event handlers (V-1). A handler's attribute value is JavaScript inside HTML: the HTML parser decodes it
// (&#39; becomes ') before the handler is compiled. So '${v}' and '${escapeHtml(v)}' both end the JS string at the
// first quote in v, and the rest of v runs as script. Values go in as ${jsArg(v)}: a JSON string literal, HTML-escaped.
const HANDLER_FILES = ['index.html', 'loader.html', 'loader-admin.html'];
// A "/" after one of these characters starts a regex literal, as in .replace(/'/g, …); after anything else it divides.
const BEFORE_REGEX = new Set([...'(,=:[!&|?{};+-*%<>~^']);
const startsRegex = (s: string, i: number): boolean => {
  let j = i - 1;
  while (j >= 0 && /\s/.test(s[j]!)) j--;
  return BEFORE_REGEX.has(s[j] ?? '(');
};

// Index just past the quoted string, template or regex literal that starts at i.
function skipLiteral(s: string, i: number): number {
  const close = s[i];
  let inClass = false;
  for (i++; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') i++;
    else if (close === '`' && c === '$' && s[i + 1] === '{') i = skipInterpolation(s, i + 2) - 1;
    else if (close === '/' && c === '[') inClass = true;
    else if (close === '/' && c === ']') inClass = false;
    else if (c === close && !inClass) return i + 1;
  }
  return i;
}

// Index just past the "}" that closes an interpolation whose expression starts at i.
function skipInterpolation(s: string, i: number): number {
  for (let depth = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{') depth++;
    else if (c === '}' && depth-- === 0) return i + 1;
    else if (c === "'" || c === '"' || c === '`' || (c === '/' && startsRegex(s, i))) i = skipLiteral(s, i) - 1;
  }
  return i;
}

interface InlineHandler {
  line: number;
  /** The attribute value as written in the source, interpolations included. */
  value: string;
  /** The value's own text: template escapes resolved, each interpolation replaced by \u0000. */
  text: string;
}

// Every on…="…" and on…='…' attribute in the file's source (not data-on…), with its line number.
// A ${…} in the value is taken whole, so a quote inside its expression does not end the value.
function inlineHandlers(source: string): InlineHandler[] {
  const found: InlineHandler[] = [];
  const attribute = /(?<![\w-])on[a-z]+=(["'])/g;
  let line = 1;
  let counted = 0;
  for (let m = attribute.exec(source); m; m = attribute.exec(source)) {
    let i = attribute.lastIndex;
    let text = '';
    while (i < source.length && source[i] !== m[1] && source[i] !== '\n') {
      if (source[i] === '\\') {
        text += source[i + 1];
        i += 2;
      } else if (source.startsWith('${', i)) {
        i = skipInterpolation(source, i + 2);
        text += '\u0000';
      } else text += source[i++];
    }
    for (; counted < m.index; counted++) if (source[counted] === '\n') line++;
    found.push({ line, value: source.slice(attribute.lastIndex, i), text });
    attribute.lastIndex = i;
  }
  return found;
}

// Whether an interpolation sits inside a JS string of the handler, as in 'prefix-${id}'. Entities count as the
// quotes the HTML parser turns them into.
function interpolatesInString(text: string): boolean {
  const js = text.replace(/&quot;|&#34;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'");
  let quote = '';
  for (let i = 0; i < js.length; i++) {
    const c = js[i];
    if (quote && c === '\\') i++;
    else if (quote && c === '\u0000') return true;
    else if (c === quote) quote = '';
    else if (!quote && (c === "'" || c === '"' || c === '`')) quote = c;
  }
  return false;
}

const handlerLines = (file: string, bad: (h: InlineHandler) => boolean): string[] =>
  inlineHandlers(read(file))
    .filter(bad)
    .map((h) => `${file}:${h.line}`);

describe('inline event handlers', () => {
  it('the scanner sees the handlers of index.html', () => {
    expect(inlineHandlers(read('index.html')).length > 500).toBe(true);
  });

  // Each failure lists only file:line entries.
  for (const file of HANDLER_FILES) {
    it(`${file}: no interpolation inside a JS string of a handler, as in '\${v}' or 'prefix-\${v}'`, () => {
      // The regex also finds a quoted interpolation in a template nested inside an interpolation.
      expect(handlerLines(file, (h) => /['"`]\$\{/.test(h.value) || interpolatesInString(h.text))).toEqual([]);
    });

    it(`${file}: no escapeHtml(…) as the encoder inside a handler (jsArg is; escapeHtml(JSON.stringify(…)) is fine)`, () => {
      expect(handlerLines(file, (h) => /escapeHtml\((?!JSON\.stringify\()/.test(h.value))).toEqual([]);
    });

    it(`${file}: no bare \${JSON.stringify(…)} inside a handler (its first " would end the attribute)`, () => {
      expect(handlerLines(file, (h) => /\$\{JSON\.stringify\(/.test(h.value))).toEqual([]);
    });
  }
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
