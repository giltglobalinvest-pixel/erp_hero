// test/e2e/rich-text.e2e.ts
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page, Route } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ROOT_DIR } from '../helpers/context.js';
import { startHarness, type Harness } from './harness.js';

// The rich-text helpers of index.html (sanitizeRichHtml, richTextToHtml, sanitizeRichTextValue, isRichText) and the
// boot guard that keeps the app closed without them. The helpers run in the served page; the login screen is enough.
// Harmless marker only: an image at a same-origin path that does not exist, whose error handler counts in a window
// variable. A handler that got through would set the counter once the output is in the live page.
const IMG = '/e2e-missing.png';
const MARK = `<img src="${IMG}" onerror="window.__rtHits=(window.__rtHits||0)+1">`;
const UNAVAILABLE =
  'Ein Teil der App konnte nicht geladen werden – bitte die Seite neu laden. Deine Anmeldung bleibt bestehen.';

// Real output of Quill 2.0.2, the version index.html loads from jsDelivr. Recorded once with a scratch probe (not in
// the repo) that ran dist/quill.js and dist/quill.snow.css from the npm package, configured as this app does it: snow
// theme, quillStandardToolbar(), registerQuillCustomSizes() (size as the style attributor, 5pt to 12pt). Toolbar
// formats were applied with quill.setText and then quill.formatText/formatLine, the calls the toolbar handlers make;
// "legacy-*" and "root-innerHTML-*" are what quill.root.innerHTML holds after the app loads such a stored value. Each
// string is quill.root.innerHTML, the value the app stores.
const QUILL_TOOLBAR: Record<string, string> = {
  'empty': '<p><br></p>',
  'setText': '<p>Zeile 1</p><p>Zeile 2</p>',
  'header1': '<h1>Titel</h1><p>Text</p>',
  'header2': '<h2>Titel</h2><p>Text</p>',
  'header3': '<h3>Titel</h3><p>Text</p>',
  'size-5pt': '<p><span style="font-size: 5pt;">Klein</span> gedruckt</p>',
  'size-6pt': '<p><span style="font-size: 6pt;">Klein</span> gedruckt</p>',
  'size-7pt': '<p><span style="font-size: 7pt;">Klein</span> gedruckt</p>',
  'size-8pt': '<p><span style="font-size: 8pt;">Klein</span> gedruckt</p>',
  'size-9pt': '<p><span style="font-size: 9pt;">Klein</span> gedruckt</p>',
  'size-10pt': '<p><span style="font-size: 10pt;">Klein</span> gedruckt</p>',
  'size-11pt': '<p><span style="font-size: 11pt;">Klein</span> gedruckt</p>',
  'size-12pt': '<p><span style="font-size: 12pt;">Klein</span> gedruckt</p>',
  'bold': '<p><strong>fett</strong> und normal</p>',
  'italic': '<p><em>kursiv</em> und normal</p>',
  'underline': '<p><u>unterstrichen</u></p>',
  'bold-italic-underline-size': '<p><strong style="font-size: 9pt;"><em><u>alles</u></em></strong> zusammen</p>',
  'list-ordered': '<ol><li data-list="ordered"><span class="ql-ui" contenteditable="false"></span>eins</li><li data-list="ordered"><span class="ql-ui" contenteditable="false"></span>zwei</li></ol>',
  'list-bullet': '<ol><li data-list="bullet"><span class="ql-ui" contenteditable="false"></span>eins</li><li data-list="bullet"><span class="ql-ui" contenteditable="false"></span>zwei</li></ol>',
  'list-nested': '<ol><li data-list="bullet"><span class="ql-ui" contenteditable="false"></span>eins</li><li data-list="bullet" class="ql-indent-1"><span class="ql-ui" contenteditable="false"></span>zwei</li><li data-list="bullet" class="ql-indent-2"><span class="ql-ui" contenteditable="false"></span>drei</li></ol>',
  'list-mixed': '<ol><li data-list="ordered"><span class="ql-ui" contenteditable="false"></span>eins</li><li data-list="bullet" class="ql-indent-1"><span class="ql-ui" contenteditable="false"></span>zwei</li></ol>',
  'align-center': '<p class="ql-align-center">Absatz</p>',
  'align-right': '<p class="ql-align-right">Absatz</p>',
  'align-justify': '<p class="ql-align-justify">Absatz</p>',
  'link': '<p><a href="https://example.test/seite" rel="noopener noreferrer" target="_blank">Webseite</a> ansehen</p>',
  'link-relative-typed': '<p><a href="www.example.test" rel="noopener noreferrer" target="_blank">Webseite</a></p>',
  'link-mailto': '<p><a href="mailto:info@example.test" rel="noopener noreferrer" target="_blank">Mail</a></p>',
  'link-tel': '<p><a href="tel:+49301234567" rel="noopener noreferrer" target="_blank">Anruf</a></p>',
  'clean': '<p>sauber</p>',
  'composite': '<p><strong>Sehr geehrte Damen und Herren,</strong></p><p><br></p><ol><li data-list="bullet"><span class="ql-ui" contenteditable="false"></span><span style="font-size: 9pt;">vielen Dank</span> für Ihre Anfrage.</li><li data-list="bullet"><span class="ql-ui" contenteditable="false"></span>Position A</li><li data-list="bullet" class="ql-align-right"><span class="ql-ui" contenteditable="false"></span>Position B</li></ol><p>Mit freundlichen Grüßen</p>',
  'legacy-root-innerHTML': '<p><br></p><p class="ql-align-center"><span class="ql-size-small">klein</span></p>',
  'legacy-root-innerHTML-ol': '<ol><li class="ql-indent-1"><span class="ql-ui" contenteditable="false"></span>eins</li></ol><p><span style="font-size: 9pt;">9</span></p>',
  'root-innerHTML-table': '<table><tbody><tr><td data-row="1">A</td></tr></tbody></table>',
  'legacy-ul (stored by an older editor)': '<ul><li>alt eins</li><li>alt zwei</li></ul><p>danach</p>',
  'legacy-ul (after Quill loaded it)': '<p><br></p><p>danach</p>',
};
// The same probe pasted other content with quill.clipboard.dangerouslyPasteHTML, because a paste keeps every format
// Quill registers, not only the toolbar's: colours, strike, sub/sup, code, quotes, images, fonts, direction, lists,
// links and tables. Each string is the resulting quill.root.innerHTML.
const QUILL_PASTE: Record<string, string> = {
  'color': '<p><span style="color: rgb(230, 0, 0);">rot</span> und <span style="color: rgb(0, 102, 204);">blau</span></p>',
  'background': '<p><span style="background-color: rgb(255, 255, 0);">gelb</span> <span style="background-color: rgb(255, 255, 0);">gelb2</span></p>',
  'color-class': '<p>rot gelb</p>',
  'strike': '<p><s>alt</s> <s>alt2</s> alt3</p>',
  'subsup': '<p>H<sub>2</sub>O und m<sup>2</sup></p>',
  'code-inline': '<p>Artikel <code>DS-6</code></p>',
  'code-block': '<div class="ql-code-block-container" spellcheck="false"><div class="ql-code-block" data-language="plain">Zeile 1</div><div class="ql-code-block" data-language="plain">Zeile 2</div></div>',
  'blockquote': '<blockquote>Zitat</blockquote>',
  'img-https': '<p><img src="https://example.test/bild.png"></p>',
  'img-attrs': '<p><img src="https://example.test/bild.png" alt="Logo" height="80" width="120"></p>',
  'img-data-png': '<p><img src="data:image/png;base64,iVBORw0KGgo="></p>',
  'img-data-jpeg': '<p><img src="data:image/jpeg;base64,/9j/4AAQ"></p>',
  'img-relative': '<p><img src="/files/logo.png"></p>',
  'img-other-scheme': '<p><img src="//:0"></p>',
  'font': '<p><span class="ql-font-serif">Serif</span> <span class="ql-font-monospace">Mono</span> <span class="ql-font-serif">S2</span></p>',
  'direction': '<p class="ql-direction-rtl">rtl</p><p class="ql-direction-rtl">rtl2</p><p class="ql-direction-rtl">rtl3</p>',
  'align': '<p class="ql-align-center">c</p><p class="ql-align-right">r</p><p class="ql-align-justify">j</p>',
  'list-nested-ol': '<ol><li data-list="ordered"><span class="ql-ui" contenteditable="false"></span>eins</li><li data-list="ordered" class="ql-indent-1"><span class="ql-ui" contenteditable="false"></span>zwei</li><li data-list="ordered"><span class="ql-ui" contenteditable="false"></span>drei</li></ol>',
  'list-nested-ul': '<ol><li data-list="bullet"><span class="ql-ui" contenteditable="false"></span>eins</li><li data-list="bullet" class="ql-indent-1"><span class="ql-ui" contenteditable="false"></span>zwei</li><li data-list="bullet" class="ql-indent-2"><span class="ql-ui" contenteditable="false"></span>drei</li></ol>',
  'list-checked': '<ol><li data-list="checked"><span class="ql-ui" contenteditable="false"></span>erledigt</li><li data-list="unchecked"><span class="ql-ui" contenteditable="false"></span>offen</li></ol>',
  'list-quill2': '<ol><li data-list="bullet"><span class="ql-ui" contenteditable="false"></span>a</li><li data-list="ordered"><span class="ql-ui" contenteditable="false"></span>b</li><li data-list="checked"><span class="ql-ui" contenteditable="false"></span>c</li><li data-list="unchecked"><span class="ql-ui" contenteditable="false"></span>d</li></ol>',
  'list-indent-class': '<ol><li data-list="bullet" class="ql-indent-2"><span class="ql-ui" contenteditable="false"></span>tief</li></ol>',
  'headers': '<h1>H1</h1><h2>H2</h2><h3>H3</h3><h4>H4</h4><h5>H5</h5><h6>H6</h6>',
  'link-target': '<p><a href="https://example.test/" rel="noopener noreferrer" target="_blank">t</a></p>',
  'size-style': '<p><span style="font-size: 9pt;">9pt</span> 18px <span style="font-size: 12pt;">12pt</span></p>',
  'size-class': '<p>gross klein</p>',
  'table': '<table><tbody><tr><td data-row="1">A1</td><td data-row="1">B1</td></tr><tr><td data-row="2">A2</td><td data-row="2">B2</td></tr></tbody></table>',
  'div': '<p>Zeile in div</p><p><strong>fett</strong> <em>kursiv</em> <u>unter</u></p>',
  'b-i-strong-em': '<p><strong>b</strong> <strong>strong</strong> <em>i</em> <em>em</em></p>',
  'style-bold': '<p><strong>fett</strong> <em>kursiv</em> <u>unter</u></p>',
  'br': '<p>Zeile 1</p><p>Zeile 2</p>',
  'empty-p': '<p>a</p><p><br></p><p>b</p>',
  'combined-styles': '<p><span style="background-color: rgb(255, 255, 0); font-size: 9pt; color: rgb(230, 0, 0);">bunt</span></p>',
  'span-class-other': '<p>tw</p>',
  'ql-ui': '<ol><li data-list="bullet"><span class="ql-ui" contenteditable="false"></span>x</li></ol>',
  'code-block-quill': '<div class="ql-code-block-container" spellcheck="false"><div class="ql-code-block" data-language="plain">a</div><div class="ql-code-block" data-language="plain">b</div></div>',
  'code-block-lang': '<div class="ql-code-block-container" spellcheck="false"><div class="ql-code-block" data-language="javascript">const x = 1;</div></div>',
  'table-th': '<table><tbody><tr><td data-row="1">KopfK2</td></tr><tr><td data-row="2"><span style="color: red;">A</span></td><td data-row="2">B</td></tr></tbody></table>',
  'table-quill': '<table><tbody><tr><td data-row="row-ab12">A</td><td data-row="row-ab12">B</td></tr></tbody></table>',
  'indent-p': '<p class="ql-indent-1">eingerueckt</p><p class="ql-direction-rtl ql-align-center ql-indent-3">alles</p>',
  'link-strong': '<p><strong><a href="https://example.test/" rel="noopener noreferrer" target="_blank">fett</a></strong><a href="https://example.test/" rel="noopener noreferrer" target="_blank"> </a><a href="https://example.test/" rel="noopener noreferrer" target="_blank" style="font-size: 9pt;">klein</a></p>',
  'img-in-link': '<p><a href="https://example.test/" rel="noopener noreferrer" target="_blank"><img src="https://example.test/b.png"></a></p>',
  'nested-inline': '<p><strong><em><s><u>x</u></s></em></strong> <sub><strong>y</strong></sub></p>',
  'color-names': '<p><span style="color: red;">r</span> <span style="color: transparent;">t</span> <span style="color: rgba(0, 0, 0, 0.5);">a</span> <span style="color: rgb(255, 0, 0);">h</span></p>',
  'bg-url': '<p><span style="background-color: initial;">u</span> u2</p>',
};
// Rich text that the app builds itself, and the markup the AI prompts ask for.
const APP_AND_PROMPTS: Record<string, string> = {
  // _aiBuildQuoteItemFields and onQiArticleChange: the article name as the title paragraph, then its description.
  'item description from an article': '<p>Drahtseil 6 mm</p><p>verzinkt</p><p><br></p><p>Länge 12 m</p>',
  // KI-Auftrag and KI-Angebot: paragraphs, line breaks inside a paragraph as <br>.
  'AI order or quote text': '<p>Vielen Dank für Ihre Anfrage.</p><p>Lieferung in KW 24.<br>Zahlbar in 14 Tagen.</p>',
  // The template generator: p, br, strong, em, u, ul, ol, li, h2, h3, with the template variables.
  'AI template': '<h2>Angebot {{angebot.nr}}</h2><p>{{kontakt.anrede}} {{kontakt.nachname}},</p><p>wir bieten an:</p><ul><li><strong>Position</strong> eins</li><li><em>Position</em> zwei</li></ul><ol><li><u>erstens</u></li></ol><h3>Hinweise</h3><p>Mit freundlichen Grüßen<br>{{firma.name}}</p>',
};
// Real Quill output that the sanitizer changes on purpose (fix report, "Allowlist decisions" and "Behaviour changes
// for legitimate content"): Quill's neutralized link target about:blank, http: and SVG image sources, the hljs-*
// class of a highlighted code token, and the video iframe.
const QUILL_CHANGED: Record<string, { in: string; out: string }> = {
  'toolbar link-other-scheme': {
    in: '<p><a href="about:blank" rel="noopener noreferrer" target="_blank">Datei</a></p>',
    out: '<p><a rel="noopener noreferrer" target="_blank">Datei</a></p>',
  },
  'paste links': { in: '<p><a href="https://example.test/" rel="noopener noreferrer" target="_blank">https</a> <a href="http://example.test/" rel="noopener noreferrer" target="_blank">http</a> <a href="mailto:info@example.test" rel="noopener noreferrer" target="_blank">mail</a> <a href="tel:+4930123" rel="noopener noreferrer" target="_blank">tel</a> <a href="sms:+4930123" rel="noopener noreferrer" target="_blank">sms</a> <a href="/files/x.pdf" rel="noopener noreferrer" target="_blank">rel</a> <a href="#oben" rel="noopener noreferrer" target="_blank">frag</a> <a href="about:blank" rel="noopener noreferrer" target="_blank">ftp</a></p>', out: '<p><a href="https://example.test/" rel="noopener noreferrer" target="_blank">https</a> <a href="http://example.test/" rel="noopener noreferrer" target="_blank">http</a> <a href="mailto:info@example.test" rel="noopener noreferrer" target="_blank">mail</a> <a href="tel:+4930123" rel="noopener noreferrer" target="_blank">tel</a> <a href="sms:+4930123" rel="noopener noreferrer" target="_blank">sms</a> <a href="/files/x.pdf" rel="noopener noreferrer" target="_blank">rel</a> <a href="#oben" rel="noopener noreferrer" target="_blank">frag</a> <a rel="noopener noreferrer" target="_blank">ftp</a></p>' },
  'paste img-http': { in: '<p><img src="http://example.test/bild.png"></p>', out: '<p><img></p>' },
  'paste img-data-svg': { in: '<p><img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="></p>', out: '<p><img></p>' },
  'paste code-block-token': {
    in: '<div class="ql-code-block-container" spellcheck="false"><div class="ql-code-block" data-language="javascript"><span class="ql-token hljs-true">const x</span></div></div>',
    out: '<div class="ql-code-block-container" spellcheck="false"><div class="ql-code-block" data-language="javascript"><span class="ql-token">const x</span></div></div>',
  },
  'paste video': {
    in: '<iframe class="ql-video" frameborder="0" allowfullscreen="true" src="https://example.test/video"></iframe>',
    out: '',
  },
  'toolbar root-innerHTML-iframe': {
    in: '<iframe class="ql-video" src="https://example.test/v"></iframe><p>x</p>',
    out: '<p>x</p>',
  },
};
// Markup no browser serialized (typed by hand, from older records or an AI answer): the sanitizer returns what the
// browser makes of it, the innerHTML of an inert <div>. Only that normalization differs from the input.
const NOT_SERIALIZED = [
  '<P>Gross<BR>geschrieben</P>',
  '<p>Zeile 1<br/>Zeile 2</p>',
  "<p class='ql-align-center'>einfache Anführungszeichen</p>",
  '<p>&quot;Zitat&quot; &#39;einfach&#39; &amp; Größer &gt; kleiner</p>',
  '<p>a < b und c > d</p>',
  '<ul><li>offen<li>auch offen</ul>',
  '<p>offener Absatz<p>zweiter',
  '<table><tr><td data-row="1">ohne tbody</td></tr></table>',
  '<p><strong>fett <em>verschachtelt</strong> weiter</em></p>',
  '<p>Leer\u00a0zeichen</p>',
];

