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
// The colleague's save lands after the server answered the form's first read of these tables and before
// the page gets the answers: the page's copy still shows the colleague's lock and the old values.
const colleagueSavesAfterRead = async (page: Page, tables: string[], save: () => Promise<void>): Promise<() => boolean> => {
  const seen = new Set<string>();
  let saved: Promise<void> | null = null;
  let allRead!: () => void;
  const read = new Promise<void>((resolve) => (allRead = resolve));
  for (const table of tables) {
    await page.route(`**/api/data/${table}`, async (route) => {
      if (route.request().method() !== 'GET' || seen.has(table)) return route.continue();
      seen.add(table);
      const snapshot = await route.fetch();
      if (seen.size === tables.length) allRead();
      await read;
      saved ??= save();
      await saved;
      await route.fulfill({ response: snapshot });
    });
  }
  return () => saved !== null;
};
const REREAD_WARNING = 'Aktuelle Daten konnten nicht geladen werden – bitte Formular schließen und neu öffnen, bevor du speicherst.';

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

  it('names a lock holder whose name has an ampersand exactly as written', async () => {
    const mueller = await h.deps.db.write((tx) => h.deps.records.insert(tx, 'User', { name: 'Müller & Söhne', status: 'aktiv' }));
    const until = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const lockFor = (id: string) =>
      h.deps.db.write((tx) => h.deps.records.update(tx, 'Customer', id, { lock_user_id: mueller.id, lock_until: until }, []));
    const held = await newCustomer('Ampersand KG');
    await lockFor(held);
    const page = await openAsVera(held);
    expect((await toasts(page)).includes('Wird gerade von Müller & Söhne bearbeitet — bitte später nochmal')).toBe(true);
    const taken = await newCustomer('Übernahme GmbH');
    await h.run(page, `await openCustomerModal(${JSON.stringify(taken)});`);
    await lockFor(taken);
    await h.run(page, `await _lockHeartbeatTick('Customer', ${JSON.stringify(taken)});`);
    const text = await toasts(page);
    expect(text.includes('Sperre verloren – der Datensatz wird jetzt von Müller & Söhne bearbeitet')).toBe(true);
    expect(text.includes('&amp;')).toBe(false);
    await h.assertClean(page);
  });

  it('a late heartbeat for a record that was closed leaves the open record alone', async () => {
    const first = await newCustomer('Erste GmbH');
    const second = await newCustomer('Zweite GmbH');
    const page = await openAsVera(first);
    await h.run(page, 'closeModal();');
    await eventually(async () => (await lockHolder(first)) === undefined);
    await h.run(page, `await openCustomerModal(${JSON.stringify(second)});`);
    // The admin opens the first record, and a tick for it that was already under way arrives now.
    await h.apiAs('admin', 'POST', `/api/locks/Customer/${first}`);
    await h.run(page, `await _lockHeartbeatTick('Customer', ${JSON.stringify(first)});`);
    expect(await h.run(page, 'return { lock: _currentLock, timer: _lockRefreshTimer !== null };')).toEqual({
      lock: { table: 'Customer', recordId: second },
      timer: true,
    });
    expect((await toasts(page)).includes('Sperre verloren')).toBe(false);
    expect(await lockHolder(second)).toBe(h.users.vera.id);
    await h.assertClean(page);
  });

  it('pagehide releases the lock too (iOS Safari fires no beforeunload)', async () => {
    const id = await newCustomer('Pagehide GmbH');
    const page = await openAsVera(id);
    expect(await lockHolder(id)).toBe(h.users.vera.id);
    await h.run(page, `window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));`);
    await eventually(async () => (await lockHolder(id)) === undefined);
    await h.assertClean(page);
  });
});

