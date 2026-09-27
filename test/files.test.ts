import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sanitizeFilename } from '../server/data/files.js';
import { createTestContext, type TestContext } from './helpers/context.js';

let ctx: TestContext;
let user: { id: string; cookie: string };
let admin: { id: string; cookie: string };
let attachmentId: string;
let companyId: string;

const PDF = Buffer.from('%PDF-1.4 test file');

beforeEach(async () => {
  ctx = await createTestContext();
  user = await ctx.loginAs();
  admin = await ctx.loginAs({ isAdmin: true });
  attachmentId = (await ctx.deps.db.write((tx) => ctx.deps.records.insert(tx, 'Attachment', { name: 'Datenblatt' }))).id;
  companyId = (await ctx.deps.db.write((tx) => ctx.deps.records.insert(tx, 'Company', { name: 'FLP' }))).id;
});
afterEach(async () => {
  await ctx.close();
});

const upload = (cookie: string, table: string, id: string, field: string, data: Buffer, filename: string, contentType = 'application/pdf') =>
  ctx.req(`/api/data/${table}/${id}/files/${field}`, {
    method: 'POST',
    cookie,
    body: { contentType, file: data.toString('base64'), filename },
  });

describe('file upload and download', () => {
  it('stores the file, appends it to the field and serves it back with umlaut-safe headers', async () => {
    const res = await upload(user.cookie, 'Attachment', attachmentId, 'file', PDF, 'Angebot Müller & Söhne.pdf');
    expect(res.status).toBe(200);
    const record = await res.json();
    const [att] = record.fields.file;
    expect(att).toEqual({
      id: expect.stringMatching(/^att[A-Za-z0-9]{14}$/),
      url: `/api/files/${att.id}/${encodeURIComponent('Angebot Müller & Söhne.pdf')}`,
      filename: 'Angebot Müller & Söhne.pdf',
      size: PDF.length,
      type: 'application/pdf',
    });

    const file = await ctx.req(att.url, { cookie: user.cookie });
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer()).equals(PDF)).toBe(true);
    expect(file.headers.get('content-type')).toBe('application/pdf');
    expect(file.headers.get('content-disposition')).toBe(
      `inline; filename="Angebot M_ller & S_hne.pdf"; filename*=UTF-8''${encodeURIComponent('Angebot Müller & Söhne.pdf')}`,
    );
    expect(file.headers.get('cache-control')).toBe('private, max-age=300');
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await ctx.req(att.url)).status).toBe(401);
  });

  it('keeps earlier files when uploading more and allows removing via PATCH [{id}]', async () => {
    const a = (await (await upload(user.cookie, 'Attachment', attachmentId, 'file', PDF, 'a.pdf')).json()).fields.file[0];
    const both = (await (await upload(user.cookie, 'Attachment', attachmentId, 'file', PDF, 'b.pdf')).json()).fields.file;
    expect(both.map((f: { filename: string }) => f.filename)).toEqual(['a.pdf', 'b.pdf']);
    const patched = await ctx.req(`/api/data/Attachment/${attachmentId}`, {
      method: 'PATCH',
      cookie: user.cookie,
      body: { fields: { file: [{ id: a.id }] } },
    });
    expect((await patched.json()).fields.file).toEqual([a]);
    // Removed files stay on disk.
    const stored = await ctx.deps.files.get(both[1].id);
    expect(stored).not.toBeNull();
  });

  it('rejects forged attachment values', async () => {
    const forged = await ctx.req(`/api/data/Attachment/${attachmentId}`, {
      method: 'PATCH',
      cookie: user.cookie,
      body: { fields: { file: [{ id: 'attFAKEFAKEFAKE12', url: 'https://evil.example/x.pdf' }] } },
    });
    expect(forged.status).toBe(422);
    const onCreate = await ctx.req('/api/data/Attachment', {
      method: 'POST',
      cookie: user.cookie,
      body: { fields: { name: 'x', file: [{ url: 'https://evil.example/x.pdf' }] } },
    });
    expect(onCreate.status).toBe(422);
  });

  it('enforces the field allowlist, admin-only logos and the 5 MB limit', async () => {
    expect((await upload(user.cookie, 'Customer', attachmentId, 'file', PDF, 'x.pdf')).status).toBe(400);
    expect((await upload(user.cookie, 'Company', companyId, 'logo', PDF, 'logo.png', 'image/png')).status).toBe(403);
    expect((await upload(admin.cookie, 'Company', companyId, 'logo', PDF, 'logo.png', 'image/png')).status).toBe(200);
    const big = await upload(user.cookie, 'Attachment', attachmentId, 'file', Buffer.alloc(5 * 1024 * 1024 + 1), 'big.pdf');
    expect(big.status).toBe(413);
    expect((await upload(user.cookie, 'Attachment', 'recGONEGONEGONE12', 'file', PDF, 'x.pdf')).status).toBe(404);
  });

  it('writes files under DATA_DIR/files/<id>/ with a sanitized name', async () => {
    const att = (await (await upload(user.cookie, 'Attachment', attachmentId, 'file', PDF, '../../etc/passwd')).json()).fields.file[0];
    expect(att.filename).toBe('_.._etc_passwd');
    const onDisk = await readFile(path.join(ctx.dataDir, 'files', att.id, '_.._etc_passwd'));
    expect(onDisk.equals(PDF)).toBe(true);
    expect(sanitizeFilename('')).toBe('datei');
    expect(sanitizeFilename('..hidden')).toBe('hidden');
  });

  it('shows raster images inline but serves SVG as a download, since SVG can carry script', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const svgAtt = (await (await upload(user.cookie, 'Attachment', attachmentId, 'file', svg, 'zeichnung.svg', 'image/svg+xml')).json()).fields.file[0];
    const svgRes = await ctx.req(svgAtt.url, { cookie: user.cookie });
    expect(svgRes.headers.get('content-disposition')).toMatch(/^attachment; /);
    const png = (await (await upload(user.cookie, 'Attachment', attachmentId, 'file', Buffer.from('PNG'), 'foto.png', 'image/png')).json()).fields.file[1];
    expect((await ctx.req(png.url, { cookie: user.cookie })).headers.get('content-disposition')).toMatch(/^inline; /);
  });

  it('serves unknown ids as 404 and non-image files as attachment downloads', async () => {
    expect((await ctx.req('/api/files/attNOPENOPENOPE12/x', { cookie: user.cookie })).status).toBe(404);
    const att = (await (await upload(user.cookie, 'Attachment', attachmentId, 'file', Buffer.from('a;b'), 'liste.csv', 'text/csv')).json()).fields.file[0];
    const res = await ctx.req(att.url, { cookie: user.cookie });
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; /);
  });
});
