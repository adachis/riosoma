import { AIRTABLE_IMPORT_LIMITS, AppError, type AirtableBase } from '@riosoma/contracts';
import { z } from 'zod';
import type { Clock, Limiter } from '../core/clock.js';

export { RateLimiter, systemClock, type Clock, type Limiter } from '../core/clock.js';

/**
 * Airtable's Web API, as far as an import needs it: the bases a token can see, a base's schema,
 * and its records, page by page.  At most five requests start in any second for one base, which
 * is Airtable's limit.  A 429 answer pauses that base's requests for as long as Airtable asks (30
 * seconds unless it says otherwise) before trying again, and network trouble and 5xx answers are
 * tried again after a growing wait.  The token goes only in the `Authorization` header, and
 * anything Airtable sends back has the token taken out before anything else reads it.
 */

export const AIRTABLE_API_URL = 'https://api.airtable.com';
export const REQUESTS_PER_SECOND = 5;
/** How long Airtable asks callers to wait after answering 429 */
export const RATE_LIMIT_WAIT_MS = 30_000;
/** Tries for one request before the import gives up on it */
export const TRIES = 6;
const FIRST_BACKOFF_MS = 1_000;
const REQUEST_TIMEOUT_MS = 60_000;
const PAGE_SIZE = 100;
const WORKSPACE_REQUEST_LIMIT = 20;
const WORKSPACE_TIME_LIMIT_MS = 5_000;
const REDACTED = '[redacted]';

const Options = z.record(z.string(), z.unknown());

export const AirtableField = z.object({
  id: z.string().min(1),
  name: z.string(),
  type: z.string(),
  description: z.string().nullish(),
  options: Options.nullish(),
});
export type AirtableField = z.infer<typeof AirtableField>;

export const AirtableView = z.object({
  id: z.string().min(1),
  name: z.string(),
  type: z.string(),
  /** Only grid views say which fields they show */
  visibleFieldIds: z.array(z.string()).nullish(),
});
export type AirtableView = z.infer<typeof AirtableView>;

export const AirtableTable = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string().nullish(),
  primaryFieldId: z.string(),
  fields: z.array(AirtableField),
  views: z.array(AirtableView).default([]),
});
export type AirtableTable = z.infer<typeof AirtableTable>;

export const AirtableSchema = z.object({ tables: z.array(AirtableTable) });
export type AirtableSchema = z.infer<typeof AirtableSchema>;

export const AirtableRecord = z.object({
  id: z.string().min(1),
  createdTime: z.string().optional(),
  fields: z.record(z.string(), z.unknown()).default({}),
});
export type AirtableRecord = z.infer<typeof AirtableRecord>;

const RecordsPage = z.object({ records: z.array(AirtableRecord), offset: z.string().optional() });
const WhoAmI = z.object({ id: z.string() });
const BasesPage = z.object({
  bases: z.array(z.object({ id: z.string(), name: z.string(), permissionLevel: z.string().default('read') })),
  offset: z.string().optional(),
});

export function tokenInvalid(): AppError {
  return new AppError('validation_failed', 'import.airtable.tokenInvalid', {
    fields: { token: 'import.airtable.tokenInvalid' },
  });
}

const unreadable = () => new AppError('unavailable', 'import.airtable.unreadable');
const unavailable = () => new AppError('unavailable', 'import.airtable.unavailable');
const rateLimited = () => new AppError('rate_limited', 'import.airtable.rateLimited');

/** What a request is for, which decides how a refusal reads. */
type Purpose = 'bases' | 'base';

function refused(status: number, purpose: Purpose): AppError {
  if (status === 401) return tokenInvalid();
  if (status === 403 || status === 404)
    return purpose === 'bases'
      ? new AppError('validation_failed', 'import.airtable.scopes', {
          fields: { token: 'import.airtable.scopes' },
        })
      : new AppError('not_found', 'import.airtable.baseUnavailable');
  return unreadable();
}

/** How long a 429 answer asks to wait, in milliseconds. */
function retryAfter(response: Response): number {
  const header = response.headers.get('retry-after');
  const seconds = header && /^\d{1,5}$/.test(header.trim()) ? Number(header) : null;
  return seconds === null ? RATE_LIMIT_WAIT_MS : Math.max(1_000, seconds * 1_000);
}

/** How a request reaches Airtable: `fetch` unless a caller supplies its own guarded way there. */
export type Fetch = (
  url: string,
  init: { headers: Record<string, string>; redirect: 'error'; signal: AbortSignal },
) => Promise<Response>;

/**
 * A request that no retry can help, like one to an address the server refuses to reach.  It leaves
 * at once, carrying the reason, instead of being tried again.
 */
export class Unreachable extends Error {
  constructor(readonly reason: unknown) {
    super('Airtable can’t be reached from here');
    this.name = 'Unreachable';
  }
}

export interface ClientOptions {
  /** Where Airtable's API answers, without a trailing slash */
  apiUrl: string;
  token: string;
  clock: Clock;
  /** The limiter for a base, or for the calls that aren't about one base */
  limiter(key: string): Limiter;
  signal?: AbortSignal;
  fetch?: Fetch;
}

export class AirtableClient {
  constructor(private readonly options: ClientOptions) {}

  /** Takes the token out of anything Airtable sends back, before it's read. */
  scrub(text: string): string {
    return this.options.token ? text.replaceAll(this.options.token, REDACTED) : text;
  }

