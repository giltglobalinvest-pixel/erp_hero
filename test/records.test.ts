import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecordStore } from '../server/data/records.js';
import { openDatabase, type Database } from '../server/db/database.js';
import { runMigrations } from '../server/db/migrations.js';
import { isRecordId } from '../server/util/ids.js';

let dir: string;
let db: Database;
let store: RecordStore;
let t = Date.parse('2026-02-01T10:00:00.000Z');

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'erp-rec-'));
  db = await openDatabase(path.join(dir, 'erp.db'));
  await runMigrations(db);
  store = new RecordStore(db, () => t);
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('RecordStore', () => {
  it('inserts with a fresh rec id and lists in creation order', async () => {
    const a = await db.write((tx) => store.insert(tx, 'Order', { order_no: 'AB-1001' }));
    t += 1000;
    const b = await db.write((tx) => store.insert(tx, 'Order', { order_no: 'AB-1002' }));
    expect(isRecordId(a.id)).toBe(true);
    expect(a.createdTime).toBe('2026-02-01T10:00:00.000Z');
    expect((await store.list('Order')).map((r) => r.id)).toEqual([a.id, b.id]);
    expect(await store.count('Order')).toBe(2);
  });

  it('keeps imported ids and createdTime', async () => {
    await db.write((tx) =>
      store.insert(tx, 'Customer', { name: 'X' }, { id: 'recAAAAAAAAAAAAAA', createdTime: '2024-01-01T00:00:00.000Z' }),
    );
    const r = await store.get('Customer', 'recAAAAAAAAAAAAAA');
    expect(r?.createdTime).toBe('2024-01-01T00:00:00.000Z');
    expect(r?.fields).toEqual({ name: 'X' });
  });

  it('merges updates and removes cleared fields', async () => {
    const a = await db.write((tx) => store.insert(tx, 'Customer', { name: 'A', city: 'Fellbach' }));
    t += 5000;
    const u = await db.write((tx) => store.update(tx, 'Customer', a.id, { phone: '123' }, ['city']));
    expect(u?.fields).toEqual({ name: 'A', phone: '123' });
    expect(u?.updatedTime).toBe(new Date(t).toISOString());
    expect(await db.write((tx) => store.update(tx, 'Customer', 'recMISSINGMISSING', {}, []))).toBeNull();
  });

  it('removes records', async () => {
    const a = await db.write((tx) => store.insert(tx, 'Customer', {}));
    expect(await db.write((tx) => store.remove(tx, 'Customer', a.id))).toBe(true);
    expect(await db.write((tx) => store.remove(tx, 'Customer', a.id))).toBe(false);
    expect(await store.get('Customer', a.id)).toBeNull();
  });
});
