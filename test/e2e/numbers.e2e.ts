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

interface Rec {
  id: string;
  fields: Record<string, unknown>;
}
const list = async (table: string): Promise<Rec[]> =>
  (await h.apiAs<{ records: Rec[] }>('admin', 'GET', `/api/data/${table}`)).records;
// A colleague (the admin) saving a record while the page is working.
const create = (table: string, fields: Record<string, unknown>): Promise<Rec> =>
  h.apiAs<Rec>('admin', 'POST', `/api/data/${table}`, { fields });
const toasts = async (page: Page): Promise<string> => (await page.locator('#toastWrap').textContent()) ?? '';
const numberRequests = (page: Page): string[] => {
  const seen: string[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith('/api/numbers/')) seen.push(url.pathname + url.search);
  });
  return seen;
};
// Toasts disappear after a few seconds, so every toast text is recorded as it appears.
const recordToasts = (page: Page): Promise<void> =>
  h.run(
    page,
    `window.__toastTexts = [];
     new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => window.__toastTexts.push(n.textContent))))
       .observe(document.getElementById('toastWrap'), { childList: true });`,
  );
const shownToasts = (page: Page): Promise<string[]> => h.run<string[]>(page, 'return window.__toastTexts;');
const toastCount = (page: Page, count: number) =>
  page.waitForFunction((n) => (window as unknown as { __toastTexts: string[] }).__toastTexts.length >= n, count);

