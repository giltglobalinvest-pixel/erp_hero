// test/e2e/editor-lists.e2e.ts
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LOCK_FIELDS } from '../../server/data/fields.js';
import type { TableName } from '../../server/data/tables.js';
import { ROOT_DIR } from '../helpers/context.js';
import { startHarness, type Harness } from './harness.js';

// Older list markup in stored rich text, opened in an editor (N7). Quill 2.0.2 keeps every list as <ol> with one
// <li data-list="bullet|ordered|…"> per item. A text with an older list (<ul>, or <li> without data-list: imported
// data, the data API, an AI answer) that the app wrote straight into an editor root lost the list with its text one
// tick later, and a save stored the text without it. These tests run the real Quill 2.0.2: the dist files of the
// test-only devDependency, served at the jsDelivr URLs the app loads (test/frontend/quill-version.test.ts keeps the
// versions equal). vera plants the records through the API; the admin opens them.
const QUILL_DIST = path.join(ROOT_DIR, 'node_modules/quill/dist');
const QUILL_VERSION = (
  JSON.parse(await readFile(path.join(ROOT_DIR, 'node_modules/quill/package.json'), 'utf8')) as { version: string }
).version;
const QUILL_URL = `https://cdn.jsdelivr.net/npm/quill@${QUILL_VERSION}/dist/`;

// The harmless marker of documents-rich-text.e2e.ts: an image at a same-origin path that does not exist, whose error
// handler counts in a window variable.
const IMG = '/e2e-missing.png';
const MARK = `<img src="${IMG}" onerror="window.__docHits=(window.__docHits||0)+1">`;

// A text with an older list between two paragraphs, labelled to tell the fields apart.
const legacy = (label: string): string =>
  `<p>${label}: Anfang</p><ul><li>${label}: Punkt A</li><li>${label}: Punkt B</li></ul><p>${label}: Ende</p>`;
// The same text in Quill 2's own list form, the form the editors store every list in.
const quill2 = (label: string): string =>
  `<p>${label}: Anfang</p><ol>` +
  ['Punkt A', 'Punkt B']
    .map((t) => `<li data-list="bullet"><span class="ql-ui" contenteditable="false"></span>${label}: ${t}</li>`)
    .join('') +
  `</ol><p>${label}: Ende</p>`;
interface Lists {
  paragraphs: string[];
  bullets: string[];
}
// What the reader sees of it: the two paragraphs and the two bullet items.
const lists = (label: string): Lists => ({
  paragraphs: [`${label}: Anfang`, `${label}: Ende`],
  bullets: [`${label}: Punkt A`, `${label}: Punkt B`],
});

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

// The real Quill bundle and its stylesheet, from node_modules, at the URLs index.html loads them from.
async function serveRealQuill(page: Page): Promise<void> {
  const js = await readFile(path.join(QUILL_DIST, 'quill.js'));
  const css = await readFile(path.join(QUILL_DIST, 'quill.snow.css'));
  await page.route(`${QUILL_URL}quill.js`, (route) => route.fulfill({ contentType: 'application/javascript', body: js }));
  await page.route(`${QUILL_URL}quill.snow.css`, (route) => route.fulfill({ contentType: 'text/css', body: css }));
}

// vera writes a record through the API, as every logged-in user can.
async function plant(table: TableName, fields: Record<string, unknown>): Promise<string> {
  return (await h.apiAs<{ id: string }>('vera', 'POST', `/api/data/${table}`, { fields })).id;
}

// The stored fields of each record, without the lock fields that opening a document sets and saving clears.
async function storedFields(records: [TableName, string][]): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const [table, id] of records) {
    const record = await h.deps.records.get(table, id);
    out.push(Object.fromEntries(Object.entries(record?.fields ?? {}).filter(([name]) => !LOCK_FIELDS.has(name))));
  }
  return out;
}

// The admin's page, wide enough for the live previews, with or without the real Quill.
async function adminPage(quill: boolean): Promise<Page> {
  const page = await h.newPage();
  await page.setViewportSize({ width: 1440, height: 2000 });
  if (quill) await serveRealQuill(page);
  page.on('dialog', (dialog) => {
    void dialog.accept();
  });
  await h.openApp(page, 'admin');
  return page;
}

// Waits until the element shows the text.
async function shows(page: Page, selector: string, text: string): Promise<void> {
  await page.waitForFunction(
    ({ selector, text }) => (document.querySelector(selector)?.textContent ?? '').includes(text),
    { selector, text },
    { timeout: 15_000 },
  );
}

// The element's HTML once Quill has handled a load: the same in 5 reads 20 ms apart. (Quill handles a write into its
// root one tick later, from a mutation observer; that is where an older list was lost.)
async function settled(page: Page, selector: string): Promise<string> {
  return h.run<string>(
    page,
    `const el = document.querySelector(${JSON.stringify(selector)});
    let last = el.innerHTML;
    for (let same = 0, reads = 0; same < 5 && reads < 250; reads++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const now = el.innerHTML;
      same = now === last ? same + 1 : 0;
      last = now;
    }
    return last;`,
  );
}

// Waits until the editor shows the text, then returns its settled HTML.
async function loaded(page: Page, selector: string, text: string): Promise<string> {
  await shows(page, selector, text);
  return settled(page, selector);
}

