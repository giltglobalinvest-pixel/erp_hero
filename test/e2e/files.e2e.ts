import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.resetContexts();
});
afterAll(async () => {
  await h?.close();
});

// A 1×1 PNG (70 bytes).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('files', () => {
  it('an admin uploads a company logo through the form, its URL serves the image, and removing it works', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'admin');
    await h.run(page, `await openCompanyModal(${JSON.stringify(h.companies.alpha)});`);
    await page.setInputFiles('#logoUpload', { name: 'logo.png', mimeType: 'image/png', buffer: PNG });
    await page.locator('#toastWrap', { hasText: 'Logo hochgeladen' }).waitFor();
    // uploadCompanyLogo reopens the form after 80 ms; the preview shows the stored file.
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>('#modalBox img[alt="Logo"]');
      return !!img && img.complete && img.naturalWidth > 0;
    });
    const src = (await page.locator('#modalBox img[alt="Logo"]').getAttribute('src')) ?? '';
    expect(/^\/api\/files\/att[A-Za-z0-9]{14}\/logo\.png$/.test(src)).toBe(true);
    const res = await page.context().request.get(h.baseUrl + src);
    expect([res.status(), res.headers()['content-type']]).toEqual([200, 'image/png']);
    expect(Buffer.from(await res.body()).equals(PNG)).toBe(true);

    page.once('dialog', (dialog) => void dialog.accept());
    // Tailwind is stubbed, so the button lies below the viewport: activate it with a DOM click.
    await page.dispatchEvent('#modalBox button:has-text("Logo entfernen")', 'click');
    await page.locator('#toastWrap', { hasText: 'Logo entfernt' }).waitFor();
    expect((await h.deps.records.get('Company', h.companies.alpha))?.fields.logo).toBe(undefined);
    // removeCompanyLogo reopens the form as well (now without the preview): wait for it, so assertClean sees the reopen.
    await page.waitForFunction(
      () => !!document.querySelector('#modalBox #logoUpload') && !document.querySelector('#modalBox img[alt="Logo"]'),
    );
    await h.assertClean(page);
  });

  it('a file name with umlauts and spaces uploads and downloads', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    const result = await h.run<Record<string, unknown>>(
      page,
      `const att = await writeData('Attachment', { name: 'Quartal', company_id: [${JSON.stringify(h.companies.alpha)}], status: 'aktiv' });
       const file = new File(['%PDF-1.4 Testinhalt'], 'Übersicht Q3.pdf', { type: 'application/pdf' });
       const rec = await uploadFileToRecord('Attachment', att.id, 'file', file);
       const stored = rec.fields.file[0];
       const res = await fetch(stored.url);
       return {
         urlOk: /^\\/api\\/files\\/att[A-Za-z0-9]{14}\\/%C3%9Cbersicht%20Q3\\.pdf$/.test(stored.url),
         filename: stored.filename, size: stored.size, type: stored.type,
         status: res.status, contentType: res.headers.get('content-type'),
         disposition: res.headers.get('content-disposition'), body: await res.text(),
       };`,
    );
    expect(result).toEqual({
      urlOk: true,
      filename: 'Übersicht Q3.pdf',
      size: 19,
      type: 'application/pdf',
      status: 200,
      contentType: 'application/pdf',
      disposition: `inline; filename="_bersicht Q3.pdf"; filename*=UTF-8''%C3%9Cbersicht%20Q3.pdf`,
      body: '%PDF-1.4 Testinhalt',
    });
    await h.assertClean(page);
  });

  it('refuses a logo upload by a non-admin with the server message, and a file over 5 MB without a request', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    const uploads: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/files/')) uploads.push(r.url());
    });
    expect(
      await h.runError(
        page,
        `await uploadFileToRecord('Company', ${JSON.stringify(h.companies.alpha)}, 'logo', new File(['x'], 'logo.png', { type: 'image/png' }));`,
      ),
    ).toEqual({ message: 'Nur für Admins', status: 403, type: 'FORBIDDEN' });
    const tooBig = await h.runError(
      page,
      `await uploadFileToRecord('Attachment', 'recNichtVorhanden0', 'file', new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'gross.bin'));`,
    );
    expect(tooBig.message).toBe('Datei zu groß (max 5 MB)');
    expect(uploads.length).toBe(1);
    await h.assertClean(page);
  });

  it('a file the browser cannot read gives a clear error and no request', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    const uploads: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/files/')) uploads.push(r.url());
    });
    // As when the file was deleted or moved after it was picked.
    const err = await h.runError(
      page,
      `FileReader.prototype.readAsDataURL = function () { setTimeout(() => this.onerror(new ProgressEvent('error'))); };
       await uploadFileToRecord('Attachment', 'recNichtVorhanden0', 'file', new File(['x'], 'kaputt.txt'));`,
    );
    expect(err.message).toBe('Datei konnte nicht gelesen werden');
    expect(uploads).toEqual([]);
    await h.assertClean(page);
  });

  it('downloads a Freshdesk attachment for the AI through the server when the direct fetch fails', async () => {
    h.fake.on('GET', 'https://attachment.freshdesk.com/inline/', () =>
      new Response(Buffer.from('GIF89a'), { headers: { 'content-type': 'image/gif' } }),
    );
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    const proxyAuth: (string | undefined)[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/attachment-proxy')) proxyAuth.push(r.headers()['authorization']);
    });
    // The CDN sends no CORS headers for the app's origin: the direct attempt fails in a real browser too.
    await page.route('https://attachment.freshdesk.com/**', (route) => route.abort());
    const b64 = await h.run<string | null>(
      page,
      `return await _downloadAttachmentAsBase64({ attachment_url: 'https://attachment.freshdesk.com/inline/attachment?token=t1', size: 6 });`,
    );
    expect(b64).toBe(Buffer.from('GIF89a').toString('base64'));
    expect(proxyAuth).toEqual([undefined]);
    expect(h.fake.calls.map((c) => c.url)).toEqual(['https://attachment.freshdesk.com/inline/attachment?token=t1']);
    await h.assertClean(page);
  });
});
