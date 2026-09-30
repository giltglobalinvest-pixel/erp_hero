// test/e2e/freshdesk-ticket-html.e2e.ts
import type { Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { TableName } from '../../server/data/tables.js';
import { jsonResponse } from '../helpers/fakeFetch.js';
import { startHarness, type Harness } from './harness.js';

const FD = 'https://flptest.freshdesk.com/api/v2/';
const AI = 'https://api.anthropic.com/v1/messages';
// Harmless markup that runs its handler if the live document parses it: the image is missing, so onerror counts.
const IMG = '/e2e-missing.png';
const MARK = `<img src="${IMG}" onerror="window.__fdImg=(window.__fdImg||0)+1">`;
const asText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const REQUESTER = { id: 5001, name: 'Kunde Muster', email: 'kunde@example.test' };

interface Conv {
  id: number;
  incoming: boolean;
  private: boolean;
  body: string;
  body_text: string;
  created_at: string;
}
interface FakeTicket {
  id: number;
  subject: string;
  description_html?: string;
  description?: string;
  description_text?: string;
  conversations: Conv[];
}

const TICKETS: Record<number, FakeTicket> = {
  7201: { id: 7201, subject: 'Anfrage Drahtseil', description_html: `<p>Bitte zwei Drahtseile, Lieferung KW 24.</p>${MARK}`, conversations: [] },
  // Freshdesk API v2 names the HTML field `description`; the app reads `description_html || description`.
  7202: { id: 7202, subject: 'Anfrage Oese', description: `<p>Bitte vier Oesen.</p>${MARK}`, conversations: [] },
  7203: {
    id: 7203,
    subject: 'Anfrage Kette',
    description_html: '<p>Bitte eine Kette.</p>',
    conversations: [
      { id: 8201, incoming: true, private: false, body: `<p>Nachtrag: bitte verzinkt.</p>${MARK}`, body_text: 'Nachtrag: bitte verzinkt.', created_at: '2026-09-29T10:00:00Z' },
    ],
  },
  // A private note with the header of an AI summary but no AI_DATA: the ticket view takes its text.
  7204: {
    id: 7204,
    subject: 'Anfrage Haken',
    description_html: '<p>Bitte drei Haken.</p>',
    conversations: [
      {
        id: 8301,
        incoming: false,
        private: true,
        body: `<p><strong>🤖 KI-Zusammenfassung</strong> · erstellt am 29.9.2026</p><p>Kurzfassung</p>${MARK}`,
        body_text: 'KI-Zusammenfassung Kurzfassung',
        created_at: '2026-09-29T10:00:00Z',
      },
    ],
  },
  // A plain-text mail whose text is the markup: the HTML field holds it escaped, the text field holds the characters.
  7205: { id: 7205, subject: 'Anfrage Ring', description: `<div>Hallo ${asText(MARK)}</div>`, description_text: `Hallo ${MARK}`, conversations: [] },
};
let listed: number[] = [];

const listEntry = (t: FakeTicket) => ({
  id: t.id,
  subject: t.subject,
  status: 2,
  priority: 1,
  type: null,
  requester_id: REQUESTER.id,
  responder_id: null,
  created_at: '2026-09-29T09:00:00Z',
  updated_at: `2026-09-29T09:${String(t.id % 60).padStart(2, '0')}:00Z`,
});
const ticketJson = (t: FakeTicket) => ({
  ...listEntry(t),
  requester: REQUESTER,
  tags: [],
  custom_fields: {},
  attachments: [],
  ...(t.description_html !== undefined ? { description_html: t.description_html } : {}),
  ...(t.description !== undefined ? { description: t.description } : {}),
  ...(t.description_text !== undefined ? { description_text: t.description_text } : {}),
});

let h: Harness;
const insert = (table: TableName, fields: Record<string, unknown>) =>
  h.deps.db.write((tx) => h.deps.records.insert(tx, table, fields));
const count = (method: string, url: string) => h.fake.calls.filter((c) => c.method === method && c.url === url).length;

beforeAll(async () => {
  h = await startHarness();
  await h.apiAs('admin', 'PUT', '/api/settings/freshdeskSalesGroupId', { value: '42' });
  // The requester is a known ERP contact.
  const customer = await insert('Customer', {
    company_id: [h.companies.alpha],
    name1: 'Seilerei Nord',
    customer_no: 'K-2001',
    status: 'aktiv',
    email: REQUESTER.email,
  });
  await insert('Contact', { customer_id: [customer.id], first_name: 'Kunde', last_name: 'Muster', email: REQUESTER.email });

  h.fake.on('GET', `${FD}search/tickets?`, () => jsonResponse({ total: listed.length, results: listed.map((id) => listEntry(TICKETS[id]!)) }));
  h.fake.on('GET', `${FD}agents`, () => jsonResponse([]));
  h.fake.on('GET', `${FD}contacts/${REQUESTER.id}/tickets`, () => jsonResponse([]));
  h.fake.on('GET', `${FD}contacts/${REQUESTER.id}`, () => jsonResponse({ ...REQUESTER, company_id: null }));
  for (const t of Object.values(TICKETS)) {
    h.fake.on('GET', `${FD}tickets/${t.id}?`, () => jsonResponse(ticketJson(t)));
    h.fake.on('GET', `${FD}tickets/${t.id}/conversations`, () => jsonResponse(t.conversations));
  }
  // No AI answer: the model call fails once its prompt, with the ticket text in it, has been built.
  h.fake.on('POST', AI, () => jsonResponse({ type: 'error', error: { type: 'invalid_request_error', message: 'e2e: no AI' } }, 400));
});
afterEach(async () => {
  await h.resetContexts();
});
afterAll(async () => {
  await h?.close();
});

// A tall viewport, so that the buttons deep in the ticket modal can be clicked as a user does.
// Counts the page's requests for the missing image: markup that is parsed inertly loads nothing.
async function tallPage(): Promise<{ page: Page; loads: () => number }> {
  const page = await h.newPage();
  await page.setViewportSize({ width: 1440, height: 2400 });
  let loads = 0;
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === IMG) loads++;
  });
  return { page, loads: () => loads };
}

