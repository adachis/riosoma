import { RioClientError } from './errors.js';
import { Credentials, Transport, type TransportOptions } from './http.js';
import { platformFetch, type OAuthTokens } from './oauth.js';
import { RecordsApi } from './records.js';
import {
  NamedFunctionsApi,
  DatabasesApi,
  FieldsApi,
  TablesApi,
  ViewsApi,
  WebhooksApi,
  openapiDocument,
} from './schema.js';
import type { Clock, FetchLike, Query, Sleep } from './types.js';

/**
 * A client for one Riosoma server.
 *
 * ```ts
 * const client = new RioClient({ baseUrl: 'https://riosoma.example.com', token: 'rio_pat_…' });
 * for await (const record of client.records.iterate('tbl…', { pageSize: 100 })) use(record);
 * ```
 *
 * One client is safe to share: it holds no state a call changes, apart from an OAuth access token
 * it refreshes in place.  It works wherever `fetch` and Web Crypto do, which is Node.js 20 or newer
 * and any browser, and it brings no dependency of its own along.
 */
export interface ClientOptions {
  /**
   * The server's address, such as `https://riosoma.example.com`.  A path is kept as a prefix, for
   * an install reached through a proxy, and a query or a fragment is refused.
   */
  baseUrl: string;
  /** A personal access token, `rio_pat_…`, made in the app's settings */
  token?: string | null;
  /** An OAuth access token, which expires, and the refresh token that replaces it */
  accessToken?: string | null;
  refreshToken?: string | null;
  /** The OAuth app the tokens came from, which a refresh has to name */
  clientId?: string | null;
  /** When the access token stops working, in milliseconds since the epoch */
  expiresAt?: number | null;
  /** How long the access token lasts, in seconds, as a token endpoint says it */
  expiresIn?: number | null;
  /** Told whenever a refresh brings new tokens, so a caller can store them */
  onTokens?: (tokens: OAuthTokens) => void | Promise<void>;
  /** The `fetch` calls are sent with, which a test or a proxying host replaces */
  fetch?: FetchLike;
  /** Headers sent with every call, such as one a proxy needs */
  headers?: Record<string, string>;
  /** Tries for one call after a 429, not counting the first */
  retries?: number;
  /** The longest wait a 429 may ask for before the caller gets the failure instead */
  maxRetryDelayMs?: number;
  /** How a rate limit is waited out, which a test replaces */
  sleep?: Sleep;
  /** How the time is read, which a test replaces */
  now?: Clock;
  /** Canceled with every call, for a caller that stops a whole run of them */
  signal?: AbortSignal;
}

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
  /** Send no credential, for the few routes anyone may read */
  anonymous?: boolean;
}

export class RioClient {
  /** Records: reads that page, and writes that go through the server's command bus */
  readonly records: RecordsApi;
  /** The databases the credential reaches, and the caller's home listing */
  readonly databases: DatabasesApi;
  /** Read and change tables, each with its fields and views */
  readonly tables: TablesApi;
  /** Read fields by ID or name, and create, update, or trash them by ID */
  readonly fields: FieldsApi;
  /** Read views by ID or name, and create, update, reorder, or trash them by ID */
  readonly views: ViewsApi;
  /** The webhooks that follow a database's changes */
  readonly webhooks: WebhooksApi;
  readonly namedFunctions: NamedFunctionsApi;

  private readonly transport: Transport;

  constructor(options: ClientOptions) {
    if (!options || typeof options !== 'object')
      throw new RioClientError('A client needs its options, at least the server address.', {
        code: 'invalid_options',
      });
    const baseUrl = checkedBaseUrl(options.baseUrl);
    const transportOptions: TransportOptions = {
      baseUrl,
      credentials: new Credentials(options),
      fetchImpl: options.fetch ?? platformFetch(),
      ...(options.headers ? { headers: options.headers } : {}),
      ...(options.retries === undefined ? {} : { retries: options.retries }),
      ...(options.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: options.maxRetryDelayMs }),
      ...(options.sleep ? { sleep: options.sleep } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onTokens ? { onTokens: options.onTokens } : {}),
    };
    this.transport = new Transport(transportOptions);
    this.records = new RecordsApi(this.transport);
    this.databases = new DatabasesApi(this.transport);
    this.tables = new TablesApi(this.transport);
    this.fields = new FieldsApi(this.tables, this.transport);
    this.views = new ViewsApi(this.transport);
    this.webhooks = new WebhooksApi(this.transport);
    this.namedFunctions = new NamedFunctionsApi(this.transport);
  }

  /** The address calls go to, which is the one this client was built with, without a trailing slash. */
  get baseUrl(): string {
    return this.transport.baseUrl;
  }

  /**
   * The credential in use, with no secret in it beyond what a caller already has: which kind it
   * is, and when an OAuth access token stops working.
   */
  get credential(): { kind: 'token' | 'oauth' | 'none'; expiresAt: number | null } {
    const credentials = this.transport.credentials;
    return {
      kind: credentials.token ? 'token' : credentials.accessToken ? 'oauth' : 'none',
      expiresAt: credentials.expiresAt,
    };
  }

  /** The API's own document, which needs no credential and says what this server serves. */
  async openapi(options: { signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
    return openapiDocument(this.transport, options);
  }

  /**
   * Any route of the API, for the calls this client doesn't name: a record lock, a knowledge
   * search, or a route a newer server added before this SDK knew about it.
   */
  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const answer = await this.transport.send<T>(method, path, options);
    return answer.data;
  }
}

/** The address a client was built with, checked once so a mistake says so before the first call. */
function checkedBaseUrl(baseUrl: string): string {
  if (typeof baseUrl !== 'string' || !baseUrl.trim())
    throw new RioClientError('A client needs the address of the server it talks to.', {
      code: 'invalid_options',
    });
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    throw new RioClientError(`"${baseUrl}" is not an address a request can be sent to.`, {
      code: 'invalid_options',
    });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new RioClientError('A Riosoma server is reached over http or https.', { code: 'invalid_options' });
  if (url.search || url.hash)
    throw new RioClientError('A server address carries no query and no fragment.', {
      code: 'invalid_options',
    });
  if (url.username || url.password)
    throw new RioClientError('A credential belongs in the client options, not in the address.', {
      code: 'invalid_options',
    });
  return url.pathname === '/' ? url.origin : `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}
