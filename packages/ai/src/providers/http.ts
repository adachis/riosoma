import { ProviderError, type ProviderConfig } from '../types.js';
import { PROVIDER_MESSAGE_KEYS, errorFromStatus, networkFailure, parseJson, secretsOf } from './errors.js';

/** A call silent for this long has stalled.  The model decides how long a reply takes, not the clock. */
export const DEFAULT_TIMEOUT_MS = 60_000;
/** Error bodies are only quoted in an error's detail, so reading more than this is pointless. */
const BODY_LIMIT = 65_536;

/** One server-sent event, as the streaming format defines it. */
export interface SseEvent {
  /** The `event:` name, for providers that name their events */
  event?: string;
  data: string;
}

export interface HttpRequest {
  url: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  method?: 'GET' | 'POST' | 'PUT';
  /** Provider headers; `ProviderConfig.headers` is merged over these, and both over the defaults */
  headers?: Record<string, string>;
  /** Sent as JSON; a request without one is a GET */
  body?: unknown;
  config: ProviderConfig;
  signal?: AbortSignal;
}

/**
 * A deadline that starts over with every chunk received, so a model that spends a minute thinking
 * before its first token is not cut off, while a socket that has gone quiet is.  One controller
 * carries both the caller's abort and the timeout to `fetch` and to the body reader.
 */
class IdleDeadline {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stalled = false;
  private readonly forward = (): void => {
    this.controller.abort(this.caller?.reason);
  };

  constructor(
    readonly ms: number,
    private readonly caller?: AbortSignal,
  ) {
    caller?.addEventListener('abort', this.forward, { once: true });
    this.touch();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get timedOut(): boolean {
    return this.stalled;
  }

  touch(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.stalled = true;
      this.controller.abort();
    }, this.ms);
    // A stream nobody is waiting for must not be the only thing holding the process open.
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.caller?.removeEventListener('abort', this.forward);
  }
}

/** A config's endpoint wins, so a proxy, a gateway, or a local server can stand in for a provider. */
export function baseUrlFor(config: ProviderConfig, fallback: string): string {
  return (config.baseUrl ?? fallback).replace(/\/+$/, '');
}

export function timeoutFor(config: ProviderConfig): number {
  return config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS;
}

/** Merges header sets case-insensitively, so a config's `Authorization` replaces the default one. */
export function mergeHeaders(...sets: Array<Record<string, string> | undefined>): Record<string, string> {
  const merged = new Map<string, string>();
  for (const set of sets) {
    for (const [name, value] of Object.entries(set ?? {})) merged.set(name.toLowerCase(), value);
  }
  return Object.fromEntries(merged);
}

function initFor(request: HttpRequest, accept: string, signal: AbortSignal): RequestInit {
  const defaults: Record<string, string> = { accept };
  if (request.body !== undefined) defaults['content-type'] = 'application/json';
  return {
    method: request.method ?? (request.body === undefined ? 'GET' : 'POST'),
    headers: mergeHeaders(defaults, request.headers, request.config.headers),
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    signal,
  };
}

/**
 * A call the person already stopped must never reach the provider: it would spend tokens on an
 * answer nobody is waiting for.
 */
function refuseIfStopped(request: HttpRequest): void {
  if (request.signal?.aborted) {
    throw request.signal.reason ?? new DOMException('The call was aborted', 'AbortError');
  }
}

/** Sorts out why a call failed: our timeout, the caller's abort, or the provider. */
function translateFailure(error: unknown, deadline: IdleDeadline, request: HttpRequest): unknown {
  if (error instanceof ProviderError) return error;
  if (deadline.timedOut) {
    return new ProviderError(
      PROVIDER_MESSAGE_KEYS.timeout,
      undefined,
      `The provider sent nothing for ${deadline.ms} ms`,
      false,
      undefined,
      { cause: new DOMException(PROVIDER_MESSAGE_KEYS.timeout, 'TimeoutError') },
    );
  }
  if (request.signal?.aborted) return request.signal.reason ?? error;
  if (error instanceof Error && error.name === 'AbortError') return error;
  return networkFailure(error, secretsOf(request.config));
}

async function run<T>(deadline: IdleDeadline, request: HttpRequest, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw translateFailure(error, deadline, request);
  } finally {
    deadline.dispose();
  }
}

async function readCapped(response: Response): Promise<string> {
  const text = await response.text();
  return text.length > BODY_LIMIT ? text.slice(0, BODY_LIMIT) : text;
}

/** One JSON request and reply, used for catalogs and anything else that isn't streamed. */
export async function fetchJson<T>(request: HttpRequest): Promise<T> {
  refuseIfStopped(request);
  const deadline = new IdleDeadline(timeoutFor(request.config), request.signal);
  return run(deadline, request, async () => {
    const response = await (request.fetch ?? fetch)(
      request.url,
      initFor(request, 'application/json', deadline.signal),
    );
    // Full conversation replies can exceed the error-detail limit without being malformed.
    const body = response.ok ? await response.text() : await readCapped(response);
    if (!response.ok) {
      throw errorFromStatus(response.status, body, secretsOf(request.config), response.headers);
    }
    return parseJson<T>(body, secretsOf(request.config), 'The catalog response');
  });
}

/**
 * Posts a request and yields the server-sent events of the reply.  Nothing here logs: an error
 * carries the provider's own words, scrubbed of any credential.
 */
export async function* streamSse(request: HttpRequest): AsyncGenerator<SseEvent> {
  refuseIfStopped(request);
  const secrets = secretsOf(request.config);
  const deadline = new IdleDeadline(timeoutFor(request.config), request.signal);
  let response: Response;
  try {
    response = await (request.fetch ?? fetch)(
      request.url,
      initFor(request, 'text/event-stream', deadline.signal),
    );
    if (!response.ok) {
      throw errorFromStatus(response.status, await readCapped(response), secrets, response.headers);
    }
  } catch (error) {
    deadline.dispose();
    throw translateFailure(error, deadline, request);
  }
  try {
    yield* readEvents(response, deadline);
  } catch (error) {
    throw translateFailure(error, deadline, request);
  } finally {
    deadline.dispose();
  }
}

const BOUNDARY = /\r\n\r\n|\n\n|\r\r/;

async function* readEvents(response: Response, deadline: IdleDeadline): AsyncGenerator<SseEvent> {
  const body = response.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      deadline.touch();
      buffer += decoder.decode(value, { stream: true });
      for (let boundary = BOUNDARY.exec(buffer); boundary; boundary = BOUNDARY.exec(buffer)) {
        const raw = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const event = parseEvent(raw);
        if (event) yield event;
      }
    }
    buffer += decoder.decode();
    // Some proxies close without the last blank line; the event before it is still whole.
    const tail = parseEvent(buffer);
    if (tail) yield tail;
  } finally {
    // An unread body would keep the socket out of the pool, and an abandoned stream would leave the
    // provider generating tokens nobody is listening to.
    void reader.cancel().catch(() => undefined);
  }
}

function parseEvent(raw: string): SseEvent | undefined {
  const data: string[] = [];
  let event: string | undefined;
  for (const line of raw.split(/\r\n|\n|\r/)) {
    // A line starting with a colon is a comment, which providers and proxies send to stay connected.
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
  }
  if (!data.length) return undefined;
  return event === undefined ? { data: data.join('\n') } : { event, data: data.join('\n') };
}