interface Step {
  step: string;
  ran: number | null;
  loaded: number;
}
// Runs one user step, gives a missing image time to fail, then records whether a handler ran and the image was requested.
async function step(page: Page, loads: () => number, log: Step[], name: string, action: () => Promise<void>): Promise<void> {
  await action();
  await page.waitForTimeout(1000);
  log.push({ step: name, ran: await h.run<number | null>(page, 'return window.__fdImg ?? null;'), loaded: loads() });
}
const quiet = (...steps: string[]): Step[] => steps.map((s) => ({ step: s, ran: null, loaded: 0 }));

// Opens the "Anfragen" list by its sidebar entry and waits for the background note scan of each card.
async function openList(page: Page): Promise<void> {
  const before = listed.map((id) => count('GET', `${FD}tickets/${id}/conversations`));
  await page.locator('.nav-item[data-route="anfragen"]').click();
  for (const [i, id] of listed.entries()) {
    await page.locator(`.swipe-card-wrap[data-ticket-id="${id}"]`).waitFor();
    await expect.poll(() => count('GET', `${FD}tickets/${id}/conversations`), { timeout: 15_000 }).toBeGreaterThan(before[i]!);
  }
}
// Opens a ticket as a user does, by a click on its card, and waits for the notes the ticket loads by itself.
async function openTicket(page: Page, id: number): Promise<void> {
  const conv = `${FD}tickets/${id}/conversations`;
  const before = count('GET', conv);
  await page.locator(`.swipe-card[data-ticket-id="${id}"]`).getByText(TICKETS[id]!.subject, { exact: true }).click();
  await page.locator('#fdTicketBody', { hasText: 'Erste Nachricht' }).waitFor();
  await expect.poll(() => count('GET', conv), { timeout: 15_000 }).toBeGreaterThan(before);
}
async function showHistory(page: Page): Promise<void> {
  await page.locator('#fdTicketBody button', { hasText: 'Verlauf anzeigen' }).click();
  await page.locator('#fdTicketBody button', { hasText: 'Verlauf ausblenden' }).waitFor();
}
const shown = (page: Page, text: string) =>
  h.run<boolean>(page, `return document.getElementById('fdTicketBody').textContent.includes(${JSON.stringify(text)});`);

