import { constants, createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { FastifyReply } from 'fastify';
import type { RuntimeConfig } from '../../config.js';
import { azureStorage, type AzureSettings } from './azure-storage.js';
import type { RemoteOptions } from './remote.js';
import { s3Storage, type S3Settings } from './s3-storage.js';

export const CHUNK_BYTES = 1024 * 1024;
export const STORAGE_KINDS = ['postgres', 'local', 's3', 'azure-blob'] as const;
export type StorageKind = (typeof STORAGE_KINDS)[number];
export interface ByteRange {
  start: number;
  end: number;
}
export interface SignedUrlOptions {
  /** How long the address works for */
  seconds: number;
  /** The content type and disposition the store answers with, as Riosoma would have */
  type: string;
  disposition: string;
}

/**
 * Where attachment bytes live.  Every kind reads and writes as streams, so no file is ever held in
 * memory whole.  A read of bytes that are gone fails with the code `ENOENT`, except in PostgreSQL,
 * where it reads as empty.  A write that fails leaves nothing under its key.
 */
export interface FileStorage {
  write(key: string, source: Readable): Promise<void>;
  read(key: string, range?: ByteRange): Readable;
  delete(key: string): Promise<void>;
  /** Copies stored bytes to a new key, inside the store itself where it can. */
  copy(from: string, to: string): Promise<void>;
  /**
   * A short-lived address a browser can fetch the bytes from directly, for stores that can sign
   * one, or null when this one can't.
   */
  signedUrl?(key: string, options: SignedUrlOptions): Promise<string | null>;
}

export type FileStorageConfig = Pick<RuntimeConfig, 'filesDir' | 'filesS3' | 'filesAzure'>;

/**
 * Whether a kind's writes belong to the database transaction they happen in.  Only PostgreSQL's
 * do, so code that stores bytes elsewhere removes them itself when its transaction fails.
 */
export function storedInDatabase(kind: StorageKind): boolean {
  return kind === 'postgres';
}

/**
 * The store's signed address for a download, when signed downloads are on and the store can sign
 * one, or null to serve the bytes through Riosoma.  Call it only after the permission check.
 */
export async function signedDownload(
  storage: FileStorage,
  key: string,
  config: Pick<RuntimeConfig, 'filesSignedUrlSeconds'>,
  answer: { type: string; disposition: string },
): Promise<string | null> {
  const seconds = config.filesSignedUrlSeconds ?? 0;
  if (!seconds || !storage.signedUrl) return null;
  return storage.signedUrl(key, { seconds, ...answer });
}

/** Sends a redirect to a signed address, which no cache keeps, since the address expires. */
export function redirectDownload(reply: FastifyReply, location: string): FastifyReply {
  for (const name of ['content-length', 'content-type', 'content-disposition', 'etag', 'accept-ranges'])
    reply.removeHeader(name);
  return reply.code(302).header('location', location).header('cache-control', 'private, no-store').send();
}

/** The setting a kind of storage still needs before files can be kept there or read from it, or null. */
export function missingSetting(kind: StorageKind, config: FileStorageConfig): string | null {
  if (kind === 'local' && !config.filesDir) return 'RIOSOMA_FILES_DIR';
  if (kind === 's3' && !config.filesS3) return 'RIOSOMA_FILES_S3_BUCKET';
  if (kind === 'azure-blob' && !config.filesAzure) return 'RIOSOMA_FILES_AZURE_ACCOUNT';
  return null;
}

/** Stores are kept per settings object, so a managed identity's token is fetched once, not per request. */
const remoteStores = new WeakMap<object, FileStorage>();

function remote<T extends object>(
  settings: T | null | undefined,
  kind: StorageKind,
  make: (settings: T) => FileStorage,
): FileStorage {
  if (!settings) throw new Error(`File storage ${kind} is not configured`);
  let store = remoteStores.get(settings);
  if (!store) {
    store = make(settings);
    remoteStores.set(settings, store);
  }
  return store;
}

function localStorage(config: FileStorageConfig): FileStorage {
  const path = (key: string) => {
    if (!config.filesDir || !/^[A-Za-z0-9_-]+$/.test(key)) throw new Error('Invalid file storage path');
    return join(config.filesDir, key);
  };
  const removeFile = (target: string) =>
    unlink(target).catch((error: unknown) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    });
  return {
    async write(key, source) {
      const target = path(key);
      await mkdir(config.filesDir!, { recursive: true, mode: 0o700 });
      try {
        await pipeline(source, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
      } catch (error) {
        // A file that was already there isn't this write's to remove, and a partial one is.
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
          await removeFile(target).catch(() => undefined);
        throw error;
      }
    },
    read: (key, range) => createReadStream(path(key), range),
    delete: (key) => removeFile(path(key)),
    async copy(from, to) {
      await mkdir(config.filesDir!, { recursive: true, mode: 0o700 });
      await copyFile(path(from), path(to), constants.COPYFILE_EXCL);
    },
  };
}

function postgresStorage(db: Queryable, appSchema: string): FileStorage {
  const chunks = ident(appSchema, 'file_chunks');
  const remove = async (key: string) => {
    await query(db, sql`DELETE FROM ${chunks} WHERE storage_key = ${key}`);
  };
  return {
    async write(key, source) {
      let buffer = Buffer.allocUnsafe(CHUNK_BYTES);
      let length = 0;
      let position = 0;
      const flush = async () => {
        await query(
          db,
          sql`INSERT INTO ${chunks} (storage_key, position, bytes)
          VALUES (${key}, ${position++}, ${buffer.subarray(0, length)})`,
        );
        buffer = Buffer.allocUnsafe(CHUNK_BYTES);
        length = 0;
      };
      try {
        for await (const value of source) {
          const bytes = value as Buffer;
          for (let offset = 0; offset < bytes.length;) {
            const count = Math.min(CHUNK_BYTES - length, bytes.length - offset);
            bytes.copy(buffer, length, offset, offset + count);
            length += count;
            offset += count;
            if (length === CHUNK_BYTES) await flush();
          }
        }
        if (length) await flush();
      } catch (error) {
        // Inside a transaction, its rollback removes the chunks anyway.  Outside one, this does.
        if (position) await remove(key).catch(() => undefined);
        throw error;
      }
    },
    read(key, range) {
      return Readable.from(
        (async function* () {
          let position = Math.floor((range?.start ?? 0) / CHUNK_BYTES);
          const last = range ? Math.floor(range.end / CHUNK_BYTES) : Infinity;
          while (position <= last) {
            const result = await query<{ bytes: Buffer }>(
              db,
              sql`SELECT bytes FROM ${chunks} WHERE storage_key = ${key} AND position = ${position}`,
            );
            const bytes = result.rows[0]?.bytes;
            if (!bytes) break;
            const offset = position * CHUNK_BYTES;
            yield bytes.subarray(
              Math.max(0, (range?.start ?? 0) - offset),
              range ? Math.min(bytes.length, range.end - offset + 1) : bytes.length,
            );
            position++;
          }
        })(),
        { objectMode: false },
      );
    },
    delete: remove,
    async copy(from, to) {
      await query(
        db,
        sql`INSERT INTO ${chunks} (storage_key, position, bytes)
        SELECT ${to}, position, bytes FROM ${chunks} WHERE storage_key = ${from}`,
      );
    },
  };
}

export function fileStorage(
  kind: StorageKind,
  db: Queryable,
  appSchema: string,
  config: FileStorageConfig,
): FileStorage {
  if (kind === 'postgres') return postgresStorage(db, appSchema);
  return outsideStorage(kind, config);
}

/**
 * A store outside the database.  With options, such as the start check's time limit, it's made
 * fresh rather than shared.
 */
export function outsideStorage(
  kind: Exclude<StorageKind, 'postgres'>,
  config: FileStorageConfig,
  options?: RemoteOptions,
): FileStorage {
  switch (kind) {
    case 'local':
      return localStorage(config);
    case 's3':
      if (options && config.filesS3) return s3Storage(config.filesS3, options);
      return remote<S3Settings>(config.filesS3, kind, (settings) => s3Storage(settings));
    case 'azure-blob':
      if (options && config.filesAzure) return azureStorage(config.filesAzure, options);
      return remote<AzureSettings>(config.filesAzure, kind, (settings) => azureStorage(settings));
  }
}
