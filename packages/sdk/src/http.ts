import { message } from './messages.js';
import { RioClientError, apiError, isAbort, retryAfterSeconds } from './errors.js';
import { sleep as platformSleep, throwIfAborted } from './encoding.js';
import { refreshAccessToken, type OAuthTokens } from './oauth.js';
import type { Clock, FetchLike, FetchResponse, Query, ResponseParts, Sleep } from './types.js';

/**
 * The one path every call takes: it builds the address, sends the credential, waits out a rate
 * limit, refreshes an OAuth access token the server refused, and turns a failure into an error a
 * caller can act on.  Keeping that in one place is what lets the rest of the SDK read like the
 * API's own documentation, and what makes a change to retries or credentials reach every call.
 */

/** Tries for one call after a 429, not counting the first */
export const DEFAULT_RETRIES = 4;
/** The longest wait a 429 may ask for before the caller gets the failure instead */
export const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
/** How long the first wait is when a 429 carries no `Retry-After`, doubled after each try */
const FIRST_BACKOFF_MS = 500;
/** The header a write answers with, naming the group that undoes it */
export const UNDO_GROUP_HEADER = 'x-undo-group-id';
const RETRY_AFTER_HEADER = 'retry-after';

export interface CredentialsInput {
  /** A personal access token, `rio_pat_…` */
  token?: string | null;
  /** An OAuth access token, which expires and may come with a refresh token */
  accessToken?: string | null;
  refreshToken?: string | null;
  /** The OAuth app the access token came from, needed to refresh it */
  clientId?: string | null;
  /** When the access token stops working, in milliseconds since the epoch */
  expiresAt?: number | null;
  /** How long the access token lasts, in seconds, as a token endpoint says it */
  expiresIn?: number | null;
}

/**
 * The credential a client sends, which a refresh replaces in place so every later call, including
 * one that waited out a rate limit, sends the fresh token.
 */
export class Credentials {
  token: string | null = null;
  accessToken: string | null = null;
  refreshToken: string | null = null;
  clientId: string | null = null;
  expiresAt: number | null = null;

  constructor(input: CredentialsInput = {}) {
    if (input.token && input.accessToken)
      throw new RioClientError('A client takes a personal access token or OAuth tokens, not both.', {
        code: 'invalid_options',
      });
    this.token = given(input.token, 'token');
    this.accessToken = given(input.accessToken, 'access token');
    this.refreshToken = given(input.refreshToken, 'refresh token');
    this.clientId = given(input.clientId, 'client ID');
    // A token endpoint says how long a token lasts rather than when it ends, and either is enough.
    this.expiresAt =
      input.expiresAt ??
      (typeof input.expiresIn === 'number' && Number.isFinite(input.expiresIn)
        ? Date.now() + input.expiresIn * 1_000
        : null);
  }

  /** What goes in the `Authorization` header, or null for a client with no credential */
  bearer(): string | null {
    return this.token ?? this.accessToken;
  }

  /** Whether an access token the server refused can be replaced with a fresh one */
  canRefresh(): boolean {
    return !this.token && Boolean(this.refreshToken && this.clientId);
  }

  /** Takes a token response in, keeping the refresh token it didn't send a new one with. */
  apply(tokens: OAuthTokens, now: number): void {
    this.accessToken = tokens.access_token;
    this.refreshToken = tokens.refresh_token ?? this.refreshToken;
    this.expiresAt = Number.isFinite(tokens.expires_in) ? now + tokens.expires_in * 1_000 : null;
  }

  /** Every secret this holds, so an error can be checked for them before anyone reads it. */
  secrets(): string[] {
    return [this.token, this.accessToken, this.refreshToken].filter((value): value is string =>
      Boolean(value && value.length >= 8),
    );
  }
}

function given(value: string | null | undefined, what: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !value.trim())
    throw new RioClientError(`A ${what} has to be a string with something in it.`, {
      code: 'invalid_credentials',
    });
  return value;
}

export interface TransportOptions {
  /** The server's address, with no path, such as `https://riosoma.example.com` */
  baseUrl: string;
  credentials: Credentials;
  fetchImpl: FetchLike;
  headers?: Record<string, string>;
  retries?: number;
  maxRetryDelayMs?: number;
  sleep?: Sleep;
  now?: Clock;
  /** Canceled with every call, for a caller that stops a whole run of them */
  signal?: AbortSignal;
  /** Told about fresh OAuth tokens, so a caller can store them before they're lost */
  onTokens?: (tokens: OAuthTokens) => void | Promise<void>;
}

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
  /** Send no credential, for the few routes anyone may read */
  anonymous?: boolean;
  /** Statuses that aren't a failure, beside the 2xx answers that never are */
  accept?: readonly number[];
}

export interface Answer<T> {
  data: T;
  status: number;
  headers: ResponseParts;
  undoGroupId: string | null;
}

export class Transport {
  private refreshing: Promise<void> | null = null;

  constructor(private readonly options: TransportOptions) {}

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  get credentials(): Credentials {
    return this.options.credentials;
  }

  private get now(): Clock {
    return this.options.now ?? (() => Date.now());
  }