// The paragraphs and the bullet items of html, read in an inert document.
const listsOf = (page: Page, html: unknown) =>
  h.run<Lists>(
    page,
    `const d = document.implementation.createHTMLDocument('');
    d.body.innerHTML = ${JSON.stringify(String(html ?? ''))};
    const texts = (q) => Array.from(d.body.querySelectorAll(q), (e) => e.textContent.trim());
    return { paragraphs: texts('p'), bullets: texts('li[data-list="bullet"]') };`,
  );

// The value of a (hidden) input.
const valueOf = (page: Page, selector: string) =>
  h.run<string | null>(page, `return document.querySelector(${JSON.stringify(selector)})?.value ?? null;`);

// Waits until the live preview shows its pages with all the texts.
async function previewShows(page: Page, preview: string, texts: string[]): Promise<void> {
  await page.waitForFunction(
    ({ preview, texts }) => {
      const sheets = Array.from(document.querySelectorAll(`#${preview} .quote-sheet`));
      const text = sheets.map((sheet) => sheet.textContent ?? '').join(' ');
      return sheets.length > 0 && texts.every((t) => text.includes(t));
    },
    { preview, texts },
    { timeout: 20_000 },
  );
}

// The bullet items on the live preview's pages, each once.
const previewBullets = (page: Page, preview: string) =>
  h.run<string[]>(
    page,
    `const items = document.querySelectorAll(${JSON.stringify(`#${preview} .quote-sheet li[data-list="bullet"]`)});
    return [...new Set(Array.from(items, (e) => e.textContent.trim()))];`,
  );

// Saves the open modal's form and waits for its confirmation ("Gespeichert" exactly: an item's save shows "Position
// gespeichert").
async function save(page: Page, form: string): Promise<void> {
  await page.dispatchEvent(`#modalBox form[${form}] button[type="submit"]`, 'click');
  await page.locator('#toastWrap span', { hasText: /^Gespeichert$/ }).waitFor();
}

// The editors of the open modal, and how many of them Quill.find gives the instance for, from their container.
const editorsFound = (page: Page) =>
  h.run<{ editors: number; found: number }>(
    page,
    `const all = Array.from(document.querySelectorAll('#modalBox .ql-editor'));
    const found = all.filter((e) => {
      const q = window.Quill.find(e.parentElement);
      return q instanceof window.Quill && q.root === e;
    });
    return { editors: all.length, found: found.length };`,
  );

// The marker counter, once every image in the page has settled (documents-rich-text.e2e.ts).
async function hits(page: Page): Promise<number | null> {
  const n = await h.run<number>(
    page,
    `const n = (window.__docControls || 0) + 1;
    window.__docControls = n;
    const img = document.createElement('img');
    img.onerror = () => { window.__docControl = n; };
    img.src = ${JSON.stringify(IMG)} + '?control=' + n;
    document.body.appendChild(img);
    return n;`,
  );
  await page.waitForFunction(
    (n) =>
      (window as unknown as { __docControl?: number }).__docControl === n &&
      Array.from(document.images).every((img) => img.complete),
    n,
    { timeout: 15_000 },
  );
  await page
    .waitForFunction(() => (window as unknown as { __docHits?: number }).__docHits !== undefined, undefined, { timeout: 500 })
    .catch(() => undefined);
  return h.run<number | null>(page, 'return window.__docHits ?? null;');
}

describe('a stored text with an older list, opened and saved', () => {
  it('T1: the admin opens a Quote whose intro has a <ul> list and saves it without an edit', async () => {
    // The Quote intro of the finding (N7).
    const quoteId = await plant('Quote', {
      company_id: [h.companies.alpha],
      status: 'Entwurf',
      description: '<p>Einleitung</p><ul><li>Punkt A</li><li>Punkt B</li></ul><p>Schluss</p>',
    });
    const before = await storedFields([['Quote', quoteId]]);
    const page = await adminPage(true);
    await h.run(page, `await openQuoteModal(${JSON.stringify(quoteId)});`);
    const editor = await loaded(page, '#quote_intro_editor .ql-editor', 'Einleitung');
    // Opening writes nothing.
    expect(await storedFields([['Quote', quoteId]])).toEqual(before);
    await save(page, 'data-quote-form');
    const [quote] = await storedFields([['Quote', quoteId]]);
    expect({ editor: await listsOf(page, editor), stored: quote?.description }).toEqual({
      editor: { paragraphs: ['Einleitung', 'Schluss'], bullets: ['Punkt A', 'Punkt B'] },
      stored:
        '<p>Einleitung</p><ol>' +
        '<li data-list="bullet"><span class="ql-ui" contenteditable="false"></span>Punkt A</li>' +
        '<li data-list="bullet"><span class="ql-ui" contenteditable="false"></span>Punkt B</li>' +
        '</ol><p>Schluss</p>',
    });
    await h.assertClean(page);
  });

  it('an older list with the marker loads through the converter, and the marker stays unset', async () => {
    const quoteId = await plant('Quote', {
      company_id: [h.companies.alpha],
      status: 'Entwurf',
      description: legacy('Markiert') + MARK,
    });
    const page = await adminPage(true);
    await h.run(page, `await openQuoteModal(${JSON.stringify(quoteId)});`);
    const editor = await loaded(page, '#quote_intro_editor .ql-editor', 'Markiert: Anfang');
    // The list loads as a Quill 2 list; the image stays, in a paragraph of its own (as Quill's paste puts it), without
    // its handler.
    expect({ hits: await hits(page), editor }).toEqual({
      hits: null,
      editor: `${quill2('Markiert')}<p><img src="${IMG}"></p>`,
    });
    await h.assertClean(page);
  });
});

