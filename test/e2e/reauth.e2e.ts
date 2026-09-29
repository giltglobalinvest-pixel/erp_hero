// test/e2e/reauth.e2e.ts
import type { Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness, type Who } from './harness.js';

interface CustomerRecord {
  id: string;
  fields: Record<string, unknown>;
}

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

const OVERLAY_TEXT = 'Sitzung abgelaufen – bitte Login-Key erneut eingeben';
// The server forgets the user's sessions; the browser keeps its now useless cookie.
const expireSessions = async (who: Who): Promise<void> => {
  await h.deps.sessions.deleteForUser(h.users[who].id);
};
// The 5 s limit lets a missing overlay fail fast.
const overlayShown = (page: Page): Promise<void> =>
  page.locator('#reauthOverlay', { hasText: OVERLAY_TEXT }).waitFor({ timeout: 5_000 });
const customerNamed = async (name: string): Promise<CustomerRecord | undefined> =>
  (await h.apiAs<{ records: CustomerRecord[] }>('admin', 'GET', '/api/data/Customer')).records.find(
    (r) => r.fields.name1 === name,
  );
// Status codes of the page's responses whose URL matches, collected from now on.
// The harness logs in through the context's request API, which does not show up here.
const statuses = (page: Page, match: (url: URL) => boolean): number[] => {
  const seen: number[] = [];
  page.on('response', (r) => {
    if (match(new URL(r.url()))) seen.push(r.status());
  });
  return seen;
};
const isLogin = (url: URL): boolean => url.pathname === '/api/auth';
// readData('Company', "{name}='<name>'") and nothing else.
const isRead =
  (name: string) =>
  (url: URL): boolean =>
    url.pathname === '/api/data/Company' && url.searchParams.get('filterByFormula') === `{name}='${name}'`;
const sessionCookie = async (page: Page) => (await page.context().cookies()).find((c) => c.name === 'erp_session');
// Vera logs in (Alpha is her current company), opens the form for a new customer and fills it in.
const fillNewCustomer = async (page: Page, name: string): Promise<void> => {
  await h.openApp(page, 'vera');
  await h.run(page, 'await openCustomerModal();');
  await page.fill('#modalBox input[name="name1"]', name);
  await page.fill('#modalBox input[name="city"]', 'Köln');
};
// The form is a long modal: the harness stubs Tailwind, so its submit button lies outside the viewport and a real click
// fails. It is activated by a DOM click instead. The re-login overlay is no part of it and gets real clicks.
const save = (page: Page): Promise<void> => page.dispatchEvent('#modalBox button[type="submit"]', 'click');
const toast = (page: Page, text: string): Promise<void> => page.locator('#toastWrap', { hasText: text }).waitFor();
const reLogin = async (page: Page, key: string): Promise<void> => {
  await page.fill('#reauthKey', key);
  await page.click('#reauthSubmit');
};