// Page-side helpers for h.run():
// - inert(html): a <div> of a document without a browsing context, filled with html. Nothing in it loads or runs.
// - problems(root): every node, element or attribute in root that the allowlist does not permit. It checks the
//   allowlist independently of the sanitizer's own code; URL schemes go through the browser's URL parser.
const PAGE_LIB = String.raw`
  const inert = (html) => {
    const div = document.implementation.createHTMLDocument('').createElement('div');
    div.innerHTML = html;
    return div;
  };
  const TAGS = new Set(['p', 'br', 'strong', 'em', 'b', 'i', 'u', 's', 'strike', 'sub', 'sup', 'code', 'pre',
    'blockquote', 'ol', 'ul', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'span', 'div', 'img', 'table', 'tbody',
    'tr', 'td']);
  const ATTRS = { a: ['href', 'target', 'rel'], img: ['src', 'alt', 'width', 'height'], li: ['data-list'],
    span: ['contenteditable'], div: ['spellcheck', 'data-language'], td: ['data-row'] };
  const DECLS = new Set(['color', 'background-color', 'font-size', 'text-align']);
  const scheme = (url) => { try { return new URL(url, 'https://base.invalid/').protocol; } catch (_) { return ''; } };
  const problems = (root) => {
    const out = [];
    const walk = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (n.nodeType === Node.COMMENT_NODE) { out.push('comment'); continue; }
      const tag = n.localName;
      if (n.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !TAGS.has(tag)) out.push('<' + tag + '>');
      for (const { name, value } of Array.from(n.attributes)) {
        if (name !== 'class' && name !== 'style' && !(ATTRS[tag] || []).includes(name)) out.push(tag + '[' + name + ']');
        if (name === 'class' && !value.split(/\s+/).filter(Boolean).every((t) => /^ql-[a-z0-9-]+$/.test(t))) {
          out.push(tag + '[class="' + value + '"]');
        }
        if (name === 'style' && !value.split(';').map((d) => d.trim()).filter(Boolean)
          .every((d) => DECLS.has(d.split(':')[0].trim().toLowerCase()) && !/url\(|!important|\\/i.test(d))) {
          out.push(tag + '[style="' + value + '"]');
        }
        if (name === 'href' && !['https:', 'http:', 'mailto:', 'tel:', 'sms:', ''].includes(scheme(value))) {
          out.push('a[href="' + value + '"]');
        }
        if (name === 'src' && !['https:', ''].includes(scheme(value))
          && !/^data:image\/(png|gif|jpeg|webp);base64,/i.test(value)) out.push('img[src="' + value + '"]');
        if (name === 'target' && value !== '_blank') out.push('a[target="' + value + '"]');
        if (name === 'contenteditable' && value !== 'false') out.push('span[contenteditable="' + value + '"]');
        if (name === 'spellcheck' && value !== 'false') out.push('div[spellcheck="' + value + '"]');
      }
      if (tag === 'a' && n.getAttribute('target') === '_blank' && n.getAttribute('rel') !== 'noopener noreferrer') {
        out.push('a[target=_blank] without rel');
      }
    }
    return out;
  };
`;

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.resetContexts();
});
afterAll(async () => {
  await h?.close();
});

