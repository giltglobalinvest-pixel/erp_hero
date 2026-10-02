import type { Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
const basic = (user: string, password: string): string => 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
const callsTo = (prefix: string) => h.fake.calls.filter((c) => c.url.startsWith(prefix));
// Headers of the page's own /api requests whose URL contains `part`, collected from now on.
const apiRequests = (page: Page, part: string): Record<string, string>[] => {
  const seen: Record<string, string>[] = [];
  page.on('request', (r) => {
    if (r.url().startsWith(h.baseUrl + '/api/') && r.url().includes(part)) seen.push(r.headers());
  });
  return seen;
};
// askAI logs its usage without awaiting it, so the test polls for the row.
const eventually = async (check: () => Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('condition not met within 5 s');
};

describe('upstream proxies', () => {
  it("freshdeskFetch sends the current company, and the server uses that company's Freshdesk key", async () => {
    h.fake.on('GET', FD + 'tickets/101', () => jsonResponse({ id: 101, subject: 'Anfrage Alpha' }));
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    const sent = apiRequests(page, '/freshdesk/');
    const subjects = await h.run<string[]>(
      page,
      `APP_KEYS.currentCompanyId = ${JSON.stringify(h.companies.alpha)};
       const a = await freshdeskFetch('tickets/101');
       APP_KEYS.currentCompanyId = ${JSON.stringify(h.companies.beta)};
       const b = await freshdeskFetch('/api/v2/tickets/101');
       return [a.subject, b.subject];`,
    );
    expect(subjects).toEqual(['Anfrage Alpha', 'Anfrage Alpha']);
    expect(sent.map((s) => [s['x-company-id'], s['authorization']])).toEqual([
      [h.companies.alpha, undefined],
      [h.companies.beta, undefined],
    ]);
    // Vera has a key for Alpha only; for Beta the server falls back to FRESHDESK_API_KEY.
    expect(callsTo(FD + 'tickets/101').map((c) => c.headers.get('authorization'))).toEqual([
      basic('fd-key-alpha', 'X'),
      basic('env-freshdesk-key', 'X'),
    ]);
    await h.assertClean(page);
  });

  it('Freshsales, Anthropic and the health check go through the server with its keys', async () => {
    h.fake.on('GET', 'https://gilt.freshworks.com/crm/sales/api/sales_accounts/77', () =>
      jsonResponse({ sales_account: { id: 77, name: 'Alpha Kunde' } }),
    );
    h.fake.on('POST', 'https://api.anthropic.com/v1/messages', () =>
      jsonResponse({
        id: 'msg_e2e',
        model: 'claude-sonnet-4-5-20250929',
        content: [{ type: 'text', text: 'Hallo zurück' }],
        usage: { input_tokens: 12, output_tokens: 4 },
      }),
    );
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    const result = await h.run<Record<string, unknown>>(
      page,
      `const fs = await proxyFetch('freshsales/api/sales_accounts/77');
       const ai = await askAI('Hallo KI', { purpose: 'e2e-test' });
       const health = await proxyFetch('health');
       return { fs: fs.sales_account.name, ai, health };`,
    );
    expect(result).toEqual({
      fs: 'Alpha Kunde',
      ai: 'Hallo zurück',
      health: {
        ok: true,
        auth_kind: 'session',
        user: { name: 'Vera Vertrieb', is_admin: false, has_freshdesk_key: false, freshdesk_company_keys: [h.companies.alpha] },
      },
    });
    const [fsCall] = callsTo('https://gilt.freshworks.com/');
    expect(fsCall?.headers.get('authorization')).toBe('Token token=test-freshsales-key');
    const [aiCall] = callsTo('https://api.anthropic.com/');
    expect(aiCall?.headers.get('x-api-key')).toBe('test-anthropic-key');
    expect(JSON.parse(String(aiCall?.body)).messages).toEqual([{ role: 'user', content: 'Hallo KI' }]);
    // askAI logs the usage with writeData('AiUsageLog', …), which every user may create.
    await eventually(async () =>
      (await h.deps.records.list('AiUsageLog')).some((r) => r.fields.purpose === 'e2e-test' && r.fields.input_tokens === 12),
    );
    await h.assertClean(page);
  });

  it('keeps the old error format "Proxy <status>: …" and resolves a 204', async () => {
    // Freshdesk's answer to a duplicate company name. _tcmCreateCompanyFromCtx and _tcmCreateFdCompany read the id
    // out of the message.
    // The body is shorter than 200 characters, so the message carries all of it.
    const duplicate = {
      description: 'Validation failed',
      errors: [{ field: 'name', additional_info: { company_id: 4711 }, message: 'It should be a unique value', code: 'duplicate_value' }],
    };
    h.fake.on('POST', FD + 'companies', () => jsonResponse(duplicate, 409));
    h.fake.on('DELETE', FD + 'conversations/555', () => new Response(null, { status: 204 }));
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    const dup = await h.runError(page, `await proxyFetch('freshdesk/api/v2/companies', { method: 'POST', body: { name: 'Alpha GmbH' } });`);
    expect(dup).toEqual({ message: 'Proxy 409: ' + JSON.stringify(duplicate), status: 409 });
    expect(/"company_id"\s*:\s*(\d+)/.exec(dup.message)?.[1]).toBe('4711');
    // The server refuses a path outside its allowlist itself; the text comes from {error: {message}}.
    expect(await h.runError(page, `await proxyFetch('freshdesk/api/v2/admin/secrets');`)).toEqual({
      message: 'Proxy 403: Endpoint nicht freigegeben',
      status: 403,
      type: 'FORBIDDEN',
    });
    expect(await h.run(page, `return await proxyFetch('freshdesk/api/v2/conversations/555', { method: 'DELETE' });`)).toBe('');
    expect(callsTo(FD + 'admin/')).toEqual([]);
    await h.assertClean(page);
  });

  it('an HTML error page from upstream becomes "Proxy <status>" without the page', async () => {
    // The server passes upstream bodies through unchanged: the markup of a 502 page must not reach the message.
    h.fake.on(
      'GET',
      FD + 'tickets/502',
      () =>
        new Response('<!DOCTYPE html><html><body><h1>502 Bad Gateway</h1></body></html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
    );
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    expect(await h.runError(page, "await proxyFetch('freshdesk/api/v2/tickets/502');")).toEqual({ message: 'Proxy 502', status: 502 });
    await h.assertClean(page);
  });

  it('an upstream 401 is an error for the caller, not an expired session', async () => {
    const rejected = { code: 'invalid_credentials', message: 'You have to be logged in to perform this action.' };
    h.fake.on('GET', FD + 'tickets/401', () => jsonResponse(rejected, 401));
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    expect(await h.runError(page, `await freshdeskFetch('tickets/401');`)).toEqual({
      message: 'Proxy 401: ' + JSON.stringify(rejected),
      status: 401,
    });
    // No re-login overlay (Task 11), and the session still works.
    expect(await page.locator('#reauthOverlay').count()).toBe(0);
    expect(await h.run(page, `return (await _api('GET', '/me')).user.name;`)).toBe('Vera Vertrieb');
    await h.assertClean(page);
  });

  it('sends a multipart body (an e-mail with a PDF) to Freshdesk with its boundary intact', async () => {
    h.fake.on('POST', FD + 'tickets/outbound_email', () => jsonResponse({ id: 9001 }, 201));
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    const id = await h.run<number>(
      page,
      `const fd = new FormData();
       fd.append('subject', 'Angebot Q-1001');
       fd.append('email', 'kunde@example.com');
       fd.append('attachments[]', new Blob(['%PDF-1.4 Angebot'], { type: 'application/pdf' }), 'Angebot Q-1001.pdf');
       const res = await proxyFetch('freshdesk/api/v2/tickets/outbound_email', { method: 'POST', body: fd });
       return res.id;`,
    );
    expect(id).toBe(9001);
    const [call] = callsTo(FD + 'tickets/outbound_email');
    const contentType = call?.headers.get('content-type') ?? '';
    expect(contentType.startsWith('multipart/form-data; boundary=')).toBe(true);
    const form = await new Response(new Uint8Array(call?.body ?? Buffer.alloc(0)), {
      headers: { 'content-type': contentType },
    }).formData();
    const file = form.get('attachments[]') as File | null;
    expect([form.get('subject'), form.get('email'), file?.name, file?.type, await file?.text()]).toEqual([
      'Angebot Q-1001',
      'kunde@example.com',
      'Angebot Q-1001.pdf',
      'application/pdf',
      '%PDF-1.4 Angebot',
    ]);
    await h.assertClean(page);
  });

  it('mailchimpFetch needs a stored key and sends only the company id', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    const sent = apiRequests(page, '/mailchimp/');
    const beta = JSON.stringify(h.companies.beta);
    expect((await h.runError(page, `await mailchimpFetch('3.0/ping', {}, ${beta});`)).message).toBe(
      'Mailchimp ist nicht konfiguriert für Mandant „Beta AG" (Admin → Einstellungen)',
    );
    expect(sent).toEqual([]);

    await h.apiAs('admin', 'PATCH', `/api/admin/companies/${h.companies.beta}/secrets`, { mailchimp_api_key: 'mc-key-beta-us21' });
    h.fake.on('GET', 'https://us21.api.mailchimp.com/3.0/ping', () => jsonResponse({ health_status: "Everything's Chimpy!" }));
    const result = await h.run<unknown[]>(
      page,
      `await loadCompanies();
       const c = APP_KEYS.companies.find(x => x.id === ${beta});
       const r = await mailchimpFetch('3.0/ping', {}, ${beta});
       return [c.has_mailchimp_key, r.health_status];`,
    );
    expect(result).toEqual([true, "Everything's Chimpy!"]);
    expect(sent.map((s) => [s['x-company-id'], s['x-mailchimp-key'], s['x-mailchimp-server']])).toEqual([
      [h.companies.beta, undefined, undefined],
    ]);
    const [call] = callsTo('https://us21.api.mailchimp.com/');
    expect(call?.headers.get('authorization')).toBe(basic('anystring', 'mc-key-beta-us21'));
    await h.assertClean(page);
  });
});
