import type { Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { jsonResponse } from '../helpers/fakeFetch.js';
import { startHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
  await h.apiAs('admin', 'PUT', '/api/settings/freshsalesSubdomain', { value: 'gilt' });
});
afterEach(async () => {
  await h.resetContexts();
});
afterAll(async () => {
  await h?.close();
});

const FS = 'https://gilt.freshworks.com/crm/sales/api/';
const FD = 'https://flptest.freshdesk.com/api/v2/';

// A customer record written by a non-admin (every user may write Customer), with the given CRM id fields.
const plantCustomer = async (name1: string, fields: Record<string, string> = {}): Promise<string> =>
  (
    await h.apiAs<{ id: string }>('vera', 'POST', '/api/data/Customer', {
      fields: { name1, status: 'aktiv', company_id: [h.companies.alpha], ...fields },
    })
  ).id;

// Upstream calls from now on, as "METHOD url".
const upstreamCalls = (): (() => string[]) => {
  const mark = h.fake.calls.length;
  return () => h.fake.calls.slice(mark).map((c) => `${c.method} ${c.url}`);
};
const toasts = (page: Page): Promise<string[]> => page.locator('#toastWrap span.flex-1').allTextContents();
const stored = async (id: string) => (await h.deps.records.get('Customer', id))?.fields ?? {};

