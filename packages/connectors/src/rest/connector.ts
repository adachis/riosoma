import { createHash } from 'node:crypto';
import type {
  CellValue,
  RestConnection,
  RestEndpoint,
  SourceObject,
  SourceSelect,
  SourceTestResult,
  TestStep,
} from '@riosoma/contracts';
import { transportFailure, withErrorDiagnostic } from './errors.js';
import { Budget } from '../common.js';
import { nodeSockets, type Sockets } from '../files/connector.js';
import { FileNetworkError, NO_NETWORK, type FileNetwork, type FileResponse } from '../files/network.js';
import type { FileCell } from '../files/cells.js';
import { sourceKey } from '../registry.js';
import { positive } from '../sql.js';
import {
  ConnectorError,
  type Connector,
  type ConnectorContext,
  type SourcePreviewRows,
  type SourceRow,
} from '../types.js';
import { scrubDetail } from '../warehouses/errors.js';
import { RowBatcher } from '../warehouses/values.js';
import {
  cachedToken,
  forgetToken,
  keepToken,
  nextLink,
  pace,
  reserveRequest,
  requestSlot,
  retryAfterMs,
  sleep,
  tokenKey,
  UNDATED_TOKEN_MS,
} from './http.js';
import {
  cellsOf,
  isRecordObject,
  KeyScan,
  listPaths,
  parseJson,
  plainColumn,
  SAMPLE_PAGES,
  Sampler,
  textAt,
  valueAt,
  type RestColumn,
} from './records.js';

/**
 * A web API that answers in JSON, read an endpoint at a time.  Each endpoint is offered like a
 * table: its records arrive a page at a time in whatever paging style the API uses, and become
 * rows through the same type rules file sources use.
 *
 * Every request goes through the server's guarded network, so the private-network rule, the
 * checks on each redirect, and the size limit on each answer hold here as they do for files.  Only
 * GET requests reach the API.  The one other request is OAuth's token request, which is a POST by
 * the standard's own rule and never follows a redirect.  Requests keep an even pace per API, a 429
 * or 503 is waited out as long as its Retry-After asks within a bound, and every call has a
 * deadline and stops when its caller gives up.  No secret, and no token got with one, ever
 * reaches a message.
 */

type Auth = RestConnection['auth'];
type OAuth = Extract<Auth, { method: 'oauth-client' }>;

export const REST_KEYS = {
  https: 'sources.rest.https',
  blocked: 'sources.rest.blocked',
  tls: 'sources.rest.tls',
  connect: 'sources.rest.connect',
  resolve: 'sources.rest.resolve',
  signIn: 'sources.rest.signIn',
  deniedToken: 'sources.rest.deniedToken',
  deniedKey: 'sources.rest.deniedKey',
  deniedPassword: 'sources.rest.deniedPassword',
  deniedOauth: 'sources.rest.deniedOauth',
  oauthDenied: 'sources.rest.oauthDenied',
  oauthFailed: 'sources.rest.oauthFailed',
  notFound: 'sources.rest.notFound',
  status: 'sources.rest.status',
  rateLimited: 'sources.rest.rateLimited',
  notJson: 'sources.rest.notJson',
  records: 'sources.rest.records',
  pageLimit: 'sources.rest.pageLimit',
  recordLimit: 'sources.rest.recordLimit',
  pagingLoop: 'sources.rest.pagingLoop',
  nextElsewhere: 'sources.rest.nextElsewhere',
  tooLarge: 'sources.rest.tooLarge',
  noQueries: 'sources.rest.noQueries',
  read: 'sources.sync.read',
  objectMissing: 'sources.sync.objectMissing',
  secretsMissing: 'sources.secretsMissing',
  timeout: 'sources.test.timeout',
} as const;

/**
 * Keys a failed test step carries as they are.  The others need a value filled in, or say less
 * than the step's own advice does.
 */
const ADVICE = new Set<string>(
  [...Object.values(REST_KEYS), 'sources.graphql.errors', 'sources.graphql.pageInfo'].filter(
    (key) =>
      ![
        REST_KEYS.read,
        REST_KEYS.objectMissing,
        REST_KEYS.tooLarge,
        REST_KEYS.pageLimit,
        REST_KEYS.recordLimit,
      ].includes(key as never),
  ),
);

/** What a refused request most likely needs, by how the source signs in. */
const DENIED: Record<Auth['method'], string> = {
  none: REST_KEYS.signIn,
  bearer: REST_KEYS.deniedToken,
  header: REST_KEYS.deniedKey,
  query: REST_KEYS.deniedKey,
  basic: REST_KEYS.deniedPassword,
  'oauth-client': REST_KEYS.deniedOauth,
};

export interface RestConnectorOptions {
  /** The guarded network the server supplies.  Without one, nothing is reached. */
  network?: FileNetwork;
  accept?: string;
  /** Metadata is read before records through the same guarded call and request budget. */
  prepare?(
    ctx: ConnectorContext,
    records: (endpoint: RestEndpoint, document?: (value: unknown) => unknown) => AsyncIterable<unknown[]>,
  ): Promise<void>;
  /** Declared columns remain available when the source contains no rows. */
  columnNames?(): readonly string[];
  queryBody?(ctx: ConnectorContext, url: URL): string;
  /** Adds a discovered projection to a page before the existing request rules run. */
  requestUrl?(ctx: ConnectorContext, url: URL): URL;
  /** Additional projections share the active call's deadline, cancellation, and retry limits. */
  document?(
    ctx: ConnectorContext,
    url: URL,
    value: unknown,
    request: (url: URL, queryBody?: string) => Promise<Buffer>,
  ): unknown | Promise<unknown>;
  /** Classify answers before renewal or parsing.  An unclassified 401 can renew its token once. */
  responseError?(
    ctx: ConnectorContext,
    status: number,
    body: Buffer,
    hidden: ReadonlySet<string>,
    canRenewToken: boolean,
    headers: Readonly<Record<string, string | undefined>>,
  ): ConnectorError | undefined;
  sockets?: Sockets;
  /** The most one answer may hold: 50 MB unless set */
  maxPageBytes?: number;
  /** How long a sync's whole read may take: 20 minutes unless set */
  deadlineMs?: number;
  /** The longest a Retry-After is waited out before the call gives up: 60 seconds unless set */
  maxRetryWaitMs?: number;
  /** Receives safe diagnostics when an app failure has no specific message. */
  onUnexpectedError?(diagnostic: { errorClass: string; errorCode?: string }): void;
  /** How often one throttled or unavailable request is tried again: 5 times unless set */
  retries?: number;
  /** How long finding key candidates may read before it offers none: 15 seconds unless set */
  keyScanMs?: number;
  /** Keys declared by a preset, so an empty account can still offer its stable key. */
  keyColumns?: readonly string[];
  /** Declarative app fields are projected before sampling, key scans, and conversion. */
  record?(value: unknown): unknown;
  /** Independent field projections page separately and join by their stable record key. */
  recordGroups?: { endpoints: readonly RestEndpoint[]; key: string; changedMessageKey: string };
  lastPage?: { path: string; value: boolean };
  /** Fixed preset headers accompany every guarded API request. */
  headers?: Readonly<Record<string, string>>;
  /** A rolling request budget, shared per account, including retries and discovery. */
  requestLimit?: { count: number; windowMs: number };
  /** Stable organization identity keeps limits intact when credentials rotate. */
  rateLimitKey?: string;
  maxConcurrent?: number;
  /** The clock tokens expire and Retry-After dates are read by */
  now?: () => number;
}

