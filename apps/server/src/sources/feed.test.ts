/**
 * Feed sources through the server: the private-network rule on a feed's address, whole syncs from
 * a local feed into a table, items that change and items that leave, and conditional requests that
 * answer `304` when nothing changed.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AppError,
  FeedConnection,
  newId,
  type CommandBatchResult,
  type CommandResult,
  type DatabaseSchema,
  type RowData,
  type SourceMeta,
  type SourcePreview,
  type TableMeta,
} from '@riosoma/contracts';
import { createFeedConnector } from '@riosoma/connectors';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { loadFields, loadTable } from '../data/metadata.js';
import { fetchRowsById } from '../data/physical/records.js';
import { checkFeedAddress } from './feed.js';
import { fileNetwork } from './files.js';
import { claimSyncs, runSync } from './sync.js';

interface Entry {
  guid: string;
  title: string;
  categories?: string[];
}

let entries: Entry[] = [];
/** Bumped whenever the feed changes, and the tag the feed answers with. */
let version = 1;
const seen: IncomingHttpHeaders[] = [];
let feedServer: Server;
let origin = '';
let kit: TestPostgres;
let server: ServerFixture;
let databaseId: string;

function rss(): string {
  const items = entries
    .map(
      (entry) =>
        `<item><guid>${entry.guid}</guid><title>${entry.title}</title><link>/items/${entry.guid}</link>` +
        `<description>&lt;p&gt;About ${entry.guid}&lt;/p&gt;</description>` +
        (entry.categories ?? []).map((category) => `<category>${category}</category>`).join('') +
        `<pubDate>Mon, 28 Sep 2026 10:00:00 GMT</pubDate></item>`,
    )
    .join('');
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Local</title>${items}</channel></rss>`;
}

beforeAll(async () => {
  entries = [
    { guid: 'a', title: 'Alpha', categories: ['News'] },
    { guid: 'b', title: '&lt;b&gt;Bravo&lt;/b&gt; &amp;amp; friends', categories: ['News', 'Sports'] },
    { guid: 'c', title: 'Charlie' },
  ];
  feedServer = createServer((req, res) => {
    seen.push(req.headers);
    const etag = `"v${version}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/rss+xml', etag });
    res.end(rss());
  });
  await new Promise<void>((resolve) => feedServer.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(feedServer.address() as AddressInfo).port}`;
  kit = await startTestPostgres();
  // Private hosts are allowed, so the test's own feed on this machine can be reached.
  server = await startServer(kit, 'feedsrc', { automationsAllowPrivateHosts: true });
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: newId('database'),
      name: 'Feeds',
      table: {
        id: newId('table'),
        name: 'Local',
        fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
        view: { id: newId('view'), name: 'Grid' },
      },
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  databaseId = created.json<DatabaseSchema>().database.id;
}, 60_000);

afterAll(async () => {
  await server?.close();
  await kit?.stop();
  await new Promise<void>((resolve) => feedServer.close(() => resolve()));
});

const ITEMS = { kind: 'object' as const, object: { schema: null, name: 'items' } };

async function createSource(url = `${origin}/feed.xml`): Promise<SourceMeta> {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/sources',
    headers: server.owner.headers,
    payload: { name: `Feed ${newId('source')}`, connection: { kind: 'feed', url }, secrets: {} },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<SourceMeta>();
}

async function command(input: Record<string, unknown>): Promise<CommandResult> {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [{ id: newId('command'), groupId: newId('action'), ...input }],
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<CommandBatchResult>().results[0]!;
}

async function applied(input: Record<string, unknown>): Promise<void> {
  const result = await command(input);
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
}

async function sync(tableId: string): Promise<TableMeta> {
  await applied({ kind: 'table.sync', tableId, confirmRemovals: false });
  for (const job of await claimSyncs(server.ctx, 100)) await runSync(server.ctx, job);
  return (await loadTable(server.pool, server.schemas, tableId))!;
}

async function rows(tableId: string): Promise<RowData[]> {
  const ids = await query<{ __id: string }>(
    server.pool,
    sql`SELECT __id FROM ${ident(server.schemas.data, tableId)} WHERE NOT __source_gone ORDER BY __rid`,
  );
  const fields = await loadFields(server.pool, server.schemas, [tableId]);
  return fetchRowsById(
    server.pool,
    server.schemas.data,
    tableId,
    fields,
    ids.rows.map((row) => row.__id),
  );
}

/** A synced table of every column the feed offers, keyed by ID. */
async function feedTable(source: SourceMeta, settings: Record<string, unknown> = {}) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/sources/${source.id}/preview`,
    headers: server.owner.headers,
    payload: { select: ITEMS },
  });
  expect(response.statusCode, response.body).toBe(200);
  const shown = response.json<SourcePreview>();
  expect(shown.keyCandidates).toEqual([['id']]);
  const tableId = newId('table');
  const field = Object.fromEntries(shown.columns.map((column) => [column.name, newId('field')]));
  const result = await command({
    kind: 'table.create',
    table: {
      id: tableId,
      name: `Items ${tableId.slice(-4)}`,
      source: { sourceId: source.id, select: ITEMS, keyColumns: ['id'], everyMinutes: 60, ...settings },
      fields: shown.columns.map((column) => ({
        id: field[column.name],
        name: column.name,
        type: column.suggested!.type,
        options: column.suggested!.options,
        source: { column: column.name, sourceType: column.sourceType },
      })),
      view: { id: newId('view'), name: 'Grid' },
      records: [],
    },
  });
  return { tableId, field, result };
}