// T2: each place where the app loads a stored text into an existing editor, all through setQuillHtml.
interface Doc {
  table: TableName;
  items: TableName;
  link: string;
  open: string;
  form: string;
  editors: [string, string];
  itemForm: string;
  saveItem: string;
  fid: string;
}
const DOCUMENTS: Doc[] = [
  {
    table: 'Quote',
    items: 'QuoteItem',
    link: 'quote_id',
    open: 'openQuoteModal',
    form: 'data-quote-form',
    editors: ['quote_intro_editor', 'quote_notes_editor'],
    itemForm: 'showQuoteItemInlineForm',
    saveItem: 'saveQuoteItemInline',
    fid: 'qif_',
  },
  {
    table: 'Order',
    items: 'OrderItem',
    link: 'order_id',
    open: 'openOrderModal',
    form: 'data-order-form',
    editors: ['order_intro_editor', 'order_closing_editor'],
    itemForm: 'showOrderItemInlineForm',
    saveItem: 'saveOrderItemInline',
    fid: 'oif_',
  },
  {
    table: 'SupplierOrder',
    items: 'SupplierOrderItem',
    link: 'purchase_id',
    open: 'openSupplierOrderModal',
    form: 'data-purchase-form',
    editors: ['purchase_intro_editor', 'purchase_closing_editor'],
    itemForm: 'showPurchaseItemInlineForm',
    saveItem: 'savePurchaseItemInline',
    fid: 'pif_',
  },
  {
    table: 'DeliveryNote',
    items: 'DeliveryNoteItem',
    link: 'delivery_id',
    open: 'openDeliveryNoteModal',
    form: 'data-delivery-form',
    editors: ['delivery_intro_editor', 'delivery_closing_editor'],
    itemForm: 'showDeliveryItemInlineForm',
    saveItem: 'saveDeliveryItemInline',
    fid: 'dif_',
  },
  {
    table: 'Invoice',
    items: 'InvoiceItem',
    link: 'invoice_id',
    open: 'openInvoiceModal',
    form: 'data-invoice-form',
    editors: ['invoice_intro_editor', 'invoice_closing_editor'],
    itemForm: 'showInvoiceItemInlineForm',
    saveItem: 'saveInvoiceItemInline',
    fid: 'iif_',
  },
];

