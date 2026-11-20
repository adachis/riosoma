import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { VaultProfiles } from './settings.js';
import { vaultFor } from './adapters.js';
import { localKey, openEnvelope, parseEnvelope, rewrapEnvelope, sealEnvelope } from './envelope.js';

const configured = process.env.RIOSOMA_CREDENTIAL_TEST_PROFILES;
const profiles = configured ? VaultProfiles.parse(JSON.parse(configured)) : [];

describe.skipIf(!configured)('live credential vaults', () => {
  for (const profile of profiles)
    it(`round trips and removes an entry through ${profile.id}`, async () => {
      const adapter = vaultFor(profile);
      const value = randomBytes(32).toString('hex');
      const binding = { orgId: 'test', owner: randomBytes(16).toString('hex'), purpose: 'live-test' };
      const key = localKey(randomBytes(32));
      let sealed = await sealEnvelope(key, value, binding);
      if (adapter.key) {
        const remote = adapter.key(`external:${profile.id}:test`);
        const rewrapped = await rewrapEnvelope(key, remote, sealed, binding);
        expect(parseEnvelope(rewrapped).value).toBe(parseEnvelope(sealed).value);
        expect(await openEnvelope(remote, rewrapped, binding)).toBe(value);
        sealed = rewrapped;
      }
      let reference: string | undefined;
      try {
        reference = await adapter.put(`rio-${randomBytes(24).toString('hex')}`, sealed);
        expect(await adapter.get(reference)).toBe(sealed);
      } finally {
        if (reference) await adapter.remove(reference);
      }
      await expect(adapter.get(reference!)).rejects.toMatchObject({ messageKey: 'credentials.unavailable' });
    });
  it.skipIf(profiles.length > 0)('requires at least one configured test identity', () => {
    expect(profiles.length).toBeGreaterThan(0);
  });
});