  private async request<T>(
    key: string,
    path: string,
    params: URLSearchParams,
    schema: z.ZodType<T>,
    purpose: Purpose,
    optional = false,
  ): Promise<T> {
    const { clock, signal } = this.options;
    const limiter = this.options.limiter(key);
    const query = params.toString();
    const url = `${this.options.apiUrl}${path}${query ? `?${query}` : ''}`;
    let backoff = FIRST_BACKOFF_MS;
    for (let attempt = 1; ; attempt++) {
      signal?.throwIfAborted();
      await limiter.take(signal);
      let response: Response;
      try {
        const timeout = AbortSignal.timeout(optional ? 5_000 : REQUEST_TIMEOUT_MS);
        response = await (this.options.fetch ?? fetch)(url, {
          headers: { authorization: `Bearer ${this.options.token}`, accept: 'application/json' },
          redirect: 'error',
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (error) {
        if (error instanceof Unreachable) throw error;
        signal?.throwIfAborted();
        if (optional || attempt >= TRIES) throw unavailable();
        await clock.sleep(backoff, signal);
        backoff *= 2;
        continue;
      }
      if (response.status === 429) {
        await response.body?.cancel().catch(() => undefined);
        if (optional || attempt >= TRIES) throw rateLimited();
        // Every request for this base waits, not just this one.
        limiter.pause(retryAfter(response));
        continue;
      }
      if (response.status >= 500) {
        await response.body?.cancel().catch(() => undefined);
        if (optional || attempt >= TRIES) throw unavailable();
        await clock.sleep(backoff, signal);
        backoff *= 2;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw refused(response.status, purpose);
      }
      let text: string;
      try {
        text = this.scrub(await response.text());
      } catch {
        signal?.throwIfAborted();
        if (optional || attempt >= TRIES) throw unavailable();
        continue;
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw unreadable();
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) throw unreadable();
      return parsed.data;
    }
  }

  /** Whether Airtable takes the token at all, whatever it may read. */
  async whoami(): Promise<{ id: string }> {
    return this.request('meta', '/v0/meta/whoami', new URLSearchParams(), WhoAmI, 'bases');
  }

  /** Every base the token can see, up to the list's limit. */
  async bases(): Promise<AirtableBase[]> {
    const bases: AirtableBase[] = [];
    let offset: string | undefined;
    do {
      const params = new URLSearchParams();
      if (offset) params.set('offset', offset);
      const page = await this.request('meta', '/v0/meta/bases', params, BasesPage, 'bases');
      for (const base of page.bases) if (/^app[A-Za-z0-9]{14}$/.test(base.id)) bases.push(base);
      offset = page.offset;
    } while (offset && bases.length < AIRTABLE_IMPORT_LIMITS.bases);
    return bases.slice(0, AIRTABLE_IMPORT_LIMITS.bases);
  }

  /** Workspace metadata is optional and a refusal ends discovery for this list */
  async groupedBases(): Promise<AirtableBase[]> {
    const bases = await this.bases();
    const pending = new Set(bases.map((base) => base.id));
    const workspaces = new Map<string, { id: string; name: string }>();
    const BaseWorkspace = z.object({ workspaceId: z.string().regex(/^wsp[A-Za-z0-9]+$/) });
    const Workspace = z.object({ id: z.string(), name: z.string(), baseIds: z.array(z.string()) });
    const timeout = AbortSignal.timeout(WORKSPACE_TIME_LIMIT_MS);
    const discovery = new AirtableClient({
      ...this.options,
      signal: this.options.signal ? AbortSignal.any([this.options.signal, timeout]) : timeout,
    });
    let requests = 0;
    try {
      for (const base of bases) {
        if (!pending.has(base.id)) continue;
        if (requests + 2 > WORKSPACE_REQUEST_LIMIT) return bases;
        requests += 2;
        const detail = await discovery.request(
          'workspace-discovery',
          `/v0/meta/bases/${base.id}`,
          new URLSearchParams(),
          BaseWorkspace,
          'base',
          true,
        );
        const workspace = await discovery.request(
          'workspace-discovery',
          `/v0/meta/workspaces/${detail.workspaceId}`,
          new URLSearchParams(),
          Workspace,
          'base',
          true,
        );
        for (const id of workspace.baseIds) {
          workspaces.set(id, { id: workspace.id, name: workspace.name });
          pending.delete(id);
        }
        workspaces.set(base.id, { id: workspace.id, name: workspace.name });
        pending.delete(base.id);
      }
    } catch {
      this.options.signal?.throwIfAborted();
      // A partial discovery must not mix workspace and access-level groups
      return bases;
    }
    return bases.map((base) => {
      const workspace = workspaces.get(base.id);
      return workspace ? { ...base, workspace } : base;
    });
  }

  /** A base's tables with their fields and views, and which fields each grid view shows. */
  schema(baseId: string): Promise<AirtableSchema> {
    const params = new URLSearchParams([['include[]', 'visibleFieldIds']]);
    return this.request(baseId, `/v0/meta/bases/${baseId}/tables`, params, AirtableSchema, 'base');
  }

  /**
   * A table's records, a page at a time, keyed by field ID.  With `view`, only the records the
   * view shows, in its order.  With `fields`, only those fields' values.
   */
  async *records(
    baseId: string,
    tableId: string,
    options: { view?: string; fields?: readonly string[] } = {},
  ): AsyncGenerator<AirtableRecord[]> {
    let offset: string | undefined;
    do {
      const params = new URLSearchParams({ pageSize: String(PAGE_SIZE), returnFieldsByFieldId: 'true' });
      if (options.view) params.set('view', options.view);
      for (const field of options.fields ?? []) params.append('fields[]', field);
      if (offset) params.set('offset', offset);
      const page = await this.request(
        baseId,
        `/v0/${baseId}/${encodeURIComponent(tableId)}`,
        params,
        RecordsPage,
        'base',
      );
      yield page.records;
      offset = page.offset;
    } while (offset);
  }
}
