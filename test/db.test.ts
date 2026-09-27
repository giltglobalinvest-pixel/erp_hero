import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '../server/db/database.js';
import { runMigrations } from '../server/db/migrations.js';
import { TABLE_NAMES } from '../server/data/tables.js';
import { isRecordId, newAttachmentId, newLoginKey, newRecordId, newSessionToken } from '../server/util/ids.js';
import { Mutex } from '../server/util/mutex.js';

let dir: string;
let db: Database;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'erp-db-'));
  db = await openDatabase(path.join(dir, 'erp.db'));
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('migrations', () => {
  it('creates all 30 ERP tables and the system tables, and is idempotent', async () => {
    await runMigrations(db);
    await runMigrations(db);
    const names = (await db.query("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => String(r.name));
    for (const t of TABLE_NAMES) expect(names).toContain(t);
    for (const t of ['sessions', 'user_secrets', 'company_secrets', 'settings', 'files', 'schema_migrations']) {
      expect(names).toContain(t);
    }
    expect(await db.query('SELECT version FROM schema_migrations')).toHaveLength(1);
  });

  it('uses WAL journal mode', async () => {
    const rows = await db.query('PRAGMA journal_mode');
    expect(rows[0]?.journal_mode).toBe('wal');
  });
});

describe('write transactions', () => {
  it('serializes concurrent writes instead of failing with SQLITE_BUSY', async () => {
    await runMigrations(db);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        db.write(async (tx) => {
          const rs = await tx.execute('SELECT count(*) AS n FROM settings');
          const n = Number(rs.rows[0]?.n);
          await tx.execute({
            sql: 'INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)',
            args: [`k${i}`, String(n), 'now', 'test'],
          });
        }),
      ),
    );
    const values = (await db.query('SELECT value FROM settings')).map((r) => Number(r.value)).sort((a, b) => a - b);
    expect(values).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it('rolls back when the function throws', async () => {
    await runMigrations(db);
    await expect(
      db.write(async (tx) => {
        await tx.execute("INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('a', 'b', 'c', 'd')");
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await db.query('SELECT * FROM settings')).toHaveLength(0);
  });
});

describe('ids and mutex', () => {
  it('generates Airtable-shaped ids and 24-char login keys', () => {
    expect(isRecordId(newRecordId())).toBe(true);
    expect(newAttachmentId()).toMatch(/^att[A-Za-z0-9]{14}$/);
    expect(newLoginKey()).toMatch(/^[a-z0-9]{24}$/);
    expect(newSessionToken().length).toBeGreaterThanOrEqual(43);
    expect(isRecordId('recABC')).toBe(false);
  });

  it('runs tasks in order even when an earlier one fails', async () => {
    const m = new Mutex();
    const order: number[] = [];
    const a = m.run(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
      throw new Error('x');
    });
    const b = m.run(async () => {
      order.push(2);
    });
    await expect(a).rejects.toThrow('x');
    await b;
    expect(order).toEqual([1, 2]);
  });
});