describe('markup in Freshdesk ticket HTML never runs in the ERP page', () => {
  it('control: the same markup does run when an element of the live document parses it', async () => {
    const { page } = await tallPage();
    await h.openApp(page, 'admin');
    await h.run(page, `document.createElement('div').innerHTML = ${JSON.stringify(MARK)};`);
    await expect.poll(() => h.run<number | null>(page, 'return window.__fdImg ?? null;'), { timeout: 10_000 }).toBe(1);
    await h.assertClean(page);
  });

  it('opening a ticket with markup in description_html, then its history: the text is shown', async () => {
    listed = [7201];
    const { page, loads } = await tallPage();
    const log: Step[] = [];
    await h.openApp(page, 'admin');
    await step(page, loads, log, 'open the list', () => openList(page));
    await step(page, loads, log, 'open the ticket', () => openTicket(page, 7201));
    await step(page, loads, log, 'show the history', () => showHistory(page));
    expect(log).toEqual(quiet('open the list', 'open the ticket', 'show the history'));
    expect(await shown(page, 'Bitte zwei Drahtseile, Lieferung KW 24.')).toBe(true);
    await h.assertClean(page);
  });

  it('opening a ticket with markup in description, the name Freshdesk API v2 uses: the text is shown', async () => {
    listed = [7202];
    const { page, loads } = await tallPage();
    const log: Step[] = [];
    await h.openApp(page, 'admin');
    await step(page, loads, log, 'open the list', () => openList(page));
    await step(page, loads, log, 'open the ticket', () => openTicket(page, 7202));
    expect(log).toEqual(quiet('open the list', 'open the ticket'));
    expect(await shown(page, 'Bitte vier Oesen.')).toBe(true);
    await h.assertClean(page);
  });

  it('showing the history of a ticket whose incoming reply has markup: the reply is shown', async () => {
    listed = [7203];
    const { page, loads } = await tallPage();
    const log: Step[] = [];
    await h.openApp(page, 'admin');
    await step(page, loads, log, 'open the list', () => openList(page));
    await step(page, loads, log, 'open the ticket', () => openTicket(page, 7203));
    await step(page, loads, log, 'show the history', async () => {
      await showHistory(page);
      await page.locator('#fdTicketBody', { hasText: 'Nachtrag: bitte verzinkt.' }).waitFor();
    });
    expect(log).toEqual(quiet('open the list', 'open the ticket', 'show the history'));
    expect(await shown(page, 'Bitte eine Kette.')).toBe(true);
    await h.assertClean(page);
  });

  it('opening a ticket whose private KI-Zusammenfassung note has markup and no AI_DATA, then its KI badge: the summary is shown', async () => {
    listed = [7204];
    const { page, loads } = await tallPage();
    const log: Step[] = [];
    await h.openApp(page, 'admin');
    await step(page, loads, log, 'open the list', async () => {
      await openList(page);
      await page.locator('.swipe-card-wrap[data-ticket-id="7204"] .ai-badge-slot button').waitFor();
    });
    await step(page, loads, log, 'open the ticket', async () => {
      await openTicket(page, 7204);
      await page.locator('#fdTicketBody', { hasText: 'Kurzfassung' }).waitFor();
    });
    await step(page, loads, log, 'close it, click the KI badge', async () => {
      await h.run(page, 'closeModal();');
      await page.locator('.swipe-card-wrap[data-ticket-id="7204"] .ai-badge-slot button').click();
      await page.locator('#aiSummaryQuickContent', { hasText: 'Kurzfassung' }).waitFor();
    });
    expect(log).toEqual(quiet('open the list', 'open the ticket', 'close it, click the KI badge'));
    await h.assertClean(page);
  });

  it('"Kontakt bearbeiten", then "Analysieren" reads description_text, which holds the markup as text: the prompt has the text', async () => {
    listed = [7205];
    const { page, loads } = await tallPage();
    const log: Step[] = [];
    await h.openApp(page, 'admin');
    await step(page, loads, log, 'open the list', () => openList(page));
    await step(page, loads, log, 'open the ticket', () => openTicket(page, 7205));
    // The HTML field holds the markup escaped: the ticket view shows it as text.
    expect(await shown(page, `Hallo ${MARK}`)).toBe(true);
    const analyse = page.locator('#tcmBody button[onclick="_tcmLoadSuggestions(true)"]');
    await step(page, loads, log, 'close it, click "Kontakt bearbeiten" on the card', async () => {
      await h.run(page, 'closeModal();');
      // The card has two such buttons, the icon in its header and the customer row; the icon comes first.
      await page.locator('.swipe-card-wrap[data-ticket-id="7205"] button[onclick^="event.stopPropagation();openTicketContactModal("]').first().click();
      await analyse.waitFor();
    });
    const aiBefore = count('POST', AI);
    await step(page, loads, log, 'click "Analysieren"', async () => {
      await analyse.click();
      await expect.poll(() => count('POST', AI), { timeout: 15_000 }).toBeGreaterThan(aiBefore);
    });
    expect(log).toEqual(
      quiet('open the list', 'open the ticket', 'close it, click "Kontakt bearbeiten" on the card', 'click "Analysieren"'),
    );
    const call = h.fake.calls.filter((c) => c.method === 'POST' && c.url === AI).at(-1)!;
    const prompt = (JSON.parse(String(call.body)) as { messages: { content: string }[] }).messages[0]!.content;
    expect(prompt).toContain('Erste Anfrage:\nHallo\n');
    await h.assertClean(page);
  });
});

