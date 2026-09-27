import type { Row } from '@libsql/client';
import type { Database, Executor } from '../db/database.js';
import { newRecordId } from '../util/ids.js';
import type { TableName } from './tables.js';

export interface StoredRecord {
  id: string;
  createdTime: string;
  updatedTime: string;
  fields: Record<string, unknown>;
}

const COLUMNS = 'id, created_time, updated_time, fields';

function toRecord(row: Row): StoredRecord {
  return {
    id: String(row.id),
    createdTime: String(row.created_time),
    updatedTime: String(row.updated_time),
    fields: JSON.parse(String(row.fields)) as Record<string, unknown>,
  };
}

/** Storage for the ERP tables. Table names come only from the registry, never from input. */
export class RecordStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  async list(table: TableName): Promise<StoredRecord[]> {
    const rows = await this.db.query(`SELECT ${COLUMNS} FROM "${table}" ORDER BY created_time, id`);
    return rows.map(toRecord);
  }

  async get(table: TableName, id: string, exec: Executor = this.db.client): Promise<StoredRecord | null> {
    const rs = await exec.execute({ sql: `SELECT ${COLUMNS} FROM "${table}" WHERE id = ?`, args: [id] });
    const row = rs.rows[0];
    return row ? toRecord(row) : null;
  }

  async count(table: TableName): Promise<number> {
    const rows = await this.db.query(`SELECT count(*) AS n FROM "${table}"`);
    return Number(rows[0]?.n ?? 0);
  }

  async insert(
    tx: Executor,
    table: TableName,
    fields: Record<string, unknown>,
    opts: { id?: string; createdTime?: string } = {},
  ): Promise<StoredRecord> {
    const id = opts.id ?? newRecordId();
    const now = this.iso();
    const createdTime = opts.createdTime ?? now;
    await tx.execute({
      sql: `INSERT INTO "${table}" (${COLUMNS}) VALUES (?, ?, ?, ?)`,
      args: [id, createdTime, now, JSON.stringify(fields)],
    });
    return { id, createdTime, updatedTime: now, fields };
  }

  /** Airtable PATCH semantics: merge `set`, delete `clear`. Returns null if the record is missing. */
  async update(
    tx: Executor,
    table: TableName,
    id: string,
    set: Record<string, unknown>,
    clear: string[],
  ): Promise<StoredRecord | null> {
    const existing = await this.get(table, id, tx);
    if (!existing) return null;
    const fields: Record<string, unknown> = { ...existing.fields, ...set };
    for (const name of clear) delete fields[name];
    const now = this.iso();
    await tx.execute({
      sql: `UPDATE "${table}" SET fields = ?, updated_time = ? WHERE id = ?`,
      args: [JSON.stringify(fields), now, id],
    });
    return { ...existing, updatedTime: now, fields };
  }

  async remove(tx: Executor, table: TableName, id: string): Promise<boolean> {
    const rs = await tx.execute({ sql: `DELETE FROM "${table}" WHERE id = ?`, args: [id] });
    return rs.rowsAffected > 0;
  }
}
