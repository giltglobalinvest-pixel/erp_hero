import { describe, expect, it } from 'vitest';
import {
  isSecretField,
  matchesConditions,
  parseFormula,
  parseMaxRecords,
  parseSort,
  prepareWriteFields,
  projectFields,
  sortRecords,
  stripSecretFields,
} from '../server/data/fields.js';
import type { AirtableRecord } from '../server/types.js';

const rec = (id: string, fields: Record<string, unknown>): AirtableRecord => ({ id, createdTime: 't', fields });

describe('prepareWriteFields', () => {
  it('splits values into set and clear using Airtable empty-value rules', () => {
    const r = prepareWriteFields({ name: 'A', zero: 0, zeroStr: '0', empty: '', no: false, none: null, list: [], links: ['recX'] });
    expect(r.set).toEqual({ name: 'A', zero: 0, zeroStr: '0', links: ['recX'] });
    expect(r.clear.sort()).toEqual(['empty', 'list', 'no', 'none']);
  });

  it('silently ignores lock and derived fields', () => {
    const r = prepareWriteFields({ lock_user_id: 'recU', lock_until: 'x', has_mailchimp_key: true, name: 'B' });
    expect(r.set).toEqual({ name: 'B' });
    expect(r.clear).toEqual([]);
  });

  it('rejects secret fields', () => {
    for (const name of ['api_key', 'freshdesk_api_key', 'freshdesk_keys_json', 'mailchimp_api_key', 'refresh_token', 'password']) {
      expect(() => prepareWriteFields({ [name]: 'x' })).toThrow(/Geheime Felder/);
    }
  });

  it('does not treat token counters as secrets', () => {
    expect(isSecretField('input_tokens')).toBe(false);
    expect(isSecretField('cache_read_input_tokens')).toBe(false);
    expect(prepareWriteFields({ input_tokens: 10, output_tokens: 5 }).set).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it('rejects non-objects and dangerous keys', () => {
    expect(() => prepareWriteFields(['a'])).toThrow(/fields muss ein Objekt sein/);
    expect(() => prepareWriteFields(JSON.parse('{"__proto__": {"x": 1}}'))).toThrow(/Ungültiger Feldname/);
  });

  it('strips secret fields from stored data', () => {
    expect(stripSecretFields({ name: 'A', api_key: 'k', some_secret: 's' })).toEqual({ name: 'A' });
  });
});

describe('parseFormula / matchesConditions', () => {
  it('parses the formula the app uses', () => {
    expect(parseFormula("{status}='aktiv'")).toEqual([{ field: 'status', value: 'aktiv' }]);
  });

  it('parses AND with escaped quotes and double-quoted values', () => {
    expect(parseFormula(`AND({name}='O\\'Brien, GmbH', {status}="aktiv")`)).toEqual([
      { field: 'name', value: "O'Brien, GmbH" },
      { field: 'status', value: 'aktiv' },
    ]);
  });

  it('rejects anything else', () => {
    for (const f of ['FIND("x",{name})', "{a}!='b'", "OR({a}='b',{c}='d')", "{a}='b' AND {c}='d'"]) {
      expect(() => parseFormula(f)).toThrow(/Formel nicht unterstützt/);
    }
  });

  it('matches scalars, arrays (contains) and missing fields', () => {
    const f = { status: 'aktiv', company_id: ['recA', 'recB'], n: 5 };
    expect(matchesConditions(f, [{ field: 'status', value: 'aktiv' }])).toBe(true);
    expect(matchesConditions(f, [{ field: 'company_id', value: 'recB' }])).toBe(true);
    expect(matchesConditions(f, [{ field: 'n', value: '5' }])).toBe(true);
    expect(matchesConditions(f, [{ field: 'missing', value: '' }])).toBe(true);
    expect(matchesConditions(f, [{ field: 'status', value: 'inaktiv' }])).toBe(false);
  });
});

describe('sorting and projection', () => {
  it('sorts German strings with umlauts next to their base letter, case-insensitively, empties last', () => {
    const records = [rec('1', { name: 'Zahnrad' }), rec('2', { name: 'Ärzte AG' }), rec('3', {}), rec('4', { name: 'apfel' })];
    const asc = sortRecords(records, [{ field: 'name', direction: 'asc' }]).map((r) => r.id);
    expect(asc).toEqual(['4', '2', '1', '3']);
    const desc = sortRecords(records, [{ field: 'name', direction: 'desc' }]).map((r) => r.id);
    expect(desc).toEqual(['1', '2', '4', '3']);
  });

  it('sorts numbers numerically and supports multiple keys', () => {
    const records = [rec('a', { g: 'x', n: 10 }), rec('b', { g: 'x', n: 9 }), rec('c', { g: 'a', n: 50 })];
    const out = sortRecords(records, [
      { field: 'g', direction: 'asc' },
      { field: 'n', direction: 'asc' },
    ]).map((r) => r.id);
    expect(out).toEqual(['c', 'b', 'a']);
  });

  it('parses Airtable sort query params', () => {
    const p = new URLSearchParams('sort[0][field]=name&sort[0][direction]=desc&sort[1][field]=created');
    expect(parseSort(p)).toEqual([
      { field: 'name', direction: 'desc' },
      { field: 'created', direction: 'asc' },
    ]);
    expect(() => parseSort(new URLSearchParams('sort[0][field]=a&sort[0][direction]=up'))).toThrow();
  });

  it('projects fields and validates maxRecords', () => {
    expect(projectFields(rec('1', { a: 1, b: 2 }), ['b']).fields).toEqual({ b: 2 });
    expect(parseMaxRecords('3')).toBe(3);
    expect(parseMaxRecords(null)).toBeUndefined();
    expect(() => parseMaxRecords('0')).toThrow();
  });
});
