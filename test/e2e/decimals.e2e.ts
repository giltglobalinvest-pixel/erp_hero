// test/e2e/decimals.e2e.ts
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

const insert = (table: TableName, fields: Record<string, unknown>) =>
  h.deps.db.write((tx) => h.deps.records.insert(tx, table, fields));
const stored = async (table: TableName, id: string): Promise<Record<string, unknown>> =>
  (await h.deps.records.list(table)).find((r) => r.id === id)?.fields ?? {};
const storedItems = async (table: TableName, link: string, docId: string) =>
  (await h.deps.records.list(table)).filter((r) => [r.fields[link]].flat().includes(docId));
const pick = (fields: Record<string, unknown>, names: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(names.map((name) => [name, fields[name]]));

describe('a decimal shown in a form is stored unchanged when the form is saved', () => {
  it('Article: only the name is changed', async () => {
    const article = await insert('Article', {
      company_id: [h.companies.alpha],
      name1: 'Seil',
      status: 'aktiv',
      sales_price: 12.5,
      purchase_price: 7.25,
      vat_rate: 19,
    });
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    await h.run(page, `await openArticleModal(${JSON.stringify(article.id)});`);
    const shown: Record<string, string> = {};
    for (const name of ['sales_price', 'purchase_price', 'vat_rate']) {
      shown[name] = await page.inputValue(`#modalBox input[name="${name}"]`);
    }
    await page.fill('#modalBox input[name="name1"]', 'Seil lang');
    await page.dispatchEvent('#modalBox button[type="submit"]', 'click');
    await page.locator('#toastWrap', { hasText: 'Gespeichert' }).waitFor();
    const f = await stored('Article', article.id);
    expect({ shown, stored: pick(f, ['name1', 'sales_price', 'purchase_price', 'vat_rate']) }).toEqual({
      shown: { sales_price: '12,5', purchase_price: '7,25', vat_rate: '19' },
      stored: { name1: 'Seil lang', sales_price: 12.5, purchase_price: 7.25, vat_rate: 19 },
    });
    await h.assertClean(page);
  });

  // An item as it is stored, and as its form shows it: a decimal comma and no thousands dots.
  const ITEM: Record<string, number> = { qty: 2.5, unit_price_net: 12.5, discount_pct: 0, vat_rate: 19, purchase_price: 7.25, line_total_net: 31.25 };
  const SHOWN: Record<string, string> = { qty: '2,5', unit_price_net: '12,5', discount_pct: '0', vat_rate: '19', purchase_price: '7,25' };
  const PRICED = ['qty', 'unit_price_net', 'discount_pct', 'vat_rate'] as const;
  const editors = [
    {
      table: 'Quote',
      open: 'openQuoteModal',
      items: 'QuoteItem',
      link: 'quote_id',
      form: 'showQuoteItemInlineForm',
      fid: 'qif_',
      save: 'saveQuoteItemInline',
      inputs: [...PRICED, 'purchase_price'],
      total: true,
    },
    {
      table: 'Order',
      open: 'openOrderModal',
      items: 'OrderItem',
      link: 'order_id',
      form: 'showOrderItemInlineForm',
      fid: 'oif_',
      save: 'saveOrderItemInline',
      inputs: PRICED,
      total: true,
    },
    {
      table: 'SupplierOrder',
      open: 'openSupplierOrderModal',
      items: 'SupplierOrderItem',
      link: 'purchase_id',
      form: 'showPurchaseItemInlineForm',
      fid: 'pif_',
      save: 'savePurchaseItemInline',
      inputs: PRICED,
      total: true,
    },
    {
      table: 'DeliveryNote',
      open: 'openDeliveryNoteModal',
      items: 'DeliveryNoteItem',
      link: 'delivery_id',
      form: 'showDeliveryItemInlineForm',
      fid: 'dif_',
      save: 'saveDeliveryItemInline',
      inputs: ['qty'],
      total: false,
    },
    {
      table: 'Invoice',
      open: 'openInvoiceModal',
      items: 'InvoiceItem',
      link: 'invoice_id',
      form: 'showInvoiceItemInlineForm',
      fid: 'iif_',
      save: 'saveInvoiceItemInline',
      inputs: PRICED,
      total: true,
    },
  ] as const;

  it.each(editors)('$items: the item form is saved unchanged', async ({ table, open, items, link, form, fid, save, inputs, total }) => {
    const names: string[] = total ? [...inputs, 'line_total_net'] : [...inputs];
    const doc = await insert(table, { company_id: [h.companies.alpha], status: 'Entwurf' });
    const item = await insert(items, { [link]: [doc.id], pos: 1, ...pick(ITEM, names), description: '<p>Seil</p>' });
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    await h.run(page, `await ${open}(${JSON.stringify(doc.id)});`);
    await h.run(page, `await ${form}(${JSON.stringify(doc.id)}, ${JSON.stringify(item.id)});`);
    const shown: Record<string, string> = {};
    for (const name of inputs) shown[name] = await page.inputValue(`#${fid}${item.id}_${name}`);
    await page.dispatchEvent(`#modalBox button[onclick^="${save}"]`, 'click');
    await page.locator('#toastWrap', { hasText: 'Position gespeichert' }).waitFor();
    expect({ shown, stored: pick(await stored(items, item.id), names) }).toEqual({ shown: pick(SHOWN, inputs), stored: pick(ITEM, names) });
    await h.assertClean(page);
  });

  it("ArticleSupplier: the supplier's form is saved unchanged", async () => {
    const article = await insert('Article', { company_id: [h.companies.alpha], name1: 'Seil', status: 'aktiv' });
    const supplier = await insert('Supplier', { company_id: [h.companies.alpha], name1: 'Seilerei', status: 'aktiv' });
    const junction = await insert('ArticleSupplier', { article_id: [article.id], supplier_id: [supplier.id], purchase_price: 7.25, is_default: true });
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    await h.run(page, `await openArticleModal(${JSON.stringify(article.id)});`);
    await h.run(page, `await showArticleSupplierInlineForm(${JSON.stringify(article.id)}, ${JSON.stringify(junction.id)});`);
    const shown = await page.inputValue(`#asf_${junction.id}_purchase_price`);
    await page.dispatchEvent('#modalBox button[onclick^="saveArticleSupplierInline"]', 'click');
    await page.locator('#toastWrap', { hasText: 'Gespeichert' }).waitFor();
    const f = await stored('ArticleSupplier', junction.id);
    expect({ shown, stored: pick(f, ['supplier_id', 'purchase_price']) }).toEqual({
      shown: '7,25',
      stored: { supplier_id: [supplier.id], purchase_price: 7.25 },
    });
    await h.assertClean(page);
  });
});

describe('a price filled in from the article or its supplier is stored as the form shows it', () => {
  const editors = [
    {
      table: 'Quote',
      open: 'openQuoteModal',
      items: 'QuoteItem',
      link: 'quote_id',
      add: '#addQiBtn',
      fid: 'qif_new',
      save: 'saveQuoteItemInline',
      price: 149.9,
      shown: '149,9',
    },
    {
      table: 'Order',
      open: 'openOrderModal',
      items: 'OrderItem',
      link: 'order_id',
      add: '#addOiBtn',
      fid: 'oif_new',
      save: 'saveOrderItemInline',
      price: 149.9,
      shown: '149,9',
    },
    // A supplier order takes the article's EK instead of its sales price.
    {
      table: 'SupplierOrder',
      open: 'openSupplierOrderModal',
      items: 'SupplierOrderItem',
      link: 'purchase_id',
      add: '#addPiBtn',
      fid: 'pif_new',
      save: 'savePurchaseItemInline',
      price: 7.25,
      shown: '7,25',
    },
    {
      table: 'Invoice',
      open: 'openInvoiceModal',
      items: 'InvoiceItem',
      link: 'invoice_id',
      add: '#addIiBtn',
      fid: 'iif_new',
      save: 'saveInvoiceItemInline',
      price: 149.9,
      shown: '149,9',
    },
  ] as const;

  it.each(editors)('$items: a new item takes the price of the picked article', async ({ table, open, items, link, add, fid, save, price, shown }) => {
    const article = await insert('Article', {
      company_id: [h.companies.alpha],
      name1: 'Kabel',
      status: 'aktiv',
      sales_price: 149.9,
      purchase_price: 7.25,
      vat_rate: 19,
    });
    const doc = await insert(table, { company_id: [h.companies.alpha], status: 'Entwurf' });
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    await h.run(page, `await ${open}(${JSON.stringify(doc.id)});`);
    await page.dispatchEvent(`#modalBox ${add}`, 'click');
    await page.waitForSelector(`#${fid}_qty`);
    // The article combobox calls this when the user picks an entry. Without Quill it also fills the description.
    await h.run(page, `onComboboxSelect(${JSON.stringify(`${fid}_article`)}, ${JSON.stringify(article.id)});`);
    const shownPrice = await page.inputValue(`#${fid}_unit_price_net`);
    await page.dispatchEvent(`#modalBox button[onclick^="${save}"]`, 'click');
    await page.locator('#toastWrap', { hasText: 'Position gespeichert' }).waitFor();
    const rows = await storedItems(items, link, doc.id);
    expect({ shown: shownPrice, stored: rows.map((r) => pick(r.fields, ['qty', 'unit_price_net', 'vat_rate', 'line_total_net'])) }).toEqual({
      shown,
      stored: [{ qty: 1, unit_price_net: price, vat_rate: 19, line_total_net: price }],
    });
    await h.assertClean(page);
  });

  const articleWithTwoSuppliers = async () => {
    const article = await insert('Article', { company_id: [h.companies.alpha], name1: 'Kabel', status: 'aktiv', sales_price: 149.9, vat_rate: 19 });
    const main = await insert('Supplier', { company_id: [h.companies.alpha], name1: 'Hauptlieferant', status: 'aktiv' });
    const other = await insert('Supplier', { company_id: [h.companies.alpha], name1: 'Zweitlieferant', status: 'aktiv' });
    await insert('ArticleSupplier', { article_id: [article.id], supplier_id: [main.id], purchase_price: 7.25, is_default: true });
    await insert('ArticleSupplier', { article_id: [article.id], supplier_id: [other.id], purchase_price: 8.4 });
    return { article, main, other };
  };

  it("QuoteItem: a new item takes the EK of the article's main supplier, and of another supplier when chosen", async () => {
    const { article, other } = await articleWithTwoSuppliers();
    const quote = await insert('Quote', { company_id: [h.companies.alpha], status: 'Entwurf' });
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    await h.run(page, `await openQuoteModal(${JSON.stringify(quote.id)});`);
    await page.dispatchEvent('#modalBox #addQiBtn', 'click');
    await page.waitForSelector('#qif_new_qty');
    await h.run(page, `onComboboxSelect('qif_new_article', ${JSON.stringify(article.id)});`);
    const shownMain = await page.inputValue('#qif_new_purchase_price');
    await page.selectOption('#qif_new_supplier', other.id);
    const shownOther = await page.inputValue('#qif_new_purchase_price');
    await page.dispatchEvent('#modalBox button[onclick^="saveQuoteItemInline"]', 'click');
    await page.locator('#toastWrap', { hasText: 'Position gespeichert' }).waitFor();
    const rows = await storedItems('QuoteItem', 'quote_id', quote.id);
    expect({ shown: [shownMain, shownOther], stored: rows.map((r) => pick(r.fields, ['supplier_id', 'purchase_price'])) }).toEqual({
      shown: ['7,25', '8,4'],
      stored: [{ supplier_id: [other.id], purchase_price: 8.4 }],
    });
    await h.assertClean(page);
  });

  it('QuoteItem: the edit form takes the EK of another supplier when chosen', async () => {
    const { article, main, other } = await articleWithTwoSuppliers();
    const quote = await insert('Quote', { company_id: [h.companies.alpha], status: 'Entwurf' });
    const item = await insert('QuoteItem', {
      quote_id: [quote.id],
      article_id: [article.id],
      supplier_id: [main.id],
      pos: 1,
      qty: 1,
      unit_price_net: 149.9,
      discount_pct: 0,
      vat_rate: 19,
      purchase_price: 7.25,
      line_total_net: 149.9,
      description: '<p>Kabel</p>',
    });
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    await h.run(page, `await openQuoteModal(${JSON.stringify(quote.id)});`);
    await h.run(page, `await showQuoteItemInlineForm(${JSON.stringify(quote.id)}, ${JSON.stringify(item.id)});`);
    await page.selectOption(`#qif_${item.id}_supplier`, other.id);
    const shown = await page.inputValue(`#qif_${item.id}_purchase_price`);
    await page.dispatchEvent('#modalBox button[onclick^="saveQuoteItemInline"]', 'click');
    await page.locator('#toastWrap', { hasText: 'Position gespeichert' }).waitFor();
    expect({ shown, stored: pick(await stored('QuoteItem', item.id), ['supplier_id', 'purchase_price']) }).toEqual({
      shown: '8,4',
      stored: { supplier_id: [other.id], purchase_price: 8.4 },
    });
    await h.assertClean(page);
  });

  it('Article: the EK taken over from the main supplier', async () => {
    const article = await insert('Article', { company_id: [h.companies.alpha], name1: 'Seil', status: 'aktiv', sales_price: 12.5, vat_rate: 19 });
    const supplier = await insert('Supplier', { company_id: [h.companies.alpha], name1: 'Seilerei', status: 'aktiv' });
    await insert('ArticleSupplier', { article_id: [article.id], supplier_id: [supplier.id], purchase_price: 7.25, is_default: true });
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    await h.run(page, `await openArticleModal(${JSON.stringify(article.id)});`);
    await page.dispatchEvent('#modalBox button[onclick^="copyDefaultSupplierPrice"]', 'click');
    await page.locator('#toastWrap', { hasText: 'EK übernommen' }).waitFor();
    const shown = await page.inputValue('#art_purchase_price');
    await page.dispatchEvent('#modalBox button[type="submit"]', 'click');
    await page.locator('#toastWrap', { hasText: 'Gespeichert' }).waitFor();
    expect({ shown, stored: (await stored('Article', article.id)).purchase_price }).toEqual({ shown: '7,25', stored: 7.25 });
    await h.assertClean(page);
  });
});

describe('parseDecimal and formatDecimalInput in the page', () => {
  it('parseDecimal reads German grouping and a decimal comma, and a lone dot as the decimal point', async () => {
    const typed = ['12,50', '1.234,5', '1.234', '12.500', '1.234.567', '12.5', '0.125', '149.90', '', 'abc'];
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    const read = await h.run<unknown[]>(page, `return ${JSON.stringify(typed)}.map((s) => parseDecimal(s));`);
    expect(Object.fromEntries(typed.map((s, i) => [s, read[i]]))).toEqual({
      '12,50': 12.5,
      '1.234,5': 1234.5,
      '1.234': 1234,
      '12.500': 12500,
      '1.234.567': 1234567,
      '12.5': 12.5,
      '0.125': 0.125,
      '149.90': 149.9,
      '': null,
      abc: null,
    });
    await h.assertClean(page);
  });

  it('formatDecimalInput shows a number with a decimal comma that parseDecimal reads back exactly', async () => {
    const values = [0, 1, 2.5, 12.5, 0.125, 1.234, 7.25, 149.9, 1234.56, 12500, -3.75, 0.19, 19];
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    const result = await h.run<{ roundTrip: unknown[]; shown: unknown[] }>(
      page,
      `return {
         roundTrip: ${JSON.stringify(values)}.map((x) => parseDecimal(formatDecimalInput(x))),
         shown: [null, undefined, '', 12.5, 1234.56, -3.75, '12.5', '19', '12,50', 'abc'].map((v) => formatDecimalInput(v)),
       };`,
    );
    expect(result).toEqual({
      roundTrip: values,
      // Empty stays empty, a legacy plain-decimal text is shown like its number, any other text is left as it is.
      shown: ['', '', '', '12,5', '1234,56', '-3,75', '12,5', '19', '12,50', 'abc'],
    });
    await h.assertClean(page);
  });
});
