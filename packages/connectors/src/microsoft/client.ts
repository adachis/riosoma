import type { SourceTestResult, TestStep } from '@riosoma/contracts';
import { Budget } from '../common.js';
import { nodeSockets, type Sockets } from '../files/connector.js';
import { FileNetworkError, NO_NETWORK, type FileNetwork } from '../files/network.js';
import { readBody } from '../rest/connector.js';
import { cachedToken, forgetToken, keepToken, pace, retryAfterMs, sleep, tokenKey } from '../rest/http.js';
import { positive } from '../sql.js';
import { ConnectorError, type ConnectorContext } from '../types.js';
import { scrubDetail } from '../warehouses/errors.js';

/**
 * How every Microsoft 365 source reaches Microsoft: as an Entra app, with the client credentials
 * grant, through the server's guarded network.  The app's token for each service is kept in memory
 * until it's close to expiring.  Requests keep an even pace for each app and service, a 429 or a
 * busy service is waited out as long as Retry-After asks, within bounds, and a next page is
 * followed only on the origin the first page came from, so a token never leaves Microsoft's own
 * addresses.  No secret or token ever reaches a message.
 */

export const MICROSOFT_KEYS = {
  tenant: 'sources.microsoft.tenant',
  client: 'sources.microsoft.client',
  secret: 'sources.microsoft.secret',
  tokenFailed: 'sources.microsoft.tokenFailed',
  unreachable: 'sources.microsoft.unreachable',
  rateLimited: 'sources.microsoft.rateLimited',
  status: 'sources.microsoft.status',
  tooLarge: 'sources.microsoft.tooLarge',
  unreadable: 'sources.microsoft.unreadable',
  noQueries: 'sources.microsoft.noQueries',
  read: 'sources.sync.read',
  objectMissing: 'sources.sync.objectMissing',
  columnMissing: 'sources.sync.columnMissing',
  secretsMissing: 'sources.secretsMissing',
  timeout: 'sources.test.timeout',
} as const;

/** Keys that say less than a failed test step's own advice, so a step shows its own instead. */
const GENERIC = new Set<string>([
  MICROSOFT_KEYS.read,
  MICROSOFT_KEYS.objectMissing,
  MICROSOFT_KEYS.columnMissing,
  MICROSOFT_KEYS.tooLarge,
  MICROSOFT_KEYS.status,
]);

export const ENTRA_LOGIN_URL = 'https://login.microsoftonline.com';
export const GRAPH_API_URL = 'https://graph.microsoft.com';

export interface MicrosoftOptions {
  /** The guarded network the server supplies.  Without one, nothing is reached. */
  network?: FileNetwork;
  sockets?: Sockets;
  /** Where Entra's token addresses answer.  Tests point it at a stand-in. */
  loginUrl?: string;
  /** Requests a second for each app and service: ten unless set, well inside Microsoft's limits */
  requestsPerSecond?: number;
  /** The most one answer may hold: 50 MB unless set */
  maxPageBytes?: number;
  /** How long a sync's whole read may take: 20 minutes unless set */
  deadlineMs?: number;
  /** The longest a Retry-After is waited out before the call gives up: 60 seconds unless set */
  maxRetryWaitMs?: number;
  /** How often one request is tried again after a 429 or a busy service: 5 times unless set */
  retries?: number;
  /** The clock tokens expire by */
  now?: () => number;
}

interface Settings {
  tenantId: string;
  clientId: string;
}

/** One answer, read whole. */
export interface Answer {
  status: number;
  headers: Record<string, string | undefined>;
  body: Buffer;
  /** Where it came from, after any redirects */
  url: URL;
}

const DEFAULT_PAGE_BYTES = 50 * 1024 * 1024;
const DEFAULT_DEADLINE_MS = 20 * 60_000;
const DEFAULT_RETRY_WAIT_MS = 60_000;
const DEFAULT_RETRIES = 5;
const ERROR_BYTES = 16 * 1024;
const TOKEN_BYTES = 64 * 1024;
/** Answers worth waiting out, as Microsoft's guidance on throttling says. */
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
/** Entra's error codes for a tenant that doesn't exist or isn't written as one. */
const TENANT_CODES = new Set([90002, 900023, 90013]);
/** Entra's error codes for an app the tenant doesn't have, or has turned off. */
const CLIENT_CODES = new Set([700016, 7000112, 700038]);
/** Entra's error codes for a secret that's wrong, missing, or expired. */
const SECRET_CODES = new Set([7000215, 7000216, 7000222]);
/** Entra's error code for a resource the tenant doesn't know, like an environment it doesn't hold. */
export const RESOURCE_MISSING = 500011;

