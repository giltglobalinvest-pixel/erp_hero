// test/e2e/users.e2e.ts
import type { Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';

interface UserRecord {
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

const toast = (page: Page, text: string): Promise<void> => page.locator('#toastWrap', { hasText: text }).waitFor();
// All users as the admin sees them, with has_api_key and the Freshdesk flags.
const allUsers = async (): Promise<UserRecord[]> =>
  (await h.apiAs<{ records: UserRecord[] }>('admin', 'GET', '/api/data/User')).records;
const userNamed = async (name: string): Promise<UserRecord> => {
  const found = (await allUsers()).find((u) => u.fields.name === name);
  if (!found) throw new Error(`no user named ${name}`);
  return found;
};
// Creates a user through the API; it has no login key unless `secrets` sets one.
const createUser = async (fields: Record<string, unknown>, secrets?: Record<string, unknown>): Promise<string> => {
  const { id } = await h.apiAs<UserRecord>('admin', 'POST', '/api/data/User', { fields: { status: 'aktiv', ...fields } });
  if (secrets) await h.apiAs('admin', 'PATCH', `/api/admin/users/${id}/secrets`, secrets);
  return id;
};
// Method and JSON body of the page's requests to URLs starting with baseUrl + prefix, collected from now on.
const requestsTo = (page: Page, prefix: string): { method: string; body: unknown }[] => {
  const seen: { method: string; body: unknown }[] = [];
  page.on('request', (r) => {
    if (r.url().startsWith(h.baseUrl + prefix)) seen.push({ method: r.method(), body: r.postDataJSON() });
  });
  return seen;
};
// The user list as the admin. The 5 s limit lets a list without row markers fail fast.
const openUsers = async (page: Page): Promise<void> => {
  await h.openApp(page, 'admin');
  await h.run(page, 'await renderAdminUsers();');
  await page.locator(`[data-user-row="${h.users.admin.id}"]`).waitFor({ timeout: 5_000 });
};
// Opens the form of an existing user (id) or of a new user (no id).
const openForm = async (page: Page, id?: string): Promise<void> => {
  await page.click(id ? `[data-user-row="${id}"] button[title="Bearbeiten"]` : 'button[onclick="openUserModal()"]');
  await page.locator('#modalBox #userApiKey').waitFor();
};
// The form is a long modal: the harness stubs Tailwind, so its controls lie outside the viewport and a real click fails.
// Every click inside the form therefore goes through dispatchEvent.
const save = (page: Page): Promise<void> => page.dispatchEvent('#modalBox button[type="submit"]', 'click');
// A successful save closes the form before it shows its toast.
const saved = async (page: Page): Promise<void> => {
  await save(page);
  await page.locator('#modalBackdrop').waitFor({ state: 'hidden' });
};
// The badges of a user's row, left to right.
const badges = async (page: Page, id: string): Promise<string[]> =>
  (await page.locator(`[data-user-row="${id}"] span`).allInnerTexts()).map((t) => t.trim());
// Logs in through the login form of a fresh page and returns the name in the sidebar.
const loginWithKey = async (key: string): Promise<string | null> => {
  const page = await h.newPage();
  await h.openApp(page);
  await page.fill('#loginKey', key);
  await page.click('#loginBtn');
  await page.waitForSelector('#appShell:not(.hidden)', { state: 'visible' });
  const name = await page.locator('#sidebarUserName').textContent();
  await h.assertClean(page);
  return name;
};

describe('user admin', () => {
  it('creates a user with the generated key, and that key logs in (scenario 8)', async () => {
    const { alpha } = h.companies;
    const page = await h.newPage();
    await openUsers(page);
    const dataCalls = requestsTo(page, '/api/data/User');
    const secretCalls = requestsTo(page, '/api/admin/users/');
    await openForm(page);
    expect(await page.innerText('#userApiKeyState')).toBe('(für Login in der App)');
    const key = await page.inputValue('#userApiKey');
    expect(/^[a-z0-9]{24}$/.test(key)).toBe(true);
    await page.fill('#modalBox [name="name"]', 'Nina Neu');
    await page.fill('#modalBox [name="role"]', 'Buchhaltung');
    await page.dispatchEvent(`#modalBox [name="allowed_companies"][value="${alpha}"]`, 'click');
    await page.fill(`#modalBox [name="fd_key__${alpha}"]`, 'fd-key-nina-alpha');
    await saved(page);
    await toast(page, 'Gespeichert');

    // The record goes to /api/data without a key; the keys go to the admin function.
    const writes = dataCalls.filter((c) => c.method !== 'GET');
    expect(writes.map((c) => [c.method, Object.keys((c.body as { fields: object }).fields).sort()])).toEqual([
      ['POST', ['allowed_companies', 'created', 'is_admin', 'name', 'role', 'status']],
    ]);
    expect(secretCalls).toEqual([
      { method: 'PATCH', body: { api_key: key, freshdesk_keys: { [alpha]: 'fd-key-nina-alpha' } } },
    ]);
    const nina = await userNamed('Nina Neu');
    expect(nina.fields).toEqual({
      name: 'Nina Neu',
      role: 'Buchhaltung',
      status: 'aktiv',
      allowed_companies: [alpha],
      created: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      has_api_key: true,
      has_freshdesk_key: false,
      freshdesk_company_keys: [alpha],
    });
    expect(await h.deps.secrets.freshdeskKeyFor(nina.id, alpha)).toBe('fd-key-nina-alpha');
    await page.locator(`[data-user-row="${nina.id}"]`).waitFor();
    await h.assertClean(page);

    expect(await loginWithKey(key)).toBe('Nina Neu');
  });

  it('keeps the login key when an existing user is saved with the key field left empty (review focus 1)', async () => {
    const { alpha, beta } = h.companies;
    const vera = h.users.vera;
    const page = await h.newPage();
    await openUsers(page);
    const recordCalls = requestsTo(page, '/api/data/User/');
    const secretCalls = requestsTo(page, '/api/admin/users/');
    await openForm(page, vera.id);
    expect(await page.inputValue('#userApiKey')).toBe('');
    expect(await page.getAttribute('#userApiKey', 'placeholder')).toBe('leer = unverändert');
    expect(await page.getAttribute('#userApiKey', 'required')).toBe(null);
    expect(await page.innerText('#userApiKeyState')).toBe('· gespeichert');
    // A stored Freshdesk key shows as "Key gespeichert", never as the key or a part of it.
    const block = (companyId: string) => page.locator(`#modalBox [data-fd-company="${companyId}"]`).innerText();
    expect((await block(alpha)).includes('Key gespeichert')).toBe(true);
    expect((await block(beta)).includes('Key gespeichert')).toBe(false);
    expect((await page.content()).includes('fd-key-alpha')).toBe(false);

    await page.fill('#modalBox [name="role"]', 'Vertrieb Nord');
    await saved(page);
    await toast(page, 'Gespeichert');
    expect(recordCalls.map((c) => c.method)).toEqual(['PATCH']);
    expect(secretCalls).toEqual([]);
    expect((await userNamed('Vera Vertrieb')).fields.role).toBe('Vertrieb Nord');
    expect(await h.deps.secrets.freshdeskKeyFor(vera.id, alpha)).toBe('fd-key-alpha');
    await h.assertClean(page);

    expect(await loginWithKey(vera.key)).toBe('Vera Vertrieb');
  });

  it('refuses a short login key and a key that is in use, for a new and for an existing user', async () => {
    const page = await h.newPage();
    await openUsers(page);
    const writes = requestsTo(page, '/api/data/User');
    await openForm(page);
    await page.fill('#modalBox [name="name"]', 'Doppelt Dora');
    await page.fill('#userApiKey', 'kurz-123');
    await save(page);
    await toast(page, 'Login-Key muss mindestens 12 Zeichen haben');
    expect(writes.filter((c) => c.method !== 'GET')).toEqual([]);

    // Vera's key belongs to Vera: the new record is removed again, and the form stays open.
    await page.fill('#userApiKey', h.users.vera.key);
    await save(page);
    await toast(page, 'Benutzer nicht angelegt: Dieser Login-Key wird bereits verwendet');
    expect(writes.filter((c) => c.method !== 'GET').map((c) => c.method)).toEqual(['POST', 'DELETE']);
    expect(await page.inputValue('#modalBox [name="name"]')).toBe('Doppelt Dora');
    expect((await allUsers()).some((u) => u.fields.name === 'Doppelt Dora')).toBe(false);

    // An existing user is saved, but keeps the old key.
    await page.dispatchEvent('#modalBox button[onclick="closeModal()"]', 'click');
    await openForm(page, h.users.vera.id);
    await page.fill('#userApiKey', h.users.admin.key);
    await save(page);
    await toast(page, 'Benutzer gespeichert, Keys aber nicht: Dieser Login-Key wird bereits verwendet');
    expect(await page.locator('#modalBackdrop').isVisible()).toBe(true);
    // apiAs logs in with Vera's key, so this fails if the key was changed.
    await h.apiAs('vera', 'GET', '/api/me');
    await h.assertClean(page);
  });

  it('removes a Freshdesk key, sets and removes the default key, and never shows a key', async () => {
    const { alpha } = h.companies;
    const id = await createUser(
      { name: 'Fred Freshdesk' },
      { generate_api_key: true, freshdesk_keys: { [alpha]: 'fd-key-fred-alpha' } },
    );
    const page = await h.newPage();
    await openUsers(page);
    const secretCalls = requestsTo(page, '/api/admin/users/');
    await openForm(page, id);
    expect((await page.content()).includes('fd-key-fred-alpha')).toBe(false);
    expect(await page.locator('#modalBox [data-fd-default]').count()).toBe(0);
    await page.dispatchEvent(`#modalBox [data-fd-company="${alpha}"] button`, 'click');
    await page.fill('#modalBox [name="freshdesk_api_key"]', 'fd-default-fred');
    await saved(page);
    expect(secretCalls.map((c) => c.body)).toEqual([
      { freshdesk_api_key: 'fd-default-fred', freshdesk_keys: { [alpha]: null } },
    ]);
    expect(await h.deps.secrets.userInfo(id)).toEqual({ hasApiKey: true, hasFreshdeskKey: true, freshdeskCompanyKeys: [] });
    expect(await h.deps.secrets.freshdeskKeyFor(id, alpha)).toBe('fd-default-fred');

    // The list is rendered again after a save; the default key is removed the same way.
    await page.locator(`[data-user-row="${id}"]`).waitFor();
    await openForm(page, id);
    expect((await page.content()).includes('fd-default-fred')).toBe(false);
    await page.dispatchEvent('#modalBox [data-fd-default] button', 'click');
    await saved(page);
    expect(secretCalls.map((c) => c.body)[1]).toEqual({ freshdesk_api_key: null });
    expect(await h.deps.secrets.userInfo(id)).toEqual({ hasApiKey: true, hasFreshdeskKey: false, freshdeskCompanyKeys: [] });
    await h.assertClean(page);
  });

  it('marks a user without a login key, counts Freshdesk keys, and "Neu" gives the user a key', async () => {
    const { alpha, beta } = h.companies;
    const id = await createUser(
      { name: 'Otto Ohnekey', allowed_companies: [alpha] },
      { freshdesk_api_key: 'fd-default-otto', freshdesk_keys: { [alpha]: 'fd-key-otto-alpha', [beta]: 'fd-key-otto-beta' } },
    );
    const page = await h.newPage();
    await openUsers(page);
    expect(await badges(page, id)).toEqual(['FD 2×+D', 'kein Login-Key']);
    expect(await badges(page, h.users.vera.id)).toEqual(['FD 1×']);
    expect(await badges(page, h.users.admin.id)).toEqual(['admin']);

    const secretCalls = requestsTo(page, '/api/admin/users/');
    await openForm(page, id);
    expect(await page.innerText('#userApiKeyState')).toBe('· keiner hinterlegt');
    await page.dispatchEvent('#userApiKeyNew', 'click');
    const key = await page.inputValue('#userApiKey');
    expect(/^[a-z0-9]{24}$/.test(key)).toBe(true);
    await saved(page);
    await toast(page, 'Gespeichert');
    expect(secretCalls.map((c) => c.body)).toEqual([{ api_key: key }]);
    await page.locator(`[data-user-row="${id}"]`).waitFor();
    expect(await badges(page, id)).toEqual(['FD 2×+D']);
    await h.assertClean(page);

    expect(await loginWithKey(key)).toBe('Otto Ohnekey');
  });

  it('ends all sessions of a user with "Alle Sitzungen abmelden"', async () => {
    const vera = h.users.vera;
    const sessionsOf = async (userId: string): Promise<number> =>
      Number((await h.deps.db.query('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', [userId]))[0]?.n);
    const veraPage = await h.newPage();
    await h.openApp(veraPage, 'vera');
    // Earlier tests of this file left sessions of Vera too (apiAs and openApp log in each time).
    const before = await sessionsOf(vera.id);
    expect(before > 0).toBe(true);

    const page = await h.newPage();
    await openUsers(page);
    await openForm(page, vera.id);
    page.once('dialog', (d) => void d.accept());
    await page.dispatchEvent('#userRevokeSessions', 'click');
    await toast(page, `${before} Sitzung(en) abgemeldet`);
    expect(await sessionsOf(vera.id)).toBe(0);
    expect((await veraPage.context().request.get(`${h.baseUrl}/api/me`)).status()).toBe(401);
    // The admin's own session stays.
    expect((await page.context().request.get(`${h.baseUrl}/api/me`)).status()).toBe(200);
    await h.assertClean(page);
    await h.assertClean(veraPage);
  });
});
