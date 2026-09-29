# Deploying the ERP Hero backend on Railway

This backend serves `index.html` and `/api/*` from one origin and stores all data in a SQLite
file on a Railway volume. For the design, see `docs/superpowers/specs/2026-09-25-erp-hero-backend-design.md`.

> The page served here is the app itself (ERP Hero v6.0). It talks only to this server, under
> `/api`, and contains no Airtable or Val.town code. Once this version is on `main`, the GitHub
> Pages copy and the old loader pages send everyone to this address (section 9).

> **Revoke the old keys.** The Airtable token that was embedded in the old `index.html` stays
> readable in the git history. Revoke it in Airtable, together with the old Airtable write key.
> Revoke the Val.town API token too, and delete the Val.town proxy (`erpHeroProxy`). The app uses
> none of them anymore, and the import in section 9 uses its own read-only token. The keys kept in
> Val.town, such as the Freshsales token, were readable with that API token: replace them as well
> (section 9, step 8).

## 1. Create the project from GitHub

1. In the Railway dashboard, click **New Project → Deploy from GitHub repo**.
2. Pick `giltglobalinvest-pixel/erp_hero`. Railway creates a service and starts a first deploy.
   That first deploy fails until the variables in section 4 are set. That's expected.
3. Open the service → **Settings → Source** and set the **branch** to `main`.
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
- Never paste the Airtable token that was embedded in the old `index.html`. The backend does not
  need Airtable at all, except on import day (section 9).

## 5. Generate a domain

Open the service → **Settings → Networking → Generate Domain**. Copy the URL (for example
`https://erp-hero-production.up.railway.app`), set `PUBLIC_ORIGIN` to exactly that value (no
trailing slash), and redeploy. `PUBLIC_ORIGIN` must match the address in the browser, otherwise
every login and save is rejected as a cross-site request.

## 6. Check the deployment

- `https://<domain>/healthz` → `{"ok":true}`
- `https://<domain>/` → the login page, with "ERP Hero v6.0" below the form.
- The deploy logs show one JSON line per request, never bodies, cookies or keys.

## 7. Create the first admin (before the import)

1. Install the Railway CLI, then run `railway login` and `railway link` (select the project and service).
2. Run `railway ssh`, then inside the container:

   ```
   npm run user:create -- --name "Patrizio" --admin
   ```

3. The command prints the new login key once. Store it safely.

`railway ssh` needs an SSH key registered with your Railway account; the CLI offers to register one
the first time. Without SSH, use a one-time start command instead: set **Settings → Deploy → Custom
Start Command** to `npm run user:create -- --name "Patrizio" --admin && npm start`, deploy, and
read the key in that deployment's logs. Then set the start command back to `npm start` and deploy
again, so that a restart does not create another admin. The key stays readable in the logs, so give
yourself a new one after the first login (section 8, step 6).

Log in with this admin in the browser (section 8). The import in section 9 replaces all users with
the users from Airtable.

## 8. Smoke test in the browser

1. Open `https://<domain>/` and log in with the key from section 7.
2. **Administration → Firmen → Firma anlegen:** enter a name and save. This is your first Mandant,
   and the switcher at the top of the sidebar now shows it. With several Mandanten, pick one there.
3. **Stammdaten → Kunden → Neuer Kunde:** the form already shows the number `K-1001` (each Mandant
   starts there). Enter a name and save.
4. Close the customer, open it again, close it, and reload the page. You are still logged in, and
   the customer is still there.
5. **Administration → Benutzer → Benutzer anlegen** creates a user with a login key. Create one
   test user here, not your colleagues: the import in section 9 brings them with their keys. The
   form fills in a new key: copy it with **Kopieren** before you save, because it is not shown
   again.
6. To replace a key, yours included, open the user, click **Neu**, copy the key and save. Saving a
   new key does not end open sessions; **Alle Sitzungen abmelden** in the same form does, and on
   your own user it logs you out as well.

Everything you create in this section goes into the database the service started with.
Activating the import (section 9, step 5) replaces that database and keeps it only in
`/data/backup-<timestamp>/`. If you do not import, it stays the real database, and step 5 is how
you create your colleagues' logins.

Then check the areas that the automated tests do not cover. Before the import there is no real
data, so repeat these checks after section 9, step 6.

> **Some of these checks write into the live Freshdesk and Freshsales accounts.** A new quote,
> order, delivery note or invoice sends its customer to Freshdesk as a company, and to Freshsales
> as an account once the Freshsales subdomain is saved; so does linking or creating a customer
> from a ticket. A KI-Angebot adds a private note with a link to the new quote to its ticket, and
> a saved AI summary adds a note too. These entries stay when the database is replaced. Before the
> import, use a test customer and a test ticket, and afterwards delete the test company in
> Freshdesk, the test account in Freshsales and the notes in the ticket.

- **PDF:** open a quote and create its PDF.
- **Quotes:** create an article first (**Stammdaten → Artikel**), then a quote with that article
  as an item, then change the item's quantity.
- **KI-Angebot:** start one from a Freshdesk ticket (uses `ANTHROPIC_API_KEY`).
- **Freshdesk:** open a ticket in the app. This needs a Freshdesk key: your own, entered under
  Administration → Benutzer ("Freshdesk API-Keys"), or the server's fallback `FRESHDESK_API_KEY`.
- **Attachment proxy:** open a ticket with an image attachment and use an AI summary that needs
  the image. If the server answers `403 Domain nicht erlaubt: <host>`, add that host to
  `ATTACHMENT_PROXY_ALLOW` (for example `ATTACHMENT_PROXY_ALLOW=<host>,…plus the defaults`) and
  tell the developer, so the default list gets updated.
