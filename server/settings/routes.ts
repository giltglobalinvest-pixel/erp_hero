import { Hono } from 'hono';
import { requireAdmin } from '../auth/middleware.js';
import type { AppDeps } from '../deps.js';
import { readJsonBody } from '../http/body.js';
import type { AppEnv } from '../types.js';
import { ApiError } from '../util/errors.js';
import { deleteSetting, isSettingKey, readSettings, upsertSetting, type SettingKey } from './store.js';

function settingKey(raw: string): SettingKey {
  if (!isSettingKey(raw)) throw new ApiError('INVALID_REQUEST', `Unbekannte Einstellung: ${raw}`);
  return raw;
}

export function settingsRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/settings', async (c) => c.json({ settings: await readSettings(deps.db) }));

  app.put('/settings/:key', requireAdmin, async (c) => {
    const key = settingKey(c.req.param('key'));
    const body = await readJsonBody(c);
    if (typeof body.value !== 'string' || body.value.length > 2000) {
      throw new ApiError('INVALID_REQUEST', 'value muss ein Text (max. 2000 Zeichen) sein');
    }
    const value = body.value.trim();
    await deps.db.write((tx) =>
      value === ''
        ? deleteSetting(tx, key)
        : upsertSetting(tx, key, value, c.get('user').id, new Date(deps.now()).toISOString()),
    );
    return c.json({ settings: await readSettings(deps.db) });
  });

  app.delete('/settings/:key', requireAdmin, async (c) => {
    const key = settingKey(c.req.param('key'));
    await deps.db.write((tx) => deleteSetting(tx, key));
    return c.json({ settings: await readSettings(deps.db) });
  });

  return app;
}
