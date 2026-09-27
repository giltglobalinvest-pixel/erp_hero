import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';

let ctx: TestContext;
let user: { id: string; cookie: string };
let admin: { id: string; cookie: string };

beforeEach(async () => {
  ctx = await createTestContext();
  user = await ctx.loginAs({ name: 'Nora' });
  admin = await ctx.loginAs({ name: 'Adam', isAdmin: true });
});
afterEach(async () => {
  await ctx.close();
});

const create = (table: string, fields: Record<string, unknown>, cookie = user.cookie) =>
  ctx.req(`/api/data/${table}`, { method: 'POST', cookie, body: { fields } });

describe('records CRUD in Airtable shape', () => {
  it('creates, reads, lists, updates and deletes', async () => {
    const created = await (await create('Customer', { name: 'Müller GmbH', company_id: ['recC1'], city: 'Fellbach' })).json();
    expect(created.id).toMatch(/^rec[A-Za-z0-9]{14}$/);
    expect(created.createdTime).toBe('2026-01-05T08:00:00.000Z');
    expect(created.fields).toEqual({ name: 'Müller GmbH', company_id: ['recC1'], city: 'Fellbach' });

    const one = await ctx.req(`/api/data/Customer/${created.id}`, { cookie: user.cookie });
    expect(await one.json()).toEqual(created);

    const list = await (await ctx.req('/api/data/Customer', { cookie: user.cookie })).json();
    expect(list).toEqual({ records: [created] });

    const patched = await ctx.req(`/api/data/Customer/${created.id}`, {
      method: 'PATCH',
      cookie: user.cookie,
      body: { fields: { city: '', phone: '0711' } },
    });
    expect((await patched.json()).fields).toEqual({ name: 'Müller GmbH', company_id: ['recC1'], phone: '0711' });

    const del = await ctx.req(`/api/data/Customer/${created.id}`, { method: 'DELETE', cookie: user.cookie });
    expect(await del.json()).toEqual({ id: created.id, deleted: true });
    expect((await ctx.req(`/api/data/Customer/${created.id}`, { cookie: user.cookie })).status).toBe(404);
  });

  it('returns all records, not just 100', async () => {
    await ctx.deps.db.write(async (tx) => {
      for (let i = 0; i < 250; i++) await ctx.deps.records.insert(tx, 'Article', { name: `A${i}` });
    });
    const list = await (await ctx.req('/api/data/Article', { cookie: user.cookie })).json();
    expect(list.records).toHaveLength(250);
  });

  it('supports the restricted formula, sort, maxRecords and fields[]', async () => {
    for (const [name, status] of [
      ['Beta', 'aktiv'],
      ['alpha', 'aktiv'],
      ['Gamma', 'archiviert'],
      ["O'Neil", 'aktiv'],
    ]) {
      await create('Supplier', { name, status });
    }
    const q = new URLSearchParams({
      filterByFormula: "{status}='aktiv'",
      'sort[0][field]': 'name',
      'sort[0][direction]': 'asc',
      maxRecords: '2',
    });
    q.append('fields[]', 'name');
    const res = await (await ctx.req(`/api/data/Supplier?${q.toString()}`, { cookie: user.cookie })).json();
    expect(res.records.map((r: { fields: unknown }) => r.fields)).toEqual([{ name: 'alpha' }, { name: 'Beta' }]);

    const quoted = new URLSearchParams({ filterByFormula: "{name}='O\\'Neil'" });
    const one = await (await ctx.req(`/api/data/Supplier?${quoted.toString()}`, { cookie: user.cookie })).json();
    expect(one.records).toHaveLength(1);

    const bad = await ctx.req(`/api/data/Supplier?${new URLSearchParams({ filterByFormula: 'FIND("a",{name})' })}`, {
      cookie: user.cookie,
    });
    expect(bad.status).toBe(400);
  });

  it('rejects unknown tables and missing records', async () => {
    expect((await ctx.req('/api/data/Secrets', { cookie: user.cookie })).status).toBe(404);
    expect((await ctx.req('/api/data/Customer/recNOPENOPENOPE12', { cookie: user.cookie })).status).toBe(404);
    const patch = await ctx.req('/api/data/Customer/recNOPENOPENOPE12', { method: 'PATCH', cookie: user.cookie, body: { fields: {} } });
    expect(patch.status).toBe(404);
    const del = await ctx.req('/api/data/Customer/recNOPENOPENOPE12', { method: 'DELETE', cookie: user.cookie });
    expect(del.status).toBe(404);
  });

  it('requires a session', async () => {
    expect((await ctx.req('/api/data/Customer')).status).toBe(401);
    expect((await ctx.req('/api/data/Customer', { method: 'POST', body: { fields: {} } })).status).toBe(401);
  });

  it('rejects secret fields, ignores lock fields, and limits the body to 5 MB', async () => {
    const secret = await create('Customer', { name: 'X', api_key: 'k' });
    expect(secret.status).toBe(400);
    expect((await secret.json()).error.message).toContain('Geheime Felder');
    const lock = await (await create('Customer', { name: 'Y', lock_user_id: 'recEVIL', lock_until: '2099-01-01' })).json();
    expect(lock.fields).toEqual({ name: 'Y' });
    const big = await create('Customer', { notes: 'x'.repeat(5 * 1024 * 1024 + 10) });
    expect(big.status).toBe(413);
    expect((await big.json()).error.type).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('permissions and secret removal', () => {
  it('lets every user read and write business records across companies', async () => {
    const a = await (await create('Customer', { name: 'A', company_id: ['recOTHERCOMPANY1'] })).json();
    const res = await ctx.req(`/api/data/Customer/${a.id}`, {
      method: 'PATCH',
      cookie: user.cookie,
      body: { fields: { name: 'A2' } },
    });
    expect(res.status).toBe(200);
  });

  it('shows non-admins only names of users; admins get everything except secrets', async () => {
    await ctx.deps.db.write((tx) => ctx.deps.secrets.mergeFreshdeskKeys(tx, user.id, { recC1: 'fd' }));
    const asUser = await (await ctx.req('/api/data/User', { cookie: user.cookie })).json();
    expect(asUser.records.map((r: { fields: unknown }) => r.fields)).toHaveLength(2);
    expect(asUser.records.map((r: { fields: unknown }) => r.fields)).toEqual(
      expect.arrayContaining([{ name: 'Nora' }, { name: 'Adam' }]),
    );

    const asAdmin = await (await ctx.req('/api/data/User', { cookie: admin.cookie })).json();
    const nora = asAdmin.records.find((r: { id: string }) => r.id === user.id);
    expect(nora.fields).toEqual({
      name: 'Nora',
      role: 'Vertrieb',
      status: 'aktiv',
      has_api_key: true,
      has_freshdesk_key: false,
      freshdesk_company_keys: ['recC1'],
    });
    expect(JSON.stringify(asAdmin)).not.toMatch(/scrypt|fd"/);
  });

  it('does not let non-admins probe hidden user fields through filters', async () => {
    const q = new URLSearchParams({ filterByFormula: "{status}='aktiv'" });
    const res = await (await ctx.req(`/api/data/User?${q}`, { cookie: user.cookie })).json();
    expect(res.records).toEqual([]);
  });

  it('allows only admins to write User and Company', async () => {
    expect((await create('User', { name: 'Hacker', is_admin: true })).status).toBe(403);
    expect((await create('Company', { name: 'NewCo' })).status).toBe(403);
    expect((await create('Company', { name: 'NewCo' }, admin.cookie)).status).toBe(200);
  });

  it('adds has_mailchimp_key to companies for everyone and never returns the key', async () => {
    const co = await (await create('Company', { name: 'FLP', status: 'aktiv', iban: 'DE38' }, admin.cookie)).json();
    await ctx.deps.db.write((tx) => ctx.deps.secrets.setMailchimpKey(tx, co.id, 'mc-secret-us21'));
    const list = await (await ctx.req('/api/data/Company', { cookie: user.cookie })).json();
    expect(list.records[0].fields).toEqual({ name: 'FLP', status: 'aktiv', iban: 'DE38', has_mailchimp_key: true });
    expect(JSON.stringify(list)).not.toContain('mc-secret');
  });

  it('strips secret-looking fields that exist in stored data', async () => {
    const r = await ctx.deps.db.write((tx) =>
      ctx.deps.records.insert(tx, 'Company', { name: 'Old', mailchimp_api_key: 'leak', webhook_secret: 'leak2' }),
    );
    const res = await (await ctx.req(`/api/data/Company/${r.id}`, { cookie: admin.cookie })).json();
    expect(JSON.stringify(res)).not.toContain('leak');
  });

  it('keeps the AI cost log write-only for non-admins', async () => {
    const entry = await create('AiUsageLog', { model: 'claude', input_tokens: 10, company_id: '' });
    expect(entry.status).toBe(200);
    expect((await entry.json()).fields).toEqual({ model: 'claude', input_tokens: 10 });
    expect((await ctx.req('/api/data/AiUsageLog', { cookie: user.cookie })).status).toBe(403);
    expect((await ctx.req('/api/data/AiUsageLog', { cookie: admin.cookie })).status).toBe(200);
  });
});

describe('schema no-ops', () => {
  it('accepts ensureTable/ensureFields for known tables and rejects unknown ones', async () => {
    const ok = await ctx.req('/api/schema/ensure-fields', {
      method: 'POST',
      cookie: user.cookie,
      body: { table: 'Company', fields: [{ name: 'brand_color', type: 'singleLineText' }] },
    });
    expect(await ok.json()).toEqual({ ok: true });
    const table = await ctx.req('/api/schema/ensure-table', { method: 'POST', cookie: user.cookie, body: { name: 'Order', fields: [] } });
    expect(table.status).toBe(200);
    const unknown = await ctx.req('/api/schema/ensure-table', { method: 'POST', cookie: user.cookie, body: { name: 'Hack', fields: [] } });
    expect(unknown.status).toBe(404);
  });
});