// The login screen of the served page, which has the helpers. Counts the requests for the missing image by URL.
async function loginScreen(): Promise<{ page: Page; imageLoads: string[] }> {
  const page = await h.newPage();
  const imageLoads: string[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.pathname === IMG) imageLoads.push(url.pathname + url.search);
  });
  await h.openApp(page);
  return { page, imageLoads };
}

// Puts html into the live page, where images load and handlers run, after a control image whose handler must run.
// Waits until the control has run and every image has settled, then gives any handler left in html one bounded
// chance to run (an image's error event comes in a task after the image is complete). Returns the counter.
async function liveHits(page: Page, html: string): Promise<number | null> {
  await h.run(page, `
    const box = document.createElement('div');
    box.id = 'rtLive';
    document.body.appendChild(box);
    box.innerHTML = '<img src="${IMG}?control" onerror="window.__rtControl=(window.__rtControl||0)+1">' + ${JSON.stringify(html)};
  `);
  await page.waitForFunction(
    () =>
      (window as unknown as { __rtControl?: number }).__rtControl === 1 &&
      Array.from(document.querySelectorAll<HTMLImageElement>('#rtLive img')).every((img) => img.complete),
    undefined,
    { timeout: 15_000 },
  );
  await page
    .waitForFunction(() => (window as unknown as { __rtHits?: number }).__rtHits !== undefined, undefined, { timeout: 500 })
    .catch(() => undefined);
  return h.run<number | null>(page, 'return window.__rtHits ?? null;');
}

