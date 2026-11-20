import { createCipheriv, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CredentialService, credentialBinding, type CredentialRepository } from './service.js';
import { fakeVault } from './http.test-support.js';
import { VaultProfile } from './settings.js';
import { localKey, parseEnvelope } from './envelope.js';
import { publicRow } from '../data/organization-archives/catalog.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const standIn = () => randomBytes(32).toString('hex');

export function legacySeal(key: Buffer, value: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return `rio1.${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')}`;
}

describe('credential storage', () => {
  it('migrates a legacy value on read and does not wait for a row lock held by its caller', async () => {
    const key = randomBytes(32),
      value = standIn();
    let complete!: () => void;
    const replace = vi.fn(
      (_org: string, _context: string, _previous: string, _next: string) =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const repository: CredentialRepository = {
      policy: async () => ({ profile: 'database', keyId: 'instance' }),
      key: async () => localKey(key),
      replace,
      failed: vi.fn(),
    };
    const service = new CredentialService(key, { profiles: [], cacheSeconds: 300 }, repository);
    expect(await service.read(legacySeal(key, value, 'source:row'), 'organization', 'source:row')).toBe(
      value,
    );
    expect(replace).toHaveBeenCalledOnce();
    expect(parseEnvelope(replace.mock.calls[0]![3] as string).keyId).toBe('instance');
    complete();
  });

  it('stores only an authenticated reference, isolates cached bindings, and never exports vault values', async () => {
    const values = new Map<string, string>();
    let failed = false,
      gets = 0;
    const fake = await fakeVault((call) => {
      if (failed) return { status: 503, body: { error: standIn() } };
      if (call.method === 'POST') values.set(call.path, (call.body.data as { value: string }).value);
      if (call.method === 'GET') {
        gets++;
        return { body: { data: { data: { value: values.get(call.path) } } } };
      }
      return { body: {} };
    });
    try {
      const key = randomBytes(32),
        value = standIn(),
        failures = vi.fn(async () => {});
      let policy = { profile: 'primary', keyId: 'instance' };
      const repository: CredentialRepository = {
        policy: async () => policy,
        key: async () => localKey(key),
        replace: async () => {},
        failed: failures,
      };
      const profile = VaultProfile.parse({
        id: 'primary',
        kind: 'vault',
        endpoint: fake.endpoint,
        auth: { kind: 'token', token: standIn() },
      });
      const service = new CredentialService(key, { profiles: [profile], cacheSeconds: 1 }, repository);
      const stored = await service.write(value, 'organization', 'source:row');
      expect(stored.startsWith('riov.')).toBe(true);
      expect(stored).not.toContain(value);
      expect([...values.values()][0]!.startsWith('rio2.')).toBe(true);
      const before = gets;
      expect(await service.read(stored, 'organization', 'source:row')).toBe(value);
      expect(await service.read(stored, 'organization', 'source:row')).toBe(value);
      expect(gets).toBe(before + 1);
      await expect(service.read(stored, 'other', 'source:row')).rejects.toThrow();
      await expect(service.read(stored, 'organization', 'source:other')).rejects.toThrow();
      const found = vi.fn();
      const exported = publicRow(
        'sources',
        { id: 'row', org_id: 'organization', sealed_secrets: stored },
        key,
        found,
      );
      expect(found).not.toHaveBeenCalled();
      expect(exported.omitted).toEqual([['sealed_secrets']]);
      expect(JSON.stringify(exported)).not.toContain(stored);
      policy = { profile: 'database', keyId: 'instance' };
      const returned = await service.move(stored, 'organization', 'source:row', policy);
      expect(await service.read(returned, 'organization', 'source:row')).toBe(value);
      expect(parseEnvelope(returned).value).toBe(parseEnvelope([...values.values()][0]!).value);
      failed = true;
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);
      await expect(service.read(stored, 'organization', 'source:row')).rejects.toMatchObject({
        messageKey: 'credentials.unavailable',
      });
      expect(failures).toHaveBeenCalledWith('organization', 'primary');
      expect(credentialBinding('organization', 'source:row').orgId).toBe('organization');
    } finally {
      await fake.close();
    }
  });

  it('reports the wrapping profile when external key reads fail', async () => {
    let failing = false;
    let plaintext: unknown;
    const fake = await fakeVault((call) => {
      if (failing) return { status: 503 };
      if (call.path.includes('/encrypt/')) {
        plaintext = call.body.plaintext;
        return { body: { data: { ciphertext: standIn() } } };
      }
      return { body: { data: { plaintext } } };
    });
    try {
      const key = randomBytes(32),
        value = standIn(),
        failed = vi.fn(async () => {});
      const profile = VaultProfile.parse({
        id: 'wrapping',
        kind: 'vault',
        endpoint: fake.endpoint,
        auth: { kind: 'token', token: standIn() },
        transit: { key: 'key' },
      });
      const service = new CredentialService(
        key,
        { profiles: [profile], cacheSeconds: 0 },
        {
          policy: async () => ({ profile: 'database', keyId: 'external:wrapping:version' }),
          key: async () => localKey(key),
          replace: async () => {},
          failed,
        },
      );
      const stored = await service.write(value, 'organization', 'source:row');
      expect(await service.read(stored, 'organization', 'source:row')).toBe(value);
      failing = true;
      await expect(service.read(stored, 'organization', 'source:row')).rejects.toMatchObject({
        messageKey: 'credentials.unavailable',
      });
      await service.drain();
      expect(failed).toHaveBeenCalledWith('organization', 'wrapping');
      expect(failed).not.toHaveBeenCalledWith('organization', 'database');
    } finally {
      await fake.close();
    }
  });

  it('refuses a failed write or malformed provider response without falling back to the database', async () => {
    const fake = await fakeVault(() => ({ status: 403, body: { token: standIn() } }));
    try {
      const key = randomBytes(32);
      const profile = VaultProfile.parse({
        id: 'primary',
        kind: 'vault',
        endpoint: fake.endpoint,
        auth: { kind: 'token', token: standIn() },
      });
      const service = new CredentialService(
        key,
        { profiles: [profile], cacheSeconds: 0 },
        {
          policy: async () => ({ profile: 'primary', keyId: 'instance' }),
          key: async () => localKey(key),
          replace: async () => {},
          failed: async () => {},
        },
      );
      await expect(service.write(standIn(), 'organization', 'source:row')).rejects.toMatchObject({
        messageKey: 'credentials.unavailable',
      });
    } finally {
      await fake.close();
    }
  });
});
