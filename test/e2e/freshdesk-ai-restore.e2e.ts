// test/e2e/freshdesk-ai-restore.e2e.ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { TableName } from '../../server/data/tables.js';
import { jsonResponse } from '../helpers/fakeFetch.js';
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

const FD = 'https://flptest.freshdesk.com/api/v2/';
const insert = (table: TableName, fields: Record<string, unknown>) =>
  h.deps.db.write((tx) => h.deps.records.insert(tx, table, fields));

// A private note in the format of saveFreshdeskTicketSummary: the summary as text, the state as base64 JSON in a comment.
const aiNote = (json: string): string =>
  '<p><strong>🤖 KI-Zusammenfassung</strong> · erstellt am 29.9.2026</p><p>Kurzfassung</p>\n' +
  `<!--AI_DATA:${Buffer.from(json, 'utf8').toString('base64')}-->`;

// A Freshdesk ticket whose conversations are the notes posted to it. Returns those notes.
const fakeTicket = (id: number, requester: () => { email: string; name: string }) => {
  const notes: { id: number; private: boolean; body: string; created_at: string }[] = [];
  h.fake.on('GET', `${FD}tickets/${id}?`, () =>
    jsonResponse({
      id,
      subject: 'Anfrage Drahtseil',
      description_html: '<p>Bitte zwei Drahtseile, Lieferung KW 24.</p>',
      status: 2,
      created_at: '2026-09-29T09:00:00Z',
      requester: requester(),
      tags: [],
      custom_fields: {},
    }),
  );
  h.fake.on('GET', `${FD}tickets/${id}/conversations`, () => jsonResponse(notes));
  h.fake.on('POST', `${FD}tickets/${id}/notes`, (call) => {
    const body = String((JSON.parse(String(call.body)) as { body: unknown }).body);
    const note = { id: 9000 + notes.length, private: true, body, created_at: `2026-09-29T10:0${notes.length}:00Z` };
    notes.push(note);
    return jsonResponse(note, 201);
  });
  return notes;
};

// Vera posts a private note through the ERP's Freshdesk proxy, which any logged-in user may do.
const postAsVera = async (ticketId: number, noteHtml: string): Promise<void> => {
  const vera = await h.newPage();
  await h.openApp(vera, 'vera');
  await h.run(
    vera,
    `APP_KEYS.currentCompanyId = ${JSON.stringify(h.companies.alpha)};
     await proxyFetch('freshdesk/api/v2/tickets/${ticketId}/notes', { method: 'POST', body: { body: ${JSON.stringify(noteHtml)}, private: true } });`,
  );
  await h.assertClean(vera);
};

