// test/e2e/documents-rich-text.e2e.ts
import type { Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LOCK_FIELDS } from '../../server/data/fields.js';
import type { TableName } from '../../server/data/tables.js';
import { startHarness, type Harness } from './harness.js';

// Rich text that a non-admin stored, opened by an admin: the five documents and their items, an article, templates
// and bundles. vera (no admin) writes every rich-text field through the real API, with real formatting (bold, a 9pt
// size, a Quill bullet list) and a harmless marker: an image at a same-origin path that does not exist, whose error
// handler counts in a window variable. The admin then opens what she wrote. The counter must stay unset, the
// formatting must stay, opening must not rewrite a record, and a save must store the sanitized value.
const IMG = '/e2e-missing.png';
const MARK = `<img src="${IMG}" onerror="window.__docHits=(window.__docHits||0)+1">`;
const rich = (label: string): string =>
  `<p><strong>${label} fett</strong> und <span style="font-size: 9pt;">${label} klein</span></p>` +
  `<ol><li data-list="bullet"><span class="ql-ui" contenteditable="false"></span>${label} Punkt</li></ol>${MARK}`;

// The harness aborts jsDelivr, so the app runs without Quill: the editors stay empty and the hidden inputs keep the
// stored values, which the live previews read (as they do when the CDN answers after a preview's first render). For
// the editors, this test-only stub is served at the jsDelivr URL of Quill 2.0.2. It is faithful where it matters:
// - root is a live div.ql-editor inside the container, so the app's own `root.innerHTML = …` stays a live parse and
//   its `.ql-editor` lookups find it, as with real Quill;
// - the constructor moves the container's existing children into root;
// - clipboard.dangerouslyPasteHTML parses in an inert document and inserts only text. Real Quill 2.0.2 also parses a
//   paste in an inert document (modules/clipboard.js) and runs nothing from it.
// Its limits: no formats, Delta, toolbar, history or selection model. A paste keeps the text only (real Quill keeps
// the registered formats); setText makes one <p> per line; insertText adds a paragraph; getSelection is always the
// end; text-change comes from a MutationObserver on root, with empty deltas. It has only the members index.html uses:
// root, clipboard, on, setText, getText, getLength, getSelection, setSelection, insertText and focus, and the statics
// import (an object with a whitelist) and register.
const QUILL_JS = 'https://cdn.jsdelivr.net/npm/quill@2.0.2/dist/quill.js';
const QUILL_STUB = String.raw`(() => {
  const inertText = (html) => {
    const div = document.implementation.createHTMLDocument('').createElement('div');
    div.innerHTML = String(html ?? '');
    return div.textContent ?? '';
  };
  class Quill {
    static import() { return { whitelist: null }; }
    static register() {}
    constructor(container, options = {}) {
      this.container = typeof container === 'string' ? document.querySelector(container) : container;
      this.options = options;
      this.handlers = {};
      this.container.classList.add('ql-container', 'ql-snow');
      this.root = document.createElement('div');
      this.root.className = 'ql-editor';
      this.root.setAttribute('contenteditable', 'true');
      while (this.container.firstChild) this.root.appendChild(this.container.firstChild);
      this.container.appendChild(this.root);
      this.clipboard = {
        dangerouslyPasteHTML: (index, html) => {
          if (typeof index === 'string') this.setText(inertText(index));
          else this.insertText(index, inertText(html));
        },
      };
      new MutationObserver(() => this.emit('text-change'))
        .observe(this.root, { childList: true, subtree: true, characterData: true });
    }
    emit(name) { for (const fn of this.handlers[name] || []) fn({ ops: [] }, { ops: [] }, 'user'); }
    on(name, fn) { (this.handlers[name] ||= []).push(fn); return this; }
    setText(text) {
      this.root.textContent = '';
      for (const line of String(text ?? '').replace(/\n$/, '').split('\n')) {
        const p = document.createElement('p');
        if (line) p.textContent = line;
        else p.appendChild(document.createElement('br'));
        this.root.appendChild(p);
      }
    }
    getText() { return Array.from(this.root.childNodes, (n) => n.textContent).join('\n') + '\n'; }
    getLength() { return this.getText().length; }
    getSelection() { return { index: this.getLength() - 1, length: 0 }; }
    setSelection() {}
    insertText(index, text) {
      const p = document.createElement('p');
      p.textContent = String(text ?? '');
      this.root.insertBefore(p, index === 0 ? this.root.firstChild : null);
    }
    focus() { this.root.focus(); }
  }
  window.Quill = Quill;
})();`;

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

