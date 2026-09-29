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

describe('boot', () => {
  it('shows the login screen with the admin hint and never calls Airtable', async () => {
    const page = await h.newPage();
    await h.openApp(page);
    expect(await page.locator('#loginScreen').isVisible()).toBe(true);
    expect((await page.locator('#loginHint').textContent())?.trim()).toBe('Den Key bekommst du vom Admin.');
    await h.assertClean(page);
  });
});
