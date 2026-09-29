// test/e2e/data.e2e.ts
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
  await h.close();
});

describe('data helpers', () => {
  it('readData filters, sorts and sends no Authorization header', async () => {
    const page = await h.newPage();
    const authHeaders: string[] = [];
    page.on('request', (r) => {
      const a = r.headers()['authorization'];
      if (r.url().includes('/api/') && a) authHeaders.push(a);
    });
    await h.openApp(page, 'vera');
    const names = await h.run<string[]>(
      page,
      `const recs = await readData('Company', "{status}='aktiv'", { sort: [{ field: 'name', direction: 'desc' }] });
       return recs.map(r => r.fields.name);`,
    );
    expect(names).toEqual(['Beta AG', 'Alpha GmbH']);
    expect(authHeaders).toEqual([]);
    await h.assertClean(page);
  });

  it('writeData, updateData and deleteData round-trip through /api/data', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    const result = await h.run<{ created: string; updated: string; deleted: boolean; left: number }>(
      page,
      `const c = await writeData('Supplier', { name1: 'Rundreise KG', company_id: [${JSON.stringify(h.companies.alpha)}] });
       const u = await updateData('Supplier', c.id, { name1: 'Rundreise KG & Co' });
       const d = await deleteData('Supplier', c.id);
       const left = (await readData('Supplier')).filter(r => r.id === c.id).length;
       return { created: c.fields.name1, updated: u.fields.name1, deleted: d.deleted, left };`,
    );
    expect(result).toEqual({ created: 'Rundreise KG', updated: 'Rundreise KG & Co', deleted: true, left: 0 });
    await h.assertClean(page);
  });

  it('prefixes server errors and keeps status and type', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    expect(await h.runError(page, `await readData('Nope')`)).toEqual({
      message: 'Lesen fehlgeschlagen: Unbekannte Tabelle: Nope',
      status: 404,
      type: 'NOT_FOUND',
    });
    expect(await h.runError(page, `await writeData('Company', { name: 'Gamma' })`)).toEqual({
      message: 'Schreiben fehlgeschlagen: Nur für Admins',
      status: 403,
      type: 'FORBIDDEN',
    });
    await h.assertClean(page);
  });

  it('reports an unreachable server with the operation prefix', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    await page.route('**/api/data/**', (route) => route.abort());
    const err = await h.runError(page, `await readData('Customer')`);
    expect(err.message).toBe('Lesen fehlgeschlagen: Server nicht erreichbar – bitte Verbindung prüfen');
    await h.assertClean(page);
  });

  it('rejects a 2xx response whose JSON body cannot be parsed', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    await page.route('**/api/data/Bad', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '<<not json>>' }),
    );
    const err = await h.runError(page, `await readData('Bad')`);
    expect(err.message).toBe('Lesen fehlgeschlagen: Ungültige Antwort vom Server');
    await h.assertClean(page);
  });

  it('shows the HTTP status instead of an HTML error page', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    await page.route('**/api/data/Bad', (route) =>
      route.fulfill({ status: 502, contentType: 'text/html', body: '<!DOCTYPE html><html><body>Bad Gateway</body></html>' }),
    );
    const err = await h.runError(page, `await readData('Bad')`);
    expect(err).toEqual({ message: 'Lesen fehlgeschlagen: HTTP 502', status: 502 });
    await h.assertClean(page);
  });

  it('loadCompanies exposes has_mailchimp_key instead of the key', async () => {
    await h.apiAs('admin', 'PATCH', `/api/admin/companies/${h.companies.beta}/secrets`, { mailchimp_api_key: 'mc-key-beta-us21' });
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    const companies = await h.run<Record<string, unknown>[]>(
      page,
      `APP_KEYS.user = { _id: ${JSON.stringify(h.users.vera.id)}, name: 'Vera Vertrieb', is_admin: false,
         allowed_companies: [${JSON.stringify(h.companies.alpha)}, ${JSON.stringify(h.companies.beta)}] };
       await loadCompanies();
       return APP_KEYS.companies;`,
    );
    expect(companies.map((c) => [c.name, c.has_mailchimp_key, 'mailchimp_api_key' in c])).toEqual([
      ['Alpha GmbH', false, false],
      ['Beta AG', true, false],
    ]);
    await h.assertClean(page);
  });
});