describe('CRM sync: ids go into a proxy path only as plain numbers', () => {
  it('the Freshsales sync stops at a planted account id and sends nothing', async () => {
    const id = await plantCustomer('Seilerei Nord', { freshsales_account_id: '../contacts/9' });
    h.fake.on('PUT', FS + 'contacts/9', () => jsonResponse({ contact: { id: 9 } }));
    const page = await h.newPage();
    await h.openApp(page, 'admin');
    const calls = upstreamCalls();
    const ok = await h.run(page, `return await syncCustomerToFreshsales(${JSON.stringify(id)}, null);`);
    expect(calls()).toEqual([]);
    expect(ok).toBe(false);
    expect(await toasts(page)).toEqual(['Ungültige Freshsales-Account-ID beim Kunden – Sync abgebrochen.']);
    expect((await stored(id)).freshsales_synced_at).toBe(undefined);
    await h.assertClean(page);
  });

  it('the Freshdesk sync stops at a planted company id and sends nothing', async () => {
    const id = await plantCustomer('Seilerei Nord', { freshdesk_company_id: '../contacts/7' });
    h.fake.on('PUT', FD + 'contacts/7', () => jsonResponse({ id: 7 }));
    const page = await h.newPage();
    await h.openApp(page, 'admin');
    const calls = upstreamCalls();
    const ok = await h.run(page, `return await syncCustomerToFreshdesk(${JSON.stringify(id)}, null);`);
    expect(calls()).toEqual([]);
    expect(ok).toBe(false);
    expect(await toasts(page)).toEqual(['Ungültige Freshdesk-Firmen-ID beim Kunden – Sync abgebrochen.']);
    expect((await stored(id)).freshdesk_synced_at).toBe(undefined);
    await h.assertClean(page);
  });

  it('the silent sync on use skips planted ids with a console warning only', async () => {
    const id = await plantCustomer('Seilerei Nord', { freshsales_account_id: '../contacts/9', freshdesk_company_id: '../contacts/7' });
    const page = await h.newPage();
    await h.openApp(page, 'admin');
    const warnings: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'warning' && m.text().startsWith('[Lazy-Push')) warnings.push(m.text());
    });
    const calls = upstreamCalls();
    await h.run(page, `await _syncCustomerOnUse(${JSON.stringify(id)});`);
    expect(calls()).toEqual([]);
    expect(warnings.sort()).toEqual([
      `[Lazy-Push FD] customer=${id}: Ungültige Freshdesk-Firmen-ID beim Kunden – Sync abgebrochen.`,
      `[Lazy-Push FS] customer=${id}: Ungültige Freshsales-Account-ID beim Kunden – Sync abgebrochen.`,
    ]);
    expect(await toasts(page)).toEqual([]);
    await h.assertClean(page);
  });

  it('an id from a search result is used only if it is a number', async () => {
    const fsId = await plantCustomer('Netzbau West');
    h.fake.on('GET', FS + 'lookup?q=Netzbau%20West', () =>
      jsonResponse({ sales_accounts: { sales_accounts: [{ id: '../contacts/9', name: 'Netzbau West' }] } }),
    );
    const fdId = await plantCustomer('Netzbau Ost');
    h.fake.on('POST', FD + 'companies', () =>
      jsonResponse({ description: 'Validation failed', errors: [{ field: 'name', message: 'It should be a unique value', code: 'duplicate_value' }] }, 409),
    );
    h.fake.on('GET', FD + 'companies/autocomplete?name=Netzbau%20Ost', () =>
      jsonResponse({ companies: [{ id: '../contacts/7', name: 'Netzbau Ost' }] }),
    );
    const page = await h.newPage();
    await h.openApp(page, 'admin');
    const calls = upstreamCalls();
    const ok = await h.run(
      page,
      `return [await syncCustomerToFreshsales(${JSON.stringify(fsId)}, null), await syncCustomerToFreshdesk(${JSON.stringify(fdId)}, null)];`,
    );
    // Only the searches went out, no PUT.
    expect(calls()).toEqual([
      `GET ${FS}lookup?q=Netzbau%20West&f=name&entities=sales_account`,
      `POST ${FD}companies`,
      `GET ${FD}companies/autocomplete?name=Netzbau%20Ost`,
    ]);
    expect(ok).toEqual([false, false]);
    expect(await toasts(page)).toEqual([
      'Freshsales lieferte eine ungültige Account-ID – Sync abgebrochen.',
      'Sync fehlgeschlagen: Duplikat-Erkennung fehlgeschlagen: Freshdesk lieferte eine ungültige Firmen-ID – Sync abgebrochen.',
    ]);
    await h.assertClean(page);
  });

  it('numeric ids still sync: a stored Freshdesk id and a Freshsales id from the lookup (a JSON number)', async () => {
    const id = await plantCustomer('Tauwerk Ost', { freshdesk_company_id: '4711' });
    h.fake.on('PUT', FD + 'companies/4711', () => jsonResponse({ id: 4711, name: 'Tauwerk Ost' }));
    h.fake.on('GET', FS + 'lookup?q=Tauwerk%20Ost', () =>
      jsonResponse({ sales_accounts: { sales_accounts: [{ id: 815, name: 'Tauwerk Ost' }] } }),
    );
    h.fake.on('PUT', FS + 'sales_accounts/815', () => jsonResponse({ sales_account: { id: 815, name: 'Tauwerk Ost' } }));
    const page = await h.newPage();
    await h.openApp(page, 'admin');
    const calls = upstreamCalls();
    const cid = JSON.stringify(id);
    const ok = await h.run(
      page,
      `return [await syncCustomerToFreshdesk(${cid}, null, { silent: true }), await syncCustomerToFreshsales(${cid}, null, { silent: true })];`,
    );
    expect(calls()).toEqual([
      `PUT ${FD}companies/4711`,
      `GET ${FS}lookup?q=Tauwerk%20Ost&f=name&entities=sales_account`,
      `PUT ${FS}sales_accounts/815`,
    ]);
    expect(ok).toEqual([true, true]);
    const f = await stored(id);
    expect([f.freshdesk_company_id, f.freshsales_account_id]).toEqual(['4711', '815']);
    await h.assertClean(page);
  });

  it('the preview dialogs of the customer modal load nothing for a planted id', async () => {
    h.fake.on('GET', FD + 'contacts/7', () => jsonResponse({ id: 7, name: 'Kontakt' }));
    h.fake.on('GET', FS + 'contacts/9', () => jsonResponse({ contact: { id: 9 } }));
    const page = await h.newPage();
    await h.openApp(page, 'admin');
    const calls = upstreamCalls();
    await h.run(page, `await previewFreshdeskCompany('../contacts/7');`);
    const fdText = await page.locator('#fdCompanyPreview').textContent();
    await h.run(page, `closeModal(); await previewFreshsalesAccount('../contacts/9');`);
    const fsText = await page.locator('#fsAccountPreview').textContent();
    expect(calls()).toEqual([]);
    expect([fdText?.trim(), fsText?.trim()]).toEqual([
      'Konnte Freshdesk-Daten nicht laden: Ungültige CRM-ID – Anfrage abgebrochen.',
      'Konnte Freshsales-Daten nicht laden: Ungültige CRM-ID – Anfrage abgebrochen.',
    ]);
    await h.assertClean(page);
  });
});
