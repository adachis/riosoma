import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  encodeEnvelope,
  localKey,
  openEnvelope,
  parseEnvelope,
  rewrapEnvelope,
  sealEnvelope,
} from './envelope.js';

const binding = { orgId: 'organization', owner: 'source:row', purpose: 'connection' };

describe('credential envelopes', () => {
  it('uses distinct data keys and refuses a swapped row, organization, purpose, or key', async () => {
    const key = localKey(randomBytes(32));
    const value = randomBytes(32).toString('hex');
    const first = await sealEnvelope(key, value, binding);
    const second = await sealEnvelope(key, value, binding);
    expect(parseEnvelope(first).wrappedKey).not.toBe(parseEnvelope(second).wrappedKey);
    expect(parseEnvelope(first).value).not.toBe(parseEnvelope(second).value);
    expect(await openEnvelope(key, first, binding)).toBe(value);
    for (const wrong of [
      { ...binding, owner: 'source:other' },
      { ...binding, orgId: 'other' },
      { ...binding, purpose: 'other' },
    ])
      await expect(openEnvelope(key, first, wrong)).rejects.toMatchObject({
        messageKey: 'credentials.unavailable',
      });
    await expect(openEnvelope(localKey(randomBytes(32)), first, binding)).rejects.toThrow();
  });

  it('rejects shortened tags, altered ciphertext, a replaced wrapped key, and malformed encodings', async () => {
    const key = localKey(randomBytes(32));
    const value = await sealEnvelope(key, randomBytes(10).toString('hex'), binding);
    const original = parseEnvelope(value);
    for (const field of ['value', 'wrappedKey'] as const) {
      const bytes = Buffer.from(original[field], 'base64url');
      const short = Buffer.concat([bytes.subarray(0, 16), bytes.subarray(28)]).toString('base64url');
      await expect(
        openEnvelope(key, encodeEnvelope({ ...original, [field]: short }), binding),
      ).rejects.toThrow();
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
      await expect(
        openEnvelope(key, encodeEnvelope({ ...original, [field]: bytes.toString('base64url') }), binding),
      ).rejects.toThrow();
    }
    const other = parseEnvelope(await sealEnvelope(key, '', binding));
    await expect(
      openEnvelope(key, encodeEnvelope({ ...original, wrappedKey: other.wrappedKey }), binding),
    ).rejects.toThrow();
    for (const malformed of ['rio2.', `${value}=`, 'rio2.e30', 'rio2.!'])
      await expect(openEnvelope(key, malformed, binding)).rejects.toThrow();
  });

  it('rewraps only the data key and authenticates the old envelope before rotation', async () => {
    const previous = localKey(randomBytes(32), 'previous');
    const next = localKey(randomBytes(32), 'next');
    const value = randomBytes(32).toString('hex');
    const sealed = await sealEnvelope(previous, value, binding);
    const rotated = await rewrapEnvelope(previous, next, sealed, binding);
    expect(parseEnvelope(rotated).value).toBe(parseEnvelope(sealed).value);
    expect(parseEnvelope(rotated).wrappedKey).not.toBe(parseEnvelope(sealed).wrappedKey);
    expect(await openEnvelope(next, rotated, binding)).toBe(value);
    await expect(openEnvelope(previous, rotated, binding)).rejects.toThrow();
    await expect(rewrapEnvelope(previous, next, sealed, { ...binding, owner: 'other' })).rejects.toThrow();
  });
});
