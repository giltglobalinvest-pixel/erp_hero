# ERP Hero Backend: Design

Date: 2026-09-25 · Status: approved in brainstorming, awaiting written-spec review

## 1. Context

ERP Hero is the internal ERP (German UI) of FLP Lift Parts GmbH and its sister companies ("Mandanten").

**Today:**
- The app is one file, `index.html` (~34k lines of vanilla JS plus the Tailwind CDN).
- It is served by GitHub Pages and loaded through `loader.html` / `loader-admin.html`.
- Airtable is the database.
- A Val.town proxy handles login and the calls to third-party APIs.

**What the security review found:**
- A hard-coded Airtable token is readable by anyone.
- Before anyone logs in, that token loads the Airtable write key, the Anthropic key and the Val.town token into every visitor's browser.
- Every logged-in user receives every user's login key and Freshdesk keys.
- Admin checks exist only in the browser.
- Reads stop at 100 records. Document numbers are "max + 1" of that partial list, which can produce duplicate invoice numbers.

**This session builds a backend that:**
- replaces the Val.town proxy and all direct Airtable access;
- **moves the data from Airtable into SQLite**, a decision taken during brainstorming;
- includes the Railway deployment configuration.

The frontend switch to the new API is the **next** session. This session does not change `index.html`, `loader*.html`, `sw.js` or `main`.

**Users:** at most 5 people, all internal and trusted.

## 2. Decisions taken in brainstorming

| # | Decision | Reason |
|---|---|---|
| D1 | **SQLite replaces Airtable** as the database. Airtable is imported once at cutover and then kept untouched as an archive. | Nobody works in Airtable directly. SQLite gives real transactions and uniqueness, no 100-record pages, no 5-requests/second limit, and no Airtable tokens in the system. |
| D2 | **Local SQLite file on a Railway volume**, accessed with `@libsql/client`. | One provider, instant local queries, and files live on the same disk. Using `@libsql/client` means moving to Turso Cloud later is only a URL change. |
| D3 | **Single server instance** (a consequence of the volume). | Railway volumes allow neither replicas nor overlapping deploys. That makes in-process serialization airtight. The cost is a few seconds of downtime per deploy. |
| D4 | **Stack:** Node 22, TypeScript, Hono (`@hono/node-server`), zod, vitest, eslint. | Hono works on Web Request/Response, which makes raw upstream passthrough (multipart, 204) simple. `app.request()` allows in-process tests. |
| D5 | **One SQLite table per ERP table.** Each row is an Airtable-shaped record: `id`, `created_time`, `updated_time`, `fields` (JSON). | Keeps the API shapes identical, so the frontend switch is mechanical. Fields can be added at any time, as `ensureFields` expects. Tables are easy to inspect with any SQLite viewer. |
| D6 | **Login keys are stored only as scrypt hashes.** On login the key is checked against every active user. | ≤5 users, so scanning is trivial. A slow hash protects keys that admins type by hand. No plaintext keys in the new database. |
| D7 | **Document numbers are assigned when the record is saved** (`assignNumber: true`), inside a write transaction. A separate *peek* endpoint previews the next number without using it up. | No duplicates and no gaps. This matters for invoices. |
| D8 | **Company separation is a working context, not a security boundary.** Every logged-in user can read and write all companies' business records, as today. `allowed_companies` drives the Mandant switcher (in the UI) and the choice of Freshdesk key. | Cross-company features are core: the ticket tool creates customers for any Mandant, email and customer matches across companies, the article-number index, the statistics. |
| D9 | **No realtime.** | Not needed now. It is possible later via Server-Sent Events. |
| D10 | **Repo layout:** `package.json` at the root, backend code in `server/`, tests in `test/`. | The server serves the root `index.html` and `sw.js` unchanged. |

## 3. Scope

**In scope:**
- static serving;
- auth and sessions;
- the Airtable-shaped data API;
- document numbers, record locks, files, settings;
- the admin secret endpoints;
- the Freshdesk / Freshsales / Mailchimp / Anthropic routes and the attachment proxy;
- the error model, security headers and `/healthz`;
- the Airtable→SQLite importer and the `user:create` / `db:activate` CLIs;
- the backup download;
- `railway.json`, `.env.example`, `DEPLOY.md`;
- tests, typecheck and lint.

**Out of scope (later sessions):**
- all `index.html` changes (the frontend switch);
- the cutover itself;
- realtime;
- automated off-site backups;
- Turso Cloud;
- multi-instance operation;
- strict company isolation;
- cleaning up legacy duplicate numbers;
- a CSP without `'unsafe-inline'`;
- an audit log.

**Hard rules for this session:**
- No live calls to Airtable, Freshdesk, Freshsales, Mailchimp or Anthropic. Tests mock all upstream HTTP. A live run of the importer needs the user's explicit go-ahead and credentials.
- Never use the token embedded in `index.html`.
- No secrets in the repo: `.env.example` has placeholders only, and `.env` is in `.gitignore`.

## 4. Architecture

```
Browser (index.html, unchanged this session)
   │  same origin · session cookie
   ▼
Node server on Railway (Hono, single instance)
   ├─ static:  /  /index.html  /sw.js   (/loader*.html → 302 /)
   ├─ /api/auth /api/me /api/logout /api/sessions/revoke-user /api/health
   ├─ /api/data/:table[/:id]   records · /api/numbers · /api/locks · files
   ├─ /api/schema/*            ensureTable / ensureFields (no-ops)
   ├─ /api/settings            non-secret settings
   ├─ /api/admin/*             user & company secrets, backup
   ├─ /api/freshdesk/api/v2/*  /api/freshsales/api/*  /api/mailchimp/3.0/*
   ├─ /api/anthropic/v1/messages  /api/attachment-proxy
   └─ /healthz
        │
        ├─ $DATA_DIR/erp.db      SQLite (WAL): ERP tables + system tables
        └─ $DATA_DIR/files/…     uploaded / imported attachment files
```