/** What a Microsoft service said about a failure: its code and its message, in a few words. */
export function microsoftProblem(body: Buffer): { code: string; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    return { code: '', message: '' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { code: '', message: '' };
  const error = (parsed as { error?: unknown }).error;
  const record =
    typeof error === 'object' && error !== null
      ? (error as Record<string, unknown>)
      : (parsed as Record<string, unknown>);
  const code = typeof record.code === 'string' ? record.code : typeof error === 'string' ? error : '';
  const said = [record.message, (parsed as Record<string, unknown>).error_description].find(
    (value) => typeof value === 'string' && value.trim(),
  );
  const text = typeof said === 'string' ? said.replace(/\s+/g, ' ').trim() : '';
  return { code: code.slice(0, 100), message: text.length > 300 ? `${text.slice(0, 300)}…` : text };
}

/** The Entra error codes a token answer carries, from `error_codes` or its `AADSTS` text. */
export function entraCodes(body: Buffer): number[] {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as {
      error_codes?: unknown;
      error_description?: unknown;
    };
    const listed = Array.isArray(parsed.error_codes)
      ? parsed.error_codes.filter((code): code is number => typeof code === 'number')
      : [];
    const said =
      typeof parsed.error_description === 'string'
        ? [...parsed.error_description.matchAll(/AADSTS(\d+)/g)].map((match) => Number(match[1]))
        : [];
    return [...new Set([...listed, ...said])];
  } catch {
    return [];
  }
}

/** Everything a Microsoft connector keeps for its whole life: its network and its manners. */
export interface MicrosoftConfig {
  network: FileNetwork;
  sockets: Sockets;
  loginUrl: string;
  perSecond: number;
  maxPageBytes: number;
  deadlineMs: number;
  maxRetryWaitMs: number;
  retries: number;
  now: () => number;
}

export function microsoftConfig(options: MicrosoftOptions): MicrosoftConfig {
  return {
    network: options.network ?? NO_NETWORK,
    sockets: options.sockets ?? nodeSockets,
    loginUrl: (options.loginUrl ?? ENTRA_LOGIN_URL).replace(/\/+$/, ''),
    perSecond: options.requestsPerSecond ?? 10,
    maxPageBytes: options.maxPageBytes ?? DEFAULT_PAGE_BYTES,
    deadlineMs: options.deadlineMs ?? DEFAULT_DEADLINE_MS,
    maxRetryWaitMs: options.maxRetryWaitMs ?? DEFAULT_RETRY_WAIT_MS,
    retries: options.retries ?? DEFAULT_RETRIES,
    now: options.now ?? Date.now,
  };
}

/**
 * One call to one Microsoft service as one app: the settings it signs in with, the service's
 * origin (which names the token's audience too), when it must stop, and the values no message of
 * its may hold.
 */
export class MicrosoftCall {
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly idleMs: number;
  readonly hidden = new Set<string>();
  private readonly secret: string;

  constructor(
    private readonly config: MicrosoftConfig,
    readonly ctx: ConnectorContext,
    readonly settings: Settings,
    /** The service's origin, like `https://graph.microsoft.com`, whose `/.default` scope is asked for */
    readonly resource: string,
    ms: number,
    /** How a token answer that names a missing resource reads, for services addressed per tenant */
    private readonly resourceMissing?: () => ConnectorError,
    extra?: AbortSignal,
  ) {
    const secret = ctx.secrets.clientSecret;
    if (!secret) throw new ConnectorError(MICROSOFT_KEYS.secretsMissing, 'the client secret isn’t stored');
    this.secret = secret;
    this.hidden.add(secret);
    this.signal = AbortSignal.any([
      ...(ctx.signal ? [ctx.signal] : []),
      ...(extra ? [extra] : []),
      AbortSignal.timeout(ms),
    ]);
    this.deadline = Date.now() + ms;
    this.idleMs = positive(ctx.timeoutMs, 30000);
  }

  private get tokenUrl(): URL {
    return new URL(`${this.config.loginUrl}/${encodeURIComponent(this.settings.tenantId)}/oauth2/v2.0/token`);
  }