describe('T2: every place that loads a stored text into an editor keeps an older list', () => {
  // The Quote's intro and closing text are initQuoteEditors (setupOne), the other documents' are
  // initSimpleQuillEditor. The items are showOrder/Purchase/Delivery/InvoiceItemInlineForm; the Quote item pastes
  // (dangerouslyPasteHTML), which converts the list already.
  it.each(DOCUMENTS)('$table: the intro, the closing text and the item, opened and saved', async (doc) => {
    const docId = await plant(doc.table, {
      company_id: [h.companies.alpha],
      status: 'Entwurf',
      description: legacy('Einleitung'),
      notes: legacy('Schlusstext'),
    });
    const itemId = await plant(doc.items, {
      [doc.link]: [docId],
      pos: 1,
      qty: 1,
      unit: 'Stück',
      unit_price_net: 10,
      vat_rate: 19,
      description: legacy('Position'),
    });
    const records: [TableName, string][] = [
      [doc.table, docId],
      [doc.items, itemId],
    ];
    const before = await storedFields(records);
    const page = await adminPage(true);
    const [intro, closing] = doc.editors.map((e) => `#${e} .ql-editor`) as [string, string];
    const item = `#${doc.fid}${itemId}_description_editor .ql-editor`;
    await h.run(page, `await ${doc.open}(${JSON.stringify(docId)});`);
    const inIntro = await loaded(page, intro, 'Einleitung: Anfang');
    const inClosing = await loaded(page, closing, 'Schlusstext: Anfang');
    await h.run(page, `await ${doc.itemForm}(${JSON.stringify(docId)}, ${JSON.stringify(itemId)});`);
    const inItem = await loaded(page, item, 'Position: Anfang');
    const hidden = {
      intro: await valueOf(page, `#modalBox form[${doc.form}] input[name="description"]`),
      closing: await valueOf(page, `#modalBox form[${doc.form}] input[name="notes"]`),
      item: await valueOf(page, `#${doc.fid}${itemId}_description`),
    };
    // Opening writes nothing.
    expect(await storedFields(records)).toEqual(before);
    await h.run(page, `await ${doc.saveItem}(${JSON.stringify(docId)}, ${JSON.stringify(itemId)});`);
    await save(page, doc.form);
    const [stored, storedItem] = await storedFields(records);
    expect({
      editors: {
        intro: await listsOf(page, inIntro),
        closing: await listsOf(page, inClosing),
        item: await listsOf(page, inItem),
      },
      hidden,
      stored: { description: stored?.description, notes: stored?.notes, item: storedItem?.description },
    }).toEqual({
      editors: { intro: lists('Einleitung'), closing: lists('Schlusstext'), item: lists('Position') },
      hidden: { intro: quill2('Einleitung'), closing: quill2('Schlusstext'), item: quill2('Position') },
      stored: { description: quill2('Einleitung'), notes: quill2('Schlusstext'), item: quill2('Position') },
    });
    await h.assertClean(page);
  });

  it('Article: the description editor (initSimpleQuillEditor), opened and saved', async () => {
    const articleId = await plant('Article', {
      company_id: [h.companies.alpha],
      status: 'aktiv',
      name1: 'Drahtseil',
      description: legacy('Artikel'),
    });
    const before = await storedFields([['Article', articleId]]);
    const page = await adminPage(true);
    await h.run(page, `await openArticleModal(${JSON.stringify(articleId)});`);
    const editor = await loaded(page, '#article_description_editor .ql-editor', 'Artikel: Anfang');
    const hidden = await valueOf(page, '#modalBox form[data-article-form] input[name="description"]');
    expect(await storedFields([['Article', articleId]])).toEqual(before);
    await save(page, 'data-article-form');
    const [article] = await storedFields([['Article', articleId]]);
    expect({ editor: await listsOf(page, editor), hidden, stored: article?.description }).toEqual({
      editor: lists('Artikel'),
      hidden: quill2('Artikel'),
      stored: quill2('Artikel'),
    });
    await h.assertClean(page);
  });

  it('Quote: a template with an older list, picked for the intro (setQuoteFieldValue), with the live preview', async () => {
    const templateId = await plant('Textemplate', {
      company_id: [h.companies.alpha],
      doc_type: 'Angebot',
      section: 'Einleitung',
      status: 'aktiv',
      name: 'Vorlage mit Liste',
      content: legacy('Vorlage'),
    });
    const quoteId = await plant('Quote', { company_id: [h.companies.alpha], status: 'Entwurf' });
    const page = await adminPage(true);
    await h.run(page, `await openQuoteModal(${JSON.stringify(quoteId)});`);
    await page.waitForSelector('#quote_intro_editor .ql-editor', { state: 'attached' });
    // The intro section is folded away until the admin shows it.
    await page.click('#quoteAdvancedToggle');
    await page.selectOption('#modalBox select[data-tpl-field="description"]', templateId);
    const editor = await loaded(page, '#quote_intro_editor .ql-editor', 'Vorlage: Anfang');
    await previewShows(page, 'quotePreview', ['Vorlage: Anfang']);
    const hidden = await valueOf(page, '#modalBox form[data-quote-form] input[name="description"]');
    const preview = await previewBullets(page, 'quotePreview');
    await save(page, 'data-quote-form');
    const [quote] = await storedFields([['Quote', quoteId]]);
    expect({ editor: await listsOf(page, editor), hidden, preview, stored: quote?.description }).toEqual({
      editor: lists('Vorlage'),
      hidden: quill2('Vorlage'),
      preview: lists('Vorlage').bullets,
      stored: quill2('Vorlage'),
    });
    await h.assertClean(page);
  });

  it('Quote: the full-screen editor (expandTextField) takes the stored intro when Quill came late', async () => {
    const quoteId = await plant('Quote', {
      company_id: [h.companies.alpha],
      status: 'Entwurf',
      description: legacy('Vollbild'),
    });
    // Quill arrives only after the modal opened (its first load failed), so the full-screen editor takes the stored
    // value from the hidden input.
    const page = await adminPage(false);
    await h.run(page, `await openQuoteModal(${JSON.stringify(quoteId)});`);
    await previewShows(page, 'quotePreview', ['Vollbild: Anfang']);
    await serveRealQuill(page);
    await h.run(page, `expandTextField('description', 'Einleitung');`);
    const editor = await loaded(page, '#expandedQuillEditor .ql-editor', 'Vollbild: Anfang');
    // "Übernehmen" (applyExpandedField) writes the editor's content back into the Quote form.
    await page.dispatchEvent('#modalBox2 form button[type="submit"]', 'click');
    await page.waitForFunction(() => !(window as unknown as { _expandedQuill?: unknown })._expandedQuill);
    const hidden = await valueOf(page, '#modalBox form[data-quote-form] input[name="description"]');
    await save(page, 'data-quote-form');
    const [quote] = await storedFields([['Quote', quoteId]]);
    expect({ editor: await listsOf(page, editor), hidden, stored: quote?.description }).toEqual({
      editor: lists('Vollbild'),
      hidden: quill2('Vollbild'),
      stored: quill2('Vollbild'),
    });
    await h.assertClean(page);
  });

  const BUNDLES = [
    { table: 'Order', docType: 'Auftrag', open: 'openOrderModal', preview: 'orderPreview', form: 'data-order-form' },
    {
      table: 'SupplierOrder',
      docType: 'Bestellung',
      open: 'openSupplierOrderModal',
      preview: 'purchasePreview',
      form: 'data-purchase-form',
    },
    {
      table: 'DeliveryNote',
      docType: 'Lieferschein',
      open: 'openDeliveryNoteModal',
      preview: 'deliveryPreview',
      form: 'data-delivery-form',
    },
    { table: 'Invoice', docType: 'Rechnung', open: 'openInvoiceModal', preview: 'invoicePreview', form: 'data-invoice-form' },
  ] as const;

  // applyOrder/Purchase/Delivery/InvoiceBundle write into the editors that the modal already has.
  it.each(BUNDLES)('$table: a bundle whose templates have older lists, applied and saved', async (bundle) => {
    const { table, docType, open, preview, form } = bundle;
    const template = (section: string, name: string, label: string) =>
      plant('Textemplate', {
        company_id: [h.companies.alpha],
        doc_type: docType,
        section,
        status: 'aktiv',
        name,
        content: legacy(label),
      });
    const introId = await template('Einleitung', 'Einleitung mit Liste', 'Paket-Einleitung');
    const closingId = await template('Schlusstext', 'Schluss mit Liste', 'Paket-Schluss');
    const bundleId = await plant('QuoteBundle', {
      company_id: h.companies.alpha,
      doc_type: docType,
      status: 'aktiv',
      name: 'Paket mit Listen',
      intro_template_id: introId,
      closing_template_id: closingId,
    });
    const docId = await plant(table, { company_id: [h.companies.alpha], status: 'Entwurf' });
    const doc = DOCUMENTS.find((d) => d.table === table);
    if (!doc) throw new Error(`no document ${table}`);
    const [intro, closing] = doc.editors.map((e) => `#${e} .ql-editor`) as [string, string];
    const page = await adminPage(true);
    await h.run(page, `await ${open}(${JSON.stringify(docId)});`);
    await page.waitForSelector(intro, { state: 'attached' });
    await page.waitForSelector(closing, { state: 'attached' });
    // The bundle functions find each editor's instance with Quill.find(container).
    expect(await editorsFound(page)).toEqual({ editors: 2, found: 2 });
    await page.selectOption('#modalBox select[name="bundle_id"]', bundleId);
    const inIntro = await loaded(page, intro, 'Paket-Einleitung: Anfang');
    const inClosing = await loaded(page, closing, 'Paket-Schluss: Anfang');
    await previewShows(page, preview, ['Paket-Einleitung: Anfang', 'Paket-Schluss: Anfang']);
    const hidden = {
      intro: await valueOf(page, `#modalBox form[${form}] input[name="description"]`),
      closing: await valueOf(page, `#modalBox form[${form}] input[name="notes"]`),
    };
    const inPreview = await previewBullets(page, preview);
    await save(page, form);
    const [stored] = await storedFields([[table, docId]]);
    expect({
      editors: { intro: await listsOf(page, inIntro), closing: await listsOf(page, inClosing) },
      hidden,
      preview: inPreview,
      stored: { description: stored?.description, notes: stored?.notes },
    }).toEqual({
      editors: { intro: lists('Paket-Einleitung'), closing: lists('Paket-Schluss') },
      hidden: { intro: quill2('Paket-Einleitung'), closing: quill2('Paket-Schluss') },
      preview: [...lists('Paket-Einleitung').bullets, ...lists('Paket-Schluss').bullets],
      stored: { description: quill2('Paket-Einleitung'), notes: quill2('Paket-Schluss') },
    });
    await h.assertClean(page);
  });

  // onPi/onDi/onIiArticleChange build the editor's HTML from escaped text lines, so no list markup reaches them; they
  // load through the same function, and what they show must stay as it was.
  const ARTICLE_CHANGES = [
    {
      table: 'SupplierOrder',
      open: 'openSupplierOrderModal',
      itemForm: 'showPurchaseItemInlineForm',
      onChange: 'onPiArticleChange',
      fid: 'pif_new',
    },
    {
      table: 'DeliveryNote',
      open: 'openDeliveryNoteModal',
      itemForm: 'showDeliveryItemInlineForm',
      onChange: 'onDiArticleChange',
      fid: 'dif_new',
    },
    {
      table: 'Invoice',
      open: 'openInvoiceModal',
      itemForm: 'showInvoiceItemInlineForm',
      onChange: 'onIiArticleChange',
      fid: 'iif_new',
    },
  ] as const;

  it.each(ARTICLE_CHANGES)('$table: an article fills an empty item description as before ($onChange)', async (change) => {
    const { table, open, itemForm, onChange, fid } = change;
    const articleId = await plant('Article', {
      company_id: [h.companies.alpha],
      status: 'aktiv',
      name1: 'Drahtseil',
      description: 'Länge 10 m\n\nTragkraft 500 kg & mehr',
    });
    const docId = await plant(table, { company_id: [h.companies.alpha], status: 'Entwurf' });
    const page = await adminPage(true);
    const editor = `#${fid}_description_editor .ql-editor`;
    await h.run(page, `await ${open}(${JSON.stringify(docId)});`);
    await h.run(page, `await ${itemForm}(${JSON.stringify(docId)}, '');`);
    await page.waitForSelector(editor, { state: 'attached' });
    await h.run(page, `${onChange}(${JSON.stringify(articleId)}, ${JSON.stringify(`${fid}_article`)});`);
    const html = await loaded(page, editor, 'Drahtseil');
    const expected = '<p>Drahtseil</p><p>Länge 10 m</p><p><br></p><p>Tragkraft 500 kg &amp; mehr</p>';
    expect({ html, hidden: await valueOf(page, `#${fid}_description`) }).toEqual({ html: expected, hidden: expected });
    await h.assertClean(page);
  });
});