describe('sanitizeRichHtml keeps legitimate content byte-identical', () => {
  it('real Quill 2.0.2 output, the texts the app builds and the markup the AI prompts ask for', async () => {
    const { page } = await loginScreen();
    const all: Record<string, string> = {};
    for (const [group, items] of Object.entries({ toolbar: QUILL_TOOLBAR, paste: QUILL_PASTE, app: APP_AND_PROMPTS })) {
      for (const [name, html] of Object.entries(items)) all[`${group} ${name}`] = html;
    }
    const out = await h.run<Record<string, string>>(
      page,
      `return Object.fromEntries(Object.entries(${JSON.stringify(all)}).map(([k, v]) => [k, sanitizeRichHtml(v)]));`,
    );
    expect(out).toEqual(all);
    await h.assertClean(page);
  });

  it('changes real Quill output only where the allowlist decisions say so', async () => {
    const { page } = await loginScreen();
    const out = await h.run<Record<string, string>>(
      page,
      `return Object.fromEntries(Object.entries(${JSON.stringify(QUILL_CHANGED)}).map(([k, v]) => [k, sanitizeRichHtml(v.in)]));`,
    );
    expect(out).toEqual(Object.fromEntries(Object.entries(QUILL_CHANGED).map(([k, v]) => [k, v.out])));
    await h.assertClean(page);
  });

  it('returns markup that no browser serialized as its inert round trip', async () => {
    const { page } = await loginScreen();
    const out = await h.run<{ input: string; got: string; roundTrip: string }[]>(
      page,
      `${PAGE_LIB}
      return ${JSON.stringify(NOT_SERIALIZED)}.map((input) => ({ input, got: sanitizeRichHtml(input), roundTrip: inert(input).innerHTML }));`,
    );
    for (const o of out) {
      // Each sample really is changed by the browser's own serialization, and by nothing else.
      expect(o.roundTrip, o.input).not.toBe(o.input);
      expect(o.got, o.input).toBe(o.roundTrip);
    }
    await h.assertClean(page);
  });
});