  /** The address of a route, with a list parameter repeated the way the API reads one. */
  url(path: string, query?: Query): string {
    if (
      typeof path !== 'string' ||
      !path ||
      path !== path.trim() ||
      path.startsWith('//') ||
      /^[a-z][a-z0-9+.-]*:/i.test(path) ||
      /[\\#]/.test(path) ||
      Array.from(path).some(
        (character) => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f,
      ) ||
      path
        .split('?')[0]!
        .split('/')
        .some((part) => /^(?:\.|%2e){1,2}$/i.test(part))
    )
      throw new RioClientError(message('sdk.route.relative'), { code: 'invalid_options' });
    const base = new URL(this.options.baseUrl);
    // A base address may carry a path, for an install reached through a proxy, and it goes first.
    const prefix = base.pathname.replace(/\/+$/, '');
    const url = new URL(`${prefix}${path.startsWith('/') ? path : `/${path}`}`, base.origin);
    if (url.origin !== base.origin || (prefix && !url.pathname.startsWith(`${prefix}/`)))
      throw new RioClientError(message('sdk.route.relative'), { code: 'invalid_options' });
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(name, String(item));
        continue;
      }
      url.searchParams.set(name, String(value));
    }
    return url.toString();
  }

  async send<T>(method: string, path: string, options: RequestOptions = {}): Promise<Answer<T>> {
    const headers: Record<string, string> = { accept: 'application/json', ...this.options.headers };
    let body: string | undefined;
    if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers['content-type'] = 'application/json';
    }
    const answer = await this.exchange(method, this.url(path, options.query), headers, body, options);
    if (answer.status >= 400 && !options.accept?.includes(answer.status))
      throw apiError(answer.status, answer.text, answer.headers, {
        undoGroupId: answer.headers.get(UNDO_GROUP_HEADER),
        retryAfterSeconds: retryAfterSeconds(answer.headers.get(RETRY_AFTER_HEADER)),
      });
    return {
      data: parse<T>(answer.text, answer.status),
      status: answer.status,
      headers: answer.headers,
      undoGroupId: answer.headers.get(UNDO_GROUP_HEADER),
    };
  }

  /** Sends one call, waiting out rate limits and refreshing a credential the server refused. */
  private async exchange(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: string | undefined,
    options: RequestOptions,
  ): Promise<{ status: number; text: string; headers: ResponseParts }> {
    const retries = this.options.retries ?? DEFAULT_RETRIES;
    const limit = this.options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    const wait = this.options.sleep ?? platformSleep;
    const signal = combine(this.options.signal, options.signal);
    let refreshed = false;
    let rateRetries = 0;
    for (;;) {
      throwIfAborted(signal);
      const sent: Record<string, string> = { ...headers };
      const bearer = options.anonymous ? null : this.credentials.bearer();
      if (bearer) sent.authorization = `Bearer ${bearer}`;
      let response: FetchResponse;
      try {
        response = await this.options.fetchImpl(url, {
          method,
          redirect: 'error',
          headers: sent,
          ...(body === undefined ? {} : { body }),
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (isAbort(error) || signal?.aborted) throw error;
        throw new RioClientError(`${originOf(url)} could not be reached.`, {
          code: 'unreachable',
          cause: error,
        });
      }
      // Every answer is read here, so a body nobody looks at can't hold a connection open.  The
      // secrets are read each time, since a refresh in this loop adds one.
      const text = this.redactor()(await readText(response));
      if (response.status === 429 && rateRetries < retries) {
        const delay = retryAfterMs(response.headers) ?? FIRST_BACKOFF_MS * 2 ** rateRetries;
        if (delay <= limit) {
          rateRetries += 1;
          await wait(delay, signal);
          continue;
        }
      }
      if (response.status === 401 && !refreshed && !options.anonymous && this.credentials.canRefresh()) {
        refreshed = true;
        // A late refusal may refer to the token another request has already replaced.
        if (this.refreshing) await this.refreshing;
        else if (bearer === this.credentials.bearer()) await this.refresh();
        continue;
      }
      return { status: response.status, text, headers: response.headers };
    }
  }

  /** Replaces an OAuth access token with a fresh one, and tells the caller what arrived. */
  private refresh(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.replaceTokens().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async replaceTokens(): Promise<void> {
    const credentials = this.credentials;
    const tokens = await refreshAccessToken({
      baseUrl: this.options.baseUrl,
      clientId: credentials.clientId ?? '',
      refreshToken: credentials.refreshToken ?? '',
      fetchImpl: this.options.fetchImpl,
    });
    credentials.apply(tokens, this.now());
    await this.options.onTokens?.(tokens);
  }

  /** Takes secrets out of text that came from the server, before it can reach a log or a screen. */
  private redactor(): (text: string) => string {
    const secrets = this.credentials.secrets();
    return (text) => secrets.reduce((value, secret) => value.replaceAll(secret, '[redacted]'), text);
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'The server';
  }
}

/**
 * How long a 429 asks a caller to wait, reading both the seconds and the date forms of
 * `Retry-After`, or null when it carries neither.
 */
export function retryAfterMs(headers: ResponseParts): number | null {
  const seconds = retryAfterSeconds(headers.get(RETRY_AFTER_HEADER));
  return seconds === null ? null : seconds * 1_000;
}

async function readText(response: FetchResponse): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    throw new RioClientError('The answer stopped before its body arrived.', {
      code: 'unreadable',
      cause: error,
    });
  }
}

function parse<T>(text: string, status: number): T {
  if (!text) return (status === 204 ? null : undefined) as T;
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new RioClientError(`The answer was not JSON: ${text.slice(0, 200)}`, {
      code: 'unreadable',
      cause: error,
    });
  }
}

/** One signal that gives up when either of the two does, or none when there's nothing to watch. */
export function combine(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (!present.length) return undefined;
  if (present.length === 1) return present[0];
  const controller = new AbortController();
  for (const signal of present) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