  /** An access token for the service, from memory while it lasts, or fresh from Entra. */
  async token(fresh = false): Promise<string> {
    const { now, network } = this.config;
    const scope = `${this.resource}/.default`;
    const url = this.tokenUrl;
    const cacheKey = tokenKey(['microsoft', url.href, this.settings.clientId, scope, this.secret]);
    if (fresh) forgetToken(cacheKey);
    const cached = cachedToken(cacheKey, now());
    if (cached) {
      this.hidden.add(cached);
      return cached;
    }
    if (!network.allowsAddress(url))
      throw new FileNetworkError('https', `${url.protocol} token addresses aren’t allowed`);
    const form = new URLSearchParams({
      client_id: this.settings.clientId,
      client_secret: this.secret,
      scope,
      grant_type: 'client_credentials',
    });
    const response = await network.request({
      url,
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'Riosoma-Sources',
      },
      body: form.toString(),
      maxBytes: TOKEN_BYTES,
      signal: this.signal,
      idleMs: this.idleMs,
    });
    const body = await readBody(response, TOKEN_BYTES, false);
    let answer: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(body.toString('utf8'));
      if (typeof parsed === 'object' && parsed !== null) answer = parsed as Record<string, unknown>;
    } catch {
      // A token address that doesn't answer in JSON is covered below.
    }
    if (response.status < 200 || response.status >= 300) {
      const codes = entraCodes(body);
      const code = typeof answer.error === 'string' ? answer.error.slice(0, 100) : '';
      const said =
        typeof answer.error_description === 'string'
          ? answer.error_description.split(/\r?\n/)[0]!.slice(0, 300)
          : '';
      const detail = `Entra answered HTTP ${response.status}${code ? ` ${code}` : ''}${said ? `: ${said}` : ''}`;
      if (codes.some((entry) => TENANT_CODES.has(entry)) || response.status === 404)
        throw new ConnectorError(MICROSOFT_KEYS.tenant, detail);
      if (codes.some((entry) => CLIENT_CODES.has(entry)))
        throw new ConnectorError(MICROSOFT_KEYS.client, detail);
      if (codes.some((entry) => SECRET_CODES.has(entry)) || code === 'invalid_client')
        throw new ConnectorError(MICROSOFT_KEYS.secret, detail);
      if (codes.includes(RESOURCE_MISSING) && this.resourceMissing) {
        const missing = this.resourceMissing();
        throw new ConnectorError(missing.messageKey, detail, missing.params);
      }
      throw new ConnectorError(MICROSOFT_KEYS.tokenFailed, detail);
    }
    const value = answer.access_token;
    if (typeof value !== 'string' || !value)
      throw new ConnectorError(MICROSOFT_KEYS.tokenFailed, 'Entra answered without an access_token');
    this.hidden.add(value);
    const seconds = Number(answer.expires_in);
    const lasts = Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 3_600_000;
    keepToken(cacheKey, value, now() + lasts, now());
    return value;
  }

  /**
   * One GET, at the app's pace for this service.  A busy answer is tried again after the wait its
   * Retry-After asks for, or a growing one when it asks for none, within bounds and the deadline.
   * A token the service refuses is renewed once.  Any other answer comes back as it is.  `raw`
   * reads the whole answer as bytes, for a file's content, up to `maxBytes`.
   */
  async get(url: URL, headers: Record<string, string> = {}, raw?: { maxBytes: number }): Promise<Answer> {
    const { network, perSecond, maxPageBytes, retries, maxRetryWaitMs, now } = this.config;
    const limit = raw?.maxBytes ?? maxPageBytes;
    let renewed = false;
    for (let attempt = 0; ; attempt++) {
      const authorization = `Bearer ${await this.token(renewed)}`;
      if (!network.allowsAddress(url))
        throw new FileNetworkError('https', `${url.protocol} addresses aren’t allowed`);
      await pace(
        `microsoft:${this.settings.tenantId}:${this.settings.clientId}:${this.resource}`,
        perSecond,
        this.signal,
      );
      const response = await network.request({
        url,
        method: 'GET',
        headers: {
          accept: raw ? '*/*' : 'application/json',
          'user-agent': 'Riosoma-Sources',
          ...headers,
          authorization,
        },
        maxBytes: limit,
        signal: this.signal,
        idleMs: this.idleMs,
      });
      const ok = response.status >= 200 && response.status < 300;
      const answer: Answer = {
        status: response.status,
        headers: response.headers,
        body: ok ? await readBody(response, limit, true) : await readBody(response, ERROR_BYTES, false),
        url: response.url,
      };
      if (RETRY_STATUSES.has(answer.status)) {
        const asked = retryAfterMs(answer.headers['retry-after'], now());
        const ms = asked ?? 1_000 * 2 ** attempt;
        if (attempt < retries && ms <= maxRetryWaitMs && Date.now() + ms < this.deadline) {
          await sleep(ms, this.signal);
          continue;
        }
        const busy = answer.status !== 429;
        throw new ConnectorError(
          busy ? MICROSOFT_KEYS.status : MICROSOFT_KEYS.rateLimited,
          `HTTP ${answer.status}${asked === null ? '' : `, asked to wait ${Math.ceil(asked / 1_000)} seconds`} after ${attempt + 1} tries`,
          busy ? { status: answer.status } : undefined,
        );
      }
      if (answer.status === 401 && !renewed) {
        renewed = true;
        continue;
      }
      return answer;
    }
  }

  /** An answer's JSON, or a plain error when it isn't JSON. */
  json(answer: Answer): unknown {
    try {
      return JSON.parse(answer.body.toString('utf8').replace(/^\uFEFF/, ''));
    } catch {
      throw new ConnectorError(MICROSOFT_KEYS.unreadable, 'Microsoft’s answer doesn’t read as JSON');
    }
  }

  /**
   * Every page of a collection, starting at `url`: each page's `value`, following `@odata.nextLink`
   * only on the same origin.  `refusal` says what an answer outside 2xx stands for.
   */
  async *pages(
    url: URL,
    refusal: (answer: Answer) => ConnectorError,
    headers: Record<string, string> = {},
  ): AsyncGenerator<Array<Record<string, unknown>>> {
    let next: URL | null = url;
    for (let page = 0; next; page++) {
      const answer = await this.get(next, headers);
      if (answer.status < 200 || answer.status >= 300) throw refusal(answer);
      const document = this.json(answer) as { value?: unknown; '@odata.nextLink'?: unknown };
      if (!Array.isArray(document.value))
        throw new ConnectorError(
          MICROSOFT_KEYS.unreadable,
          'Microsoft’s answer holds no list where it should',
        );
      yield document.value.filter(
        (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
      );
      const link = document['@odata.nextLink'];
      if (typeof link !== 'string' || !link) return;
      if (!URL.canParse(link) || new URL(link).origin !== url.origin)
        throw new ConnectorError(MICROSOFT_KEYS.unreadable, 'a next page named another address');
      next = new URL(link);
    }
  }

  /** Words about a failure with every secret and token taken out. */
  scrubbed(detail: unknown): string | undefined {
    let text = scrubDetail(detail, this.ctx);
    if (text === undefined) return undefined;
    for (const value of [...this.hidden].sort((a, b) => b.length - a.length))
      if (value.length >= 4) text = text.split(value).join('[redacted]');
    return text;
  }
}