interface Rejected {
  html: string;
  // DOM queries that must find nothing in an inert parse of the output.
  gone: string[];
  // Text that must still be there.
  text: string[];
}
// One sample per class of markup the allowlist rejects. Each one carries the marker; a data-e2e attribute marks
// elements whose attributes must go.
const REJECTED: Record<string, Rejected> = {
  'event-handler attributes': {
    html: `<p data-e2e="h" onclick="window.__rtHits=(window.__rtHits||0)+1" onmouseover="window.__rtHits=(window.__rtHits||0)+1">Absatz mit Handlern</p>${MARK}`,
    gone: ['[onclick]', '[onmouseover]', '[onerror]', '[data-e2e]'],
    text: ['Absatz mit Handlern'],
  },
  'URL schemes outside the lists, in href and src': {
    html: `<p><a href="javascript:void(0)">Skript-Link</a> <a href="data:text/html,Seite">Daten-Link</a> <a href="vbscript:x">VB-Link</a> <a href="ftp://example.test/">FTP-Link</a> <a href="file:///tmp/a">Datei-Link</a></p><p><img src="http://example.test/b.png" alt="http"><img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" alt="svg"><img src="blob:https://example.test/x" alt="blob"><img src="javascript:void(0)" alt="skript">Bilder</p>${MARK}`,
    gone: ['a[href]', 'img[src^="http:"]', 'img[src^="data:"]', 'img[src^="blob:"]', 'img[src^="javascript:"]'],
    text: ['Skript-Link', 'Daten-Link', 'VB-Link', 'FTP-Link', 'Datei-Link', 'Bilder'],
  },
  'frames and embedded objects': {
    html: `<p>Vor dem Rahmen</p><iframe src="${IMG}?frame"></iframe><object data="${IMG}?object"><p>Ersatztext</p></object><embed src="${IMG}?embed"><p>Nach dem Rahmen</p>${MARK}`,
    gone: ['iframe', 'object', 'embed'],
    text: ['Vor dem Rahmen', 'Ersatztext', 'Nach dem Rahmen'],
  },
  'forms and form controls': {
    html: `<form action="/e2e-form" method="post"><p>Formulartext</p><input name="feld" value="Eingabe"><textarea>Langer Text</textarea><select><option>Auswahl</option></select><button formaction="/e2e-form">Absenden</button></form>${MARK}`,
    gone: ['form', 'input', 'textarea', 'select', 'option', 'button'],
    text: ['Formulartext', 'Langer Text', 'Auswahl', 'Absenden'],
  },
  'style elements, and declarations that load or position': {
    html: `<p>Vorher</p><style>p { display: none; }</style><p style="position: fixed; top: 0; left: 0; z-index: 9999; color: rgb(230, 0, 0);">Rote Schrift</p><p style="background-image: url(${IMG}?css); background: url(${IMG}?css);">Hintergrund</p><p style="color: red !important;">Wichtig</p>${MARK}`,
    gone: ['style', '[style*="url("]', '[style*="position"]', '[style*="z-index"]', '[style*="important"]'],
    text: ['Vorher', 'Rote Schrift', 'Hintergrund', 'Wichtig'],
  },
  'classes that do not start with ql-': {
    html: `<p class="hidden ql-align-center">Mittig</p><p class="fixed inset-0 z-50">Vollbild</p><span class="ql-size-small text-red-600">Klein</span>${MARK}`,
    gone: ['.hidden', '.fixed', '.inset-0', '.z-50', '.text-red-600'],
    text: ['Mittig', 'Vollbild', 'Klein'],
  },
  'id and name': {
    html: `<p id="e2eRtId">Mit Id</p><a name="e2eRtName">Mit Name</a><img id="e2eRtImg" name="e2eRtImg" src="${IMG}" alt="Bild">${MARK}`,
    gone: ['[id]', '[name]'],
    text: ['Mit Id', 'Mit Name'],
  },
  'SVG and MathML': {
    html: `<p>Vor der Grafik</p><svg><image href="${IMG}?svg"></image><text>Grafiktext</text></svg><math><mi>x</mi></math><p>Nach der Grafik</p>${MARK}`,
    gone: ['svg', 'image', 'math', 'mi'],
    text: ['Vor der Grafik', 'Nach der Grafik'],
  },
  comments: {
    html: `<p>Vor<!-- Notiz -->Nach</p><!-- ${MARK} -->${MARK}`,
    gone: [],
    text: ['VorNach'],
  },
  'malformed nesting': {
    html: `<p><strong>fett<em>kursiv</p><li>lose</li></strong><div><p>innen</div><ul><p>in der Liste</p></ul><table><td>Zelle</td>${MARK}</table><p>Ende`,
    gone: [],
    text: ['fett', 'kursiv', 'lose', 'innen', 'in der Liste', 'Zelle', 'Ende'],
  },
};

