import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyLoginKey } from '../server/auth/passwords.js';
import { RecordStore } from '../server/data/records.js';
import { TABLE_NAMES } from '../server/data/tables.js';
import { openDatabase } from '../server/db/database.js';
import { AirtableReader, type AirtableApiRecord } from '../server/import/airtable.js';
import { runImport } from '../server/import/importer.js';
import { SecretStore } from '../server/secrets/store.js';
import { readSettings } from '../server/settings/store.js';
import { FakeFetch, jsonResponse } from './helpers/fakeFetch.js';

const KEY = Buffer.alloc(32, 5);
const APP = 'appAPPAPPAPPAPP12';
const MASTER = 'appMASTERMASTER12';
const PROJECT = 'p_1778057282571';
const rid = (n: number) => `rec${String(n).padStart(14, '0')}`;

const extraFields: Record<string, { name: string; type: string }[]> = {
  Customer: [
    { name: 'name', type: 'singleLineText' },
    { name: 'display_name', type: 'formula' },
    { name: 'photo', type: 'multipleAttachments' },
  ],
  Attachment: [
    { name: 'name', type: 'singleLineText' },
    { name: 'file', type: 'multipleAttachments' },
  ],
  Invoice: [{ name: 'order_count', type: 'count' }],
};

const tableData: Record<string, AirtableApiRecord[]> = {
  Customer: Array.from({ length: 150 }, (_, i) => ({
    id: rid(i + 1),
    createdTime: `2024-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
    fields: i === 0 ? { name: 'Müller GmbH', company_id: [rid(900)], portal_password: 'hunter2' } : { name: `K${i}` },
  })),
  Company: [{ id: rid(900), createdTime: '2023-01-01T00:00:00.000Z', fields: { name: 'FLP', mailchimp_api_key: 'mc-us21', status: 'aktiv' } }],
  User: [
    {
      id: rid(800),
      createdTime: '2023-01-01T00:00:00.000Z',
      fields: {
        name: 'Anna',
        status: 'aktiv',
        api_key: 'annaoldkey1234567890abcd',
        freshdesk_api_key: 'fd-default',
        freshdesk_keys_json: JSON.stringify({ [rid(900)]: 'fd-flp' }),
      },
    },
    { id: rid(801), createdTime: '2023-01-01T00:00:00.000Z', fields: { name: 'NoKey', status: 'aktiv', freshdesk_keys_json: '{broken' } },
  ],
  Invoice: [
    { id: rid(700), createdTime: '2025-01-01T00:00:00.000Z', fields: { invoice_no: 'R-1001', company_id: rid(900), customer_id: rid(999) } },
    { id: rid(701), createdTime: '2025-01-02T00:00:00.000Z', fields: { invoice_no: 'R-1001', company_id: rid(900) } },
  ],
  Attachment: [
    {
      id: rid(600),
      createdTime: '2025-01-01T00:00:00.000Z',
      fields: {
        name: 'Datenblatt',
        file: [{ id: 'attAAAAAAAAAAAAAA', url: 'https://v5.airtableusercontent.com/ok', filename: 'blatt.pdf', size: 3, type: 'application/pdf' }],
      },
    },
  ],
};

function fakeAirtable(options: { failDownload?: boolean } = {}) {
  const fake = new FakeFetch();
  fake.on('GET', `https://api.airtable.com/v0/meta/bases/${APP}/tables`, () =>
    jsonResponse({
      tables: [
        ...TABLE_NAMES.map((name, i) => ({ id: `tbl${i}`, name, fields: extraFields[name] ?? [] })),
        { id: 'tblX', name: 'Projects', fields: [] },
      ],
    }),
  );
  fake.on('GET', `https://api.airtable.com/v0/${APP}/`, (call) => {
    const url = new URL(call.url);
    const table = decodeURIComponent(url.pathname.split('/').pop() ?? '');
    const rows = tableData[table] ?? [];
    const start = Number(url.searchParams.get('offset') ?? '0');
    const page = rows.slice(start, start + 100);
    return jsonResponse({ records: page, ...(start + 100 < rows.length ? { offset: String(start + 100) } : {}) });
  });
  fake.on('GET', `https://api.airtable.com/v0/${MASTER}/Keys`, () =>
    jsonResponse({
      records: [
        { id: 'recK1', createdTime: 't', fields: { project_id: PROJECT, key_name: 'freshdeskDomain', key_value: 'flpliftparts' } },
        { id: 'recK2', createdTime: 't', fields: { project_id: PROJECT, key_name: 'anthropicKey', key_value: 'sk-ant-SECRET' } },
        { id: 'recK3', createdTime: 't', fields: { project_id: 'p_other', key_name: 'freshdeskTicketTypes', key_value: 'x' } },
      ],
    }),
  );
  fake.on('GET', 'https://v5.airtableusercontent.com/ok', () =>
    options.failDownload ? new Response('expired', { status: 410 }) : new Response(Buffer.from('PDF'), { headers: { 'content-type': 'application/pdf' } }),
  );
  return fake;
}

let base: string;
let staging: string;
beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'erp-import-'));
  staging = path.join(base, 'import-1');
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const run = (fake: FakeFetch) =>
  runImport({
    reader: new AirtableReader({ token: 'pat', fetch: fake.fetch, minIntervalMs: 0 }),
    appBaseId: APP,
    masterBaseId: MASTER,
    projectId: PROJECT,
    stagingDir: staging,
    secretsKey: KEY,
    now: () => Date.parse('2026-03-01T12:00:00.000Z'),
  });