**Keeping the frontend switch mechanical:**
- The third-party routes keep the proxy's path names under `/api`. The frontend's `proxyFetch` base becomes `/api`; the Bearer header is dropped and the cookie is used instead.
- The data routes keep Airtable's request and response shapes.

**Units, each with one purpose and testable on its own:**

| Unit | Responsibility | Depends on |
|---|---|---|
| `config` | Parse and validate env vars (zod). Fail fast on missing required values. | – |
| `db` | Open the libsql client, run migrations, provide write transactions. Writes are queued in-process, because libsql cannot hold two write transactions open at once. | config |
| `records` | CRUD on ERP tables, Airtable emulation (IDs, empty-value dropping), sort/filter. | db, tables |
| `tables` | Registry of the 30 tables: numbered field, lockable, attachment fields, permission class. | – |
| `numbers` | Assign and peek document numbers; duplicate check. | records |
| `locks` | Acquire / refresh / release record locks. | records |
| `files` | Store and serve attachment files; normalize attachment field values. | db, fs |
| `auth` | scrypt keys, sessions, login rate limit, auth middleware, CSRF/origin check. | db |
| `secrets` | AES-256-GCM encrypt/decrypt of third-party keys; user/company secret storage. | config, db |
| `settings` | Allowlisted non-secret settings. | db |
| `proxy/*` | Freshdesk, Freshsales, Mailchimp, Anthropic, attachment proxy. Endpoint allowlists, key selection, passthrough. | config, secrets, injected `fetch` |
| `http` | Error model, security headers, static files, body limits, request log. | config |
| `import` | Airtable→SQLite importer and its report. | injected `fetch`, db, files, secrets |
| `cli` | `user:create`, `db:activate`, `import:airtable` entry points. | above |

**Dependency injection:** all outbound HTTP goes through a `fetch` function passed in at app/importer construction. Production passes `globalThis.fetch`; tests pass fakes.

## 5. Storage

### 5.1 ERP tables (30)

`Customer, Contact, Article, Quote, QuoteItem, QuoteBundle, Order, OrderItem, Address, Supplier, Textemplate, Attachment, Layout, Invoice, InvoiceItem, ArticleSupplier, SupplierOrder, SupplierOrderItem, DeliveryNote, DeliveryNoteItem, CustomField, Inquiry, PaymentTerm, DeliveryTerm, AiUsageLog, AiQuoteChatLearning, Manufacturer, Category, Company, User`

Each table is created with the exact name, always quoted (e.g. `"Order"`):

```sql
CREATE TABLE "Invoice" (
  id           TEXT PRIMARY KEY,           -- 'rec' + 14 chars; imported records keep Airtable IDs
  created_time TEXT NOT NULL,              -- ISO 8601, returned as createdTime
  updated_time TEXT NOT NULL,
  fields       TEXT NOT NULL CHECK (json_valid(fields))
);
```

- Records never contain secrets. Secret values live only in the system tables below.
- Unknown table names are rejected everywhere (404 `NOT_FOUND`).

### 5.2 System tables

| Table | Columns | Purpose |
|---|---|---|
| `schema_migrations` | `version`, `applied_at` | Migration bookkeeping |
| `sessions` | `token_hash` (SHA-256 hex, PK), `user_id`, `created_at` and `expires_at` (epoch ms), `long_lived`, `user_agent` (≤200 chars) | Login sessions |
| `user_secrets` | `user_id` PK, `api_key_hash` (scrypt string), `freshdesk_api_key_enc`, `freshdesk_keys_enc` (JSON `{companyId: key}` encrypted) | Login and Freshdesk keys |
| `company_secrets` | `company_id` PK, `mailchimp_api_key_enc` | Mailchimp key per company |
| `settings` | `key` PK, `value`, `updated_at`, `updated_by` | Non-secret settings |
| `files` | `id` ('att' + 14, PK), `table_name`, `record_id`, `field`, `filename`, `content_type`, `size`, `sha256`, `path`, `created_at`, `created_by` | Attachment files |

### 5.3 SQLite settings

- `journal_mode=WAL`, `synchronous=FULL` (durability over speed), `busy_timeout=5000`, `foreign_keys=ON`.
- Migrations are versioned SQL, applied at startup inside a transaction.

## 6. Authentication and sessions

**Login: `POST /api/auth` with `{user_key, long_lived}`**
1. The key is trimmed. An empty key → 400.
2. The rate limit is checked (see below).
3. The key is verified against the `api_key_hash` of every User whose `fields.status === 'aktiv'`, with scrypt and `timingSafeEqual`. Every candidate is checked, with no early exit, to avoid timing leaks.
4. On success: a 32-byte random token (base64url) is created and its SHA-256 is stored in `sessions`. `expires_at` is now + 8 h, or + 30 d when `long_lived`.
5. The cookie is set:
   - production: `__Host-erp_session=<token>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=…` (Max-Age only when `long_lived`, otherwise a session cookie);
   - development: `erp_session` without `Secure`.
6. Response 200:

   ```json
   { "expires_in": 28800,
     "user": { "id": "rec…", "name": "…", "role": "…", "is_admin": false,
               "allowed_companies": ["rec…"], "has_freshdesk_key": true,
               "freshdesk_company_keys": ["rec…"] } }
   ```

   This is the same shape as the proxy's, minus `session_token`. `freshdesk_company_keys` is always an array, because the frontend's `proxyV2` feature flag depends on it.
7. A failure → 401 `{error:{type:"UNAUTHENTICATED", message:"Ungültiger Login-Key oder Account inaktiv"}}`.

