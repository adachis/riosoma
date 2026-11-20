import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import {
  compareVersions,
  SignedFeed,
  UpdateFeed,
  type FeedKey,
  type FeedStatus,
  type ImagePlatform,
  type UpdateRelease,
} from '@riosoma/contracts';

/** A feed signed longer ago than this is stale, and nothing in it is shown. */
export const FEED_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
/** A feed may be signed this far in the future, for clocks that disagree a little, and no further. */
const FUTURE_SKEW_MS = 24 * 60 * 60_000;
/** The registry releases come from when a feed doesn't name one */
export const DEFAULT_REPOSITORY = 'ghcr.io/adachis/riosoma';

export type VerifiedFeed = { status: 'ok'; feed: UpdateFeed; keyId: string; issuedAt: Date };
export type FeedCheck = VerifiedFeed | { status: Exclude<FeedStatus, 'ok'> };

function publicKey(key: FeedKey): KeyObject | null {
  try {
    return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.publicKey }, format: 'jwk' });
  } catch {
    return null;
  }
}

function signatureMatches(payload: string, signature: Buffer, material: KeyObject | null): boolean {
  if (!material || signature.length !== 64) return false;
  try {
    return verify(null, Buffer.from(payload, 'utf8'), material, signature);
  } catch {
    return false;
  }
}

/**
 * Checks what a feed address answered: that it's a signed envelope, that one of these keys signed
 * it, that what it signed is a feed, and that the feed is neither stale nor from the future.  The
 * signature covers the payload's exact bytes, so nothing is parsed before it's verified.
 */
export function verifyFeed(text: string, keys: readonly FeedKey[], now: Date): FeedCheck {
  if (!keys.length) return { status: 'noKeys' };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { status: 'invalid' };
  }
  const envelope = SignedFeed.safeParse(body);
  if (!envelope.success) {
    const fields = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    return { status: fields.signature === undefined || fields.keyId === undefined ? 'unsigned' : 'invalid' };
  }
  const key = keys.find((candidate) => candidate.id === envelope.data.keyId);
  if (!key) return { status: 'unknownKey' };
  const material = publicKey(key);
  const signature = Buffer.from(envelope.data.signature, 'base64');
  if (!signatureMatches(envelope.data.payload, signature, material)) return { status: 'badSignature' };
  let payload: unknown;
  try {
    payload = JSON.parse(envelope.data.payload);
  } catch {
    return { status: 'invalid' };
  }
  const feed = UpdateFeed.safeParse(payload);
  if (!feed.success) return { status: 'invalid' };
  const issuedAt = new Date(feed.data.issuedAt);
  if (issuedAt.getTime() - now.getTime() > FUTURE_SKEW_MS) return { status: 'invalid' };
  if (now.getTime() - issuedAt.getTime() > FEED_MAX_AGE_MS) return { status: 'stale' };
  return { status: 'ok', feed: feed.data, keyId: key.id, issuedAt };
}

export interface Offer {
  /** Newer releases, newest first */
  available: UpdateRelease[];
  /** The newest of them this version may update to directly */
  target: UpdateRelease | null;
  security: boolean;
}

const prerelease = (version: string) => version.includes('-');

/**
 * The releases a server at `current` is offered.  A prerelease is only offered to a server that
 * runs one.  A release whose minimum version is above `current` is listed but isn't the target,
 * so a server that fell far behind updates to the newest release it can reach first.
 */
export function offer(feed: UpdateFeed, current: string): Offer {
  const available = feed.releases
    .filter((release) => compareVersions(release.version, current) > 0)
    .filter((release) => !prerelease(release.version) || prerelease(current))
    .sort((a, b) => compareVersions(b.version, a.version));
  const target = available.find((release) => compareVersions(current, release.minimumVersion) >= 0) ?? null;
  return { available, target, security: available.some((release) => release.security) };
}

/** The image platform this server runs on, when it's one releases name */
export function serverPlatform(): ImagePlatform | null {
  if (process.platform !== 'linux') return null;
  if (process.arch === 'x64') return 'linux/amd64';
  if (process.arch === 'arm64') return 'linux/arm64';
  return null;
}