/** An API connector, which can also show an endpoint's first page while it's being set up. */
export interface RestConnector extends Connector {
  request(ctx: RestConnectorContext, url: URL): Promise<Buffer>;
  records(ctx: ConnectorContext, select: SourceSelect): AsyncGenerator<unknown[]>;
  firstPage(ctx: ConnectorContext, select: SourceSelect, limit: number): Promise<SourcePreviewRows>;
}

export interface RestConnectorContext extends ConnectorContext {
  /** Absolute deadline in milliseconds for an app operation that spans multiple REST calls. */
  deadlineAt?: number;
}

export function isRestConnector(connector: Connector): connector is RestConnector {
  return connector.kind === 'rest' && 'firstPage' in connector;
}

const DEFAULT_PAGE_BYTES = 50 * 1024 * 1024;
const DEFAULT_DEADLINE_MS = 20 * 60_000;
const DEFAULT_RETRY_WAIT_MS = 60_000;
const DEFAULT_RETRIES = 5;
const DEFAULT_KEY_SCAN_MS = 15_000;
/** How much of an error answer is read for the API's own words. */
const ERROR_BYTES = 16 * 1024;
const TOKEN_BYTES = 64 * 1024;
/** How much of the API's own words a message keeps. */
const WORDS = 300;

/** One answer, read whole. */
interface Answer {
  status: number;
  headers: Record<string, string | undefined>;
  url: URL;
  body: Buffer;
  document?: { value: unknown };
}

/** One page of an endpoint: its records, and whether the API says it's the last. */
interface Page {
  records: unknown[];
  last: boolean;
  answer: Answer;
}

/** One call's settings, when it must stop, and the values no message of its may hold. */
interface Call {
  ctx: ConnectorContext;
  settings: RestConnection;
  signal: AbortSignal;
  deadline: number;
  idleMs: number;
  /** Tokens and sign-in headers made from the secrets, which a scrubbed message must also hide */
  hidden: Set<string>;
}

function megabytes(bytes: number): number {
  return Math.floor(bytes / 1024 / 1024);
}

/** The address an endpoint's first page is at, before paging adds to it. */
export function endpointUrl(baseUrl: string, endpoint: Pick<RestEndpoint, 'path' | 'query'>): URL {
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  const rest = endpoint.path.replace(/^\/+/, '');
  const url = new URL(base.href);
  if (rest) url.pathname = `${basePath}/${rest}`;
  // The contract keeps a path from leaving its base, and this makes sure of it.
  if (url.origin !== base.origin || !url.pathname.startsWith(basePath))
    throw new ConnectorError(REST_KEYS.read, 'the endpoint’s path leaves its base address');
  for (const { name, value } of endpoint.query) url.searchParams.append(name, value);
  return url;
}

/** The first page's address, with the paging parameters a first page asks with. */
export function firstUrl(settings: Pick<RestConnection, 'baseUrl'>, endpoint: RestEndpoint): URL {
  const url = endpointUrl(settings.baseUrl, endpoint);
  const { paging } = endpoint;
  if (paging.style === 'last-record') {
    if (paging.sizeParam) url.searchParams.set(paging.sizeParam, String(paging.size));
  } else if (paging.style === 'page') {
    url.searchParams.set(
      paging.param,
      paging.valueTemplate?.replaceAll('{page}', String(paging.start)) ?? String(paging.start),
    );
    if (paging.sizeParam && paging.size !== undefined)
      url.searchParams.set(paging.sizeParam, String(paging.size));
  } else if (paging.style === 'offset') {
    url.searchParams.set(paging.offsetParam, '0');
    url.searchParams.set(paging.limitParam, String(paging.limit));
  }
  return url;
}

/**
 * An answer's body.  A whole one past its limit fails, which the server's network also makes sure
 * of, and an error answer is read only as far as its first bytes.
 */
export async function readBody(
  response: FileResponse,
  limit: number,
  whole: boolean,
  onChunk?: () => void,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      onChunk?.();
      chunks.push(chunk);
      size += chunk.length;
      if (size > limit && whole) throw new FileNetworkError('tooLarge', 'an answer passed the size limit');
      if (size >= limit && !whole) break;
    }
  } finally {
    response.close();
  }
  return whole ? Buffer.concat(chunks) : Buffer.concat(chunks).subarray(0, limit);
}

/** What an API said about a failure, in a few words: its message when it has one, its text otherwise. */
function apiWords(body: Buffer): string {
  const text = body.toString('utf8').replace(/^\uFEFF/, '');
  let words = text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecordObject(parsed)) {
      const said = ['message', 'error_description', 'error', 'detail', 'title']
        .map((name) => parsed[name])
        .find((value) => typeof value === 'string' && value.trim());
      if (typeof said === 'string') words = said;
    }
  } catch {
    // Plain text says what it says.
  }
  // An HTML page's markup says nothing useful.
  if (/^\s*</.test(words)) return '';
  words = words.replace(/\s+/g, ' ').trim();
  return words.length > WORDS ? `${words.slice(0, WORDS)}…` : words;
}

