import type { Row } from '@libsql/client';
import type { Database, Executor } from '../db/database.js';
import { isPlainObject } from '../http/body.js';
import { decryptSecret, encryptSecret } from './crypto.js';

export interface UserSecretInfo {
  hasApiKey: boolean;
  hasFreshdeskKey: boolean;
  /** Company ids for which the user has a personal Freshdesk key. */
  freshdeskCompanyKeys: string[];
}

type UserColumn = 'api_key_hash' | 'freshdesk_api_key_enc' | 'freshdesk_keys_enc';

const present = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** Login-key hashes and encrypted third-party keys. Nothing here is ever sent to a browser. */
export class SecretStore {
  constructor(
    private readonly db: Database,
    private readonly key: Buffer,
  ) {}

  private async userRow(userId: string, exec: Executor = this.db.client): Promise<Row | undefined> {
    const rs = await exec.execute({
      sql: 'SELECT user_id, api_key_hash, freshdesk_api_key_enc, freshdesk_keys_enc FROM user_secrets WHERE user_id = ?',
      args: [userId],
    });
    return rs.rows[0];
  }

  private decryptMap(enc: unknown): Record<string, string> {
    if (!present(enc)) return {};
    const parsed: unknown = JSON.parse(decryptSecret(this.key, enc));
    if (!isPlainObject(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => present(entry[1])),
    );
  }

  private toInfo(row: Row | undefined): UserSecretInfo {
    return {
      hasApiKey: present(row?.api_key_hash),
      hasFreshdeskKey: present(row?.freshdesk_api_key_enc),
      freshdeskCompanyKeys: Object.keys(this.decryptMap(row?.freshdesk_keys_enc)).sort(),
    };
  }

  private async upsertUser(tx: Executor, userId: string, column: UserColumn, value: string | null): Promise<void> {
    await tx.execute({
      sql: `INSERT INTO user_secrets (user_id, ${column}) VALUES (?, ?)
            ON CONFLICT(user_id) DO UPDATE SET ${column} = excluded.${column}`,
      args: [userId, value],
    });
  }

  async userInfo(userId: string): Promise<UserSecretInfo> {
    return this.toInfo(await this.userRow(userId));
  }

  async allUserInfo(): Promise<Map<string, UserSecretInfo>> {
    const rows = await this.db.query(
      'SELECT user_id, api_key_hash, freshdesk_api_key_enc, freshdesk_keys_enc FROM user_secrets',
    );
    return new Map(rows.map((row) => [String(row.user_id), this.toInfo(row)]));
  }

  /** userId -> scrypt hash, for users that have a login key. */
  async apiKeyHashes(): Promise<Map<string, string>> {
    const rows = await this.db.query(
      "SELECT user_id, api_key_hash FROM user_secrets WHERE api_key_hash IS NOT NULL AND api_key_hash <> ''",
    );
    return new Map(rows.map((row) => [String(row.user_id), String(row.api_key_hash)]));
  }

  setApiKeyHash(tx: Executor, userId: string, hash: string | null): Promise<void> {
    return this.upsertUser(tx, userId, 'api_key_hash', hash);
  }

  setFreshdeskDefault(tx: Executor, userId: string, apiKey: string | null): Promise<void> {
    return this.upsertUser(tx, userId, 'freshdesk_api_key_enc', apiKey ? encryptSecret(this.key, apiKey) : null);
  }

  /** Merges per-company Freshdesk keys; null removes a company's key. */
  async mergeFreshdeskKeys(tx: Executor, userId: string, patch: Record<string, string | null>): Promise<void> {
    const map = this.decryptMap((await this.userRow(userId, tx))?.freshdesk_keys_enc);
    for (const [companyId, apiKey] of Object.entries(patch)) {
      if (apiKey) map[companyId] = apiKey;
      else delete map[companyId];
    }
    const enc = Object.keys(map).length > 0 ? encryptSecret(this.key, JSON.stringify(map)) : null;
    await this.upsertUser(tx, userId, 'freshdesk_keys_enc', enc);
  }

  /** The user's key for companyId if given and present, else the user's default key. */
  async freshdeskKeyFor(userId: string, companyId: string | null): Promise<string | null> {
    const row = await this.userRow(userId);
    if (companyId) {
      const companyKey = this.decryptMap(row?.freshdesk_keys_enc)[companyId];
      if (companyKey) return companyKey;
    }
    return present(row?.freshdesk_api_key_enc) ? decryptSecret(this.key, row.freshdesk_api_key_enc) : null;
  }

  async companiesWithMailchimpKey(): Promise<Set<string>> {
    const rows = await this.db.query(
      "SELECT company_id FROM company_secrets WHERE mailchimp_api_key_enc IS NOT NULL AND mailchimp_api_key_enc <> ''",
    );
    return new Set(rows.map((row) => String(row.company_id)));
  }

  async mailchimpKey(companyId: string): Promise<string | null> {
    const rows = await this.db.query('SELECT mailchimp_api_key_enc FROM company_secrets WHERE company_id = ?', [
      companyId,
    ]);
    const enc = rows[0]?.mailchimp_api_key_enc;
    return present(enc) ? decryptSecret(this.key, enc) : null;
  }

  async setMailchimpKey(tx: Executor, companyId: string, apiKey: string | null): Promise<void> {
    await tx.execute({
      sql: `INSERT INTO company_secrets (company_id, mailchimp_api_key_enc) VALUES (?, ?)
            ON CONFLICT(company_id) DO UPDATE SET mailchimp_api_key_enc = excluded.mailchimp_api_key_enc`,
      args: [companyId, apiKey ? encryptSecret(this.key, apiKey) : null],
    });
  }
}
