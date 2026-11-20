import {
  FEED_COLUMNS,
  FEED_OBJECT,
  parseRequestHeaders,
  type CellValue,
  type FeedColumn,
  type SourceColumn,
  type SourceSelect,
  type SourceTestResult,
  type TestStep,
} from '@riosoma/contracts';
import { FileNetworkError, NO_NETWORK, type FileNetwork } from '../files/network.js';
import { sourceKey } from '../registry.js';
import {
  ConnectorError,
  NotModified,
  type Connector,
  type ConnectorContext,
  type SourcePreviewRows,
  type SourceRow,
  type Validators,
} from '../types.js';
import { FEED_KEYS, parseFeed, type FeedItem, type ParsedFeed } from './parse.js';

/**
 * RSS, Atom, and JSON feeds at a web address.  A feed offers one thing, its items, whose columns are
 * always the same, and each item is a record keyed by its ID.  Every request goes through the
 * server's guarded network, the one file and API sources use, so the private-network rule and the
 * checks on each redirect hold here too.  A read sends the validators the last read's answer gave,
 * and a feed that says nothing changed ends the read with `NotModified`.
 */

type Settings = { kind: 'feed'; url: string };

export const FEED_CONNECTOR_KEYS = {
  ...FEED_KEYS,
  https: 'sources.feed.https',
  blocked: 'sources.feed.blocked',
  resolve: 'sources.feed.resolve',
  tooLarge: 'sources.feed.tooLarge',
  denied: 'sources.feed.denied',
  notFound: 'sources.feed.notFound',
  status: 'sources.feed.status',
  headers: 'sources.file.headers',
  noQueries: 'sources.feed.noQueries',
  read: 'sources.sync.read',
  objectMissing: 'sources.sync.objectMissing',
  timeout: 'sources.test.timeout',
} as const;

export interface FeedConnectorOptions {
  /** The guarded network the server supplies.  Without one, nothing is reached. */
  network?: FileNetwork;
  /** The most one feed may hold: 20 MB unless set */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

/** How a test names the format it found, where a database's test names its server. */
const FORMAT_NAMES = { rss2: 'RSS 2.0', rss1: 'RSS 1.0', atom: 'Atom 1.0', json: 'JSON Feed' } as const;
const ACCEPT =
  'application/feed+json, application/rss+xml, application/atom+xml, application/rdf+xml;q=0.9, application/json;q=0.8, application/xml;q=0.8, text/xml;q=0.8, */*;q=0.5';

/** Each column's type, and the other types it converts to cleanly. */
const COLUMNS: Record<
  FeedColumn,
  { type: string; options?: Record<string, unknown>; alternatives: string[] }
> = {
  id: { type: 'text', alternatives: ['longText', 'url'] },
  title: { type: 'text', alternatives: ['longText'] },
  link: { type: 'url', alternatives: ['text'] },
  author: { type: 'text', alternatives: ['longText'] },
  published: { type: 'date', options: { includeTime: true, timeZone: 'UTC' }, alternatives: ['text'] },
  updated: { type: 'date', options: { includeTime: true, timeZone: 'UTC' }, alternatives: ['text'] },
  summary: { type: 'longText', alternatives: ['text'] },
  content: { type: 'longText', options: { richText: true }, alternatives: [] },
  categories: { type: 'multipleSelect', alternatives: ['text', 'longText'] },
  enclosure: { type: 'url', alternatives: ['text'] },
};

export const FEED_SOURCE_COLUMNS: SourceColumn[] = FEED_COLUMNS.map((name) => ({
  name,
  sourceType: name === 'categories' ? 'list' : name === 'published' || name === 'updated' ? 'date' : 'text',
  nullable: name !== 'id',
  suggested: { type: COLUMNS[name].type, options: COLUMNS[name].options ?? {} },
  alternatives: COLUMNS[name].alternatives,
}));

function settingsOf(ctx: ConnectorContext): Settings {
  if (ctx.connection.kind !== 'feed') throw new ConnectorError(FEED_CONNECTOR_KEYS.read, 'not a feed source');
  return ctx.connection;
}

function checkSelect(select: SourceSelect): void {
  if (select.kind === 'query')
    throw new ConnectorError(FEED_CONNECTOR_KEYS.noQueries, 'feeds have no queries');
  if (select.object.name !== FEED_OBJECT)
    throw new ConnectorError(FEED_CONNECTOR_KEYS.objectMissing, 'a feed offers only its items', {
      object: select.object.name,
    });
}

/** One item's value for a column, as a field of the given type holds it. */
export function feedValue(item: FeedItem, column: string, type: string): CellValue {
  const value = (item as unknown as Record<string, unknown>)[column];
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) {
    if (!value.length) return null;
    return type === 'multipleSelect' ? value.map(String) : value.map(String).join(', ');
  }
  if (type === 'multipleSelect') return [String(value)];
  return String(value);
}

