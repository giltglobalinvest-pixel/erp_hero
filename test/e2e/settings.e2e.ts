// test/e2e/settings.e2e.ts
import type { Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { jsonResponse } from '../helpers/fakeFetch.js';
import { startHarness, type Harness } from './harness.js';

const FD = 'https://flptest.freshdesk.com/api/v2/';
const basic = (user: string, password: string): string => 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');

let h: Harness;
// The answer to the Freshsales lookup that "Verbindung testen" sends (the harness sets FRESHSALES_SUBDOMAIN=gilt).
const FS_LOOKUP_OK = (): Response => jsonResponse({});
let fsLookup = FS_LOOKUP_OK;
beforeAll(async () => {
  h = await startHarness();
  // Every render of the settings page loads the Freshdesk groups for the dropdowns.
  h.fake.on('GET', FD + 'groups', () => jsonResponse([{ id: 11, name: 'Vertrieb' }, { id: 12, name: 'Bestellungen' }]));
  h.fake.on('GET', 'https://gilt.freshworks.com/crm/sales/api/lookup', () => fsLookup());
});
afterEach(async () => {
  await h.resetContexts();
});
afterAll(async () => {
  await h?.close();
});

const callsTo = (prefix: string) => h.fake.calls.filter((c) => c.url.startsWith(prefix));
const settings = async (): Promise<Record<string, string>> =>
  (await h.apiAs<{ settings: Record<string, string> }>('admin', 'GET', '/api/settings')).settings;
const companyFields = async (id: string): Promise<Record<string, unknown>> =>
  (await h.deps.records.get('Company', id))?.fields ?? {};
// Headers of the page's own /api requests whose URL contains `part`, collected from now on.
const apiRequests = (page: Page, part: string): Record<string, string>[] => {
  const seen: Record<string, string>[] = [];
  page.on('request', (r) => {
    if (r.url().startsWith(h.baseUrl + '/api/') && r.url().includes(part)) seen.push(r.headers());
  });
  return seen;
};
const toast = (page: Page, text: string): Promise<void> => page.locator('#toastWrap', { hasText: text }).waitFor();
// Opens the settings page as the admin. showApp() renders the start page synchronously, so nothing
// overwrites the settings page afterwards. The 5 s limit lets a page that never renders fail fast.
const openSettings = async (page: Page): Promise<void> => {
  await h.openApp(page, 'admin');
  await h.run(page, 'await renderAdminSettings();');
  await page.locator('#settingsFdDomain').waitFor({ timeout: 5_000 });
};
// A save re-renders the page. The toast appears in the same task that starts the re-render,
// so after the toast the old input is gone, and this waits for the fresh one.
const inputShows = (page: Page, selector: string, value: string): Promise<unknown> =>
  page.waitForFunction(
    ([sel, want]) => document.querySelector<HTMLInputElement | HTMLSelectElement>(sel)?.value === want,
    [selector, value] as const,
  );

describe('settings page', () => {
  it('saves the Freshdesk domain on the server, and it survives a reload (scenario 9)', async () => {
    const page = await h.newPage();
    await openSettings(page);
    await page.fill('#settingsFdDomain', 'https://flpliftparts.freshdesk.com/');
    await page.click('button[onclick="saveFreshdeskDomain()"]');
    await toast(page, 'Freshdesk-Domain gespeichert');
    expect((await settings()).freshdeskDomain).toBe('flpliftparts');
    expect(await h.run(page, 'return APP_KEYS.freshdeskDomain;')).toBe('flpliftparts');
    // Let the re-render finish before reloading, so no request is cut off.
    await inputShows(page, '#settingsFdDomain', 'flpliftparts');

    await page.reload();
    await page.waitForSelector('#appShell:not(.hidden)', { state: 'visible' });
    // The boot loads the settings before it shows the app shell.
    expect(await h.run(page, 'return APP_KEYS.freshdeskDomain;')).toBe('flpliftparts');
    await h.run(page, 'await renderAdminSettings();');
    expect(await page.inputValue('#settingsFdDomain')).toBe('flpliftparts');
    await h.assertClean(page);
  });

  it('shows no Val.town setup, offers the Freshdesk groups and tests the connection to the server', async () => {
    const page = await h.newPage();
    await openSettings(page);
    const text = await page.locator('#pageContent').innerText();
    expect(/val\.?town|Master-Base|Proxy-URL/i.test(text)).toBe(false);
    expect(await page.locator('#valtownCodeBlock, #valtownKeyInput, #settingsProxyUrl, #settingsFsApiKey').count()).toBe(0);
    expect(await page.locator('#settingsSalesGroupId option').allTextContents()).toEqual([
      '— keine Default-Sales-Gruppe —',
      'Bestellungen (#12)',
      'Vertrieb (#11)',
    ]);
    await page.selectOption('#settingsSalesGroupId', '11');
    await page.click('button[onclick="saveSalesGroupId()"]');
    await toast(page, 'Sales-Group-ID gespeichert');
    expect((await settings()).freshdeskSalesGroupId).toBe('11');
    await inputShows(page, '#settingsSalesGroupId', '11');

    await page.click('button[onclick="testProxyConnection()"]');
    const result = page.locator('#proxyTestResult', { hasText: 'Verbindung erfolgreich' });
    await result.waitFor();
    const resultText = await result.innerText();
    expect(resultText.includes('Authentifiziert als Ada Admin (admin).')).toBe(true);
    // The admin has no Freshdesk key, so the page points to the server's fallback key.
    expect(resultText.includes('FRESHDESK_API_KEY')).toBe(true);
    await h.assertClean(page);
  });

  it('normalizes the ticket types, deletes the setting when emptied, and skips a save without change', async () => {
    const page = await h.newPage();
    await openSettings(page);
    await page.fill('#settingsTicketTypes', ' Anfrage ,, Bestellung ');
    await page.click('button[onclick="saveTicketTypes()"]');
    await toast(page, 'Ticket-Typen-Filter gespeichert');
    expect((await settings()).freshdeskTicketTypes).toBe('Anfrage, Bestellung');
    await inputShows(page, '#settingsTicketTypes', 'Anfrage, Bestellung');

    await page.fill('#settingsTicketTypes', '');
    await page.click('button[onclick="saveTicketTypes()"]');
    await toast(page, 'Filter entfernt — alle Tickettypen');
    expect('freshdeskTicketTypes' in (await settings())).toBe(false);
    expect(await h.run(page, 'return APP_KEYS.freshdeskTicketTypes;')).toBe(null);
    await inputShows(page, '#settingsTicketTypes', '');

    // Nothing set and nothing typed: no request at all.
    const puts = apiRequests(page, '/settings/');
    await page.click('button[onclick="saveTicketTypes()"]');
    await toast(page, 'Kein Filter (alle Tickettypen)');
    expect(puts).toEqual([]);
    await h.assertClean(page);
  });

  it('refuses settings changes by a non-admin', async () => {
    const before = (await settings()).freshdeskDomain;
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    expect(await h.runError(page, "await saveSetting('freshdeskDomain', 'fremd');")).toEqual({
      message: 'Nur für Admins',
      status: 403,
      type: 'FORBIDDEN',
    });
    expect((await settings()).freshdeskDomain).toBe(before);
    await h.run(page, 'await renderAdminSettings();');
    expect((await page.locator('#pageContent').innerText()).includes('Nur für Admins.')).toBe(true);
    await h.assertClean(page);
  });

  it('stores a Mailchimp key encrypted on the server and never shows it again (scenario 11)', async () => {
    h.fake.on('GET', 'https://us21.api.mailchimp.com/3.0/ping', () => jsonResponse({ health_status: "Everything's Chimpy!" }));
    h.fake.on('GET', 'https://us21.api.mailchimp.com/3.0/lists', () =>
      jsonResponse({ lists: [{ id: 'l1', name: 'Newsletter', stats: { member_count: 3 } }] }),
    );
    const alpha = h.companies.alpha;
    const row = `[data-mc-row-company="${alpha}"]`;
    const page = await h.newPage();
    await openSettings(page);
    const secretCalls = apiRequests(page, '/admin/companies/');
    const mailchimpCalls = apiRequests(page, '/mailchimp/');
    const statusShows = (text: string) => page.locator(`[data-mc-status="${alpha}"]`, { hasText: text }).waitFor();

    await page.fill(`${row} [data-mc-input="api_key"]`, 'mc-key-alpha-us21');
    await page.fill(`${row} [data-mc-input="list_id"]`, 'list-alpha');
    await page.click(`${row} button[onclick^="_mcSaveCompany"]`);
    await statusShows('✓ Gespeichert');
    const fields = await companyFields(alpha);
    expect([fields.mailchimp_server_prefix, fields.mailchimp_list_id, 'mailchimp_api_key' in fields]).toEqual([
      'us21',
      'list-alpha',
      false,
    ]);
    expect(await h.deps.secrets.mailchimpKey(alpha)).toBe('mc-key-alpha-us21');
    expect(secretCalls.length).toBe(1);
    // The browser keeps no key: the cache has the flag only, and the input is empty again.
    expect(
      await h.run(
        page,
        `const c = APP_KEYS.companies.find(x => x.id === ${JSON.stringify(alpha)});
         return [c.has_mailchimp_key, 'mailchimp_api_key' in c];`,
      ),
    ).toEqual([true, false]);
    expect(await page.inputValue(`${row} [data-mc-input="api_key"]`)).toBe('');
    expect(await page.getAttribute(`${row} [data-mc-input="api_key"]`, 'placeholder')).toBe('leer = unverändert');
    expect(await page.inputValue(`${row} [data-mc-input="server_prefix"]`)).toBe('us21');

    // Test and audience list use the stored key; a second save keeps it.
    await page.click(`${row} button[onclick^="_mcTestConnection"]`);
    await statusShows("Verbindung OK: Everything's Chimpy!");
    await page.click(`${row} button[onclick^="_mcLoadAudiences"]`);
    await page.click(`${row} [data-mc-pick-list-id="l1"]`);
    // The status reads "Verbindung OK" now, so "Gespeichert" comes from this save.
    await page.click(`${row} button[onclick^="_mcSaveCompany"]`);
    await statusShows('✓ Gespeichert');
    const after = await companyFields(alpha);
    expect([after.mailchimp_server_prefix, after.mailchimp_list_id, after.mailchimp_list_name]).toEqual([
      'us21',
      'l1',
      'Newsletter',
    ]);
    expect(await h.deps.secrets.mailchimpKey(alpha)).toBe('mc-key-alpha-us21');
    expect(secretCalls.length).toBe(1);
    expect(mailchimpCalls.map((s) => [s['x-company-id'], s['x-mailchimp-key'], s['x-mailchimp-server']])).toEqual([
      [alpha, undefined, undefined],
      [alpha, undefined, undefined],
    ]);
    expect(callsTo('https://us21.api.mailchimp.com/3.0/').map((c) => c.headers.get('authorization'))).toEqual([
      basic('anystring', 'mc-key-alpha-us21'),
      basic('anystring', 'mc-key-alpha-us21'),
    ]);
    await h.assertClean(page);
  });

  it('tests Mailchimp with the stored key while the key input is empty, and with a typed key without saving it', async () => {
    const beta = h.companies.beta;
    await h.apiAs('admin', 'PATCH', `/api/admin/companies/${beta}/secrets`, { mailchimp_api_key: 'mc-key-beta-us19' });
    h.fake.on('GET', 'https://us19.api.mailchimp.com/3.0/ping', () => jsonResponse({ health_status: 'Gespeicherter Key OK' }));
    h.fake.on('GET', 'https://us5.api.mailchimp.com/3.0/ping', () => jsonResponse({ health_status: 'Neuer Key OK' }));
    const row = `[data-mc-row-company="${beta}"]`;
    const page = await h.newPage();
    await openSettings(page);
    const sent = apiRequests(page, '/mailchimp/');
    const statusShows = (text: string) => page.locator(`[data-mc-status="${beta}"]`, { hasText: text }).waitFor();
    expect(await page.inputValue(`${row} [data-mc-input="api_key"]`)).toBe('');

    await page.click(`${row} button[onclick^="_mcTestConnection"]`);
    await statusShows('Verbindung OK: Gespeicherter Key OK');
    await page.fill(`${row} [data-mc-input="api_key"]`, 'mc-key-neu-us5');
    await page.click(`${row} button[onclick^="_mcTestConnection"]`);
    await statusShows('Verbindung OK: Neuer Key OK');

    expect(sent.map((s) => [s['x-company-id'], s['x-mailchimp-key'], s['x-mailchimp-server']])).toEqual([
      [beta, undefined, undefined],
      [beta, 'mc-key-neu-us5', 'us5'],
    ]);
    expect(callsTo('https://us19.api.mailchimp.com/').map((c) => c.headers.get('authorization'))).toEqual([
      basic('anystring', 'mc-key-beta-us19'),
    ]);
    expect(callsTo('https://us5.api.mailchimp.com/').map((c) => c.headers.get('authorization'))).toEqual([
      basic('anystring', 'mc-key-neu-us5'),
    ]);
    // Testing saves nothing.
    expect(await h.deps.secrets.mailchimpKey(beta)).toBe('mc-key-beta-us19');
    await h.assertClean(page);
  });

  it('removes a stored Mailchimp key after a confirmation and keeps the server prefix and audience', async () => {
    const beta = h.companies.beta;
    await h.apiAs('admin', 'PATCH', `/api/admin/companies/${beta}/secrets`, { mailchimp_api_key: 'mc-key-beta-us19' });
    await h.apiAs('admin', 'PATCH', `/api/data/Company/${beta}`, {
      fields: { mailchimp_server_prefix: 'us19', mailchimp_list_id: 'list19' },
    });
    const row = `[data-mc-row-company="${beta}"]`;
    const page = await h.newPage();
    await openSettings(page);
    const removeButton = page.locator(`${row} button`, { hasText: 'Key entfernen' });
    expect(await removeButton.count()).toBe(1);
    const sent: (string | null)[] = [];
    page.on('request', (r) => {
      if (r.url().startsWith(h.baseUrl + '/api/admin/companies/')) sent.push(r.postData());
    });
    const asked: string[] = [];
    let accept = false;
    page.on('dialog', (d) => {
      asked.push(d.message());
      void (accept ? d.accept() : d.dismiss());
    });

    // Cancelled: nothing is sent, and the key stays.
    await removeButton.click();
    expect(asked.length).toBe(1);
    expect(await h.deps.secrets.mailchimpKey(beta)).toBe('mc-key-beta-us19');

    accept = true;
    await removeButton.click();
    await toast(page, 'Mailchimp-Key entfernt');
    // The re-rendered row treats Beta as not linked: no "gespeichert", no remove button.
    await page.locator(`${row} [data-mc-input="api_key"][placeholder="xxxxx-us21"]`).waitFor();
    expect(await page.locator(`${row} label`).first().innerText()).toBe('API-Key');
    expect(await removeButton.count()).toBe(0);
    const question = 'Mailchimp-Key von „Beta AG" wirklich entfernen?\n\nServer-Prefix und Audience bleiben gespeichert.';
    expect(asked).toEqual([question, question]);
    expect(sent).toEqual([JSON.stringify({ mailchimp_api_key: null })]);
    expect(await h.deps.secrets.mailchimpKey(beta)).toBe(null);
    expect(
      await h.run(page, `return APP_KEYS.companies.find(x => x.id === ${JSON.stringify(beta)}).has_mailchimp_key;`),
    ).toBe(false);
    const fields = await companyFields(beta);
    expect([fields.mailchimp_server_prefix, fields.mailchimp_list_id]).toEqual(['us19', 'list19']);
    await h.assertClean(page);
  });

  it('saves the Freshsales subdomain without a token field and tests the server key', async () => {
    const page = await h.newPage();
    await openSettings(page);
    expect(await page.locator('#settingsFsApiKey').count()).toBe(0);
    await page.fill('#settingsFsDomain', 'https://gilt.freshworks.com/crm/sales/');
    await page.click('button[onclick="saveFreshsalesSetup(this)"]');
    await toast(page, 'Freshsales-Subdomain gespeichert');
    expect((await settings()).freshsalesSubdomain).toBe('gilt');
    // The test button is rendered once a subdomain is set; click waits for the re-render.
    await page.click('button[onclick="testFreshsalesConnection(this)"]');
    await toast(page, '✓ Freshsales-API erreichbar · Token + Server-Subdomain (FRESHSALES_SUBDOMAIN) OK');
    const [lookup] = callsTo('https://gilt.freshworks.com/crm/sales/api/lookup');
    expect(lookup?.headers.get('authorization')).toBe('Token token=test-freshsales-key');
    expect((await page.locator('#pageContent').innerText()).includes('FRESHSALES_API_KEY')).toBe(true);
    await h.assertClean(page);
  });

  it('sends a Freshsales 404 to the Railway variable FRESHSALES_SUBDOMAIN, not to the subdomain saved here', async () => {
    fsLookup = () => jsonResponse({ errors: { code: 404, message: 'Not Found' } }, 404);
    try {
      const page = await h.newPage();
      await openSettings(page);
      await page.fill('#settingsFsDomain', 'https://gilt-crm.freshworks.com/crm/sales/');
      await page.click('button[onclick="saveFreshsalesSetup(this)"]');
      await toast(page, 'Freshsales-Subdomain gespeichert');
      expect((await settings()).freshsalesSubdomain).toBe('gilt-crm');
      await inputShows(page, '#settingsFsDomain', 'gilt-crm');
      // Toasts disappear after a few seconds, so each one is recorded as it appears.
      await h.run(
        page,
        `window.__toastTexts = [];
         new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => window.__toastTexts.push(n.textContent))))
           .observe(document.getElementById('toastWrap'), { childList: true });`,
      );
      const callsBefore = h.fake.calls.length;

      await page.click('button[onclick="testFreshsalesConnection(this)"]');
      await page.waitForFunction(() => (window as unknown as { __toastTexts: string[] }).__toastTexts.length > 0);
      // The server called the subdomain from its own environment, not the one saved above.
      const hosts = h.fake.calls
        .slice(callsBefore)
        .filter((c) => c.url.includes('freshworks.com'))
        .map((c) => new URL(c.url).host);
      expect(hosts).toEqual(['gilt.freshworks.com']);
      expect(await h.run<string[]>(page, 'return window.__toastTexts;')).toEqual([
        'Freshsales antwortet 404 — Railway-Variable FRESHSALES_SUBDOMAIN prüfen (die Subdomain hier gilt nur für Links und den Sync-Schalter).',
      ]);
      await h.assertClean(page);
    } finally {
      fsLookup = FS_LOOKUP_OK;
    }
  });
});
