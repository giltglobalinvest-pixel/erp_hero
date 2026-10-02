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

// Stored rich text in the editors. Quill 2.0.2 sanitizes nothing: its root is a live div.ql-editor, so
// root.innerHTML = html is a live parse in the page, and so is a write to the element Quill is built on. Its
// clipboard.dangerouslyPasteHTML parses in an inert document today; it takes sanitized HTML anyway, so that a Quill
// upgrade cannot reopen a path. The scanner reads the inline scripts of index.html as code: comments removed, and the
// text of strings, templates and regex literals blanked, so text in a literal never counts as code.
// Stored HTML goes into an existing editor only through setQuillHtml (N7): a direct write drops older list markup with
// its text, so a write into a Quill root or a ql-editor element anywhere else fails, sanitized or not. Inside
// setQuillHtml, the direct write and clipboard.convert take the sanitizer's output; convert parses HTML like a paste,
// so every convert call is a sink.
const RICH_TEXT_TAGS = /p\|br\|strong\|em\|b\|i\|u\|ol\|ul\|li\|h\[1-6\]\|span\|div/g;
// After one of these words a "/" starts a regex literal too, as in: return /<p\b/i.test(s).
const REGEX_WORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'void', 'delete', 'throw', 'new', 'else', 'do', 'yield', 'await']);
const regexAt = (s: string, i: number): boolean => {
  if (startsRegex(s, i)) return true;
  let j = i - 1;
  while (j >= 0 && /\s/.test(s[j]!)) j--;
  let k = j;
  while (k >= 0 && /[\w$]/.test(s[k]!)) k--;
  return s[k] !== '.' && REGEX_WORDS.has(s.slice(k + 1, j + 1));
};

interface Script {
  /** Offset of the script's first character in the file. */
  offset: number;
  /** The script with its comments replaced by spaces; offsets and line breaks are kept. */
  code: string;
  /** code with the text of every literal also replaced by spaces (the quotes, backticks and ${…} code stay). */
  mask: string;
}

function scanScript(js: string, offset: number): Script {
  const code = js.split('');
  const mask = js.split('');
  // Comments go from both; a literal's text only from the mask, line breaks included, so a multi-line template
  // reads as one token.
  const blank = (to: string[][], from: number, end: number, keepBreaks: boolean) => {
    for (const out of to) for (let k = from; k < end; k++) if (!(keepBreaks && out[k] === '\n')) out[k] = ' ';
  };
  // Code from i up to the "}" that closes an interpolation (returned), or to the end.
  const scan = (i: number, interpolation: boolean): number => {
    for (let depth = 0; i < js.length; ) {
      const c = js[i];
      if (c === '/' && js[i + 1] === '/') {
        const end = js.indexOf('\n', i) < 0 ? js.length : js.indexOf('\n', i);
        blank([code, mask], i, end, true);
        i = end;
      } else if (c === '/' && js[i + 1] === '*') {
        const end = js.indexOf('*/', i + 2) < 0 ? js.length : js.indexOf('*/', i + 2) + 2;
        blank([code, mask], i, end, true);
        i = end;
      } else if (c === '`') i = template(i);
      else if (c === "'" || c === '"' || (c === '/' && regexAt(js, i))) {
        const end = skipLiteral(js, i);
        blank([mask], i + 1, end - 1, false);
        i = end;
      } else {
        if (c === '{') depth++;
        else if (c === '}' && depth-- === 0 && interpolation) return i;
        i++;
      }
    }
    return i;
  };
  // A template literal at i: its text is blanked, its ${…} code is scanned. Returns the index past it.
  const template = (i: number): number => {
    let text = i + 1;
    for (let k = i + 1; k < js.length; ) {
      if (js[k] === '\\') k += 2;
      else if (js[k] === '`') {
        blank([mask], text, k, false);
        return k + 1;
      } else if (js[k] === '$' && js[k + 1] === '{') {
        blank([mask], text, k, false);
        k = scan(k + 2, true) + 1;
        text = k;
      } else k++;
    }
    return js.length;
  };
  scan(0, false);
  return { offset, code: code.join(''), mask: mask.join('') };
}