**scrypt format:** `scrypt$N$r$p$<salt b64>$<hash b64>` with N=16384, r=8, p=1, a 16-byte salt and a 64-byte hash.

**Rate limit (in memory):**
- 5 failed attempts per client IP within 15 minutes → 429 `RATE_LIMITED` until the window passes.
- Additionally, 30 failed attempts in total within 15 minutes → 429 for everyone.
- Successful logins don't count.
- Client IP: the right-most `X-Forwarded-For` entry, which Railway's edge appends. If that header is missing, the socket address is used.

**Every authenticated request:**
- Cookie → SHA-256 → session row.
- If the session is missing or expired → 401, and the cookie is cleared.
- The User record is loaded fresh on every request. If the user is inactive, the session is deleted → 401.
- `c.var.user` = `{id, name, role, is_admin, allowed_companies, status}`. Changes to status, admin flag or companies take effect on the next request.
- There is no Bearer or raw-key fallback. The raw key is accepted only by `POST /api/auth`.

**Other routes:**
- `GET /api/me` → `{user:{…same as login…}}`.
- `POST /api/logout` → deletes the session and clears the cookie → `{ok:true}`. It is idempotent: without a session it still returns 200.
- `POST /api/sessions/revoke-user` with `{user_id}`, admin only → deletes all of that user's sessions → `{revoked:n}`.
- `GET /api/health` → `{ok:true, auth_kind:"session", user:{name, is_admin, has_freshdesk_key, freshdesk_company_keys}}`, same shape as the proxy's.
- Expired sessions are purged at startup and every hour.

**CSRF / origin check** for every unsafe method (`POST/PUT/PATCH/DELETE`), login included:
- Allowed: `Origin` equals `PUBLIC_ORIGIN`, or `Origin` is absent and `Sec-Fetch-Site` is `same-origin`.
- Otherwise → 403 `FORBIDDEN`.
- `navigator.sendBeacon` / `keepalive` requests send `Origin`, so they pass.

## 7. Data API

### 7.1 Endpoints and frontend mapping

| Frontend today | Endpoint | Response |
|---|---|---|
| `readData(table, filter?, {sort, maxRecords})` | `GET /api/data/:table` | `{records:[{id, createdTime, fields}]}`, **all** matching records |
| `readData(t).find(r => r.id === id)` | `GET /api/data/:table/:id` (new) | `{id, createdTime, fields}` or 404 |
| `writeData(table, fields)` | `POST /api/data/:table` `{fields, assignNumber?, variantOf?}` | the created record |
| `updateData(table, id, fields)` | `PATCH /api/data/:table/:id` `{fields}` | the updated record |
| `deleteData(table, id)` | `DELETE /api/data/:table/:id` | `{id, deleted:true}` |
| `ensureTable` / `ensureFields` | `POST /api/schema/ensure-table` `{name, fields}` / `POST /api/schema/ensure-fields` `{table, fields}` | `{ok:true}` for known tables (no-op). An unknown table → 404. |
| `next*No(companyId)` | `POST /api/data/:table` with `assignNumber: true` (section 8) · preview: `GET /api/numbers/:type/next?company=…[&base=Q-1024]` | record · `{number}` |
| `acquireLock` / heartbeat / `releaseLock` / unload PATCH | `POST /api/locks/:table/:id` · `…/refresh` · `…/release` | section 9 |
| `uploadFileToRecord(recordId, field, file)` | `POST /api/data/:table/:id/files/:field` (the table is now explicit) | section 10 |
| `_fetchMasterBaseKeys` / `_writeMasterBaseKey` / `_deleteMasterBaseKey` / `loadProjectKeys` | `GET /api/settings` · `PUT /api/settings/:key` · `DELETE /api/settings/:key` | section 11 |

**List query parameters:**
- `sort[i][field]` and `sort[i][direction]` (`asc`|`desc`), with Airtable's syntax.
  - Numbers compare numerically.
  - Strings compare with `Intl.Collator('de', {sensitivity:'base'})`.
  - Empty values sort last.
  - Default order: `created_time`, then `id`.
- `maxRecords`.
- `fields[]`, which returns only the listed fields.
- `filterByFormula` in a **restricted** form only: `{field}='value'` or `AND({a}='x',{b}='y')`, with Airtable's quote escaping.
  - For array fields the condition means "contains".
  - Anything else → 400 `INVALID_REQUEST` "Formel nicht unterstützt".
  - This covers the only formula the app uses (`{status}='aktiv'`).

### 7.2 Airtable emulation (field normalization on write)

- **The body is `{fields: {...}}`.** Keys must be non-empty strings of at most 200 chars.
- **Empty values are dropped:** `null`, `''`, `false` and `[]` are removed from the stored record, as Airtable omits them. A PATCH that sends such a value clears the field. `0` and `'0'` are kept.
- **PATCH merges.** Only the fields sent change.
- **Silently ignored on write:**
  - `lock_user_id` / `lock_until` (only the lock endpoints set them);
  - derived read-only fields (`has_freshdesk_key`, `freshdesk_company_keys`, `has_api_key`, `has_mailchimp_key`).
- **Rejected on write** with 400 `INVALID_REQUEST` "Geheime Felder nur über Admin-Funktion":
  - `api_key`, `freshdesk_api_key`, `freshdesk_keys_json`, `mailchimp_api_key`;
  - any field name matching `/(^|_)(api_?key|token|secret|password)$/i`. The pattern is anchored at the end on purpose, so `AiUsageLog.input_tokens` / `output_tokens` / `cache_*_tokens` are **not** affected.
- **Attachment fields** (registry: `Company.logo`, `Company.secondary_logo`, `Company.sub_logo`, `Attachment.file`):
  - A written value must be an array of `{id}` objects referring to existing `files` rows for the same table, record and field.
  - The server replaces each entry with the stored metadata.
  - Unknown IDs → 422 `VALIDATION_FAILED`.
