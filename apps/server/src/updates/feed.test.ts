import { sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compareVersions, type UpdateRelease } from '@riosoma/contracts';
import { describe, expect, it } from 'vitest';
import { offer, verifyFeed } from './feed.js';
import { FEED_KEYS } from './keys.js';
import { DAY, release, signFeed, signingKey } from './updates.test-helpers.js';

const now = new Date();
const current = signingKey('2026-10');

describe('update feed signatures', () => {
  it('accepts a feed one of the keys signed', () => {
    const checked = verifyFeed(signFeed(current, [release('1.0.0')]), [current], now);
    expect(checked).toMatchObject({ status: 'ok', keyId: '2026-10' });
  });

  it('refuses a feed signed with the wrong key, even under a known key ID', () => {
    const impostor = signingKey('2026-10');
    expect(verifyFeed(signFeed(impostor, [release('1.0.0')]), [current], now).status).toBe('badSignature');
  });

  it('refuses a feed whose payload changed after it was signed', () => {
    const envelope = JSON.parse(signFeed(current, [release('1.0.0')])) as { payload: string };
    const tampered = JSON.stringify({ ...envelope, payload: envelope.payload.replace('1.0.0', '9.0.0') });
    expect(verifyFeed(tampered, [current], now).status).toBe('badSignature');
    const bytes = JSON.stringify({ ...envelope, signature: Buffer.alloc(64).toString('base64') });
    expect(verifyFeed(bytes, [current], now).status).toBe('badSignature');
  });

  it('refuses an unsigned feed, a key it doesn’t know, and something that isn’t a feed', () => {
    const payload = JSON.stringify({ schema: 1, issuedAt: now.toISOString(), releases: [] });
    expect(verifyFeed(JSON.stringify({ payload }), [current], now).status).toBe('unsigned');
    expect(verifyFeed(payload, [current], now).status).toBe('unsigned');
    expect(verifyFeed('<html>', [current], now).status).toBe('invalid');
    const stranger = signingKey('2025-01');
    expect(verifyFeed(signFeed(stranger, []), [current], now).status).toBe('unknownKey');
    const notAFeed = JSON.stringify({ schema: 2, releases: 'none' });
    const signature = sign(null, Buffer.from(notAFeed), current.privateKey).toString('base64');
    expect(
      verifyFeed(JSON.stringify({ keyId: current.id, signature, payload: notAFeed }), [current], now).status,
    ).toBe('invalid');
  });

  it('refuses a feed signed more than 14 days ago, or more than a day from now', () => {
    expect(verifyFeed(signFeed(current, [], new Date(now.getTime() - 13 * DAY)), [current], now).status).toBe(
      'ok',
    );
    expect(verifyFeed(signFeed(current, [], new Date(now.getTime() - 15 * DAY)), [current], now).status).toBe(
      'stale',
    );
    expect(verifyFeed(signFeed(current, [], new Date(now.getTime() + 2 * DAY)), [current], now).status).toBe(
      'invalid',
    );
  });

  it('rotates keys: a feed names its key, and both keys work while both are listed', () => {
    const next = signingKey('2027-04');
    const both = [current, next];
    expect(verifyFeed(signFeed(current, []), both, now)).toMatchObject({ status: 'ok', keyId: '2026-10' });
    expect(verifyFeed(signFeed(next, []), both, now)).toMatchObject({ status: 'ok', keyId: '2027-04' });
    // Once the old key is retired, what it signed stops verifying.
    expect(verifyFeed(signFeed(current, []), [next], now).status).toBe('unknownKey');
  });

  it('verifies nothing with no keys', () => {
    expect(verifyFeed(signFeed(current, [release('1.0.0')]), [], now).status).toBe('noKeys');
  });

  it('ships keys that are named and hold 32 bytes each', () => {
    expect(FEED_KEYS.length).toBeGreaterThan(0);
    expect(new Set(FEED_KEYS.map((key) => key.id)).size).toBe(FEED_KEYS.length);
    for (const key of FEED_KEYS) expect(Buffer.from(key.publicKey, 'base64url')).toHaveLength(32);
  });

  it('keeps the updater sidecar’s keys the same as the server’s', () => {
    const path = fileURLToPath(new URL('../../../../deploy/updater/feed-keys.json', import.meta.url));
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(FEED_KEYS);
  });
});

describe('what a feed offers', () => {
  const feed = (releases: UpdateRelease[]) => ({ schema: 1 as const, issuedAt: now.toISOString(), releases });

  it('lists newer releases newest first, and flags a security release among them', () => {
    const offered = offer(
      feed([
        release('1.0.0'),
        release('1.2.0'),
        release('1.1.0', { security: true }),
        release('0.9.0', { security: true }),
      ]),
      '1.0.0',
    );
    expect(offered.available.map((item) => item.version)).toEqual(['1.2.0', '1.1.0']);
    expect(offered.target?.version).toBe('1.2.0');
    expect(offered.security).toBe(true);
    expect(offer(feed([release('1.2.0')]), '1.0.0').security).toBe(false);
  });

  it('targets the newest release this version can reach directly', () => {
    const offered = offer(
      feed([release('2.0.0', { minimumVersion: '1.5.0' }), release('1.5.0', { minimumVersion: '1.0.0' })]),
      '1.1.0',
    );
    expect(offered.available.map((item) => item.version)).toEqual(['2.0.0', '1.5.0']);
    expect(offered.target?.version).toBe('1.5.0');
    expect(offer(feed([release('2.0.0', { minimumVersion: '1.5.0' })]), '1.1.0').target).toBeNull();
  });

  it('offers prereleases only to a server running one', () => {
    const releases = [release('1.1.0-rc.1'), release('1.0.1')];
    expect(offer(feed(releases), '1.0.0').available.map((item) => item.version)).toEqual(['1.0.1']);
    expect(offer(feed(releases), '1.0.0-rc.2').available.map((item) => item.version)).toEqual([
      '1.1.0-rc.1',
      '1.0.1',
      // 1.0.0 itself is newer than its own release candidate, but it isn't in this feed.
    ]);
  });

  it('orders versions as semantic versioning does', () => {
    const sorted = [
      '1.0.0',
      '1.0.0-rc.10',
      '0.9.9',
      '1.0.0-rc.2',
      '1.0.0-beta',
      '1.10.0',
      '1.2.0',
      'custom',
    ].sort(compareVersions);
    expect(sorted).toEqual([
      'custom',
      '0.9.9',
      '1.0.0-beta',
      '1.0.0-rc.2',
      '1.0.0-rc.10',
      '1.0.0',
      '1.2.0',
      '1.10.0',
    ]);
  });
});
