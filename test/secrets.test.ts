import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashLoginKey, verifyLoginKey } from '../server/auth/passwords.js';
import { openDatabase, type Database } from '../server/db/database.js';
import { runMigrations } from '../server/db/migrations.js';
import { decryptSecret, encryptSecret } from '../server/secrets/crypto.js';
import { SecretStore } from '../server/secrets/store.js';

const KEY = Buffer.alloc(32, 9);

describe('encryptSecret / decryptSecret', () => {
  it('round-trips and uses a fresh IV each time', () => {
    const a = encryptSecret(KEY, 'fd-key-123');
    const b = encryptSecret(KEY, 'fd-key-123');
    expect(a).not.toBe(b);
    expect(a.startsWith('v1:')).toBe(true);
    expect(a).not.toContain('fd-key-123');
    expect(decryptSecret(KEY, a)).toBe('fd-key-123');
  });

  it('fails with the wrong key or tampered data', () => {
    const blob = encryptSecret(KEY, 'x');
    expect(() => decryptSecret(Buffer.alloc(32, 1), blob)).toThrow();
    const parts = blob.split(':');
    parts[2] = Buffer.from('tampered').toString('base64');
    expect(() => decryptSecret(KEY, parts.join(':'))).toThrow();
  });
});

describe('login key hashing', () => {
  it('verifies the right key and rejects others', async () => {
    const stored = await hashLoginKey('abcdefghijklmnopqrstuvwx');
    expect(stored).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(stored).not.toContain('abcdefghijklmnopqrstuvwx');
    expect(await verifyLoginKey('abcdefghijklmnopqrstuvwx', stored)).toBe(true);
    expect(await verifyLoginKey('abcdefghijklmnopqrstuvwy', stored)).toBe(false);
    expect(await verifyLoginKey('x', 'garbage')).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashLoginKey('same-key-same-key')).not.toBe(await hashLoginKey('same-key-same-key'));
  });
});

describe('SecretStore', () => {
  let dir: string;
  let db: Database;
  let store: SecretStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'erp-sec-'));
    db = await openDatabase(path.join(dir, 'erp.db'));
    await runMigrations(db);
    store = new SecretStore(db, KEY);
  });
  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('reports nothing for unknown users', async () => {
    expect(await store.userInfo('recU')).toEqual({ hasApiKey: false, hasFreshdeskKey: false, freshdeskCompanyKeys: [] });
    expect(await store.freshdeskKeyFor('recU', 'recC')).toBeNull();
  });

  it('stores api key hashes', async () => {
    await db.write((tx) => store.setApiKeyHash(tx, 'recU', 'scrypt$hash'));
    expect((await store.apiKeyHashes()).get('recU')).toBe('scrypt$hash');
    expect((await store.userInfo('recU')).hasApiKey).toBe(true);
    await db.write((tx) => store.setApiKeyHash(tx, 'recU', null));
    expect((await store.apiKeyHashes()).has('recU')).toBe(false);
  });

  it('selects the per-company Freshdesk key, then the default', async () => {
    await db.write(async (tx) => {
      await store.setFreshdeskDefault(tx, 'recU', 'default-key');
      await store.mergeFreshdeskKeys(tx, 'recU', { recC1: 'company-1-key', recC2: 'company-2-key' });
    });
    expect(await store.freshdeskKeyFor('recU', 'recC1')).toBe('company-1-key');
    expect(await store.freshdeskKeyFor('recU', 'recC9')).toBe('default-key');
    expect(await store.freshdeskKeyFor('recU', null)).toBe('default-key');
    expect(await store.userInfo('recU')).toEqual({
      hasApiKey: false,
      hasFreshdeskKey: true,
      freshdeskCompanyKeys: ['recC1', 'recC2'],
    });
    const raw = await db.query('SELECT freshdesk_api_key_enc, freshdesk_keys_enc FROM user_secrets');
    expect(JSON.stringify(raw)).not.toContain('company-1-key');
  });

  it('merges company keys: null removes, other companies stay', async () => {
    await db.write((tx) => store.mergeFreshdeskKeys(tx, 'recU', { recC1: 'a', recC2: 'b' }));
    await db.write((tx) => store.mergeFreshdeskKeys(tx, 'recU', { recC1: null, recC3: 'c' }));
    expect((await store.userInfo('recU')).freshdeskCompanyKeys).toEqual(['recC2', 'recC3']);
    expect((await store.allUserInfo()).get('recU')?.freshdeskCompanyKeys).toEqual(['recC2', 'recC3']);
  });

  it('treats values stored under a previous SECRETS_KEY as absent, reports each once, and lets admins overwrite them', async () => {
    const previous = new SecretStore(db, Buffer.alloc(32, 1));
    await db.write(async (tx) => {
      await previous.setApiKeyHash(tx, 'recU', 'scrypt$hash');
      await previous.setFreshdeskDefault(tx, 'recU', 'old-default');
      await previous.mergeFreshdeskKeys(tx, 'recU', { recC1: 'old-c1' });
      await previous.setMailchimpKey(tx, 'recC1', 'old-mc-us21');
    });
    const reported: string[] = [];
    const current = new SecretStore(db, KEY, (ref) => reported.push(ref));
    expect(await current.userInfo('recU')).toEqual({ hasApiKey: true, hasFreshdeskKey: false, freshdeskCompanyKeys: [] });
    expect(await current.freshdeskKeyFor('recU', 'recC1')).toBeNull();
    expect(await current.mailchimpKey('recC1')).toBeNull();
    expect([...(await current.companiesWithMailchimpKey())]).toEqual([]);
    expect((await current.allUserInfo()).get('recU')?.freshdeskCompanyKeys).toEqual([]);

    await db.write((tx) => current.mergeFreshdeskKeys(tx, 'recU', { recC2: 'new-c2' }));
    await db.write((tx) => current.setMailchimpKey(tx, 'recC1', 'new-mc-us21'));
    expect(await current.freshdeskKeyFor('recU', 'recC2')).toBe('new-c2');
    expect(await current.mailchimpKey('recC1')).toBe('new-mc-us21');

    expect(reported.length).toBeGreaterThan(0);
    expect(new Set(reported).size).toBe(reported.length);
    expect(reported.join(' ')).toContain('recU');
    expect(reported.join(' ')).toContain('recC1');
    expect(reported.join(' ')).not.toMatch(/old-|v1:/);
  });

  it('stores Mailchimp keys per company', async () => {
    await db.write((tx) => store.setMailchimpKey(tx, 'recC1', 'mc-key-us21'));
    expect(await store.mailchimpKey('recC1')).toBe('mc-key-us21');
    expect([...(await store.companiesWithMailchimpKey())]).toEqual(['recC1']);
    await db.write((tx) => store.setMailchimpKey(tx, 'recC1', null));
    expect(await store.mailchimpKey('recC1')).toBeNull();
  });
});
