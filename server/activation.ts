import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from './http/logger.js';

export const ACTIVATION_MARKER = 'activate-pending';
const DB_FILES = ['erp.db', 'erp.db-wal', 'erp.db-shm'];

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

/** Marks an import staging directory for activation on the next server start. */
export async function scheduleActivation(dataDir: string, stagingDir: string): Promise<string> {
  const staging = path.resolve(stagingDir);
  if (!(await exists(path.join(staging, 'erp.db')))) throw new Error(`No erp.db in ${staging}`);
  await writeFile(path.join(dataDir, ACTIVATION_MARKER), staging);
  return staging;
}

/**
 * Runs at startup BEFORE the database is opened: moves the current database and files
 * into backup-<timestamp>/ and the staged import into place. Never deletes anything.
 */
export async function applyPendingActivation(
  dataDir: string,
  logger: Logger,
  now: Date = new Date(),
): Promise<{ activated: boolean; backupDir?: string }> {
  const marker = path.join(dataDir, ACTIVATION_MARKER);
  const staging = (await readFile(marker, 'utf8').catch(() => '')).trim();
  if (!staging) return { activated: false };
  if (!(await exists(path.join(staging, 'erp.db')))) {
    logger.error({ message: 'activation skipped: staging database missing', staging });
    await rm(marker, { force: true });
    return { activated: false };
  }

  const backupDir = path.join(dataDir, `backup-${now.toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(backupDir, { recursive: true });
  for (const name of [...DB_FILES, 'files']) {
    if (await exists(path.join(dataDir, name))) await rename(path.join(dataDir, name), path.join(backupDir, name));
  }
  for (const name of [...DB_FILES, 'files']) {
    if (await exists(path.join(staging, name))) await rename(path.join(staging, name), path.join(dataDir, name));
  }
  await rm(marker, { force: true });
  logger.info({ message: 'activated imported database', staging, backupDir });
  return { activated: true, backupDir };
}
