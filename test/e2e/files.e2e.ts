import type { Page } from 'playwright-core';
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

// The Company form's logo fields: file input and preview image.
const LOGO_FIELDS = [
  { field: 'logo', input: '#logoUpload', alt: 'Logo' },
  { field: 'secondary_logo', input: '#secondaryLogoUpload', alt: '2. Logo' },
  { field: 'sub_logo', input: '#subLogoUpload', alt: 'Sub-Logo' },
] as const;

// The upload handlers close the form and reopen it after 80 ms: wait for the fresh, empty file input and a loaded preview.
const uploadAndWaitForReopen = async (page: Page, input: string, alt: string, name: string): Promise<void> => {
  await page.setInputFiles(input, { name, mimeType: 'image/png', buffer: PNG });
  await page.waitForFunction(
    ([input, alt]) => {
      const el = document.querySelector<HTMLInputElement>('#modalBox ' + input);
      const img = document.querySelector<HTMLImageElement>(`#modalBox img[alt="${alt}"]`);
      return !!el && el.files?.length === 0 && !!img && img.complete && img.naturalWidth > 0;
    },
    [input, alt],
  );
};

interface Rec {
  id: string;
  fields: Record<string, unknown>;
}

// File counts of the stored Attachment records with this name.
const storedFileCounts = async (name: string): Promise<number[]> =>
  (await h.apiAs<{ records: Rec[] }>('admin', 'GET', '/api/data/Attachment')).records
    .filter((r) => r.fields.name === name)
    .map((r) => (Array.isArray(r.fields.file) ? r.fields.file.length : 0))
    .sort();

// The first attachment upload of the page is dropped, as on a network drop. Later ones go through.
const dropFirstUpload = async (page: Page): Promise<void> => {
  let dropped = false;
  await page.route('**/api/data/Attachment/*/files/file', (route) => {
    if (dropped) return route.continue();
    dropped = true;
    return route.abort();
  });
};

// "Anlegen + Hochladen": in "Anhänge verwalten" (every user) and on the admin page "Anhänge".
const ATTACHMENT_FORMS = [
  {
    handler: 'addAttachmentWithFile',
    who: 'vera',
    open: 'await openAttachmentManagement();',
    nameInput: '#newAttName',
    fileInput: '#newAttFile',
    list: '#modalBox',
    name: 'AGB 2026',
  },
  {
    handler: '_adminAddAttachment',
    who: 'admin',
    open: 'await renderAdminAttachments();',
    nameInput: '#adminNewAttName',
    fileInput: '#adminNewAttFile',
    list: '#adminAttContent',
    name: 'Datenblatt 2026',
  },
] as const;

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

  it('a replacement logo replaces the old one: form preview, quote PDF and the stored field show only the new file', async () => {
    const id = h.companies.beta;
    const page = await h.newPage();
    await h.openApp(page, 'admin');
    await h.run(page, `await openCompanyModal(${JSON.stringify(id)});`);
    // For each field, the admin uploads alt.png and then picks neu.png in the same form, as the form offers.
    for (const { input, alt } of LOGO_FIELDS) {
      await uploadAndWaitForReopen(page, input, alt, 'alt.png');
      await uploadAndWaitForReopen(page, input, alt, 'neu.png');
    }
    const previews: Record<string, string | undefined> = {};
    for (const { field, alt } of LOGO_FIELDS) {
      previews[field] = (await page.getAttribute(`#modalBox img[alt="${alt}"]`, 'src'))?.split('/').pop();
    }
    // What a quote PDF opened now would render as its logo (the quote editor reads the Company record fresh).
    const pdfLogo = await h.run<string | undefined>(
      page,
      `const c = (await readData('Company')).find((r) => r.id === ${JSON.stringify(id)}).fields;
       return (buildQuoteLogoHtml(c, 40).match(/src="([^"]*)"/) || [])[1]?.split('/').pop();`,
    );
    const record = (await h.deps.records.get('Company', id))?.fields ?? {};
    const stored: Record<string, string[]> = {};
    for (const { field } of LOGO_FIELDS) stored[field] = ((record[field] ?? []) as { filename: string }[]).map((a) => a.filename);

    expect({ previews, pdfLogo, stored }).toEqual({
      previews: { logo: 'neu.png', secondary_logo: 'neu.png', sub_logo: 'neu.png' },
      pdfLogo: 'neu.png',
      stored: { logo: ['neu.png'], secondary_logo: ['neu.png'], sub_logo: ['neu.png'] },
    });
    await h.assertClean(page);
  });

  for (const form of ATTACHMENT_FORMS) {
    it(`${form.handler}: a failed upload removes the new attachment again, so the retry leaves one "${form.name}"`, async () => {
      const page = await h.newPage();
      await h.openApp(page, form.who);
      await h.run(page, form.open);
      await dropFirstUpload(page);
      await page.fill(form.nameInput, form.name);
      await page.setInputFiles(form.fileInput, { name: 'agb.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 AGB') });
      const button = `button[onclick="${form.handler}()"]`;
      await page.dispatchEvent(button, 'click');
      const failToast = page.locator('#toastWrap span.flex-1', { hasText: 'Server nicht erreichbar' });
      await failToast.waitFor();
      const failText = await failToast.textContent();
      const afterFailure = await storedFileCounts(form.name);
      // The inputs are still filled: the user clicks again.
      await page.dispatchEvent(button, 'click');
      // The handler shows the list again after the upload.
      const listed = page.locator(form.list).getByText(form.name, { exact: true });
      await listed.first().waitFor();
      expect({ failText, afterFailure, afterRetry: await storedFileCounts(form.name), listed: await listed.count() }).toEqual({
        failText: 'Datei-Upload fehlgeschlagen – Anhang nicht angelegt: Server nicht erreichbar – bitte Verbindung prüfen',
        afterFailure: [],
        afterRetry: [1],
        listed: 1,
      });
      await h.assertClean(page);
    });
  }

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