const serveQuillStub = (page: Page) =>
  page.route(QUILL_JS, (route) => route.fulfill({ contentType: 'application/javascript', body: QUILL_STUB }));

// The admin's page, wide enough for the live previews (narrow screens skip them), with or without the Quill stub.
async function adminPage(quill: boolean): Promise<Page> {
  const page = await h.newPage();
  await page.setViewportSize({ width: 1440, height: 2000 });
  if (quill) await serveQuillStub(page);
  page.on('dialog', (dialog) => {
    void dialog.accept();
  });
  await h.openApp(page, 'admin');
  return page;
}

// The marker counter, once every image in the page has settled. A control image whose handler must run goes in last;
// after it ran and every image is complete, a handler that got through has one bounded chance to run (an image's
// error event comes in a task after the image is complete).
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

// Waits until the element shows the text.
async function shows(page: Page, selector: string, text: string): Promise<void> {
  await page.waitForFunction(
    ({ selector, text }) => (document.querySelector(selector)?.textContent ?? '').includes(text),
    { selector, text },
    { timeout: 15_000 },
  );
}

interface Formatting {
  bold: string[];
  small: string[];
  bullets: string[];
  handlers: number;
}
// What the elements under selector keep of the formatting, and how many of them have an error handler.
async function formatting(page: Page, selector: string): Promise<Formatting> {
  return h.run<Formatting>(
    page,
    `const under = (q) => Array.from(document.querySelectorAll(${JSON.stringify(selector)} + ' ' + q), (e) => e.textContent.trim());
    return {
      bold: under('strong'),
      small: under('span[style="font-size: 9pt;"]'),
      bullets: under('li[data-list="bullet"]'),
      handlers: document.querySelectorAll(${JSON.stringify(selector)} + ' [onerror]').length,
    };`,
  );
}
// The formatting of rich(label) for each label, and no handler.
const kept = (labels: string[]) => ({
  bold: expect.arrayContaining(labels.map((l) => `${l} fett`)),
  small: expect.arrayContaining(labels.map((l) => `${l} klein`)),
  bullets: expect.arrayContaining(labels.map((l) => `${l} Punkt`)),
  handlers: 0,
});
// An editor that pastes its value: the stub's paste keeps the text only, so nothing but the text is left.
const textOnly: Formatting = { bold: [], small: [], bullets: [], handlers: 0 };

// What the app's sanitizer makes of html, trimmed as the forms trim a value before they save it.
const sanitized = (page: Page, html: string) =>
  h.run<string>(page, `return sanitizeRichHtml(${JSON.stringify(html)}).trim();`);