describe("a colleague's save between the form's read and the lock", () => {
  const forms = [
    { table: 'Customer', open: 'openCustomerModal', field: 'name1' },
    { table: 'Supplier', open: 'openSupplierModal', field: 'name1' },
    { table: 'Article', open: 'openArticleModal', field: 'name1' },
    { table: 'Inquiry', open: 'openInquiryModal', field: 'title' },
    { table: 'Quote', open: 'openQuoteModal', field: 'quote_title' },
    { table: 'Order', open: 'openOrderModal', field: 'order_title' },
    { table: 'SupplierOrder', open: 'openSupplierOrderModal', field: 'purchase_title' },
    { table: 'DeliveryNote', open: 'openDeliveryNoteModal', field: 'delivery_title' },
    { table: 'Invoice', open: 'openInvoiceModal', field: 'invoice_title' },
  ] as const;
  it.each(forms)('the $table form shows what the colleague saved', async ({ table, open, field }) => {
    const { id } = await h.apiAs<{ id: string }>('admin', 'POST', `/api/data/${table}`, {
      fields: { [field]: 'Stand vorher', company_id: [h.companies.alpha] },
    });
    await h.apiAs('admin', 'POST', `/api/locks/${table}/${id}`);
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    const raced = await colleagueSavesAfterRead(page, [table], async () => {
      await h.apiAs('admin', 'PATCH', `/api/data/${table}/${id}`, { fields: { [field]: 'Stand des Kollegen' } });
      await h.apiAs('admin', 'POST', `/api/locks/${table}/${id}/release`);
    });
    await h.run(page, `await ${open}(${JSON.stringify(id)});`);
    expect(raced()).toBe(true);
    expect(await page.locator('#modalBackdrop').isVisible()).toBe(true);
    expect(await page.inputValue(`#modalBox [name="${field}"]`)).toBe('Stand des Kollegen');
    expect((await h.deps.records.get(table, id))?.fields.lock_user_id).toBe(h.users.vera.id);
    await h.assertClean(page);
  });

  it("Customer: Vera's save keeps the colleague's values", async () => {
    const { id } = await h.apiAs<{ id: string }>('admin', 'POST', '/api/data/Customer', {
      fields: { name1: 'Original GmbH', phone: '0711 111', status: 'aktiv', company_id: [h.companies.alpha] },
    });
    await h.apiAs('admin', 'POST', `/api/locks/Customer/${id}`);
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    const raced = await colleagueSavesAfterRead(page, ['Customer'], async () => {
      await h.apiAs('admin', 'PATCH', `/api/data/Customer/${id}`, { fields: { name1: 'Admin-Änderung GmbH', phone: '0711 999' } });
      await h.apiAs('admin', 'POST', `/api/locks/Customer/${id}/release`);
    });
    await h.run(page, `await openCustomerModal(${JSON.stringify(id)});`);
    expect(raced()).toBe(true);
    expect(await page.inputValue('#modalBox input[name="name1"]')).toBe('Admin-Änderung GmbH');
    expect(await page.inputValue('#modalBox input[name="phone"]')).toBe('0711 999');
    // Vera only adds a note and saves.
    await page.fill('#modalBox textarea[name="notes"]', 'Rückruf Montag');
    await page.dispatchEvent('#modalBox button[type="submit"]', 'click');
    await page.locator('#toastWrap', { hasText: 'Gespeichert' }).waitFor();
    const stored = (await h.deps.records.get('Customer', id))?.fields;
    expect([stored?.name1, stored?.phone, stored?.notes]).toEqual(['Admin-Änderung GmbH', '0711 999', 'Rückruf Montag']);
    await h.assertClean(page);
  });

  it("Invoice: Vera's save does not put the invoice the colleague finalized back to Entwurf", async () => {
    const { id } = await h.apiAs<{ id: string }>('admin', 'POST', '/api/data/Invoice', {
      fields: { invoice_no: 'R-7001', invoice_title: 'Wartung 2026', status: 'Entwurf', company_id: [h.companies.alpha] },
    });
    await h.apiAs('admin', 'POST', `/api/locks/Invoice/${id}`);
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    const raced = await colleagueSavesAfterRead(page, ['Invoice'], async () => {
      await h.apiAs('admin', 'PATCH', `/api/data/Invoice/${id}`, {
        fields: { status: 'Versendet', invoice_title: 'Wartung 2026 – final', locked_at: '29.9.2026, 10:00:00' },
      });
      await h.apiAs('admin', 'POST', `/api/locks/Invoice/${id}/release`);
    });
    await h.run(page, `await openInvoiceModal(${JSON.stringify(id)});`);
    expect(raced()).toBe(true);
    expect(await page.inputValue('#modalBox form[data-invoice-form] select[name="status"]')).toBe('Versendet');
    expect(await page.getAttribute('#modalBox form[data-invoice-form]', 'data-locked')).toBe('1');
    // Vera changes nothing and clicks "Speichern & schließen".
    await page.dispatchEvent('#modalBox form[data-invoice-form] button[type="submit"]', 'click');
    await page.locator('#toastWrap', { hasText: 'Gespeichert' }).waitFor();
    const stored = (await h.deps.records.get('Invoice', id))?.fields;
    expect([stored?.status, stored?.invoice_title]).toEqual(['Versendet', 'Wartung 2026 – final']);
    await h.assertClean(page);
  });

  it('the quote form also shows the item the colleague added', async () => {
    const { id } = await h.apiAs<{ id: string }>('admin', 'POST', '/api/data/Quote', {
      fields: { quote_title: 'Wartung', status: 'Entwurf', company_id: [h.companies.alpha] },
    });
    const first = await h.apiAs<{ id: string }>('admin', 'POST', '/api/data/QuoteItem', {
      fields: { quote_id: [id], pos: 1, description: 'Prüfung', qty: 1, unit_price_net: 100 },
    });
    await h.apiAs('admin', 'POST', `/api/locks/Quote/${id}`);
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    let added = '';
    const raced = await colleagueSavesAfterRead(page, ['Quote', 'QuoteItem'], async () => {
      added = (
        await h.apiAs<{ id: string }>('admin', 'POST', '/api/data/QuoteItem', {
          fields: { quote_id: [id], pos: 2, description: 'Ersatzteil', qty: 2, unit_price_net: 50 },
        })
      ).id;
      await h.apiAs('admin', 'PATCH', `/api/data/Quote/${id}`, { fields: { quote_title: 'Wartung und Ersatzteil' } });
      await h.apiAs('admin', 'POST', `/api/locks/Quote/${id}/release`);
    });
    await h.run(page, `await openQuoteModal(${JSON.stringify(id)});`);
    expect(raced()).toBe(true);
    expect(await page.inputValue('#modalBox input[name="quote_title"]')).toBe('Wartung und Ersatzteil');
    const rows = await page.locator('#modalBox [data-qi-row]').evaluateAll((els) => els.map((el) => el.getAttribute('data-qi-row')));
    expect(rows).toEqual([first.id, added]);
    await h.assertClean(page);
  });

  it('keeps the copy it has and warns when the fresh read fails', async () => {
    const id = await newCustomer('Netzfehler GmbH');
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    await page.route(`**/api/data/Customer/${id}`, (route) => route.abort());
    await h.run(page, `await openCustomerModal(${JSON.stringify(id)});`);
    expect(await page.inputValue('#modalBox input[name="name1"]')).toBe('Netzfehler GmbH');
    expect((await toasts(page)).includes(REREAD_WARNING)).toBe(true);
    expect(await lockHolder(id)).toBe(h.users.vera.id);
    await h.assertClean(page);
  });

  it('the quote form keeps its copy and warns when the fresh item read fails', async () => {
    const { id } = await h.apiAs<{ id: string }>('admin', 'POST', '/api/data/Quote', {
      fields: { quote_title: 'Offline-Angebot', status: 'Entwurf', company_id: [h.companies.alpha] },
    });
    const item = await h.apiAs<{ id: string }>('admin', 'POST', '/api/data/QuoteItem', {
      fields: { quote_id: [id], pos: 1, description: 'Prüfung', qty: 1, unit_price_net: 100 },
    });
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    // The form's own item read goes through, the read after the lock fails.
    let itemReads = 0;
    await page.route('**/api/data/QuoteItem', (route) => (++itemReads === 1 ? route.continue() : route.abort()));
    await h.run(page, `await openQuoteModal(${JSON.stringify(id)});`);
    expect(itemReads).toBe(2);
    expect(await page.inputValue('#modalBox input[name="quote_title"]')).toBe('Offline-Angebot');
    const rows = await page.locator('#modalBox [data-qi-row]').evaluateAll((els) => els.map((el) => el.getAttribute('data-qi-row')));
    expect(rows).toEqual([item.id]);
    expect((await toasts(page)).split(REREAD_WARNING).length - 1).toBe(1);
    expect((await h.deps.records.get('Quote', id))?.fields.lock_user_id).toBe(h.users.vera.id);
    await h.assertClean(page);
  });
});