describe('document numbers', () => {
  it('a customer created through the form gets the server number and the current company', async () => {
    const page = await h.newPage();
    const peeks = numberRequests(page);
    await h.openApp(page, 'vera');
    await h.run(page, 'await openCustomerModal();');
    expect(await page.inputValue('#modalBox input[name="customer_no"]')).toBe('K-1001');
    expect(peeks).toEqual([`/api/numbers/customer/next?company=${h.companies.alpha}`]);
    await page.fill('#modalBox input[name="name1"]', 'Erste Kundin GmbH');
    // Without Tailwind (stubbed in the harness) the modal is not scrollable and the button lies below the
    // viewport, so it is activated by a DOM click instead of a mouse click.
    await page.dispatchEvent('#modalBox button[type="submit"]', 'click');
    await page.locator('#toastWrap', { hasText: 'Gespeichert' }).waitFor();
    const saved = (await list('Customer')).find((r) => r.fields.name1 === 'Erste Kundin GmbH');
    expect([saved?.fields.customer_no, saved?.fields.company_id]).toEqual(['K-1001', [h.companies.alpha]]);
    await h.assertClean(page);
  });

  it('saves under the next free number when a proposed number was taken meanwhile', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    const beta = JSON.stringify(h.companies.beta);
    expect(await h.run<string>(page, `return await nextCustomerNo(${beta});`)).toBe('K-1001');
    await create('Customer', { name1: 'Schneller AG', customer_no: 'K-1001', company_id: [h.companies.beta] });
    const stored = await h.run<string>(
      page,
      `const c = await writeData('Customer', { name1: 'Langsam GmbH', customer_no: 'K-1001', company_id: [${beta}] });
       return c.fields.customer_no;`,
    );
    expect(stored).toBe('K-1002');
    expect((await toasts(page)).includes('Nummer K-1001 war inzwischen vergeben – gespeichert als K-1002')).toBe(true);
    await h.assertClean(page);
  });

  it('keeps a variant a variant, and the variant flow reports the stored number', async () => {
    const alpha = h.companies.alpha;
    const original = await create('Quote', { quote_no: 'Q-2001', status: 'Entwurf', company_id: [alpha] });
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    let raced = false;
    await page.route('**/api/data/Quote', async (route) => {
      if (route.request().method() === 'POST' && !raced) {
        raced = true;
        // Between the proposal and the save, a colleague saves the same variant number.
        await create('Quote', { quote_no: 'Q-2001.1', company_id: [alpha] });
      }
      await route.continue();
    });
    const result = await h.run<{ quote_no: string } | null>(
      page,
      `return await createQuoteVariant(${JSON.stringify(original.id)}, { silent: true, skipModalActions: true });`,
    );
    expect(result?.quote_no).toBe('Q-2001.2');
    const text = await toasts(page);
    expect(text.includes('Nummer Q-2001.1 war inzwischen vergeben – gespeichert als Q-2001.2')).toBe(true);
    expect(text.includes('✓ Variante Q-2001.2 angelegt')).toBe(true);
    const numbers = (await list('Quote')).map((r) => String(r.fields.quote_no)).filter((n) => n.startsWith('Q-2001'));
    expect(numbers.sort()).toEqual(['Q-2001', 'Q-2001.1', 'Q-2001.2']);
    await h.assertClean(page);
  });

  it('reports a duplicate number typed by hand instead of replacing it', async () => {
    await create('Customer', { name1: 'Vorhanden KG', customer_no: 'K-5000', company_id: [h.companies.alpha] });
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    const err = await h.runError(
      page,
      `await writeData('Customer', { name1: 'Doppelt GmbH', customer_no: 'K-5000', company_id: [${JSON.stringify(h.companies.alpha)}] });`,
    );
    expect(err).toEqual({
      message: 'Schreiben fehlgeschlagen: Nummer bereits vergeben: K-5000',
      status: 409,
      type: 'DUPLICATE_NUMBER',
    });
    expect((await list('Customer')).some((r) => r.fields.name1 === 'Doppelt GmbH')).toBe(false);
    await h.assertClean(page);
  });

  it('proposes variants on the server and keeps computing old non-Q variants in the browser', async () => {
    const beta = h.companies.beta;
    for (const quote_no of ['Q-3001', 'Q-3001.1', 'ALT-7', 'ALT-7.1']) await create('Quote', { quote_no, company_id: [beta] });
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    const b = JSON.stringify(beta);
    expect(
      await h.run<string[]>(
        page,
        `return [await nextQuoteVariantNo('Q-3001', ${b}), await nextQuoteVariantNo('Q-3001.1', ${b}), await nextQuoteNo(${b})];`,
      ),
    ).toEqual(['Q-3001.2', 'Q-3001.2', 'Q-3002']);
    const peeks = numberRequests(page);
    expect(await h.run<string>(page, `return await nextQuoteVariantNo('ALT-7', ${b});`)).toBe('ALT-7.2');
    expect(peeks).toEqual([]);
    await h.assertClean(page);
  });

  it('starts every number type at its floor in a new company and needs a company', async () => {
    const gamma = await create('Company', { name: 'Gamma KG', status: 'aktiv' });
    const page = await h.newPage();
    const peeks = numberRequests(page);
    await h.openApp(page, 'admin');
    const g = JSON.stringify(gamma.id);
    const numbers = await h.run<string[]>(
      page,
      `return [
         await nextCustomerNo(${g}), await nextSupplierNo(${g}), await nextArticleNo(${g}),
         await nextInquiryNo(${g}), await nextQuoteNo(${g}), await nextOrderNo(${g}),
         await nextPurchaseNo(${g}), await nextDeliveryNo(${g}), await nextInvoiceNo(${g}),
       ];`,
    );
    expect(numbers).toEqual(['K-1001', 'L-1001', 'A-10001', 'AN-1001', 'Q-1001', 'AB-1001', 'B-1001', 'L-1001', 'R-1001']);
    expect(peeks.length).toBe(9);
    expect((await h.runError(page, 'await nextCustomerNo(null);')).message).toBe('Kein Mandant ausgewählt');
    await h.assertClean(page);
  });

  it('a quote saved in the background shows the number it was stored under, and saving keeps it', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    // Toasts disappear after a few seconds, so every toast text is recorded as it appears.
    await h.run(
      page,
      `await openQuoteModal();
       window.__toastTexts = [];
       new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => window.__toastTexts.push(n.textContent))))
         .observe(document.getElementById('toastWrap'), { childList: true });`,
    );
    const proposed = await page.inputValue('#modalBox input[name="quote_no"]');
    // A colleague saves a quote under the proposed number while the form is open.
    await create('Quote', { quote_no: proposed, status: 'Entwurf', company_id: [h.companies.alpha] });
    // "Position hinzufügen" on a new quote saves its header in the background first.
    const id = await h.run<string>(page, `await showQuoteItemInlineForm(''); return window._currentQuoteIdInModal;`);
    const stored = String((await h.deps.records.get('Quote', id))?.fields.quote_no);
    expect(stored).not.toBe(proposed);
    expect(await page.inputValue('#modalBox input[name="quote_no"]')).toBe(stored);
    const shown = await h.run<string[]>(page, 'return window.__toastTexts;');
    expect(shown).toContain(`Nummer ${proposed} war inzwischen vergeben – gespeichert als ${stored}`);
    expect(shown).toContain(`Angebot ${stored} angelegt`);
    // "Speichern & schließen" saves the header again, now under the stored number.
    await page.dispatchEvent('#modalBox form[data-quote-form] button[type="submit"]', 'click');
    await page.locator('#toastWrap', { hasText: 'Gespeichert' }).waitFor();
    expect((await h.deps.records.get('Quote', id))?.fields.quote_no).toBe(stored);
    await h.assertClean(page);
  });
});