describe('re-login when the session expires', () => {
  it('keeps the open form, asks for the key again and then saves (scenario 12)', async () => {
    const page = await h.newPage();
    const logins = statuses(page, isLogin);
    await fillNewCustomer(page, 'Nach Pause GmbH');
    await expireSessions('vera');
    await save(page);
    await overlayShown(page);
    // Vera did not tick "Angemeldet bleiben" at the login.
    expect(await page.isChecked('#reauthRemember')).toBe(false);
    // The form stays open behind the overlay, with what was typed.
    expect(await page.locator('#modalBackdrop').isVisible()).toBe(true);
    expect(await page.inputValue('#modalBox input[name="name1"]')).toBe('Nach Pause GmbH');

    await reLogin(page, 'falscher-key-123');
    await page.locator('#reauthError', { hasText: 'Ungültiger Login-Key oder Account inaktiv' }).waitFor();
    expect(await page.locator('#reauthOverlay').count()).toBe(1);

    await reLogin(page, h.users.vera.key);
    await toast(page, 'Gespeichert');
    expect(await page.locator('#reauthOverlay').count()).toBe(0);
    const saved = await customerNamed('Nach Pause GmbH');
    expect([saved?.fields.city, saved?.fields.company_id]).toEqual(['Köln', [h.companies.alpha]]);
    expect(await h.run(page, 'return APP_KEYS.user._id;')).toBe(h.users.vera.id);
    await expect.poll(() => logins).toEqual([401, 200]);
    // Without "Angemeldet bleiben" the new cookie ends with the browser session.
    expect((await sessionCookie(page))?.expires).toBe(-1);
    await h.assertClean(page);
  });

  it('parallel requests share one overlay and all go through after the login', async () => {
    const page = await h.newPage();
    const reads = statuses(page, isRead('Alpha GmbH'));
    const logins = statuses(page, isLogin);
    await h.openApp(page, 'vera');
    // As if Vera had ticked "Angemeldet bleiben" at the login.
    await h.run(page, "document.getElementById('loginRememberMe').checked = true;");
    await expireSessions('vera');
    await h.run(
      page,
      `window.__parallel = Promise.all([1, 2, 3].map(() => readData('Company', "{name}='Alpha GmbH'").then(r => r.length)));`,
    );
    await expect.poll(() => reads, { timeout: 5_000 }).toEqual([401, 401, 401]);
    await overlayShown(page);
    expect(await page.locator('#reauthOverlay').count()).toBe(1);
    expect(await page.isChecked('#reauthRemember')).toBe(true);

    await reLogin(page, h.users.vera.key);
    expect(await h.run(page, 'return await window.__parallel;')).toEqual([1, 1, 1]);
    await expect.poll(() => reads).toEqual([401, 401, 401, 200, 200, 200]);
    await expect.poll(() => logins).toEqual([200]);
    // "Angemeldet bleiben" makes the new cookie outlive the browser session.
    expect(((await sessionCookie(page))?.expires ?? 0) > 0).toBe(true);
    await h.assertClean(page);
  });

  it('"Abbrechen" keeps the form with a clear error, and saving again asks again', async () => {
    const page = await h.newPage();
    await fillNewCustomer(page, 'Abbruch GmbH');
    await expireSessions('vera');
    await save(page);
    await overlayShown(page);
    await page.click('#reauthCancel');
    await toast(page, 'Schreiben fehlgeschlagen: Sitzung abgelaufen');
    expect(await page.locator('#reauthOverlay').count()).toBe(0);
    expect(await page.inputValue('#modalBox input[name="name1"]')).toBe('Abbruch GmbH');
    expect(await customerNamed('Abbruch GmbH')).toBeUndefined();

    await save(page);
    await overlayShown(page);
    await reLogin(page, h.users.vera.key);
    await toast(page, 'Gespeichert');
    expect((await customerNamed('Abbruch GmbH'))?.fields.city).toBe('Köln');
    await h.assertClean(page);
  });

  it('the key of a different user reloads the app for that user instead of continuing', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    await expireSessions('vera');
    // The read is not awaited: it waits for the overlay, which then reloads the page.
    await h.run(page, "window.__before = 'alt'; readData('Company').catch(() => {});");
    await overlayShown(page);
    const reloaded = page.waitForEvent('load');
    await reLogin(page, h.users.admin.key);
    await reloaded;
    await page.waitForSelector('#appShell:not(.hidden)', { state: 'visible' });
    expect(await page.locator('#sidebarUserName').textContent()).toBe('Ada Admin');
    // A new page: nothing of Vera's state is left.
    expect(await h.run(page, 'return window.__before;')).toBeUndefined();
    await h.assertClean(page);
  });

  it('a request whose 401 arrives after the re-login is repeated without a second overlay', async () => {
    const page = await h.newPage();
    const betaReads = statuses(page, isRead('Beta AG'));
    const logins = statuses(page, isLogin);
    await h.openApp(page, 'vera');
    // Holds every response for a URL with "Beta" in the page until __release() is called.
    await h.run(
      page,
      `const realFetch = window.fetch;
       let release;
       const gate = new Promise((resolve) => { release = resolve; });
       window.__release = release;
       window.fetch = async (...args) => {
         const res = await realFetch(...args);
         if (String(args[0]).includes('Beta')) await gate;
         return res;
       };`,
    );
    await expireSessions('vera');
    await h.run(page, `window.__slow = readData('Company', "{name}='Beta AG'").then(r => r.length);`);
    // The server has answered 401, but the app does not see it yet.
    await expect.poll(() => betaReads, { timeout: 5_000 }).toEqual([401]);
    await h.run(page, `window.__fast = readData('Company', "{name}='Alpha GmbH'").then(r => r.length);`);
    await overlayShown(page);
    await reLogin(page, h.users.vera.key);
    expect(await h.run(page, 'return await window.__fast;')).toBe(1);

    // Now the old 401 for Beta reaches the app, after the re-login.
    const outcome = await h.run(
      page,
      `window.__release();
       let timer;
       const overlay = new Promise((resolve) => {
         timer = setInterval(() => {
           if (document.getElementById('reauthOverlay')) resolve('second overlay');
         }, 20);
       });
       const first = await Promise.race([window.__slow.then((n) => 'resolved ' + n), overlay]);
       clearInterval(timer);
       return first;`,
    );
    expect(outcome).toBe('resolved 1');
    expect(await page.locator('#reauthOverlay').count()).toBe(0);
    await expect.poll(() => betaReads).toEqual([401, 200]);
    await expect.poll(() => logins).toEqual([200]);
    await h.assertClean(page);
  });
});
