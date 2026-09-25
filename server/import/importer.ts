import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hashLoginKey } from '../auth/passwords.js';
import { isSecretField } from '../data/fields.js';
import { FileStore, type AttachmentValue } from '../data/files.js';
import { companyOf } from '../data/numbers.js';
import { RecordStore } from '../data/records.js';
import { attachmentFieldRule, isTableName, NUMBER_SPECS, TABLE_NAMES, type TableName } from '../data/tables.js';
import { openDatabase, type Executor } from '../db/database.js';
import { runMigrations } from '../db/migrations.js';
import { isPlainObject } from '../http/body.js';
import { SecretStore } from '../secrets/store.js';
import { isSettingKey, upsertSetting } from '../settings/store.js';
import { isRecordId } from '../util/ids.js';
import type { AirtableReader } from './airtable.js';
import { emptyReport, type ImportReport } from './report.js';

export const COMPUTED_FIELD_TYPES: ReadonlySet<string> = new Set([
  'formula',
  'rollup',
  'multipleLookupValues',
  'count',
  'autoNumber',
  'createdTime',
  'lastModifiedTime',
  'createdBy',
  'lastModifiedBy',
  'button',
  'aiText',
]);

export interface ImportOptions {
  reader: AirtableReader;
  appBaseId: string;
  masterBaseId: string;
  projectId: string;
  stagingDir: string;
  secretsKey: Buffer;
  now?: () => number;
  log?: (line: string) => void;
}

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

/**
 * Copies Airtable into a NEW SQLite database in stagingDir (read-only towards Airtable).
 * The live database is untouched; activation is a separate step (db:activate + restart).
 */
