import { mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { create } from 'tar';
import { TABLE_NAMES } from '../data/tables.js';
import type { RecordStore } from '../data/records.js';
import type { Database } from '../db/database.js';

const TMP_PREFIX = 'tmp-backup-';

export interface BackupArchive {
  file: string;
  filename: string;
  cleanup: () => Promise<void>;
}

/**
 * Removes archive directories left behind by downloads the server could not finish (e.g. a crash
 * mid-download). Only for startup: while the server runs, such a directory may belong to a download in
 * progress. Only `tmp-backup-*` is touched; `backup-<timestamp>/` holds the pre-activation database.
 */
export async function sweepStaleBackupDirs(dataDir: string): Promise<string[]> {
  const removed: string[] = [];
  for (const entry of await readdir(dataDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(TMP_PREFIX)) continue;
    await rm(path.join(dataDir, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}

/**
 * Consistent snapshot of the database (VACUUM INTO) plus all uploaded files and a
 * manifest, packed as .tar.gz in a temp dir on the same volume. Call cleanup() when done.
 */
export async function createBackupArchive(db: Database, records: RecordStore, dataDir: string, now: Date): Promise<BackupArchive> {
  const tmp = await mkdtemp(path.join(dataDir, TMP_PREFIX));
  try {
    await db.client.execute({ sql: 'VACUUM INTO ?', args: [path.join(tmp, 'erp.db')] });
    const tables: Record<string, number> = {};
    for (const table of TABLE_NAMES) tables[table] = await records.count(table);
    await writeFile(path.join(tmp, 'manifest.json'), JSON.stringify({ created_at: now.toISOString(), tables }, null, 2));

    const entries = ['erp.db', 'manifest.json'];
    const filesDir = path.join(dataDir, 'files');
    if (await stat(filesDir).catch(() => null)) {
      await symlink(filesDir, path.join(tmp, 'files'), 'dir');
      entries.push('files');
    }
    const filename = `erp-backup-${now.toISOString().replace(/[:.]/g, '-')}.tar.gz`;
    const file = path.join(tmp, filename);
    await create({ gzip: true, cwd: tmp, file, follow: true, portable: true }, entries);
    return { file, filename, cleanup: () => rm(tmp, { recursive: true, force: true }) };
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }
}
