import { retryAfterMs } from '@riosoma/connectors';
import { DownloadError, download } from '../data/imports/download.js';
import {
  DestinationError,
  registerOutboundHttp,
  type OutboundHttp,
  type OutboundHttpOptions,
  type OutboundRequest,
} from './destination.js';

/**
 * One guarded way out for every destination call.  It sends only to the adapter's own origin,
 * through the server's download guard, so the address check, the pacing, the retries, and the
 * scrubbing of credentials out of answers are the same for every kind.  It never logs a body or a
 * header, and it never lets a credential reach a log line or a thrown problem.
 */

const MAX_BYTES = 32 * 1024 * 1024;
const TIMEOUT_MS = 60_000;
const ERROR_BODY_CAP = 64 * 1024;
const MAX_TRIES = 6;

/** Failures that mean nothing was sent, so the request was never carried out. */
const BEFORE_SEND = new Set([
  'resolve',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EACCES',
]);

/** Replaces every secret substring with nothing, through the whole of a value. */
function scrub<T>(value: T, secrets: readonly string[]): T {
  if (!secrets.length) return value;
  const clean = (text: string): string =>
    secrets.reduce((acc, secret) => (secret ? acc.split(secret).join('') : acc), text);
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return clean(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object')
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child)]));
    return node;
  };
  return walk(value) as T;
}

async function readBody(stream: NodeJS.ReadableStream, cap: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    chunks.push(buffer);
    if (size >= cap) break;
  }
  return Buffer.concat(chunks).toString('utf8').slice(0, cap);
}

function parse(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

export function createOutboundHttp(options: OutboundHttpOptions): OutboundHttp {
  const { adapter, where, credential, limiter, clock, resolve, allowPrivate, signal, log } = options;
  const base = (options.address ?? adapter.address(where as never)).replace(/\/+$/, '');
  const origin = new URL(base).origin;
  const headers = adapter.headers(credential);
  const secrets = adapter.secrets(credential);

  async function send<T>(request: OutboundRequest<T>): Promise<T> {
    const query = request.query?.toString();
    const url = `${base}${request.path}${query ? `?${query}` : ''}`;
    const call = { method: request.method, path: request.path };
    const body = request.body === undefined ? undefined : JSON.stringify(request.body);

    let tries = 0;
    for (;;) {
      tries += 1;
      await limiter.take(signal);
      let answer: Awaited<ReturnType<typeof download>>;
      try {
        answer = await download(url, {
          resolve,
          allowPrivate,
          maxBytes: MAX_BYTES,
          timeoutMs: TIMEOUT_MS,
          signal,
          method: request.method,
          headers: {
            ...headers,
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body,
          allowUrl: (candidate) => candidate.origin === origin,
          anyStatus: true,
        });
      } catch (error) {
        if (error instanceof DownloadError && error.problem === 'blocked') {
          log?.({ ...call, status: null, messageKey: 'syncOut.destination.private' });
          throw new DestinationError(
            { messageKey: 'syncOut.destination.private', scope: 'sync' },
            { status: null },
          );
        }
        if (error instanceof DownloadError && error.problem === 'tooLarge') {
          log?.({ ...call, status: null, messageKey: 'syncOut.destination.unreadable' });
          throw new DestinationError(
            { messageKey: 'syncOut.destination.unreadable', scope: 'run' },
            { status: null, unconfirmed: !request.idempotent },
          );
        }
        const detail = error instanceof DownloadError ? error.detail : undefined;
        if (detail && BEFORE_SEND.has(detail)) {
          log?.({ ...call, status: null, messageKey: 'syncOut.destination.unreachable' });
          throw new DestinationError(
            { messageKey: 'syncOut.destination.unreachable', scope: 'run' },
            { status: null },
          );
        }
        // A connection that dropped after the request may have been carried out.
        if (request.idempotent && tries < MAX_TRIES) {
          await clock.sleep(1000 * 2 ** (tries - 1), signal);
          continue;
        }
        if (!request.idempotent) {
          log?.({ ...call, status: null, messageKey: 'syncOut.destination.unconfirmed' });
          throw new DestinationError(
            { messageKey: 'syncOut.destination.unconfirmed', scope: 'run' },
            { status: null, unconfirmed: true },
          );
        }
        log?.({ ...call, status: null, messageKey: 'syncOut.destination.unavailable' });
        throw new DestinationError(
          { messageKey: 'syncOut.destination.unavailable', scope: 'run' },
          { status: null },
        );
      }

      const status = answer.status;
      if (status >= 200 && status < 300) {
        const text = await readBody(answer.body, MAX_BYTES);
        const parsed = scrub(parse(text), secrets);
        const checked = request.schema.safeParse(parsed);
        if (!checked.success) {
          log?.({ ...call, status, messageKey: 'syncOut.destination.unreadable' });
          throw new DestinationError(
            { messageKey: 'syncOut.destination.unreadable', scope: 'run' },
            { status, unconfirmed: !request.idempotent },
          );
        }
        log?.({ ...call, status });
        return checked.data;
      }

      const bodyText = await readBody(answer.body, ERROR_BODY_CAP);
      const errorBody = scrub(parse(bodyText), secrets);

      if (status === 429) {
        const problem = adapter.problem(status, errorBody, call);
        if (problem.scope === 'sync') {
          log?.({ ...call, status, messageKey: problem.messageKey });
          throw new DestinationError(problem, { status });
        }
        if (tries < MAX_TRIES) {
          const header = answer.headers['retry-after'];
          const wait =
            retryAfterMs(Array.isArray(header) ? header[0] : header, clock.now()) ?? adapter.pacing.waitMs;
          limiter.pause(wait);
          continue;
        }
        log?.({ ...call, status, messageKey: 'syncOut.destination.rateLimited' });
        throw new DestinationError(
          { messageKey: 'syncOut.destination.rateLimited', scope: 'run' },
          { status },
        );
      }

      if (status >= 500) {
        if (request.idempotent && tries < MAX_TRIES) {
          await clock.sleep(1000 * 2 ** (tries - 1), signal);
          continue;
        }
        if (!request.idempotent) {
          log?.({ ...call, status, messageKey: 'syncOut.destination.unconfirmed' });
          throw new DestinationError(
            { messageKey: 'syncOut.destination.unconfirmed', scope: 'run' },
            { status, unconfirmed: true },
          );
        }
        log?.({ ...call, status, messageKey: 'syncOut.destination.unavailable' });
        throw new DestinationError(
          { messageKey: 'syncOut.destination.unavailable', scope: 'run' },
          { status },
        );
      }

      const problem = adapter.problem(status, errorBody, call);
      log?.({ ...call, status, messageKey: problem.messageKey });
      throw new DestinationError(problem, { status });
    }
  }

  return { send };
}

let installed = false;

/** Registers the one HTTP layer the engine and routes use.  Safe to call more than once. */
export function installOutboundHttp(): void {
  if (installed) return;
  installed = true;
  registerOutboundHttp(createOutboundHttp);
}
