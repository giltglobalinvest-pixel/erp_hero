# ERP Hero frontend switch: index.html on the backend API — Design

- Date: 2026-09-28
- Branch: `claude/awesome-faraday-jjwsxl`
- Builds on: `2026-09-25-erp-hero-backend-design.md` (the backend, merged in PR #1, and §21 "Frontend switch cheat-sheet")
- Review mode: the user gave a free hand ("go ahead and work as you need"). This spec is shared for asynchronous review and is not a blocking gate.

## 1. Context and goal

The backend (Hono + SQLite) runs at `https://erp-hero-production.up.railway.app` and serves `index.html` and `sw.js` from the repo root. `index.html` (v5.20, about 34,000 lines) still talks to Airtable directly: it uses an embedded read token plus a write key loaded from the Master base. It also calls the Val.town proxy for login, Freshdesk, Freshsales, Mailchimp and Anthropic. So a user who opens the Railway URL today sees the old login, and it cannot work.

**Goal.** `index.html` talks only to its own origin under `/api`. A user opens the Railway URL, logs in with a login key, and works on the SQLite data.

**Success criteria**

1. Logging in with a login key on the Railway URL works, and the session survives a reload through the cookie.
2. Every data read and write, and every lock, document number, file, setting and upstream call, goes to `/api/...`.
3. `index.html` contains no Airtable host, no Val.town code and no embedded token.
4. The Airtable base is never written to. After this change the app makes no Airtable call at all. The one-off import (`npm run import:airtable`) only reads, with GET.
5. A browser end-to-end suite covers the main flows against an in-process backend, and both suites are green: unit (`npm test`) and end-to-end (`npm run test:e2e`).

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **Direct cutover**, with no parallel run of the old app | The user confirmed that the old GitHub Pages app is not in use. |
| D2 | **Same-origin cookie auth.** The browser keeps no token, and `/api` calls send no `Authorization` header. | The backend already sets an HttpOnly session cookie. |
| D3 | **Keep the existing function names and signatures** (`readData`, `writeData`, `updateData`, `deleteData`, `proxyFetch`, `freshdeskFetch`, `mailchimpFetch`, `acquireLock`, `releaseLock`, `next*No`). The one exception is `uploadFileToRecord`, which gains a `table` parameter. | This keeps the change mechanical: about 500 call sites stay as they are. |
| D4 | **Document numbers: peek, then save, with 409 recovery.** `next*No` asks the server for the next free number. `writeData` saves it. If another save took that number in the meantime, `writeData` retries once and lets the server assign the number. | The forms show the number before saving, as today. The server stays the only authority, and a race costs a warning toast instead of a duplicate. |
| D5 | **Server locks** through `/api/locks`, plus a small shim in `updateData` for the existing pattern that releases a lock inside the save PATCH | The save handlers stay untouched. |
| D6 | **Session expiry opens a re-login overlay.** It keeps the open form and retries the failed request once. | An 8-hour session must never cost unsaved input. |
| D7 | **The Railway URL is the only home.** GitHub Pages copies and the loaders redirect there. | This avoids a broken app on github.io once `main` carries the new `index.html`. |
| D8 | **`APP_VERSION = 'v6.0'`** | This is a breaking change of the app's backend. |
| D9 | **The e2e tests run in a real headless Chromium**, driven by `playwright-core` from vitest against an in-process backend. Third-party CDNs are stubbed, and upstream hosts are blocked. | The flows depend on a real DOM, cookies and a service worker, and the suite must stay hermetic. |

## 3. Scope

**In scope**

- `index.html`
- `sw.js`
- `loader.html`, `loader-admin.html`
- new tests (`test/frontend/`, `test/e2e/`)
- `package.json` (one devDependency and one script)
- `vitest.e2e.config.ts`
- `README.md`, `DEPLOY.md`

**Out of scope**

- Backend changes. The exception is a backend bug that blocks the switch; that gets the minimal fix with a test, and is called out in the summary.
- Visual redesign, and splitting `index.html` into modules.
- Offline mode, beyond today's service worker fallback.
- Pre-existing bugs that the switch does not touch, for example `_logAiUsage` reading `APP_KEYS.user?.id` instead of `_id`. These are listed in the final summary.
- `backfillCustomerNumbers()`. It stays client-side, and it keeps working through `updateData`.
- Running the Airtable import. That needs the user's own read token (§12).

## 4. Architecture

```
UI code (unchanged)
  │  readData / writeData / updateData / deleteData
  │  next*No · acquireLock / releaseLock · uploadFileToRecord
  │  proxyFetch / freshdeskFetch / mailchimpFetch · loadSettings / saveSetting
  ▼
_api(method, path, options)         ← the one place that talks HTTP
  │  fetch('/api' + path), same-origin cookie, JSON in and out
  │  errors → Error(message) with .status and .type
  │  401 UNAUTHENTICATED → re-login overlay → retry once
  ▼
backend /api/*  (auth, data, numbers, locks, files, settings, admin, proxies)
```

The existing helpers are rewritten on top of `_api`. Nothing else in the UI needs to know about HTTP.

## 5. The API client

The signature is `_api(method, path, { body, headers, keepalive, reauth = true })`.

- The URL is `'/api' + path`, with `credentials: 'same-origin'` and `Accept: application/json`.
- A plain-object body is JSON-encoded and sent with `Content-Type: application/json`. A `FormData` or string body is sent as is.
- **Network failure:** it throws `Error('Server nicht erreichbar – bitte Verbindung prüfen')`.
- **Non-2xx response:** it reads the body. The message is picked in this order:
  1. `j.error.message` (the backend's `{error:{type,message}}` shape);
  2. `j.error`, when it is a string;
  3. `j.message`;
  4. `j.description`, which Freshdesk sends;
  5. the first 200 characters of the text body;
  6. `'HTTP ' + status'`.

  It throws an `Error` with that message, plus `.status` and `.type` (`j.error?.type`) and `.body` (the parsed body, for callers that inspect upstream errors).
- **Session expiry:** status 401 with `error.type === 'UNAUTHENTICATED'` and `reauth` on means `await _reauth()`, then a single retry of the same request. A raw upstream 401, for example Freshdesk rejecting a key, has no such type, so it is thrown as a normal error.
- **Success:** it returns parsed JSON when the response is `application/json`, and text otherwise.
- `reauth: false` is used for `/auth`, for `/me` at boot, and for `/logout`. The `sendBeacon` lock release on unload doesn't go through `_api`.

**Re-login overlay (`_reauth`)**

- All requests waiting on it share one promise, so parallel failures open a single overlay.
- The overlay is its own DOM node, appended to `<body>`, with a z-index above every modal and toast. It contains:
  - the text "Sitzung abgelaufen – bitte Login-Key erneut eingeben";
  - a password input for the key;
  - an "Angemeldet bleiben" checkbox, defaulting to the login screen's choice;
  - two buttons, "Anmelden" and "Abbrechen".
- **Anmelden** sends `POST /api/auth` with `reauth: false`. An error is shown inside the overlay. On success:
  - if the returned user id differs from `APP_KEYS.user._id`, it runs `location.reload()`, because a different user must not inherit the open screen;
  - otherwise it refreshes `APP_KEYS.user` and resolves the promise.
- **Abbrechen** rejects with `Error('Sitzung abgelaufen')`. The caller shows its usual error, and the open form stays as it is.

## 6. Authentication and boot

**`init()`**

It keeps its current steps, with these changes:

- The `loadProjectKeys()` call is dropped.
- A one-time cleanup removes the old token keys from localStorage: the session-token key and the legacy user-key key.
- `tryAutoLogin()` calls `GET /api/me` with `reauth: false`. On success it calls `showApp()`. On a 401 it calls `showLoginScreen()`.

**`loginWithUserKey(userKey, longLived)`**

- It sends `POST /api/auth {user_key, long_lived}`.
- It sets `APP_KEYS.user` from `data.user`: `{_id: data.user.id, name, role, is_admin, allowed_companies, freshdesk_company_keys, has_freshdesk_key}`.
- It then runs `_afterLogin()`.
- On an error, the login screen shows the server's message: "Ungültiger Login-Key oder Account inaktiv", or the rate-limit text.

**`_afterLogin()`** runs `Promise.all([loadCompanies(), loadUsersCache(), loadSettings()])`. Both a login and `tryAutoLogin` use it.

**`logout()`** does the following, in order:

1. It releases the current lock, if there is one.
2. It sends `POST /api/logout` with keepalive, ignoring errors.
3. It clears `APP_KEYS` and reloads the page.

**Removed**

- the token storage helpers (`_get/_set/_clearStoredToken`);
- `_bootstrapLogin` and the legacy key migration;
- `loadProjectKeys`;
- `_TKP1` / `_TKP2`;
- `APP_CONFIG.AIRTABLE_READ_KEY`, `APP_BASE_ID` and `MASTER_BASE_ID`;
- the `APP_KEYS` fields `airtableWriteKey`, `anthropicKey`, `appBaseId`, `apiProxyUrl`, `freshdeskProxyUrl`, `freshdeskProxyToken`, `valtownKey`, `valtownValId` and `sessionToken`.

**Kept**

- `APP_KEYS.proxyV2` stays and is always `true`: the server supports a Freshdesk key per company, so the existing branches keep working.
- Every check of the form "is the proxy configured?" or "is there a write key?" is removed or replaced by "is a user logged in?". That covers `APP_KEYS.apiProxyUrl`, `APP_KEYS.airtableWriteKey` and `_proxyBase()` truthiness.
- `_proxyBase()` still returns `'/api'`, for the few places that build URLs from it, so any truthiness check left behind stays harmless.

**Login screen.** It drops the "Setup-Modus" branch and always shows "Den Key bekommst du vom Admin."

## 7. Data

| Function | New behaviour |
|---|---|
| `readData(table, filter, opts)` | Sends `GET /api/data/:table` with `filterByFormula`, `sort[i][field|direction]`, `maxRecords` and `fields[]`, and returns `records`. The server returns **all** matching records; the old code only read Airtable's first page of up to 100. The error is `'Lesen fehlgeschlagen: ' + message`. The only formula `index.html` uses is `{status}='aktiv'`, which the server supports. |
| `writeData(table, fields, opts)` | Sends `POST /api/data/:table {fields, assignNumber?, variantOf?}`. The error is `'Schreiben fehlgeschlagen: ' + message`. The lazy customer sync (`_syncCustomerOnUse` for Quote, Order, DeliveryNote and Invoice) stays. The number recovery is in §8. |
| `updateData(table, id, fields)` | Sends `PATCH /api/data/:table/:id {fields}`. The error is `'Update fehlgeschlagen: ' + message`. The lock shim is in §9. |
| `deleteData(table, id)` | Sends `DELETE /api/data/:table/:id`. The error is `'Löschen fehlgeschlagen: ' + message`. |
| `ensureTable` / `ensureFields` | Return immediately, with no request: every table exists and fields need no schema. The callers never use the return value. |
| `loadCompanies()` | Uses `readData('Company', "{status}='aktiv'")` with the same mapping as today, except that `mailchimp_api_key` becomes `has_mailchimp_key`. |
| `loadUsersCache()` | No change. `readData('User')` returns names only for non-admins, which is all it needs. |

**What the server does on writes that the client must respect**

- Empty values (`null`, `''`, `false`, `[]`) clear the field.
- Lock fields and derived fields (`has_*`, `freshdesk_company_keys`) are ignored.
- Secret fields are rejected with a 400. The client never sends them: the User and Company admin forms send secrets only through the admin secret endpoints (§11).

## 8. Document numbers

- The ten generators keep their names and parameters:
  - `nextCustomerNo`, `nextSupplierNo`, `nextArticleNo`, `nextInquiryNo`, `nextQuoteNo`;
  - `nextQuoteVariantNo(base, companyId)`;
  - `nextOrderNo`, `nextPurchaseNo`, `nextDeliveryNo`, `nextInvoiceNo`.
- Each one becomes a call to `GET /api/numbers/:type/next?company=<id>` (with `&base=<quote no>` for variants), and returns `number`.
- The number types are `customer`, `supplier`, `article`, `inquiry`, `quote`, `order`, `purchase`, `delivery` and `invoice`.
- Each generator records the peeked value in `_peekedNumbers` (a Set of `table|value`).
- The client knows each table's number field: Customer `customer_no`, Supplier `supplier_no`, Article `article_no`, Inquiry `inquiry_no`, Quote `quote_no`, Order `order_no`, SupplierOrder `purchase_no`, DeliveryNote `delivery_no`, Invoice `invoice_no`.

**Recovery in `writeData`**

- It applies when `writeData` fails with 409 `DUPLICATE_NUMBER`, and the table's number field in `fields` holds a peeked value.
- In that case it retries once:
  - with `variantOf: <that value>` when the value matches `^Q-\d+\.\d+$`;
  - otherwise with `assignNumber: true`.
- The server then assigns the next free number inside its write transaction.
- On success it shows a warning toast: "Nummer X war inzwischen vergeben – gespeichert als Y".
- A 409 on a number the user typed by hand is not recovered. It is shown as an error, as any other save error.

**Call sites.** A call site that reuses the number *after* the save, in a toast, a follow-up write or a subject line, reads `created.fields.<number field>` instead of its local variable. The plan lists these sites. Text built into the record *before* the save keeps the peeked number; that is acceptable, because a 409 only happens when two users create the same document type in the same company within seconds.

**Updates.** Updates keep the server's check: changing a number to one that already exists gives a 409 error with no recovery, as before.

## 9. Record locks

- **`acquireLock(table, recordId, currentRecord)`**
  - It ignores `currentRecord`, since the server decides.
  - It sends `POST /api/locks/:table/:id`.
  - `{ok:true}` starts the heartbeat and returns `{ok:true}`.
  - `{ok:false, locked_by}` returns `{ok:false, lockedBy: locked_by.name}`, which the callers already display.
- **Heartbeat**
  - `startLockHeartbeat` keeps setting `_currentLock` and its two-minute timer.
  - The timer sends `POST …/refresh`.
  - If a refresh comes back `ok:false` (the lock expired, for example after sleep, and someone else took it), the heartbeat stops and a warning toast names the other user.
  - Network errors are ignored, as today.
- **`releaseLock(table, recordId)`** stops the heartbeat and sends `POST …/release`, ignoring errors.
- **Unload.** `beforeunload` sends `navigator.sendBeacon('/api/locks/<t>/<id>/release')` for `_currentLock`. That request carries the cookie, and the server ignores its body.
- **Shim in `updateData`**
  - The save handlers put `lock_user_id: ''` and `lock_until: ''` into their PATCH.
  - `updateData` strips `lock_user_id` and `lock_until` from `fields` and sends the PATCH.
  - Only if the PATCH succeeds and both values were empty does it:
    1. stop the heartbeat, if `_currentLock` is this record;
    2. send `POST …/release`.
  - The handlers' own `if (_currentLock) { stopLockHeartbeat(); _currentLock = null; }` then does nothing more.
- **Lists.** `getLockInfo` and `isLockedByOther` keep reading `lock_user_id` and `lock_until` from records, so the lock indicators in lists keep working. The server returns those fields.
- **Lockable tables:** Customer, Supplier, Article, Inquiry, Quote, Order, SupplierOrder, DeliveryNote, Invoice.

## 10. Files

**`uploadFileToRecord(table, recordId, field, file)`**

- It keeps the 5 MB check and the FileReader base64 step.
- It sends `POST /api/data/:table/:id/files/:field {file, filename, contentType}`.
- It returns the updated record.
- It has six callers, which now pass their table:
  - `Company` for `logo`, `secondary_logo` and `sub_logo`, which are admin only;
  - `Attachment` for `file`, at three sites.

**Stored values**

- Attachment values have the shape `{id, url:'/api/files/<attId>/<name>', filename, size, type}`.
- `<img src>`, links and `fetch(url)` work same-origin with the cookie.
- `index.html` never reads Airtable `thumbnails` and never writes attachments by URL, so nothing else changes.
- Removing a logo keeps working unchanged: it sends `updateData('Company', id, {logo: []})`.

**`_downloadAttachmentAsBase64`** tries the direct URL first, then `/api/attachment-proxy?url=…`. That second request goes through `_api`'s base, with no Bearer header.

## 11. Settings, admin and upstream proxies

**Settings**

- **`loadSettings()`** calls `GET /api/settings` and copies these keys into `APP_KEYS`:
  - `freshdeskSalesGroupId`, `freshdeskOrderGroupId`, `freshdeskTicketTypes`, `freshdeskDomain`, `freshsalesSubdomain`;
  - Every value is plain text, as it was in the Master base. For example, `freshdeskTicketTypes` is a comma-separated list.
- **`saveSetting(key, value)`** calls `PUT /api/settings/:key {value}`; an empty value deletes the key. It then applies the returned settings.
  - It is used by `saveSalesGroupId`, `saveOrderGroupId`, `saveTicketTypes`, `saveFreshdeskDomain` and `saveFreshsalesSetup`.
  - `saveFreshsalesSetup` saves the subdomain only. The Freshsales API key is a Railway variable, and the settings page says so.
- The Freshdesk email inbox settings stay in localStorage, as today.

**Admin: users**

- The list reads `has_api_key`, `has_freshdesk_key` and `freshdesk_company_keys` for its badges.
- **Login-Key field**
  - For a new user it is prefilled with a generated key of 24 characters `a-z0-9`, and it is required.
  - For an existing user it is empty, with the hint "leer = unverändert", because the server cannot show a stored key. A "Neu" button fills in a generated key.
- **Save**
  1. It sends `writeData` or `updateData('User', …)` with the non-secret fields: `name`, `role`, `status`, `is_admin`, `allowed_companies`, and `created` for new users.
  2. It then sends `PATCH /api/admin/users/:id/secrets` with whichever of these changed:
     - `api_key` (at least 12 characters; a 409 `KEY_IN_USE` is shown as an error);
     - `freshdesk_api_key`;
     - `freshdesk_keys` (`{companyId: key | null}`), where the existing `__CLEAR__` marker maps to `null`.
- **Revoke sessions:** "Alle Sitzungen abmelden" sends `POST /api/sessions/revoke-user {user_id}`.

**Admin: companies and Mailchimp**

- `_mcSaveCompany` sends `updateData('Company', id, {mailchimp_server_prefix, mailchimp_list_id, mailchimp_list_name})`.
- When a key was entered, it also sends `PATCH /api/admin/companies/:id/secrets {mailchimp_api_key}`.
- The settings page counts configured companies by `has_mailchimp_key`.

**Upstream proxies**

- `proxyFetch(path, opts)` becomes `_api(opts.method || 'GET', '/' + path, …)`. The paths stay as they are:
  - `freshdesk/api/v2/…`
  - `freshsales/api/…`
  - `mailchimp/3.0/…`
  - `anthropic/v1/messages`
  - `attachment-proxy?url=…`
- It keeps adding `X-Company-Id` for `freshdesk/` paths. It no longer sends a Bearer header.
- `mailchimpFetch(path, opts, mandantId)` requires `has_mailchimp_key` and sends `X-Company-Id: mandantId`, without key headers.
- The settings page's "Verbindung testen" and "Audiences laden" also send `X-Company-Id`. When the admin typed a key or server that isn't saved yet, they pass it in `x-mailchimp-key` and `x-mailchimp-server`, which the server allows for admins.
- A Freshdesk `401` from the upstream reaches the caller as a normal error (for example "Proxy 401: …"). It is not a session expiry.

**Admin settings page ("Einstellungen")**

- **Kept:**
  - the connection test: `proxyFetch('health')` now reaches `GET /api/health`, which returns the same shape as the old proxy's `/health`;
  - Freshdesk groups, ticket types, domain and email inbox;
  - Mailchimp per Mandant;
  - the Freshsales subdomain and custom fields.
- **Removed:**
  - Val.town steps 1–4 and the diagram;
  - the "Schnell-Setup";
  - the Master-base keys block;
  - `#valtownCodeBlock`;
  - `VALTOWN_PROXY_CODE`;
  - `_valtownEnvVars`, `_fetchMasterBaseKeys`, `_writeMasterBaseKey`, `_deleteMasterBaseKey`, `_applyKeyToAppState` and the setup wizard state.
- `_maskSecret` stays.
- The title becomes "Einstellungen". Texts that pointed to Val.town environment variables now point to Railway variables (`FRESHDESK_API_KEY`, `FRESHSALES_API_KEY`, `ANTHROPIC_API_KEY`).

## 12. Other files and texts

**`sw.js` v2**

- `SW_VERSION = 'erp-hero-sw-v2'`.
- The fetch handler returns early, without `respondWith`, for any path under `/api/` and for `/healthz`. API responses and files are therefore never cached.
- Activation deletes the v1 cache.

**`loader.html` and `loader-admin.html`**

- Each becomes a small page that removes the `app_cache_*` keys from localStorage and runs `location.replace('https://erp-hero-production.up.railway.app/')`.
- Each shows a plain link as fallback.
- On Railway they are already redirected to `/`.

**GitHub Pages guard.** The first script in `index.html` does `location.replace(<Railway URL>)` when `location.hostname` ends in `github.io`. That covers direct visits and the old loader, which writes the fetched HTML into a github.io page.

**`forceAppUpdate()`**

1. It clears the `app_cache_*` and `cache_*` localStorage keys, as today, and the Cache Storage entries.
2. It then runs `location.replace('/?t=' + Date.now())`.

**UI texts**

- **Welcome status tiles:**
  - "Server · verbunden";
  - "Schreibrechte · aktiv" for any logged-in user;
  - "KI · über Server".
- The roadmap card says "Auth via Server" instead of "Auth via Airtable".
- **AI-costs page:** if loading `AiUsageLog` fails, it shows the error. The "create the table in the Airtable base" help and `_createAiUsageLogTableManually` go away.

**Version.** `APP_VERSION = 'v6.0'`.

## 13. Secret hygiene during the change

- The first implementation step deletes the `_TKP1` / `_TKP2` lines and every `AIRTABLE_READ_KEY` use. A small script does it and verifies by counts only (number of lines removed; zero remaining matches), and it never prints the lines.
- No step may print, copy or use the embedded token.
- The token stays in git history. The user should revoke it in Airtable; they already plan to revoke the old keys.
- The static guard test (§14) fails if an Airtable token pattern (`pat` followed by 14 alphanumerics, a dot, and 64 hex characters) ever appears in `index.html` again.

## 14. Testing

**Static guard** (in the normal `npm test` suite, `test/frontend/guard.test.ts`)

- `index.html` contains none of:
  - `api.airtable.com`, `content.airtable.com`;
  - `val.town`, `val.run`, `esm.town`;
  - `_TKP`, `AIRTABLE_READ_KEY`, `airtableWriteKey`, `VALTOWN_PROXY_CODE`, `sessionToken`;
  - the token pattern.
- `sw.js` bypasses `/api/`.

**End-to-end suite** (`npm run test:e2e`, with `vitest.e2e.config.ts`, files `test/e2e/**/*.e2e.ts`)

- **Browser and dependency:**
  - It uses `playwright-core`, pinned to 1.56.1 as a devDependency. That version matches the Chromium preinstalled at `/opt/pw-browsers`. It has no install script and never downloads a browser.
  - `CHROMIUM_PATH` overrides the executable.
- **Harness** (`test/e2e/harness.ts`)
  - It starts `@hono/node-server` on `127.0.0.1:0`. The handler is attached only after the port is known, so `PUBLIC_ORIGIN` matches exactly.
  - It builds the app with `createApp` and `buildDeps`, reusing `test/helpers`: `testEnv`, a temp data dir, the real clock, and `FakeFetch` for every upstream call.
  - It seeds the data: an admin, a normal user, and two companies, where one user has a Freshdesk key for one company.
  - It opens one browser per file and a fresh context per test.
  - Service workers are blocked, except in the service worker test.
- **Network rules in the page**
  - Requests to the harness origin go through.
  - `cdn.tailwindcss.com` gets a stub that defines `.hidden{display:none!important}`, plus any other visibility class a scenario needs, such as `invisible`.
  - `unpkg.com` (lucide) gets a stub with `createIcons()` as a no-op.
  - Google Fonts, jsdelivr and cdnjs are aborted, because their libraries load lazily for editors and PDFs.
  - Any request to an Airtable, Val.town, Freshdesk, Freshworks, Mailchimp or Anthropic host is aborted **and recorded**. Every test asserts that the record is empty.
- **Scenarios**
  - UI-driven where the flow is short, and through `page.evaluate` for data-layer contracts:
    1. Login with a valid key: the app shell is shown. Login with a wrong key: the server message is shown.
    2. Auto-login after a reload. Logout returns to the login screen, and `/api/me` is 401.
    3. Creating a customer through the UI stores `customer_no` `K-1001` and `company_id`.
    4. Number recovery: after a peek, another save takes the number. `writeData` stores the next number and shows the warning toast.
    5. Locks: opening a customer takes the lock, closing releases it, saving releases it (the shim), and a record locked by the other user shows that user's name.
    6. Freshdesk through the proxy: `freshdeskFetch` sends `X-Company-Id`, and `FakeFetch` sees that company's key.
    7. AI call: `proxyFetch('anthropic/v1/messages', …)` reaches `FakeFetch` with the server's key.
    8. Admin creates a user with a generated key. That key logs in, in a fresh context.
    9. Admin saves the Freshdesk domain setting, and it is still there after a reload.
    10. Admin uploads a company logo; its `/api/files/...` URL serves the image.
    11. Admin saves a Mailchimp key for a company: `has_mailchimp_key` becomes true, and ping reaches `FakeFetch` with that key.
    12. Session expiry: the session is revoked on the server, the next `readData` opens the overlay, entering the key resolves the original call, and the form contents stay.
    13. With the service worker enabled, after API calls, Cache Storage holds no `/api/` URL.
- **TDD.** Each behaviour change starts with its failing scenario or guard assertion, then the code.

**Manual check on Railway after deploy:** log in, create a Mandant and a customer, open and close it, and reload.

## 15. Deployment and test login on Railway

1. Run `railway up` from the branch, with the user-provided Railway token passed through the environment and never written to disk. Then check `/healthz` and the served `APP_VERSION`.
2. First login. There are two ways:
   - **Fresh database:** `railway ssh` and then `npm run user:create -- --name "<name>" --admin`, which prints the login key once. If the provided token cannot open `railway ssh`, the user runs this one command, and DEPLOY.md shows how.
   - **Existing users and data:** the read-only import (DEPLOY.md §9). The user sets their own Airtable read token as a Railway variable, runs `npm run import:airtable`, and restarts. Existing login keys then work, because the import hashes them. The import never writes to Airtable.
3. **DEPLOY.md:**
   - §8, smoke test: log in through the browser, create a Mandant and a customer.
   - §9, cutover: the frontend is switched, the loaders redirect, and GitHub Pages is no longer needed.
   - A new note: revoke the old Airtable token and the Val.town keys.
4. `README.md`: the e2e suite, how to run it, and the `CHROMIUM_PATH` override.

## 16. Error handling summary

| Situation | What the user sees |
|---|---|
| Server unreachable | "Server nicht erreichbar – bitte Verbindung prüfen", with the operation's prefix |
| Session expired | The re-login overlay. After it, the original action completes. "Abbrechen" gives "Sitzung abgelaufen". |
| Wrong key or inactive account at login | "Ungültiger Login-Key oder Account inaktiv" |
| Too many login attempts | The server's rate-limit message |
| Admin-only action by a non-admin | "Nur für Admins" |
| Number taken meanwhile | The warning toast, and the record is saved with the new number |
| Number typed by hand already exists | "Schreiben fehlgeschlagen: Nummer bereits vergeben: X" |
| Record locked by someone else | The existing lock message, with the name from the server |
| Upstream key missing on the server | The server's `NOT_CONFIGURED` message, which names the Railway variable |
| Upstream error | "Proxy <status>: <upstream message>", as today |

## 17. Risks

- **Computed Airtable fields.** Formula, lookup and rollup fields are fixed values after an import and are not computed for new records. The plan includes an audit: fields that `index.html` reads but never writes, on tables where it creates records. An audit result that breaks a core flow gets a client-side fallback. The rest are listed as follow-ups.
- **More records.** The app now sees every record instead of the first 100 per table. Lists may grow; this is intended, but slower on large tables.
- **Numbers after a recovery.** Text built before the save keeps the peeked number (§8). This is rare, and the user is warned.
- **Token in git history.** It is removed from the file but not from history, so it must be revoked.
- **Single big file.** `index.html` is edited in many places. The static guard, the e2e suite and a review pass per task limit regressions. Areas without an e2e scenario (PDF, quotes UI, AI assistant) are covered by the manual check list in the final summary.
