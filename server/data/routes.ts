import { Hono, type Context } from 'hono';
import type { AppDeps } from '../deps.js';
import { limit, MB, readJsonBody } from '../http/body.js';
import type { AppEnv } from '../types.js';
import { ApiError } from '../util/errors.js';
import {
  matchesConditions,
  parseFormula,
  parseMaxRecords,
  parseSort,
  prepareWriteFields,
  projectFields,
  sortRecords,
} from './fields.js';
import { assertCanRead, assertCanWrite } from './permissions.js';
import { loadPublicExtras, toPublicRecord } from './public.js';
import type { StoredRecord } from './records.js';
import { isTableName, type TableName } from './tables.js';

export function tableParam(c: Context<AppEnv>): TableName {
  const table = c.req.param('table') ?? '';
  if (!isTableName(table)) throw new ApiError('NOT_FOUND', `Unbekannte Tabelle: ${table}`);
  return table;
}

export function dataRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const present = async (c: Context<AppEnv>, table: TableName, record: StoredRecord) => {
    const user = c.get('user');
    return toPublicRecord(table, record, user, await loadPublicExtras(deps, table, user));
  };

  app.get('/data/:table', async (c) => {
    const table = tableParam(c);
    const user = c.get('user');
    assertCanRead(table, user);
    const params = new URL(c.req.url).searchParams;
    const conditions = parseFormula(params.get('filterByFormula') ?? '');
    const sorts = parseSort(params);
    const maxRecords = parseMaxRecords(params.get('maxRecords'));
    const onlyFields = params.getAll('fields[]');

    const extras = await loadPublicExtras(deps, table, user);
    // Filter and sort on the public view, so hidden fields can never be probed.
    let records = (await deps.records.list(table)).map((r) => toPublicRecord(table, r, user, extras));
    records = sortRecords(
      records.filter((r) => matchesConditions(r.fields, conditions)),
      sorts,
    );
    if (maxRecords !== undefined) records = records.slice(0, maxRecords);
    if (onlyFields.length > 0) records = records.map((r) => projectFields(r, onlyFields));
    return c.json({ records });
  });

  app.get('/data/:table/:id', async (c) => {
    const table = tableParam(c);
    assertCanRead(table, c.get('user'));
    const record = await deps.records.get(table, c.req.param('id'));
    if (!record) throw new ApiError('NOT_FOUND', 'Datensatz nicht gefunden');
    return c.json(await present(c, table, record));
  });

  app.post('/data/:table', limit(5 * MB), async (c) => {
    const table = tableParam(c);
    assertCanWrite(table, c.get('user'), 'create');
    const body = await readJsonBody(c);
    const { set } = prepareWriteFields(body.fields ?? {});
    const record = await deps.db.write((tx) => deps.records.insert(tx, table, set));
    return c.json(await present(c, table, record));
  });

  app.patch('/data/:table/:id', limit(5 * MB), async (c) => {
    const table = tableParam(c);
    assertCanWrite(table, c.get('user'), 'update');
    const id = c.req.param('id');
    const body = await readJsonBody(c);
    const { set, clear } = prepareWriteFields(body.fields ?? {});
    const record = await deps.db.write((tx) => deps.records.update(tx, table, id, set, clear));
    if (!record) throw new ApiError('NOT_FOUND', 'Datensatz nicht gefunden');
    return c.json(await present(c, table, record));
  });

  app.delete('/data/:table/:id', async (c) => {
    const table = tableParam(c);
    assertCanWrite(table, c.get('user'), 'delete');
    const id = c.req.param('id');
    const removed = await deps.db.write((tx) => deps.records.remove(tx, table, id));
    if (!removed) throw new ApiError('NOT_FOUND', 'Datensatz nicht gefunden');
    return c.json({ id, deleted: true });
  });

  // ensureTable / ensureFields are no-ops: every known table exists and fields need no schema.
  app.post('/schema/ensure-table', async (c) => {
    const body = await readJsonBody(c);
    if (typeof body.name !== 'string' || !isTableName(body.name)) {
      throw new ApiError('NOT_FOUND', 'Unbekannte Tabelle');
    }
    return c.json({ ok: true });
  });

  app.post('/schema/ensure-fields', async (c) => {
    const body = await readJsonBody(c);
    if (typeof body.table !== 'string' || !isTableName(body.table)) {
      throw new ApiError('NOT_FOUND', 'Unbekannte Tabelle');
    }
    return c.json({ ok: true });
  });

  return app;
}