interface Doc {
  table: TableName;
  items: TableName;
  link: string;
  open: string;
  preview: string;
  editors: [string, string];
  itemForm: string;
  fid: string;
  fields?: Record<string, unknown>;
}
const DOCUMENTS: Doc[] = [
  {
    table: 'Quote',
    items: 'QuoteItem',
    link: 'quote_id',
    open: 'openQuoteModal',
    preview: 'quotePreview',
    editors: ['quote_intro_editor', 'quote_notes_editor'],
    itemForm: 'showQuoteItemInlineForm',
    fid: 'qif_',
    // The closing text on a page of its own: the pagination's second measuring path.
    fields: { force_closing_new_page: true },
  },
  {
    table: 'Order',
    items: 'OrderItem',
    link: 'order_id',
    open: 'openOrderModal',
    preview: 'orderPreview',
    editors: ['order_intro_editor', 'order_closing_editor'],
    itemForm: 'showOrderItemInlineForm',
    fid: 'oif_',
  },
  {
    table: 'SupplierOrder',
    items: 'SupplierOrderItem',
    link: 'purchase_id',
    open: 'openSupplierOrderModal',
    preview: 'purchasePreview',
    editors: ['purchase_intro_editor', 'purchase_closing_editor'],
    itemForm: 'showPurchaseItemInlineForm',
    fid: 'pif_',
  },
  {
    table: 'DeliveryNote',
    items: 'DeliveryNoteItem',
    link: 'delivery_id',
    open: 'openDeliveryNoteModal',
    preview: 'deliveryPreview',
    editors: ['delivery_intro_editor', 'delivery_closing_editor'],
    itemForm: 'showDeliveryItemInlineForm',
    fid: 'dif_',
  },
  {
    table: 'Invoice',
    items: 'InvoiceItem',
    link: 'invoice_id',
    open: 'openInvoiceModal',
    preview: 'invoicePreview',
    editors: ['invoice_intro_editor', 'invoice_closing_editor'],
    itemForm: 'showInvoiceItemInlineForm',
    fid: 'iif_',
  },
];

// vera writes a document with one item, with rich text in every rich-text field.
async function plantDocument(doc: Doc) {
  const docId = await plant(doc.table, {
    company_id: [h.companies.alpha],
    status: 'Entwurf',
    description: rich('Einleitung'),
    notes: rich('Schlusstext'),
    ...doc.fields,
  });
  const itemId = await plant(doc.items, {
    [doc.link]: [docId],
    pos: 1,
    qty: 1,
    unit: 'Stück',
    unit_price_net: 10,
    vat_rate: 19,
    description: rich('Position'),
  });
  const records: [TableName, string][] = [
    [doc.table, docId],
    [doc.items, itemId],
  ];
  const before = await storedFields(records);
  // The server stores what vera sent, marker included.
  expect(before.map((f) => f.description)).toEqual([rich('Einleitung'), rich('Position')]);
  return { docId, itemId, records, before };
}