/** The error a call leaves with: a key people can act on, and scrubbed words behind it. */
export function microsoftFailure(
  error: unknown,
  ctx: ConnectorContext,
  config: MicrosoftConfig,
  call?: MicrosoftCall,
): ConnectorError {
  const scrub = (detail: unknown) => (call ? call.scrubbed(detail) : scrubDetail(detail, ctx));
  if (error instanceof ConnectorError) {
    const timedOut = error.messageKey === MICROSOFT_KEYS.timeout;
    const detail =
      error.detail !== undefined
        ? scrub(error.detail)
        : timedOut
          ? `Microsoft took longer than ${positive(ctx.timeoutMs, 30000)} ms to answer`
          : ctx.signal?.aborted
            ? 'the call was stopped before it finished'
            : undefined;
    return new ConnectorError(timedOut ? MICROSOFT_KEYS.read : error.messageKey, detail, error.params);
  }
  if (error instanceof FileNetworkError) {
    const detail = scrub(error.detail ?? error.problem);
    if (error.problem === 'tooLarge')
      return new ConnectorError(MICROSOFT_KEYS.tooLarge, detail, {
        megabytes: Math.floor(config.maxPageBytes / 1024 / 1024),
      });
    if (error.problem === 'https' || error.problem === 'blocked' || error.problem === 'resolve')
      return new ConnectorError(MICROSOFT_KEYS.unreachable, detail);
    return new ConnectorError(MICROSOFT_KEYS.read, detail);
  }
  if (
    ctx.signal?.aborted ||
    call?.signal.aborted ||
    (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
  )
    return new ConnectorError(
      MICROSOFT_KEYS.read,
      'the call was stopped or ran out of time before it finished',
    );
  return new ConnectorError(MICROSOFT_KEYS.read, scrub(error));
}

/** One step of a connection test past signing in, run within the test's time. */
export interface TestStage {
  step: TestStep;
  run(within: <T>(action: () => Promise<T>) => Promise<T>): Promise<void>;
}

/**
 * A connection test's climb: name resolution, the connection, and TLS to the service's address,
 * then signing in with a fresh token, then each stage in order.  It stops at the first failure and
 * never throws for one.  A failed step carries the connector's own advice when its error has some,
 * and the step's otherwise.
 */
export async function climb(
  ctx: ConnectorContext,
  config: MicrosoftConfig,
  address: URL,
  begin: (ms: number) => MicrosoftCall,
  stages: readonly TestStage[],
): Promise<SourceTestResult> {
  const steps: SourceTestResult['steps'] = [];
  let current: TestStep = 'resolve';
  let start = Date.now();
  let call: MicrosoftCall | undefined;
  const passed = (step: TestStep) => steps.push({ step, status: 'ok', ms: Date.now() - start });
  const enter = (step: TestStep) => {
    current = step;
    start = Date.now();
  };
  try {
    const budget = new Budget(ctx);
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
    const port = Number(address.port || (address.protocol === 'https:' ? 443 : 80));
    if (!config.network.allowsAddress(address))
      throw new FileNetworkError('https', `${address.protocol} addresses aren’t allowed`);
    const checked = await within((signal) => config.network.check(address, signal));
    passed('resolve');
    enter('connect');
    await within((signal) => config.sockets.connect(checked, port, signal));
    passed('connect');
    enter('tls');
    if (address.protocol === 'https:') {
      await within((signal) => config.sockets.handshake(checked, port, address.hostname, signal));
      passed('tls');
    } else steps.push({ step: 'tls', status: 'skipped', ms: null });

    // Signing in is the token request, always a new one, to prove the secret works.
    enter('authenticate');
    const tested = begin(budget.ms);
    call = tested;
    await within(() => tested.token(true));
    passed('authenticate');
    for (const stage of stages) {
      enter(stage.step);
      await stage.run((action) => within(() => action()));
      passed(stage.step);
    }
    return { ok: true, steps };
  } catch (error) {
    const detail = call
      ? call.scrubbed(error instanceof ConnectorError ? (error.detail ?? '') : error)
      : scrubDetail(error instanceof ConnectorError ? (error.detail ?? '') : error, ctx);
    steps.push({
      step: current,
      status: 'failed',
      ms: Date.now() - start,
      messageKey: testKey(error, current),
      ...(detail ? { detail } : {}),
    });
    return { ok: false, steps };
  }
}

/** The advice a failed step carries.  Keys that say less, or need a value filled in, give way. */
function testKey(error: unknown, step: TestStep): string {
  if (error instanceof ConnectorError) {
    if (error.messageKey === MICROSOFT_KEYS.timeout) return MICROSOFT_KEYS.timeout;
    return GENERIC.has(error.messageKey) || error.params ? `sources.test.${step}` : error.messageKey;
  }
  if (error instanceof FileNetworkError) {
    if (error.problem === 'resolve') return 'sources.test.resolve';
    if (error.problem === 'https' || error.problem === 'blocked') return MICROSOFT_KEYS.unreachable;
  }
  const text =
    error instanceof Error ? `${error.message} ${String((error as { code?: unknown }).code ?? '')}` : '';
  if (/timeout|timed out|ETIMEDOUT/i.test(text)) return MICROSOFT_KEYS.timeout;
  return `sources.test.${step}`;
}

/**
 * A date a Microsoft service keeps as the instant of midnight where the site or the person is, like
 * a SharePoint date-only column, as the day it names: the nearest midnight in UTC, which is right
 * for every zone within 12 hours of UTC.
 */
export function nearestDay(instant: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(instant)) return instant;
  const time = Date.parse(instant);
  if (Number.isNaN(time)) return null;
  return new Date(time + 12 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * Column names from the names a service shows, with the reserved names taken first, so a column
 * that repeats one is the one that gets numbered, the way a sheet's repeated headers are.
 */
export function distinctNames(names: readonly string[], reserved: readonly string[]): string[] {
  const used = new Set(reserved.map((name) => name.toLowerCase()));
  return names.map((raw) => {
    const base = raw.replace(/\s+/g, ' ').trim().slice(0, 255) || 'Column';
    let name = base;
    for (let suffix = 1; used.has(name.toLowerCase()); suffix++) name = `${base}_${suffix}`;
    used.add(name.toLowerCase());
    return name;
  });
}