// T3. Shapes of older lists, each loaded through initSimpleQuillEditor into a new editor of the admin's page, as a
// form loads it. For each shape: (a) every non-whitespace character of its text is in the editor; (b) each list item
// has the list type and indent level that Quill's own paste of the same HTML gives; (c) what the form saves loads
// unchanged a second time. One map of all shapes, so that a failure shows every shape that fails.
const LIST_SHAPES: Record<string, string> = {
  'flat ul': '<ul><li>Eins</li><li>Zwei</li><li>Drei</li></ul>',
  'ul nested 2 levels': '<ul><li>Eins<ul><li>Eins.eins</li><li>Eins.zwei</li></ul></li><li>Zwei</li></ul>',
  'ul nested 3 levels': '<ul><li>Eins<ul><li>Eins.eins<ul><li>Eins.eins.eins</li></ul></li></ul></li><li>Zwei</li></ul>',
  'ul in ol': '<ol><li>Schritt eins<ul><li>Detail A</li><li>Detail B</li></ul></li><li>Schritt zwei</li></ol>',
  'ol in ul': '<ul><li>Punkt<ol><li>Erstens</li><li>Zweitens</li></ol></li><li>Noch ein Punkt</li></ul>',
  'ol without data-list': '<ol><li>Erstens</li><li>Zweitens</li></ol>',
  'Quill 1 flat ul with ql-indent': '<ul><li>Eins</li><li class="ql-indent-1">Eins.eins</li><li class="ql-indent-2">Eins.eins.eins</li><li>Zwei</li></ul>',
  'Quill 1 flat ol with ql-indent': '<ol><li>Erstens</li><li class="ql-indent-1">Unterpunkt a</li><li class="ql-indent-1">Unterpunkt b</li><li>Zweitens</li></ol>',
  'li with bold': '<ul><li><strong>Fett</strong> und normal</li></ul>',
  'li with italic': '<ul><li><em>Kursiv</em> und normal</li></ul>',
  'li with underline': '<ul><li><u>Unterstrichen</u> und normal</li></ul>',
  'li with a link': '<ul><li><a href="https://example.test/seite">Webseite</a> ansehen</li></ul>',
  'li with a size span': '<ul><li><span style="font-size: 9pt;">Klein</span> gedruckt</li></ul>',
  'li with a colour': '<ul><li><span style="color: rgb(230, 0, 0);">Rot</span> und normal</li></ul>',
  'li with p children': '<ul><li><p>Absatz eins</p></li><li><p>Absatz zwei</p></li></ul>',
  'li with br': '<ul><li>Zeile eins<br>Zeile zwei</li><li>Danach</li></ul>',
  'empty li': '<ul><li>Voll</li><li></li><li>Auch voll</li></ul>',
  'Quill 2 list and older list in one text':
    '<ol><li data-list="bullet"><span class="ql-ui" contenteditable="false"></span>Neue Liste</li></ol><p>Dazwischen</p><ul><li>Alte Liste</li></ul>',
  'li without data-list in a Quill 2 list':
    '<ol><li data-list="bullet"><span class="ql-ui" contenteditable="false"></span>Mit Typ</li><li>Ohne Typ</li></ol>',
  'older list in a Quill 2 item':
    '<ol><li data-list="bullet"><span class="ql-ui" contenteditable="false"></span>Aussen<ul><li>Innen</li></ul></li></ol>',
  'li outside a list': '<p>Davor</p><li>Lose Zeile</li><p>Danach</p>',
  'list first': '<ul><li>Zuerst die Liste</li></ul><p>Dann der Text</p>',
  'list last': '<p>Erst der Text</p><ul><li>Zuletzt die Liste</li></ul>',
  'list between headers': '<h2>Titel</h2><ul><li>Punkt</li></ul><h3>Untertitel</h3>',
  'list with alignment classes': '<ul><li class="ql-align-center">Mittig</li><li class="ql-align-right">Rechts</li></ul>',
  'nbsp inside items': '<ul><li>Preis:&nbsp;&nbsp;100&nbsp;€</li><li>&nbsp;&nbsp;eingerückt</li></ul>',
  'multiple spaces inside items': '<ul><li>Preis:   100   €</li><li>  führend und am Ende  </li></ul>',
  'ul in a blockquote': '<blockquote><ul><li>Im Zitat</li></ul></blockquote>',
  'ul in a table cell': '<p>Tabelle:</p><table><tbody><tr><td data-row="1">Zelle<ul><li>In der Zelle</li></ul></td></tr></tbody></table>',
  'letter with a nested list':
    '<p><strong>Sehr geehrte Damen und Herren,</strong></p><p>wir bieten an:</p>' +
    '<ul><li><span style="font-size: 9pt;">Wartung</span> vor Ort</li><li>Ersatzteile<ul><li>Seile</li></ul></li></ul>' +
    '<p>Mit freundlichen Grüßen</p>',
};
// Other block markup that a root write drops with its text, by the same mechanism, as measured with Quill 2.0.2: it has
// no blot for <pre>, and a plain <div> meets the scroll blot. Each shape, and what it loads as, has a tag that
// isRichText knows, as a text needs one to load as HTML (a table or a quote alone loads as plain text).
const BLOCK_SHAPES: Record<string, string> = {
  'pre between paragraphs': '<p>Davor</p><pre>Zeile eins\nZeile zwei</pre><p>Danach</p>',
  'pre with br lines': '<p>Davor</p><pre>eins<br>zwei</pre>',
  'pre with code': '<p>Code:</p><pre><code>let a = 1;</code></pre>',
  'pre in a list item': '<ol><li data-list="bullet"><span class="ql-ui" contenteditable="false"></span>Punkt<pre>Im Punkt</pre></li></ol>',
  'pre in a blockquote': '<p>Davor</p><blockquote><pre>Im Zitat</pre></blockquote>',
  'pre in a table cell': '<p>Tabelle:</p><table><tbody><tr><td data-row="1"><pre>In der Zelle</pre></td></tr></tbody></table>',
  'plain div': '<div>Ein Block</div>',
  'div lines': '<div>Zeile eins</div><div>Zeile zwei</div>',
  'div with a paragraph': '<div><p>Absatz im Block</p></div>',
  'nested div': '<div><div>Innen</div></div>',
  'div with inline formats': '<div><strong>Fett</strong> und <em>kursiv</em></div>',
  'div with an alignment class': '<div class="ql-align-center">Mittig</div>',
  'div between paragraphs': '<p>Davor</p><div>Mitte</div><p>Danach</p>',
  'div in a list item': '<ol><li data-list="bullet"><span class="ql-ui" contenteditable="false"></span>Punkt<div>Im Punkt</div></li></ol>',
  'div in a table cell': '<p>Tabelle:</p><table><tbody><tr><td data-row="1"><div>In der Zelle</div></td></tr></tbody></table>',
  'div in a blockquote': '<p>Davor</p><blockquote><div>Im Zitat</div></blockquote>',
  'div in a heading': '<h2><div>Titel</div></h2>',
};

