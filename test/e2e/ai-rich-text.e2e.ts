// test/e2e/ai-rich-text.e2e.ts
import type { Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { TableName } from '../../server/data/tables.js';
import { jsonResponse } from '../helpers/fakeFetch.js';
import { startHarness, type Harness } from './harness.js';

// Rich text in a model answer, through the assistants that show it or save it: KI-Auftrag and KI-Angebot (started
// from the ticket card), the ERP-Assistent, KI-Artikel and the Anfrage-Assistent. The fake model puts real formatting
// (bold, a 9pt size, a Quill bullet list) and a harmless marker into every field that the app shows as HTML or saves
// into a rich-text field: an image at a same-origin path that does not exist, whose error handler counts in a window
// variable. The counter must stay unset through the assistant's start, its preview and the record it opens; the
// preview must keep the formatting; the records it creates, read back through the API, must hold the sanitized value,
// with the formatting and without any image.
const FD = 'https://flptest.freshdesk.com/api/v2/';
const AI = 'https://api.anthropic.com/v1/messages';
const IMG = '/e2e-missing.png';
const MARK = `<img src="${IMG}" onerror="window.__aiHits=(window.__aiHits||0)+1">`;
const rich = (label: string): string =>
  `<p><strong>${label} fett</strong> und <span style="font-size: 9pt;">${label} klein</span></p>` +
  `<ol><li data-list="bullet"><span class="ql-ui" contenteditable="false"></span>${label} Punkt</li></ol>${MARK}`;

const REQUESTER = { id: 5001, name: 'Kunde Muster', email: 'kunde@example.test' };
const TICKET = { id: 7301, subject: 'Bestellung Drahtseil', description_html: '<p>Bitte zwei Drahtseile, Lieferung KW 24.</p>' };
const CARD = `.swipe-card-wrap[data-ticket-id="${TICKET.id}"]`;
const listEntry = () => ({
  id: TICKET.id,
  subject: TICKET.subject,
  status: 2,
  priority: 1,
  type: null,
  requester_id: REQUESTER.id,
  responder_id: null,
  created_at: '2026-09-29T09:00:00Z',
  updated_at: '2026-09-29T09:05:00Z',
});

type Fields = Record<string, unknown>;
let h: Harness;
let customerId = '';
// The text of the fake model's next answer; each test sets it before the assistant asks.
let answer = '';

beforeAll(async () => {
  h = await startHarness();
  const insert = (table: TableName, fields: Fields) => h.deps.db.write((tx) => h.deps.records.insert(tx, table, fields));
  await h.apiAs('admin', 'PUT', '/api/settings/freshdeskSalesGroupId', { value: '42' });
  await h.apiAs('admin', 'PUT', '/api/settings/freshdeskOrderGroupId', { value: '43' });
  const customer = await insert('Customer', {
    company_id: [h.companies.alpha],
    name1: 'Seilerei Nord',
    customer_no: 'K-2001',
    status: 'aktiv',
    email: REQUESTER.email,
  });
  customerId = customer.id;
  await insert('Contact', { customer_id: [customer.id], first_name: 'Kunde', last_name: 'Muster', email: REQUESTER.email });
  await insert('Article', {
    company_id: [h.companies.alpha],
    name1: 'Drahtseil 6 mm',
    article_no: 'DS-6',
    status: 'aktiv',
    sales_price: 12,
  });

  h.fake.on('GET', `${FD}search/tickets?`, () => jsonResponse({ total: 1, results: [listEntry()] }));
  h.fake.on('GET', `${FD}agents`, () => jsonResponse([]));
  h.fake.on('GET', `${FD}contacts/${REQUESTER.id}/tickets`, () => jsonResponse([]));
  h.fake.on('GET', `${FD}contacts/${REQUESTER.id}`, () => jsonResponse({ ...REQUESTER, company_id: null }));
  h.fake.on('GET', `${FD}tickets/${TICKET.id}?`, () =>
    jsonResponse({
      ...listEntry(),
      requester: REQUESTER,
      tags: [],
      custom_fields: {},
      attachments: [],
      description_html: TICKET.description_html,
    }),
  );
  h.fake.on('GET', `${FD}tickets/${TICKET.id}/conversations`, () => jsonResponse([]));
  h.fake.on('PUT', `${FD}tickets/`, () => jsonResponse({ ok: true }));
  h.fake.on('POST', `${FD}tickets/${TICKET.id}/notes`, () => jsonResponse({ id: 1 }, 201));
  h.fake.on('POST', AI, () =>
    jsonResponse({
      id: 'msg_e2e',
      model: 'claude-sonnet-4-5-20250929',
      content: [{ type: 'text', text: answer }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
  );
});
afterEach(async () => {
  await h.resetContexts();
});
afterAll(async () => {
  await h?.close();
});

const count = (method: string, url: string) => h.fake.calls.filter((c) => c.method === method && c.url === url).length;

// The admin's page, wide enough for the live previews of the documents the assistants open.
async function adminPage(): Promise<Page> {
  const page = await h.newPage();
  await page.setViewportSize({ width: 1440, height: 2400 });
  page.on('dialog', (dialog) => {
    void dialog.accept();
  });
  await h.openApp(page, 'admin');
  return page;
}

// Opens the ticket list and waits until the ticket's card has scanned its notes and found its customer, so its
// AI button is enabled.
async function openTicketList(page: Page, route: 'anfragen' | 'kundenbestellungen'): Promise<void> {
  const scans = count('GET', `${FD}tickets/${TICKET.id}/conversations`);
  await h.run(page, `dispatchRoute(${JSON.stringify(route)});`);
  await page.locator(CARD).waitFor({ timeout: 15_000 });
  await expect
    .poll(() => count('GET', `${FD}tickets/${TICKET.id}/conversations`), { timeout: 15_000 })
    .toBeGreaterThan(scans);
  await page.waitForFunction(
    (card) => (document.querySelector(card) as HTMLElement | null)?.dataset.erpState === 'green',
    CARD,
    { timeout: 15_000 },
  );
}

// The marker counter, once every image in the page has settled. A control image whose handler must run goes in last;
// after it ran and every image is complete, a handler that got through has one bounded chance to run (an image's
// error event comes in a task after the image is complete).
async function hits(page: Page): Promise<number | null> {
  const n = await h.run<number>(
    page,
    `const n = (window.__aiControls || 0) + 1;
    window.__aiControls = n;
    const img = document.createElement('img');
    img.onerror = () => { window.__aiControl = n; };
    img.src = ${JSON.stringify(IMG)} + '?control=' + n;
    document.body.appendChild(img);
    return n;`,
  );
  await page.waitForFunction(
    (n) =>
      (window as unknown as { __aiControl?: number }).__aiControl === n &&
      Array.from(document.images).every((img) => img.complete),
    n,
    { timeout: 15_000 },
  );
  await page
    .waitForFunction(() => (window as unknown as { __aiHits?: number }).__aiHits !== undefined, undefined, { timeout: 500 })
    .catch(() => undefined);
  return h.run<number | null>(page, 'return window.__aiHits ?? null;');
}

// Waits until the element shows the text.
async function shows(page: Page, selector: string, text: string): Promise<void> {
  await page.waitForFunction(
    ({ selector, text }) => (document.querySelector(selector)?.textContent ?? '').includes(text),
    { selector, text },
    { timeout: 15_000 },
  );
}

// Waits until the live preview of the opened document shows its pages with the text.
async function previewShows(page: Page, preview: string, text: string): Promise<void> {
  await page.waitForFunction(
    ({ preview, text }) =>
      Array.from(document.querySelectorAll(`#${preview} .quote-sheet`), (sheet) => sheet.textContent ?? '')
        .join(' ')
        .includes(text),
    { preview, text },
    { timeout: 20_000 },
  );
}

interface Formatting {
  bold: string[];
  small: string[];
  bullets: string[];
  images: number;
  handlers: number;
}
interface Stored extends Formatting {
  value: string | null;
}
// What root keeps of the formatting of rich(), and how many images and error handlers it holds.
const READ = `(root) => {
  const under = (q) => Array.from(root.querySelectorAll(q), (e) => e.textContent.trim());
  return {
    bold: under('strong'),
    small: under('span[style="font-size: 9pt;"]'),
    bullets: under('li[data-list="bullet"]'),
    images: root.querySelectorAll('img').length,
    handlers: root.querySelectorAll('[onerror]').length,
  };
}`;
const formatting = (page: Page, selector: string) =>
  h.run<Formatting>(page, `return (${READ})(document.querySelector(${JSON.stringify(selector)}));`);
// The formatting of rich(label) for each label, and no image.
const kept = (labels: string[]) => ({
  bold: expect.arrayContaining(labels.map((l) => `${l} fett`)),
  small: expect.arrayContaining(labels.map((l) => `${l} klein`)),
  bullets: expect.arrayContaining(labels.map((l) => `${l} Punkt`)),
  images: 0,
  handlers: 0,
});

// A stored value and what it holds, parsed in an inert document.
const stored = (page: Page, value: unknown) =>
  h.run<Stored>(
    page,
    `const value = ${JSON.stringify(typeof value === 'string' ? value : null)};
    const root = document.implementation.createHTMLDocument('').createElement('div');
    root.innerHTML = value ?? '';
    return { value, ...(${READ})(root) };`,
  );
// What a record must hold for rich(label): the app's sanitizer output without images, trimmed as the saves trim.
async function clean(page: Page, label: string): Promise<Stored> {
  return {
    value: await h.run<string>(page, `return sanitizeRichHtml(${JSON.stringify(rich(label))}, { images: false }).trim();`),
    bold: [`${label} fett`],
    small: [`${label} klein`],
    bullets: [`${label} Punkt`],
    images: 0,
    handlers: 0,
  };
}

// The fields of the record that the assistant created, read back through the API.
async function record(table: TableName, match: (fields: Fields) => boolean): Promise<Fields> {
  const { records } = await h.apiAs<{ records: { id: string; fields: Fields }[] }>('admin', 'GET', `/api/data/${table}`);
  return records.find((r) => match(r.fields))?.fields ?? {};
}

describe('rich text in a model answer', () => {
  it('KI-Auftrag: the preview right after the card click, then the order and the new article it creates', async () => {
    answer = JSON.stringify({
      action: 'create_order',
      source_quote_id: null,
      order_title: 'AB Seilklemmen',
      description: rich('Einleitung'),
      notes: rich('Schlusstext'),
      lieferzeit: 'KW 24',
      items: [
        {
          qty: 2,
          new_article: { name1: 'Seilklemme 8 mm', article_no: 'SK-8', description: rich('Artikel'), unit: 'Stück', sales_price: 3.5 },
        },
      ],
      summary_for_user: 'Auftragsbestätigung vorbereitet',
    });
    const page = await adminPage();
    await openTicketList(page, 'kundenbestellungen');
    // The only click before the preview: the card's button. The chat starts by itself and renders the preview.
    await page.locator(`${CARD} .ticket-aiquote-slot button`, { hasText: 'KI-Auftrag' }).click();
    await shows(page, '#aocResultBody', 'Schlusstext fett');
    const previewHits = await hits(page);
    const preview = await formatting(page, '#aocResultBody');
    await page.locator('#aocCreateBtn').click();
    await previewShows(page, 'orderPreview', 'Schlusstext fett');
    const order = await record('Order', (f) => f.order_title === 'AB Seilklemmen');
    const article = await record('Article', (f) => f.article_no === 'SK-8');
    expect({
      previewHits,
      preview,
      description: await stored(page, order.description),
      notes: await stored(page, order.notes),
      article: await stored(page, article.description),
      hits: await hits(page),
    }).toEqual({
      previewHits: null,
      preview: kept(['Einleitung', 'Schlusstext']),
      description: await clean(page, 'Einleitung'),
      notes: await clean(page, 'Schlusstext'),
      article: await clean(page, 'Artikel'),
      hits: null,
    });
    await h.assertClean(page);
  });

  it('KI-Angebot: the preview right after the card click, then the quote and the catalogue article it creates', async () => {
    answer = JSON.stringify({
      action: 'create_quote',
      bundle_id: null,
      quote_title: 'Angebot Drahtseil',
      intro: rich('Einleitung'),
      closing: rich('Schlusstext'),
      lieferzeit: 'KW 24',
      custom_values: {},
      items: [
        {
          qty: 2,
          new_article: { name1: 'Seilklemme 10 mm', article_no: 'SK-10', description: rich('Artikel'), unit: 'Stück', sales_price: 4.2 },
        },
      ],
      summary_for_user: 'Angebot vorbereitet',
    });
    const page = await adminPage();
    await openTicketList(page, 'anfragen');
    await page.locator(`${CARD} .ticket-aiquote-slot button`, { hasText: 'KI-Angebot' }).click();
    await shows(page, '#aqcResultBody', 'Schlusstext fett');
    const previewHits = await hits(page);
    const preview = await formatting(page, '#aqcResultBody');
    // "Auch in den Artikelstamm aufnehmen": the new article goes into the catalogue.
    await page.locator('[data-aqc-catalog-idx="0"]').check();
    await page.locator('#aqcCreateBtn').click();
    await previewShows(page, 'quotePreview', 'Schlusstext fett');
    const quote = await record('Quote', (f) => f.quote_title === 'Angebot Drahtseil');
    const article = await record('Article', (f) => f.article_no === 'SK-10');
    expect({
      previewHits,
      preview,
      description: await stored(page, quote.description),
      notes: await stored(page, quote.notes),
      article: await stored(page, article.description),
      hits: await hits(page),
    }).toEqual({
      previewHits: null,
      preview: kept(['Einleitung', 'Schlusstext']),
      description: await clean(page, 'Einleitung'),
      notes: await clean(page, 'Schlusstext'),
      article: await clean(page, 'Artikel'),
      hits: null,
    });
    await h.assertClean(page);
  });

  it('ERP-Assistent: the quote it creates from the chat', async () => {
    answer = JSON.stringify({
      action: 'create_quote',
      customer_id: customerId,
      contact_id: null,
      bundle_id: null,
      quote_title: 'Angebot Seilklemmen',
      intro: rich('Einleitung'),
      closing: rich('Schlusstext'),
      lieferzeit: 'KW 25',
      custom_values: {},
      items: [],
      summary_for_user: 'Angebot für Seilerei Nord angelegt',
    });
    const page = await adminPage();
    await h.run(page, 'await openErpAssistant();');
    await page.locator('#eaInput').fill('Mach ein Angebot für Seilerei Nord: zwei Seilklemmen, Lieferzeit KW 25');
    await page.locator('#eaSendBtn').click();
    await previewShows(page, 'quotePreview', 'Schlusstext fett');
    const quote = await record('Quote', (f) => f.quote_title === 'Angebot Seilklemmen');
    expect({
      description: await stored(page, quote.description),
      notes: await stored(page, quote.notes),
      hits: await hits(page),
    }).toEqual({
      description: await clean(page, 'Einleitung'),
      notes: await clean(page, 'Schlusstext'),
      hits: null,
    });
    await h.assertClean(page);
  });

  it('KI-Artikel: the article it creates from the chat', async () => {
    answer = JSON.stringify({
      action: 'create_article',
      article: {
        name1: 'Seilklemme 12 mm',
        name2: '',
        article_no: 'SK-12',
        description: rich('Artikel'),
        manufacturer_no: '',
        unit: 'Stück',
        sales_price: 5.1,
        vat_rate: 19,
        internal_notes: '',
      },
      category_id: null,
      manufacturer_id: null,
      source_freshdesk_ticket_id: null,
      supplier: { id: null, create_new: false, name1: '', email: '', supplier_article_no: '', purchase_price: null, lead_time: '' },
      summary_for_user: 'Artikel vorbereitet',
    });
    const page = await adminPage();
    await h.run(page, 'await openAiArticleCreationModal();');
    await page.locator('#aacInput').fill('Neuer Artikel: Seilklemme 12 mm, Verkaufspreis 5,10 €');
    await page.locator('#aacSendBtn').click();
    await page.waitForFunction(() => (document.getElementById('aac_description') as HTMLTextAreaElement | null)?.value, undefined, {
      timeout: 15_000,
    });
    // Without Tailwind the long modal does not scroll, and the button sits below the viewport: it gets the click
    // event directly.
    await page.locator('#aacCreateBtn').dispatchEvent('click');
    await page.locator('#article_description_editor').waitFor({ state: 'attached', timeout: 15_000 });
    const article = await record('Article', (f) => f.article_no === 'SK-12');
    expect({ article: await stored(page, article.description), hits: await hits(page) }).toEqual({
      article: await clean(page, 'Artikel'),
      hits: null,
    });
    await h.assertClean(page);
  });

  it('Anfrage-Assistent: the quote it creates from the analysis', async () => {
    answer = [
      'TITLE: Anfrage Seilklemmen',
      'TICKET: leer',
      'CHANNEL: Email',
      'CUSTOMER_HINT: Seilerei Nord',
      'CONTACT_HINT: Kunde Muster',
      'ZUSAMMENFASSUNG:',
      rich('Zusammenfassung'),
    ].join('\n');
    const page = await adminPage();
    await h.run(page, 'await openInquiryWizard();');
    const next = page.locator('button[onclick="inqWizNext()"]');
    await next.click();
    await page.locator('#inq_raw_text').fill('Hallo, wir brauchen zwei Seilklemmen 8 mm. Viele Grüße, Kunde Muster');
    // Step 3 analyses the text by itself and fills in the fields.
    await next.click();
    await page.waitForFunction(
      () => (document.getElementById('iw_title') as HTMLInputElement | null)?.value === 'Anfrage Seilklemmen',
      undefined,
      { timeout: 15_000 },
    );
    await next.click();
    await page.locator('button[onclick="inqWizCreateQuote()"]').click();
    await previewShows(page, 'quotePreview', 'Zusammenfassung fett');
    const quote = await record('Quote', (f) => f.title === 'Anfrage Seilklemmen');
    expect({ description: await stored(page, quote.description), hits: await hits(page) }).toEqual({
      description: await clean(page, 'Zusammenfassung'),
      hits: null,
    });
    await h.assertClean(page);
  });
});
