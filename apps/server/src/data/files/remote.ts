import { setTimeout as delay } from 'node:timers/promises';
import { Readable } from 'node:stream';

/**
 * What the S3-compatible and Azure Blob stores share: errors that never carry a credential, retries
 * for the answers a busy service gives, a stream split into parts of a fixed size, and a download
 * that starts only when something reads it.
 */

/** Uploads over this size go up in parts of this size, so one upload holds at most one part in memory. */
export const PART_BYTES = 16 * 1024 * 1024;

/** A request that sends a body gets this long, which covers a part on a slow link. */
export const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * A stored file that isn't there.  Its code is `ENOENT`, like a missing file on disk, so the code
 * that copies files for archives treats every store alike.
 */
export class MissingFile extends Error {
  readonly code = 'ENOENT';
  constructor() {
    super('The stored file is missing');
    this.name = 'MissingFile';
  }
}

/**
 * A storage service's refusal, by its HTTP status and its own error code.  Neither ever holds a
 * credential or a signature, so both are safe to log and to show at startup.
 */
export class StorageServiceError extends Error {
  constructor(
    readonly status: number,
    readonly serviceCode: string | null,
  ) {
    super(`File storage answered ${status}${serviceCode ? ` ${serviceCode}` : ''}`);
    this.name = 'StorageServiceError';
  }
}

export interface RemoteOptions {
  /** The client requests go through, which tests replace to watch them */
  fetch?: typeof fetch;
  /** The part size for large uploads, in bytes */
  partBytes?: number;
  /** A limit on every request, in milliseconds, where normally only requests with a body get one */
  timeoutMs?: number;
  /** Where Azure Blob Storage gets identity tokens, in place of the managed identity */
  token?: () => Promise<string>;
}

const RETRIED = new Set([429, 500, 502, 503, 504]);

/**
 * Sends a request, and again up to twice more when the connection fails or the service answers
 * that it's busy.  `send` builds the request each time, since a signature carries the time.  A
 * request that timed out isn't sent again, so a service that doesn't answer fails promptly.
 */
export async function withRetries(send: () => Promise<Response>, retries = 2): Promise<Response> {
  for (let tries = 0; ; tries++) {
    let response: Response;
    try {
      response = await send();
    } catch (error) {
      if (tries >= retries || (error instanceof Error && error.name === 'TimeoutError')) throw error;
      await delay(250 * 4 ** tries);
      continue;
    }
    if (!RETRIED.has(response.status) || tries >= retries) return response;
    await response.body?.cancel();
    await delay(250 * 4 ** tries);
  }
}

/** Up to 64 KB of an answer's body as text, which is plenty for an error or a short result. */
export async function answerText(response: Response): Promise<string> {
  if (!response.body) return '';
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of response.body) {
    chunks.push(Buffer.from(chunk));
    length += chunk.byteLength;
    if (length >= 65_536) break;
  }
  return Buffer.concat(chunks).subarray(0, 65_536).toString('utf8');
}

/**
 * Splits a stream into parts of exactly `size` bytes and a last part of whatever is left, holding
 * one part at a time.  An empty stream has no parts.
 */
export async function* partsOf(source: AsyncIterable<unknown>, size: number): AsyncGenerator<Buffer> {
  let part = Buffer.allocUnsafe(size);
  let length = 0;
  for await (const value of source) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    for (let offset = 0; offset < bytes.length;) {
      const count = Math.min(size - length, bytes.length - offset);
      bytes.copy(part, length, offset, offset + count);
      length += count;
      offset += count;
      if (length === size) {
        yield part;
        part = Buffer.allocUnsafe(size);
        length = 0;
      }
    }
  }
  if (length) yield part.subarray(0, length);
}

/**
 * A download as a stream that sends its request only once something reads it, and cancels the
 * download when the reader stops early, such as when a browser closes the connection.
 */
export function lazyDownload(open: () => Promise<Response>): Readable {
  return Readable.from(
    (async function* () {
      const response = await open();
      if (!response.body) return;
      for await (const chunk of response.body)
        yield Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    })(),
    { objectMode: false },
  );
}

/** A failure's system code, such as `ECONNREFUSED` or `EACCES`, or `TIMEOUT`, found through its causes. */
export function failureCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,40}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : null;
}

/** The keys Riosoma stores files under: attachment IDs and their previews. */
export function checkedKey(key: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error('Invalid file storage key');
  return key;
}
