# erp_hero
GitDeploy: erp_hero

### Browser end-to-end tests

`npm run test:e2e` loads the real `index.html` in headless Chromium against an in-process backend
(temporary SQLite database, fake upstreams). Tailwind and Lucide get stand-ins. Fonts and the
lazily loaded editor and PDF libraries (`fonts.googleapis.com`, `fonts.gstatic.com`,
`cdn.jsdelivr.net`, `cdnjs.cloudflare.com`) are blocked without failing the test. A request to any
other foreign host fails it, so the suite never touches Airtable, Freshdesk, Freshsales, Mailchimp
or Anthropic.

It uses `playwright-core` (no bundled browser). Playwright finds the browser through
`PLAYWRIGHT_BROWSERS_PATH`; to use another Chromium, set `CHROMIUM_PATH`:

```bash
CHROMIUM_PATH=/usr/bin/chromium npm run test:e2e
```