describe('feed addresses', () => {
  it('refuses a feed at a private address, before saving and when a name resolves to one', async () => {
    const strict = { production: true, automationsAllowPrivateHosts: false };
    const problem = (url: string) => {
      try {
        checkFeedAddress(FeedConnection.parse({ kind: 'feed', url }), strict);
        return null;
      } catch (error) {
        return error instanceof AppError ? error.messageKey : String(error);
      }
    };
    expect(problem('https://news.example.com/feed.xml')).toBeNull();
    expect(problem('http://news.example.com/feed.xml')).toBe('sources.feed.https');
    expect(problem('https://10.1.2.3/feed.xml')).toBe('sources.feed.blocked');
    expect(problem('https://[::1]/feed.xml')).toBe('sources.feed.blocked');

    // A name that resolves somewhere private is refused when the feed is fetched.
    const connector = createFeedConnector({
      network: fileNetwork({
        resolve: async () => [{ address: '192.168.1.20', family: 4 }],
        allowPrivate: () => false,
      }),
    });
    const context = {
      connection: FeedConnection.parse({ kind: 'feed', url: 'https://intranet.example.test/feed.xml' }),
      secrets: {},
      timeoutMs: 5_000,
    };
    await expect(connector.preview(context, ITEMS, 5)).rejects.toMatchObject({
      messageKey: 'sources.feed.blocked',
    });
    const tested = await connector.test(context);
    expect(tested.steps.at(-1)).toMatchObject({
      step: 'resolve',
      status: 'failed',
      messageKey: 'sources.feed.blocked',
    });
  });
});