export function createFeedConnector(options: FeedConnectorOptions = {}): Connector {
  const network = options.network ?? NO_NETWORK;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  function failure(error: unknown, ctx: ConnectorContext): ConnectorError {
    if (error instanceof ConnectorError) return error;
    if (error instanceof FileNetworkError) {
      switch (error.problem) {
        case 'https':
          return new ConnectorError(FEED_CONNECTOR_KEYS.https, error.detail);
        case 'blocked':
          return new ConnectorError(FEED_CONNECTOR_KEYS.blocked, error.detail);
        case 'resolve':
          return new ConnectorError(FEED_CONNECTOR_KEYS.resolve, error.detail);
        case 'tooLarge':
          return new ConnectorError(FEED_CONNECTOR_KEYS.tooLarge, undefined, {
            megabytes: Math.floor(maxBytes / 1024 / 1024),
          });
        default:
          return new ConnectorError(FEED_CONNECTOR_KEYS.read, error.detail);
      }
    }
    if (ctx.signal?.aborted)
      return new ConnectorError(FEED_CONNECTOR_KEYS.read, 'the call was stopped before it finished');
    return new ConnectorError(
      FEED_CONNECTOR_KEYS.read,
      error instanceof Error ? error.message.slice(0, 300) : undefined,
    );
  }

  /** The feed's answer, or `NotModified` when the validators say nothing changed. */
  async function fetchFeed(
    ctx: ConnectorContext,
    since?: Validators,
  ): Promise<{ feed: ParsedFeed; validators: Validators }> {
    const settings = settingsOf(ctx);
    const url = new URL(settings.url);
    if (!network.allowsAddress(url))
      throw new FileNetworkError('https', `${url.protocol} addresses aren't allowed`);
    const headers: Record<string, string> = { accept: ACCEPT };
    if (ctx.secrets.headers !== undefined) {
      const own = parseRequestHeaders(ctx.secrets.headers);
      if (!own) throw new ConnectorError(FEED_CONNECTOR_KEYS.headers);
      Object.assign(headers, own);
    }
    if (since?.etag) headers['if-none-match'] = since.etag;
    if (since?.lastModified) headers['if-modified-since'] = since.lastModified;
    const timeoutMs = ctx.timeoutMs ?? 30_000;
    const signal = ctx.signal
      ? AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    const response = await network
      .request({
        url,
        method: 'GET',
        headers,
        maxBytes,
        signal,
        idleMs: timeoutMs,
      })
      .catch((error: unknown) => {
        if (signal.aborted && !ctx.signal?.aborted) throw new ConnectorError(FEED_CONNECTOR_KEYS.timeout);
        throw error;
      });
    try {
      if (response.status === 304 && since && (since.etag || since.lastModified)) throw new NotModified();
      if (response.status === 401 || response.status === 403)
        throw new ConnectorError(FEED_CONNECTOR_KEYS.denied, `the feed answered ${response.status}`);
      if (response.status === 404 || response.status === 410)
        throw new ConnectorError(FEED_CONNECTOR_KEYS.notFound, `the feed answered ${response.status}`);
      if (response.status < 200 || response.status >= 300)
        throw new ConnectorError(FEED_CONNECTOR_KEYS.status, `the feed answered ${response.status}`, {
          status: response.status,
        });
      const chunks: Buffer[] = [];
      for await (const chunk of response.body) chunks.push(chunk);
      const feed = parseFeed(Buffer.concat(chunks), response.url.href);
      const validators: Validators = {};
      if (response.headers.etag) validators.etag = response.headers.etag;
      if (response.headers['last-modified']) validators.lastModified = response.headers['last-modified'];
      return { feed, validators };
    } catch (error) {
      if (signal.aborted && !ctx.signal?.aborted) throw new ConnectorError(FEED_CONNECTOR_KEYS.timeout);
      throw error;
    } finally {
      response.close();
    }
  }

  function rowsOf(
    items: readonly FeedItem[],
    columns: readonly string[],
    types: Record<string, string>,
  ): CellValue[][] {
    return items.map((item) => columns.map((column) => feedValue(item, column, types[column] ?? 'text')));
  }

  const suggestedTypes = Object.fromEntries(
    FEED_SOURCE_COLUMNS.map((column) => [column.name, column.suggested!.type]),
  );

  async function test(ctx: ConnectorContext): Promise<SourceTestResult> {
    const steps: SourceTestResult['steps'] = [];
    const deadline = AbortSignal.timeout(ctx.timeoutMs ?? 30_000);
    const signal = AbortSignal.any([deadline, ...(ctx.signal ? [ctx.signal] : [])]);
    let current: TestStep = 'resolve';
    let started = Date.now();
    const passed = (step: TestStep, next: TestStep) => {
      steps.push({ step, status: 'ok', ms: Date.now() - started });
      current = next;
      started = Date.now();
    };
    try {
      const settings = settingsOf(ctx);
      const url = new URL(settings.url);
      if (!network.allowsAddress(url))
        throw new FileNetworkError('https', `${url.protocol} addresses aren't allowed`);
      await network.check(url, signal);
      passed('resolve', 'read');
      const { feed } = await fetchFeed(ctx);
      passed('read', 'feed');
      if (!feed.items.length) throw new ConnectorError(FEED_KEYS.empty, 'the feed has no items');
      steps.push({ step: 'feed', status: 'ok', ms: Date.now() - started });
      return { ok: true, steps, serverVersion: FORMAT_NAMES[feed.format] };
    } catch (error) {
      const failed =
        deadline.aborted && !ctx.signal?.aborted
          ? new ConnectorError(FEED_CONNECTOR_KEYS.timeout)
          : failure(error, ctx);
      const key =
        failed.messageKey === FEED_CONNECTOR_KEYS.read
          ? `sources.test.${current}`
          : failed.messageKey === FEED_CONNECTOR_KEYS.resolve
            ? 'sources.test.resolve'
            : failed.messageKey;
      steps.push({
        step: current,
        status: 'failed',
        ms: Date.now() - started,
        messageKey: key,
        ...(failed.detail ? { detail: failed.detail } : {}),
      });
      return { ok: false, steps };
    }
  }

  return {
    kind: 'feed',
    test,
    async listObjects() {
      return [{ schema: null, name: FEED_OBJECT, type: 'feed', rowEstimate: null }];
    },
    async describe(_ctx, select) {
      checkSelect(select);
      return FEED_SOURCE_COLUMNS;
    },
    async preview(ctx, select, limit): Promise<SourcePreviewRows> {
      checkSelect(select);
      try {
        const { feed } = await fetchFeed(ctx);
        const columns = FEED_SOURCE_COLUMNS.map((column) => column.name);
        return {
          columns: FEED_SOURCE_COLUMNS,
          rows: rowsOf(feed.items.slice(0, Math.max(1, Math.min(limit, 1_000))), columns, suggestedTypes),
          rowEstimate: feed.items.length,
        };
      } catch (error) {
        throw failure(error, ctx);
      }
    },
    async keyCandidates() {
      return [['id']];
    },
    async *read(ctx, select, readOptions): AsyncIterable<SourceRow[]> {
      checkSelect(select);
      let items: FeedItem[];
      try {
        const { feed, validators } = await fetchFeed(ctx, readOptions.since);
        readOptions.onValidators?.(validators);
        items = feed.items;
      } catch (error) {
        if (error instanceof NotModified) throw error;
        throw failure(error, ctx);
      }
      const size = Math.max(1, readOptions.batchSize ?? 5_000);
      for (let start = 0; start < items.length; start += size) {
        yield items.slice(start, start + size).map((item) => ({
          key: sourceKey(readOptions.keyColumns.map((column) => feedValue(item, column, 'text'))),
          values: Object.fromEntries(
            readOptions.columns.map((column) => [
              column,
              feedValue(item, column, readOptions.types[column] ?? 'text'),
            ]),
          ),
        }));
      }
    },
  };
}
