// test/e2e/inline-handlers.e2e.ts
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

// Values that end a JS string, an attribute or an element, or that the HTML parser decodes in an attribute.
const TRICKY = [
  "'",
  '"',
  '\\',
  "\\'",
  '&#39;',
  '&quot;',
  '&amp;',
  '</button><b data-v1>x</b>',
  'a\nb',
  '\r\t',
  '  ',
  '`${1}`',
  "');window.__v1=1;('",
  '");window.__v1=1;("',
  'ÄÖÜß €',
  '🛗',
  '',
];

describe('inline event handlers get their arguments as JS string literals', () => {
  it('jsArg: each value arrives unchanged in a double- and a single-quoted handler, and nothing else runs', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    // The browser's HTML parser decodes the attribute and its JS engine compiles the handler, as for the app's own.
    const wrong = await h.run<unknown[]>(
      page,
      `const host = document.body.appendChild(document.createElement('div'));
      const wrong = [];
      for (const s of ${JSON.stringify(TRICKY)}) {
        for (const q of ['"', "'"]) {
          delete window.__got;
          delete window.__v1;
          host.innerHTML = '<button onclick=' + q + 'window.__got=' + jsArg(s) + q + '>x</button>';
          host.querySelector('button').click();
          const marks = document.querySelectorAll('[data-v1]').length;
          if (window.__got !== s || window.__v1 !== undefined || marks) wrong.push({ s, q, got: window.__got, v1: window.__v1, marks });
        }
      }
      host.remove();
      return wrong;`,
    );
    expect(wrong).toEqual([]);
    await h.assertClean(page);
  });

  it('the quote e-mail send button passes the customer name and the quote number on unchanged', async () => {
    // Every user may write customers and quotes; the admin sends the e-mail.
    const name1 = 'O\'Brien "Q" \\ <b data-v1>x</b>';
    const customer = await h.apiAs<{ id: string }>('vera', 'POST', '/api/data/Customer', {
      fields: { name1, status: 'aktiv', email: 'kunde@example.test', company_id: [h.companies.alpha] },
    });
    const quote = await h.apiAs<{ id: string }>('vera', 'POST', '/api/data/Quote', {
      fields: { quote_no: 'AN-2026-0042', status: 'Entwurf', customer_id: [customer.id], company_id: [h.companies.alpha] },
    });
    const page = await h.newPage();
    await h.openApp(page, 'admin');
    await h.run(page, `await openQuoteModal(${JSON.stringify(quote.id)}); await emailQuote();`);
    await page.waitForSelector('#eqSendBtn');
    // Only what the button hands over: the stand-in builds no PDF and sends nothing.
    const got = await h.run(
      page,
      `window._emailQuoteDoSend = (...args) => { window.__sent = args.slice(0, 3); };
      document.getElementById('eqSendBtn').click();
      return { sent: window.__sent ?? null, marks: document.querySelectorAll('[data-v1]').length, v1: typeof window.__v1 };`,
    );
    expect(got).toEqual({ sent: ['', name1, 'AN-2026-0042'], marks: 0, v1: 'undefined' });
    await h.assertClean(page);
  });
});
