import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Row } from '@libsql/client';
import { Hono } from 'hono';
import type { Database, Executor } from '../db/database.js';
import type { AppDeps } from '../deps.js';
import { isPlainObject, limit, MB, readJsonBody } from '../http/body.js';
import type { AppEnv } from '../types.js';
import { ApiError } from '../util/errors.js';
import { newAttachmentId } from '../util/ids.js';
import { loadPublicExtras, toPublicRecord } from './public.js';
import { attachmentFieldRule, isTableName, type TableName } from './tables.js';

export const MAX_FILE_BYTES = 5 * MB;

/** Airtable's attachment object shape, pointing at our own download route. */
export interface AttachmentValue {
  id: string;
  url: string;
  filename: string;
  size: number;
  type: string;
}

interface FileRow {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  path: string;
}

const isControlChar = (ch: string): boolean => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f;

export function sanitizeFilename(name: string): string {
  const cleaned = [...name.replace(/[/\\]/g, '_')]
    .filter((ch) => !isControlChar(ch))
    .join('')
    .trim()
    .replace(/^\.+/, '');
  return (cleaned || 'datei').slice(0, 150);
}

const safeContentType = (value: string): string =>
  /^[\w.+-]+\/[\w.+-]+$/.test(value) ? value.toLowerCase() : 'application/octet-stream';

const toRow = (row: Row): FileRow => ({
  id: String(row.id),
  filename: String(row.filename),
  contentType: String(row.content_type),
  size: Number(row.size),
  path: String(row.path),
});

const toValue = (f: FileRow): AttachmentValue => ({
  id: f.id,
  url: `/api/files/${f.id}/${encodeURIComponent(f.filename)}`,
  filename: f.filename,
  size: f.size,
  type: f.contentType,
});

export interface SaveFileInput {
  table: TableName;
  recordId: string;
  field: string;
  filename: string;
  contentType: string;
  data: Buffer;
  createdBy: string;
  /** Keep an existing id (used by the Airtable import). */
  id?: string;
}

export class FileStore {
  constructor(
    private readonly db: Database,
    private readonly dataDir: string,
    private readonly now: () => number = Date.now,
  ) {}

  async save(tx: Executor, input: SaveFileInput): Promise<AttachmentValue> {
    const id = input.id ?? newAttachmentId();
    const filename = sanitizeFilename(input.filename);
    const relative = path.posix.join('files', id, filename);
    await mkdir(path.join(this.dataDir, 'files', id), { recursive: true });
    await writeFile(path.join(this.dataDir, relative), input.data);
    const row: FileRow = { id, filename, contentType: safeContentType(input.contentType), size: input.data.length, path: relative };
    await tx.execute({
      sql: `INSERT INTO files (id, table_name, record_id, field, filename, content_type, size, sha256, path, created_at, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        input.table,
        input.recordId,
        input.field,
        row.filename,
        row.contentType,
        row.size,
        createHash('sha256').update(input.data).digest('hex'),
        relative,
        new Date(this.now()).toISOString(),
        input.createdBy,
      ],
    });
    return toValue(row);
  }

  async get(id: string): Promise<FileRow | null> {
    const rows = await this.db.query('SELECT id, filename, content_type, size, path FROM files WHERE id = ?', [id]);
    return rows[0] ? toRow(rows[0]) : null;
  }

  absolutePath(file: FileRow): string {
    return path.join(this.dataDir, file.path);
  }

  /**
   * Attachment fields may only be written as [{id}, ...] referring to files already
   * uploaded for this record and field. Entries are replaced by the stored metadata.
   */
  async normalizeAttachmentFields(
    exec: Executor,
    table: TableName,
    recordId: string | null,
    set: Record<string, unknown>,
  ): Promise<void> {
    for (const [field, value] of Object.entries(set)) {
      if (!attachmentFieldRule(table, field)) continue;
      if (!Array.isArray(value)) throw new ApiError('VALIDATION_FAILED', `${field}: Liste von Dateien erwartet`);
      const normalized: AttachmentValue[] = [];
      for (const item of value) {
        const id = isPlainObject(item) && typeof item.id === 'string' ? item.id : null;
        const rs = id && recordId
          ? await exec.execute({
              sql: 'SELECT id, filename, content_type, size, path FROM files WHERE id = ? AND table_name = ? AND record_id = ? AND field = ?',
              args: [id, table, recordId, field],
            })
          : null;
        const row = rs?.rows[0];
        if (!row) throw new ApiError('VALIDATION_FAILED', `${field}: unbekannte Datei`);
        normalized.push(toValue(toRow(row)));
      }
      set[field] = normalized;
    }
  }
}

function contentDisposition(file: FileRow): string {
  // SVG is an image type that can carry script, so it is downloaded rather than rendered on our origin.
  const isRasterImage = file.contentType.startsWith('image/') && !file.contentType.startsWith('image/svg');
  const inline = isRasterImage || file.contentType === 'application/pdf';
  const ascii = file.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`;
}

export function fileRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/data/:table/:id/files/:field', limit(7 * MB), async (c) => {
    const tableName = c.req.param('table');
    if (!isTableName(tableName)) throw new ApiError('NOT_FOUND', `Unbekannte Tabelle: ${tableName}`);
    const table: TableName = tableName;
    const { id, field } = c.req.param();
    const rule = attachmentFieldRule(table, field);
    if (!rule) throw new ApiError('INVALID_REQUEST', 'Upload für dieses Feld nicht erlaubt');
    const user = c.get('user');
    if (rule.adminOnly && !user.isAdmin) throw new ApiError('FORBIDDEN', 'Nur für Admins');

    const body = await readJsonBody(c);
    if (typeof body.file !== 'string' || typeof body.filename !== 'string') {
      throw new ApiError('INVALID_REQUEST', 'file und filename erforderlich');
    }
    const data = Buffer.from(body.file, 'base64');
    if (data.length > MAX_FILE_BYTES) throw new ApiError('PAYLOAD_TOO_LARGE', 'Datei zu groß (max 5 MB)');
    const contentType = typeof body.contentType === 'string' ? body.contentType : 'application/octet-stream';

    const record = await deps.db.write(async (tx) => {
      const existing = await deps.records.get(table, id, tx);
      if (!existing) throw new ApiError('NOT_FOUND', 'Datensatz nicht gefunden');
      const saved = await deps.files.save(tx, {
        table,
        recordId: id,
        field,
        filename: body.filename as string,
        contentType,
        data,
        createdBy: user.id,
      });
      const current = Array.isArray(existing.fields[field]) ? (existing.fields[field] as unknown[]) : [];
      return deps.records.update(tx, table, id, { [field]: [...current, saved] }, []);
    });
    if (!record) throw new ApiError('NOT_FOUND', 'Datensatz nicht gefunden');
    return c.json(toPublicRecord(table, record, user, await loadPublicExtras(deps, table, user)));
  });

  app.get('/files/:id/:filename', async (c) => {
    const file = await deps.files.get(c.req.param('id'));
    if (!file) throw new ApiError('NOT_FOUND', 'Datei nicht gefunden');
    const absolute = deps.files.absolutePath(file);
    const info = await stat(absolute).catch(() => null);
    if (!info) throw new ApiError('NOT_FOUND', 'Datei nicht gefunden');
    const stream = Readable.toWeb(createReadStream(absolute)) as ReadableStream<Uint8Array>;
    return new Response(stream, {
      headers: {
        'content-type': file.contentType,
        'content-length': String(info.size),
        'content-disposition': contentDisposition(file),
        'cache-control': 'private, max-age=300',
      },
    });
  });

  return app;
}
