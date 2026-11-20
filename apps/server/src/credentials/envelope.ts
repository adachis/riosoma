import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { AppError } from '@riosoma/contracts';

export interface SecretBinding {
  orgId: string;
  owner: string;
  purpose: string;
}

export interface KeyEncryptionKey {
  id: string;
  wrap(key: Buffer, aad: Buffer): Promise<string>;
  unwrap(wrapped: string, aad: Buffer): Promise<Buffer>;
}

export interface Envelope {
  version: 2;
  keyId: string;
  wrappedKey: string;
  value: string;
}

export const unavailable = () => new AppError('unavailable', 'credentials.unavailable');

export function associatedData(binding: SecretBinding): Buffer {
  if (!binding.orgId || !binding.owner || !binding.purpose) throw unavailable();
  return Buffer.from(
    JSON.stringify(['riosoma.credential', 2, binding.orgId, binding.owner, binding.purpose]),
  );
}

function bytes(text: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw unavailable();
  const result = Buffer.from(text, 'base64url');
  if (result.toString('base64url') !== text) throw unavailable();
  return result;
}

function encrypt(key: Buffer, value: Buffer, aad: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

function decrypt(key: Buffer, value: string, aad: Buffer): Buffer {
  const raw = bytes(value);
  if (raw.length < 28) throw unavailable();
  const cipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12), { authTagLength: 16 });
  cipher.setAAD(aad);
  cipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([cipher.update(raw.subarray(28)), cipher.final()]);
}

function wrappingData(aad: Buffer, keyId: string, value: string): Buffer {
  // Binding the wrapped key to the ciphertext also protects rewrapping from value substitution
  return Buffer.from(JSON.stringify(['wrap', keyId, aad.toString('base64url'), value]));
}

export function localKey(key: Buffer, id = 'instance'): KeyEncryptionKey {
  if (key.length !== 32) throw unavailable();
  return {
    id,
    async wrap(dataKey, aad) {
      return encrypt(key, dataKey, aad);
    },
    async unwrap(wrapped, aad) {
      return decrypt(key, wrapped, aad);
    },
  };
}

export function encodeEnvelope(envelope: Envelope): string {
  return `rio2.${Buffer.from(JSON.stringify(envelope)).toString('base64url')}`;
}

export function parseEnvelope(value: string): Envelope {
  try {
    if (!value.startsWith('rio2.')) throw unavailable();
    const parsed = JSON.parse(bytes(value.slice(5)).toString('utf8')) as Envelope;
    if (
      parsed.version !== 2 ||
      typeof parsed.keyId !== 'string' ||
      !parsed.keyId ||
      typeof parsed.wrappedKey !== 'string' ||
      typeof parsed.value !== 'string'
    )
      throw unavailable();
    return parsed;
  } catch {
    throw unavailable();
  }
}

export async function sealEnvelope(
  kek: KeyEncryptionKey,
  plaintext: string,
  binding: SecretBinding,
): Promise<string> {
  const key = randomBytes(32);
  try {
    const aad = associatedData(binding);
    const value = encrypt(key, Buffer.from(plaintext), aad);
    const wrappedKey = await kek.wrap(key, wrappingData(aad, kek.id, value));
    return encodeEnvelope({ version: 2, keyId: kek.id, wrappedKey, value });
  } finally {
    key.fill(0);
  }
}

async function dataKey(kek: KeyEncryptionKey, envelope: Envelope, binding: SecretBinding): Promise<Buffer> {
  if (kek.id !== envelope.keyId) throw unavailable();
  const key = await kek.unwrap(
    envelope.wrappedKey,
    wrappingData(associatedData(binding), kek.id, envelope.value),
  );
  if (key.length !== 32) {
    key.fill(0);
    throw unavailable();
  }
  return key;
}

export async function openEnvelope(
  kek: KeyEncryptionKey,
  sealed: string,
  binding: SecretBinding,
): Promise<string> {
  let key: Buffer | undefined;
  try {
    const envelope = parseEnvelope(sealed);
    key = await dataKey(kek, envelope, binding);
    return decrypt(key, envelope.value, associatedData(binding)).toString('utf8');
  } catch {
    throw unavailable();
  } finally {
    key?.fill(0);
  }
}

export async function rewrapEnvelope(
  previous: KeyEncryptionKey,
  next: KeyEncryptionKey,
  sealed: string,
  binding: SecretBinding,
): Promise<string> {
  let key: Buffer | undefined;
  try {
    const envelope = parseEnvelope(sealed);
    key = await dataKey(previous, envelope, binding);
    const wrappedKey = await next.wrap(key, wrappingData(associatedData(binding), next.id, envelope.value));
    return encodeEnvelope({ ...envelope, keyId: next.id, wrappedKey });
  } catch {
    throw unavailable();
  } finally {
    key?.fill(0);
  }
}

export function bindingHash(binding: SecretBinding): string {
  return createHash('sha256').update(associatedData(binding)).digest('hex');
}