describe('sanitizeRichHtml rejects what the allowlist does not name', () => {
  for (const [name, sample] of Object.entries(REJECTED)) {
    it(name, async () => {
      const { page, imageLoads } = await loginScreen();
      const out = await h.run<{ html: string; found: string[]; problems: string[]; text: string; again: string; reparsed: string }>(
        page,
        `${PAGE_LIB}
        const html = sanitizeRichHtml(${JSON.stringify(sample.html)});
        const root = inert(html);
        return {
          html,
          found: ${JSON.stringify(sample.gone)}.filter((sel) => root.querySelector(sel) !== null),
          problems: problems(root),
          text: root.textContent,
          again: sanitizeRichHtml(html),
          reparsed: root.innerHTML,
        };`,
      );
      // An inert parse of the output holds none of the rejected features, and nothing else the allowlist lacks.
      expect(out.found).toEqual([]);
      expect(out.problems).toEqual([]);
      // The text stays.
      for (const t of sample.text) expect(out.text, t).toContain(t);
      // The output is stable: sanitizing it again or reparsing it changes nothing.
      expect(out.again).toBe(out.html);
      expect(out.reparsed).toBe(out.html);
      // In the live page, no handler runs and nothing but the marker's own image loads.
      expect(await liveHits(page, out.html)).toBe(null);
      expect(imageLoads.filter((u) => u !== IMG && u !== `${IMG}?control`)).toEqual([]);
      await h.assertClean(page);
    });
  }
});

