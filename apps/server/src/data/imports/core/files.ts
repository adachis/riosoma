import type { Readable } from 'node:stream';
import { AppError, newId, type AttachmentMeta } from '@riosoma/contracts';
import { withTransaction } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import type { Resolve } from '../../../automations/outbound.js';
import { dataStore } from '../../context.js';
import { fileName } from '../../files/detect.js';
import { finishUpload } from '../../files/finish.js';
import { fileStorage, storedInDatabase } from '../../files/storage.js';
import { download, DownloadError } from '../download.js';
import type { Note } from './report.js';

/** A file name as uploads keep them, or `file` when nothing usable is left. */
export function safeFileName(name: unknown): string {
  try {
    return fileName(encodeURIComponent(typeof name === 'string' ? name : ''));
  } catch {
    return 'file';
  }
}

/**
 * Stores a downloaded file for an attachment field, the way an upload is stored: its type from
 * its bytes, previews for images, and a checksum.  It sits in no record until a record command
 * names it, and cleanup removes it a day later if none does.
 */
export async function storeFile(
  app: FastifyInstance,
  owner: { orgId: string; userId: string },
  target: { tableId: string; fieldId: string },
  name: string,
  body: Readable,
  source?: AttachmentMeta['source'],
): Promise<{ id: string; size: number }> {
  const { pool, schemas } = dataStore(app.ctx);
  const kind = app.ctx.config.filesStorage ?? 'postgres';
  const id = newId('attachment');
  try {
    return await withTransaction(pool, async (db) => {
      const stored = await finishUpload(
        db,
        schemas.app,
        app.ctx.config,
        {
          id,
          orgId: owner.orgId,
          userId: owner.userId,
          ...target,
          name,
          storage: kind,
        },
        body,
        source,
      );
      // A search result has to be a raster image, so anything else is refused before a record can name it.
      if (source && (!stored.type.startsWith('image/') || stored.type === 'image/svg+xml'))
        throw new AppError('validation_failed', 'files.search.notImage');
      return { id, size: Number(stored.size) };
    });
  } catch (error) {
    if (!storedInDatabase(kind)) {
      const storage = fileStorage(kind, pool, schemas.app, app.ctx.config);
      for (const key of [id, `${id}_small`, `${id}_large`]) await storage.delete(key).catch(() => undefined);
    }
    throw error;
  } finally {
    body.destroy();
  }
}

/** One file an imported cell names. */
export interface Attachment {
  url: string;
  filename: unknown;
  /** What the source says its size is, when it says */
  size: number | null;
  /** Sent with the download, and after a redirect only while it stays on the same origin */
  headers?: Record<string, string>;
  /** Attachment routes allowed on the initial request and every redirect */
  allowUrl?(url: URL): boolean;
  /** A source file that could not be resolved safely, retained for the report */
  problem?: 'blocked' | 'failed';
  /** Resolves short-lived signed URLs after this download has reserved its allowance. */
  prepare?(): Promise<Attachment>;
}

export interface FileLimits {
  fileBytes: number;
  totalFileBytes: number;
}

interface FileProblems {
  tooLarge: number;
  maxFileBytes: number;
  blocked: number;
  failed: number;
  budget: number;
}

export interface FileDownloadOptions {
  app: FastifyInstance;
  owner: { orgId: string; userId: string };
  resolve: Resolve;
  allowPrivate(url: URL): boolean;
  limits: FileLimits;
  signal: AbortSignal;
  /** The report's message keys for each way a file can be left out */
  keys: { tooLarge: string; blocked: string; failed: string; budget: string };
}

/**
 * An import's downloads: each file through the guarded client, within the size of one file and the
 * import's allowance, stored the way an upload is, with a count of each way a file was left out,
 * by the field it belonged to.
 */
export class FileDownloads<Key> {
  /** Files stored so far */
  files = 0;
  /** Bytes stored so far */
  bytes = 0;
  private reserved = 0;
  private readonly pending = new Set<Promise<void>>();
  private readonly problems = new Map<Key, FileProblems>();

  constructor(private readonly options: FileDownloadOptions) {}

