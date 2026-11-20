import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { hashRaw } from '@node-rs/argon2';
import { AppError, ArchiveEncryption } from '@riosoma/contracts';
import { seal, unseal } from '../../secrets.js';

export function encryptionParameters(): ArchiveEncryption {
  return {
    kdf: 'argon2id',
    version: 19,
    memory: 65536,
    iterations: 3,
    parallelism: 1,
    cipher: 'aes-256-gcm',
    keys: 'hkdf-sha256',
    mac: 'hmac-sha256',
    salt: randomBytes(16).toString('hex'),
  };
}

/** Two keys from one passphrase: one seals secrets, the other authenticates the manifest. */
export interface ArchiveKeys {
  encryption: Buffer;
  authentication: Buffer;
}

export async function archiveKeys(passphrase: string, parameters: ArchiveEncryption): Promise<ArchiveKeys> {
  // A fixed profile prevents an untrusted manifest from requesting unbounded derivation work.
  const p = ArchiveEncryption.parse(parameters);
  const salt = Buffer.from(p.salt, 'hex');
  const master = await hashRaw(passphrase, {
    algorithm: 2,
    version: 1,
    memoryCost: p.memory,
    timeCost: p.iterations,
    parallelism: p.parallelism,
    outputLen: 32,
    salt,
  });
  const derive = (purpose: string) =>
    Buffer.from(hkdfSync('sha256', master, salt, `riosoma.organization-archive.${purpose}`, 32));
  try {
    return { encryption: derive('encryption'), authentication: derive('authentication') };
  } finally {
    master.fill(0);
  }
}

export function forgetKeys(keys: ArchiveKeys | null): void {
  keys?.encryption.fill(0);
  keys?.authentication.fill(0);
}

/** The HMAC-SHA256 of the manifest's bytes, which list every other entry's SHA-256 */
export async function manifestMac(key: Buffer, manifest: AsyncIterable<Buffer | string>): Promise<string> {
  const mac = createHmac('sha256', key);
  for await (const part of manifest) mac.update(part);
  return mac.digest('hex');
}

export const notAuthentic = () => new AppError('validation_failed', 'organizationArchive.notAuthentic');

export function checkMac(expected: string, stored: Buffer): void {
  const found = Buffer.from(stored.toString('utf8'), 'hex');
  const wanted = Buffer.from(expected, 'hex');
  if (found.length !== wanted.length || !timingSafeEqual(found, wanted)) throw notAuthentic();
}

/** Where a secret belongs.  Its associated data binds it there, and to this archive's manifest. */
export interface SecretPlace {
  entry: string;
  catalog: string;
  identity: Record<string, unknown>;
  path: string[];
  /** The sealing context it had on the old server, or null for a value that wasn't sealed */
  context: string | null;
}

function associatedData(mac: string, place: SecretPlace): string {
  return JSON.stringify([
    'riosoma.organization-archive.secret',
    mac,
    place.entry,
    place.catalog,
    place.identity,
    place.path,
    place.context,
  ]);
}

export function encryptSecret(key: Buffer, mac: string, place: SecretPlace, value: unknown): string {
  return seal(key, JSON.stringify(value), associatedData(mac, place));
}

export function decryptSecret(key: Buffer, mac: string, place: SecretPlace, sealed: string): unknown {
  try {
    return JSON.parse(unseal(key, sealed, associatedData(mac, place))) as unknown;
  } catch {
    throw notAuthentic();
  }
}