describe('runImport', () => {
  it('copies every record with its id and createdTime, using only GET requests', async () => {
    const fake = fakeAirtable();
    const report = await run(fake);
    expect(fake.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(report.tables.Customer).toEqual({ airtable: 150, imported: 150 });
    expect(report.countMismatches).toEqual([]);

    const db = await openDatabase(path.join(staging, 'erp.db'));
    const records = new RecordStore(db);
    const first = await records.get('Customer', rid(1));
    expect(first?.createdTime).toBe('2024-01-01T00:00:00.000Z');
    expect(first?.fields).toEqual({ name: 'Müller GmbH', company_id: [rid(900)] });
    db.close();
  });

  it('moves secrets out of records: hashed login keys, encrypted Freshdesk and Mailchimp keys', async () => {
    const report = await run(fakeAirtable());
    const db = await openDatabase(path.join(staging, 'erp.db'));
    const records = new RecordStore(db);
    const secrets = new SecretStore(db, KEY);
    expect((await records.get('User', rid(800)))?.fields).toEqual({ name: 'Anna', status: 'aktiv' });
    const hash = (await secrets.apiKeyHashes()).get(rid(800)) ?? '';
    expect(await verifyLoginKey('annaoldkey1234567890abcd', hash)).toBe(true);
    expect(await secrets.freshdeskKeyFor(rid(800), rid(900))).toBe('fd-flp');
    expect(await secrets.freshdeskKeyFor(rid(800), null)).toBe('fd-default');
    expect(await secrets.mailchimpKey(rid(900))).toBe('mc-us21');
    expect((await records.get('Company', rid(900)))?.fields).toEqual({ name: 'FLP', status: 'aktiv' });
    expect(report.strippedSecretFields).toEqual(['Customer.portal_password']);
    expect(report.usersWithoutKey).toEqual([rid(801)]);
    expect(report.warnings).toEqual([`User ${rid(801)}: freshdesk_keys_json ist kein gültiges JSON – übersprungen`]);
    const dump = JSON.stringify(await db.query('SELECT * FROM user_secrets')) + JSON.stringify(await db.query('SELECT * FROM company_secrets'));
    expect(dump).not.toMatch(/annaoldkey|fd-flp|fd-default|mc-us21/);
    db.close();
  });

  it('downloads attachments and rewrites them to our file URLs, keeping the attachment id', async () => {
    const report = await run(fakeAirtable());
    expect(report.attachments).toEqual({ downloaded: 1, bytes: 3, failed: [] });
    const db = await openDatabase(path.join(staging, 'erp.db'));
    const att = (await new RecordStore(db).get('Attachment', rid(600)))?.fields.file;
    expect(att).toEqual([
      { id: 'attAAAAAAAAAAAAAA', url: '/api/files/attAAAAAAAAAAAAAA/blatt.pdf', filename: 'blatt.pdf', size: 3, type: 'application/pdf' },
    ]);
    expect((await readFile(path.join(staging, 'files', 'attAAAAAAAAAAAAAA', 'blatt.pdf'))).toString()).toBe('PDF');
    db.close();
  });

  it('imports only allowlisted settings from ERP Hero rows of the Master base', async () => {
    const report = await run(fakeAirtable());
    const db = await openDatabase(path.join(staging, 'erp.db'));
    expect(await readSettings(db)).toEqual({ freshdeskDomain: 'flpliftparts' });
    db.close();
    expect(report.importedSettings).toEqual(['freshdeskDomain']);
    expect(report.skippedSettingKeys).toEqual(['anthropicKey']);
    expect(JSON.stringify(report)).not.toContain('sk-ant-SECRET');
  });

  it('reports computed fields, unknown tables, unregistered attachment fields, dangling links and duplicate numbers', async () => {
    const report = await run(fakeAirtable());
    expect(report.computedFields).toEqual({ Customer: ['display_name'], Invoice: ['order_count'] });
    expect(report.unknownTables).toEqual(['Projects']);
    expect(report.unregisteredAttachmentFields).toEqual(['Customer.photo']);
    expect(report.danglingLinks).toEqual({ 'Invoice.customer_id': { count: 1, sample: [rid(999)] } });
    expect(report.duplicateNumbers).toEqual([{ type: 'invoice', companyId: rid(900), number: 'R-1001', recordIds: [rid(700), rid(701)] }]);
    expect(report.ok).toBe(true);
    const saved = JSON.parse(await readFile(path.join(staging, 'import-report.json'), 'utf8'));
    expect(saved.tables.Customer).toEqual({ airtable: 150, imported: 150 });
  });

  it('marks the import as not ok when an attachment cannot be downloaded', async () => {
    const report = await run(fakeAirtable({ failDownload: true }));
    expect(report.ok).toBe(false);
    expect(report.attachments.failed).toEqual([{ table: 'Attachment', recordId: rid(600), field: 'file', filename: 'blatt.pdf' }]);
  });

  it('refuses to reuse an existing staging directory', async () => {
    await run(fakeAirtable());
    await expect(run(fakeAirtable())).rejects.toThrow('Staging directory already exists');
    await access(path.join(staging, 'erp.db'));
  });
});
