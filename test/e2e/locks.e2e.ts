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
  await h.close();
});

const newCustomer = async (name1: string): Promise<string> =>
  (
    await h.apiAs<{ id: string }>('admin', 'POST', '/api/data/Customer', {
      fields: { name1, status: 'aktiv', company_id: [h.companies.alpha] },
    })
  ).id;
const lockHolder = async (id: string): Promise<unknown> => (await h.deps.records.get('Customer', id))?.fields.lock_user_id;
const toasts = async (page: Page): Promise<string> => (await page.locator('#toastWrap').textContent()) ?? '';
// Nobody awaits the release from closeModal() or from the unload beacon, so the tests poll.
const eventually = async (check: () => Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('condition not met within 5 s');
};
// Vera logs in (Alpha is her current company) and opens the customer.
const openAsVera = async (id: string): Promise<Page> => {
  const page = await h.newPage();
  await h.openApp(page, 'vera');
  await h.run(page, `await openCustomerModal(${JSON.stringify(id)});`);
  return page;
};

describe('record locks', () => {
  it('opening a customer takes the lock on the server and closing the modal releases it', async () => {
    const id = await newCustomer('Sperr GmbH');
    const page = await openAsVera(id);
    expect(await lockHolder(id)).toBe(h.users.vera.id);
    expect(await h.run(page, 'return { lock: _currentLock, timer: _lockRefreshTimer !== null };')).toEqual({
      lock: { table: 'Customer', recordId: id },
      timer: true,
    });
    await h.run(page, 'closeModal();');
    await eventually(async () => (await lockHolder(id)) === undefined);
    await h.assertClean(page);
  });

  it('saving through the form releases the lock', async () => {
    const id = await newCustomer('Speicher GmbH');
    const page = await openAsVera(id);
    expect(await lockHolder(id)).toBe(h.users.vera.id);
    await page.fill('#modalBox input[name="name1"]', 'Speicher GmbH & Co');
    // Tailwind is stubbed, so the submit button lies below the viewport: activate it with a DOM click.
    await page.dispatchEvent('#modalBox button[type="submit"]', 'click');
    await page.locator('#toastWrap', { hasText: 'Gespeichert' }).waitFor();
    const stored = await h.deps.records.get('Customer', id);
    expect([stored?.fields.name1, stored?.fields.lock_user_id]).toEqual(['Speicher GmbH & Co', undefined]);
    expect(await h.run(page, 'return { lock: _currentLock, timer: _lockRefreshTimer };')).toEqual({ lock: null, timer: null });
    await h.assertClean(page);
  });

  it('a customer locked by someone else names that user and opens nothing', async () => {
    const id = await newCustomer('Besetzt KG');
    await h.apiAs('admin', 'POST', `/api/locks/Customer/${id}`);
    const page = await openAsVera(id);
    expect((await toasts(page)).includes('Wird gerade von Ada Admin bearbeitet — bitte später nochmal')).toBe(true);
    expect(await page.locator('#modalBackdrop').isVisible()).toBe(false);
    expect(await h.run(page, 'return _currentLock;')).toBe(null);
    expect(await lockHolder(id)).toBe(h.users.admin.id);
    await h.assertClean(page);
  });

  it('closing the tab releases the lock through sendBeacon', async () => {
    const id = await newCustomer('Tab GmbH');
    const page = await openAsVera(id);
    expect(await lockHolder(id)).toBe(h.users.vera.id);
    await h.assertClean(page);
    // With routes active, Playwright drops the requests a closing page makes. A real browser sends
    // the beacon (checked by hand: without routes the release arrives), so the routes go first.
    await page.context().unrouteAll({ behavior: 'wait' });
    await page.close({ runBeforeUnload: true });
    await eventually(async () => (await lockHolder(id)) === undefined);
  });

  it('the heartbeat ignores network errors and reports a lock that someone else took over', async () => {
    const id = await newCustomer('Herzschlag AG');
    const page = await openAsVera(id);
    const idJson = JSON.stringify(id);

    await page.route('**/api/locks/**', (route) => route.abort());
    await h.run(page, `await _lockHeartbeatTick('Customer', ${idJson});`);
    await page.unroute('**/api/locks/**');
    expect(await h.run(page, 'return _currentLock;')).toEqual({ table: 'Customer', recordId: id });
    expect((await toasts(page)).includes('Sperre verloren')).toBe(false);

    // Vera's laptop slept longer than the lock lives, and the admin took the record over.
    const until = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    await h.deps.db.write((tx) =>
      h.deps.records.update(tx, 'Customer', id, { lock_user_id: h.users.admin.id, lock_until: until }, []),
    );
    await h.run(page, `await _lockHeartbeatTick('Customer', ${idJson});`);
    expect((await toasts(page)).includes('Sperre verloren – der Datensatz wird jetzt von Ada Admin bearbeitet')).toBe(true);
    expect(await h.run(page, 'return { lock: _currentLock, timer: _lockRefreshTimer };')).toEqual({ lock: null, timer: null });
    expect(await lockHolder(id)).toBe(h.users.admin.id);
    await h.assertClean(page);
  });
});
