import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';

let ctx: TestContext;
let cookie: string;

beforeEach(async () => {
  ctx = await createTestContext();
  ({ cookie } = await ctx.loginAs());
});
afterEach(async () => {
  await ctx.close();
});

const create = (table: string, body: Record<string, unknown>) => ctx.req(`/api/data/${table}`, { method: 'POST', cookie, body });
const seed = (table: 'Invoice' | 'Order' | 'Quote' | 'Customer', fields: Record<string, unknown>) =>
  ctx.deps.db.write((tx) => ctx.deps.records.insert(tx, table, fields));

describe('number assignment on create', () => {
  it('starts each type at its floor + 1 with the right prefix', async () => {
    const cases: [string, string, string, Record<string, unknown>][] = [
      ['Customer', 'customer_no', 'K-1001', { company_id: ['recC1'] }],
      ['Supplier', 'supplier_no', 'L-1001', { company_id: ['recC1'] }],
      ['Article', 'article_no', 'A-10001', { company_id: ['recC1'] }],
      ['Inquiry', 'inquiry_no', 'AN-1001', { company_id: ['recC1'] }],
      ['Quote', 'quote_no', 'Q-1001', { company_id: ['recC1'] }],
      ['Order', 'order_no', 'AB-1001', { company_id: 'recC1' }],
      ['SupplierOrder', 'purchase_no', 'B-1001', { company_id: 'recC1' }],
      ['DeliveryNote', 'delivery_no', 'L-1001', { company_id: 'recC1' }],
      ['Invoice', 'invoice_no', 'R-1001', { company_id: 'recC1' }],
    ];
    for (const [table, field, expected, fields] of cases) {
      const res = await create(table, { fields, assignNumber: true });
      expect(res.status).toBe(200);
      expect((await res.json()).fields[field]).toBe(expected);
    }
  });

  it('continues after the highest existing number of the same company, matching string and array company_id', async () => {
    await seed('Order', { company_id: 'recC1', order_no: 'AB-1041' });
    await seed('Order', { company_id: ['recC1'], order_no: 'AB-1099' });
    await seed('Order', { company_id: 'recC2', order_no: 'AB-5000' });
    await seed('Order', { company_id: 'recC1', order_no: 'AB-99999-alt' });
    const res = await create('Order', { fields: { company_id: ['recC1'], customer_id: 'recK' }, assignNumber: true });
    expect((await res.json()).fields.order_no).toBe('AB-1100');
    const other = await create('Order', { fields: { company_id: 'recC3' }, assignNumber: true });
    expect((await other.json()).fields.order_no).toBe('AB-1001');
  });

  it('overwrites a client-supplied number when assignNumber is set', async () => {
    const res = await create('Invoice', { fields: { company_id: 'recC1', invoice_no: 'R-1' }, assignNumber: true });
    expect((await res.json()).fields.invoice_no).toBe('R-1001');
  });

  it('gives 20 simultaneous invoices 20 unique consecutive numbers', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => create('Invoice', { fields: { company_id: 'recC1' }, assignNumber: true })),
    );
    const numbers = await Promise.all(results.map(async (r) => (await r.json()).fields.invoice_no as string));
    const sorted = [...numbers].sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
    expect(sorted).toEqual(Array.from({ length: 20 }, (_, i) => `R-${1001 + i}`));
  });

  it('creates quote variants', async () => {
    await seed('Quote', { company_id: ['recC1'], quote_no: 'Q-1024' });
    await seed('Quote', { company_id: ['recC1'], quote_no: 'Q-1024.1' });
    await seed('Quote', { company_id: ['recC1'], quote_no: 'Q-1024.2' });
    await seed('Quote', { company_id: ['recC2'], quote_no: 'Q-1024.7' });
    const res = await create('Quote', { fields: { company_id: ['recC1'] }, variantOf: 'Q-1024.1' });
    expect((await res.json()).fields.quote_no).toBe('Q-1024.3');
    expect((await create('Order', { fields: { company_id: 'recC1' }, variantOf: 'Q-1' })).status).toBe(400);
    expect((await create('Quote', { fields: { company_id: ['recC1'] }, variantOf: 'nonsense' })).status).toBe(400);
  });

  it('requires a company and a numbered table', async () => {
    expect((await create('Invoice', { fields: {}, assignNumber: true })).status).toBe(400);
    expect((await create('Contact', { fields: { company_id: ['recC1'] }, assignNumber: true })).status).toBe(400);
  });
});

describe('duplicate guard', () => {
  it('refuses a hand-typed duplicate on create and update within the same company', async () => {
    await seed('Invoice', { company_id: 'recC1', invoice_no: 'R-1005' });
    const dup = await create('Invoice', { fields: { company_id: 'recC1', invoice_no: 'R-1005' } });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({ error: { type: 'DUPLICATE_NUMBER', message: 'Nummer bereits vergeben: R-1005' } });
    expect((await create('Invoice', { fields: { company_id: 'recC2', invoice_no: 'R-1005' } })).status).toBe(200);

    const other = await seed('Invoice', { company_id: 'recC1', invoice_no: 'R-1006' });
    const upd = await ctx.req(`/api/data/Invoice/${other.id}`, {
      method: 'PATCH',
      cookie,
      body: { fields: { invoice_no: 'R-1005' } },
    });
    expect(upd.status).toBe(409);
  });

  it('leaves legacy duplicates alone unless the number is changed', async () => {
    const a = await seed('Invoice', { company_id: 'recC1', invoice_no: 'R-1010' });
    await seed('Invoice', { company_id: 'recC1', invoice_no: 'R-1010' });
    const res = await ctx.req(`/api/data/Invoice/${a.id}`, {
      method: 'PATCH',
      cookie,
      body: { fields: { invoice_no: 'R-1010', status: 'Bezahlt' } },
    });
    expect(res.status).toBe(200);
  });
});

describe('GET /api/numbers/:type/next', () => {
  it('previews without reserving', async () => {
    await seed('Invoice', { company_id: 'recC1', invoice_no: 'R-1200' });
    const peek = async () => (await (await ctx.req('/api/numbers/invoice/next?company=recC1', { cookie })).json()).number;
    expect(await peek()).toBe('R-1201');
    expect(await peek()).toBe('R-1201');
    await seed('Quote', { company_id: ['recC1'], quote_no: 'Q-2000' });
    const variant = await ctx.req('/api/numbers/quote/next?company=recC1&base=Q-2000', { cookie });
    expect(await variant.json()).toEqual({ number: 'Q-2000.1' });
  });

  it('validates type, company and base', async () => {
    expect((await ctx.req('/api/numbers/foo/next?company=recC1', { cookie })).status).toBe(404);
    expect((await ctx.req('/api/numbers/invoice/next', { cookie })).status).toBe(400);
    expect((await ctx.req('/api/numbers/invoice/next?company=recC1&base=Q-1', { cookie })).status).toBe(400);
  });
});
