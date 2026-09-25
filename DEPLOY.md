# Deploying the ERP Hero backend on Railway

This backend serves `index.html` and `/api/*` from one origin and stores all data in a SQLite
file on a Railway volume. For the design, see `docs/superpowers/specs/2026-09-25-erp-hero-backend-design.md`.

> Until the frontend switch (next development step) is merged, the old GitHub Pages app stays
> the one your team uses. The page served by this backend loads, but cannot work yet: its old
> Airtable/Val.town calls are blocked on purpose by the new security policy.

## 1. Create the project from GitHub

1. In the Railway dashboard, click **New Project → Deploy from GitHub repo**.
2. Pick `giltglobalinvest-pixel/erp_hero`. Railway creates a service and starts a first deploy.
   That first deploy fails until the variables in section 4 are set. That's expected.
3. Open the service → **Settings → Source** and set the **branch** to the branch with the
   backend: `claude/confident-pascal-b6b330` until it is merged, then `main`.
4. **Settings → Deploy → Healthcheck Path:** enter `/healthz`. Railway then switches traffic to a
   new deployment only after `/healthz` answers 200.
   Everything else uses Railway's defaults, which match this repo: Railpack detects Node, runs
   `npm run build`, starts with `npm start`, and restarts on failure (up to 10 times).
   > `railway.json` in the repo describes the same settings, but Railway has deprecated these
   > config files: **new services do not read them**, and existing services stop reading them on
   > 2026-12-01. That is why the healthcheck path must be set here. Railway's replacement is a
   > `.railway/railway.ts` file applied with `railway config apply` ("Infrastructure as Code" in
   > Railway's docs). It is not set up in this repo yet.
5. **Settings → Deploy → Regions:** choose **EU West (Amsterdam)**.

> **When the repository becomes private:** Railway's GitHub app must be allowed to read it.
> In GitHub, open **Settings → Applications → Installed GitHub Apps → Railway → Configure** (for
> the organization or account that owns the repo). Under **Repository access**, add `erp_hero`,
> or allow all repositories. Otherwise deploys stop with a "repository not found / no access" error.

## 2. Add the volume

1. Press `⌘K` (or right-click the project canvas) → **Create Volume** → select the ERP Hero service.
2. Set the **mount path** to `/data`.
3. Railway redeploys the service with the volume attached. A service with a volume runs as a
   single instance and has a few seconds of downtime on each redeploy. That's fine for this app.

## 3. Turn on backups

Open the service → **Backups** tab and enable the **Daily**, **Weekly** and **Monthly** schedules.
They are kept for 6, 27 and 89 days respectively.

For long-term retention, an admin can also download a full backup at any time
(database + files, `.tar.gz`) from `GET /api/admin/backup` while logged in. Store those somewhere you control.

## 4. Set the variables

Open the service → **Variables** → **Raw Editor** and paste the list below, filling in real values.
`.env.example` in the repo explains every variable.

```
NODE_ENV=production
PUBLIC_ORIGIN=https://<your-domain>          # set after step 5, then redeploy
DATA_DIR=/data
SECRETS_KEY=<32 random bytes, base64>
ANTHROPIC_API_KEY=<key>
FRESHDESK_DOMAIN=<subdomain, e.g. flpliftparts>
FRESHDESK_API_KEY=<optional fallback key>
FRESHSALES_SUBDOMAIN=<subdomain, e.g. gilt>
FRESHSALES_API_KEY=<key>
```

- Generate `SECRETS_KEY` once with
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
  and **store a copy in your password manager**. Without it, the stored Freshdesk/Mailchimp keys
  cannot be decrypted (they would have to be re-entered; login keys are not affected).
- Do not set `PORT`; Railway injects it.
- Never paste the Airtable token that is embedded in `index.html`. The backend does not need
  Airtable at all, except on import day (section 9).

## 5. Generate a domain

Open the service → **Settings → Networking → Generate Domain**. Copy the URL (for example
`https://erp-hero-production.up.railway.app`), set `PUBLIC_ORIGIN` to exactly that value (no
trailing slash), and redeploy. `PUBLIC_ORIGIN` must match the address in the browser, otherwise
every login and save is rejected as a cross-site request.

## 6. Check the deployment

- `https://<domain>/healthz` → `{"ok":true}`
- `https://<domain>/` → the ERP Hero page. Until the frontend switch, the login cannot work yet.
- The deploy logs show one JSON line per request, never bodies, cookies or keys.

## 7. Create the first admin (before the import)

1. Install the Railway CLI, then run `railway login` and `railway link` (select the project and service).
2. Run `railway ssh`, then inside the container:

   ```
   npm run user:create -- --name "Patrizio" --admin
   ```

3. The command prints the new login key once. Store it safely.

Use this admin to smoke-test the deployment. The import in section 9 replaces all users with the users from Airtable.

## 8. Smoke test with real services (needs a logged-in session)

After the frontend switch, or with a REST client and the session cookie:

- **Freshdesk:** open a ticket in the app. Check that `GET /api/freshdesk/api/v2/tickets/<id>` works.
- **Attachment proxy:** open a ticket with an image attachment and use an AI summary that needs
  the image. If the server answers `403 Domain nicht erlaubt: <host>`, add that host to
  `ATTACHMENT_PROXY_ALLOW` (for example `ATTACHMENT_PROXY_ALLOW=<host>,…plus the defaults`) and
  tell the developer, so the default list gets updated.
- **Anthropic, Freshsales, Mailchimp:** use one feature each ("KI-Angebot", Freshsales sync,
  Mailchimp "Verbindung testen").

## 9. Cutover from Airtable (after the frontend switch is merged)

1. Tell everyone to stop using the old app, and wait until nobody is editing anymore.
2. In Airtable, create a **new read-only token** with scopes `data.records:read` and
   `schema.bases:read` on the App base and the Master base.
3. Set the import variables on the service (`AIRTABLE_TOKEN`, `AIRTABLE_BASE_ID`,
   `AIRTABLE_MASTER_BASE_ID`, `ERP_PROJECT_ID=p_1778057282571`). This redeploys.
4. Run `railway ssh`, then:

   ```
   npm run import:airtable
   ```

   The import reads everything from Airtable (GET only) into a new folder `/data/import-<timestamp>/`,
   downloads all attachments, and prints a report. It is also saved as `import-report.json`.
   Read the report:
   - record counts must match;
   - failed attachments must be zero;
   - review duplicate document numbers, links to missing records, and calculated Airtable fields
     (copied as fixed values).
5. Activate the import. The old database is kept in `/data/backup-<timestamp>/`.

   ```
   npm run db:activate -- /data/import-<timestamp>
   ```

   Then **Restart** the service in the dashboard.
6. Everyone logs in at the new address with their existing login key.
7. Remove the four import variables again, and delete the read-only Airtable token.
8. **Rotate every key the old setup exposed.** The old `index.html` is public, including in the git history:
   - revoke the Airtable token embedded in `index.html` and the old Airtable write key;
   - create a new Anthropic key (update `ANTHROPIC_API_KEY`);
   - have each user regenerate their Freshdesk API key, then enter it again under Admin → Benutzer;
   - rotate Mailchimp keys;
   - revoke the Val.town API token and delete the Val.town proxy (`erpHeroProxy`).
9. Keep the Airtable bases untouched as an archive.

## Local development

```
cp .env.example .env        # fill in SECRETS_KEY; the other keys are optional locally
npm install
npm run dev                 # http://localhost:3000 (tsx watch)
npm test                    # all upstream HTTP is faked; no network access needed
npm run typecheck && npm run lint
npm run build && npm start  # production build
```

Load `.env` into your shell before `npm run dev` (for example `set -a; . ./.env; set +a`).
The server does not read `.env` by itself.
