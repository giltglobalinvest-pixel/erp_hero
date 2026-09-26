import { access, mkdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from './http/logger.js';

export const ACTIVATION_MARKER = 'activate-pending';
const DB_FILES = ['erp.db', 'erp.db-wal', 'erp.db-shm'];

/** The file operations the swap uses; injectable so tests can make one of them fail. */
export interface ActivationFs {
  rename: (from: string, to: string) => Promise<void>;
}

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

/** Renaming only works within one filesystem, so the staging dir must live on the same device as DATA_DIR. */
const sameDevice = async (dataDir: string, staging: string): Promise<boolean> => (await stat(dataDir)).dev === (await stat(staging)).dev;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Marks an import staging directory for activation on the next server start. */
export async function scheduleActivation(dataDir: string, stagingDir: string): Promise<string> {
  const staging = path.resolve(stagingDir);
  if (!(await exists(path.join(staging, 'erp.db')))) throw new Error(`No erp.db in ${staging}`);
  if (!(await sameDevice(dataDir, staging))) {
    throw new Error(
      `${staging} is on a different filesystem than ${dataDir}, so it cannot be moved into place. ` +
        `Stage the import inside ${dataDir}: run the import without --staging (its default target is ${dataDir}/import-<timestamp>), ` +
        `or copy the directory there first.`,
    );
  }
  await writeFile(path.join(dataDir, ACTIVATION_MARKER), staging);
  return staging;
}

/**
 * Runs at startup BEFORE the database is opened: moves the current database and files
 * into backup-<timestamp>/ and the staged import into place. Never deletes anything.
 * If any step fails, everything already moved is put back and the previous database is kept.
 */
export async function applyPendingActivation(
  dataDir: string,
  logger: Logger,
  now: Date = new Date(),
  fs: ActivationFs = { rename },
): Promise<{ activated: boolean; backupDir?: string }> {
  const marker = path.join(dataDir, ACTIVATION_MARKER);
  const staging = (await readFile(marker, 'utf8').catch(() => '')).trim();
  if (!staging) return { activated: false };
  if (!(await exists(path.join(staging, 'erp.db')))) {
    logger.error({ message: 'activation skipped: staging database missing', staging });
    await rm(marker, { force: true });
    return { activated: false };
  }
  // The marker may be old or written by hand, so the check from scheduleActivation is repeated here.
  if (!(await sameDevice(dataDir, staging))) {
    logger.error({ message: 'activation skipped: staging directory is on another filesystem, previous database kept', staging });
    await rm(marker, { force: true });
    return { activated: false };
  }

  const backupDir = path.join(dataDir, `backup-${now.toISOString().replace(/[:.]/g, '-')}`);
  const moved: [from: string, to: string][] = [];
  const move = async (from: string, to: string) => {
    await fs.rename(from, to);
    moved.push([from, to]);
  };
  try {
    await mkdir(backupDir, { recursive: true });
    for (const name of [...DB_FILES, 'files']) {
      if (await exists(path.join(dataDir, name))) await move(path.join(dataDir, name), path.join(backupDir, name));
    }
    for (const name of [...DB_FILES, 'files']) {
      if (await exists(path.join(staging, name))) await move(path.join(staging, name), path.join(dataDir, name));
    }
  } catch (err) {
    // Undo in reverse order. A rollback step that fails is only logged: the data stays where it is, never deleted.
    for (const [from, to] of moved.reverse()) {
      await fs.rename(to, from).catch((e: unknown) => {
        logger.error({ message: 'activation rollback: entry could not be moved back, restore it by hand', from: to, to: from, error: errorMessage(e) });
      });
    }
    // Only an empty backup dir is removed; a failed rollback step may have left data in it.
    await rmdir(backupDir).catch(() => undefined);
    await rm(marker, { force: true });
    logger.error({ message: 'activation failed, previous database kept', staging, error: errorMessage(err) });
    return { activated: false };
  }
  await rm(marker, { force: true });
  logger.info({ message: 'activated imported database', staging, backupDir });
  return { activated: true, backupDir };
}
