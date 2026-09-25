import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { list, extract } from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../server/db/database.js';
import { createTestContext, type TestContext } from './helpers/context.js';

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
