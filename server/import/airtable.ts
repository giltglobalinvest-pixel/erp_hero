import type { FetchFn } from '../deps.js';
import { isPlainObject } from '../http/body.js';

export interface AirtableField {
  id: string;
  name: string;
  type: string;
}

export interface AirtableTable {
  id: string;
  name: string;
  fields: AirtableField[];
}

export interface AirtableApiRecord {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
}

export interface AirtableReaderOptions {
  token: string;
  fetch: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** 200 ms between API requests = at most 5 requests/second (Airtable's per-base limit). */
  minIntervalMs?: number;
  /** Airtable asks clients to wait 30 s after a 429. */
  retryWaitMs?: number;
  maxRetries?: number;
}

const API = 'https://api.airtable.com/v0';

/** Read-only Airtable client for the one-time import. It only ever sends GET requests. */
export class AirtableReader {
  private lastRequestAt = Number.NEGATIVE_INFINITY;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly o: AirtableReaderOptions) {
    this.sleep = o.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = o.now ?? Date.now;
  }

  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + (this.o.minIntervalMs ?? 200) - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();
  }

  private async getJson(url: string): Promise<Record<string, unknown>> {
    const maxRetries = this.o.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      const res = await this.o.fetch(url, { method: 'GET', headers: { authorization: `Bearer ${this.o.token}` } });
      if (res.status === 429 && attempt < maxRetries) {
        await this.sleep(this.o.retryWaitMs ?? 30_000);
        continue;
      }
      if (!res.ok) throw new Error(`Airtable GET ${new URL(url).pathname} failed with HTTP ${res.status}`);
      const data: unknown = await res.json();
      if (!isPlainObject(data)) throw new Error(`Airtable GET ${new URL(url).pathname} returned unexpected data`);
      return data;
    }
  }

  async listTables(baseId: string): Promise<AirtableTable[]> {
    const data = await this.getJson(`${API}/meta/bases/${encodeURIComponent(baseId)}/tables`);
    if (!Array.isArray(data.tables)) throw new Error('Airtable schema response has no tables');
    return data.tables as AirtableTable[];
  }

  /** All records of a table, following Airtable's `offset` pagination. */
  async listRecords(baseId: string, table: string, opts: { filterByFormula?: string } = {}): Promise<AirtableApiRecord[]> {
    const records: AirtableApiRecord[] = [];
    let offset: string | undefined;
    do {
      const params = new URLSearchParams({ pageSize: '100' });
      if (opts.filterByFormula) params.set('filterByFormula', opts.filterByFormula);
      if (offset) params.set('offset', offset);
      const data = await this.getJson(`${API}/${encodeURIComponent(baseId)}/${encodeURIComponent(table)}?${params.toString()}`);
      if (!Array.isArray(data.records)) throw new Error(`Airtable table ${table} returned no records array`);
      records.push(...(data.records as AirtableApiRecord[]));
      offset = typeof data.offset === 'string' ? data.offset : undefined;
    } while (offset);
    return records;
  }

  /** Downloads an attachment from its (expiring) Airtable URL. */
  async download(url: string): Promise<{ data: Buffer; contentType: string }> {
    const res = await this.o.fetch(url, { method: 'GET' });
    if (!res.ok) throw new Error(`Download failed with HTTP ${res.status}`);
    return {
      data: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    };
  }
}