// Every inline script of the file (scripts with src are skipped).
function inlineScripts(html: string): Script[] {
  const scripts: Script[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (/\bsrc\s*=/.test(m[1]!)) continue;
    scripts.push(scanScript(m[2]!, m.index + m[0].indexOf('>') + 1));
  }
  return scripts;
}

// Index of the bracket that closes the one at i (in a mask), or -1.
function closerOf(mask: string, i: number): number {
  for (let depth = 0, k = i; k < mask.length; k++) {
    if ('([{'.includes(mask[k]!)) depth++;
    else if (')]}'.includes(mask[k]!) && --depth === 0) return k;
  }
  return -1;
}
// Index of the bracket that opens the one at i (in a mask), or -1.
function openerOf(mask: string, i: number): number {
  for (let depth = 0, k = i; k >= 0; k--) {
    if (')]}'.includes(mask[k]!)) depth++;
    else if ('([{'.includes(mask[k]!) && --depth === 0) return k;
  }
  return -1;
}
// The innermost { … } around i, as [open, close].
function blockAround(mask: string, i: number): [number, number] {
  for (let depth = 0, k = i - 1; k >= 0; k--) {
    if (mask[k] === '}') depth++;
    else if (mask[k] === '{' && depth-- === 0) return [k, closerOf(mask, k)];
  }
  return [0, mask.length];
}

