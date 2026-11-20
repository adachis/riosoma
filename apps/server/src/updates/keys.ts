import type { FeedKey } from '@riosoma/contracts';

/**
 * The public keys an update feed may be signed with, each an Ed25519 key as its 32 bytes in
 * base64url, named by the ID a feed gives in its `keyId`.  A feed names the key that signed it, so
 * a new key can be added here a release before the hub starts signing with it, and an old one
 * removed a release after it stops.
 *
 * With no keys, no feed can be verified, so the server fetches nothing and shows no update notices,
 * and the admin screen says why.
 *
 * The updater sidecar checks the same signature with its own copy, `deploy/updater/feed-keys.json`,
 * which a test keeps identical to this list.
 */
export const FEED_KEYS: readonly FeedKey[] = [
  { id: '2026-10', publicKey: 'rJr9u7OIxnUZbxv-ujoC7nlCh8HPcDdwGcdjYn5bORs' },
];
