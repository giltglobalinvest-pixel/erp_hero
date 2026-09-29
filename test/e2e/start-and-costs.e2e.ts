// test/e2e/start-and-costs.e2e.ts
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

describe('start page', () => {
  it('shows version v6.0 on the login screen', async () => {
    const page = await h.newPage();
    await h.openApp(page);
    expect(await page.locator('#loginVersionLabel').textContent()).toBe('v6.0');
    await h.assertClean(page);
  });

  it('shows the server status tiles and the roadmap without Airtable', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    expect(await page.locator('#topbarVersion').textContent()).toBe('v6.0');
    const tiles = await h.run<string[]>(
      page,
      `const status = [...document.querySelectorAll('#pageContent h3')].find((e) => e.textContent.trim() === 'Status');
       return [...status.nextElementSibling.children].map((tile) => tile.innerText.replace(/\\s+/g, ' ').trim());`,
    );
    expect(tiles).toEqual(['Server verbunden', 'Schreibrechte aktiv', 'KI über Server']);
    const text = await page.locator('#pageContent').innerText();
    expect(text.includes('Auth via Server')).toBe(true);
    expect(text.includes('Airtable')).toBe(false);
    await h.assertClean(page);
  });
});

describe('AI costs page', () => {
  it('logs the user id and the company name, and offers both as filters', async () => {
    const vera = await h.newPage();
    await h.openApp(vera, 'vera');
    await h.run(
      vera,
      `await _logAiUsage(
         { id: 'msg_e2e', model: 'claude-sonnet-4-5-20250929', usage: { input_tokens: 1000, output_tokens: 200 } },
         { purpose: 'e2e-kosten' },
       );`,
    );
    const [entry] = await h.deps.records.list('AiUsageLog');
    expect(entry?.fields).toEqual(
      expect.objectContaining({
        created_at: expect.any(String),
        user_id: h.users.vera.id,
        user_name: 'Vera Vertrieb',
        company_id: h.companies.alpha,
        company_name: 'Alpha GmbH',
        model: 'claude-sonnet-4-5-20250929',
        purpose: 'e2e-kosten',
        input_tokens: 1000,
        output_tokens: 200,
        cost_usd: 0.006,
        request_id: 'msg_e2e',
      }),
    );
    await h.assertClean(vera);

    const admin = await h.newPage();
    await h.openApp(admin, 'admin');
    const filters = await h.run<{ users: string[][]; companies: string[][] }>(
      admin,
      `await renderAdminAiCosts();
       const options = (label) => {
         const field = [...document.querySelectorAll('#pageContent label')].find((l) => l.textContent.trim() === label);
         return [...field.nextElementSibling.options].filter((o) => o.value).map((o) => [o.value, o.textContent.trim()]);
       };
       return { users: options('Benutzer'), companies: options('Firma') };`,
    );
    expect(filters).toEqual({
      users: [[h.users.vera.id, 'Vera Vertrieb']],
      companies: [[h.companies.alpha, 'Alpha GmbH']],
    });
    await h.assertClean(admin);
  });

  it('shows the server error when the logs cannot be loaded', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'admin');
    await page.route(/\/api\/data\/AiUsageLog(\?|$)/, (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { type: 'INTERNAL', message: 'Datenbank nicht lesbar' } }),
      }),
    );
    const shown = await h.run<{ error: string | null; text: string }>(
      page,
      `await renderAdminAiCosts();
       return {
         error: document.getElementById('aiCostsError')?.textContent ?? null,
         text: document.getElementById('pageContent').innerText,
       };`,
    );
    expect(shown.error).toBe('Lesen fehlgeschlagen: Datenbank nicht lesbar');
    expect(shown.text.includes('Airtable')).toBe(false);
    expect(shown.text.includes('Tabelle jetzt anlegen')).toBe(false);
    await h.assertClean(page);
  });
});
