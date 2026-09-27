import type { Database, Executor } from '../db/database.js';

/** Non-secret settings the browser may read. Everything else from the old Keys table is gone. */
export const SETTING_KEYS = [
  'freshdeskSalesGroupId',
  'freshdeskOrderGroupId',
  'freshdeskTicketTypes',
  'freshdeskDomain',
  'freshsalesSubdomain',
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

const KEY_SET: ReadonlySet<string> = new Set(SETTING_KEYS);
export const isSettingKey = (key: string): key is SettingKey => KEY_SET.has(key);

export async function readSettings(db: Database): Promise<Record<string, string>> {
  const rows = await db.query('SELECT key, value FROM settings ORDER BY key');
  return Object.fromEntries(rows.map((row) => [String(row.key), String(row.value)]));
}

export async function upsertSetting(exec: Executor, key: SettingKey, value: string, updatedBy: string, at: string): Promise<void> {
  await exec.execute({
    sql: `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    args: [key, value, at, updatedBy],
  });
}

export async function deleteSetting(exec: Executor, key: SettingKey): Promise<void> {
  await exec.execute({ sql: 'DELETE FROM settings WHERE key = ?', args: [key] });
}