describe('_fdHtmlToText keeps its text', () => {
  // Harmless HTML and the text the function made of it when it still parsed into a <div> of the live document.
  const TEXTS: [string, string][] = [
    ['<p>Hallo&nbsp;Welt</p><br><div>Zeile 2</div>', 'Hallo Welt\n\nZeile 2'],
    ['Zeile 1<br/>Zeile 2<BR>Zeile 3<br />Zeile 4', 'Zeile 1\nZeile 2\nZeile 3\nZeile 4'],
    ['<ul><li>Eins</li><li>Zwei</li></ul><p>Ende</p>', '• Eins\n• Zwei\nEnde'],
    ['<ol><li>Erstens</li><li>Zweitens</li></ol>', '• Erstens\n• Zweitens'],
    [
      '<div>Sehr geehrte Damen und Herren,<br><br>bitte <b>2 Stück</b> &amp; <i>Versand</i>.</div><blockquote>Zitat</blockquote>',
      'Sehr geehrte Damen und Herren,\n\nbitte 2 Stück & Versand.\nZitat',
    ],
    [
      '<div dir="ltr">Hallo Team,<div><br></div><div>danke für das Angebot.</div><div><br></div><div>Gruß<br>Erika</div></div>',
      'Hallo Team,\n\ndanke für das Angebot.\n\nGruß\nErika',
    ],
    ['<div>Antwort</div><blockquote><div>Am Montag schrieb Kunde:</div><blockquote><p>Frage</p></blockquote></blockquote>', 'Antwort\nAm Montag schrieb Kunde:\nFrage'],
    ['&lt;b&gt;kein Tag&lt;/b&gt;', '<b>kein Tag</b>'],
    ['<p>&auml;&ouml;&uuml;&szlig; &euro; &#8364; &#x20AC; &quot;x&quot; &lt;tag&gt; &amp;amp;</p>', 'äöüß € € € "x" <tag> &amp;'],
    ['<table><tr><td>A</td><td>B</td></tr><tr><td>C</td></tr></table>', 'AB\nC'],
    ['<table><thead><tr><th>Pos</th><th>Menge</th></tr></thead><tbody><tr><td>1</td><td>2 Stk</td></tr></tbody></table>', 'PosMenge\n12 Stk'],
    ['<html><head><title>T</title><style>p{color:red}</style></head><body><p>Body</p></body></html>', 'Tp{color:red}Body'],
    ['<script>var x = 1</script><p>nach Script</p>', 'var x = 1nach Script'],
    ['<p>Bild: <img alt="x"></p><h2>Titel</h2>', 'Bild:\nTitel'],
    ['Nur Text\nmit   Zeilen', 'Nur Text\nmit Zeilen'],
    ['<p>a</p>\n\n\n\n<p>b</p>', 'a\n\nb'],
    ['', ''],
  ];

  it('harmless HTML gives the same text as before; no HTML gives an empty string', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'admin');
    const got = await h.run<{ texts: string[]; empty: string[] }>(
      page,
      `return {
         texts: ${JSON.stringify(TEXTS.map(([html]) => html))}.map((s) => _fdHtmlToText(s)),
         empty: [_fdHtmlToText(null), _fdHtmlToText(undefined)],
       };`,
    );
    expect(got).toEqual({ texts: TEXTS.map(([, text]) => text), empty: ['', ''] });
    await h.assertClean(page);
  });
});