- **Request body limit:** 5 MB on data routes.

### 7.3 Response filtering (secrets never leave the server)

Every record passes through `toPublicRecord(table, record, user)`:
1. Remove every field whose name matches the secret pattern above. This is a safety net, since stored records contain no secrets anyway.
2. `User`:
   - **Admins** get all fields plus derived `has_api_key`, `has_freshdesk_key` and `freshdesk_company_keys` (company IDs with a stored key).
   - **Non-admins** get only `{name}`, which is all the lock labels need.
3. `Company`: everyone gets all fields plus derived `has_mailchimp_key`.

### 7.4 Permissions

| Table | Read | Create / Update / Delete |
|---|---|---|
| Business tables (all except the three below) | any logged-in user | any logged-in user |
| `Company` | any logged-in user | admin |
| `User` | admin: full (minus secrets); others: `name` only | admin |
| `AiUsageLog` | admin | create: any user · update/delete: admin |

- Settings, admin endpoints and session revocation are admin-only.
- A non-admin writing an admin-only table → 403 "Nur für Admins".

## 8. Document numbers

| `type` | Table | Field | Format | First number |
|---|---|---|---|---|
| `customer` | Customer | `customer_no` | `K-<n>` | 1001 |
| `supplier` | Supplier | `supplier_no` | `L-<n>` | 1001 |
| `article` | Article | `article_no` | `A-<n>` | 10001 |
| `inquiry` | Inquiry | `inquiry_no` | `AN-<n>` | 1001 |
| `quote` | Quote | `quote_no` | `Q-<n>` (variants `Q-<n>.<v>`) | 1001 |
| `order` | Order | `order_no` | `AB-<n>` | 1001 |
| `purchase` | SupplierOrder | `purchase_no` | `B-<n>` | 1001 |
| `delivery` | DeliveryNote | `delivery_no` | `L-<n>` | 1001 |
| `invoice` | Invoice | `invoice_no` | `R-<n>` | 1001 |

**Company matching:**
- A record belongs to company `C` if `fields.company_id` equals `C` (string) or contains `C` (array). Both forms exist in the data.
- In SQL: `EXISTS (SELECT 1 FROM json_each(fields,'$.company_id') WHERE value = ?)`. This also covers plain strings.

**Assignment on create (`assignNumber: true`)**, all inside one write transaction together with the insert:
1. The table must be numbered, and `fields.company_id` must identify a company (the first ID if it is an array); otherwise 400.
2. `n = max(floor, highest N among the company's records whose field matches ^PREFIX(\d+)$) + 1`, where floor is 1000 or 10000.
3. The field is set and the record inserted. A client-supplied value for the numbered field is overwritten.

**Variants** (`variantOf: "Q-1024"` or `"Q-1024.2"`, Quote only):
- The base `Q-1024` is extracted.
- Result: `Q-1024.<max existing variant for base in company + 1>`.

**Peek:** `GET /api/numbers/:type/next?company=<id>[&base=Q-1024]` → `{number}`. Nothing is written.

**Duplicate guard:**
- On create or update, if the numbered field is present and differs from the stored value, and another record of the same table and company already has that value → 409 `DUPLICATE_NUMBER` "Nummer bereits vergeben".
- Existing legacy duplicates stay untouched unless the number is changed.

**Why it's race-free:** the server queues all write transactions in-process, and there is a single process (D3). The highest existing number is read inside the same write transaction as the insert, so no other write can happen in between. A test creates 20 invoices concurrently and expects 20 distinct consecutive numbers.

## 9. Record locks

**Lockable tables:** Customer, Supplier, Article, Inquiry, Quote, Order, SupplierOrder, DeliveryNote, Invoice. Others → 400.

- `POST /api/locks/:table/:id`:
  - If the record has `lock_user_id`, `lock_until > now` and the holder isn't the caller → 200 `{ok:false, locked_by:{id, name}, until}`.
  - Otherwise it sets `lock_user_id = session user` and `lock_until = now + 5 min` → 200 `{ok:true, until}`.
- `POST …/refresh`: extends by 5 minutes if the caller holds the lock or it has expired; otherwise `{ok:false, locked_by, until}`.
- `POST …/release`: clears both fields if the caller holds the lock or it has expired. It is idempotent and always returns `{ok:true}`. It accepts an empty or `text/plain` body, so `navigator.sendBeacon` works.
- Every lock operation runs in a write transaction, so there are no races.
- Locks stay **advisory**, as today: normal saves are not blocked. The lock fields stay visible in record `fields`, so `getLockInfo()` keeps working.

## 10. Files

**Upload: `POST /api/data/:table/:id/files/:field`** with `{contentType, file (base64), filename}`, the same body as Airtable's `uploadAttachment`.
- The decoded file must be ≤ 5 MB; otherwise 413. The request body limit is 7 MB.
- Allowed combinations: `Company.{logo,secondary_logo,sub_logo}` (admin) and `Attachment.file` (any user).
- The file is stored at `$DATA_DIR/files/<attId>/<sanitized filename>`, with a `files` row.
- `{id, url:"/api/files/<attId>/<urlencoded filename>", filename, size, type}` is appended to the field.
- The response is the updated record (`{id, createdTime, fields}`).

**Download: `GET /api/files/:attId/:filename`**
- Login required. Unknown ID → 404.
- `Content-Type` comes from the DB, plus `X-Content-Type-Options: nosniff`.
- `Content-Disposition`: `inline` for images and PDFs, `attachment` otherwise.
- `Cache-Control: private, max-age=300`.

**Removal:**
- The frontend PATCHes the field with the remaining `{id}`s, as today.
- Removed files stay on disk (no data loss by mistake).

## 11. Settings

