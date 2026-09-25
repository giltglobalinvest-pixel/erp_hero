import { Hono, type Handler } from 'hono';
import type { Database } from '../db/database.js';
import type { AppDeps } from '../deps.js';
import type { AppEnv, SessionUser } from '../types.js';
import { ApiError } from '../util/errors.js';
import type { RecordStore } from './records.js';
import { isTableName, LOCKABLE_TABLES, type TableName } from './tables.js';

export const LOCK_TTL_MS = 5 * 60 * 1000;

export type LockResult =
  | { ok: true; until: string }
  | { ok: false; locked_by: { id: string; name: string }; until: string };

/** Advisory record locks stored in the record's lock_user_id / lock_until fields (as today). */
export class LockService {
  constructor(
    private readonly db: Database,
    private readonly records: RecordStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** Takes or extends the lock unless another user holds a valid one. */
  acquire(table: TableName, id: string, user: SessionUser): Promise<LockResult> {
    return this.db.write(async (tx) => {
      const record = await this.records.get(table, id, tx);
      if (!record) throw new ApiError('NOT_FOUND', 'Datensatz nicht gefunden');
      const holder = record.fields.lock_user_id;
      const until = Date.parse(String(record.fields.lock_until ?? ''));
      if (typeof holder === 'string' && holder !== '' && holder !== user.id && until > this.now()) {
        const holderRecord = await this.records.get('User', holder, tx);
        const name = typeof holderRecord?.fields.name === 'string' ? holderRecord.fields.name : 'einem anderen Benutzer';
        return { ok: false, locked_by: { id: holder, name }, until: new Date(until).toISOString() };
      }
      const newUntil = new Date(this.now() + LOCK_TTL_MS).toISOString();
      await this.records.update(tx, table, id, { lock_user_id: user.id, lock_until: newUntil }, []);
      return { ok: true, until: newUntil };
    });
  }

  /** Clears the lock if the caller holds it or it has expired. Missing records are fine. */
  release(table: TableName, id: string, user: SessionUser): Promise<void> {
    return this.db.write(async (tx) => {
      const record = await this.records.get(table, id, tx);
      if (!record) return;
      const holder = record.fields.lock_user_id;
      const until = Date.parse(String(record.fields.lock_until ?? ''));
      const expired = !(until > this.now());
      if (holder === undefined || holder === user.id || expired) {
        await this.records.update(tx, table, id, {}, ['lock_user_id', 'lock_until']);
      }
    });
  }
}

function lockableTable(name: string): TableName {
  if (!isTableName(name)) throw new ApiError('NOT_FOUND', `Unbekannte Tabelle: ${name}`);
  if (!LOCKABLE_TABLES.has(name)) throw new ApiError('INVALID_REQUEST', 'Diese Tabelle unterstützt keine Sperren');
  return name;
}

export function lockRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const acquire: Handler<AppEnv> = async (c) =>
    c.json(await deps.locks.acquire(lockableTable(c.req.param('table') ?? ''), c.req.param('id') ?? '', c.get('user')));

  app.post('/locks/:table/:id', acquire);
  app.post('/locks/:table/:id/refresh', acquire);
  // Works with navigator.sendBeacon: the body is ignored.
  app.post('/locks/:table/:id/release', async (c) => {
    await deps.locks.release(lockableTable(c.req.param('table')), c.req.param('id'), c.get('user'));
    return c.json({ ok: true });
  });
  return app;
}
