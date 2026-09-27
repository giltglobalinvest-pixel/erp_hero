import { createHash } from 'node:crypto';
import type { Database } from '../db/database.js';
import { newSessionToken } from '../util/ids.js';

export const SHORT_TTL_MS = 8 * 60 * 60 * 1000;
export const LONG_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export interface SessionInfo {
  tokenHash: string;
  userId: string;
  expiresAt: number;
}

/** Sessions are stored by token hash only; the token itself lives only in the cookie. */
export class SessionStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  async create(userId: string, longLived: boolean, userAgent: string): Promise<{ token: string; ttlMs: number }> {
    const token = newSessionToken();
    const ttlMs = longLived ? LONG_TTL_MS : SHORT_TTL_MS;
    const now = this.now();
    await this.db.write((tx) =>
      tx.execute({
        sql: 'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, long_lived, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
        args: [hashToken(token), userId, now, now + ttlMs, longLived ? 1 : 0, userAgent.slice(0, 200)],
      }),
    );
    return { token, ttlMs };
  }

  /** Returns the session if it exists and has not expired (expired ones are deleted). */
  async lookup(token: string): Promise<SessionInfo | null> {
    const tokenHash = hashToken(token);
    const rows = await this.db.query('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?', [tokenHash]);
    const row = rows[0];
    if (!row) return null;
    const expiresAt = Number(row.expires_at);
    if (expiresAt <= this.now()) {
      await this.delete(tokenHash);
      return null;
    }
    return { tokenHash, userId: String(row.user_id), expiresAt };
  }

  async delete(tokenHash: string): Promise<void> {
    await this.db.write((tx) => tx.execute({ sql: 'DELETE FROM sessions WHERE token_hash = ?', args: [tokenHash] }));
  }

  async deleteForUser(userId: string): Promise<number> {
    const rs = await this.db.write((tx) => tx.execute({ sql: 'DELETE FROM sessions WHERE user_id = ?', args: [userId] }));
    return rs.rowsAffected;
  }

  async purgeExpired(): Promise<number> {
    const rs = await this.db.write((tx) =>
      tx.execute({ sql: 'DELETE FROM sessions WHERE expires_at <= ?', args: [this.now()] }),
    );
    return rs.rowsAffected;
  }
}