  private problem(key: Key, kind: Exclude<keyof FileProblems, 'maxFileBytes'>, limit?: number): void {
    const found = this.problems.get(key) ?? {
      tooLarge: 0,
      maxFileBytes: this.options.limits.fileBytes,
      blocked: 0,
      failed: 0,
      budget: 0,
    };
    found[kind]++;
    if (kind === 'tooLarge' && limit !== undefined) found.maxFileBytes = Math.min(found.maxFileBytes, limit);
    this.problems.set(key, found);
  }

  /** Downloads and stores one file, answering its ID here, or null when it was left out. */
  async fetch(
    key: Key,
    target: { tableId: string; fieldId: string },
    attachment: Attachment,
  ): Promise<string | null> {
    const { limits, app, owner, signal } = this.options;
    signal.throwIfAborted();
    if (attachment.problem) {
      this.problem(key, attachment.problem);
      return null;
    }
    if (attachment.size !== null && attachment.size > limits.fileBytes) {
      this.problem(key, 'tooLarge');
      return null;
    }
    let room = limits.totalFileBytes - this.bytes - this.reserved;
    // An in-flight file may use less than its reservation or fail, so wait before omitting a file.
    while (this.pending.size && (room <= 0 || (attachment.size !== null && attachment.size > room))) {
      await Promise.race(this.pending);
      signal.throwIfAborted();
      room = limits.totalFileBytes - this.bytes - this.reserved;
    }
    if (room <= 0 || (attachment.size !== null && attachment.size > room)) {
      this.problem(key, 'budget');
      return null;
    }
    // Source sizes are untrusted, so reserve the full enforced download allowance.
    const reserved = Math.min(limits.fileBytes, room);
    this.reserved += reserved;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pending.add(pending);
    try {
      if (attachment.prepare) {
        attachment = await attachment.prepare();
        signal.throwIfAborted();
        if (attachment.problem) {
          this.problem(key, attachment.problem);
          return null;
        }
      }
      const got = await download(attachment.url, {
        resolve: this.options.resolve,
        allowPrivate: (url) => this.options.allowPrivate(url),
        maxBytes: reserved,
        signal,
        ...(attachment.allowUrl ? { allowUrl: attachment.allowUrl } : {}),
        ...(attachment.headers ? { headers: attachment.headers } : {}),
      });
      const file = await storeFile(app, owner, target, safeFileName(attachment.filename), got.body);
      this.files++;
      this.bytes += file.size;
      return file.id;
    } catch (error) {
      signal.throwIfAborted();
      if (
        error instanceof AppError &&
        error.code === 'payload_too_large' &&
        error.messageKey === 'data.file.tooLarge'
      ) {
        const cap = error.params?.maxUploadBytes;
        this.problem(key, 'tooLarge', typeof cap === 'number' ? cap : limits.fileBytes);
      } else {
        const problem = error instanceof DownloadError ? error.problem : 'failed';
        // Past the size limit because the import's allowance ran out, rather than the file's own limit.
        this.problem(key, problem === 'tooLarge' && room < limits.fileBytes ? 'budget' : problem);
      }
      return null;
    } finally {
      this.reserved -= reserved;
      this.pending.delete(pending);
      release();
    }
  }

  /** What the report says about the files of one field that were left out. */
  notes(key: Key): Note[] {
    const problems = this.problems.get(key);
    if (!problems) return [];
    const { keys, limits } = this.options;
    const megabytes = problems.maxFileBytes / 1024 ** 2;
    const gigabytes = Math.floor(limits.totalFileBytes / 1024 ** 3);
    const notes: Note[] = [];
    if (problems.tooLarge)
      notes.push({ status: 'omitted', key: keys.tooLarge, params: { count: problems.tooLarge, megabytes } });
    if (problems.blocked)
      notes.push({ status: 'omitted', key: keys.blocked, params: { count: problems.blocked } });
    if (problems.failed)
      notes.push({ status: 'omitted', key: keys.failed, params: { count: problems.failed } });
    if (problems.budget)
      notes.push({ status: 'omitted', key: keys.budget, params: { count: problems.budget, gigabytes } });
    return notes;
  }
}