interface ShapeResult {
  text: string;
  items: string[];
  again: string;
}
// Loads each shape as described above; returns what each check compares, as found and as expected.
async function loadShapes(page: Page, shapes: Record<string, string>) {
  return h.run<{ found: Record<string, ShapeResult>; expected: Record<string, ShapeResult> }>(
    page,
    `await ensureQuillLoaded();
    registerQuillCustomSizes();
    const settle = async (root) => {
      let last = root.innerHTML;
      for (let same = 0, reads = 0; same < 5 && reads < 250; reads++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const now = root.innerHTML;
        same = now === last ? same + 1 : 0;
        last = now;
      }
      return last;
    };
    const parse = (html) => {
      const d = document.implementation.createHTMLDocument('');
      d.body.innerHTML = html;
      return d.body;
    };
    const chars = (html) => (parse(html).textContent || '').replace(/\\s+/g, '');
    const indent = (li) => (/\\bql-indent-(\\d+)\\b/.exec(li.className) || [])[1] || '0';
    const items = (html) =>
      Array.from(parse(html).querySelectorAll('li'), (li) =>
        [li.textContent.trim(), li.getAttribute('data-list'), indent(li)].join(' | '));
    let n = 0;
    // A form's editor: a hidden input and a container in #modalBox, loaded by initSimpleQuillEditor.
    const load = async (html) => {
      const name = 'editorLists' + (++n);
      const host = document.createElement('div');
      host.innerHTML = '<input type="hidden" name="' + name + '"><div id="' + name + '_editor"></div>';
      document.getElementById('modalBox').appendChild(host);
      const q = await initSimpleQuillEditor(name + '_editor', name, html, '');
      const shown = await settle(q.root);
      const saved = host.querySelector('input').value;
      host.remove();
      return { shown, saved };
    };
    const paste = async (html) => {
      const host = document.createElement('div');
      host.appendChild(document.createElement('div'));
      document.getElementById('modalBox').appendChild(host);
      const q = new window.Quill(host.firstChild, { theme: 'snow', modules: { toolbar: quillStandardToolbar() } });
      q.clipboard.dangerouslyPasteHTML(html);
      const shown = await settle(q.root);
      host.remove();
      return shown;
    };
    const found = {};
    const expected = {};
    for (const [name, html] of Object.entries(${JSON.stringify(shapes)})) {
      const first = await load(html);
      const second = await load(first.saved);
      found[name] = { text: chars(first.shown), items: items(first.shown), again: second.shown };
      expected[name] = { text: chars(html), items: items(await paste(html)), again: first.shown };
    }
    return { found, expected };`,
  );
}

