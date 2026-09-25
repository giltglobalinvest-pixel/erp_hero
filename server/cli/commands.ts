import path from 'node:path';
import { parseArgs } from 'node:util';
import { scheduleActivation } from '../activation.js';
import { hashLoginKey } from '../auth/passwords.js';
import { loadConfig } from '../config.js';
import { RecordStore } from '../data/records.js';
import { openDatabase } from '../db/database.js';
import { runMigrations } from '../db/migrations.js';
import type { FetchFn } from '../deps.js';
import { AirtableReader } from '../import/airtable.js';
import { runImport } from '../import/importer.js';
import { formatReport } from '../import/report.js';
import { SecretStore } from '../secrets/store.js';
import { newLoginKey } from '../util/ids.js';

export type Output = (line: string) => void;

/** npm run user:create -- --name "Anna" [--admin] [--role Vertrieb] [--companies recA,recB] */
export async function runUserCreateCli(argv: string[], env: NodeJS.ProcessEnv, out: Output): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      name: { type: 'string' },
      role: { type: 'string' },
      admin: { type: 'boolean', default: false },
      companies: { type: 'string' },
    },
  });
  const name = values.name?.trim();
  if (!name) {
    out('Fehler: --name ist erforderlich');
    return 1;
  }
  const config = loadConfig(env, process.cwd());
  const db = await openDatabase(path.join(config.dataDir, 'erp.db'));
  try {
    await runMigrations(db);
    const records = new RecordStore(db);
    const secrets = new SecretStore(db, config.secretsKey);
    const key = newLoginKey();
    const hash = await hashLoginKey(key);
    const fields: Record<string, unknown> = { name, status: 'aktiv', created: new Date().toISOString().slice(0, 10) };
    if (values.role) fields.role = values.role;
    if (values.admin) fields.is_admin = true;
    const companies = (values.companies ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (companies.length > 0) fields.allowed_companies = companies;
    const user = await db.write(async (tx) => {
      const record = await records.insert(tx, 'User', fields);
      await secrets.setApiKeyHash(tx, record.id, hash);
      return record;
    });
    out(`Benutzer angelegt: ${name} (${user.id})${values.admin ? ' [Admin]' : ''}`);
    out(`Login-Key (wird nur jetzt angezeigt): ${key}`);
    return 0;
  } finally {
    db.close();
  }
}

/** npm run db:activate -- <staging-dir> ; takes effect on the next restart. */
export async function runDbActivateCli(argv: string[], env: NodeJS.ProcessEnv, out: Output): Promise<number> {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true });
  const stagingDir = positionals[0];
  if (!stagingDir) {
    out('Fehler: Pfad zum Import-Verzeichnis fehlt (npm run db:activate -- /data/import-...)');
    return 1;
  }
  const config = loadConfig(env, process.cwd());
  const staging = await scheduleActivation(config.dataDir, stagingDir);
  out(`Aktivierung vorgemerkt: ${staging}`);
  out('Jetzt den Service im Railway-Dashboard neu starten (Restart). Die bisherige Datenbank wird dabei in backup-<Zeitstempel>/ verschoben.');
  return 0;
}

/** npm run import:airtable [-- --staging /data/import-2026-...] */
export async function runImportCli(argv: string[], env: NodeJS.ProcessEnv, fetchFn: FetchFn, out: Output): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { staging: { type: 'string' } } });
  const missing = ['AIRTABLE_TOKEN', 'AIRTABLE_BASE_ID', 'AIRTABLE_MASTER_BASE_ID', 'ERP_PROJECT_ID'].filter((k) => !env[k]?.trim());
  if (missing.length > 0) {
    out(`Fehler: fehlende Variablen: ${missing.join(', ')}`);
    return 1;
  }
  const config = loadConfig(env, process.cwd());
  const stagingDir = values.staging ?? path.join(config.dataDir, `import-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const report = await runImport({
    reader: new AirtableReader({ token: String(env.AIRTABLE_TOKEN).trim(), fetch: fetchFn }),
    appBaseId: String(env.AIRTABLE_BASE_ID).trim(),
    masterBaseId: String(env.AIRTABLE_MASTER_BASE_ID).trim(),
    projectId: String(env.ERP_PROJECT_ID).trim(),
    stagingDir,
    secretsKey: config.secretsKey,
    log: out,
  });
  out(formatReport(report));
  out('');
  out(`Datenbank und Bericht: ${stagingDir}`);
  out(`Aktivieren mit: npm run db:activate -- ${stagingDir}`);
  return report.ok ? 0 : 1;
}