describe('syncing a feed into a table', () => {
  it('adds each item, updates changed ones, keeps ones that leave, and asks only for what changed', async () => {
    const source = await createSource();
    const tested = await server.app.inject({
      method: 'POST',
      url: `/api/sources/${source.id}/test`,
      headers: server.owner.headers,
    });
    expect(tested.json()).toMatchObject({ ok: true, serverVersion: 'RSS 2.0' });
    // A feed syncs every 15 minutes at most.
    const often = await feedTable(source, { everyMinutes: 5 });
    expect(often.result).toMatchObject({
      status: 'rejected',
      error: { messageKey: 'sources.feed.schedule' },
    });

    const { tableId, field, result } = await feedTable(source);
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
    const first = await sync(tableId);
    expect(first.source!.status).toMatchObject({ state: 'idle', stats: { added: 3 } });
    const byId = async () => new Map((await rows(tableId)).map((row) => [row.values[field.id!], row.values]));
    const items = await byId();
    expect(items.get('b')).toMatchObject({
      [field.title!]: 'Bravo & friends',
      [field.link!]: `${origin}/items/b`,
      [field.summary!]: 'About b',
      [field.published!]: '2026-09-28T10:00:00.000Z',
    });
    const categories = (await loadFields(server.pool, server.schemas, [tableId])).find(
      (entry) => entry.id === field.categories,
    )!;
    const names = new Map(
      (categories.options as { choices: Array<{ id: string; name: string }> }).choices.map((choice) => [
        choice.id,
        choice.name,
      ]),
    );
    expect((items.get('b')![field.categories!] as string[]).map((id) => names.get(id))).toEqual([
      'News',
      'Sports',
    ]);

    // Nothing changed, so the feed answers 304 to the tag it gave, and every record stands.
    const unchanged = await sync(tableId);
    expect(seen.at(-1)!['if-none-match']).toBe('"v1"');
    expect(unchanged.source!.status).toMatchObject({
      state: 'idle',
      stats: { added: 0, changed: 0, removed: 0, unchanged: 3 },
    });

    // Bravo's title changes, Charlie scrolls out of the feed, and Delta arrives.
    entries = [
      { guid: 'a', title: 'Alpha' },
      { guid: 'b', title: 'Bravo again' },
      { guid: 'd', title: 'Delta' },
    ];
    version += 1;
    const next = await sync(tableId);
    expect(seen.at(-1)!['if-none-match']).toBe('"v1"');
    expect(next.source!.status).toMatchObject({ state: 'idle', stats: { added: 1, removed: 0 } });
    const after = await byId();
    expect([...after.keys()].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(after.get('b')![field.title!]).toBe('Bravo again');
    const stored = await query<{ fetch_state: unknown }>(
      server.pool,
      sql`SELECT fetch_state FROM ${ident(server.schemas.app, 'table_sources')} WHERE table_id = ${tableId}`,
    );
    expect(stored.rows[0]!.fetch_state).toEqual({ etag: '"v2"' });

    // With removal on, items that left the feed leave the table too.  The feed hasn't changed, but
    // the next sync reads it whole, since what it removes has.
    await applied({ kind: 'table.updateSource', tableId, settings: { removeMissing: true } });
    const removed = await sync(tableId);
    expect(seen.at(-1)!['if-none-match']).toBeUndefined();
    expect(removed.source!.status).toMatchObject({ state: 'idle', stats: { removed: 1 } });
    expect([...(await byId()).keys()].sort()).toEqual(['a', 'b', 'd']);
  });
});

describe('changing where a feed comes from', () => {
  it('forgets the last answer’s validators when the address or the headers change', async () => {
    const source = await createSource();
    const { tableId, result } = await feedTable(source);
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
    await sync(tableId);
    await sync(tableId);
    expect(seen.at(-1)!['if-none-match']).toBe(`"v${version}"`);
    const validators = async () =>
      (
        await query<{ fetch_state: unknown }>(
          server.pool,
          sql`SELECT fetch_state FROM ${ident(server.schemas.app, 'table_sources')} WHERE table_id = ${tableId}`,
        )
      ).rows[0]!.fetch_state;
    const change = async (payload: Record<string, unknown>) => {
      const response = await server.app.inject({
        method: 'PATCH',
        url: `/api/sources/${source.id}`,
        headers: server.owner.headers,
        payload,
      });
      expect(response.statusCode, response.body).toBe(200);
    };

    // A new address asks for the whole feed, not whether the old one changed.
    await change({ connection: { kind: 'feed', url: `${origin}/moved.xml` } });
    expect(await validators()).toBeNull();
    await sync(tableId);
    expect(seen.at(-1)!['if-none-match']).toBeUndefined();
    await sync(tableId);
    expect(seen.at(-1)!['if-none-match']).toBe(`"v${version}"`);

    // So do new headers, since the feed may answer someone else differently.
    const credential = ['Bearer', randomBytes(8).toString('hex')].join(' ');
    await change({ secrets: { headers: `Authorization: ${credential}` } });
    expect(await validators()).toBeNull();
    await sync(tableId);
    expect(seen.at(-1)!['if-none-match']).toBeUndefined();
    expect(seen.at(-1)!.authorization).toBe(credential);

    // A change that isn't where or how it's fetched, like its name, keeps them.
    await sync(tableId);
    await change({ name: `Renamed ${newId('source')}` });
    expect(await validators()).toEqual({ etag: `"v${version}"` });
  });
});
