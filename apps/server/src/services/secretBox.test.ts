import { describe, expect, it } from 'vitest';
import { decryptJson, decryptSecret, encryptJson, encryptSecret, safeEqual } from './secretBox.js';

describe('secretBox', () => {
  it('round-trips a secret', () => {
    const secret = 'ghp_averysecrettokenvalue';
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it('round-trips structured credentials', () => {
    const payload = { privateKey: '-----BEGIN KEY-----\nabc\n', passphrase: 'hunter2' };
    expect(decryptJson<typeof payload>(encryptJson(payload))).toEqual(payload);
  });

  it('produces a different envelope every time', () => {
    // A per-record salt and IV mean identical secrets never share ciphertext,
    // so an attacker cannot tell which repositories share a token.
    const first = encryptSecret('same');
    const second = encryptSecret('same');
    expect(first).not.toBe(second);
    expect(decryptSecret(first)).toBe(decryptSecret(second));
  });

  it('rejects a tampered ciphertext rather than returning garbage', () => {
    const envelope = encryptSecret('sensitive');
    const parts = envelope.split('.');
    const corrupted = Buffer.from(parts[4]!, 'base64url');
    corrupted[0] = (corrupted[0]! ^ 0xff) & 0xff;
    parts[4] = corrupted.toString('base64url');

    expect(() => decryptSecret(parts.join('.'))).toThrow();
  });

  it('rejects a malformed envelope', () => {
    expect(() => decryptSecret('not-an-envelope')).toThrow(/Malformed/);
    expect(() => decryptSecret('v2.a.b.c.d')).toThrow(/Malformed/);
  });

  it('handles unicode and long values', () => {
    const value = `${'π'.repeat(500)}\n🔐 done`;
    expect(decryptSecret(encryptSecret(value))).toBe(value);
  });

  it('compares strings safely', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