export function createRestConnector(options: RestConnectorOptions = {}): RestConnector {
  const network = options.network ?? NO_NETWORK;
  const sockets = options.sockets ?? nodeSockets;
  const maxPageBytes = options.maxPageBytes ?? DEFAULT_PAGE_BYTES;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const maxRetryWaitMs = options.maxRetryWaitMs ?? DEFAULT_RETRY_WAIT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const keyScanMs = options.keyScanMs ?? DEFAULT_KEY_SCAN_MS;
  const now = options.now ?? Date.now;

  function settingsOf(ctx: ConnectorContext): RestConnection {
    if (ctx.connection.kind !== 'rest')
      throw new ConnectorError(
        REST_KEYS.read,
        `the connection settings are for ${ctx.connection.kind}, not rest`,
      );
    return ctx.connection;
  }

  /** A call that stops after `ms`, or sooner when its caller gives up. */
  function begin(ctx: RestConnectorContext, ms: number, extra?: AbortSignal): Call {
    const settings = settingsOf(ctx);
    const start = Date.now();
    const deadline = Math.min(start + ms, ctx.deadlineAt ?? Infinity);
    return {
      ctx,
      settings,
      signal: AbortSignal.any([
        ...(ctx.signal ? [ctx.signal] : []),
        ...(extra ? [extra] : []),
        AbortSignal.timeout(Math.max(0, deadline - start)),
      ]),
      deadline,
      idleMs: positive(ctx.timeoutMs, 30000),
      hidden: new Set(
        [...Object.values(ctx.secrets), ...(ctx.serverSecrets ?? [])].filter(
          (secret): secret is string => typeof secret === 'string' && secret.length > 0,
        ),
      ),
    };
  }

  function secretOf(
    ctx: ConnectorContext,
    name: 'token' | 'apiKey' | 'password' | 'clientSecret' | 'refreshToken',
  ): string {
    const value = ctx.secrets[name];
    if (!value) throw new ConnectorError(REST_KEYS.secretsMissing, `the ${name} secret isn’t stored`);
    return value;
  }

  function scrubbed(detail: unknown, ctx: ConnectorContext, call?: Call): string | undefined {
    let text = scrubDetail(detail, ctx);
    if (text === undefined) return undefined;
    for (const value of [...(call?.hidden ?? [])].sort((a, b) => b.length - a.length))
      if (value.length >= 4) text = text.split(value).join('[redacted]');
    return text;
  }

  /** The error a call leaves with: a key people can act on, and scrubbed words behind it. */
  function failure(error: unknown, ctx: ConnectorContext, call?: Call): ConnectorError {
    if (
      error instanceof FileNetworkError &&
      error.problem === 'failed' &&
      error.detail === 'timeout' &&
      !ctx.signal?.aborted
    )
      error = new ConnectorError(REST_KEYS.timeout);
    if (error instanceof ConnectorError) {
      const timedOut = error.messageKey === REST_KEYS.timeout;
      const detail =
        error.detail !== undefined
          ? scrubbed(error.detail, ctx, call)
          : timedOut
            ? `the API took longer than ${positive(ctx.timeoutMs, 30000)} ms to answer`
            : ctx.signal?.aborted
              ? 'the call was stopped before it finished'
              : undefined;
      return new ConnectorError(
        timedOut ? REST_KEYS.read : error.messageKey,
        detail,
        timedOut ? { ...error.params, reason: 'timeout' } : error.params,
      );
    }
    const transport = transportFailure(error);
    if (transport && !call?.signal.aborted && !ctx.signal?.aborted)
      return new ConnectorError(REST_KEYS[transport.kind]);
    if (error instanceof FileNetworkError) {
      if (call?.signal.aborted && !ctx.signal?.aborted)
        return new ConnectorError(REST_KEYS.read, scrubbed(error.detail, ctx, call), { reason: 'timeout' });
      const detail = scrubbed(error.detail ?? error.problem, ctx, call);
      switch (error.problem) {
        case 'https':
          return new ConnectorError(REST_KEYS.https, detail);
        case 'blocked':
          return new ConnectorError(REST_KEYS.blocked, detail);
        case 'tooLarge':
          return new ConnectorError(REST_KEYS.tooLarge, detail, { megabytes: megabytes(maxPageBytes) });
        default:
          return new ConnectorError(REST_KEYS.read, detail);
      }
    }
    if (
      ctx.signal?.aborted ||
      call?.signal.aborted ||
      (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
    )
      return new ConnectorError(
        REST_KEYS.read,
        'the call was stopped or ran out of time before it finished',
        call?.signal.aborted && !ctx.signal?.aborted ? { reason: 'timeout' } : undefined,
      );
    return withErrorDiagnostic(new ConnectorError(REST_KEYS.read, scrubbed(error, ctx, call)), error);
  }

  /** The OAuth token for this client, from the cache while it lasts, or fresh from the token address. */
  async function token(call: Call, fresh = false): Promise<string> {
    const auth = call.settings.auth as OAuth;
    const secret = secretOf(call.ctx, 'clientSecret');
    const refresh = auth.grant === 'refresh_token' ? secretOf(call.ctx, 'refreshToken') : undefined;
    const key = tokenKey([auth, secret, refresh]);
    if (fresh) forgetToken(key);
    const cached = cachedToken(key, now());
    if (cached) {
      call.hidden.add(cached);
      return cached;
    }
    const url = new URL(auth.tokenUrl);
    if (!network.allowsAddress(url))
      throw new FileNetworkError('https', `${url.protocol} token addresses aren’t allowed`);
    const form = new URLSearchParams({ ...auth.tokenParams, grant_type: auth.grant ?? 'client_credentials' });
    if (refresh) form.set('refresh_token', refresh);
    if (auth.scope) form.set('scope', auth.scope);
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'Riosoma-Sources',
    };
    if (auth.clientAuth === 'basic') {
      // The standard form-encodes both parts before joining them.
      const encode = (text: string) => new URLSearchParams({ v: text }).toString().slice(2);
      const basic = Buffer.from(`${encode(auth.clientId)}:${encode(secret)}`).toString('base64');
      call.hidden.add(basic);
      headers.authorization = `Basic ${basic}`;
    } else {
      form.set('client_id', auth.clientId);
      form.set('client_secret', secret);
    }
    for (let attempt = 0; ; attempt++) {
      let response: Answer;
      try {
        response = await exchange(call, {
          url,
          method: 'POST',
          headers,
          body: form.toString(),
          maxBytes: TOKEN_BYTES,
        });
      } catch (error) {
        if (!call.signal.aborted && transportFailure(error)?.transient && (await retry(call, attempt)))
          continue;
        throw error;
      }
      if ([429, 500, 502, 503].includes(response.status)) {
        const asked = retryAfterMs(response.headers['retry-after'], now());
        if (await retry(call, attempt, asked)) continue;
        if (response.status === 429 || response.status === 503) throw limited(response, attempt, asked);
      }
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(response.body.toString('utf8'));
      } catch {
        // A token address that doesn't answer in JSON is covered below.
      }
      const answer = isRecordObject(parsed) ? parsed : {};
      if (response.status < 200 || response.status >= 300) {
        const code = typeof answer.error === 'string' ? answer.error.slice(0, 100) : '';
        const detail = `the token address answered HTTP ${response.status}${code ? ` ${code}` : ''}`;
        throw new ConnectorError(
          [400, 401, 403].includes(response.status)
            ? REST_KEYS.oauthDenied
            : response.status >= 400
              ? REST_KEYS.status
              : REST_KEYS.oauthFailed,
          detail,
          { status: response.status },
        );
      }
      const value = answer.access_token;
      if (typeof value !== 'string' || !value)
        throw new ConnectorError(REST_KEYS.oauthFailed, 'the token address answered without an access_token');
      call.hidden.add(value);
      const seconds = Number(answer.expires_in);
      const lasts = Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : UNDATED_TOKEN_MS;
      keepToken(key, value, now() + lasts, now());
      return value;
    }
  }

  /** A request's address and headers, signed in the source's way. */
  async function signed(
    call: Call,
    target: URL,
    freshToken: boolean,
  ): Promise<{ url: URL; headers: Record<string, string> }> {
    const url = new URL(target.href);
    const headers: Record<string, string> = {
      accept: options.accept ?? 'application/json',
      'user-agent': 'Riosoma-Sources',
      ...options.headers,
    };
    const { auth } = call.settings;
    switch (auth.method) {
      case 'none':
        break;
      case 'bearer':
        headers.authorization = `Bearer ${secretOf(call.ctx, 'token')}`;
        break;
      case 'header':
        headers[auth.name] = `${auth.prefix ?? ''}${secretOf(call.ctx, 'apiKey')}`;
        break;
      case 'query':
        url.searchParams.set(auth.name, secretOf(call.ctx, 'apiKey'));
        break;
      case 'basic': {
        const secret = secretOf(call.ctx, 'password');
        const basic = Buffer.from(
          auth.secretAsUsername ? `${secret}:${auth.user}` : `${auth.user}:${secret}`,
        ).toString('base64');
        call.hidden.add(basic);
        headers.authorization = `Basic ${basic}`;
        break;
      }
      case 'oauth-client':
        headers.authorization = `Bearer ${await token(call, freshToken)}`;
        break;
    }
    return { url, headers };
  }

  /** The key requests to one API share a pace under: its address and sign-in, never a secret. */
  function paceKey(settings: RestConnection): string {
    return JSON.stringify([
      settings.baseUrl,
      options.rateLimitKey ?? settings.auth,
      settings.requestsPerSecond,
    ]);
  }

  function checkActive(call: Call): void {
    call.signal.throwIfAborted();
    if (Date.now() >= call.deadline) throw new ConnectorError(REST_KEYS.timeout);
  }

  async function retry(call: Call, attempt: number, asked: number | null = null): Promise<boolean> {
    checkActive(call);
    const ms = asked ?? 1_000 * 2 ** attempt;
    if (attempt >= retries || ms > maxRetryWaitMs || Date.now() + ms >= call.deadline) return false;
    await sleep(ms, call.signal);
    checkActive(call);
    return true;
  }

  function limited(answer: Answer, attempt: number, asked: number | null): ConnectorError {
    return new ConnectorError(
      REST_KEYS.rateLimited,
      `HTTP ${answer.status}${asked === null ? '' : `, asked to wait ${Math.ceil(asked / 1_000)} seconds`} after ${attempt + 1} tries`,
      { status: answer.status },
    );
  }

  type Request = Omit<Parameters<FileNetwork['request']>[0], 'signal' | 'idleMs'>;

  /** Each attempt can time out while opening a connection, waiting for headers, or reading a body. */
  async function receive(call: Call, request: Request): Promise<Answer> {
    checkActive(call);
    const idle = new AbortController();
    const signal = AbortSignal.any([call.signal, idle.signal]);
    const timer = setTimeout(() => idle.abort(new FileNetworkError('failed', 'timeout')), call.idleMs);
    let stop!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      stop = () => reject(signal.reason);
      signal.addEventListener('abort', stop, { once: true });
    });
    let answer: Answer | undefined;
    let ok = false;
    let close: (() => void) | undefined;
    const open = async () => {
      const response = await network.request({ ...request, signal, idleMs: call.idleMs });
      if (signal.aborted) {
        response.close();
        signal.throwIfAborted();
      }
      const closeBody = () => {
        if (close) {
          close = undefined;
          response.close();
        }
      };
      close = closeBody;
      timer.refresh();
      ok = response.status >= 200 && response.status < 300;
      // Paging needs the response address without any credential carried in its query.
      const from = new URL(response.url.href);
      if (call.settings.auth.method === 'query') from.searchParams.delete(call.settings.auth.name);
      answer = { status: response.status, headers: response.headers, url: from, body: Buffer.alloc(0) };
      const body = await readBody(
        { ...response, close: closeBody },
        ok ? request.maxBytes : ERROR_BYTES,
        ok,
        () => {
          signal.throwIfAborted();
          timer.refresh();
        },
      );
      signal.throwIfAborted();
      return { ...answer, body };
    };
    try {
      return await Promise.race([stopped, open()]);
    } catch (error) {
      // A failed error body cannot replace a received refusal, status, or retry instruction.
      if (answer && !ok && !call.signal.aborted) return answer;
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      close?.();
    }
  }

  /** Token exchanges and API requests share pacing, concurrency, and the account's request budget. */
  async function exchange(call: Call, request: Request): Promise<Answer> {
    checkActive(call);
    if (!network.allowsAddress(request.url))
      throw new FileNetworkError('https', `${request.url.protocol} addresses aren’t allowed`);
    const release = options.maxConcurrent
      ? await requestSlot(
          tokenKey([call.settings.baseUrl, options.rateLimitKey ?? call.settings.auth]),
          options.maxConcurrent,
          call.signal,
        )
      : () => {};
    try {
      await pace(paceKey(call.settings), call.settings.requestsPerSecond, call.signal);
      checkActive(call);
      if (
        options.requestLimit &&
        !reserveRequest(
          tokenKey([
            call.settings.baseUrl,
            options.rateLimitKey ?? [call.settings.auth, call.ctx.secrets],
            options.requestLimit,
          ]),
          options.requestLimit,
          now(),
        )
      )
        throw new ConnectorError(REST_KEYS.rateLimited);
      const answer = await receive(call, request);
      checkActive(call);
      return answer;
    } finally {
      release();
    }
  }

  /**
   * Requests and body reads share one retry budget and the API's pace.  Transient transport,
   * server, and incomplete JSON failures use a bounded backoff or the server's Retry-After.
   * An OAuth token the API refuses is renewed once.
   */
  async function get(call: Call, target: URL, project = true, queryBody?: string): Promise<Answer> {
    if (project && options.requestUrl) target = options.requestUrl(call.ctx, new URL(target.href));
    let renewed = false;
    for (let attempt = 0; ; attempt++) {
      const { url, headers } = await signed(call, target, renewed);
      let answer: Answer;
      try {
        const body = queryBody ?? options.queryBody?.(call.ctx, target);
        answer = await exchange(call, {
          url,
          method: body !== undefined ? 'POST' : 'GET',
          headers: body !== undefined ? { ...headers, 'content-type': 'application/json' } : headers,
          ...(body !== undefined ? { body } : {}),
          maxBytes: maxPageBytes,
        });
      } catch (error) {
        if (!call.signal.aborted && transportFailure(error)?.transient && (await retry(call, attempt)))
          continue;
        throw error;
      }
      const canRenewToken = answer.status === 401 && call.settings.auth.method === 'oauth-client' && !renewed;
      const error = options.responseError?.(
        call.ctx,
        answer.status,
        answer.body,
        call.hidden,
        canRenewToken,
        answer.headers,
      );
      // A declared permission failure cannot be repaired by exchanging the same credentials again.
      if (canRenewToken && !error) {
        renewed = true;
        continue;
      }
      if (error && error.messageKey !== REST_KEYS.rateLimited) throw error;
      if ([429, 500, 502, 503].includes(answer.status) || error?.messageKey === REST_KEYS.rateLimited) {
        const asked = retryAfterMs(answer.headers['retry-after'], now());
        if (await retry(call, attempt, asked)) continue;
        if (answer.status === 429 || answer.status === 503 || error?.messageKey === REST_KEYS.rateLimited)
          throw limited(answer, attempt, asked);
      }
      if (
        answer.status >= 200 &&
        answer.status < 300 &&
        answer.status !== 204 &&
        !options.accept?.includes('xml')
      ) {
        try {
          answer.document = { value: documentOf(answer) };
        } catch {
          // Keep the terminal parsing error in the read step after sharing the transport retry budget.
          if (/^[\s\uFEFF]*(?:[{[]|$)/.test(answer.body.toString('utf8')) && (await retry(call, attempt)))
            continue;
        }
      }
      return answer;
    }
  }

  /** The error an answer outside 2xx stands for. */
  function refusal(call: Call, answer: Answer, endpoint: RestEndpoint): ConnectorError {
    const words = apiWords(answer.body);
    const detail = `HTTP ${answer.status}${words ? `: ${words}` : ''}`;
    if (answer.status === 401 || answer.status === 403)
      return new ConnectorError(DENIED[call.settings.auth.method], detail);
    if (answer.status === 404 || answer.status === 410)
      return new ConnectorError(REST_KEYS.notFound, detail, { endpoint: endpoint.name });
    return new ConnectorError(REST_KEYS.status, detail, { status: answer.status });
  }

  /** A projection stays on this API and uses the active call's transport and sign-in. */
  async function request(call: Call, url: URL, project = true, queryBody?: string): Promise<Buffer> {
    const base = new URL(call.settings.baseUrl);
    if (url.origin !== base.origin || url.username || url.password)
      throw new ConnectorError(REST_KEYS.nextElsewhere);
    const answer = await get(call, url, project, queryBody);
    if (answer.status < 200 || answer.status >= 300) throw refusal(call, answer, call.settings.endpoints[0]!);
    return answer.body;
  }

  async function pageDocument(call: Call, url: URL, answer: Answer): Promise<unknown> {
    const parsed = answer.document ? answer.document.value : documentOf(answer);
    return options.document
      ? options.document({ ...call.ctx, signal: call.signal }, url, parsed, (next, queryBody) =>
          request(call, next, false, queryBody),
        )
      : parsed;
  }

  function documentOf(answer: Answer): unknown {
    try {
      return parseJson(answer.body.toString('utf8').replace(/^\uFEFF/, ''));
    } catch {
      const type = answer.headers['content-type']?.split(';')[0]?.trim();
      throw new ConnectorError(
        REST_KEYS.notJson,
        `the answer${type ? ` (${type.slice(0, 100)})` : ''} doesn’t read as JSON`,
      );
    }
  }

  /** The records on a page.  A later page with nothing at the path has no more records. */
  function recordsOf(document: unknown, endpoint: RestEndpoint, first: boolean, project = true): unknown[] {
    const found = valueAt(document, endpoint.records);
    if (Array.isArray(found)) return project && options.record ? found.map(options.record) : found;
    if (!first && (found === undefined || found === null)) return [];
    const lists = listPaths(document);
    throw new ConnectorError(
      REST_KEYS.records,
      lists.length
        ? `lists in the answer: ${lists.map((path) => path || '(the answer itself)').join(', ')}`
        : 'the answer holds no list',
    );
  }

  /** The endpoint a select names. */
  function endpointOf(settings: RestConnection, select: SourceSelect): RestEndpoint {
    if (select.kind !== 'object')
      throw new ConnectorError(REST_KEYS.noQueries, 'API sources read endpoints, not queries');
    const endpoint = settings.endpoints.find((entry) => entry.name === select.object.name);
    if (!endpoint)
      throw new ConnectorError(
        REST_KEYS.objectMissing,
        `the source has no endpoint named ${select.object.name}`,
        {
          object: select.object.name,
        },
      );
    return endpoint;
  }

  /** The address of the page after this one, or null when this one is the last. */
  function nextPage(
    call: Call,
    endpoint: RestEndpoint,
    state: { first: URL; current: URL; number: number; offset: number; seen: Set<string> },
    page: { records: unknown[]; document: unknown; answer: Answer },
  ): URL | null {
    const { paging } = endpoint;
    // An empty page ends every style, so an API that keeps offering more of nothing stops here.
    if (paging.style === 'none' || page.records.length === 0) return null;
    if (options.lastPage && valueAt(page.document, options.lastPage.path) === options.lastPage.value)
      return null;
    const next = new URL(state.first.href);
    let address: string | null = null;
    switch (paging.style) {
      case 'page': {
        if (paging.countPath) {
          const count = valueAt(page.document, paging.countPath);
          if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
            throw new ConnectorError(REST_KEYS.pagingLoop);
          // A zero start selects zero-based numbering, and positive starts use one-based numbering.
          const base = paging.start === 0 ? 0 : 1;
          if (paging.start + state.number - base >= count) return null;
        }
        if (paging.size !== undefined && page.records.length < paging.size) return null;
        const position = String(paging.start + state.number * (paging.step ?? 1));
        next.searchParams.set(paging.param, paging.valueTemplate?.replaceAll('{page}', position) ?? position);
        return next;
      }
      case 'offset':
        if (paging.totalPath) {
          const total = valueAt(page.document, paging.totalPath);
          if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0)
            throw new ConnectorError(REST_KEYS.pagingLoop);
          if (state.offset + page.records.length >= total) return null;
          next.searchParams.set(paging.offsetParam, String(state.offset + page.records.length));
          return next;
        }
        if (paging.lastPath && valueAt(page.document, paging.lastPath) === true) return null;
        if (
          (!paging.lastPath || valueAt(page.document, paging.lastPath) !== false) &&
          page.records.length < paging.limit
        )
          return null;
        next.searchParams.set(paging.offsetParam, String(state.offset + page.records.length));
        return next;
      case 'last-record': {
        if (page.records.length < paging.size) return null;
        const cursor = textAt(page.records.at(-1), paging.cursorPath);
        if (cursor === null) throw new ConnectorError(REST_KEYS.pagingLoop);
        next.searchParams.set(paging.param, cursor);
        break;
      }
      case 'cursor': {
        const cursor = textAt(page.document, paging.cursorPath);
        if (cursor === null) return null;
        next.searchParams.set(paging.param, cursor);
        break;
      }
      case 'next-url':
        address = textAt(page.document, paging.nextPath);
        if (address === null) return null;
        break;
      case 'link-header':
        address = nextLink(page.answer.headers.link);
        if (address === null) return null;
        break;
    }
    let url = next;
    if (address !== null) {
      try {
        url = new URL(address, page.answer.url);
      } catch {
        throw new ConnectorError(REST_KEYS.pagingLoop, 'the next page’s address doesn’t read as one');
      }
      // Credentials go only where the source points, so a next page elsewhere is never asked for.
      if (url.origin !== new URL(call.settings.baseUrl).origin)
        throw new ConnectorError(REST_KEYS.nextElsewhere, `the next page is at ${url.host}`);
    }
    if (state.seen.has(url.href))
      throw new ConnectorError(REST_KEYS.pagingLoop, `page ${state.number + 1} asks for a page read before`);
    return url;
  }

  /**
   * An endpoint's pages, first to last.  A full read keeps to the endpoint's page and record
   * limits and fails past them, since a partial read would look like records leaving, while a
   * sample just stops after `pages`.  Numbered pages that repeat the page before mean the API ignored
   * the paging parameter, which would otherwise read the same records until the limit.
   */
  async function* endpointPages(
    call: Call,
    endpoint: RestEndpoint,
    mode: { full: true } | { full: false; pages: number },
    metadata?: (value: unknown) => unknown,
  ): AsyncGenerator<Page> {
    if (!metadata)
      await options.prepare?.(
        { ...call.ctx, signal: call.signal },
        async function* (definition, document = (value) => value) {
          for await (const page of endpointPages(call, definition, { full: true }, document))
            yield page.records;
        },
      );
    const first = firstUrl(call.settings, endpoint);
    const { paging } = endpoint;
    const state = { first, current: first, number: 0, offset: 0, seen: new Set<string>() };
    const limit = mode.full ? endpoint.maxPages : Math.min(mode.pages, endpoint.maxPages);
    let total = 0;
    let previous: string | null = null;
    for (;;) {
      state.number++;
      state.seen.add(state.current.href);
      const answer = await get(call, state.current, !metadata);
      if (answer.status < 200 || answer.status >= 300) throw refusal(call, answer, endpoint);
      const document =
        answer.status === 204
          ? undefined
          : metadata
            ? metadata(answer.document ? answer.document.value : documentOf(answer))
            : await pageDocument(call, state.current, answer);
      const records =
        answer.status === 204 ? [] : recordsOf(document, endpoint, state.number === 1, !metadata);
      total += records.length;
      if (mode.full && total > endpoint.maxRecords)
        throw new ConnectorError(
          REST_KEYS.recordLimit,
          `${endpoint.name} has more than ${endpoint.maxRecords} records`,
          { records: endpoint.maxRecords },
        );
      if ((paging.style === 'page' || paging.style === 'offset') && records.length) {
        const hash = createHash('sha256').update(JSON.stringify(records)).digest('hex');
        if (hash === previous)
          throw new ConnectorError(
            REST_KEYS.pagingLoop,
            `page ${state.number} holds the same records as page ${state.number - 1}`,
          );
        previous = hash;
      }
      const next = nextPage(call, endpoint, state, { records, document, answer });
      yield { records, last: next === null, answer };
      if (next === null) return;
      if (state.number >= limit) {
        if (mode.full)
          throw new ConnectorError(REST_KEYS.pageLimit, `${endpoint.name} has more than ${limit} pages`, {
            pages: limit,
          });
        return;
      }
      state.offset += records.length;
      state.current = next;
    }
  }

  /** Field groups keep their own cursors and page sizes, sharing the active call's bounds. */
  async function* pages(
    call: Call,
    endpoint: RestEndpoint,
    mode: { full: true } | { full: false; pages: number },
  ): AsyncGenerator<Page> {
    const groups = options.recordGroups;
    if (!groups || groups.endpoints.length < 2) {
      yield* endpointPages(call, groups?.endpoints[0] ?? endpoint, mode);
      return;
    }
    const changed = () => new ConnectorError(groups.changedMessageKey);
    const keyOf = (row: unknown) => {
      const key = valueAt(row, groups.key);
      const text = typeof key === 'string' ? key : textAt(row, groups.key);
      if (!isRecordObject(row) || text === null) throw changed();
      return typeof key === 'number' ? key : text;
    };
    const streams = groups.endpoints.slice(1).map((group) => ({
      pages: endpointPages(call, group, { full: true }),
      pending: new Map<string | number, Record<string, unknown>>(),
      seen: new Set<string | number>(),
      done: false,
    }));
    const primaryKeys = new Set<string | number>();
    try {
      for await (const page of endpointPages(call, groups.endpoints[0]!, mode)) {
        const rows = page.records.map((row) => {
          const key = keyOf(row);
          if (primaryKeys.has(key)) throw changed();
          primaryKeys.add(key);
          return { ...(row as Record<string, unknown>) };
        });
        for (const stream of streams) {
          const advance = async () => {
            const next = await stream.pages.next();
            stream.done = next.done === true || next.value.last;
            if (next.done) return;
            for (const row of next.value.records) {
              const key = keyOf(row);
              if (stream.seen.has(key)) throw changed();
              stream.seen.add(key);
              stream.pending.set(key, row as Record<string, unknown>);
            }
          };
          for (const row of rows) {
            const key = keyOf(row);
            while (!stream.pending.has(key) && !stream.done) await advance();
            const extra = stream.pending.get(key);
            if (!extra) throw changed();
            Object.assign(row, extra);
            stream.pending.delete(key);
          }
          if (page.last) {
            while (!stream.done) await advance();
            if (stream.pending.size) throw changed();
          }
        }
        yield { ...page, records: rows };
      }
    } finally {
      for (const stream of streams) await stream.pages.return(undefined);
    }
  }

  /** The first records, enough to decide each column's type, and whether they were all there were. */
  async function sample(
    call: Call,
    endpoint: RestEndpoint,
    pageLimit = SAMPLE_PAGES,
  ): Promise<{ records: unknown[]; sampler: Sampler; complete: boolean }> {
    const records: unknown[] = [];
    const sampler = new Sampler(endpoint);
    for await (const page of pages(call, endpoint, { full: false, pages: pageLimit })) {
      records.push(...page.records);
      sampler.declare(options.columnNames?.() ?? []);
      for (const record of page.records) sampler.add(record);
      if (page.last) return { records, sampler, complete: true };
      if (sampler.full) break;
    }
    return { records, sampler, complete: false };
  }

  /**
   * Every record of a full read as cells, once the first ones have decided each column's type,
   * the same way `sample` decides them, so a read and its preview agree.
   */
  async function* stream(
    call: Call,
    endpoint: RestEndpoint,
    described: (columns: RestColumn[]) => void,
  ): AsyncGenerator<Array<Map<string, FileCell>>> {
    const sampler = new Sampler(endpoint);
    let held: unknown[] | null = [];
    let count = 0;
    const settle = () => {
      sampler.declare(options.columnNames?.() ?? []);
      described(sampler.describe());
      const cells = held!.map((record) => cellsOf(record, endpoint));
      held = null;
      return cells;
    };
    for await (const page of pages(call, endpoint, { full: true })) {
      if (held === null) {
        yield page.records.map((record) => cellsOf(record, endpoint));
        continue;
      }
      held.push(...page.records);
      sampler.declare(options.columnNames?.() ?? []);
      for (const record of page.records) sampler.add(record);
      if (sampler.full || ++count >= SAMPLE_PAGES) yield settle();
    }
    if (held !== null) yield settle();
  }

  function rowsOf(
    records: unknown[],
    columns: RestColumn[],
    endpoint: RestEndpoint,
    limit: number,
  ): CellValue[][] {
    return records.slice(0, limit).map((record) => {
      const cells = cellsOf(record, endpoint);
      return columns.map((entry) =>
        entry.column.suggested
          ? entry.value(cells.get(entry.column.name), entry.column.suggested.type)
          : null,
      );
    });
  }

  async function preview(
    ctx: ConnectorContext,
    select: SourceSelect,
    limit: number,
    pageLimit: number,
  ): Promise<SourcePreviewRows> {
    let call: Call | undefined;
    try {
      positive(limit, 50);
      // Paced field groups can span many requests while each individual request keeps its idle timeout.
      call = begin(ctx, options.recordGroups ? deadlineMs : positive(ctx.timeoutMs, 30000));
      const endpoint = endpointOf(call.settings, select);
      const { records, sampler, complete } = await sample(call, endpoint, pageLimit);
      const columns = sampler.describe();
      return {
        columns: columns.map((entry) => entry.column),
        rows: rowsOf(records, columns, endpoint, limit),
        rowEstimate: complete ? records.length : null,
      };
    } catch (error) {
      throw failure(error, ctx, call);
    }
  }

  async function test(ctx: ConnectorContext): Promise<SourceTestResult> {
    const steps: SourceTestResult['steps'] = [];
    let current: TestStep = 'resolve';
    let start = Date.now();
    let serverVersion: string | undefined;
    let call: Call | undefined;
    const passed = (step: TestStep) => steps.push({ step, status: 'ok', ms: Date.now() - start });
    const enter = (step: TestStep) => {
      current = step;
      start = Date.now();
    };
    const done = (): SourceTestResult => ({ ok: true, steps, ...(serverVersion ? { serverVersion } : {}) });
    try {
      const budget = new Budget(ctx);
      /** One step's work, stopped when the budget runs out or the caller gives up. */
      const within = async <T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> => {
        const controller = new AbortController();
        try {
          return await budget.run(
            () => action(AbortSignal.any([controller.signal, ...(ctx.signal ? [ctx.signal] : [])])),
            () => controller.abort(),
          );
        } finally {
          controller.abort();
        }
      };
      const settings = settingsOf(ctx);
      const endpoint = settings.endpoints[0]!;
      const address = new URL(settings.baseUrl);
      const port = Number(address.port || (address.protocol === 'https:' ? 443 : 80));
      if (!network.allowsAddress(address))
        throw new FileNetworkError('https', `${address.protocol} addresses aren’t allowed`);
      const checked = await within((signal) => network.check(address, signal));
      passed('resolve');
      enter('connect');
      await within((signal) => sockets.connect(checked, port, signal));
      passed('connect');
      enter('tls');
      if (address.protocol === 'https:') {
        await within((signal) => sockets.handshake(checked, port, address.hostname, signal));
        passed('tls');
      } else steps.push({ step: 'tls', status: 'skipped', ms: null });

      // Signing in is the token request for OAuth, then the first page, whose status says whether
      // the API took the sign-in.  A test always asks for a new token, to prove the secret works.
      enter('authenticate');
      const tested = begin(ctx, budget.ms);
      call = tested;
      if (settings.auth.method === 'oauth-client') await within(() => token(tested, true));
      const first = firstUrl(settings, endpoint);
      const answer = await within(() => get(tested, first));
      serverVersion = answer.headers.server?.slice(0, 100);
      if (answer.status === 401 || answer.status === 403) throw refusal(tested, answer, endpoint);
      passed('authenticate');

      enter('read');
      if (answer.status < 200 || answer.status >= 300) throw refusal(tested, answer, endpoint);
      const document = await pageDocument(tested, first, answer);
      passed('read');

      enter('records');
      const records = recordsOf(document, endpoint, true);
      passed('records');

      enter('paging');
      const state = { first, current: first, number: 1, offset: 0, seen: new Set([first.href]) };
      const next = nextPage(tested, endpoint, state, { records, document, answer });
      // Without paging, or with every record on the first page, there's no second page to ask for.
      if (next === null) {
        steps.push({ step: 'paging', status: 'skipped', ms: null });
        return done();
      }
      const second = await within(() => get(tested, next));
      if (second.status < 200 || second.status >= 300) throw refusal(tested, second, endpoint);
      const more = recordsOf(await pageDocument(tested, next, second), endpoint, false);
      if (
        (endpoint.paging.style === 'page' || endpoint.paging.style === 'offset') &&
        more.length > 0 &&
        JSON.stringify(more) === JSON.stringify(records)
      )
        throw new ConnectorError(REST_KEYS.pagingLoop, 'page 2 holds the same records as page 1');
      passed('paging');
      return done();
    } catch (error) {
      const detail = scrubbed(error instanceof ConnectorError ? (error.detail ?? '') : error, ctx, call);
      steps.push({
        step: current,
        status: 'failed',
        ms: Date.now() - start,
        messageKey: testKey(error, current),
        ...(error instanceof ConnectorError && error.params
          ? {
              params: Object.fromEntries(
                Object.entries(error.params).filter((entry): entry is [string, string | number | boolean] =>
                  ['string', 'number', 'boolean'].includes(typeof entry[1]),
                ),
              ),
            }
          : {}),
        ...(detail ? { detail } : {}),
      });
      return { ok: false, steps };
    }
  }

  /** The advice a failed step carries.  Keys that need a value filled in give way to the step's own. */
  function testKey(error: unknown, step: TestStep): string {
    if (error instanceof ConnectorError) {
      if (error.messageKey === REST_KEYS.timeout) return REST_KEYS.timeout;
      return options.responseError || ADVICE.has(error.messageKey)
        ? error.messageKey
        : `sources.test.${step}`;
    }
    if (error instanceof FileNetworkError) {
      if (error.problem === 'https') return REST_KEYS.https;
      if (error.problem === 'blocked') return REST_KEYS.blocked;
      if (error.problem === 'resolve') return 'sources.test.resolve';
    }
    const text =
      error instanceof Error ? `${error.message} ${String((error as { code?: unknown }).code ?? '')}` : '';
    if (/timeout|timed out|ETIMEDOUT/i.test(text)) return REST_KEYS.timeout;
    if (step === 'tls') return REST_KEYS.tls;
    return `sources.test.${step}`;
  }

  return {
    async *records(ctx, select) {
      let call: Call | undefined;
      try {
        call = begin(ctx, deadlineMs);
        const endpoint = endpointOf(call.settings, select);
        for await (const page of pages(call, endpoint, { full: true })) yield page.records;
      } catch (error) {
        throw failure(error, ctx, call);
      }
    },
    async request(ctx, url) {
      let call: Call | undefined;
      try {
        // App setup shares the operation deadline.  A 30-second idle attempt and a 1-second
        // backoff already need more than 30 seconds, even before pacing or a successful response.
        call = begin(ctx, ctx.deadlineAt === undefined ? positive(ctx.timeoutMs, 30000) : deadlineMs);
        return await request(call, url);
      } catch (error) {
        throw failure(error, ctx, call);
      }
    },
    kind: 'rest',
    test,
    async listObjects(ctx): Promise<SourceObject[]> {
      try {
        return settingsOf(ctx).endpoints.map((endpoint) => ({
          schema: null,
          name: endpoint.name,
          type: 'endpoint',
          rowEstimate: null,
        }));
      } catch (error) {
        throw failure(error, ctx);
      }
    },
    async describe(ctx, select) {
      return (await preview(ctx, select, 1, SAMPLE_PAGES)).columns;
    },
    preview: (ctx, select, limit) => preview(ctx, select, limit, SAMPLE_PAGES),
    firstPage: (ctx, select, limit) => preview(ctx, select, limit, 1),
    async keyCandidates(ctx, object) {
      // A full read proves which columns are keys, and one that runs out of time offers none.
      const scan = new AbortController();
      const timer = setTimeout(() => scan.abort(), keyScanMs);
      let call: Call | undefined;
      try {
        call = begin(ctx, deadlineMs, scan.signal);
        const endpoint = endpointOf(call.settings, { kind: 'object', object });
        if (options.keyColumns) return [[...options.keyColumns]];
        let keys: KeyScan | undefined;
        for await (const batch of stream(call, endpoint, (columns) => {
          keys = new KeyScan(columns);
        }))
          for (const cells of batch) keys!.add(cells);
        return keys?.candidates() ?? [];
      } catch (error) {
        if (scan.signal.aborted && !ctx.signal?.aborted) return [];
        throw failure(error, ctx, call);
      } finally {
        clearTimeout(timer);
      }
    },
    async *read(ctx, select, readOptions) {
      let call: Call | undefined;
      try {
        const size = positive(readOptions.batchSize, 5000);
        call = begin(ctx, deadlineMs);
        const endpoint = endpointOf(call.settings, select);
        let byName = new Map<string, RestColumn>();
        // A column no record has yet is still asked for, since JSON leaves out what's empty.
        const columnOf = (name: string): RestColumn => {
          let column = byName.get(name);
          if (!column) {
            column = plainColumn(name);
            byName.set(name, column);
          }
          return column;
        };
        const toRow = (cells: Map<string, FileCell>): SourceRow => ({
          key: sourceKey(readOptions.keyColumns.map((name) => columnOf(name).key(cells.get(name)))),
          values: Object.fromEntries(
            readOptions.columns.map((name) => {
              const column = columnOf(name);
              return [
                name,
                column.value(
                  cells.get(name),
                  readOptions.types[name] ?? column.column.suggested?.type ?? 'text',
                ),
              ];
            }),
          ),
        });
        const batcher = new RowBatcher<SourceRow>(size);
        const running = call;
        for await (const batch of stream(running, endpoint, (columns) => {
          byName = new Map(columns.map((entry) => [entry.column.name, entry]));
        })) {
          for (const rows of batcher.add(batch.map(toRow))) {
            running.signal.throwIfAborted();
            yield rows;
          }
        }
        const rest = batcher.flush();
        running.signal.throwIfAborted();
        if (rest) yield rest;
      } catch (error) {
        throw failure(error, ctx, call);
      }
    },
  };
}
