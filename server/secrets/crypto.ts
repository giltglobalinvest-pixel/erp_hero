import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** AES-256-GCM; stored as "v1:<iv>:<ciphertext>:<tag>" (base64 parts). */
export function encryptSecret(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), ciphertext.toString('base64'), tag.toString('base64')].join(':');
}

export function decryptSecret(key: Buffer, blob: string): string {
  const [version, iv, ciphertext, tag] = blob.split(':');
  if (version !== 'v1' || iv === undefined || ciphertext === undefined || tag === undefined) {
    throw new Error('Unknown secret format');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}
