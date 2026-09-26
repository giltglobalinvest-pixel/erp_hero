import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { list, extract } from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sweepStaleBackupDirs } from '../server/admin/backup.js';
import { openDatabase } from '../server/db/database.js';
import { createTestContext, TEST_ORIGIN, type TestContext } from './helpers/context.js';

let ctx: TestContext;
let admin: { cookie: string };
let out: string;

beforeEach(async () => {
  ctx = await createTestContext();
  admin = await ctx.loginAs({ isAdmin: true });
  out = await mkdtemp(path.join(os.tmpdir(), 'erp-backup-out-'));
});
afterEach(async () => {
  await ctx.close();
  await rm(out, { recursive: true, force: true });
});

describe('GET /api/admin/backup', () => {
  it('downloads a tar.gz with a DB snapshot, the files and a manifest, then cleans up', async () => {
    const att = await ctx.deps.db.write((tx) => ctx.deps.records.insert(tx, 'Attachment', { name: 'Datenblatt' }));
    await ctx.deps.db.write((tx) => ctx.deps.records.insert(tx, 'Invoice', { invoice_no: 'R-1001' }));
    await ctx.req(`/api/data/Attachment/${att.id}/files/file`, {
      method: 'POST',
      cookie: admin.cookie,
      body: { contentType: 'application/pdf', file: Buffer.from('%PDF').toString('base64'), filename: 'blatt.pdf' },
    });

    const res = await ctx.req('/api/admin/backup', { cookie: admin.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/gzip');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="erp-backup-2026-01-05T08-00-00-000Z.tar.gz"');
    const archive = path.join(out, 'backup.tar.gz');
    await writeFile(archive, Buffer.from(await res.arrayBuffer()));

    const entries: string[] = [];
    await list({ file: archive, onReadEntry: (e) => entries.push(e.path) });
    expect(entries).toContain('erp.db');
    expect(entries).toContain('manifest.json');
    expect(entries.some((e) => /^files\/att[A-Za-z0-9]{14}\/blatt\.pdf$/.test(e))).toBe(true);

    await extract({ file: archive, cwd: out });
    const manifest = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8'));
    expect(manifest.created_at).toBe('2026-01-05T08:00:00.000Z');
    expect(manifest.tables).toMatchObject({ Invoice: 1, Attachment: 1, User: 1 });
    const snapshot = await openDatabase(path.join(out, 'erp.db'));
    expect((await snapshot.query('SELECT count(*) AS n FROM "Invoice"'))[0]?.n).toBe(1);
    snapshot.close();

    await new Promise((r) => setTimeout(r, 50));
    expect((await readdir(ctx.dataDir)).filter((n) => n.startsWith('tmp-backup-'))).toEqual([]);
  });

  it('is admin-only', async () => {
    const { cookie } = await ctx.loginAs();
    expect((await ctx.req('/api/admin/backup', { cookie })).status).toBe(403);
  });
});

describe('GET /api/admin/backup when the client disconnects', () => {
  const tmpDirs = async () => (await readdir(ctx.dataDir)).filter((n) => n.startsWith('tmp-backup-'));
  const settle = () => new Promise((r) => setTimeout(r, 100));
  const request = (signal: AbortSignal) =>
    ctx.app.request('/api/admin/backup', { headers: { origin: TEST_ORIGIN, cookie: admin.cookie }, signal });

  beforeEach(async () => {
    // A tiny archive drains into the stream buffers by itself even when nobody reads it. Real backups are
    // megabytes, so give the archive 2 MB of incompressible data.
    const att = await ctx.deps.db.write((tx) => ctx.deps.records.insert(tx, 'Attachment', { name: 'big' }));
    const upload = await ctx.req(`/api/data/Attachment/${att.id}/files/file`, {
      method: 'POST',
      cookie: admin.cookie,
      body: { contentType: 'application/octet-stream', file: randomBytes(2 * 1024 * 1024).toString('base64'), filename: 'big.bin' },
    });
    expect(upload.status).toBe(200);
  });

  it('removes the archive when the client is already gone before the download starts, and the next download is complete', async () => {
    const gone = new AbortController();
    gone.abort();
    const abandoned = await request(gone.signal);
    await settle();
    expect(await tmpDirs()).toEqual([]);
    expect(abandoned.status).toBe(204);
    expect(ctx.logs.some((entry) => /backup/i.test(String(entry.message ?? '')))).toBe(true);

    const res = await ctx.req('/api/admin/backup', { cookie: admin.cookie });
    expect(res.status).toBe(200);
    const bytes = (await res.arrayBuffer()).byteLength;
    expect(bytes).toBeGreaterThan(1024 * 1024);
    expect(String(bytes)).toBe(res.headers.get('content-length'));
    await settle();
    expect(await tmpDirs()).toEqual([]);
  });

  it('removes the archive when the client disconnects during the download', async () => {
    const client = new AbortController();
    const res = await request(client.signal);
    expect(res.status).toBe(200);
    client.abort();
    await settle();
    expect(await tmpDirs()).toEqual([]);
  });

  it('does not report a completed download as abandoned when the connection closes afterwards', async () => {
    // @hono/node-server also aborts the request signal when a client closes its connection after the
    // complete response (curl does; browsers may, once the connection goes idle).
    const client = new AbortController();
    const res = await request(client.signal);
    expect((await res.arrayBuffer()).byteLength).toBe(Number(res.headers.get('content-length')));
    client.abort();
    await settle();
    expect(await tmpDirs()).toEqual([]);
    expect(ctx.logs.filter((entry) => /backup/i.test(String(entry.message ?? '')))).toEqual([]);
  });
});

describe('sweepStaleBackupDirs (at startup)', () => {
  it('removes leftover tmp-backup-* directories and nothing else', async () => {
    await mkdir(path.join(out, 'tmp-backup-a1B2c3'));
    await writeFile(path.join(out, 'tmp-backup-a1B2c3', 'erp.db'), 'stale snapshot');
    await mkdir(path.join(out, 'backup-2026-03-01T12-00-00-000Z'));
    await writeFile(path.join(out, 'backup-2026-03-01T12-00-00-000Z', 'erp.db'), 'OLD');
    await mkdir(path.join(out, 'files', 'attX'), { recursive: true });
    await writeFile(path.join(out, 'erp.db'), 'LIVE');

    expect(await sweepStaleBackupDirs(out)).toEqual(['tmp-backup-a1B2c3']);
    expect((await readdir(out)).sort()).toEqual(['backup-2026-03-01T12-00-00-000Z', 'erp.db', 'files']);
    expect(await readFile(path.join(out, 'backup-2026-03-01T12-00-00-000Z', 'erp.db'), 'utf8')).toBe('OLD');
    expect(await readdir(path.join(out, 'files'))).toEqual(['attX']);
  });
});
