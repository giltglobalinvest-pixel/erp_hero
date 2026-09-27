import { TABLE_NAMES } from '../data/tables.js';
import type { Database } from './database.js';

interface Migration {
  version: number;
  statements: string[];
}

const erpTable = (name: string): string =>
  `CREATE TABLE IF NOT EXISTS "${name}" (
     id TEXT PRIMARY KEY,
     created_time TEXT NOT NULL,
     updated_time TEXT NOT NULL,
     fields TEXT NOT NULL CHECK (json_valid(fields))
   )`;

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    statements: [
      ...TABLE_NAMES.map(erpTable),
      `CREATE TABLE IF NOT EXISTS sessions (
         token_hash TEXT PRIMARY KEY,
         user_id TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         expires_at INTEGER NOT NULL,
         long_lived INTEGER NOT NULL,
         user_agent TEXT NOT NULL DEFAULT ''
       )`,
      'CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id)',
      `CREATE TABLE IF NOT EXISTS user_secrets (
         user_id TEXT PRIMARY KEY,
         api_key_hash TEXT,
         freshdesk_api_key_enc TEXT,
         freshdesk_keys_enc TEXT
       )`,
      `CREATE TABLE IF NOT EXISTS company_secrets (
         company_id TEXT PRIMARY KEY,
         mailchimp_api_key_enc TEXT
       )`,
      `CREATE TABLE IF NOT EXISTS settings (
         key TEXT PRIMARY KEY,
         value TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         updated_by TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS files (
         id TEXT PRIMARY KEY,
         table_name TEXT NOT NULL,
         record_id TEXT NOT NULL,
         field TEXT NOT NULL,
         filename TEXT NOT NULL,
         content_type TEXT NOT NULL,
         size INTEGER NOT NULL,
         sha256 TEXT NOT NULL,
         path TEXT NOT NULL,
         created_at TEXT NOT NULL,
         created_by TEXT NOT NULL
       )`,
    ],
  },
];

export async function runMigrations(db: Database): Promise<void> {
  await db.client.execute(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const applied = new Set((await db.query('SELECT version FROM schema_migrations')).map((r) => Number(r.version)));
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    await db.write(async (tx) => {
      for (const sql of migration.statements) await tx.execute(sql);
      await tx.execute({
        sql: 'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
        args: [migration.version, new Date().toISOString()],
      });
    });
  }
}
