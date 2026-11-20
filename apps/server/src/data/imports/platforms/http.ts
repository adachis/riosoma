import { AppError } from '@riosoma/contracts';
import type { z } from 'zod';
import type { Resolve } from '../../../automations/outbound.js';
import type { Clock, RateLimiter } from '../core/clock.js';
import { download, DownloadError, type Download } from '../download.js';

/**
 * A tool's REST API, as an import reads it, through the same guarded client attachments use: every
 * address a host resolves to has to pass the private-network rule, the connection goes to the
 * address that was checked, and credentials go along on a redirect only while it stays on the same
 * origin.  Plain `http` is refused unless the rule allows the address, since a token would otherwise
 * cross the internet unencrypted.  Requests keep to the tool's rate: a 429 pauses every request to
 * that tool for as long as it asks (30 seconds unless it says) before trying again, and network
 * trouble and 5xx answers are tried again after a growing wait.  Credentials go only in headers,
 * and anything the tool sends back has them taken out before anything else reads it.
 */

/** How long a tool is waited for after answering 429 when it doesn't say */
export const RATE_LIMIT_WAIT_MS = 30_000;
/** Tries for one request before the import gives up on it */
export const TRIES = 6;
const FIRST_BACKOFF_MS = 1_000;
const REQUEST_TIMEOUT_MS = 60_000;
/** The most one answer may hold */
const ANSWER_BYTES = 128 * 1024 * 1024;
const REDACTED = '[redacted]';
const JSON_DEPTH = 64;
const JSON_VALUES = 1_000_000;

/** What a request is for, which decides how a refusal reads. */
export type Purpose = 'list' | 'base';

export function tokenInvalid(): AppError {
  return new AppError('validation_failed', 'import.platform.tokenInvalid', {
    fields: { token: 'import.platform.tokenInvalid' },
  });
}

const addressProblem = (key: string) => new AppError('validation_failed', key, { fields: { address: key } });
const unreadable = () => new AppError('unavailable', 'import.platform.unreadable');
const unavailable = () => new AppError('unavailable', 'import.platform.unavailable');
const rateLimited = () => new AppError('rate_limited', 'import.platform.rateLimited');

/** Keep the response status so optional reads can distinguish premium restrictions from bad data. */
export class PlatformResponseError extends AppError {
  constructor(
    readonly responseStatus: number,
    error: AppError,
  ) {
    super(error.code, error.messageKey, {
      params: error.params,
      fields: error.fields,
      issues: error.issues,
    });
  }
}

function refused(status: number, purpose: Purpose): AppError {
  if (status === 401) return tokenInvalid();
  if (purpose === 'list') {
    if (status === 403)
      return new AppError('validation_failed', 'import.platform.forbidden', {
        fields: { token: 'import.platform.forbidden' },
      });
    if (status === 404 || status === 405) return addressProblem('import.platform.notFound');
  }
  if (status === 403 || status === 404) return new AppError('not_found', 'import.platform.baseUnavailable');
  return unreadable();
}

/** How long a 429 answer asks to wait, in milliseconds. */
function retryAfter(headers: Download['headers']): number {
  const header = headers['retry-after'];
  const text = Array.isArray(header) ? header[0] : header;
  const seconds = text && /^\d{1,5}$/.test(text.trim()) ? Number(text) : null;
  return seconds === null ? RATE_LIMIT_WAIT_MS : Math.max(1_000, seconds * 1_000);
}

async function readAll(answer: Download): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of answer.body) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export interface ClientOptions {
  /** The tool's address, as the server keeps it, without a slash at the end */
  address: string;
  clock: Clock;
  limiter: RateLimiter;
  resolve: Resolve;
  /** Whether a request to this address may reach a private network */
  allowPrivate(url: URL): boolean;
  signal?: AbortSignal;
  /** The headers that prove who's asking */
  credentials(): Record<string, string>;
  /** Everything secret the credentials hold, to take out of answers */
  secrets(): string[];
  /** Gets fresh credentials after a 401, answering whether it could */
  refresh?(): Promise<boolean>;
  rateLimitWaitMs?: number;
}

export interface RequestOptions {
  query?: Record<string, string | number | undefined> | URLSearchParams;
  method?: 'GET' | 'POST';
  body?: unknown;
  purpose?: Purpose;
  /** Sends no credentials, for signing in */
  anonymous?: boolean;
}

export class PlatformClient {
  constructor(readonly options: ClientOptions) {}

  /** Takes every secret out of anything the tool sends back, before it's read. */
  scrub(text: string): string {
    let clean = text;
    for (const secret of this.options.secrets()) if (secret) clean = clean.replaceAll(secret, REDACTED);
    return clean;
  }