- **Freshsales, Mailchimp:** under **Administration → Einstellungen**, save the Freshsales
  subdomain (this turns the Freshsales sync on) and use Mailchimp "Verbindung testen". Then open
  a customer and click **Erstmals syncen** in its Freshsales section.

The API also works from a REST client with the session cookie:

> **REST clients must send `Origin`.** Every `POST`, `PUT`, `PATCH` and `DELETE`, including the login
> `POST /api/auth`, must carry `Origin: https://<domain>` (exactly `PUBLIC_ORIGIN`); otherwise the
> server answers `403 FORBIDDEN "Anfrage von fremder Herkunft abgelehnt"`. Browsers add the header by
> themselves; curl and Postman do not, so add it to every such request. `GET` requests only need the cookie:
>
> ```
> curl -c jar.txt -H "Origin: https://<domain>" -H "Content-Type: application/json" \
>   -d '{"user_key":"<login key>"}' https://<domain>/api/auth
> curl -b jar.txt https://<domain>/api/me
> ```

## 9. Cutover from Airtable

The app is already switched: it talks only to this server, and the loader pages redirect here.
The cutover moves the data and retires the old setup.

1. Tell everyone to stop using the old app, and wait until nobody is editing anymore. Then revoke
   the old Airtable keys, if not done yet (see the note at the top): the old app can then no
   longer write to Airtable, and the import uses its own token.
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
     (copied as fixed values);
   - users listed under "Mehrere Benutzer mit demselben Login-Key" share one login key, and only the
     oldest of them can log in. Give each of them a separate key in step 6.
5. Activate the import. The old database is kept in `/data/backup-<timestamp>/`.

   ```
   npm run db:activate -- /data/import-<timestamp>
   ```

   Then **Restart** the service in the dashboard.

   If the service does not start after the restart and the log says the activation could not be
   rolled back, run `railway ssh`, read `/data/activation-failed`, move the entries listed there back
   in the order listed, as described in that file, delete the file, and restart again. The service
   then runs on the previous database; run `db:activate` again if you still want the import.
6. Log in at the new address with your existing login key and check the data. Then give every
   user a new login key before your colleagues start working here. The imported keys were
   readable through the Airtable token in the old `index.html`, and the old proxy sent them to
   every logged-in user, so until they are replaced anyone who read them can log in here,
   including with an admin's key. Open each user under Administration → Benutzer: click **Neu**,
   copy the key and save, then open the user again and click **Alle Sitzungen abmelden**. Do your
   own account last, because that logs you out; log in again with your new key. Hand each new key
   over in person or by phone. A REST client does the same with
   `PATCH /api/admin/users/<id>/secrets` and `{"generate_api_key": true}`, then
   `POST /api/sessions/revoke-user` and `{"user_id": "<id>"}`. `<id>` is the user's `id` from
   `GET /api/data/User`, and the PATCH response carries the new key once, as `api_key`. Both calls
   need the session cookie and the `Origin: https://<domain>` header (see section 8), for example:

   ```
   curl -b jar.txt -X PATCH -H "Origin: https://<domain>" -H "Content-Type: application/json" \
     -d '{"generate_api_key":true}' https://<domain>/api/admin/users/<id>/secrets
   ```

   Old bookmarks of the GitHub Pages address and of the loader pages lead here too. An app that
   was added to the home screen from the old address opens the new address; remove it and add it
   again from the new address.
7. Remove the four import variables again, and delete the read-only Airtable token.
8. **Rotate the other keys the old setup exposed.** The old `index.html` is public, including in the git history:
   - revoke the Airtable token that was embedded in the old `index.html`, and the old Airtable
     write key, if not done yet (see the note at the top);
   - create a new Anthropic key (update `ANTHROPIC_API_KEY`);
   - have each user regenerate their Freshdesk API key, then enter it again under
     Administration → Benutzer;
   - replace the keys that were kept in Val.town, because the old Val.town API token could read
     them: create a new Freshsales API key (update `FRESHSALES_API_KEY`), and a new Freshdesk key
     if the server's `FRESHDESK_API_KEY` came from there. The environment variables of the
     Val.town account list them all;
   - create a new Mailchimp API key for each Mandant and enter it under
     Administration → Einstellungen;
   - revoke the Val.town API token and delete the Val.town proxy (`erpHeroProxy`), if not done
     yet (see the note at the top).
9. Keep the Airtable bases untouched as an archive.
10. GitHub Pages is no longer needed. Leave it on until nobody uses the old address anymore, so old
    bookmarks still redirect, then turn it off in GitHub under **Settings → Pages**.

## 10. Known limitations after the switch

The app computes and saves its own totals, line totals and document numbers, so no core flow
depends on an Airtable formula. These smaller gaps remain:

- **Calculated Airtable fields are frozen by the import.** Formula, lookup and rollup values are
  copied as fixed values and never recalculated. `import-report.json` lists them per table under
  `computedFields`; read that list after the import (section 9, step 4).
- **Manufacturer in the quote item's article picker.** The picker shows the old text field
  `manufacturer`, which the app no longer writes, so new articles show only their article number
  there. The article list itself uses the linked manufacturer and category.
- **Archived Mandanten in a Freshdesk ticket's contact dialog.** Its Mandant list hides companies
  by the Airtable field `archived`, but the app archives a company by setting its status to
  "archiviert". A company archived in the app still appears in that list.
- **Custom field types.** The AI quote assistant uses a custom field's Airtable field `field_type`
  as a hint. The app does not edit that field, so custom fields created in the app give no hint.
- **Every record is loaded.** Lists now load all records of a table instead of the first 100, so
  large tables can take longer to open.
- **A document number taken meanwhile.** If a colleague saves the same number first, the record is
  saved with the next free number, and a warning says so. Text that was generated before saving
  still shows the first number.

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