describe('saving again after an error', () => {
  it('the inquiry wizard keeps one inquiry when "Angebot erstellen" is clicked again after the quote step failed', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    await h.run(
      page,
      `await openInquiryWizard();
       _inquiryWizard.data.title = 'Aufzug Wartung Retry';
       _inquiryWizard.step = 4;
       renderInquiryWizardStep();`,
    );
    const proposed = await h.run<string>(page, 'return _inquiryWizard.data.inquiry_no;');
    await recordToasts(page);
    // The quote step fails once (Wi-Fi drop, deploy restart); the inquiry step before it succeeded.
    let failed = false;
    await page.route('**/api/data/Quote', async (route) => {
      if (route.request().method() === 'POST' && !failed) {
        failed = true;
        return route.abort();
      }
      return route.continue();
    });
    const createQuote = '#modalBox button[onclick="inqWizCreateQuote()"]';
    await page.dispatchEvent(createQuote, 'click');
    await page.locator('#toastWrap', { hasText: 'Server nicht erreichbar' }).waitFor();
    // The wizard stays open; the user clicks "Angebot erstellen" again.
    await page.dispatchEvent(createQuote, 'click');
    await page.locator('#toastWrap', { hasText: 'angelegt' }).waitFor();

    const inquiries = (await list('Inquiry')).filter((r) => r.fields.title === 'Aufzug Wartung Retry');
    expect(inquiries.map((r) => r.fields.inquiry_no)).toEqual([proposed]);
    const quotes = (await list('Quote')).filter((r) => r.fields.title === 'Aufzug Wartung Retry');
    expect(quotes.map((r) => r.fields.inquiry_id)).toEqual([[inquiries[0]?.id]]);
    expect((await shownToasts(page)).some((t) => t.includes('war inzwischen vergeben'))).toBe(false);
    await h.assertClean(page);
  });

  it('a customer saved again after a lost response is not stored twice, and the message says to check the list', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    await recordToasts(page);
    let lost = false;
    await page.route('**/api/data/Customer', async (route) => {
      if (route.request().method() === 'POST' && !lost) {
        lost = true;
        // The server receives and commits the create; the response never reaches the page.
        await h.apiAs('vera', 'POST', '/api/data/Customer', route.request().postDataJSON());
        return route.abort();
      }
      return route.continue();
    });
    await h.run(page, 'await openCustomerModal();');
    const proposed = await page.inputValue('#modalBox input[name="customer_no"]');
    await page.fill('#modalBox input[name="name1"]', 'Doppelt Retry GmbH');
    await page.dispatchEvent('#modalBox button[type="submit"]', 'click');
    await toastCount(page, 1);
    // The user sees "Server nicht erreichbar" and clicks Speichern again.
    await page.dispatchEvent('#modalBox button[type="submit"]', 'click');
    await toastCount(page, 2);

    const customers = (await list('Customer')).filter((r) => r.fields.name1 === 'Doppelt Retry GmbH');
    expect(customers.map((r) => r.fields.customer_no)).toEqual([proposed]);
    expect((await shownToasts(page)).slice(0, 2)).toEqual([
      'Schreiben fehlgeschlagen: Server nicht erreichbar – bitte Verbindung prüfen',
      `Schreiben fehlgeschlagen: Nummer ${proposed} ist schon vergeben – vermutlich wurde dein letzter Versuch gespeichert. ` +
        'Bitte in der Liste prüfen; fehlt der Datensatz dort, das Formular neu öffnen.',
    ]);
    await h.assertClean(page);
  });

  it('a create that never reached the server is saved under the proposed number on the next try', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    let dropped = false;
    await page.route('**/api/data/Customer', async (route) => {
      if (route.request().method() === 'POST' && !dropped) {
        dropped = true;
        return route.abort();
      }
      return route.continue();
    });
    await h.run(page, 'await openCustomerModal();');
    const proposed = await page.inputValue('#modalBox input[name="customer_no"]');
    await page.fill('#modalBox input[name="name1"]', 'Zweiter Versuch GmbH');
    await page.dispatchEvent('#modalBox button[type="submit"]', 'click');
    await page.locator('#toastWrap', { hasText: 'Server nicht erreichbar' }).waitFor();
    await page.dispatchEvent('#modalBox button[type="submit"]', 'click');
    await page.locator('#toastWrap', { hasText: 'Gespeichert' }).waitFor();
    const customers = (await list('Customer')).filter((r) => r.fields.name1 === 'Zweiter Versuch GmbH');
    expect(customers.map((r) => r.fields.customer_no)).toEqual([proposed]);
    await h.assertClean(page);
  });

  it('a proposed number this page has already saved is refused, not renumbered, when the same create comes again', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    const alpha = JSON.stringify(h.companies.alpha);
    const outcome = await h.run<string>(
      page,
      `const fields = { name1: 'Zweimal GmbH', customer_no: await nextCustomerNo(${alpha}), company_id: [${alpha}] };
       await writeData('Customer', fields);
       try { await writeData('Customer', fields); return 'zweimal gespeichert'; } catch (e) { return e.message; }`,
    );
    const customers = (await list('Customer')).filter((r) => r.fields.name1 === 'Zweimal GmbH');
    expect(customers.length).toBe(1);
    expect(outcome).toBe(`Schreiben fehlgeschlagen: Nummer bereits vergeben: ${String(customers[0]?.fields.customer_no)}`);
    await h.assertClean(page);
  });
});
