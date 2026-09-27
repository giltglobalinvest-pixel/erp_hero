import { Hono } from 'hono';
import type { Executor } from '../db/database.js';
import type { AppDeps } from '../deps.js';
import type { AppEnv } from '../types.js';
import { ApiError } from '../util/errors.js';
import type { StoredRecord } from './records.js';
import { numberSpecForTable, numberSpecForType, type NumberSpec, type TableName } from './tables.js';

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** company_id is a plain string on some tables and an array of record ids on others. */
export function companyOf(fields: Record<string, unknown>): string | null {
  const v = fields.company_id;
  if (typeof v === 'string' && v !== '') return v;
  if (Array.isArray(v)) {
    const first = v.find((x): x is string => typeof x === 'string' && x !== '');
    return first ?? null;
  }
  return null;
}

export interface CreateNumberOptions {
  assignNumber: boolean;
  variantOf: unknown;
}

/**
 * Document numbers. Every method runs inside the caller's write transaction; write
 * transactions are serialized, so "read highest, add one, insert" cannot race.
 */
export class NumberService {
  private async valuesForCompany(exec: Executor, spec: NumberSpec, companyId: string) {
    const rs = await exec.execute({
      sql: `SELECT id, json_extract(fields, '$.${spec.field}') AS value FROM "${spec.table}"
            WHERE EXISTS (SELECT 1 FROM json_each("${spec.table}".fields, '$.company_id') WHERE json_each.value = ?)`,
      args: [companyId],
    });
    return rs.rows
      .filter((row) => row.value !== null && row.value !== undefined)
      .map((row) => ({ id: String(row.id), value: String(row.value) }));
  }

  async next(exec: Executor, spec: NumberSpec, companyId: string): Promise<string> {
    const pattern = new RegExp(`^${escapeRegex(spec.prefix)}(\\d+)$`);
    let highest = spec.floor;
    for (const { value } of await this.valuesForCompany(exec, spec, companyId)) {
      const m = pattern.exec(value);
      if (m?.[1]) highest = Math.max(highest, Number(m[1]));
    }
    return `${spec.prefix}${highest + 1}`;
  }

  /** "Q-1024" or "Q-1024.2" -> "Q-1024.<highest existing variant + 1>". */
  async nextVariant(exec: Executor, companyId: string, variantOf: string): Promise<string> {
    const base = /^(Q-\d+)(?:\.\d+)?$/.exec(variantOf.trim())?.[1];
    if (!base) throw new ApiError('INVALID_REQUEST', `Ungültige Angebotsnummer für Variante: ${variantOf}`);
    const spec = numberSpecForType('quote');
    if (!spec) throw new Error('quote number spec missing');
    const pattern = new RegExp(`^${escapeRegex(base)}\\.(\\d+)$`);
    let highest = 0;
    for (const { value } of await this.valuesForCompany(exec, spec, companyId)) {
      const m = pattern.exec(value);
      if (m?.[1]) highest = Math.max(highest, Number(m[1]));
    }
    return `${base}.${highest + 1}`;
  }

  private async assertUnique(exec: Executor, spec: NumberSpec, companyId: string, value: string, excludeId: string | null) {
    const clash = (await this.valuesForCompany(exec, spec, companyId)).some(
      (row) => row.value === value && row.id !== excludeId,
    );
    if (clash) throw new ApiError('DUPLICATE_NUMBER', `Nummer bereits vergeben: ${value}`);
  }

  /** Assigns a number (assignNumber / variantOf) or checks a client-supplied one. Mutates `set`. */
  async applyOnCreate(exec: Executor, table: TableName, set: Record<string, unknown>, opts: CreateNumberOptions): Promise<void> {
    const spec = numberSpecForTable(table);
    const wantsVariant = typeof opts.variantOf === 'string' && opts.variantOf !== '';
    if (opts.assignNumber || wantsVariant) {
      if (!spec) throw new ApiError('INVALID_REQUEST', 'Diese Tabelle hat keine Belegnummern');
      if (wantsVariant && spec.type !== 'quote') throw new ApiError('INVALID_REQUEST', 'Varianten gibt es nur für Angebote');
      const companyId = companyOf(set);
      if (!companyId) throw new ApiError('INVALID_REQUEST', 'company_id fehlt für die Nummernvergabe');
      set[spec.field] = wantsVariant
        ? await this.nextVariant(exec, companyId, String(opts.variantOf))
        : await this.next(exec, spec, companyId);
      return;
    }
    if (spec && set[spec.field] !== undefined) {
      const companyId = companyOf(set);
      if (companyId) await this.assertUnique(exec, spec, companyId, String(set[spec.field]), null);
    }
  }

  /** Refuses changing a number to one that already exists in the same company. */
  async checkOnUpdate(exec: Executor, table: TableName, existing: StoredRecord, set: Record<string, unknown>): Promise<void> {
    const spec = numberSpecForTable(table);
    if (!spec || set[spec.field] === undefined) return;
    const value = String(set[spec.field]);
    if (value === String(existing.fields[spec.field] ?? '')) return;
    const companyId = companyOf({ ...existing.fields, ...set });
    if (companyId) await this.assertUnique(exec, spec, companyId, value, existing.id);
  }
}

/** GET /numbers/:type/next — preview only, nothing is reserved. */
export function numberRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get('/numbers/:type/next', async (c) => {
    const spec = numberSpecForType(c.req.param('type'));
    if (!spec) throw new ApiError('NOT_FOUND', 'Unbekannter Nummerntyp');
    const companyId = c.req.query('company') ?? '';
    if (!companyId) throw new ApiError('INVALID_REQUEST', 'company fehlt');
    const base = c.req.query('base');
    if (base && spec.type !== 'quote') throw new ApiError('INVALID_REQUEST', 'Varianten gibt es nur für Angebote');
    const number = base
      ? await deps.numbers.nextVariant(deps.db.client, companyId, base)
      : await deps.numbers.next(deps.db.client, spec, companyId);
    return c.json({ number });
  });
  return app;
}
