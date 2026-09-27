import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOCK_TTL_MS } from '../server/data/locks.js';
import { createTestContext, type TestContext } from './helpers/context.js';

let ctx: TestContext;
let anna: { id: string; cookie: string };
let ben: { id: string; cookie: string };
let quoteId: string;

beforeEach(async () => {
  ctx = await createTestContext();
  anna = await ctx.loginAs({ name: 'Anna' });
  ben = await ctx.loginAs({ name: 'Ben' });
  quoteId = (await ctx.deps.db.write((tx) => ctx.deps.records.insert(tx, 'Quote', { quote_no: 'Q-1001' }))).id;
});
afterEach(async () => {
  await ctx.close();
});

const lock = (cookie: string, suffix = '', table = 'Quote', id = quoteId) =>
  ctx.req(`/api/locks/${table}/${id}${suffix}`, { method: 'POST', cookie });
const lockFields = async () => (await ctx.deps.records.get('Quote', quoteId))?.fields;

describe('record locks', () => {
  it('lets the first user lock for 5 minutes and tells others who holds it', async () => {
    const res = await (await lock(anna.cookie)).json();
    const until = new Date(ctx.clock.now + LOCK_TTL_MS).toISOString();
    expect(res).toEqual({ ok: true, until });
    expect(await lockFields()).toMatchObject({ lock_user_id: anna.id, lock_until: until });

    expect(await (await lock(ben.cookie)).json()).toEqual({ ok: false, locked_by: { id: anna.id, name: 'Anna' }, until });
  });

  it('refresh extends the holder lock; others can take over after expiry', async () => {
    await lock(anna.cookie);
    ctx.clock.now += 2 * 60 * 1000;
    const refreshed = await (await lock(anna.cookie, '/refresh')).json();
    expect(refreshed.until).toBe(new Date(ctx.clock.now + LOCK_TTL_MS).toISOString());
    ctx.clock.now += LOCK_TTL_MS + 1;
    expect((await (await lock(ben.cookie)).json()).ok).toBe(true);
    expect((await lockFields())?.lock_user_id).toBe(ben.id);
  });

  it('release clears only your own or expired locks, and accepts beacon requests', async () => {
    await lock(anna.cookie);
    const beacon = await ctx.req(`/api/locks/Quote/${quoteId}/release`, {
      method: 'POST',
      cookie: ben.cookie,
      body: 'ignored',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
    });
    expect(await beacon.json()).toEqual({ ok: true });
    expect((await lockFields())?.lock_user_id).toBe(anna.id);

    await lock(anna.cookie, '/release');
    expect(await lockFields()).toEqual({ quote_no: 'Q-1001' });
    expect((await ctx.req('/api/locks/Quote/recGONEGONEGONE12/release', { method: 'POST', cookie: anna.cookie })).status).toBe(200);
  });

  it('never lets the normal data API set lock fields', async () => {
    await lock(anna.cookie);
    await ctx.req(`/api/data/Quote/${quoteId}`, {
      method: 'PATCH',
      cookie: ben.cookie,
      body: { fields: { lock_user_id: ben.id, lock_until: '2099-01-01T00:00:00.000Z', quote_title: 'X' } },
    });
    expect(await lockFields()).toMatchObject({ lock_user_id: anna.id, quote_title: 'X' });
  });

  it('keeps locks advisory: saving a record locked by someone else still works', async () => {
    await lock(anna.cookie);
    const res = await ctx.req(`/api/data/Quote/${quoteId}`, { method: 'PATCH', cookie: ben.cookie, body: { fields: { status: 'x' } } });
    expect(res.status).toBe(200);
  });

  it('rejects non-lockable tables and missing records', async () => {
    const item = await ctx.deps.db.write((tx) => ctx.deps.records.insert(tx, 'QuoteItem', {}));
    expect((await lock(anna.cookie, '', 'QuoteItem', item.id)).status).toBe(400);
    expect((await lock(anna.cookie, '', 'Quote', 'recGONEGONEGONE12')).status).toBe(404);
    expect((await lock(anna.cookie, '', 'Nope', quoteId)).status).toBe(404);
  });
});