describe('the attribute rules', () => {
  const RULES: Record<string, string> = {
    // class: Quill's ql- tokens only; kept byte for byte when all pass, rebuilt when some pass, dropped when none.
    '<p class="ql-align-center ql-indent-1">a</p>': '<p class="ql-align-center ql-indent-1">a</p>',
    '<p class="ql-align-center  ql-indent-1">a</p>': '<p class="ql-align-center  ql-indent-1">a</p>',
    '<p class="text-red-600 ql-align-center">a</p>': '<p class="ql-align-center">a</p>',
    '<p class="text-red-600 hidden">a</p>': '<p>a</p>',
    // style: color, background-color, font-size and text-align with strict values; the same keep/rebuild/drop rule.
    '<span style="color: rgb(230, 0, 0); font-size: 9pt;">a</span>': '<span style="color: rgb(230, 0, 0); font-size: 9pt;">a</span>',
    '<span style="color:red;font-size:9pt">a</span>': '<span style="color:red;font-size:9pt">a</span>',
    '<span style="color: #0066cc; background-color: #ffff0080">a</span>': '<span style="color: #0066cc; background-color: #ffff0080">a</span>',
    '<p style="text-align: justify;">a</p>': '<p style="text-align: justify;">a</p>',
    '<span style="color: red; position: absolute; font-size: 9pt">a</span>': '<span style="color: red; font-size: 9pt;">a</span>',
    '<span style="font-size: 12pt; font-family: serif">a</span>': '<span style="font-size: 12pt;">a</span>',
    '<span style="color: var(--brand); text-align: center">a</span>': '<span style="text-align: center;">a</span>',
    '<span style="position: fixed; top: 0">a</span>': '<span>a</span>',
    '<span style="color: red !important">a</span>': '<span>a</span>',
    '<span style="background-color: url(/e2e-missing.png)">a</span>': '<span>a</span>',
    '<span style="font-size: large">a</span>': '<span>a</span>',
    // href: http, https, mailto, tel, sms, or no scheme (relative, fragment, a typed www. address).
    '<a href="https://example.test/a">a</a>': '<a href="https://example.test/a">a</a>',
    '<a href="http://example.test/a">a</a>': '<a href="http://example.test/a">a</a>',
    '<a href="mailto:info@example.test">a</a>': '<a href="mailto:info@example.test">a</a>',
    '<a href="tel:+4930123">a</a>': '<a href="tel:+4930123">a</a>',
    '<a href="sms:+4930123">a</a>': '<a href="sms:+4930123">a</a>',
    '<a href="/files/a.pdf">a</a>': '<a href="/files/a.pdf">a</a>',
    '<a href="#oben">a</a>': '<a href="#oben">a</a>',
    '<a href="www.example.test">a</a>': '<a href="www.example.test">a</a>',
    '<a href="?seite=2">a</a>': '<a href="?seite=2">a</a>',
    '<a href="javascript:void(0)">a</a>': '<a>a</a>',
    '<a href=" JavaScript:void(0)">a</a>': '<a>a</a>',
    '<a href="f&#10;tp://example.test/">a</a>': '<a>a</a>',
    '<a href="data:text/html,Hallo">a</a>': '<a>a</a>',
    '<a href="vbscript:x">a</a>': '<a>a</a>',
    '<a href="ftp://example.test/">a</a>': '<a>a</a>',
    '<a href="file:///tmp/a">a</a>': '<a>a</a>',
    '<a href="about:blank">a</a>': '<a>a</a>',
    '<a href="blob:https://example.test/x">a</a>': '<a>a</a>',
    // src: https, no scheme, or a base64 PNG, GIF, JPEG or WebP.
    '<img src="https://example.test/b.png">': '<img src="https://example.test/b.png">',
    '<img src="/files/b.png">': '<img src="/files/b.png">',
    '<img src="//:0">': '<img src="//:0">',
    '<img src="data:image/png;base64,iVBORw0KGgo=">': '<img src="data:image/png;base64,iVBORw0KGgo=">',
    '<img src="data:image/gif;base64,R0lGODlh">': '<img src="data:image/gif;base64,R0lGODlh">',
    '<img src="data:image/jpeg;base64,/9j/4AAQ">': '<img src="data:image/jpeg;base64,/9j/4AAQ">',
    '<img src="data:image/webp;base64,UklGRg==">': '<img src="data:image/webp;base64,UklGRg==">',
    '<img src="http://example.test/b.png">': '<img>',
    '<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">': '<img>',
    '<img src="data:image/png,rohdaten">': '<img>',
    '<img src="data:text/html;base64,SGFsbG8=">': '<img>',
    '<img src="blob:https://example.test/x">': '<img>',
    '<img src="javascript:void(0)">': '<img>',
    '<img src="ftp://example.test/b.png">': '<img>',
    // alt, width and height: free text, and numbers with px or %.
    '<img src="/files/a.png" alt="Logo &quot;Muster&quot;" width="120" height="80">': '<img src="/files/a.png" alt="Logo &quot;Muster&quot;" width="120" height="80">',
    '<img src="/files/a.png" width="50%" height="80px">': '<img src="/files/a.png" width="50%" height="80px">',
    '<img src="/files/a.png" width="calc(100vw)">': '<img src="/files/a.png">',
    // target only as _blank, which always gets rel="noopener noreferrer".
    '<a href="https://example.test/" rel="noopener noreferrer" target="_blank">a</a>': '<a href="https://example.test/" rel="noopener noreferrer" target="_blank">a</a>',
    '<a href="https://example.test/" target="_blank">a</a>': '<a href="https://example.test/" target="_blank" rel="noopener noreferrer">a</a>',
    '<a href="https://example.test/" target="_blank" rel="opener">a</a>': '<a href="https://example.test/" target="_blank" rel="noopener noreferrer">a</a>',
    '<a href="https://example.test/" target="_self">a</a>': '<a href="https://example.test/">a</a>',
    '<a href="https://example.test/" target="_top" rel="noopener">a</a>': '<a href="https://example.test/" rel="noopener">a</a>',
    // data-list on li with Quill's values; no other data- attribute.
    '<ol><li data-list="checked">a</li></ol>': '<ol><li data-list="checked">a</li></ol>',
    '<ol><li data-list="unchecked">a</li></ol>': '<ol><li data-list="unchecked">a</li></ol>',
    '<ol><li data-list="neu">a</li></ol>': '<ol><li>a</li></ol>',
    '<p data-list="bullet">a</p>': '<p>a</p>',
    '<p data-e2e="1">a</p>': '<p>a</p>',
    // contenteditable only as false on span (Quill's list marker), spellcheck only as false on div.
    '<span class="ql-ui" contenteditable="false"></span>': '<span class="ql-ui" contenteditable="false"></span>',
    '<span contenteditable="true">a</span>': '<span>a</span>',
    '<p contenteditable="false">a</p>': '<p>a</p>',
    '<div spellcheck="false">a</div>': '<div spellcheck="false">a</div>',
    '<div spellcheck="true">a</div>': '<div>a</div>',
    '<p spellcheck="false">a</p>': '<p>a</p>',
    // data-row on td and data-language on div, as Quill's table and code block write them.
    '<table><tbody><tr><td data-row="row-ab12">a</td></tr></tbody></table>': '<table><tbody><tr><td data-row="row-ab12">a</td></tr></tbody></table>',
    '<table><tbody><tr><td data-row="1 2">a</td></tr></tbody></table>': '<table><tbody><tr><td>a</td></tr></tbody></table>',
    '<div class="ql-code-block" data-language="c++">a</div>': '<div class="ql-code-block" data-language="c++">a</div>',
    '<div data-language="a b">a</div>': '<div>a</div>',
    '<p data-language="plain">a</p>': '<p>a</p>',
  };

  it('class, style, href, src, target and rel, data-list, contenteditable and the other Quill attributes', async () => {
    const { page } = await loginScreen();
    const out = await h.run<Record<string, string>>(
      page,
      `return Object.fromEntries(${JSON.stringify(Object.keys(RULES))}.map((k) => [k, sanitizeRichHtml(k)]));`,
    );
    expect(out).toEqual(RULES);
    await h.assertClean(page);
  });

  it('images: false removes every image and keeps the rest', async () => {
    const { page } = await loginScreen();
    const html =
      '<p>Text <img src="/files/a.png" alt="A"> weiter</p><p><a href="https://example.test/" rel="noopener noreferrer" target="_blank"><img src="https://example.test/b.png"></a></p><ol><li data-list="bullet"><span class="ql-ui" contenteditable="false"></span>Punkt <img src="data:image/png;base64,iVBORw0KGgo="></li></ol>';
    const out = await h.run<{ withImages: string; without: string; viaRichText: string }>(
      page,
      `const html = ${JSON.stringify(html)};
      return { withImages: sanitizeRichHtml(html), without: sanitizeRichHtml(html, { images: false }), viaRichText: richTextToHtml(html, { images: false }) };`,
    );
    const without =
      '<p>Text  weiter</p><p><a href="https://example.test/" rel="noopener noreferrer" target="_blank"></a></p><ol><li data-list="bullet"><span class="ql-ui" contenteditable="false"></span>Punkt </li></ol>';
    expect(out).toEqual({ withImages: html, without, viaRichText: without });
    await h.assertClean(page);
  });
});