export async function runImport(o: ImportOptions): Promise<ImportReport> {
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => undefined);
  if (await exists(o.stagingDir)) throw new Error(`Staging directory already exists: ${o.stagingDir}`);
  await mkdir(o.stagingDir, { recursive: true });

  const report = emptyReport(new Date(now()).toISOString());
  const db = await openDatabase(path.join(o.stagingDir, 'erp.db'));
  try {
    await runMigrations(db);
    const records = new RecordStore(db, now);
    const secrets = new SecretStore(db, o.secretsKey);
    const files = new FileStore(db, o.stagingDir, now);
    const stripped = new Set<string>();

    const importUserSecrets = async (tx: Executor, userId: string, fields: Record<string, unknown>) => {
      const apiKey = fields.api_key;
      if (typeof apiKey === 'string' && apiKey.trim() !== '') {
        await secrets.setApiKeyHash(tx, userId, await hashLoginKey(apiKey.trim()));
      }
      const fdDefault = fields.freshdesk_api_key;
      if (typeof fdDefault === 'string' && fdDefault.trim() !== '') {
        await secrets.setFreshdeskDefault(tx, userId, fdDefault.trim());
      }
      const fdJson = fields.freshdesk_keys_json;
      if (typeof fdJson === 'string' && fdJson.trim() !== '') {
        try {
          const parsed: unknown = JSON.parse(fdJson);
          if (!isPlainObject(parsed)) throw new Error('not an object');
          const patch = Object.fromEntries(
            Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].trim() !== ''),
          );
          await secrets.mergeFreshdeskKeys(tx, userId, patch);
        } catch {
          report.warnings.push(`User ${userId}: freshdesk_keys_json ist kein gültiges JSON – übersprungen`);
        }
      }
      delete fields.api_key;
      delete fields.freshdesk_api_key;
      delete fields.freshdesk_keys_json;
    };

    const importAttachments = async (
      tx: Executor,
      table: TableName,
      recordId: string,
      field: string,
      value: unknown[],
    ): Promise<AttachmentValue[]> => {
      const out: AttachmentValue[] = [];
      for (const item of value) {
        if (!isPlainObject(item) || typeof item.url !== 'string') continue;
        const filename = typeof item.filename === 'string' ? item.filename : 'datei';
        try {
          const { data, contentType } = await o.reader.download(item.url);
          out.push(
            await files.save(tx, {
              table,
              recordId,
              field,
              filename,
              contentType: typeof item.type === 'string' ? item.type : contentType,
              data,
              createdBy: 'import',
              ...(typeof item.id === 'string' ? { id: item.id } : {}),
            }),
          );
          report.attachments.downloaded++;
          report.attachments.bytes += data.length;
        } catch {
          report.attachments.failed.push({ table, recordId, field, filename });
        }
      }
      return out;
    };

    // 1. Schema
    const schema = await o.reader.listTables(o.appBaseId);
    report.unknownTables = schema.map((t) => t.name).filter((name) => !isTableName(name));

    // 2. Records, secrets and attachments
    for (const table of TABLE_NAMES) {
      const tableSchema = schema.find((t) => t.name === table);
      if (!tableSchema) {
        report.missingTables.push(table);
        continue;
      }
      const computed = tableSchema.fields.filter((f) => COMPUTED_FIELD_TYPES.has(f.type)).map((f) => f.name);
      if (computed.length > 0) report.computedFields[table] = computed;
      const attachmentFields = tableSchema.fields.filter((f) => f.type === 'multipleAttachments').map((f) => f.name);
      for (const f of attachmentFields) {
        if (!attachmentFieldRule(table, f)) report.unregisteredAttachmentFields.push(`${table}.${f}`);
      }

      const source = await o.reader.listRecords(o.appBaseId, table);
      log(`${table}: ${source.length} Datensätze`);
      for (const rec of source) {
        const fields: Record<string, unknown> = { ...rec.fields };
        await db.write(async (tx) => {
          if (table === 'User') await importUserSecrets(tx, rec.id, fields);
          if (table === 'Company') {
            const mc = fields.mailchimp_api_key;
            if (typeof mc === 'string' && mc.trim() !== '') await secrets.setMailchimpKey(tx, rec.id, mc.trim());
            delete fields.mailchimp_api_key;
          }
          for (const name of Object.keys(fields)) {
            if (isSecretField(name)) {
              delete fields[name];
              stripped.add(`${table}.${name}`);
            }
          }
          for (const f of attachmentFields) {
            const value = fields[f];
            if (Array.isArray(value)) fields[f] = await importAttachments(tx, table, rec.id, f, value);
          }
          await records.insert(tx, table, fields, { id: rec.id, createdTime: rec.createdTime });
        });
      }
      const imported = await records.count(table);
      report.tables[table] = { airtable: source.length, imported };
      if (imported !== source.length) report.countMismatches.push(table);
    }
    report.strippedSecretFields = [...stripped].sort();

    // 3. Settings: only ERP Hero's rows of the shared Master base, only non-secret keys.
    const keyRows = await o.reader.listRecords(o.masterBaseId, 'Keys', {
      filterByFormula: `{project_id}='${o.projectId.replace(/'/g, "\\'")}'`,
    });
    await db.write(async (tx) => {
      for (const row of keyRows) {
        if (row.fields.project_id !== o.projectId) continue;
        const name = row.fields.key_name;
        const value = row.fields.key_value;
        if (typeof name !== 'string') continue;
        if (isSettingKey(name) && typeof value === 'string' && value.trim() !== '') {
          await upsertSetting(tx, name, value.trim(), 'import', new Date(now()).toISOString());
          report.importedSettings.push(name);
        } else {
          report.skippedSettingKeys.push(name);
        }
      }
    });

    // 4. Verification
    const allIds = new Set<string>();
    const all = new Map<TableName, Awaited<ReturnType<RecordStore['list']>>>();
    for (const table of TABLE_NAMES) {
      const list = await records.list(table);
      all.set(table, list);
      for (const r of list) allIds.add(r.id);
    }
    for (const [table, list] of all) {
      for (const r of list) {
        for (const [field, value] of Object.entries(r.fields)) {
          const ids = (Array.isArray(value) ? value : [value]).filter(isRecordId);
          for (const id of ids) {
            if (allIds.has(id)) continue;
            const key = `${table}.${field}`;
            const entry = (report.danglingLinks[key] ??= { count: 0, sample: [] });
            entry.count++;
            if (entry.sample.length < 5) entry.sample.push(id);
          }
        }
      }
    }
    for (const spec of NUMBER_SPECS) {
      const groups = new Map<string, string[]>();
      for (const r of all.get(spec.table) ?? []) {
        const value = r.fields[spec.field];
        if (value === undefined) continue;
        const key = `${companyOf(r.fields) ?? '(ohne Firma)'}\u0000${String(value)}`;
        groups.set(key, [...(groups.get(key) ?? []), r.id]);
      }
      for (const [key, ids] of groups) {
        if (ids.length < 2) continue;
        const [companyId = '', number = ''] = key.split('\u0000');
        report.duplicateNumbers.push({ type: spec.type, companyId, number, recordIds: ids });
      }
    }
    const hashes = await secrets.apiKeyHashes();
    report.usersWithoutKey = (all.get('User') ?? []).filter((u) => !hashes.has(u.id)).map((u) => u.id);

    report.finishedAt = new Date(now()).toISOString();
    report.ok = report.countMismatches.length === 0 && report.attachments.failed.length === 0;
    await db.client.execute('PRAGMA wal_checkpoint(TRUNCATE)');
    return report;
  } finally {
    db.close();
    await writeFile(path.join(o.stagingDir, 'import-report.json'), JSON.stringify(report, null, 2));
  }
}