describe('T3: shapes of older lists, in an editor with the real Quill', () => {
  const listShapes = Object.keys(LIST_SHAPES).length;
  const blockShapes = Object.keys(BLOCK_SHAPES).length;
  it(`older lists: ${listShapes} shapes keep their text, list types and indents, and load the same again`, async () => {
    const page = await adminPage(true);
    const { found, expected } = await loadShapes(page, LIST_SHAPES);
    expect(Object.keys(found)).toHaveLength(listShapes);
    expect(found).toEqual(expected);
    await h.assertClean(page);
  });

  it(`<pre> and plain <div>: ${blockShapes} shapes keep their text and load the same again`, async () => {
    const page = await adminPage(true);
    const { found, expected } = await loadShapes(page, BLOCK_SHAPES);
    expect(Object.keys(found)).toHaveLength(blockShapes);
    expect(found).toEqual(expected);
    await h.assertClean(page);
  });
});

// T4. Texts without older list markup load exactly as before. Real Quill 2.0.2 states (root.innerHTML), recorded in an
// editor set up as the app sets up its editors (quillStandardToolbar, the 5-12pt sizes) through the calls its toolbar
// makes.
const QUILL2_STATES: Record<string, string> = {
  'bullet list':
    '<ol><li data-list="bullet"><span class="ql-ui" contenteditable="false"></span>Punkt A</li><li data-list="bullet"><span class="ql-ui" contenteditable="false"></span>Punkt B</li></ol>',
  'ordered list':
    '<ol><li data-list="ordered"><span class="ql-ui" contenteditable="false"></span>Erstens</li><li data-list="ordered"><span class="ql-ui" contenteditable="false"></span>Zweitens</li></ol>',
  'nested list':
    '<ol><li data-list="bullet"><span class="ql-ui" contenteditable="false"></span>Eins</li><li data-list="bullet" class="ql-indent-1"><span class="ql-ui" contenteditable="false"></span>Eins.eins</li><li data-list="bullet" class="ql-indent-2"><span class="ql-ui" contenteditable="false"></span>Eins.eins.eins</li></ol>',
  'mixed list':
    '<ol><li data-list="ordered"><span class="ql-ui" contenteditable="false"></span>Schritt</li><li data-list="bullet" class="ql-indent-1"><span class="ql-ui" contenteditable="false"></span>Detail</li></ol>',
  'checked list':
    '<ol><li data-list="checked"><span class="ql-ui" contenteditable="false"></span>Erledigt</li><li data-list="unchecked"><span class="ql-ui" contenteditable="false"></span>Offen</li></ol>',
  'indented paragraph': '<p class="ql-indent-2">Eingerückt</p>',
  'size 5pt': '<p><span style="font-size: 5pt;">Klein</span> gedruckt</p>',
  'size 9pt': '<p><span style="font-size: 9pt;">Klein</span> gedruckt</p>',
  'size 12pt bold': '<p><strong style="font-size: 12pt;">Gross</strong> und fett</p>',
  'bold italic underline': '<p><strong>fett</strong> <em>kursiv</em> <u>unterstrichen</u></p>',
  colour: '<p><span style="color: rgb(230, 0, 0);">Rot</span> und normal</p>',
  background: '<p><span style="background-color: rgb(255, 255, 0);">Markiert</span> und normal</p>',
  'align center': '<p class="ql-align-center">Mittig</p>',
  'align right': '<p class="ql-align-right">Rechts</p>',
  'align justify and a list item aligned right':
    '<p class="ql-align-justify">Blocksatz</p><ol><li data-list="bullet" class="ql-align-right"><span class="ql-ui" contenteditable="false"></span>Punkt</li></ol>',
  link: '<p><a href="https://example.test/seite" rel="noopener noreferrer" target="_blank">Webseite</a> ansehen</p>',
  'same-origin image': `<p>Bild:<img src="${IMG}"></p>`,
  'empty paragraphs': '<p>Oben</p><p><br></p><p><br></p><p>Unten</p>',
  'multiple spaces': '<p>Preis:   100 €  netto</p>',
  'leading spaces': '<p>   eingerückt mit Leerzeichen</p>',
  headers: '<h1>Titel</h1><h3>Untertitel</h3><p>Text</p>',
  blockquote: '<blockquote>Zitat</blockquote><p>Danach</p>',
  'code block':
    '<div class="ql-code-block-container" spellcheck="false"><div class="ql-code-block" data-language="plain">let a = 1;</div><div class="ql-code-block" data-language="plain">let b = 2;</div></div>',
  table:
    '<table><tbody><tr><td data-row="1">A1</td><td data-row="1">B1</td></tr><tr><td data-row="2">A2</td><td data-row="2">B2</td></tr></tbody></table>',
  'letter with a list':
    '<p><strong>Sehr geehrte Damen und Herren,</strong></p><p><br></p><ol><li data-list="bullet"><span class="ql-ui" contenteditable="false"></span><span style="font-size: 9pt;">vielen Dank</span> für Ihre Anfrage.</li><li data-list="bullet"><span class="ql-ui" contenteditable="false"></span>Position A</li></ol><p>Mit freundlichen Grüßen</p>',
};
// HTML that the app builds for an editor: a plain-text template in a bundle (applyOrderBundle and the others wrote it
// without the sanitizer: <p>${escapeHtml(content)}</p>), and an article's lines in an item (onPiArticleChange and the
// others).
const APP_HTML: Record<string, { html: string; sanitized: boolean }> = {
  'escaped plain-text template': { html: '<p>Preis &lt; 100 € &amp; &quot;netto&quot; für Müller&#39;s</p>', sanitized: false },
  'article lines': { html: '<p>Drahtseil</p><p>Länge 10 m</p><p><br></p><p>Tragkraft 500 kg &amp; mehr</p>', sanitized: true },
};