describe('richTextToHtml, sanitizeRichTextValue and isRichText', () => {
  it('show plain text escaped as before, sanitize rich text, and keep plain text plain for saves', async () => {
    const { page } = await loginScreen();
    const out = await h.run<Record<string, unknown>>(
      page,
      `const MARK = ${JSON.stringify(MARK)};
      return {
        empty: [richTextToHtml(''), richTextToHtml(null), richTextToHtml(undefined)],
        plain: richTextToHtml('Preis < 5 € & "netto"\\nzweite Zeile'),
        rich: richTextToHtml('<p>Hallo</p>' + MARK),
        richWithoutImages: richTextToHtml('<p>Hallo</p>' + MARK, { images: false }),
        savePlain: sanitizeRichTextValue('Preis < 5 € <img src=x>'),
        saveRich: sanitizeRichTextValue('<p>Hallo</p>' + MARK),
        saveRichWithoutImages: sanitizeRichTextValue('<p>Hallo</p>' + MARK, { images: false }),
        isRich: ['<p>x</p>', 'a<BR>b', 'a <b>b</b>', '<span>', '<div class="x">', '<h3>', '<ul>',
          'a < b', '<table><tr><td>x', '<img src=x>', '<pre>', '', null].map(isRichText),
        ready: richTextSanitizerReady(),
        // The hooks sit on the app's own instance: the global DOMPurify still keeps any class.
        globalUntouched: window.DOMPurify.sanitize('<p class="eigene">x</p>'),
      };`,
    );
    expect(out).toEqual({
      empty: ['', '', ''],
      plain: 'Preis &lt; 5 € &amp; &quot;netto&quot;<br>zweite Zeile',
      rich: `<p>Hallo</p><img src="${IMG}">`,
      richWithoutImages: '<p>Hallo</p>',
      savePlain: 'Preis < 5 € <img src=x>',
      saveRich: `<p>Hallo</p><img src="${IMG}">`,
      saveRichWithoutImages: '<p>Hallo</p>',
      isRich: [true, true, true, true, true, true, true, false, false, false, false, false, false],
      ready: true,
      globalUntouched: '<p class="eigene">x</p>',
    });
    expect(await page.locator('#loginError').isVisible()).toBe(false);
    await h.assertClean(page);
  });
});

describe('without the sanitizer the app stays closed', () => {
  // Boots the page with a session cookie while the route breaks vendor/purify.min.js. Without the guard, the
  // auto-login would open the app. Records the page's own calls to /api/me and /api/auth.
  async function bootWithout(serve: (route: Route) => Promise<void>): Promise<{ page: Page; calls: string[] }> {
    const page = await h.newPage();
    const calls: string[] = [];
    page.on('request', (r) => {
      const p = new URL(r.url()).pathname;
      if (p === '/api/me' || p === '/api/auth') calls.push(p);
    });
    await page.route('**/vendor/purify.min.js', serve);
    await h.openApp(page, 'admin');
    return { page, calls };
  }

  async function expectClosed(page: Page, calls: string[]): Promise<void> {
    expect(await page.locator('#loginScreen').isVisible()).toBe(true);
    expect(await page.locator('#appShell').isVisible()).toBe(false);
    expect(await page.locator('#loginError').textContent()).toBe(UNAVAILABLE);
    expect(await h.run(page, 'return [typeof window.DOMPurify, richTextSanitizerReady()];')).toEqual(['undefined', false]);

    // A login with a valid key is refused with the same message, and the server is not asked.
    await h.run(page, 'clearLoginError(); document.getElementById("loginError").textContent = "";');
    await page.locator('#loginKey').fill(h.users.admin.key);
    await page.locator('#loginBtn').click();
    await expect.poll(() => page.locator('#loginError').textContent()).toBe(UNAVAILABLE);
    const asked = await page
      .waitForRequest((r) => new URL(r.url()).pathname === '/api/auth', { timeout: 500 })
      .then(() => true, () => false);
    expect(asked).toBe(false);
    expect(calls).toEqual([]);
    expect(await page.locator('#appShell').isVisible()).toBe(false);

    // The helpers' own fallback: the text only, escaped, so their output creates no element.
    const out = await h.run<{ results: string[]; elements: number[] }>(
      page,
      `${PAGE_LIB}
      const input = ${JSON.stringify(`${MARK}<p><strong>Fett</strong> &lt;b&gt;kein Tag&lt;/b&gt;</p>`)};
      const results = [sanitizeRichHtml(input), sanitizeRichHtml(input, { images: false }), richTextToHtml(input), sanitizeRichTextValue(input)];
      return { results, elements: results.map((r) => inert(r).querySelectorAll('*').length) };`,
    );
    const text = 'Fett &lt;b&gt;kein Tag&lt;/b&gt;';
    expect(out).toEqual({ results: [text, text, text, text], elements: [0, 0, 0, 0] });
    expect(await liveHits(page, out.results.join(''))).toBe(null);
    await h.assertClean(page);
  }

  it('when vendor/purify.min.js does not load', async () => {
    const { page, calls } = await bootWithout((route) => route.abort());
    await expectClosed(page, calls);
  });

  it('when vendor/purify.min.js has other bytes than the integrity pin', async () => {
    const original = await readFile(path.join(ROOT_DIR, 'vendor', 'purify.min.js'));
    const { page, calls } = await bootWithout((route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/javascript; charset=utf-8',
        body: Buffer.concat([original, Buffer.from('\n// verändert\n')]),
      }),
    );
    await expectClosed(page, calls);
  });
});
