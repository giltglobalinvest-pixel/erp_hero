// test/e2e/items.e2e.ts
import type { Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { TableName } from '../../server/data/tables.js';
import { startHarness, type Harness } from './harness.js';

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

// Written straight into the database: the API refuses text in number fields, but older data or an import can hold it.
const insert = (table: TableName, fields: Record<string, unknown>) =>
  h.deps.db.write((tx) => h.deps.records.insert(tx, table, fields));
// Harmless markup that also ends an attribute: the tests count whether the browser built a <b> element from it.
const MARK = '"><b>fett</b>';
const boldInModal = `return [...document.querySelectorAll('#modalBox b')].filter((e) => e.textContent === 'fett').length;`;

describe('number fields of documents are shown as text, never as markup', () => {
  const documents = [
    { table: 'Quote', open: 'openQuoteModal', items: 'QuoteItem', link: 'quote_id', form: 'showQuoteItemInlineForm', fid: 'qif_' },
    { table: 'Order', open: 'openOrderModal', items: 'OrderItem', link: 'order_id', form: 'showOrderItemInlineForm', fid: 'oif_' },
    {
      table: 'SupplierOrder',
      open: 'openSupplierOrderModal',
      items: 'SupplierOrderItem',
      link: 'purchase_id',
      form: 'showPurchaseItemInlineForm',
      fid: 'pif_',
    },
    {
      table: 'DeliveryNote',
      open: 'openDeliveryNoteModal',
      items: 'DeliveryNoteItem',
      link: 'delivery_id',
      form: 'showDeliveryItemInlineForm',
      fid: 'dif_',
    },
    { table: 'Invoice', open: 'openInvoiceModal', items: 'InvoiceItem', link: 'invoice_id', form: 'showInvoiceItemInlineForm', fid: 'iif_' },
  ] as const;

  it.each(documents)('$items: the item row and its edit form', async ({ table, open, items, link, form, fid }) => {
    const doc = await insert(table, { company_id: [h.companies.alpha], status: 'Entwurf' });
    const item = await insert(items, {
      [link]: [doc.id],
      pos: MARK,
      qty: MARK,
      unit_price_net: MARK,
      discount_pct: MARK,
      vat_rate: MARK,
      purchase_price: MARK,
      description: '<p>Seil</p>',
    });
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    await h.run(page, `await ${open}(${JSON.stringify(doc.id)});`);
    expect(await h.run<number>(page, boldInModal)).toBe(0);
    expect(await page.locator('#modalBox').innerText()).toContain(`Pos. ${MARK}`);

    await h.run(page, `await ${form}(${JSON.stringify(doc.id)}, ${JSON.stringify(item.id)});`);
    expect(await h.run<number>(page, boldInModal)).toBe(0);
    expect(await page.inputValue(`#${fid}${item.id}_qty`)).toBe(MARK);
    await h.assertClean(page);
  });

  it('Article: the price fields of the article and of its supplier', async () => {
    const article = await insert('Article', {
      company_id: [h.companies.alpha],
      name1: 'Seil',
      status: 'aktiv',
      purchase_price: MARK,
      sales_price: MARK,
      vat_rate: MARK,
    });
    const junction = await insert('ArticleSupplier', { article_id: [article.id], purchase_price: MARK });
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    await h.run(page, `await openArticleModal(${JSON.stringify(article.id)});`);
    expect(await h.run<number>(page, boldInModal)).toBe(0);
    expect(await page.inputValue('#modalBox input[name="sales_price"]')).toBe(MARK);

    await h.run(page, `await showArticleSupplierInlineForm(${JSON.stringify(article.id)}, ${JSON.stringify(junction.id)});`);
    expect(await h.run<number>(page, boldInModal)).toBe(0);
    expect(await page.inputValue(`#asf_${junction.id}_purchase_price`)).toBe(MARK);
    await h.assertClean(page);
  });
});

describe('saving an item through the form', () => {
  const flows = [
    { table: 'Quote', open: 'openQuoteModal', items: 'QuoteItem', link: 'quote_id', add: '#addQiBtn', fid: 'qif_new', save: 'saveQuoteItemInline' },
    { table: 'Order', open: 'openOrderModal', items: 'OrderItem', link: 'order_id', add: '#addOiBtn', fid: 'oif_new', save: 'saveOrderItemInline' },
  ] as const;

  it.each(flows)('$items: stores what the user typed as numbers', async ({ table, open, items, link, add, fid, save }) => {
    const doc = await insert(table, { company_id: [h.companies.alpha], status: 'Entwurf' });
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    await h.run(page, `await ${open}(${JSON.stringify(doc.id)});`);
    await page.dispatchEvent(`#modalBox ${add}`, 'click');
    await page.waitForSelector(`#${fid}_qty`);
    await page.fill(`#${fid}_qty`, '2,5');
    await page.fill(`#${fid}_unit_price_net`, '10,50');
    await page.fill(`#${fid}_discount_pct`, '0');
    // The Quill editor is not loaded in the tests; the form reads the description from its hidden field.
    await h.run(page, `document.getElementById(${JSON.stringify(`${fid}_description`)}).value = '<p>Seil</p>';`);
    await page.dispatchEvent(`#modalBox button[onclick^="${save}"]`, 'click');
    await page.locator('#toastWrap', { hasText: 'Position gespeichert' }).waitFor();
    const stored = (await h.deps.records.list(items)).filter((r) => [r.fields[link]].flat().includes(doc.id));
    const fields = ['pos', 'qty', 'unit_price_net', 'discount_pct', 'vat_rate', 'line_total_net'];
    expect(stored.map((r) => fields.map((name) => r.fields[name]))).toEqual([[1, 2.5, 10.5, 0, 19, 26.25]]);
    await h.assertClean(page);
  });
});

describe('a supplier id in the Quote item form is data, never markup', () => {
  // Any logged-in user can store any string in a link field. This planted supplier id ends the value attribute, adds an
  // attribute and an image whose error handler counts, and holds the characters an escape has to give back unchanged.
  const IMG = '/e2e-missing.png';
  const PLANTED = `recS" x="1"><img src="${IMG}" onerror="window.__qiImg=(window.__qiImg||0)+1">A & B &amp; C<`;
  let articleId = '';
  let normalId = '';
  beforeAll(async () => {
    articleId = (await insert('Article', { company_id: [h.companies.alpha], name1: 'Drahtseil 6 mm', status: 'aktiv', sales_price: 12 })).id;
    normalId = (await insert('Supplier', { company_id: [h.companies.alpha], name1: 'Stahlhandel Süd', supplier_no: 'L-100' })).id;
    // vera is not an admin. She links the article to both suppliers through the API; the planted one is the default.
    await h.apiAs('vera', 'POST', '/api/data/ArticleSupplier', {
      fields: { article_id: [articleId], supplier_id: [PLANTED], purchase_price: 3.25, is_default: true },
    });
    await h.apiAs('vera', 'POST', '/api/data/ArticleSupplier', {
      fields: { article_id: [articleId], supplier_id: [normalId], purchase_price: 7.5, is_default: false },
    });
  });

  // The admin's page, counting its requests for the planted image.
  async function adminPage(): Promise<{ page: Page; loads: () => number }> {
    const page = await h.newPage();
    let loads = 0;
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === IMG) loads++;
    });
    await h.openApp(page, 'admin');
    return { page, loads: () => loads };
  }
  async function openNewItem(page: Page, quoteId: string): Promise<void> {
    await h.run(page, `await openQuoteModal(${JSON.stringify(quoteId)});`);
    await page.dispatchEvent('#modalBox #addQiBtn', 'click');
    await page.waitForSelector('#qif_new_qty');
  }
  // Like a user: type into the article search, then press the entry the dropdown shows.
  async function pickArticle(page: Page): Promise<void> {
    await page.fill('#qif_new_article_search', 'Drahtseil');
    await page.locator('#qif_new_article_dropdown > div', { hasText: 'Drahtseil 6 mm' }).dispatchEvent('mousedown');
  }
  async function editItem(page: Page, itemId: string): Promise<void> {
    await page.dispatchEvent(`#modalBox [data-qi-row="${itemId}"] button[title="Bearbeiten"]`, 'click');
    await page.waitForSelector(`#qif_${itemId}_qty`);
  }
  async function save(page: Page): Promise<void> {
    await page.dispatchEvent('#modalBox button[onclick^="saveQuoteItemInline"]', 'click');
    await page.locator('#toastWrap', { hasText: 'Position gespeichert' }).waitFor();
  }
  const itemsOf = async (quoteId: string) =>
    (await h.deps.records.list('QuoteItem')).filter((r) => [r.fields.quote_id].flat().includes(quoteId));
  const supplierOf = (r: { fields: Record<string, unknown> }) => ({ supplier_id: r.fields.supplier_id, purchase_price: r.fields.purchase_price });

  // What the form shows for the supplier, read after a second, so that an image in it would have loaded and failed by then.
  async function picker(page: Page, loads: () => number, fid: string) {
    await page.waitForTimeout(1000);
    const seen = await h.run<Record<string, unknown>>(
      page,
      `const s = document.getElementById(${JSON.stringify(`${fid}_supplier`)});
       return {
         options: [...s.options].map((o) => ({ value: o.value, attributes: o.getAttributeNames(), text: o.textContent })),
         otherElements: [...s.querySelectorAll('*')].filter((e) => e.tagName !== 'OPTION').map((e) => e.tagName),
         chosen: s.value,
         purchasePrice: document.getElementById(${JSON.stringify(`${fid}_purchase_price`)}).value,
         ran: window.__qiImg ?? null,
       };`,
    );
    return { ...seen, loaded: loads() };
  }
  // The planted supplier is chosen, and every option has only the attributes the form sets.
  // No supplier record has the planted id, so the form names it '?'.
  const plantedChosen = () => ({
    options: [
      { value: '', attributes: ['value'], text: '— kein Lieferant —' },
      { value: PLANTED, attributes: ['value', 'data-ek', 'selected'], text: '★ ?' },
      { value: normalId, attributes: ['value', 'data-ek'], text: 'Stahlhandel Süd (L-100)' },
    ],
    otherElements: [],
    chosen: PLANTED,
    purchasePrice: '3,25',
    ran: null,
    loaded: 0,
  });

  it('picking the article: the planted supplier id is the option value, exactly, and adds no markup', async () => {
    const quote = await insert('Quote', { company_id: [h.companies.alpha], status: 'Entwurf' });
    const { page, loads } = await adminPage();
    await openNewItem(page, quote.id);
    await pickArticle(page);
    expect(await picker(page, loads, 'qif_new')).toEqual(plantedChosen());
    await save(page);
    expect((await itemsOf(quote.id)).map(supplierOf)).toEqual([{ supplier_id: [PLANTED], purchase_price: 3.25 }]);
    await h.assertClean(page);
  });

  it('editing an item that has the planted supplier: the same, and saving keeps the id', async () => {
    const quote = await insert('Quote', { company_id: [h.companies.alpha], status: 'Entwurf' });
    const item = await h.apiAs<{ id: string }>('vera', 'POST', '/api/data/QuoteItem', {
      fields: {
        quote_id: [quote.id],
        pos: 1,
        qty: 1,
        unit: 'Stück',
        unit_price_net: 12,
        discount_pct: 0,
        vat_rate: 19,
        description: '<p>Drahtseil 6 mm</p>',
        article_id: [articleId],
        supplier_id: [PLANTED],
        purchase_price: 3.25,
      },
    });
    const { page, loads } = await adminPage();
    await h.run(page, `await openQuoteModal(${JSON.stringify(quote.id)});`);
    await editItem(page, item.id);
    expect(await picker(page, loads, `qif_${item.id}`)).toEqual(plantedChosen());
    await save(page);
    expect((await itemsOf(quote.id)).map(supplierOf)).toEqual([{ supplier_id: [PLANTED], purchase_price: 3.25 }]);
    await h.assertClean(page);
  });

  it('a normal supplier id still selects, fills the purchase price from data-ek and is preselected when the item is edited', async () => {
    const quote = await insert('Quote', { company_id: [h.companies.alpha], status: 'Entwurf' });
    const { page } = await adminPage();
    await openNewItem(page, quote.id);
    await pickArticle(page);
    await page.selectOption('#qif_new_supplier', normalId);
    const chosen = (fid: string) => `const s = document.getElementById(${JSON.stringify(`${fid}_supplier`)});
      return { chosen: s.value, attributes: s.options[s.selectedIndex].getAttributeNames(),
               purchasePrice: document.getElementById(${JSON.stringify(`${fid}_purchase_price`)}).value };`;
    expect(await h.run(page, chosen('qif_new'))).toEqual({ chosen: normalId, attributes: ['value', 'data-ek'], purchasePrice: '7,5' });
    await save(page);
    const saved = await itemsOf(quote.id);
    expect(saved.map(supplierOf)).toEqual([{ supplier_id: [normalId], purchase_price: 7.5 }]);

    const savedId = saved[0]?.id ?? '';
    await editItem(page, savedId);
    expect(await h.run(page, chosen(`qif_${savedId}`))).toEqual({
      chosen: normalId,
      attributes: ['value', 'data-ek', 'selected'],
      purchasePrice: '7,5',
    });
    await h.assertClean(page);
  });
});
