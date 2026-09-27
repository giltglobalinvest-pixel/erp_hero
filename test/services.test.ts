import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { jsonResponse } from './helpers/fakeFetch.js';

let ctx: TestContext;
let user: { id: string; cookie: string };
let admin: { id: string; cookie: string };

beforeEach(async () => {
  ctx = await createTestContext();
  user = await ctx.loginAs();
  admin = await ctx.loginAs({ isAdmin: true });
});
afterEach(async () => {
  await ctx.close();
});

describe('Freshsales proxy', () => {
  const FS = 'https://gilt.freshworks.com/crm/sales/api/';

  it('forwards allowed calls with the token header and passes errors through', async () => {
    ctx.fake
      .on('GET', `${FS}lookup`, () => jsonResponse({ contacts: { contacts: [] } }))
      .on('PUT', `${FS}sales_accounts/`, () => jsonResponse({ errors: { message: ['Company is not unique'] } }, 400));
    const ok = await ctx.req('/api/freshsales/api/lookup?q=a%40b.de&f=email&entities=contact', { cookie: user.cookie });
    expect(ok.status).toBe(200);
    expect(ctx.fake.calls[0]?.url).toBe(`${FS}lookup?q=a%40b.de&f=email&entities=contact`);
    expect(ctx.fake.calls[0]?.headers.get('authorization')).toBe('Token token=test-freshsales-key');

    const err = await ctx.req('/api/freshsales/api/sales_accounts/77', {
      method: 'PUT',
      cookie: user.cookie,
      body: { sales_account: { name: 'X' } },
    });
    expect(err.status).toBe(400);
    expect(await err.json()).toEqual({ errors: { message: ['Company is not unique'] } });
    expect(ctx.fake.calls[1]?.body?.toString()).toBe('{"sales_account":{"name":"X"}}');
  });

  it('blocks everything else and reports missing config by name', async () => {
    expect((await ctx.req('/api/freshsales/api/contacts/5', { method: 'DELETE', cookie: user.cookie })).status).toBe(403);
    expect((await ctx.req('/api/freshsales/api/settings/sales_accounts/fields', { cookie: user.cookie })).status).toBe(403);
    const bare = await createTestContext({ env: { FRESHSALES_API_KEY: '' } });
    try {
      const { cookie } = await bare.loginAs();
      const res = await bare.req('/api/freshsales/api/lookup?q=x', { cookie });
      expect((await res.json()).error.message).toContain('FRESHSALES_API_KEY');
    } finally {
      await bare.close();
    }
  });
});

describe('Mailchimp proxy', () => {
  let companyId: string;
  beforeEach(async () => {
    companyId = (
      await ctx.deps.db.write((tx) => ctx.deps.records.insert(tx, 'Company', { name: 'FLP', mailchimp_server_prefix: 'us21' }))
    ).id;
    await ctx.deps.db.write((tx) => ctx.deps.secrets.setMailchimpKey(tx, companyId, 'saved-key-us21'));
  });

  it('uses the company key and server prefix from the database', async () => {
    ctx.fake.on('GET', 'https://us21.api.mailchimp.com/3.0/', () => jsonResponse({ health_status: "Everything's Chimpy!" }));
    const res = await ctx.req('/api/mailchimp/3.0/ping', { cookie: user.cookie, headers: { 'x-company-id': companyId } });
    expect(await res.json()).toEqual({ health_status: "Everything's Chimpy!" });
    expect(ctx.fake.calls[0]?.headers.get('authorization')).toBe(
      `Basic ${Buffer.from('anystring:saved-key-us21').toString('base64')}`,
    );
  });

  it('lets only admins test unsaved values, and validates the server prefix', async () => {
    ctx.fake.on('GET', 'https://eu1.api.mailchimp.com/3.0/lists', () => jsonResponse({ lists: [] }));
    const headers = { 'x-company-id': companyId, 'x-mailchimp-key': 'typed-key-eu1', 'x-mailchimp-server': 'eu1' };
    expect((await ctx.req('/api/mailchimp/3.0/lists?count=50', { cookie: user.cookie, headers })).status).toBe(403);
    const ok = await ctx.req('/api/mailchimp/3.0/lists?count=50', { cookie: admin.cookie, headers });
    expect(ok.status).toBe(200);
    expect(ctx.fake.calls[0]?.url).toBe('https://eu1.api.mailchimp.com/3.0/lists?count=50');
    const bad = await ctx.req('/api/mailchimp/3.0/ping', {
      cookie: admin.cookie,
      headers: { ...headers, 'x-mailchimp-server': 'evil.com#' },
    });
    expect(bad.status).toBe(400);
  });

  it('requires a company, a configured key and an allowed endpoint', async () => {
    expect((await ctx.req('/api/mailchimp/3.0/ping', { cookie: user.cookie })).status).toBe(400);
    const other = await ctx.deps.db.write((tx) => ctx.deps.records.insert(tx, 'Company', { name: 'Other' }));
    const unconfigured = await ctx.req('/api/mailchimp/3.0/ping', { cookie: user.cookie, headers: { 'x-company-id': other.id } });
    expect(unconfigured.status).toBe(400);
    expect(
      (await ctx.req('/api/mailchimp/3.0/lists/abc/members', { cookie: user.cookie, headers: { 'x-company-id': companyId } }))
        .status,
    ).toBe(403);
  });
});

describe('Anthropic proxy', () => {
  it('forwards POST /v1/messages with the server key and passes the response through', async () => {
    ctx.fake.on('POST', 'https://api.anthropic.com/v1/messages', () =>
      jsonResponse({ id: 'msg_1', content: [{ type: 'text', text: 'Hallo' }], usage: { input_tokens: 3, output_tokens: 1 } }),
    );
    const payload = { model: 'claude-sonnet-4-5-20250929', max_tokens: 100, messages: [{ role: 'user', content: 'Hi' }] };
    const res = await ctx.req('/api/anthropic/v1/messages', { method: 'POST', cookie: user.cookie, body: payload });
    expect((await res.json()).content[0].text).toBe('Hallo');
    const call = ctx.fake.calls[0];
    expect(call?.headers.get('x-api-key')).toBe('test-anthropic-key');
    expect(call?.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(JSON.parse(call?.body?.toString() ?? '')).toEqual(payload);
  });

  it('accepts large image payloads up to 32 MB and rejects bigger ones with 413 JSON', async () => {
    ctx.fake.on('POST', 'https://api.anthropic.com/v1/messages', () => jsonResponse({ ok: true }));
    const image = 'A'.repeat(20 * 1024 * 1024);
    const ok = await ctx.req('/api/anthropic/v1/messages', { method: 'POST', cookie: user.cookie, body: { image } });
    expect(ok.status).toBe(200);
    const tooBig = await ctx.req('/api/anthropic/v1/messages', {
      method: 'POST',
      cookie: user.cookie,
      body: { image: 'A'.repeat(33 * 1024 * 1024) },
    });
    expect(tooBig.status).toBe(413);
    expect((await tooBig.json()).error.type).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects other methods and reports a missing key by name', async () => {
    expect((await ctx.req('/api/anthropic/v1/messages', { cookie: user.cookie })).status).toBe(405);
    const bare = await createTestContext({ env: { ANTHROPIC_API_KEY: '' } });
    try {
      const { cookie } = await bare.loginAs();
      const res = await bare.req('/api/anthropic/v1/messages', { method: 'POST', cookie, body: {} });
      expect((await res.json()).error.message).toContain('ANTHROPIC_API_KEY');
    } finally {
      await bare.close();
    }
  });
});
