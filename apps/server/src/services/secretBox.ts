import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { config } from '../config.js';

/**
 * Authenticated encryption for git credentials at rest.
 *
 * Envelope format: `v1.<salt>.<iv>.<authTag>.<ciphertext>`, all base64url. The
 * per-record salt means two identical tokens encrypt differently and a leaked
 * derived key compromises only one record.
 */

const VERSION = 'v1';
const KEY_LEN = 32;
const IV_LEN = 12;

function deriveKey(salt: Buffer): Buffer {
  return scryptSync(config.credentialSecret, salt, KEY_LEN);
}

export function encryptSecret(plaintext: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(salt), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    VERSION,
    salt.toString('base64url'),
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptSecret(envelope: string): string {
  const parts = envelope.split('.');
  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new Error('Malformed credential envelope');
  }
  const [, saltB64, ivB64, tagB64, dataB64] = parts;
  const salt = Buffer.from(saltB64!, 'base64url');
  const iv = Buffer.from(ivB64!, 'base64url');
  const authTag = Buffer.from(tagB64!, 'base64url');
  const ciphertext = Buffer.from(dataB64!, 'base64url');

  const decipher = createDecipheriv('aes-256-gcm', deriveKey(salt), iv);
  decipher.setAuthTag(authTag);
  // Throws if the tag does not verify, which is exactly what we want: a wrong
  // TEAMAGENTS_SECRET must fail loudly rather than yield garbage.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function encryptJson(value: unknown): string {
  return encryptSecret(JSON.stringify(value));
}

export function decryptJson<T>(envelope: string): T {
  return JSON.parse(decryptSecret(envelope)) as T;
}

/** Constant-time string comparison, for comparing opaque tokens. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
