# erp_hero
GitDeploy: erp_hero

### Browser end-to-end tests

`npm run test:e2e` loads the real `index.html` in headless Chromium against an in-process backend
(temporary SQLite database, fake upstreams). Third-party CDNs are stubbed and every request to a
foreign host fails the test, so the suite never touches Airtable, Freshdesk, Freshsales, Mailchimp
or Anthropic.

It uses `playwright-core` (no bundled browser). Playwright finds the browser through
`PLAYWRIGHT_BROWSERS_PATH`; to use another Chromium, set `CHROMIUM_PATH`:

```bash
CHROMIUM_PATH=/usr/bin/chromium npm run test:e2e
```