// A line that ends in one of these, or whose next line starts with one, continues the expression.
const CONTINUES_AFTER = /[-+*/%&|^!~?:.,=<>([{]$/;
const CONTINUES_BEFORE = /^[-+*/%&|^?:.,=<>([`]/;
// End of the expression that starts at i: a ";" or "," outside brackets, an unmatched closing bracket, or a line
// break that ends the statement.
function expressionEnd(mask: string, i: number): number {
  for (let depth = 0, k = i; k < mask.length; k++) {
    const c = mask[k]!;
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c) && depth-- === 0) return k;
    else if (depth === 0 && (c === ';' || c === ',')) return k;
    else if (depth === 0 && c === '\n') {
      const before = mask.slice(i, k).trimEnd().slice(-1);
      const after = mask.slice(k + 1).trimStart().slice(0, 1);
      if (before && !CONTINUES_AFTER.test(before) && !CONTINUES_BEFORE.test(after)) return k;
    }
  }
  return mask.length;
}

// The arguments of the call whose "(" is at open, as [from, to) ranges, and the index of its ")".
function callArguments(mask: string, open: number): { args: [number, number][]; close: number } {
  const close = closerOf(mask, open);
  const args: [number, number][] = [];
  let from = open + 1;
  for (let depth = 0, k = open + 1; k < close; k++) {
    if ('([{'.includes(mask[k]!)) depth++;
    else if (')]}'.includes(mask[k]!)) depth--;
    else if (depth === 0 && mask[k] === ',') {
      args.push([from, k]);
      from = k + 1;
    }
  }
  if (mask.slice(from, close).trim()) args.push([from, close]);
  return { args, close };
}

// Start of the member expression that ends at end, as in a?.b.c(…)[…] before ".innerHTML".
function receiverStart(mask: string, end: number): number {
  let i = end;
  for (;;) {
    let j = i - 1;
    while (j >= 0 && /\s/.test(mask[j]!)) j--;
    if (mask[j] === ')' || mask[j] === ']') {
      i = openerOf(mask, j);
      continue;
    }
    if (!/[\w$]/.test(mask[j] ?? '')) return i;
    while (j >= 0 && /[\w$]/.test(mask[j]!)) j--;
    i = j + 1;
    let p = j;
    while (p >= 0 && /\s/.test(mask[p]!)) p--;
    if (mask[p] !== '.') return i;
    i = mask[p - 1] === '?' ? p - 1 : p;
  }
}

const squash = (s: string): string => s.replace(/\s+/g, '');
// A whole call of name(…) and nothing else.
function isCallOf(names: RegExp, code: string, mask: string): boolean {
  const lead = code.length - code.trimStart().length;
  const m = names.exec(mask.slice(lead));
  if (!m) return false;
  const open = lead + m[0].length - 1;
  return closerOf(mask, open) === mask.trimEnd().length - 1;
}
// HTML that is safe to parse in the page: a sanitizer call, an empty string, or a template whose every ${…} is a
// whole escapeHtml(…) call (the editors' plain-text branches, as in `<p>${escapeHtml(text)}</p>`).
function isSanitizedHtml(code: string, mask: string): boolean {
  const s = code.trim();
  if (s === "''" || s === '""' || s === '``') return true;
  if (isCallOf(/^(?:sanitizeRichHtml|richTextToHtml)\s*\(/, code, mask)) return true;
  const lead = code.length - code.trimStart().length;
  const m = mask.slice(lead, lead + s.length);
  if (!m.startsWith('`')) return false;
  for (let k = 1; k < m.length; k++) {
    if (m[k] === '`') return k === m.length - 1;
    if (m.startsWith('${', k)) {
      const close = closerOf(m, k + 1);
      if (close < 0 || !isCallOf(/^escapeHtml\s*\(/, s.slice(k + 2, close), m.slice(k + 2, close))) return false;
      k = close;
    }
  }
  return false;
}

type SinkKind = 'Quill root' | 'editor element' | 'Quill container' | 'paste' | 'convert';
interface EditorSink {
  kind: SinkKind;
  line: number;
  sanitized: boolean;
  /** In the body of setQuillHtml. */
  inLoader: boolean;
}
interface EditorScan {
  constructors: number;
  /** Constructors whose container the scanner found: a const/let/var binding, or an expression. */
  containersResolved: number;
  /** Declarations function setQuillHtml(…) { … }. */
  loaders: number;
  /** Calls of setQuillHtml. */
  loaderCalls: number;
  sinks: EditorSink[];
}

const LOADER = 'setQuillHtml';
// A write into a Quill root or a ql-editor element outside setQuillHtml.
const isDirect = (s: EditorSink): boolean => !s.inLoader && (s.kind === 'Quill root' || s.kind === 'editor element');
// What the guard rejects, as "line kind": every sink that takes unsanitized HTML, and every direct write.
const rejected = (scan: EditorScan): string[] =>
  scan.sinks.flatMap((s) => (!s.sanitized ? [`${s.line} ${s.kind}`] : isDirect(s) ? [`${s.line} ${s.kind} outside ${LOADER}`] : []));

// The names that the function in [from, to) binds to sanitized HTML (const name = sanitizeRichHtml(…)), when nothing
// else in it binds or assigns that name: no parameter of it or of a function in it, no other declaration, no
// assignment.
function cleanNames(code: string, mask: string, from: number, to: number): Set<string> {
  const region = mask.slice(from, to);
  // Parameter lists, catch bindings and destructuring patterns in the function, as text.
  const patterns: string[] = [];
  for (const m of region.matchAll(/\bfunction\b\s*[\w$]*\s*\(|\bcatch\s*\(|\b(?:const|let|var)\s*[{[]/g)) {
    const open = m.index + m[0].length - 1;
    patterns.push(region.slice(open, closerOf(region, open) + 1));
  }
  for (const m of region.matchAll(/=>/g)) {
    let j = m.index - 1;
    while (j >= 0 && /\s/.test(region[j]!)) j--;
    let k = j;
    if (region[j] === ')') k = openerOf(region, j) - 1;
    else while (k >= 0 && /[\w$]/.test(region[k]!)) k--;
    patterns.push(region.slice(k + 1, j + 1));
  }
  const names = new Set<string>();
  for (const m of region.matchAll(/\bconst\s+([\w$]+)\s*=(?!=)/g)) {
    const start = from + m.index + m[0].length;
    const end = expressionEnd(mask, start);
    if (!isSanitizedHtml(code.slice(start, end), mask.slice(start, end))) continue;
    const name = m[1]!.replace(/\$/g, '\\$');
    const word = String.raw`(?<![\w$.])${name}(?![\w$])`;
    const count = (re: string) => [...region.matchAll(new RegExp(re, 'g'))].length;
    const declarations = count(String.raw`\b(?:const|let|var|function|class)\s+${name}(?![\w$])`);
    const assignments = count(String.raw`${word}\s*(?:[-+*/%&|^]|\*\*|<<|>>>?|&&|\|\||\?\?)?=(?![=>])`);
    const updates = count(String.raw`(?:\+\+|--)\s*${word}|${word}\s*(?:\+\+|--)`);
    const bound = patterns.some((p) => new RegExp(word).test(p));
    if (declarations === 1 && assignments === 1 && updates === 0 && !bound) names.add(m[1]!);
  }
  return names;
}

// Every write of HTML into a Quill root, an element of class ql-editor, or a Quill container, every
// dangerouslyPasteHTML call and every convert call, in the inline scripts of html.
function scanEditorSinks(html: string): EditorScan {
  const breaks: number[] = [];
  for (let k = html.indexOf('\n'); k >= 0; k = html.indexOf('\n', k + 1)) breaks.push(k);
  const lineOf = (pos: number): number => {
    let lo = 0;
    let hi = breaks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (breaks[mid]! < pos) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
  const result: EditorScan = { constructors: 0, containersResolved: 0, loaders: 0, loaderCalls: 0, sinks: [] };
  for (const { offset, code, mask } of inlineScripts(html)) {
    // The loader: function setQuillHtml(…) { … }, with the names it binds to sanitized HTML.
    const loaders: { from: number; to: number; clean: Set<string> }[] = [];
    for (const m of mask.matchAll(new RegExp(String.raw`\bfunction\s+${LOADER}\s*\(`, 'g'))) {
      let open = callArguments(mask, m.index + m[0].length - 1).close + 1;
      while (/\s/.test(mask[open] ?? '')) open++;
      if (mask[open] !== '{') continue;
      const to = closerOf(mask, open) + 1;
      loaders.push({ from: open, to, clean: cleanNames(code, mask, m.index, to) });
      result.loaders++;
    }
    result.loaderCalls += [...mask.matchAll(new RegExp(String.raw`(?<!\bfunction\s+)\b${LOADER}\s*\(`, 'g'))].length;
    const loaderAt = (at: number) => loaders.find((l) => l.from <= at && at < l.to);
    // Sanitized HTML: a sanitizer call, '' or escaped text (isSanitizedHtml); in the loader, also a name it binds to one.
    const safe = ([from, to]: [number, number], at: number): boolean =>
      isSanitizedHtml(code.slice(from, to), mask.slice(from, to)) || !!loaderAt(at)?.clean.has(code.slice(from, to).trim());
    // Writes: target.innerHTML = …, target.outerHTML = …, target['innerHTML'] = …, target.insertAdjacentHTML(_, …).
    const writes: { at: number; receiver: string; value: [number, number] }[] = [];
    for (const m of mask.matchAll(/\.\s*(?:innerHTML|outerHTML)\s*\+?=(?!=)/g)) {
      const value = m.index + m[0].length;
      writes.push({ at: m.index, receiver: code.slice(receiverStart(mask, m.index), m.index), value: [value, expressionEnd(mask, value)] });
    }
    for (const m of code.matchAll(/\[\s*(['"`])(?:innerHTML|outerHTML)\1\s*\]\s*\+?=(?!=)/g)) {
      if (mask[m.index] !== '[') continue;
      const value = m.index + m[0].length;
      writes.push({ at: m.index, receiver: code.slice(receiverStart(mask, m.index), m.index), value: [value, expressionEnd(mask, value)] });
    }
    for (const m of mask.matchAll(/\.\s*insertAdjacentHTML\s*\(/g)) {
      const { args } = callArguments(mask, m.index + m[0].length - 1);
      if (args[1]) writes.push({ at: m.index, receiver: code.slice(receiverStart(mask, m.index), m.index), value: args[1] });
    }
    // Names bound to an editor root or a ql-editor element: const r = quill.root, const { root } = quill,
    // const box = el.querySelector('.ql-editor'). Each covers the rest of its block.
    const aliases: { name: string; kind: SinkKind; from: number; to: number }[] = [];
    for (const m of mask.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=(?!=)/g)) {
      const from = m.index + m[0].length;
      const rhs = squash(code.slice(from, expressionEnd(mask, from)));
      const kind: SinkKind | null = /(?:\.root|\[['"`]root['"`]\])$/.test(rhs) ? 'Quill root' : rhs.includes('ql-editor') ? 'editor element' : null;
      if (kind) aliases.push({ name: m[1]!, kind, from, to: blockAround(mask, m.index)[1] });
    }
    for (const m of mask.matchAll(/\b(?:const|let|var)\s*\{([^{}]*)\}\s*=(?!=)/g)) {
      const root = /(?:^|,)\s*root\s*(?::\s*([\w$]+))?\s*(?:,|$)/.exec(m[1]!);
      if (root) aliases.push({ name: root[1] ?? 'root', kind: 'Quill root', from: m.index, to: blockAround(mask, m.index)[1] });
    }
    // Quill containers: the first argument of new Quill(…) / new window.Quill(…). A name counts from its last
    // binding before the constructor to the end of that binding's block; the expression it was bound to (or the
    // argument itself, if it is no name) counts everywhere.
    const containers: { name: string | null; expression: string; from: number; to: number }[] = [];
    for (const m of mask.matchAll(/\bnew\s+(?:window\s*\.\s*)?Quill\s*\(/g)) {
      result.constructors++;
      const [first] = callArguments(mask, m.index + m[0].length - 1).args;
      if (!first) continue;
      const arg = code.slice(first[0], first[1]).trim();
      if (!/^[\w$]+$/.test(arg)) {
        containers.push({ name: null, expression: squash(arg), from: 0, to: 0 });
        result.containersResolved++;
        continue;
      }
      const bindings = [...mask.slice(0, m.index).matchAll(new RegExp(String.raw`(?<![\w$.])(?:(?:const|let|var)\s+)?${arg}\s*=(?!=)`, 'g'))];
      const binding = bindings.filter((b) => blockAround(mask, b.index)[1] > m.index).pop();
      if (!binding) {
        const [from, to] = blockAround(mask, m.index);
        containers.push({ name: arg, expression: '', from, to });
        continue;
      }
      const from = binding.index + binding[0].length;
      containers.push({ name: arg, expression: squash(code.slice(from, expressionEnd(mask, from))), from: binding.index, to: blockAround(mask, binding.index)[1] });
      result.containersResolved++;
    }
    const kindOf = (w: (typeof writes)[number]): SinkKind | null => {
      const receiver = squash(w.receiver);
      if (/(?:\.root|\[['"`]root['"`]\])$/.test(receiver)) return 'Quill root';
      if (receiver.includes('ql-editor')) return 'editor element';
      const alias = aliases.filter((a) => a.name === receiver && a.from <= w.at && w.at < a.to).pop();
      if (alias) return alias.kind;
      for (const c of containers) {
        if (c.name === receiver && c.from <= w.at && w.at < c.to) return 'Quill container';
        if (c.expression && c.expression === receiver) return 'Quill container';
      }
      return null;
    };
    for (const w of writes) {
      const kind = kindOf(w);
      if (!kind) continue;
      result.sinks.push({ kind, line: lineOf(offset + w.at), sanitized: safe(w.value, w.at), inLoader: !!loaderAt(w.at) });
    }
    // dangerouslyPasteHTML(html[, source]) or dangerouslyPasteHTML(index, html[, source]), also as ['…'](…).
    for (const m of code.matchAll(/\bdangerouslyPasteHTML\b(\s*['"`]\s*\])?\s*\(/g)) {
      const isCode = m[1] ? mask[m.index - 1] === m[1].trim()[0] : mask[m.index] === 'd';
      if (!isCode) continue;
      const { args } = callArguments(mask, m.index + m[0].length - 1);
      const second = args[1] ? squash(code.slice(args[1][0], args[1][1])) : '';
      const html = args.length < 2 || /^(['"`])(?:api|user|silent)\1$|\.sources\.[A-Z]+$/.test(second) ? args[0] : args[1];
      const sanitized = !!html && safe(html, m.index);
      result.sinks.push({ kind: 'paste', line: lineOf(offset + m.index), sanitized, inLoader: !!loaderAt(m.index) });
    }
    // convert({ html, text }) on any receiver (q.clipboard, getModule('clipboard'), an alias), also as ['convert'](…)
    // or ?.(…). Its argument must be an object literal whose html properties are all sanitized; any other argument, a
    // spread or a computed key could carry HTML.
    for (const m of code.matchAll(/(?:\?\.|\.)\s*convert\s*(?:\?\.\s*)?\(|(?:\?\.\s*)?\[\s*(['"`])convert\1\s*\]\s*(?:\?\.\s*)?\(/g)) {
      if (mask[m.index] === ' ') continue;
      const [arg] = callArguments(mask, m.index + m[0].length - 1).args;
      let sanitized = true;
      if (arg) {
        const text = code.slice(arg[0], arg[1]);
        const open = arg[0] + text.length - text.trimStart().length;
        sanitized =
          mask[open] === '{' &&
          closerOf(mask, open) === arg[0] + text.trimEnd().length - 1 &&
          callArguments(mask, open).args.every(([from, to]) => {
            const property = code.slice(from, to);
            if (/^\s*[\w$]+\s*$/.test(property)) return property.trim() !== 'html' || safe([from, to], m.index);
            const key = /^\s*(?:([\w$]+)|(['"`])([^'"`]*)\2)\s*:/.exec(property);
            return !!key && ((key[1] ?? key[3]) !== 'html' || safe([from + key[0].length, to], m.index));
          });
      }
      result.sinks.push({ kind: 'convert', line: lineOf(offset + m.index), sanitized, inLoader: !!loaderAt(m.index) });
    }
  }
  result.sinks.sort((a, b) => a.line - b.line);
  return result;
}

describe('rich text in the editors', () => {
  const html = read('index.html');
  const lineOf = (pos: number): number => html.slice(0, pos).split('\n').length;

  it('the rich-text test is written once, in isRichText', () => {
    const places = [...html.matchAll(RICH_TEXT_TAGS)].map((m) => ({
      line: lineOf(m.index),
      // The function whose body holds it directly.
      fn: /function\s+([\w$]+)\s*\([^)]*\)\s*\{[^{}]*$/.exec(html.slice(0, m.index))?.[1] ?? '',
    }));
    // A failure lists every other line that carries it.
    expect(places.filter((p) => p.fn !== 'isRichText').map((p) => `index.html:${p.line}`)).toEqual([]);
    expect(places.filter((p) => p.fn === 'isRichText')).toHaveLength(1);
  });

  it('the scanner finds each form of an editor sink, and nothing in strings, comments or regex literals', () => {
    // Lines ending in //! must be found, as the kind after it; no other line may be.
    const sample = [
      '<script>',
      'function a(q, el, html) {',
      '  q.root.innerHTML = html; //!Quill root',
      '  q.root.innerHTML = sanitizeRichHtml(html); //!Quill root outside setQuillHtml',
      "  q.root.innerHTML = ''; //!Quill root outside setQuillHtml",
      '  q.root.outerHTML = richTextToHtml(html) + html; //!Quill root',
      "  window._x.description.root['innerHTML'] += html; //!Quill root",
      '  const r = q.root;',
      '  r.innerHTML = //!Quill root',
      '    html;',
      '  const { root: ed } = q;',
      "  ed.insertAdjacentHTML('beforeend', html); //!Quill root",
      "  const box = el?.querySelector('.ql-editor');",
      '  if (isRichText(html)) box.innerHTML = html; //!editor element',
      '  else box.innerHTML = `<p>${escapeHtml(html)}</p>`; //!editor element outside setQuillHtml',
      '  box.innerHTML = `<p>${html}</p>`; //!editor element',
      "  document.querySelector('#x .ql-editor').innerHTML = html; //!editor element",
      '  q.clipboard.dangerouslyPasteHTML(html); //!paste',
      "  q.clipboard.dangerouslyPasteHTML(0, html, 'user'); //!paste",
      "  q.clipboard.dangerouslyPasteHTML(sanitizeRichHtml(html), 'api');",
      '  q.clipboard.dangerouslyPasteHTML(0, sanitizeRichHtml(html) + html); //!paste',
      "  q.clipboard['dangerouslyPasteHTML'](0, html, Quill.sources.USER); //!paste",
      '  q.clipboard.convert({ html }); //!convert',
      "  q.setContents(q.clipboard.convert({ html: sanitizeRichHtml(html), text: html }), 'api');",
      "  q.clipboard['convert']({ text: html });",
      `  q.getModule('clipboard').convert({ "html": html }); //!convert`,
      '  q.clipboard?.convert(opts); //!convert',
      '  q.clipboard.convert?.({ ...opts }); //!convert',
      '  const safe = sanitizeRichHtml(html);',
      '  q.clipboard.convert({ html: safe }); //!convert',
      '  setQuillHtml(q, html);',
      "  const s = 'q.root.innerHTML = html; q.clipboard.dangerouslyPasteHTML(html); q.clipboard.convert({ html });';",
      '  const t = `q.root.innerHTML = ${JSON.stringify(html)}`;',
      '  // q.root.innerHTML = html; q.clipboard.convert({ html });',
      '  /* q.clipboard.dangerouslyPasteHTML(html); */',
      '  const re = /q.root.innerHTML = html/;',
      '  el.innerHTML = html;',
      '}',
      'function b(html) {',
      "  const container = document.getElementById('c_editor');",
      '  container.innerHTML = html; //!Quill container',
      '  const q = new window.Quill(container, {});',
      "  document.getElementById('d_editor').innerHTML = html; //!Quill container",
      "  new Quill(document.getElementById('d_editor'));",
      '}',
      'function setQuillHtml(q, html, opts) {',
      '  const clean = sanitizeRichHtml(html, opts);',
      '  const raw = html;',
      "  if (clean.includes('<ul')) q.setContents(q.clipboard.convert({ html: clean }), 'api');",
      '  else q.root.innerHTML = clean;',
      '  q.root.innerHTML = sanitizeRichHtml(html);',
      '  q.root.innerHTML = html; //!Quill root',
      '  q.root.innerHTML = clean + html; //!Quill root',
      '  q.clipboard.convert({ html: raw }); //!convert',
      "  q.clipboard.convert({ 'html': html, text: clean }); //!convert",
      '}',
      '</script>',
      '<script>',
      'function setQuillHtml(q, html) {',
      '  const clean = sanitizeRichHtml(html);',
      '  let later = sanitizeRichHtml(html);',
      '  q.root.innerHTML = later; //!Quill root',
      '  [html].forEach((clean) => { q.root.innerHTML = clean; }); //!Quill root',
      '}',
      '</script>',
    ];
    const expected = sample.flatMap((l, i) => (l.includes('//!') ? [`${i + 1} ${l.split('//!')[1]}`] : []));
    const scan = scanEditorSinks(sample.join('\n'));
    expect(rejected(scan)).toEqual(expected);
    expect([scan.constructors, scan.containersResolved, scan.loaders, scan.loaderCalls]).toEqual([2, 2, 2, 1]);
  });

  it('the scanner sees the editors of index.html', () => {
    const scan = scanEditorSinks(html);
    const count = (kind: SinkKind, inLoader: boolean) => scan.sinks.filter((s) => s.kind === kind && s.inLoader === inLoader).length;
    expect(scan.constructors >= 10).toBe(true);
    expect(scan.containersResolved).toBe(scan.constructors);
    // One setQuillHtml, with its direct write and its convert call; the editors' 19 loads call it.
    expect([scan.loaders, count('Quill root', true), count('convert', true)]).toEqual([1, 1, 1]);
    expect(scan.loaderCalls >= 19).toBe(true);
    expect(count('paste', false) >= 6).toBe(true);
  });

  // Each failure lists only file:line entries.
  it('every Quill root, ql-editor element, Quill container, paste and convert takes sanitized HTML', () => {
    const unsanitized = scanEditorSinks(html).sinks.filter((s) => !s.sanitized);
    expect(unsanitized.map((s) => `index.html:${s.line} ${s.kind}`)).toEqual([]);
  });

  it('only setQuillHtml writes HTML into a Quill root or a ql-editor element', () => {
    const direct = scanEditorSinks(html).sinks.filter(isDirect);
    expect(direct.map((s) => `index.html:${s.line} ${s.kind}`)).toEqual([]);
  });

  it('the markup gives every editor container no content of its own', () => {
    const containers = [...html.matchAll(/<([a-z]+)\b[^>]*\bid="[^"]*[eE]ditor"[^>]*>/g)];
    expect(containers.length >= 19).toBe(true);
    const filled = containers.filter((m) => !html.startsWith(`</${m[1]}>`, m.index + m[0].length));
    expect(filled.map((m) => `index.html:${lineOf(m.index)}`)).toEqual([]);
  });
});