  /** Decode escapes before redacting, with bounded work even for hostile nested answers. */
  private scrubJson(value: unknown): unknown {
    const root: Record<string, unknown> = { value };
    const pending = [{ parent: root, key: 'value', depth: 0 }];
    let visited = 0;
    while (pending.length) {
      const { parent, key, depth } = pending.pop()!;
      if (++visited > JSON_VALUES || depth > JSON_DEPTH) throw unreadable();
      const item = parent[key];
      if (typeof item === 'string') parent[key] = this.scrub(item);
      else if (item !== null && typeof item === 'object') {
        const entries = Object.entries(item);
        if (visited + pending.length + entries.length > JSON_VALUES) throw unreadable();
        const clean = (Array.isArray(item) ? [] : {}) as Record<string, unknown>;
        parent[key] = clean;
        for (const [name, child] of entries) {
          const safe = Array.isArray(item) ? name : this.scrub(name);
          Object.defineProperty(clean, safe, {
            value: child,
            writable: true,
            enumerable: true,
            configurable: true,
          });
          pending.push({ parent: clean, key: safe, depth: depth + 1 });
        }
      }
    }
    return root.value;
  }

  /** The address of a path on the tool. */
  url(path: string, query?: RequestOptions['query']): URL {
    const url = new URL(`${this.options.address}${path}`);
    if (query instanceof URLSearchParams)
      for (const [key, value] of query) url.searchParams.append(key, value);
    else
      for (const [key, value] of Object.entries(query ?? {}))
        if (value !== undefined) url.searchParams.set(key, String(value));
    return url;
  }

  /** Refuses plain `http` to an address the private-network rule doesn't allow. */
  check(url: URL): void {
    if (url.protocol === 'http:' && !this.options.allowPrivate(url))
      throw addressProblem('import.platform.https');
  }

  /** The headers a download from the tool itself needs, for attachments it serves. */
  headers(): Record<string, string> {
    return this.options.credentials();
  }

  async json<T>(path: string, schema: z.ZodType<T>, options: RequestOptions = {}): Promise<T> {
    const { clock, limiter, signal } = this.options;
    const url = this.url(path, options.query);
    this.check(url);
    const purpose = options.purpose ?? 'base';
    let backoff = FIRST_BACKOFF_MS;
    let refreshed = false;
    for (let attempt = 1; ; attempt++) {
      signal?.throwIfAborted();
      await limiter.take(signal);
      let answer: Download;
      try {
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        answer = await download(url.href, {
          resolve: this.options.resolve,
          allowPrivate: (target) => this.options.allowPrivate(target),
          allowUrl: (target) => target.origin === new URL(this.options.address).origin,
          maxBytes: ANSWER_BYTES,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          timeoutMs: REQUEST_TIMEOUT_MS,
          anyStatus: true,
          method: options.method ?? 'GET',
          headers: {
            accept: 'application/json',
            ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(options.anonymous ? {} : this.options.credentials()),
          },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        });
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof DownloadError && error.problem === 'blocked')
          throw addressProblem('import.platform.private');
        if (error instanceof DownloadError && error.problem === 'tooLarge') throw unreadable();
        if (attempt >= TRIES)
          throw purpose === 'list' ? addressProblem('import.platform.unreachable') : unavailable();
        await clock.sleep(backoff, signal);
        backoff *= 2;
        continue;
      }
      const { status } = answer;
      if (status === 429) {
        answer.body.destroy();
        if (attempt >= TRIES) throw rateLimited();
        // Every request to this tool waits, not just this one.
        const wait = this.options.rateLimitWaitMs;
        limiter.pause(
          wait === undefined
            ? retryAfter(answer.headers)
            : Math.max(retryAfter(answer.headers), wait * 2 ** (attempt - 1)),
        );
        continue;
      }
      if (status >= 500) {
        answer.body.destroy();
        if (attempt >= TRIES) throw unavailable();
        await clock.sleep(backoff, signal);
        backoff *= 2;
        continue;
      }
      if (status === 401 && !refreshed && !options.anonymous && this.options.refresh) {
        answer.body.destroy();
        refreshed = true;
        if (await this.options.refresh()) continue;
        throw tokenInvalid();
      }
      if (status < 200 || status >= 300) {
        answer.body.destroy();
        throw new PlatformResponseError(status, refused(status, purpose));
      }
      let text: string;
      try {
        text = await readAll(answer);
      } catch {
        signal?.throwIfAborted();
        if (attempt >= TRIES) throw unavailable();
        continue;
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw purpose === 'list' ? addressProblem('import.platform.notFound') : unreadable();
      }
      const parsed = schema.safeParse(this.scrubJson(json));
      if (!parsed.success)
        throw purpose === 'list' ? addressProblem('import.platform.notFound') : unreadable();
      return parsed.data;
    }
  }
}
