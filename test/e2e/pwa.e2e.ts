// test/e2e/pwa.e2e.ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ROOT_DIR } from '../helpers/context.js';
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

const RAILWAY = 'https://erp-hero-production.up.railway.app/';
// The old home on GitHub Pages, and the localStorage key of the old loader's copy of index.html.
const PAGES = 'https://giltglobalinvest-pixel.github.io';
const LOADER_CACHE_KEY = 'app_cache_giltglobalinvest-pixel/erp_hero';

// What the service worker must leave to the network.
const isApi = (pathname: string): boolean => pathname.startsWith('/api/') || pathname === '/healthz';

// Plays GitHub Pages (pathname → HTML, else 404) and Railway (a stand-in page) for this page.
// page.route() takes precedence over the harness's context route.
// Returns the GitHub Pages pathnames the page asked for.
const playPagesAndRailway = async (page: Page, pages: Record<string, string>): Promise<string[]> => {
  const requested: string[] = [];
  await page.route(`${PAGES}/**`, (route) => {
    const pathname = new URL(route.request().url()).pathname;
    requested.push(pathname);
    const body = pages[pathname];
    return body === undefined
      ? route.fulfill({ status: 404, contentType: 'text/plain', body: 'nicht gefunden' })
      : route.fulfill({ contentType: 'text/html; charset=utf-8', body });
  });
  await page.route(`${RAILWAY}**`, (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<p id="railway">Railway</p>' }),
  );
  return requested;
};

const controlled = (page: Page): Promise<boolean> =>
  h.run<boolean>(page, 'return !!navigator.serviceWorker.controller;');

// Cache Storage of the page's origin: cache name → cached pathnames.
const cacheContents = (page: Page): Promise<Record<string, string[]>> =>
  h.run<Record<string, string[]>>(
    page,
    `const out = {};
     for (const name of await caches.keys()) {
       out[name] = (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname);
     }
     return out;`,
  );

describe('service worker', () => {
  it('scenario 13: v2 never answers or stores /api/ and /healthz, and drops the v1 cache', async () => {
    const page = await h.newPage({ serviceWorkers: 'allow' });
    // An old installation: a v1 cache with a stored API answer. Any page of the origin can create it.
    await page.goto(`${h.baseUrl}/healthz`);
    await h.run(page, `await (await caches.open('erp-hero-sw-v1')).put('/api/me', new Response('{}'));`);
    const fromWorker: string[] = [];
    page.on('response', (res) => {
      const url = new URL(res.url());
      if (url.origin === h.baseUrl && res.fromServiceWorker()) fromWorker.push(url.pathname);
    });

    await h.openApp(page, 'vera');
    await expect.poll(() => controlled(page), { timeout: 10_000 }).toBe(true);
    await h.run(page, `await readData('Company'); await fetch('/healthz');`);
    // From the second visit on, the worker sees every request, the page itself included.
    await page.reload();
    await page.waitForSelector('#appShell:not(.hidden)', { state: 'visible' });
    await h.run(page, `await readData('Customer');`);

    expect(fromWorker.includes('/')).toBe(true);
    expect(fromWorker.filter(isApi)).toEqual([]);
    await expect.poll(async () => Object.keys(await cacheContents(page)), { timeout: 5_000 }).toEqual(['erp-hero-sw-v2']);
    await expect
      .poll(async () => (await cacheContents(page))['erp-hero-sw-v2']?.includes('/'), { timeout: 5_000 })
      .toBe(true);
    expect(((await cacheContents(page))['erp-hero-sw-v2'] ?? []).filter(isApi)).toEqual([]);
    await h.assertClean(page);
  });
});

describe('GitHub Pages', () => {
  const indexHtml = readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');

  it('a copy of index.html there moves on to Railway before the app starts', async () => {
    const page = await h.newPage();
    const requested = await playPagesAndRailway(page, { '/erp_hero/': indexHtml });
    await page.goto(`${PAGES}/erp_hero/`, { waitUntil: 'commit' });
    await page.waitForURL(RAILWAY, { timeout: 5_000 });
    expect(await page.locator('#railway').textContent()).toBe('Railway');
    // Once started, the app would ask github.io for /api/me at once.
    expect(requested.filter(isApi)).toEqual([]);
    await h.assertClean(page);
  });

  it('so does the old loader, which writes index.html into its own page', async () => {
    const page = await h.newPage();
    // Like the old loader.html, which fetched the file from raw.githubusercontent.com.
    const oldLoader = `<!DOCTYPE html><html><body><script>
      fetch('index.html').then((r) => r.text()).then((t) => { document.open(); document.write(t); document.close(); });
    </script></body></html>`;
    const requested = await playPagesAndRailway(page, {
      '/erp_hero/loader.html': oldLoader,
      '/erp_hero/index.html': indexHtml,
    });
    await page.goto(`${PAGES}/erp_hero/loader.html`, { waitUntil: 'commit' });
    await page.waitForURL(RAILWAY, { timeout: 5_000 });
    expect(requested.filter(isApi)).toEqual([]);
    await h.assertClean(page);
  });

  it.each(['loader.html', 'loader-admin.html'])('%s deletes the old copy of the app and moves on to Railway', async (file) => {
    const loader = readFileSync(path.join(ROOT_DIR, file), 'utf8');
    // The fallback when the redirect does not run.
    expect(loader.includes('<a href="https://erp-hero-production.up.railway.app/">Weiter zu ERP Hero</a>')).toBe(true);
    const page = await h.newPage();
    await playPagesAndRailway(page, { '/erp_hero/': '<!DOCTYPE html><title>leer</title>', [`/erp_hero/${file}`]: loader });
    await page.goto(`${PAGES}/erp_hero/`);
    await h.run(
      page,
      `localStorage.setItem('${LOADER_CACHE_KEY}', '<html>alt</html>');
       localStorage.setItem('${LOADER_CACHE_KEY}_at', '2026-01-01T00:00:00.000Z');
       localStorage.setItem('e2e_bleibt', '1');`,
    );
    await page.goto(`${PAGES}/erp_hero/${file}`, { waitUntil: 'commit' });
    await page.waitForURL(RAILWAY, { timeout: 5_000 });
    await page.goto(`${PAGES}/erp_hero/`);
    expect(await h.run<string[]>(page, 'return Object.keys(localStorage);')).toEqual(['e2e_bleibt']);
    await h.assertClean(page);
  });
});

describe('forceAppUpdate', () => {
  it('clears the old copies and Cache Storage, then loads / again', async () => {
    const page = await h.newPage();
    await h.openApp(page, 'vera');
    await h.run(
      page,
      `localStorage.setItem('${LOADER_CACHE_KEY}', '<html>alt</html>');
       localStorage.setItem('cache_Company', '[]');
       localStorage.setItem('e2e_bleibt', '1');
       await (await caches.open('erp-hero-sw-v1')).put('/', new Response('alt'));`,
    );
    // It navigates away, so it is started and not awaited.
    await h.run(page, 'forceAppUpdate();');
    await page.waitForURL(/\/\?t=\d+$/, { timeout: 5_000 });
    await page.waitForSelector('#appShell:not(.hidden)', { state: 'visible' });
    const left = await h.run<Record<string, unknown>>(
      page,
      `return {
         cacheKeys: Object.keys(localStorage).filter((k) => k.startsWith('app_cache_') || k.startsWith('cache_')),
         kept: localStorage.getItem('e2e_bleibt'),
         cacheStorage: await caches.keys(),
       };`,
    );
    expect(left).toEqual({ cacheKeys: [], kept: '1', cacheStorage: [] });
    await h.assertClean(page);
  });
});
