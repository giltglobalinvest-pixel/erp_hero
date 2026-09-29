// test/e2e/auth.e2e.ts
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

// APP_CONFIG.PROJECT_ID in index.html; the old token keys were named after it.
const PROJECT_ID = 'p_1778057282571';

describe('login and session', () => {
  it('logs in through the form and keeps a long-lived cookie when asked', async () => {
    const page = await h.newPage();
    await h.openApp(page);
    await page.fill('#loginKey', h.users.vera.key);
    await page.check('#loginRememberMe');
    await page.click('#loginBtn');
    await page.waitForSelector('#appShell:not(.hidden)', { state: 'visible' });
    expect(await page.locator('#sidebarUserName').textContent()).toBe('Vera Vertrieb');
    expect(await page.inputValue('#loginKey')).toBe('');
    const cookie = (await page.context().cookies()).find((c) => c.name === 'erp_session');
    // Playwright reports a session cookie as expires -1 and a persistent one as a timestamp.
    expect(cookie !== undefined && cookie.expires > 0).toBe(true);
    await h.assertClean(page);
  });

  it('shows the server message for a wrong key', async () => {
    const page = await h.newPage();
    await h.openApp(page);
    await page.fill('#loginKey', 'kein-gueltiger-key');
    await page.click('#loginBtn');
    await page.waitForSelector('#loginError:not(.hidden)', { state: 'visible' });
    expect(await page.locator('#loginError').textContent()).toBe('Ungültiger Login-Key oder Account inaktiv');
    expect(await page.locator('#appShell').isVisible()).toBe(false);
    // The login itself never opens the re-login overlay (Task 11).
    expect(await page.locator('#reauthOverlay').count()).toBe(0);
    await h.assertClean(page);
  });

  it('survives a reload, and logout returns to the login screen', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    expect(await page.locator('#appShell').isVisible()).toBe(true);
    await page.reload();
    await page.waitForSelector('#appShell:not(.hidden)', { state: 'visible' });
    expect(await page.locator('#sidebarUserName').textContent()).toBe('Vera Vertrieb');
    // logout() reloads the page, so it is started from a timer instead of being awaited.
    await page.evaluate('setTimeout(logout, 0)');
    await page.waitForSelector('#loginScreen:not(.hidden)', { state: 'visible' });
    const me = await page.context().request.get(`${h.baseUrl}/api/me`);
    expect(me.status()).toBe(401);
    await h.assertClean(page);
  });

  it('removes the old token keys from browser storage', async () => {
    const page = await h.newPage();
    // Any page of the origin will do to prepare the storage before the app starts.
    await page.goto(`${h.baseUrl}/healthz`);
    await h.run(
      page,
      `localStorage.setItem('session_token_${PROJECT_ID}', 'alt');
       sessionStorage.setItem('session_token_${PROJECT_ID}', 'alt');
       localStorage.setItem('user_key_${PROJECT_ID}', 'alt');`,
    );
    await h.openApp(page);
    const left = await h.run<unknown[]>(
      page,
      `return [
         localStorage.getItem('session_token_${PROJECT_ID}'),
         sessionStorage.getItem('session_token_${PROJECT_ID}'),
         localStorage.getItem('user_key_${PROJECT_ID}'),
       ];`,
    );
    expect(left).toEqual([null, null, null]);
    await h.assertClean(page);
  });

  it('takes the user from the server and loads companies, user names and settings', async () => {
    await h.apiAs('admin', 'PUT', '/api/settings/freshdeskTicketTypes', { value: 'Anfrage,Bestellung' });
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    const state = await h.run<Record<string, unknown>>(
      page,
      `return {
         user: APP_KEYS.user,
         proxyV2: APP_KEYS.proxyV2,
         companies: APP_KEYS.companies.map(c => c.name),
         users: Object.values(APP_KEYS.usersById).map(u => u.name).sort(),
         ticketTypes: APP_KEYS.freshdeskTicketTypes,
         domain: APP_KEYS.freshdeskDomain,
       };`,
    );
    expect(state).toEqual({
      user: {
        _id: h.users.vera.id,
        name: 'Vera Vertrieb',
        role: 'Vertrieb',
        is_admin: false,
        allowed_companies: [h.companies.alpha, h.companies.beta],
        freshdesk_company_keys: [h.companies.alpha],
        has_freshdesk_key: false,
      },
      proxyV2: true,
      companies: ['Alpha GmbH', 'Beta AG'],
      users: ['Ada Admin', 'Vera Vertrieb'],
      ticketTypes: 'Anfrage,Bestellung',
      domain: null,
    });
    await h.assertClean(page);
  });

  it('shows the login screen and a connection message when the server cannot be reached', async () => {
    const page = await h.newPage();
    // tryAutoLogin never throws: an unreachable /api/me must not leave the app on the boot screen.
    await page.route('**/api/me', (route) => route.abort());
    await h.openApp(page);
    expect(await page.locator('#loginScreen').isVisible()).toBe(true);
    await page.route('**/api/auth', (route) => route.abort());
    await page.fill('#loginKey', h.users.vera.key);
    await page.click('#loginBtn');
    await page.waitForSelector('#loginError:not(.hidden)', { state: 'visible' });
    expect(await page.locator('#loginError').textContent()).toBe('Server nicht erreichbar – bitte Verbindung prüfen');
    expect(await page.locator('#appShell').isVisible()).toBe(false);
    await h.assertClean(page);
  });

  it('a 2xx answer without a user is an error, not a crash', async () => {
    const page = await h.newPage();
    // Something between browser and server (a captive portal, a proxy) answers instead of the server.
    await page.route('**/api/me', (route) => route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' }));
    await h.openApp(page);
    expect(await page.locator('#loginScreen').isVisible()).toBe(true);
    await page.route('**/api/auth', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    await page.fill('#loginKey', h.users.vera.key);
    await page.click('#loginBtn');
    await page.waitForSelector('#loginError:not(.hidden)', { state: 'visible' });
    expect(await page.locator('#loginError').textContent()).toBe('Ungültige Antwort vom Server');
    expect(await page.locator('#appShell').isVisible()).toBe(false);
    await h.assertClean(page);
  });
});

describe('server settings', () => {
  it('_applySettings sets each of the five fields to its string value or null', async () => {
    const page = await h.newPage();
    await h.openApp(page);
    const result = await h.run<Record<string, unknown>>(
      page,
      `_applySettings({ freshdeskSalesGroupId: '4711', freshdeskOrderGroupId: '', freshdeskTicketTypes: 7, freshdeskDomain: 'flp', ignoriert: 'x' });
       const applied = _SETTING_KEYS.map(k => APP_KEYS[k]);
       _applySettings(undefined);
       return { keys: _SETTING_KEYS, applied, cleared: _SETTING_KEYS.map(k => APP_KEYS[k]), stray: 'ignoriert' in APP_KEYS };`,
    );
    expect(result).toEqual({
      keys: ['freshdeskSalesGroupId', 'freshdeskOrderGroupId', 'freshdeskTicketTypes', 'freshdeskDomain', 'freshsalesSubdomain'],
      applied: ['4711', null, null, 'flp', null],
      cleared: [null, null, null, null, null],
      stray: false,
    });
    await h.assertClean(page);
  });

  it('loadSettings logs and keeps the old values when the request fails', async () => {
    await h.apiAs('admin', 'PUT', '/api/settings/freshsalesSubdomain', { value: 'flpsales' });
    try {
      const page = await h.newPage();
      const warnings: string[] = [];
      page.on('console', (m) => {
        // Other warnings (e.g. the blocked service worker) are not what is under test.
        if (m.type() === 'warning' && m.text().startsWith('Einstellungen')) warnings.push(m.text());
      });
      await h.openApp(page, 'vera');
      expect(await h.run(page, `return APP_KEYS.freshsalesSubdomain;`)).toBe('flpsales');
      await page.route('**/api/settings', (route) =>
        route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"type":"INTERNAL","message":"kaputt"}}' }),
      );
      // loadSettings must resolve (never reject) and leave the loaded values alone.
      expect(await h.run(page, `await loadSettings(); return APP_KEYS.freshsalesSubdomain;`)).toBe('flpsales');
      expect(warnings).toEqual(['Einstellungen konnten nicht geladen werden: kaputt']);
      await h.assertClean(page);
    } finally {
      await h.apiAs('admin', 'DELETE', '/api/settings/freshsalesSubdomain');
    }
  });
});
