import { randomBytes, randomInt } from 'node:crypto';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const LOWER_ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomString(alphabet: string, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet.charAt(randomInt(alphabet.length));
  return out;
}

/** Airtable-style record id: "rec" + 14 alphanumerics. */
export const newRecordId = (): string => 'rec' + randomString(ALNUM, 14);
/** Airtable-style attachment id: "att" + 14 alphanumerics. */
export const newAttachmentId = (): string => 'att' + randomString(ALNUM, 14);
/** Login key in the format the old app generated: 24 chars [a-z0-9], unbiased. */
export const newLoginKey = (): string => randomString(LOWER_ALNUM, 24);
/** Opaque session token for the cookie. */
export const newSessionToken = (): string => randomBytes(32).toString('base64url');

export const isRecordId = (value: unknown): value is string =>
  typeof value === 'string' && /^rec[A-Za-z0-9]{14}$/.test(value);
