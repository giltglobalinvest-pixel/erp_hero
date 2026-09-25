import { isPlainObject } from '../http/body.js';
import type { AirtableRecord } from '../types.js';
import { ApiError } from '../util/errors.js';

/** Secret fields that may exist in Airtable data; never stored in records, never returned. */
export const SECRET_FIELD_NAMES: ReadonlySet<string> = new Set([
  'api_key',
  'freshdesk_api_key',
  'freshdesk_keys_json',
  'mailchimp_api_key',
]);
// Anchored at the end on purpose: "input_tokens" / "output_tokens" are NOT secrets.
const SECRET_PATTERN = /(^|_)(api_?key|token|secret|password)$/i;

export const isSecretField = (name: string): boolean => SECRET_FIELD_NAMES.has(name) || SECRET_PATTERN.test(name);

/** Set only by the lock endpoints. */
export const LOCK_FIELDS: ReadonlySet<string> = new Set(['lock_user_id', 'lock_until']);
/** Computed by the server when responding. */
export const DERIVED_FIELDS: ReadonlySet<string> = new Set([
  'has_api_key',
  'has_freshdesk_key',
  'freshdesk_company_keys',
  'has_mailchimp_key',
]);

/** Airtable omits these values, so we drop them too. */
export const isEmptyValue = (v: unknown): boolean =>
  v === null || v === undefined || v === '' || v === false || (Array.isArray(v) && v.length === 0);

export interface WriteFields {
  set: Record<string, unknown>;
  clear: string[];
}

/** Validates a client `fields` object for a create/update. */
export function prepareWriteFields(input: unknown): WriteFields {
  if (!isPlainObject(input)) throw new ApiError('INVALID_REQUEST', 'fields muss ein Objekt sein');
  const set: [string, unknown][] = [];
  const clear: string[] = [];
  for (const [name, value] of Object.entries(input)) {
    if (name.length === 0 || name.length > 200 || name === '__proto__') {
      throw new ApiError('INVALID_REQUEST', 'Ungültiger Feldname');
    }
    if (LOCK_FIELDS.has(name) || DERIVED_FIELDS.has(name)) continue;
    if (isSecretField(name)) throw new ApiError('INVALID_REQUEST', `Geheime Felder nur über Admin-Funktion (${name})`);
    if (isEmptyValue(value)) clear.push(name);
    else set.push([name, value]);
  }
  return { set: Object.fromEntries(set), clear };
}

export function stripSecretFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([name]) => !isSecretField(name)));
}

// ---------- restricted filterByFormula ----------

export interface Condition {
  field: string;
  value: string;
}

const CONDITION = /^\{([^{}]+)\}\s*=\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")$/s;

function parseCondition(text: string): Condition {
  const m = CONDITION.exec(text.trim());
  if (!m || m[1] === undefined) throw new ApiError('INVALID_REQUEST', 'Formel nicht unterstützt');
  const raw = m[2] ?? m[3] ?? '';
  return { field: m[1], value: raw.replace(/\\(.)/gs, '$1') };
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (quote) {
      current += ch;
      if (ch === '\\') {
        current += text.charAt(i + 1);
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '(' || ch === '{') depth++;
    else if (ch === ')' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/** Supports `{field}='value'` and `AND({a}='x', {b}='y')` — the only formulas the app uses. */
export function parseFormula(formula: string): Condition[] {
  const text = formula.trim();
  if (text === '') return [];
  const and = /^AND\s*\((.*)\)$/is.exec(text);
  if (!and || and[1] === undefined) return [parseCondition(text)];
  return splitTopLevel(and[1]).map(parseCondition);
}

export function matchesConditions(fields: Record<string, unknown>, conditions: Condition[]): boolean {
  return conditions.every(({ field, value }) => {
    const v = fields[field];
    if (Array.isArray(v)) return v.some((item) => String(item) === value);
    if (v === undefined || v === null) return value === '';
    return String(v) === value;
  });
}

// ---------- sorting ----------

export interface SortSpec {
  field: string;
  direction: 'asc' | 'desc';
}

export function parseSort(params: URLSearchParams): SortSpec[] {
  const specs: SortSpec[] = [];
  for (let i = 0; params.has(`sort[${i}][field]`); i++) {
    const field = params.get(`sort[${i}][field]`) ?? '';
    const dir = params.get(`sort[${i}][direction]`) ?? 'asc';
    if (!field || (dir !== 'asc' && dir !== 'desc')) throw new ApiError('INVALID_REQUEST', 'Ungültige Sortierung');
    specs.push({ field, direction: dir });
  }
  return specs;
}

const collator = new Intl.Collator('de', { sensitivity: 'base', numeric: true });

function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = Array.isArray(a) ? a.join(', ') : String(a);
  const sb = Array.isArray(b) ? b.join(', ') : String(b);
  return collator.compare(sa, sb);
}

/** Stable sort; empty values always last. */
export function sortRecords(records: AirtableRecord[], specs: SortSpec[]): AirtableRecord[] {
  if (specs.length === 0) return records;
  return [...records].sort((ra, rb) => {
    for (const { field, direction } of specs) {
      const a = ra.fields[field];
      const b = rb.fields[field];
      const ea = isEmptyValue(a);
      const eb = isEmptyValue(b);
      if (ea && eb) continue;
      if (ea) return 1;
      if (eb) return -1;
      const c = compareValues(a, b);
      if (c !== 0) return direction === 'asc' ? c : -c;
    }
    return 0;
  });
}

export function projectFields(record: AirtableRecord, names: string[]): AirtableRecord {
  const wanted = new Set(names);
  return { ...record, fields: Object.fromEntries(Object.entries(record.fields).filter(([k]) => wanted.has(k))) };
}

export function parseMaxRecords(raw: string | null): number | undefined {
  if (raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new ApiError('INVALID_REQUEST', 'maxRecords muss eine positive Zahl sein');
  return n;
}
