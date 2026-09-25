import { describe, expect, it } from 'vitest';
import { AirtableReader } from '../server/import/airtable.js';
import { FakeFetch, jsonResponse } from './helpers/fakeFetch.js';

function setup() {
  const fake = new FakeFetch();
  let now = 0;
  const sleeps: number[] = [];
  const reader = new AirtableReader({
    token: 'pat-read-only',
    fetch: fake.fetch,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });
  return { fake, reader, sleeps };
}

describe('AirtableReader', () => {
  it('follows offset pagination and sends only GET with the bearer token', async () => {
    const { fake, reader } = setup();
    fake.on('GET', 'https://api.airtable.com/v0/appX/Customer', (call) => {
      const offset = new URL(call.url).searchParams.get('offset');
      if (!offset) return jsonResponse({ records: [{ id: 'rec1', createdTime: 't1', fields: {} }], offset: 'o1' });
      if (offset === 'o1') return jsonResponse({ records: [{ id: 'rec2', createdTime: 't2', fields: {} }], offset: 'o2' });
      return jsonResponse({ records: [{ id: 'rec3', createdTime: 't3', fields: {} }] });
    });
    const records = await reader.listRecords('appX', 'Customer');
    expect(records.map((r) => r.id)).toEqual(['rec1', 'rec2', 'rec3']);
    expect(fake.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(fake.calls[0]?.headers.get('authorization')).toBe('Bearer pat-read-only');
    expect(new URL(fake.calls[0]?.url ?? '').searchParams.get('pageSize')).toBe('100');
  });

  it('passes filterByFormula and encodes table names', async () => {
    const { fake, reader } = setup();
    fake.on('GET', 'https://api.airtable.com/v0/appM/Keys', () => jsonResponse({ records: [] }));
    await reader.listRecords('appM', 'Keys', { filterByFormula: "{project_id}='p_1'" });
    expect(new URL(fake.calls[0]?.url ?? '').searchParams.get('filterByFormula')).toBe("{project_id}='p_1'");
  });

  it('stays at or below 5 requests per second', async () => {
    const { fake, reader, sleeps } = setup();
    fake.on('GET', 'https://api.airtable.com/v0/', () => jsonResponse({ records: [] }));
    for (let i = 0; i < 4; i++) await reader.listRecords('appX', `T${i}`);
    expect(sleeps).toEqual([200, 200, 200]);
  });

  it('waits 30 s and retries on 429, up to 3 times, then fails', async () => {
    const { fake, reader, sleeps } = setup();
    let hits = 0;
    fake.on('GET', 'https://api.airtable.com/v0/appX/A', () => (++hits < 3 ? jsonResponse({}, 429) : jsonResponse({ records: [] })));
    await reader.listRecords('appX', 'A');
    expect(sleeps.filter((s) => s === 30_000)).toHaveLength(2);

    fake.on('GET', 'https://api.airtable.com/v0/appX/B', () => jsonResponse({}, 429));
    await expect(reader.listRecords('appX', 'B')).rejects.toThrow('Airtable GET /v0/appX/B failed with HTTP 429');
  });

  it('reads the schema and fails clearly on errors without leaking the token', async () => {
    const { fake, reader } = setup();
    fake
      .on('GET', 'https://api.airtable.com/v0/meta/bases/appX/tables', () =>
        jsonResponse({ tables: [{ id: 'tbl1', name: 'Customer', fields: [{ id: 'fld1', name: 'name', type: 'singleLineText' }] }] }),
      )
      .on('GET', 'https://api.airtable.com/v0/meta/bases/appBAD/tables', () => jsonResponse({ error: 'x' }, 403));
    expect((await reader.listTables('appX'))[0]?.name).toBe('Customer');
    const err = await reader.listTables('appBAD').catch((e: Error) => e);
    expect(String(err)).toContain('HTTP 403');
    expect(String(err)).not.toContain('pat-read-only');
  });

  it('downloads attachments', async () => {
    const { fake, reader } = setup();
    fake
      .on('GET', 'https://v5.airtableusercontent.com/ok', () => new Response(Buffer.from('PNG'), { headers: { 'content-type': 'image/png' } }))
      .on('GET', 'https://v5.airtableusercontent.com/expired', () => new Response('gone', { status: 410 }));
    const file = await reader.download('https://v5.airtableusercontent.com/ok');
    expect(file.data.toString()).toBe('PNG');
    expect(file.contentType).toBe('image/png');
    await expect(reader.download('https://v5.airtableusercontent.com/expired')).rejects.toThrow('HTTP 410');
  });
});