describe('the admin opens a document that vera wrote', () => {
  it.each(DOCUMENTS)('$table: the modal, the live preview and its pages', async (doc) => {
    const { docId, records, before } = await plantDocument(doc);
    const page = await adminPage(false);
    await h.run(page, `await ${doc.open}(${JSON.stringify(docId)});`);
    await previewShows(page, doc.preview, ['Einleitung fett', 'Schlusstext fett', 'Position fett']);
    expect(await hits(page)).toBe(null);
    expect(await formatting(page, `#${doc.preview} .quote-sheet`)).toEqual(kept(['Einleitung', 'Schlusstext', 'Position']));
    expect(await storedFields(records)).toEqual(before);
    await h.assertClean(page);
  });

  it.each(DOCUMENTS)('$table: the editors of the document and of its item', async (doc) => {
    const { docId, itemId, records, before } = await plantDocument(doc);
    const page = await adminPage(true);
    const [intro, closing] = doc.editors;
    const item = `#${doc.fid}${itemId}_description_editor`;
    await h.run(page, `await ${doc.open}(${JSON.stringify(docId)});`);
    await shows(page, `#${intro} .ql-editor`, 'Einleitung fett');
    await shows(page, `#${closing} .ql-editor`, 'Schlusstext fett');
    await h.run(page, `await ${doc.itemForm}(${JSON.stringify(docId)}, ${JSON.stringify(itemId)});`);
    await shows(page, `${item} .ql-editor`, 'Position fett');
    expect(await hits(page)).toBe(null);
    expect({
      intro: await formatting(page, `#${intro} .ql-editor`),
      closing: await formatting(page, `#${closing} .ql-editor`),
      item: await formatting(page, `${item} .ql-editor`),
    }).toEqual({
      intro: kept(['Einleitung']),
      closing: kept(['Schlusstext']),
      // The Quote item editor pastes the description.
      item: doc.table === 'Quote' ? textOnly : kept(['Position']),
    });
    expect(await storedFields(records)).toEqual(before);
    await h.assertClean(page);
  });

  it('Quote: the full-screen editor and the e-mail editor', async () => {
    const customerId = await plant('Customer', {
      company_id: [h.companies.alpha],
      name1: 'Kunde Vera',
      email: 'kunde@example.test',
      status: 'aktiv',
    });
    const quoteId = await plant('Quote', {
      company_id: [h.companies.alpha],
      customer_id: [customerId],
      status: 'Entwurf',
      description: rich('Einleitung'),
      notes: rich('Schlusstext'),
    });
    const templateId = await plant('Textemplate', {
      company_id: [h.companies.alpha],
      doc_type: 'E-Mail',
      status: 'aktiv',
      name: 'Angebot per E-Mail',
      subject: 'Ihr Angebot',
      content: rich('Nachricht'),
    });
    const records: [TableName, string][] = [
      ['Customer', customerId],
      ['Quote', quoteId],
      ['Textemplate', templateId],
    ];
    const before = await storedFields(records);
    // Quill arrives only after the modal opened (its first load failed), so the full-screen editor takes the stored
    // value from the hidden input, as the preview does.
    const page = await adminPage(false);
    await h.run(page, `await openQuoteModal(${JSON.stringify(quoteId)});`);
    await previewShows(page, 'quotePreview', ['Einleitung fett']);
    await serveQuillStub(page);
    await h.run(page, `expandTextField('description', 'Einleitung');`);
    await shows(page, '#expandedQuillEditor .ql-editor', 'Einleitung fett');
    const expanded = await formatting(page, '#expandedQuillEditor .ql-editor');
    await h.run(page, 'closeModal2();');
    await h.run(page, 'await emailQuote();');
    await shows(page, '#eqBodyEditor .ql-editor', 'Nachricht fett');
    expect(await hits(page)).toBe(null);
    // The e-mail editor pastes the template.
    expect({ expanded, email: await formatting(page, '#eqBodyEditor .ql-editor') }).toEqual({
      expanded: kept(['Einleitung']),
      email: textOnly,
    });
    expect(await storedFields(records)).toEqual(before);
    await h.assertClean(page);
  });

  it('Article: the description editor', async () => {
    const articleId = await plant('Article', {
      company_id: [h.companies.alpha],
      status: 'aktiv',
      name1: 'Drahtseil',
      description: rich('Artikel'),
    });
    const before = await storedFields([['Article', articleId]]);
    const page = await adminPage(true);
    await h.run(page, `await openArticleModal(${JSON.stringify(articleId)});`);
    await shows(page, '#article_description_editor .ql-editor', 'Artikel fett');
    expect(await hits(page)).toBe(null);
    expect(await formatting(page, '#article_description_editor .ql-editor')).toEqual(kept(['Artikel']));
    expect(await storedFields([['Article', articleId]])).toEqual(before);
    await h.assertClean(page);
  });
});