describe('T4: texts without older list markup', () => {
  const samples = {
    ...Object.fromEntries(Object.entries(QUILL2_STATES).map(([name, html]) => [name, { html, sanitized: true }])),
    ...APP_HTML,
  };
  const count = Object.keys(samples).length;
  it(`${count} samples give the same editor through setQuillHtml as through the direct write`, async () => {
    const page = await adminPage(true);
    const result = await h.run<{ viaLoader: Record<string, string>; direct: Record<string, string> }>(
      page,
      `await ensureQuillLoaded();
      registerQuillCustomSizes();
      const settle = async (root) => {
        let last = root.innerHTML;
        for (let same = 0, reads = 0; same < 5 && reads < 250; reads++) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          const now = root.innerHTML;
          same = now === last ? same + 1 : 0;
          last = now;
        }
        return last;
      };
      const editor = () => {
        const host = document.createElement('div');
        host.appendChild(document.createElement('div'));
        document.getElementById('modalBox').appendChild(host);
        return new window.Quill(host.firstChild, { theme: 'snow', modules: { toolbar: quillStandardToolbar() } });
      };
      const viaLoader = {};
      const direct = {};
      for (const [name, { html, sanitized }] of Object.entries(${JSON.stringify(samples)})) {
        const a = editor();
        setQuillHtml(a, html);
        viaLoader[name] = await settle(a.root);
        // The write that the sites made before.
        const b = editor();
        b.root.innerHTML = sanitized ? sanitizeRichHtml(html) : html;
        direct[name] = await settle(b.root);
      }
      return { viaLoader, direct };`,
    );
    expect(Object.keys(result.direct)).toHaveLength(count);
    // The recorded Quill 2 states also load unchanged.
    const recorded = Object.fromEntries(Object.keys(QUILL2_STATES).map((name) => [name, result.direct[name]]));
    expect({ viaLoader: result.viaLoader, recorded }).toEqual({ viaLoader: result.direct, recorded: QUILL2_STATES });
    await h.assertClean(page);
  });
});
