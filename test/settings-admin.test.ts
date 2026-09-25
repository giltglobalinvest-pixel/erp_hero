import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyLoginKey } from '../server/auth/passwords.js';
import { createTestContext, type TestContext } from './helpers/context.js';

let ctx: TestContext;
let user: { id: string; key: string; cookie: string };
let admin: { id: string; cookie: string };

beforeEach(async () => {
  ctx = await createTestContext();
  user = await ctx.loginAs({ name: 'Nora' });
  admin = await ctx.loginAs({ name: 'Adam', isAdmin: true });
});
afterEach(async () => {
  await ctx.close();
});

describe('settings', () => {
  it('lets everyone read and only admins change allowlisted settings', async () => {
    const put = (cookie: string, key: string, value: unknown) =>
      ctx.req(`/api/settings/${key}`, { method: 'PUT', cookie, body: { value } });
    expect((await put(user.cookie, 'freshdeskDomain', 'flp')).status).toBe(403);
    expect(await (await put(admin.cookie, 'freshdeskDomain', ' flpliftparts ')).json()).toEqual({
      settings: { freshdeskDomain: 'flpliftparts' },
    });
    await put(admin.cookie, 'freshdeskTicketTypes', 'FLP Lift Parts GmbH, FLP Traction Drives GmbH');
    expect(await (await ctx.req('/api/settings', { cookie: user.cookie })).json()).toEqual({
      settings: { freshdeskDomain: 'flpliftparts', freshdeskTicketTypes: 'FLP Lift Parts GmbH, FLP Traction Drives GmbH' },
    });
    expect((await put(admin.cookie, 'anthropicKey', 'sk-ant')).status).toBe(400);
    expect((await put(admin.cookie, 'freshdeskDomain', 5)).status).toBe(400);
    expect(await (await put(admin.cookie, 'freshdeskDomain', '')).json()).toEqual({
      settings: { freshdeskTicketTypes: 'FLP Lift Parts GmbH, FLP Traction Drives GmbH' },
    });
    const del = await ctx.req('/api/settings/freshdeskTicketTypes', { method: 'DELETE', cookie: admin.cookie });
    expect(await del.json()).toEqual({ settings: {} });
  });

  it('requires a session', async () => {
    expect((await ctx.req('/api/settings')).status).toBe(401);
  });
});

describe('admin: user secrets', () => {
  const patch = (cookie: string, userId: string, body: unknown) =>
    ctx.req(`/api/admin/users/${userId}/secrets`, { method: 'PATCH', cookie, body });

  it('is admin-only', async () => {
    expect((await patch(user.cookie, user.id, { generate_api_key: true })).status).toBe(403);
  });

  it('generates a new 24-char key once, replacing the old one', async () => {
    const res = await (await patch(admin.cookie, user.id, { generate_api_key: true })).json();
    expect(res.api_key).toMatch(/^[a-z0-9]{24}$/);
    expect(res).toMatchObject({ has_api_key: true, has_freshdesk_key: false, freshdesk_company_keys: [] });
    expect((await ctx.req('/api/auth', { method: 'POST', body: { user_key: user.key } })).status).toBe(401);
    expect((await ctx.req('/api/auth', { method: 'POST', body: { user_key: res.api_key } })).status).toBe(200);
  });

  it('sets a manual key (min 12 chars, unique) without echoing it, or removes it', async () => {
    expect((await patch(admin.cookie, user.id, { api_key: 'short' })).status).toBe(422);
    const other = await ctx.createUser({ key: 'already-used-key-123' });
    expect(other.id).toBeTruthy();
    const dup = await patch(admin.cookie, user.id, { api_key: 'already-used-key-123' });
    expect(dup.status).toBe(409);
    expect((await dup.json()).error.type).toBe('KEY_IN_USE');
    const ok = await (await patch(admin.cookie, user.id, { api_key: 'nora-new-key-2026' })).json();
    expect(ok.api_key).toBeUndefined();
    const hash = (await ctx.deps.secrets.apiKeyHashes()).get(user.id) ?? '';
    expect(await verifyLoginKey('nora-new-key-2026', hash)).toBe(true);
    const removed = await (await patch(admin.cookie, user.id, { api_key: null })).json();
    expect(removed.has_api_key).toBe(false);
  });

  it('sets, merges and clears Freshdesk keys server-side', async () => {
    let res = await (
      await patch(admin.cookie, user.id, { freshdesk_api_key: 'default-fd', freshdesk_keys: { recC1: 'k1', recC2: 'k2' } })
    ).json();
    expect(res).toEqual({ has_api_key: true, has_freshdesk_key: true, freshdesk_company_keys: ['recC1', 'recC2'] });
    res = await (await patch(admin.cookie, user.id, { freshdesk_keys: { recC1: null, recC3: 'k3' } })).json();
    expect(res.freshdesk_company_keys).toEqual(['recC2', 'recC3']);
    res = await (await patch(admin.cookie, user.id, { freshdesk_api_key: '' })).json();
    expect(res.has_freshdesk_key).toBe(false);
    expect(await ctx.deps.secrets.freshdeskKeyFor(user.id, 'recC3')).toBe('k3');
    expect((await patch(admin.cookie, user.id, { freshdesk_keys: 'x' })).status).toBe(400);
  });

  it('404s for unknown users', async () => {
    expect((await patch(admin.cookie, 'recGONEGONEGONE12', { generate_api_key: true })).status).toBe(404);
  });
});

describe('admin: company secrets', () => {
  it('sets and clears the Mailchimp key without ever returning it', async () => {
    const co = await ctx.deps.db.write((tx) => ctx.deps.records.insert(tx, 'Company', { name: 'FLP' }));
    const url = `/api/admin/companies/${co.id}/secrets`;
    expect((await ctx.req(url, { method: 'PATCH', cookie: user.cookie, body: { mailchimp_api_key: 'x' } })).status).toBe(403);
    const set = await ctx.req(url, { method: 'PATCH', cookie: admin.cookie, body: { mailchimp_api_key: 'abc-us21' } });
    expect(await set.json()).toEqual({ has_mailchimp_key: true });
    expect(await ctx.deps.secrets.mailchimpKey(co.id)).toBe('abc-us21');
    const cleared = await ctx.req(url, { method: 'PATCH', cookie: admin.cookie, body: { mailchimp_api_key: null } });
    expect(await cleared.json()).toEqual({ has_mailchimp_key: false });
    expect((await ctx.req(url, { method: 'PATCH', cookie: admin.cookie, body: {} })).status).toBe(400);
    expect(
      (await ctx.req('/api/admin/companies/recGONEGONEGONE12/secrets', { method: 'PATCH', cookie: admin.cookie, body: { mailchimp_api_key: 'x' } }))
        .status,
    ).toBe(404);
  });
});
