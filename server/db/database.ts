import { createClient, type Client, type InArgs, type InStatement, type ResultSet, type Row, type Transaction } from '@libsql/client';
import { Mutex } from '../util/mutex.js';

/** Anything that can run a statement: the client or an open transaction. */
export interface Executor {
  execute(stmt: InStatement): Promise<ResultSet>;
}

export interface Database {
  readonly client: Client;
  /** Read query on committed data. */
  query(sql: string, args?: InArgs): Promise<Row[]>;
  /**
   * Runs fn inside one SQLite write transaction. Write transactions are queued
   * in-process, so they never overlap (libsql cannot hold two open at once).
   */
  write<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  close(): void;
}

export async function openDatabase(filePath: string): Promise<Database> {
  const client = createClient({ url: `file:${filePath}` });
  await client.execute('PRAGMA journal_mode = WAL');
  await client.execute('PRAGMA busy_timeout = 5000');
  const mutex = new Mutex();

  return {
    client,
    async query(sql, args = []) {
      const rs = await client.execute({ sql, args });
      return rs.rows;
    },
    write(fn) {
      return mutex.run(async () => {
        // The transaction takes over the client's current connection, so set the
        // busy timeout on it first (matters only if a CLI writes at the same time).
        await client.execute('PRAGMA busy_timeout = 5000');
        const tx = await client.transaction('write');
        try {
          const result = await fn(tx);
          await tx.commit();
          return result;
        } catch (err) {
          await tx.rollback().catch(() => undefined);
          throw err;
        } finally {
          tx.close();
        }
      });
    },
    close() {
      client.close();
    },
  };
}