**Allowed keys** (all non-secret):
- `freshdeskSalesGroupId`
- `freshdeskOrderGroupId`
- `freshdeskTicketTypes`
- `freshdeskDomain` (used for UI deep links; the API domain comes from env `FRESHDESK_DOMAIN`)
- `freshsalesSubdomain`

**Endpoints:**
- `GET /api/settings` → `{settings:{key:value}}` for any logged-in user.
- `PUT /api/settings/:key` with `{value}` and `DELETE /api/settings/:key` are admin-only. An unknown key → 400.
- An empty `value` deletes the setting.
- Both return the full `{settings}` map.

**Where the rest of the old Keys data goes:**
- Secrets move to Railway variables: `anthropicKey` → `ANTHROPIC_API_KEY`, `freshdeskProxyToken` (unused) and the Freshsales key. `airtableWriteKey` and `valtownKey` are dropped.
- Legacy keys (`apiProxyUrl`, `freshdeskProxyUrl`, `valtownValId`, `airtableBaseId`) are not imported.

## 12. Admin endpoints

**`PATCH /api/admin/users/:id/secrets`** with `{api_key?, generate_api_key?, freshdesk_api_key?, freshdesk_keys?}`:
- `generate_api_key: true` creates 24 characters `[a-z0-9]` with an unbiased random generator and returns it **once** as `api_key`.
- `api_key: "<string>"` sets a manual key of at least 12 chars. It is not echoed back.
- `api_key: null` removes the key.
- If the new key already matches another user's key → 409 `KEY_IN_USE`.
- `freshdesk_api_key: string | null` sets or clears the default key.
- `freshdesk_keys: {companyId: string | null}` is merged on the server; `null` clears that company.
- Response: `{api_key?, has_api_key, has_freshdesk_key, freshdesk_company_keys}`.

**`PATCH /api/admin/companies/:id/secrets`** with `{mailchimp_api_key: string | null}` → `{has_mailchimp_key}`.

**`GET /api/admin/backup`**
- Streams `erp-backup-<timestamp>.tar.gz`, containing:
  - a consistent DB snapshot (`VACUUM INTO` a temp file);
  - the `files/` directory;
  - `manifest.json` (time and record counts).
- The encrypted secrets stay encrypted. Restoring them needs the same `SECRETS_KEY`.

**Encryption:**
- Third-party keys are encrypted with AES-256-GCM and a random 12-byte IV per value. Stored as `v1:<iv b64>:<ciphertext b64>:<tag b64>`.
- The key comes from `SECRETS_KEY` (32 bytes, base64).
- If `SECRETS_KEY` is lost, the stored keys are unrecoverable. Admins then re-enter them, and login keys are unaffected.

## 13. Third-party routes

**Common behaviour:**
- Login is required.
- The upstream status and body are passed through unchanged, with the upstream `Content-Type`. The frontend regex-matches raw Freshdesk and Freshsales error bodies (`one of these values`, `409 duplicate`, `company_id`), so these must stay raw.
- 204 and 205 responses have no body and no JSON content type.
- **Not forwarded upstream:** client cookies, `Authorization`, and all headers except `Content-Type` and `Accept`.
- **Upstream timeouts:** 60 s, or 300 s for Anthropic.
- **Network error or timeout** → 502 `UPSTREAM_UNAVAILABLE` / 504 `UPSTREAM_TIMEOUT`, with a German message and no internal detail.
- **Missing configuration** → 500 `NOT_CONFIGURED`, with a message naming the env var (e.g. "FRESHDESK_API_KEY fehlt"), because the frontend matches those names.
- A call that isn't on the allowlist → 403 `FORBIDDEN` "Endpoint nicht freigegeben".

### 13.1 Freshdesk: `ANY /api/freshdesk/api/v2/*`

- **Target:** `https://<FRESHDESK_DOMAIN>.freshdesk.com/api/v2/<path><query>`.
- **Auth:** Basic `<key>:X`.
- **Key selection:**
  1. `X-Company-Id` header is present, the company is in the user's `allowed_companies` (or the user is admin), and a per-company key is stored → that key;
  2. the user's default key;
  3. env `FRESHDESK_API_KEY`;
  4. none → 500 `NOT_CONFIGURED`.
- **Multipart** (`multipart/form-data`): the body is passed through as bytes, with the client's `Content-Type` (boundary) and a 25 MB limit. JSON bodies are limited to 5 MB, because note and reply HTML can contain pasted images.
- **Allowlist** (`{id}` = digits):

| Method | Path |
|---|---|
| GET | `tickets/{id}` |
| PUT | `tickets/{id}` |
| POST | `tickets` |
| POST | `tickets/outbound_email` |
| GET | `tickets/{id}/conversations` |
| POST | `tickets/{id}/notes` |
| POST | `tickets/{id}/forward` |
| GET | `search/tickets` |
| GET | `agents` |
| GET | `contacts` |
| POST | `contacts` |
| GET | `contacts/{id}` |
| PUT | `contacts/{id}` |
| GET | `contacts/{id}/tickets` |
| GET | `companies/{id}` |
| PUT | `companies/{id}` |
| POST | `companies` |
| GET | `companies/autocomplete` |
| GET | `search/companies` |
| GET | `canned_response_folders` |
| GET | `canned_response_folders/{id}/responses` |
| GET | `conversations/{id}` |
| PUT | `conversations/{id}` |
| DELETE | `conversations/{id}` |
| GET | `groups` |
| GET | `email_configs` |
| GET | `ticket_fields` |

### 13.2 Freshsales: `ANY /api/freshsales/api/*`

- **Target:** `https://<FRESHSALES_SUBDOMAIN>.freshworks.com/crm/sales/api/<path><query>`.
- **Auth:** `Token token=<FRESHSALES_API_KEY>`.
- **Body:** JSON, 1 MB limit.
- **Allowlist:**