describe('a restored AI note is untrusted data', () => {
  // Harmless markup that also ends a double- or single-quoted attribute: the test counts the elements built from it.
  const MARK = `1"'><b data-n2>x</b>`;

  it("a non-admin's note restores as text in the admin's ticket view: qty 1, no markup, no foreign prototype", async () => {
    fakeTicket(7101, () => ({ email: 'kunde@example.test', name: 'Kunde' }));
    const aiData = {
      version: 1,
      summary: MARK,
      extracted: {
        company: { name: MARK, city: MARK },
        contact: { name: MARK, first_name: MARK, email: MARK },
        items: [{ article_id: MARK, qty: MARK, name_spoken: MARK }],
      },
      editFields: {
        ticket_number: MARK,
        customer_reference: MARK,
        lieferzeit: MARK,
        customer_id: MARK,
        contact_id: MARK,
        bundle_id_override: MARK,
        attachment_ids: [MARK],
        items: [{ article_id: 'recN2', sku: MARK, name: MARK, qty: MARK }],
      },
      savedAt: '2026-09-29T10:00:00Z',
    };
    // JSON.parse makes "__proto__" an own key; a merge with Object.assign would make its value the prototype.
    const json = JSON.stringify(aiData).replace('"editFields":{', '"editFields":{"__proto__":{"polluted":"ja"},');
    await postAsVera(7101, aiNote(json));

    const admin = await h.newPage();
    await h.openApp(admin, 'admin');
    await h.run(admin, 'await openFreshdeskTicket(7101);');
    await admin.locator('#fdTicketBody', { hasText: 'aus früherer Sitzung wiederhergestellt' }).waitFor({ timeout: 10_000 });
    const view = await h.run(
      admin,
      `const body = document.getElementById('fdTicketBody');
       const qty = body.querySelector('input[type="number"][min="1"]');
       const ef = _fdTicketState.editFields;
       return {
         markup: document.querySelectorAll('[data-n2]').length,
         qty: qty && qty.value,
         qtyHandler: qty && qty.getAttribute('onchange'),
         ticketNumber: body.querySelector('input[placeholder^="FT-"]').value,
         summaryAsText: body.textContent.includes(${JSON.stringify(MARK)}),
         prototype: Object.getPrototypeOf(ef) === Object.prototype,
         polluted: typeof ef.polluted,
         items: ef.items,
       };`,
    );
    expect(view).toEqual({
      markup: 0,
      qty: '1',
      qtyHandler: '_setFdItemEditQty(0, this.value)',
      ticketNumber: MARK,
      summaryAsText: true,
      prototype: true,
      polluted: 'undefined',
      // The article is not in the cache: no article number, the stored name as the fallback.
      items: [{ article_id: 'recN2', qty: 1, sku: '', name: MARK }],
    });
    await h.assertClean(admin);
  });

  it("the app's own note restores the article with qty 2, the customer, the ticket number and the delivery time", async () => {
    const article = await insert('Article', {
      company_id: [h.companies.alpha],
      article_no: 'DS-8',
      name1: 'Drahtseil 8 mm',
      status: 'aktiv',
      sales_price: 12,
    });
    const customer = await insert('Customer', { company_id: [h.companies.alpha], name1: 'Seilerei Nord', customer_no: 'K-1001', status: 'aktiv' });
    const contact = await insert('Contact', {
      customer_id: [customer.id],
      first_name: 'Erika',
      last_name: 'Muster',
      email: 'einkauf@seilerei-nord.example',
    });
    let requester = { email: 'einkauf@seilerei-nord.example', name: 'Erika Muster' };
    const notes = fakeTicket(7102, () => requester);
    const answer = {
      summary: '**Anliegen:** zwei Drahtseile',
      company: { name: 'Seilerei Nord', city: 'Fellbach' },
      contact: { first_name: 'Erika', last_name: 'Muster', phone: '' },
      items: [{ article_id: article.id, qty: 2, name_spoken: 'Drahtseil 8mm', match_confidence: 'high' }],
      ticket_number: 'AB-4711',
      customer_reference: 'PO-815',
      lieferzeit: 'KW 24',
    };
    h.fake.on('POST', 'https://api.anthropic.com/v1/messages', () =>
      jsonResponse({
        id: 'msg_e2e',
        model: 'claude-sonnet-4-5-20250929',
        content: [{ type: 'text', text: JSON.stringify(answer) }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    );
    const page = await h.newPage();
    await h.openApp(page, 'admin');
    await h.run(page, 'await openFreshdeskTicket(7102);');
    await page.locator('#fdTicketBody button', { hasText: 'KI-Zusammenfassung erstellen' }).waitFor();
    await h.run(page, 'await generateFreshdeskTicketSummary();');
    // The summary saves itself as a private note.
    expect(notes.map((n) => n.body.includes('<!--AI_DATA:'))).toEqual([true]);

    // Nobody in the ERP has this address: the customer can come back only from the note, not from the e-mail match.
    requester = { email: 'neu@example.test', name: 'Neu' };
    await h.run(page, 'closeModal(); await openFreshdeskTicket(7102);');
    await page.locator('#fdTicketBody', { hasText: 'aus früherer Sitzung wiederhergestellt' }).waitFor({ timeout: 10_000 });
    const restored = await h.run(
      page,
      `const body = document.getElementById('fdTicketBody');
       const qty = body.querySelector('input[type="number"][min="1"]');
       const text = (el) => el.textContent.replace(/\\s+/g, ' ').trim();
       return {
         summary: _fdTicketState.summary,
         extracted: _fdTicketState.extracted,
         editFields: _fdTicketState.editFields,
         match: _fdTicketState.match && [_fdTicketState.match.customer.id, _fdTicketState.match.contact.id],
         shown: {
           item: text(qty.closest('.border-emerald-100')),
           qty: qty.value,
           customer: document.getElementById('fd_customer_search').value,
           contact: document.getElementById('fd_contact_search').value,
           ticketNumber: body.querySelector('input[placeholder^="FT-"]').value,
           reference: body.querySelector('input[placeholder^="Bestellnr."]').value,
           lieferzeit: body.querySelector('input[placeholder^="z.B."]').value,
         },
       };`,
    );
    expect(restored).toEqual({
      summary: '**Anliegen:** zwei Drahtseile',
      extracted: {
        company: { name: 'Seilerei Nord', city: 'Fellbach' },
        contact: { first_name: 'Erika', last_name: 'Muster', phone: '', email: 'einkauf@seilerei-nord.example' },
        items: [{ article_id: article.id, qty: 2, name_spoken: 'Drahtseil 8mm', match_confidence: 'high' }],
      },
      editFields: {
        ticket_number: 'AB-4711',
        customer_reference: 'PO-815',
        lieferzeit: 'KW 24',
        customer_id: customer.id,
        contact_id: contact.id,
        items: [{ article_id: article.id, qty: 2, sku: 'DS-8', name: 'Drahtseil 8 mm' }],
        attachment_ids: [],
      },
      match: [customer.id, contact.id],
      shown: {
        item: 'DS-8 Drahtseil 8 mm',
        qty: '2',
        customer: 'Seilerei Nord',
        contact: 'Erika Muster',
        ticketNumber: 'AB-4711',
        reference: 'PO-815',
        lieferzeit: 'KW 24',
      },
    });
    await h.assertClean(page);
  });

  it('an AI_DATA that is not an object restores the text of the note, as for a note without AI_DATA', async () => {
    fakeTicket(7103, () => ({ email: 'kunde@example.test', name: 'Kunde' }));
    await postAsVera(7103, aiNote('[]'));
    const admin = await h.newPage();
    await h.openApp(admin, 'admin');
    await h.run(admin, 'await openFreshdeskTicket(7103);');
    await expect
      .poll(
        () =>
          h.run(
            admin,
            `return {
               summary: _fdTicketState.summary,
               noStructure: !!_fdTicketState.cachedAiNoStructure,
               shown: document.getElementById('fdTicketBody').textContent.includes('Aus alter Notiz wiederhergestellt'),
             };`,
          ),
        { timeout: 10_000 },
      )
      .toEqual({ summary: 'Kurzfassung', noStructure: true, shown: true });
    await h.assertClean(admin);
  });

  it('the sanitizer never throws, drops what does not fit and never sets a prototype', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'admin');
    // "__proto__" as an own key at every level, as JSON.parse builds it.
    const protoJson = JSON.stringify({
      summary: 's',
      extracted: { company: { name: 'Seilerei' }, contact: {}, items: [{ qty: 1 }] },
      editFields: { items: [{ qty: 2 }, { article_id: 'recA', qty: 2 }] },
    })
      .replace(/^\{/, '{"__proto__":{"polluted":"top"},')
      .replace('"extracted":{', '"extracted":{"__proto__":{"polluted":"extracted"},')
      .replace('"company":{', '"company":{"__proto__":{"polluted":"company"},')
      .replace('"contact":{', '"contact":{"__proto__":{"polluted":"contact"}')
      .replace('"items":[{"qty":1}', '"items":[{"__proto__":{"polluted":"item"},"qty":1}')
      .replace('"editFields":{', '"editFields":{"__proto__":{"polluted":"editFields","customer_id":"recGeerbt"},')
      .replace('{"qty":2}', '{"__proto__":{"article_id":"recA"},"qty":2}');
    const result = await h.run<unknown>(
      page,
      `const articles = [{ id: 'recA', fields: { article_no: 'A-1', name1: 'Seil' } }];
       const mixed = {
         version: 1, savedAt: 'x', extra: 'weg', summary: 5,
         extracted: {
           company: { name: 'Seilerei', zip: 70734, vat: true, nested: { a: 1 }, list: [1], none: null, nan: NaN, toString: 'x' },
           contact: 'x',
           items: [{ article_id: 'recA', qty: 2, deep: {} }, 'x', null, [1]],
           other: 1,
         },
         editFields: {
           ticket_number: 4711, customer_reference: 815, lieferzeit: {},
           customer_id: 12, contact_id: 'recK', bundle_id_override: 'recB',
           attachment_ids: ['recF', 5, null, {}],
           items: [
             { article_id: 'recA', qty: '3', sku: 'FALSCH', name: 'Alt' },
             { article_id: 'recWeg', qty: 0, name: 'Gelöschter Artikel' },
             { article_id: 7, qty: 2 }, { article_id: '', qty: 2 }, { article_id: 'recA', qty: 2, name: {} },
           ],
           evil: 'weg',
         },
       };
       const inputs = [null, [], 'x', { editFields: 'x' }, { editFields: { items: 'x' } },
         { editFields: { items: [null, 5, { qty: {} }] } }, JSON.parse(${JSON.stringify(protoJson)}), mixed];
       // Only plain objects and arrays, no own "__proto__" key, at any depth.
       const plain = (v) => v === null || typeof v !== 'object' || (
         Object.getPrototypeOf(v) === (Array.isArray(v) ? Array.prototype : Object.prototype) &&
         !Object.prototype.hasOwnProperty.call(v, '__proto__') && Object.values(v).every(plain));
       const out = inputs.map((x) => {
         const r = _sanitizeAiData(x, articles);
         return { r, plain: plain(r), editFieldsProto: r === null ? null : Object.getPrototypeOf(r.editFields) === Object.prototype };
       });
       return { out, polluted: typeof ({}).polluted };`,
    );
    const empty = { summary: null, extracted: null };
    expect(result).toEqual({
      out: [
        { r: null, plain: true, editFieldsProto: null },
        { r: null, plain: true, editFieldsProto: null },
        { r: null, plain: true, editFieldsProto: null },
        { r: { ...empty, editFields: {} }, plain: true, editFieldsProto: true },
        { r: { ...empty, editFields: {} }, plain: true, editFieldsProto: true },
        { r: { ...empty, editFields: { items: [] } }, plain: true, editFieldsProto: true },
        {
          r: {
            summary: 's',
            extracted: { company: { name: 'Seilerei' }, contact: {}, items: [{ qty: 1 }] },
            editFields: { items: [{ article_id: 'recA', qty: 2, sku: 'A-1', name: 'Seil' }] },
          },
          plain: true,
          editFieldsProto: true,
        },
        {
          r: {
            summary: null,
            extracted: { company: { name: 'Seilerei', zip: 70734, vat: true }, contact: {}, items: [{ article_id: 'recA', qty: 2 }] },
            editFields: {
              ticket_number: '4711',
              customer_reference: '815',
              contact_id: 'recK',
              bundle_id_override: 'recB',
              attachment_ids: ['recF'],
              items: [
                { article_id: 'recA', qty: 3, sku: 'A-1', name: 'Seil' },
                { article_id: 'recWeg', qty: 1, sku: '', name: 'Gelöschter Artikel' },
                { article_id: 'recA', qty: 2, sku: 'A-1', name: 'Seil' },
              ],
            },
          },
          plain: true,
          editFieldsProto: true,
        },
      ],
      polluted: 'undefined',
    });
    await h.assertClean(page);
  });
});
