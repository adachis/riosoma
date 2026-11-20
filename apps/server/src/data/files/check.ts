import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type { RuntimeConfig } from '../../config.js';
import { ConfigurationError } from '../../configuration-error.js';
import { failureCode, StorageServiceError } from './remote.js';
import { outsideStorage, storedInDatabase, type FileStorageConfig, type StorageKind } from './storage.js';

/**
 * The start check: writes a small test file to the storage new files go to, reads it back, and
 * deletes it, so a wrong key, bucket, or permission stops the server at start rather than failing
 * the first upload.  PostgreSQL needs no check, since the server can't start without its database.
 */
export async function checkFileStorage(
  config: FileStorageConfig & Pick<RuntimeConfig, 'filesStorage'>,
): Promise<StorageKind> {
  const kind = config.filesStorage ?? 'postgres';
  if (storedInDatabase(kind)) return kind;
  const storage = outsideStorage(kind as Exclude<StorageKind, 'postgres'>, config, { timeoutMs: 20_000 });
  const key = `riosoma-check-${randomBytes(8).toString('hex')}`;
  const bytes = randomBytes(64);
  try {
    await storage.write(key, Readable.from([bytes]));
    const chunks: Buffer[] = [];
    for await (const chunk of storage.read(key)) chunks.push(chunk as Buffer);
    if (!Buffer.concat(chunks).equals(bytes)) throw new StorageServiceError(200, 'ReadBackMismatch');
    await storage.delete(key);
  } catch (error) {
    await storage.delete(key).catch(() => undefined);
    const detail =
      error instanceof StorageServiceError
        ? `${error.status}${error.serviceCode ? ` ${error.serviceCode}` : ''}`
        : (failureCode(error) ?? undefined);
    throw new ConfigurationError('RIOSOMA_FILES_STORAGE', 'storageCheck', detail);
  }
  return kind;
}