| Method | Path |
|---|---|
| GET | `sales_accounts/{id}` |
| PUT | `sales_accounts/{id}` |
| POST | `sales_accounts` |
| POST | `sales_accounts/{id}/contacts` |
| GET | `contacts/{id}` |
| PUT | `contacts/{id}` |
| POST | `contacts` |
| POST | `contacts/{id}/sales_accounts` |
| GET | `lookup` |
| GET | `search` |
| POST | `notes` |

### 13.3 Mailchimp: `GET /api/mailchimp/3.0/*`

- **Allowlist:** `GET ping`, `GET lists`.
- **The company comes from the `X-Company-Id` header**, which is required.
  - The server uses that company's stored key and `fields.mailchimp_server_prefix`.
  - If the prefix is empty, it is taken from the key suffix `-usNN`.
- **Admins only:** they may instead send `x-mailchimp-key` / `x-mailchimp-server` to test values before saving them. Non-admins sending these headers → 403.
- **Validation:** the server prefix must match `^[a-z]{2,3}\d{1,2}$`; otherwise 400.
- **Target:** `https://<server>.api.mailchimp.com/3.0/<path><query>`.
- **Auth:** Basic `anystring:<key>`.

### 13.4 Anthropic: `POST /api/anthropic/v1/messages`

- The body is passed through (32 MB limit, which is Anthropic's own request limit).
- **Headers sent upstream:** `x-api-key: ANTHROPIC_API_KEY`, `anthropic-version: 2023-06-01`, `content-type: application/json`.
- The response is passed through.
- Only POST; other methods → 405.

### 13.5 Attachment proxy: `GET /api/attachment-proxy?url=…`

- **The URL must be `https:`** and match the allowlist on the exact host, plus an optional path prefix.
- **Default allowlist** (overridable via `ATTACHMENT_PROXY_ALLOW`, a comma-separated list of `host` or `host/pathprefix`):
  - `<FRESHDESK_DOMAIN>.freshdesk.com`
  - `<FRESHDESK_DOMAIN>.attachments.freshdesk.com`
  - `attachment.freshdesk.com`
  - `attachment.freshdeskusercontent.com`
  - `s3.amazonaws.com/cdn.freshdesk.com/`
  - `s3.eu-central-1.amazonaws.com/euc-cdn.freshdesk.com/`
- **Redirects** are followed manually, at most 3, and each hop is re-validated.
- **No credentials** are sent.
- **Size:** at most 5 MB, enforced while streaming; larger → 413.
- **Response:** the upstream `Content-Type`, `Cache-Control: private, max-age=300`.
- Upstream non-2xx → the same status with `{error:{type:"UPSTREAM_ERROR", message:"Upstream <status>"}}`.
- **The default list must be verified against one real attachment URL** at the first deploy test (open item, section 20).

## 14. Errors and logging

**Error body** for our own errors: `{error:{type, message}}`, with German messages.
- The frontend's `proxyFetch` reads `j.error.message || j.error`, so both shapes work.

| Type | Status |
|---|---|
| `INVALID_REQUEST` | 400 |
| `UNAUTHENTICATED` | 401 |
| `FORBIDDEN` | 403 |
| `NOT_FOUND` | 404 |
| `METHOD_NOT_ALLOWED` | 405 |
| `DUPLICATE_NUMBER`, `KEY_IN_USE` | 409 |
| `PAYLOAD_TOO_LARGE` | 413 |
| `VALIDATION_FAILED` | 422 |
| `RATE_LIMITED` | 429 |
| `NOT_CONFIGURED`, `INTERNAL` | 500 |
| `UPSTREAM_ERROR` | the upstream status (attachment proxy) |
| `UPSTREAM_UNAVAILABLE` | 502 |
| `UPSTREAM_TIMEOUT` | 504 |

- `INTERNAL` returns "Interner Fehler (Referenz <requestId>)" and never a stack trace.
- Every response carries an `X-Request-Id` header.

**Logging:** one JSON line per request to stdout: `time, requestId, method, path` (without query string), `status, durationMs, userId`.
- Errors are logged with the stack trace, server-side only.
- Bodies, cookies, `Authorization` headers and keys are never logged.

## 15. Security headers and static serving

**Headers on every response:**
- `Content-Security-Policy`:

  ```
  default-src 'self';
  script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://unpkg.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com;
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net;
  font-src 'self' data: https://fonts.gstatic.com;
  img-src 'self' data: blob: https:;
  connect-src 'self' <attachment hosts>;
  frame-src 'self' blob: <attachment hosts>;
  worker-src 'self'; manifest-src 'self' data:;
  object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
  ```

  `'unsafe-inline'` for scripts is required because `index.html` has about 560 inline event handlers. Tightening it is a later task. The CSP is verified by loading the served page in headless Chromium and checking for violations; the Airtable and Val.town calls it blocks are expected.
- `Strict-Transport-Security: max-age=31536000` (production only).
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`.
- `Permissions-Policy: microphone=(self), camera=(), geolocation=(), payment=()`. The microphone is used by the dictation feature.
- `Cross-Origin-Opener-Policy: same-origin`.
- `/api/*` additionally: `Cache-Control: no-store`.

**Static routes:**

| Route | Response |
|---|---|
| `GET` / `HEAD` `/` and `/index.html` | `index.html` bytes unchanged, `text/html; charset=utf-8`, `Cache-Control: no-cache`, with an ETag |
| `/sw.js` | `application/javascript; charset=utf-8`, `no-cache` |
| `/loader.html`, `/loader-admin.html` | 302 → `/` (the app's "load newest version" button points to `loader.html`) |
| `GET /healthz` | 200 `{ok:true}` when `SELECT 1` succeeds, else 503. No auth, no upstream calls. |
| anything else | 404 |

**Until the next session's frontend switch, the page served by this server is intentionally non-functional.** It still calls Airtable and Val.town directly, and the CSP blocks both. The GitHub Pages app stays in use until cutover.

## 16. Airtable → SQLite importer

**Invocation:** `npm run import:airtable [-- --staging <dir>]`, e.g. in the Railway shell via `railway ssh`. Without `--staging`, the target is `$DATA_DIR/import-<timestamp>`.
- It writes `<dir>/erp.db`, `<dir>/files/` and `<dir>/import-report.json`.
- It refuses to run if `<dir>` already exists.
- **Env:** `AIRTABLE_TOKEN` (read-only scopes: `data.records:read` and `schema.bases:read` on both bases), `AIRTABLE_BASE_ID`, `AIRTABLE_MASTER_BASE_ID`, `ERP_PROJECT_ID`, `SECRETS_KEY`.
- **It only ever uses GET.**

**Steps:**
1. Read the App base schema (Meta API). This lists tables and fields and classifies computed fields: `formula, rollup, multipleLookupValues, count, autoNumber, createdTime, lastModifiedTime, createdBy, lastModifiedBy, button, aiText`.
2. For each of the 30 known tables, read all records, following `offset`, at ≤ 5 requests/second per base. On 429, wait 30 s and retry, at most 3 times.
3. Insert the records with their original IDs and `createdTime`.
   - Computed-field values are copied as fixed values.
   - Secret fields are moved out of `fields`:
     - `User.api_key` → scrypt hash;
     - `freshdesk_api_key` and `freshdesk_keys_json` → encrypted (malformed JSON is reported and skipped);
     - `Company.mailchimp_api_key` → encrypted.
4. Download every attachment of every field of type `multipleAttachments`, while its URLs are still valid (≥ 2 h, per Airtable). Files are stored with their Airtable IDs, and field values are rewritten to our format.
5. Read the Master base `Keys` rows with `{project_id}='<ERP_PROJECT_ID>'`. Import the allowlisted settings. Report the other key **names** (never values) as "move to Railway variables / dropped".
6. Verify and write the report.

**Report contents:**
- per-table counts (Airtable vs SQLite);
- attachments (count, bytes, failures);
- dangling links (table.field → missing IDs, with a sample);
- duplicate document numbers per type and company;
- computed fields per table;
- Airtable tables not in the registry;
- attachment fields outside the upload registry;
- users without a login key;
- skipped secret key names.

**Exit code:** non-zero if counts mismatch or any attachment failed.

**Activation:** `npm run db:activate -- <dir>` writes `$DATA_DIR/activate-pending` (the staging path).
- On the next start, before opening the DB, the server moves the current `erp.db` (plus `-wal`/`-shm`) and `files/` to `$DATA_DIR/backup-<timestamp>/` and moves the staging files into place.
- The service is then restarted from the Railway dashboard.
- The swap never happens while the database is open.

**Bootstrap:** `npm run user:create -- --name "…" [--admin] [--companies rec…,rec…]` creates an active User and prints the generated key once. It is used to test a fresh deployment before the import.

## 17. Configuration (`.env.example`, placeholders only)

| Variable | Required | Purpose |
|---|---|---|
| `NODE_ENV` | yes | `production` on Railway |
| `PORT` | set by Railway | Listen port (default 3000 locally) |
| `PUBLIC_ORIGIN` | yes | e.g. `https://erp-hero.up.railway.app`. Used by the origin check. |
| `DATA_DIR` | yes | `/data` on Railway (volume mount), `./.data` locally |
| `SECRETS_KEY` | yes | 32 random bytes, base64. Encrypts stored third-party keys. |
| `ANTHROPIC_API_KEY` | for AI | Anthropic key |
| `FRESHDESK_DOMAIN` | for Freshdesk | Subdomain, e.g. `flpliftparts` |
| `FRESHDESK_API_KEY` | optional | Fallback Freshdesk key |
| `FRESHSALES_SUBDOMAIN` | for Freshsales | e.g. `gilt` |
| `FRESHSALES_API_KEY` | for Freshsales | Freshsales token |
| `ATTACHMENT_PROXY_ALLOW` | optional | Override for the attachment host list |
| `LOG_LEVEL` | optional | `info` (default) / `debug` |
| `AIRTABLE_TOKEN`, `AIRTABLE_BASE_ID`, `AIRTABLE_MASTER_BASE_ID`, `ERP_PROJECT_ID` | import day only | Importer. Remove them afterwards. |

## 18. Railway

- **`railway.json`** (`$schema: https://railway.com/railway.schema.json`):
  - `build.builder: RAILPACK`
  - `deploy.startCommand: npm start`
  - `deploy.healthcheckPath: /healthz`, `healthcheckTimeout: 120` (this includes volume re-mount and any pending DB activation)
  - `restartPolicyType: ON_FAILURE`, `restartPolicyMaxRetries: 10`
- **Build:** Railpack runs `npm ci` and the `build` script (`tsc -p tsconfig.build.json` → `dist/`). `start` runs `node dist/server/main.js`.
- **Node version:** pinned via `engines.node: ">=22 <23"` and `.nvmrc`.
- **The server listens on `process.env.PORT`** on `0.0.0.0`.
- **`DEPLOY.md`** (dashboard steps):
  1. Create a project from the GitHub repo and select the branch.
  2. Set the region (EU West, Amsterdam, recommended).
  3. Add a volume mounted at `/data`.
  4. Set the variables.
  5. Generate a domain and set `PUBLIC_ORIGIN` to it.
  6. Enable volume backups (daily, weekly, monthly).
  7. Create the first admin via `railway ssh` + `npm run user:create`.
  8. Smoke checklist, including the attachment-host check.
  9. Import and cutover checklist, including rotating every key exposed by the old setup (the Airtable read token in the public repo history, the Airtable write key, the Anthropic key, the Freshdesk keys, the Val.town token) and decommissioning the Val.town proxy.
  10. Note: when the repo goes private, the Railway GitHub app needs access to it.

## 19. Testing strategy (TDD)

**Setup:**
- vitest, running in-process via `app.request()`.
- Each test gets a fresh temp-dir SQLite database and data dir.
- A fake `fetch` records calls and returns scripted responses.
- A global setup replaces `globalThis.fetch` with a function that throws, so any accidental live call fails the test.

**Suites:**
- **config:** missing and invalid env values.
- **auth:** login ok/fail, inactive user, rate limits (per IP and global), cookie flags, 8 h vs 30 d expiry, `/me`, logout, revoke-user (admin only), deactivation takes effect on the next request, no Bearer fallback, origin check.
- **records:** CRUD, Airtable empty-value semantics, PATCH merge, sort/filter/`maxRecords`/`fields[]`, restricted formula, unknown table, body limit.
- **permissions and secret removal:** User (admin vs non-admin), Company, AiUsageLog, secret-field rejection on write, safety-net stripping, derived fields.
- **numbers:** all 9 formats and floors, company matching (string and array), variants, peek, duplicate guard, legacy duplicates, 20 concurrent creates → unique and consecutive.
- **locks:** acquire/refresh/release, other holder, expiry, beacon release, non-lockable table.
- **files:** upload limits, allowed combinations, serving and headers, attachment-field normalization.
- **settings and admin secrets:** allowlist, admin only, key generation, `KEY_IN_USE`, Freshdesk key merge, encryption round-trip, backup archive contents.
- **third-party routes:** each allowlisted call forwarded correctly, disallowed calls blocked, Freshdesk key-selection order, multipart passthrough, 204 handling, raw error-body passthrough, missing-config messages, upstream failures, Mailchimp admin override and prefix validation, Anthropic method and size limit, attachment-proxy host/path/redirect/size checks.
- **static and headers:** `index.html` served byte-identical, `sw.js`, loader redirect, 404, security headers, `/healthz`.
- **importer:** pagination, rate limiting, attachments, secret handling, settings filtering, report contents, refusing an existing staging dir, GET-only against the fake Airtable. Plus `db:activate` swap on startup.

**Gates:**
- `npm test`, `npm run typecheck` (`tsc --noEmit`) and `npm run lint` (eslint + typescript-eslint) must all be clean.
- Plus a manual check: start the server locally and load `/` in headless Chromium.

## 20. Risks and open items

- **Attachment hosts:** the default allowlist is based on known Freshdesk URL forms. It must be verified with one real `attachment_url` at the first deploy test.
- **Computed Airtable fields** become fixed values after import. The report lists them. If the frontend relies on one staying live, we implement it server-side in a follow-up.
- **Unknown attachment fields:** attachment-type fields outside the upload registry are imported and served, but can't receive new uploads until they are added to the registry.
- **CSP:** it must be confirmed that the Tailwind Play CDN runs without `'unsafe-eval'` (checked in headless Chromium).
- **Old-app duplicates:** the old app keeps producing "max+1 of first 100" numbers until cutover. The import report lists the resulting duplicates, and cleaning them up is a separate decision.
- **`SECRETS_KEY` loss** makes stored Freshdesk and Mailchimp keys unrecoverable (they can be re-entered). Store it in a password manager.
- **Single instance:** each deploy has a few seconds of downtime. That is acceptable for 5 users.
- **`sw.js` caches every same-origin GET**, and API responses would be included. The Cache API ignores `Cache-Control: no-store`, so business data and files would end up in the browser's Cache Storage and survive logout. `sw.js` must not change this session. **The next session must make `sw.js` skip `/api/`** before the frontend switch goes live. Until then, the served page makes no successful API calls, so nothing is cached.

## 21. Frontend switch cheat-sheet (for the next session)

| Frontend function | New call |
|---|---|
| `loadProjectKeys` | `GET /api/settings` (no secrets anymore) |
| `loginWithUserKey` | `POST /api/auth` (the cookie replaces `session_token`) |
| `tryAutoLogin` | `GET /api/me` |
| `logout` | `POST /api/logout` |
| `_bootstrapLogin` / legacy key | removed |
| `loadCompanies` | `GET /api/data/Company?filterByFormula={status}='aktiv'` |
| `loadUsersCache` | `GET /api/data/User` (names only for non-admins) |
| `readData` / `writeData` / `updateData` / `deleteData` | `/api/data/...` (section 7) |
| `next*No` + `writeData` | `writeData(..., {assignNumber:true})`, then read the number from the result; previews use `/api/numbers/:type/next` |
| `acquireLock` / `releaseLock` / heartbeat / `beforeunload` | `/api/locks/...` (the unload handler uses `sendBeacon` on `…/release`) |
| `uploadFileToRecord` | `/api/data/:table/:id/files/:field` (callers pass the table) |
| `ensureTable` / `ensureFields` | `/api/schema/*` no-ops, or delete the calls |
| `_fetchMasterBaseKeys` / `_writeMasterBaseKey` / `_deleteMasterBaseKey` | `/api/settings` |
| admin user form | `PATCH /api/admin/users/:id/secrets` for keys; can no longer display the current login key |
| `_mcSaveCompany` | `PATCH /api/data/Company/:id` (prefix/list) plus `PATCH /api/admin/companies/:id/secrets` (key) |
| `proxyFetch` | base `/api`, no `Authorization` header, keep `X-Company-Id` |
| `mailchimpFetch` / settings tests | send `X-Company-Id`; admins may still send `x-mailchimp-key` / `x-mailchimp-server` for unsaved values |
| Val.town wizard, `valtown*`, `VALTOWN_PROXY_CODE` | removed |
| `sw.js` fetch handler | must bypass `/api/` (never cache API responses) |
