import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACTIVATION_MARKER, applyPendingActivation, scheduleActivation } from '../server/activation.js';
import { verifyLoginKey } from '../server/auth/passwords.js';
import { runDbActivateCli, runImportCli, runUserCreateCli } from '../server/cli/commands.js';
import { RecordStore } from '../server/data/records.js';
import { openDatabase } from '../server/db/database.js';
import { SecretStore } from '../server/secrets/store.js';
import { testEnv } from './helpers/context.js';
import { FakeFetch, jsonResponse } from './helpers/fakeFetch.js';

let dataDir: string;
let out: string[];
const print = (line: string) => out.push(line);
const silent = { info: () => undefined, error: () => undefined };

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'erp-cli-'));
  out = [];
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('user:create', () => {
  it('creates an active admin with a hashed key and prints the key once', async () => {
    const code = await runUserCreateCli(['--name', 'Patrizio', '--admin', '--companies', 'recA,recB'], testEnv(dataDir), print);
    expect(code).toBe(0);
    const key = /Login-Key \(wird nur jetzt angezeigt\): ([a-z0-9]{24})/.exec(out.join('\n'))?.[1] ?? '';
    const db = await openDatabase(path.join(dataDir, 'erp.db'));
    const [user] = await new RecordStore(db).list('User');
    expect(user?.fields).toMatchObject({ name: 'Patrizio', status: 'aktiv', is_admin: true, allowed_companies: ['recA', 'recB'] });
    const hash = (await new SecretStore(db, Buffer.alloc(32, 7)).apiKeyHashes()).get(user?.id ?? '') ?? '';
    expect(await verifyLoginKey(key, hash)).toBe(true);
    db.close();
  });

  it('requires --name', async () => {
    expect(await runUserCreateCli([], testEnv(dataDir), print)).toBe(1);
    expect(out[0]).toContain('--name');
  });
});

describe('activation', () => {
  it('swaps in the staged database on the next start and keeps the old one as backup', async () => {
    await writeFile(path.join(dataDir, 'erp.db'), 'OLD');
    await mkdir(path.join(dataDir, 'files', 'attOLD'), { recursive: true });
    const staging = path.join(dataDir, 'import-1');
    await mkdir(path.join(staging, 'files', 'attNEW'), { recursive: true });
    await writeFile(path.join(staging, 'erp.db'), 'NEW');

    expect(await runDbActivateCli([staging], testEnv(dataDir), print)).toBe(0);
    expect(await readFile(path.join(dataDir, ACTIVATION_MARKER), 'utf8')).toBe(staging);

    const result = await applyPendingActivation(dataDir, silent, new Date('2026-03-01T12:00:00.000Z'));
    expect(result).toEqual({ activated: true, backupDir: path.join(dataDir, 'backup-2026-03-01T12-00-00-000Z') });
    expect(await readFile(path.join(dataDir, 'erp.db'), 'utf8')).toBe('NEW');
    expect(await readdir(path.join(dataDir, 'files'))).toEqual(['attNEW']);
    expect(await readFile(path.join(result.backupDir ?? '', 'erp.db'), 'utf8')).toBe('OLD');
    expect(await readdir(path.join(result.backupDir ?? '', 'files'))).toEqual(['attOLD']);
    expect((await readdir(dataDir)).includes(ACTIVATION_MARKER)).toBe(false);
  });

  it('does nothing without a marker and refuses staging dirs without a database', async () => {
    expect(await applyPendingActivation(dataDir, silent)).toEqual({ activated: false });
    await expect(scheduleActivation(dataDir, path.join(dataDir, 'nope'))).rejects.toThrow('No erp.db');
    await writeFile(path.join(dataDir, ACTIVATION_MARKER), path.join(dataDir, 'gone'));
    expect(await applyPendingActivation(dataDir, silent)).toEqual({ activated: false });
    expect(await runDbActivateCli([], testEnv(dataDir), print)).toBe(1);
  });
});

describe('import:airtable', () => {
  it('requires the Airtable variables', async () => {
    expect(await runImportCli([], testEnv(dataDir), new FakeFetch().fetch, print)).toBe(1);
    expect(out[0]).toBe('Fehler: fehlende Variablen: AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_MASTER_BASE_ID, ERP_PROJECT_ID');
  });

  it('runs the import into a staging dir and prints the report and next step', async () => {
    const fake = new FakeFetch()
      .on('GET', 'https://api.airtable.com/v0/meta/bases/appA/tables', () => jsonResponse({ tables: [] }))
      .on('GET', 'https://api.airtable.com/v0/appM/Keys', () => jsonResponse({ records: [] }));
    const env = testEnv(dataDir, {
      AIRTABLE_TOKEN: 'pat',
      AIRTABLE_BASE_ID: 'appA',
      AIRTABLE_MASTER_BASE_ID: 'appM',
      ERP_PROJECT_ID: 'p_1',
    });
    const staging = path.join(dataDir, 'import-x');
    const code = await runImportCli(['--staging', staging], env, fake.fetch, print);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain(`Aktivieren mit: npm run db:activate -- ${staging}`);
    expect(out.join('\n')).toContain('Import OK');
  });
});
