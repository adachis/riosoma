import { parseOptions, verify } from '@node-rs/argon2';
import type * as argon2 from '@node-rs/argon2';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashPassword, verifyPassword } from './passwords.js';

vi.mock('@node-rs/argon2', async (importOriginal) => {
  const original = await importOriginal<typeof argon2>();
  return { ...original, verify: vi.fn(original.verify) };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('password hashing', () => {
  it('uses independently salted Argon2id hashes at the required cost', async () => {
    const first = await hashPassword('a long test password');
    const second = await hashPassword('a long test password');
    expect(first).not.toBe(second);
    expect(parseOptions(first)).toMatchObject({
      algorithm: 2,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
    expect(await verifyPassword('a long test password', first)).toBe(true);
    expect(await verifyPassword('a wrong password', first)).toBe(false);
  });

  it('performs the native verification against the same full-cost dummy hash for missing passwords', async () => {
    expect(await verifyPassword('first missing password', null)).toBe(false);
    expect(await verifyPassword('second missing password', null)).toBe(false);
    const calls = vi.mocked(verify).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]![0]).toBe(calls[1]![0]);
    expect(parseOptions(calls[0]![0])).toMatchObject({
      algorithm: 2,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
  });
});
