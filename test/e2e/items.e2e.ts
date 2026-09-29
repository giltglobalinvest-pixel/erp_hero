// test/e2e/items.e2e.ts
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
