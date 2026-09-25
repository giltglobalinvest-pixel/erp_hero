import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { requireAdmin } from '../auth/middleware.js';
import { hashLoginKey, verifyLoginKey } from '../auth/passwords.js';
import type { AppDeps } from '../deps.js';
import { isPlainObject, readJsonBody } from '../http/body.js';
import type { AppEnv } from '../types.js';
import { ApiError } from '../util/errors.js';
import { newLoginKey } from '../util/ids.js';
import { createBackupArchive } from './backup.js';

const optionalSecret = (value: unknown, name: string): string | null => {
  if (value === null) return null;
  if (typeof value !== 'string') throw new ApiError('INVALID_REQUEST', `${name} muss Text oder null sein`);
  return value.trim() === '' ? null : value.trim();
};

async function keyInUseByOther(deps: AppDeps, key: string, userId: string): Promise<boolean> {
  for (const [otherId, hash] of await deps.secrets.apiKeyHashes()) {
    if (otherId !== userId && (await verifyLoginKey(key, hash))) return true;
  }
  return false;
}

/** Mounted at /api/admin. Everything here is admin-only. */
export function adminRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', requireAdmin);

  app.patch('/users/:id/secrets', async (c) => {
    const userId = c.req.param('id');
    if (!(await deps.records.get('User', userId))) throw new ApiError('NOT_FOUND', 'Benutzer nicht gefunden');
    const body = await readJsonBody(c);

    let newKey: string | null | undefined;
    let generated = false;
    if (body.generate_api_key === true) {
      newKey = newLoginKey();
      generated = true;
    } else if (body.api_key === null) {
      newKey = null;
    } else if (body.api_key !== undefined) {
      if (typeof body.api_key !== 'string' || body.api_key.trim().length < 12) {
        throw new ApiError('VALIDATION_FAILED', 'Login-Key muss mindestens 12 Zeichen haben');
      }
      newKey = body.api_key.trim();
    }
    if (newKey && (await keyInUseByOther(deps, newKey, userId))) {
      throw new ApiError('KEY_IN_USE', 'Dieser Login-Key wird bereits verwendet');
    }
    const hash = newKey ? await hashLoginKey(newKey) : null;

    let companyPatch: Record<string, string | null> | undefined;
    if (body.freshdesk_keys !== undefined) {
      if (!isPlainObject(body.freshdesk_keys)) throw new ApiError('INVALID_REQUEST', 'freshdesk_keys muss ein Objekt sein');
      companyPatch = Object.fromEntries(
        Object.entries(body.freshdesk_keys).map(([companyId, v]) => [companyId, optionalSecret(v, 'freshdesk_keys')]),
      );
    }
    const defaultKey = body.freshdesk_api_key === undefined ? undefined : optionalSecret(body.freshdesk_api_key, 'freshdesk_api_key');

    await deps.db.write(async (tx) => {
      if (newKey !== undefined) await deps.secrets.setApiKeyHash(tx, userId, hash);
      if (defaultKey !== undefined) await deps.secrets.setFreshdeskDefault(tx, userId, defaultKey);
      if (companyPatch) await deps.secrets.mergeFreshdeskKeys(tx, userId, companyPatch);
    });

    const info = await deps.secrets.userInfo(userId);
    return c.json({
      ...(generated && newKey ? { api_key: newKey } : {}),
      has_api_key: info.hasApiKey,
      has_freshdesk_key: info.hasFreshdeskKey,
      freshdesk_company_keys: info.freshdeskCompanyKeys,
    });
  });

  app.patch('/companies/:id/secrets', async (c) => {
    const companyId = c.req.param('id');
    if (!(await deps.records.get('Company', companyId))) throw new ApiError('NOT_FOUND', 'Firma nicht gefunden');
    const body = await readJsonBody(c);
    if (body.mailchimp_api_key === undefined) throw new ApiError('INVALID_REQUEST', 'mailchimp_api_key fehlt');
    const key = optionalSecret(body.mailchimp_api_key, 'mailchimp_api_key');
    await deps.db.write((tx) => deps.secrets.setMailchimpKey(tx, companyId, key));
    return c.json({ has_mailchimp_key: key !== null });
  });

  app.get('/backup', async () => {
    const archive = await createBackupArchive(deps.db, deps.records, deps.config.dataDir, new Date(deps.now()));
    const { size } = await stat(archive.file);
    const stream = createReadStream(archive.file);
    stream.on('close', () => void archive.cleanup());
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      headers: {
        'content-type': 'application/gzip',
        'content-length': String(size),
        'content-disposition': `attachment; filename="${archive.filename}"`,
        'cache-control': 'no-store',
      },
    });
  });

  return app;
}