describe('templates and bundles that vera wrote', () => {
  it('Quote: the template editor shows the template, and the admin picks it for the intro and saves', async () => {
    const templateId = await plant('Textemplate', {
      company_id: [h.companies.alpha],
      doc_type: 'Angebot',
      section: 'Einleitung',
      status: 'aktiv',
      name: 'Vorlage von Vera',
      content: rich('Vorlage'),
    });
    const quoteId = await plant('Quote', { company_id: [h.companies.alpha], status: 'Entwurf' });
    const template = await storedFields([['Textemplate', templateId]]);
    const page = await adminPage(true);
    // The template's own editor, which pastes the content.
    await h.run(page, `await openTemplateModal(${JSON.stringify(templateId)});`);
    await shows(page, '#tpl_content_editor .ql-editor', 'Vorlage fett');
    const inTemplateEditor = await formatting(page, '#tpl_content_editor .ql-editor');
    await h.run(page, 'closeModal();');
    // The Quote's template picker for the intro.
    await h.run(page, `await openQuoteModal(${JSON.stringify(quoteId)});`);
    await page.waitForSelector('#quote_intro_editor .ql-editor', { state: 'attached' });
    // The intro section is folded away until the admin shows it.
    await page.click('#quoteAdvancedToggle');
    await page.selectOption('#modalBox select[data-tpl-field="description"]', templateId);
    await shows(page, '#quote_intro_editor .ql-editor', 'Vorlage fett');
    await previewShows(page, 'quotePreview', ['Vorlage fett']);
    const inEditor = await formatting(page, '#quote_intro_editor .ql-editor');
    const inPreview = await formatting(page, '#quotePreview .quote-sheet');
    await page.dispatchEvent('#modalBox form[data-quote-form] button[type="submit"]', 'click');
    await page.locator('#toastWrap', { hasText: 'Gespeichert' }).waitFor();
    const [quote] = await storedFields([['Quote', quoteId]]);
    expect({ hits: await hits(page), description: quote?.description }).toEqual({
      hits: null,
      description: await sanitized(page, rich('Vorlage')),
    });
    expect({ inTemplateEditor, inEditor, inPreview }).toEqual({
      inTemplateEditor: textOnly,
      inEditor: kept(['Vorlage']),
      inPreview: kept(['Vorlage']),
    });
    expect(await storedFields([['Textemplate', templateId]])).toEqual(template);
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
  // The intro and closing editors of a document's modal.
  const editorsOf = (table: TableName): [string, string] => {
    const doc = DOCUMENTS.find((d) => d.table === table);
    if (!doc) throw new Error(`no document ${table}`);
    return [`#${doc.editors[0]} .ql-editor`, `#${doc.editors[1]} .ql-editor`];
  };

  it.each(BUNDLES)('$table: the admin applies a bundle of templates and saves', async ({ table, docType, open, preview, form }) => {
    const template = (section: string, name: string, label: string) =>
      plant('Textemplate', {
        company_id: [h.companies.alpha],
        doc_type: docType,
        section,
        status: 'aktiv',
        name,
        content: rich(label),
      });
    const introId = await template('Einleitung', 'Einleitung von Vera', 'Paket Einleitung');
    const closingId = await template('Schlusstext', 'Schluss von Vera', 'Paket Schluss');
    const bundleId = await plant('QuoteBundle', {
      company_id: h.companies.alpha,
      doc_type: docType,
      status: 'aktiv',
      name: 'Paket von Vera',
      intro_template_id: introId,
      closing_template_id: closingId,
    });
    const docId = await plant(table, { company_id: [h.companies.alpha], status: 'Entwurf' });
    const sources: [TableName, string][] = [
      ['Textemplate', introId],
      ['Textemplate', closingId],
      ['QuoteBundle', bundleId],
    ];
    const before = await storedFields(sources);
    const page = await adminPage(true);
    const [intro, closing] = editorsOf(table);
    await h.run(page, `await ${open}(${JSON.stringify(docId)});`);
    await page.waitForSelector(intro, { state: 'attached' });
    await page.waitForSelector(closing, { state: 'attached' });
    await page.selectOption('#modalBox select[name="bundle_id"]', bundleId);
    await shows(page, intro, 'Paket Einleitung fett');
    await shows(page, closing, 'Paket Schluss fett');
    await previewShows(page, preview, ['Paket Einleitung fett', 'Paket Schluss fett']);
    const inEditors = { intro: await formatting(page, intro), closing: await formatting(page, closing) };
    const inPreview = await formatting(page, `#${preview} .quote-sheet`);
    await page.dispatchEvent(`#modalBox form[${form}] button[type="submit"]`, 'click');
    await page.locator('#toastWrap', { hasText: 'Gespeichert' }).waitFor();
    const [stored] = await storedFields([[table, docId]]);
    expect({ hits: await hits(page), description: stored?.description, notes: stored?.notes }).toEqual({
      hits: null,
      description: await sanitized(page, rich('Paket Einleitung')),
      notes: await sanitized(page, rich('Paket Schluss')),
    });
    expect({ inEditors, inPreview }).toEqual({
      inEditors: { intro: kept(['Paket Einleitung']), closing: kept(['Paket Schluss']) },
      inPreview: kept(['Paket Einleitung', 'Paket Schluss']),
    });
    expect(await storedFields(sources)).toEqual(before);
    await h.assertClean(page);
  });
});
