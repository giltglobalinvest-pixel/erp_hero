// test/e2e/session-tabs.e2e.ts
// All tabs of one browser share the session cookie, while each tab shows the user it started with. After a login or
// logout in one tab, a tab that shows another user must not go on acting as whoever holds the cookie now.
import type { Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { jsonResponse } from '../helpers/fakeFetch.js';
import { startHarness, type Harness, type Who } from './harness.js';

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

const FD = 'https://flptest.freshdesk.com/api/v2/';
const basic = (user: string, password: string): string => 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
const nameOf = (id: unknown): string => Object.values(h.users).find((u) => u.id === id)?.name ?? String(id);
const newCustomer = async (name1: string): Promise<string> =>
  (
    await h.apiAs<{ id: string }>('admin', 'POST', '/api/data/Customer', {
      fields: { name1, status: 'aktiv', company_id: [h.companies.alpha] },
    })
  ).id;
const lockHolder = async (id: string): Promise<unknown> => (await h.deps.records.get('Customer', id))?.fields.lock_user_id;

interface Step {
  ui: string | null; // the user whose screen the tab showed when it sent the request (null: no app screen)
  result: string;
}
// Runs page code and records which user's screen the tab showed at that moment: the sidebar name while the app shell
// is visible, mapped to the user id. A throw in the page becomes 'error: …', a page that navigated away 'page gone: …'.
const step = async (page: Page, body: string): Promise<Step> => {
  try {
    const run = await h.run<{ shown: string | null; result: string }>(
      page,
      `const shell = document.getElementById('appShell');
       const shown = shell && !shell.classList.contains('hidden')
         ? (document.getElementById('sidebarUserName')?.textContent || '').trim() || null
         : null;
       try { const result = await (async () => { ${body} })(); return { shown, result: String(result) }; }
       catch (e) { return { shown, result: 'error: ' + e.message }; }`,
    );
    const ui = run.shown === null ? null : (Object.values(h.users).find((u) => u.name === run.shown)?.id ?? run.shown);
    return { ui, result: run.result };
  } catch (e) {
    return { ui: null, result: 'page gone: ' + (e as Error).message };
  }
};
// A second tab in the same browser: same context, so the same cookie jar and the same BroadcastChannel.
const secondTab = async (first: Page, shown = '#appShell'): Promise<{ tab: Page; errors: string[] }> => {
  const tab = await first.context().newPage();
  const errors: string[] = [];
  tab.on('pageerror', (e) => errors.push(e.message));
  await tab.goto(`${h.baseUrl}/`);
  await tab.waitForSelector(`${shown}:not(.hidden)`, { state: 'visible' });
  return { tab, errors };
};
// `who` logs in through the login form of this tab.
const formLogin = async (tab: Page, who: Who): Promise<void> => {
  await tab.fill('#loginKey', h.users[who].key);
  await tab.press('#loginKey', 'Enter');
  await tab.waitForSelector('#appShell:not(.hidden)', { state: 'visible' });
  expect(await tab.locator('#sidebarUserName').textContent()).toBe(h.users[who].name);
};
// The user of this tab logs out, and `who` logs in here through the login form.
const switchUserInTab = async (tab: Page, who: Who): Promise<void> => {
  const reloaded = tab.waitForEvent('load');
  await h.run(tab, 'logout(); return null;');
  await reloaded;
  await tab.waitForSelector('#loginScreen:not(.hidden)', { state: 'visible' });
  await formLogin(tab, who);
};
const ME = `return (await _api('GET', '/me')).user.id;`;
const meViolation = (me: Step): string[] =>
  me.ui !== null && !me.result.startsWith('error') && !me.result.startsWith('page gone') && me.result !== me.ui
    ? [`GET /me answers ${nameOf(me.result)} to a tab showing ${nameOf(me.ui)}`]
    : [];
// Whether the page loads again within a few seconds.
const reloads = (page: Page): Promise<boolean> =>
  page.waitForEvent('load', { timeout: 5_000 }).then(
    () => true,
    () => false,
  );
// From now on, records each decision of the tab about a session user it was told about: [user id, reloaded].
// The spy calls the page's own decision; a tab that reloads loses the record, which fails the test.
const watchDecisions = (page: Page): Promise<void> =>
  h.run(
    page,
    `window.__decisions = [];
     const decide = _reloadIfOtherUser;
     window._reloadIfOtherUser = (userId) => {
       const reloaded = decide(userId);
       window.__decisions.push([userId, reloaded]);
       return reloaded;
     };`,
  );
const decisions = async (page: Page, count: number): Promise<unknown> => {
  await page.waitForFunction((n) => (window as unknown as { __decisions: unknown[] }).__decisions.length >= n, count);
  return h.run(page, 'return window.__decisions;');
};

describe('one browser, two tabs, a user switch in one of them', () => {
  it("Vera's other tab does not go on as Ada after Ada logs in in the first tab", async () => {
    h.fake.on('GET', FD + 'tickets/101', () => jsonResponse({ id: 101, subject: 'Anfrage Alpha' }));
    const held = JSON.stringify(await newCustomer('Tabs Vorher GmbH'));
    const openedId = await newCustomer('Tabs Nachher GmbH');
    const opened = JSON.stringify(openedId);
    const alpha = JSON.stringify(h.companies.alpha);
    const vera = h.users.vera.id;

    const tab1 = await h.newPage();
    await h.openApp(tab1, 'vera');
    const { tab: tab2, errors } = await secondTab(tab1);

    // Before the switch tab 2 is Vera's on the server too: no admin rights, and her lock.
    expect(await step(tab2, ME)).toEqual({ ui: vera, result: vera });
    expect(await step(tab2, `await writeData('Company', { name: 'Tabs vorher', status: 'aktiv' }); return 'created';`)).toEqual({
      ui: vera,
      result: 'error: Schreiben fehlgeschlagen: Nur für Admins',
    });
    expect(await step(tab2, `return JSON.stringify(await acquireLock('Customer', ${held}));`)).toEqual({
      ui: vera,
      result: '{"ok":true}',
    });

    await switchUserInTab(tab1, 'admin');

    // Tab 2 was not touched. What it does next:
    const violations: string[] = [];
    const me = await step(tab2, ME);
    violations.push(...meViolation(me));

    const company = await step(tab2, `await writeData('Company', { name: 'Tabs nachher', status: 'aktiv' }); return 'created';`);
    if (company.ui === vera && company.result === 'created') violations.push('a tab showing Vera (no admin) created a Mandant');

    const callsBefore = h.fake.calls.length;
    const fd = await step(tab2, `APP_KEYS.currentCompanyId = ${alpha}; return (await freshdeskFetch('tickets/101')).id;`);
    const keys = h.fake.calls.slice(callsBefore).map((c) => c.headers.get('authorization'));
    if (fd.ui === vera && keys.some((k) => k !== basic('fd-key-alpha', 'X'))) {
      violations.push("a Freshdesk call from a tab showing Vera went upstream with another user's key");
    }

    // The 2-minute heartbeat tick of Vera's lock, run now.
    const tick = await step(tab2, `await _lockHeartbeatTick('Customer', ${held}); return 'ticked';`);
    const toasts = (await tab2.locator('#toastWrap').textContent()) ?? '';
    if (tick.ui === vera && toasts.includes('Sperre verloren – der Datensatz wird jetzt von Vera Vertrieb bearbeitet')) {
      violations.push('the heartbeat reports that Vera Vertrieb took over the lock of the tab showing Vera');
    }

    const lock = await step(tab2, `return JSON.stringify(await acquireLock('Customer', ${opened}));`);
    const holder = await lockHolder(openedId);
    if (lock.ui === vera && holder !== undefined && holder !== vera) {
      violations.push(`a lock taken in a tab showing Vera is held by ${nameOf(holder)}`);
    }
    const foreign = await step(tab2, `const rec = await _api('GET', '/data/Customer/' + ${opened}); return String(isLockedByOther(rec));`);
    if (foreign.ui === vera && lock.result === '{"ok":true}' && foreign.result === 'true') {
      violations.push('the tab shows its own new lock as held by someone else');
    }

    expect(violations).toEqual([]);
    expect(errors).toEqual([]);
    await h.assertClean(tab1);
  });

  it("Ada's admin tab does not keep the admin screens after Vera logs in in the other tab", async () => {
    const admin = h.users.admin.id;
    const tab1 = await h.newPage();
    await h.openApp(tab1, 'admin');
    const { tab: tab2, errors } = await secondTab(tab1);
    expect(await tab2.locator('#navAdmin').isHidden()).toBe(false);

    await switchUserInTab(tab1, 'vera');

    const violations: string[] = [];
    const me = await step(tab2, ME);
    violations.push(...meViolation(me));
    const write = await step(tab2, `await writeData('Company', { name: 'Tabs Admin-Tab', status: 'aktiv' }); return 'created';`);
    if (write.ui === admin && write.result.includes('Nur für Admins')) {
      violations.push('a tab showing Ada (admin) gets "Nur für Admins" for an admin write');
    }
    expect(violations).toEqual([]);
    expect(errors).toEqual([]);
    await h.assertClean(tab1);
  });

  it('a logout sends the other tabs to the login screen; a login reloads no tab on the login screen or of the same user', async () => {
    const tab1 = await h.newPage();
    await h.openApp(tab1, 'vera');
    const { tab: tab2, errors } = await secondTab(tab1);
    const vera = h.users.vera.id;

    // Vera logs out in tab 2. Tab 1 showed Vera and goes to the login screen too.
    const tab1Reloaded = reloads(tab1);
    const tab2Reloaded = tab2.waitForEvent('load');
    await h.run(tab2, 'logout(); return null;');
    await tab2Reloaded;
    expect(await tab1Reloaded).toBe(true);
    await tab1.waitForSelector('#loginScreen:not(.hidden)', { state: 'visible' });
    await tab2.waitForSelector('#loginScreen:not(.hidden)', { state: 'visible' });

    await watchDecisions(tab1);
    await watchDecisions(tab2);
    // Vera logs in in tab 1. Tab 2 is on the login screen and stays there.
    await formLogin(tab1, 'vera');
    expect(await decisions(tab2, 1)).toEqual([[vera, false]]);
    // Vera logs in in tab 2 as well. Tab 1 already shows Vera and stays.
    await formLogin(tab2, 'vera');
    expect(await decisions(tab1, 1)).toEqual([[vera, false]]);
    // No tab was told about its own login.
    expect([await decisions(tab1, 1), await decisions(tab2, 1)]).toEqual([[[vera, false]], [[vera, false]]]);
    expect(errors).toEqual([]);
    await h.assertClean(tab1);
  });

  it('a tab that missed the message checks the user when it is shown again, and reloads for the new user', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    // Ada logs in in this browser without any tab being told (a frozen tab, or one in the back-forward cache).
    await h.login(page, 'admin');
    const shown = reloads(page);
    await h.run(page, `document.dispatchEvent(new Event('visibilitychange'));`);
    expect(await shown).toBe(true);
    await page.waitForSelector('#appShell:not(.hidden)', { state: 'visible' });
    expect(await page.locator('#sidebarUserName').textContent()).toBe('Ada Admin');

    await h.login(page, 'vera');
    const restored = reloads(page);
    await h.run(page, `window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));`);
    expect(await restored).toBe(true);
    await page.waitForSelector('#appShell:not(.hidden)', { state: 'visible' });
    expect(await page.locator('#sidebarUserName').textContent()).toBe('Vera Vertrieb');
    await h.assertClean(page);
  });

  it('the check keeps the tab for the same user, on the login screen and whenever /me fails', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    const check = (): Promise<boolean> => h.run<boolean>(page, 'return await _checkSessionUser();');
    expect(await check()).toBe(false);

    await page.route('**/api/me', (route) => route.abort());
    expect(await check()).toBe(false);
    await page.unroute('**/api/me');
    await page.route('**/api/me', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { type: 'INTERNAL', message: 'kaputt' } }),
      }),
    );
    expect(await check()).toBe(false);
    await page.unroute('**/api/me');
    // The session is gone: the tab stays, and its next request asks for the key again (the open form is kept).
    await h.deps.sessions.deleteForUser(h.users.vera.id);
    expect(await check()).toBe(false);
    expect(await page.locator('#reauthOverlay').count()).toBe(0);
    expect(await page.locator('#sidebarUserName').textContent()).toBe('Vera Vertrieb');

    // Only a tab being shown and a page back from the back-forward cache check; a hidden tab and a normal load do not.
    const checks = await h.run<number[]>(
      page,
      `window.__checks = 0;
       const check = _checkSessionUser;
       window._checkSessionUser = () => { window.__checks++; return check(); };
       Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
       document.dispatchEvent(new Event('visibilitychange'));
       delete document.visibilityState;
       window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
       const before = window.__checks;
       document.dispatchEvent(new Event('visibilitychange'));
       window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
       return [before, window.__checks];`,
    );
    expect(checks).toEqual([0, 2]);
    await h.assertClean(page);

    const login = await h.newPage();
    await h.openApp(login);
    const asked: string[] = [];
    login.on('request', (r) => {
      if (new URL(r.url()).pathname === '/api/me') asked.push(r.url());
    });
    expect(await h.run<boolean>(login, 'return await _checkSessionUser();')).toBe(false);
    expect(asked).toEqual([]);
    await h.assertClean(login);
  });

  it('without BroadcastChannel the app still logs in and out, and a tab shown again still follows the session', async () => {
    const page = await h.newPage();
    await page.context().addInitScript('delete window.BroadcastChannel;');
    await h.openApp(page, 'vera');
    expect(await h.run(page, 'return typeof BroadcastChannel;')).toBe('undefined');

    await h.login(page, 'admin');
    const shown = reloads(page);
    await h.run(page, `document.dispatchEvent(new Event('visibilitychange'));`);
    expect(await shown).toBe(true);
    await page.waitForSelector('#appShell:not(.hidden)', { state: 'visible' });
    expect(await page.locator('#sidebarUserName').textContent()).toBe('Ada Admin');

    await switchUserInTab(page, 'vera');
    await h.assertClean(page);
  });
});
