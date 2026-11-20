import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  GridConfig,
  newId,
  SEARCH_LIMITS,
  type CommandBatchResult,
  type GridConfigPatch,
  type RowsPage,
  type ViewSearchRequest,
  type ViewSearchResult,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { dataStore } from './context.js';
import { ViewSearch } from './search.js';
import { SnapshotCache } from './snapshots.js';
import { readFixture } from './snapshots.test-helpers.js';

let kit: TestPostgres;
let server: ServerFixture;
const clientId = newId('client');
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'search');
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

async function send(databaseId: string, commands: Array<Record<string, unknown>>) {
  const groupId = newId('action');
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId,
      commands: commands.map((command) => ({ id: newId('command'), groupId, ...command })),
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  for (const result of response.json<CommandBatchResult>().results)
    expect(result.status, response.body).toBe('applied');
}

async function search(viewId: string, body: ViewSearchRequest, as: SignedIn = server.owner) {
  return server.app.inject({
    method: 'POST',
    url: `/api/views/${viewId}/search`,
    headers: as.headers,
    payload: body,
  });
}

async function found(viewId: string, body: ViewSearchRequest): Promise<ViewSearchResult> {
  const response = await search(viewId, body);
  expect(response.statusCode, response.body).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  return response.json<ViewSearchResult>();
}

async function configure(viewId: string, patch: GridConfigPatch) {
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'views')}
    SET config = ${JSON.stringify(GridConfig.parse(patch))}::jsonb WHERE id = ${viewId}`,
  );
}

const ids = {
  database: newId('database'),
  table: newId('table'),
  view: newId('view'),
  name: newId('field'),
  amount: newId('field'),
  price: newId('field'),
  day: newId('field'),
  status: newId('field'),
  owner: newId('field'),
  done: newId('field'),
  notes: newId('field'),
  other: newId('table'),
  link: newId('field'),
  otherName: newId('field'),
};
const choices = { open: newId('choice'), progress: newId('choice') };
const records = Array.from({ length: 6 }, () => newId('record'));

async function projects() {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: ids.database,
      name: 'Search',
      table: {
        id: ids.table,
        name: 'Projects',
        fields: [
          { id: ids.name, name: 'Name', type: 'text' },
          { id: ids.amount, name: 'Amount', type: 'number', options: { precision: 1, thousands: true } },
          { id: ids.price, name: 'Price', type: 'currency', options: { code: 'USD', precision: 2 } },
          {
            id: ids.day,
            name: 'Due',
            type: 'date',
            options: { dateFormat: 'friendly', includeTime: false },
          },
          {
            id: ids.status,
            name: 'Status',
            type: 'singleSelect',
            options: {
              choices: [
                { id: choices.open, name: 'Open', color: 'blue' },
                { id: choices.progress, name: 'In progress', color: 'green' },
              ],
            },
          },
          { id: ids.owner, name: 'Owner', type: 'user' },
          { id: ids.done, name: 'Done', type: 'checkbox' },
          { id: ids.notes, name: 'Notes', type: 'longText' },
        ],
        view: { id: ids.view, name: 'Grid' },
      },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  await send(ids.database, [
    {
      kind: 'table.create',
      table: {
        id: ids.other,
        name: 'Clients',
        fields: [{ id: ids.otherName, name: 'Name', type: 'text' }],
        view: { id: newId('view'), name: 'Grid' },
        records: [],
      },
    },
  ]);
  await send(ids.database, [
    {
      kind: 'field.create',
      tableId: ids.table,
      field: { id: ids.link, name: 'Client', type: 'link', options: { linkedTableId: ids.other } },
    },
  ]);
  const client = newId('record');
  await send(ids.database, [
    {
      kind: 'record.create',
      tableId: ids.other,
      records: [{ id: client, values: { [ids.otherName]: 'Zephyr Labs' } }],
    },
  ]);
  const rows: Array<Record<string, unknown>> = [
    { [ids.name]: 'Acme launch', [ids.amount]: 1234567.5, [ids.status]: choices.progress, [ids.done]: true },
    { [ids.name]: 'Beta', [ids.price]: 1234.5, [ids.day]: '2026-09-27', [ids.owner]: [server.owner.userId] },
    { [ids.name]: 'Gamma ACME', [ids.notes]: 'Ask acme about checked items', [ids.link]: [client] },
    { [ids.name]: 'Delta', [ids.amount]: 1234, [ids.status]: choices.open },
    { [ids.name]: 'Epsilon', [ids.day]: '2025-02-03' },
    { [ids.name]: 'Zeta', [ids.amount]: 0.5 },
  ];
  await send(ids.database, [
    {
      kind: 'record.create',
      tableId: ids.table,
      records: rows.map((values, index) => ({ id: records[index]!, values })),
    },
  ]);
}

const pairs = (result: ViewSearchResult) =>
  result.matches.map((match) => [records.indexOf(match.recordId), match.fieldId]);

describe('view search', () => {
  beforeAll(projects);

  it('finds text in view order, ignoring case, by record and then by field', async () => {
    const result = await found(ids.view, { query: 'acme' });
    expect(pairs(result)).toEqual([
      [0, ids.name],
      [2, ids.name],
      [2, ids.notes],
    ]);
    expect(result).toMatchObject({ total: 3, listed: 3, offset: 0, next: null, rebuilt: false });
    expect(result.fields).toEqual({ [ids.name]: 2, [ids.notes]: 1 });
    expect(result.matches.map((match) => match.index)).toEqual([0, 2, 2]);
  });

  it('matches numbers, money, and dates as they read in the viewer’s language', async () => {
    expect(pairs(await found(ids.view, { query: '1,234,567.5' }))).toEqual([[0, ids.amount]]);
    // Grouped, a stored 1234567.5 never reads "1234", and 1234 reads "1,234.0".
    expect(pairs(await found(ids.view, { query: '1234' }))).toEqual([]);
    expect(pairs(await found(ids.view, { query: '1,234' }))).toEqual([
      [0, ids.amount],
      [1, ids.price],
      [3, ids.amount],
    ]);
    expect(pairs(await found(ids.view, { query: '$1,234.50' }))).toEqual([[1, ids.price]]);
    expect(pairs(await found(ids.view, { query: '0.5' }))).toEqual([[5, ids.amount]]);
    expect(pairs(await found(ids.view, { query: '567,5', locale: 'de' }))).toEqual([[0, ids.amount]]);
    expect(pairs(await found(ids.view, { query: 'sept' }))).toEqual([[1, ids.day]]);
    expect(pairs(await found(ids.view, { query: 'February 3, 2025' }))).toEqual([[4, ids.day]]);
    expect(pairs(await found(ids.view, { query: 'Februar 2025', locale: 'de' }))).toEqual([[4, ids.day]]);
    expect(pairs(await found(ids.view, { query: 'Februar 2025' }))).toEqual([]);
    expect(pairs(await found(ids.view, { query: '27. September', locale: 'de' }))).toEqual([[1, ids.day]]);
  });

  it('matches choices, people, and linked records by name, and never a checkbox', async () => {
    expect(pairs(await found(ids.view, { query: 'PROGRESS' }))).toEqual([[0, ids.status]]);
    expect(pairs(await found(ids.view, { query: choices.progress }))).toEqual([]);
    expect(pairs(await found(ids.view, { query: 'owner' }))).toEqual([[1, ids.owner]]);
    expect(pairs(await found(ids.view, { query: 'zephyr' }))).toEqual([[2, ids.link]]);
    expect(pairs(await found(ids.view, { query: 'checked' }))).toEqual([[2, ids.notes]]);
    // Wildcards are text like any other.
    expect(pairs(await found(ids.view, { query: '%' }))).toEqual([]);
    expect(pairs(await found(ids.view, { query: '_' }))).toEqual([]);
  });

  it('follows the view: its filter, its sort, its hidden fields, and the fields asked for', async () => {
    await configure(ids.view, {
      sorts: [{ fieldId: ids.name, direction: 'desc' }],
      hiddenFieldIds: [ids.notes],
      filter: {
        conjunction: 'and',
        conditions: [{ id: 'f', fieldId: ids.name, operator: 'doesNotContain', value: 'launch' }],
      },
    });
    try {
      const result = await found(ids.view, { query: 'a' });
      const names = result.matches.filter((match) => match.fieldId === ids.name);
      expect(names.map((match) => records.indexOf(match.recordId))).toEqual([5, 2, 3, 1]);
      expect(result.matches.some((match) => match.fieldId === ids.notes)).toBe(false);
      expect(result.matches.some((match) => match.recordId === records[0])).toBe(false);
      const only = await found(ids.view, { query: 'o', fieldIds: [ids.status, ids.notes] });
      expect(pairs(only)).toEqual([[3, ids.status]]);
    } finally {
      await configure(ids.view, {});
    }
  });

  it('pages through matches, keeps its key while nothing changes, and answers text for replacing', async () => {
    const first = await found(ids.view, { query: 'e', limit: 2 });
    expect(first.total).toBeGreaterThan(4);
    expect(first.matches).toHaveLength(2);
    expect(first.next).toBe(2);
    const seen = [...first.matches];
    let next = first.next;
    while (next !== null) {
      const page = await found(ids.view, { query: 'e', limit: 2, offset: next, snapshot: first.snapshot });
      expect(page.key).toBe(first.key);
      expect(page.snapshot).toBe(first.snapshot);
      seen.push(...page.matches);
      next = page.next;
    }
    expect(seen).toHaveLength(first.total);
    expect(new Set(seen.map((match) => `${match.recordId}:${match.fieldId}`)).size).toBe(first.total);
    const withText = await found(ids.view, { query: 'ACME', withText: true });
    expect(withText.matches.map((match) => match.text)).toEqual([
      'Acme launch',
      'Gamma ACME',
      'Ask acme about checked items',
    ]);
    const choice = await found(ids.view, { query: 'progress', withText: true });
    expect(choice.matches[0]!.text).toBeUndefined();
    await send(ids.database, [
      {
        kind: 'record.update',
        tableId: ids.table,
        records: [{ id: records[1]!, values: { [ids.name]: 'Beta e' } }],
      },
    ]);
    const changed = await found(ids.view, { query: 'e', snapshot: first.snapshot });
    expect(changed.key).not.toBe(first.key);
    expect(changed.snapshot).toBe(first.snapshot);
  });

  it('keeps positions in the grid’s snapshot and says when that snapshot is gone', async () => {
    const rows = await server.app.inject({
      url: `/api/views/${ids.view}/rows`,
      headers: server.owner.headers,
    });
    const page = rows.json<RowsPage>();
    const result = await found(ids.view, { query: 'zeta', snapshot: page.snapshot });
    expect(result.snapshot).toBe(page.snapshot);
    expect(result.matches[0]!.index).toBe(5);
    const gone = await found(ids.view, { query: 'zeta', snapshot: 'evicted' });
    expect(gone.rebuilt).toBe(true);
  });

  it('answers only people who may read the database', async () => {
    const stranger = await server.addMember();
    expect((await search(ids.view, { query: 'acme' }, stranger)).statusCode).toBe(404);
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
      (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
      VALUES (${server.owner.info.org.id}, 'database', ${ids.database}, 'user', ${stranger.userId}, 'reader')`,
    );
    const reader = await search(ids.view, { query: 'acme' }, stranger);
    expect(reader.statusCode, reader.body).toBe(200);
    expect(reader.json<ViewSearchResult>().total).toBe(3);
    expect((await search(newId('view'), { query: 'acme' })).statusCode).toBe(404);
    const invalid = await search(ids.view, { query: '' });
    expect(invalid.statusCode).toBe(422);
    const tooLong = await search(ids.view, { query: 'a', limit: SEARCH_LIMITS.pageSize + 1 });
    expect(tooLong.statusCode).toBe(422);
  });

  it('refuses protected POST search results when the session ends during the read', async () => {
    const reader = await server.addMember();
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
      (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
      VALUES (${server.owner.info.org.id}, 'database', ${ids.database}, 'user', ${reader.userId}, 'reader')`,
    );
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const original = ViewSearch.prototype.search;
    const paused = vi.spyOn(ViewSearch.prototype, 'search').mockImplementation(async function (
      this: ViewSearch,
      ...args
    ) {
      const result = await original.apply(this, args);
      expect(result.matches.some((match) => match.text?.includes('Acme'))).toBe(true);
      started();
      await blocked;
      return result;
    });
    const reading = search(ids.view, { query: 'acme', withText: true }, reader).then((response) => response);
    try {
      await ready;
      const ended = await server.app.inject({
        method: 'POST',
        url: '/api/me/sessions/end',
        headers: reader.headers,
        payload: {},
      });
      expect(ended.statusCode, ended.body).toBe(204);
      expect(
        (await server.app.inject({ url: '/api/auth/session', headers: reader.headers })).statusCode,
      ).toBe(401);
    } finally {
      release();
      paused.mockRestore();
    }
    const response = await reading;
    expect(response.statusCode, response.body).toBe(401);
    expect(response.body).not.toContain('Acme');
    expect(response.body).not.toContain('matches');
  });
});

describe('view search limits', () => {
  it('gives up at its statement timeout with a message the person can act on', async () => {
    const read = await readFixture(server, [{ type: 'text' }]);
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.data, read.table.id)} (__id, ${ident(read.fields[0]!.columnName)})
      SELECT 'rec' || lpad(n::text, 14, '0'), 'Record ' || n FROM generate_series(1, 200000) AS n`,
    );
    const store = () => dataStore(server.ctx);
    const snapshots = new SnapshotCache(store, 64, { warn: () => undefined });
    const quick = new ViewSearch(store, snapshots, 1_001);
    await expect(
      quick.search(read, { query: 'record 9', offset: 0, limit: 10, locale: 'en-US', withText: false }),
    ).rejects.toMatchObject({ messageKey: 'data.search.tooSlow' });
    const patient = new ViewSearch(store, snapshots, 30_000);
    const result = await patient.search(read, {
      query: 'record 19999',
      offset: 0,
      limit: 10,
      locale: 'en-US',
      withText: false,
    });
    expect(result.total).toBe(11);
  });

  it('lists the first matches in order and counts the rest', async () => {
    const read = await readFixture(server, [{ type: 'text' }]);
    const count = SEARCH_LIMITS.listed + 5;
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.data, read.table.id)} (__id, ${ident(read.fields[0]!.columnName)})
      SELECT 'rec' || lpad(n::text, 14, '0'), 'Row ' || n FROM generate_series(1, ${count}::int) AS n`,
    );
    const store = () => dataStore(server.ctx);
    const search = new ViewSearch(store, new SnapshotCache(store, 64, { warn: () => undefined }), 30_000);
    const input = {
      query: 'row',
      offset: SEARCH_LIMITS.listed - 1,
      limit: 10,
      locale: 'en-US',
      withText: false,
    };
    const result = await search.search(read, input);
    expect(result).toMatchObject({ total: count, listed: SEARCH_LIMITS.listed, next: null });
    expect(result.matches.map((match) => match.index)).toEqual([SEARCH_LIMITS.listed - 1]);
  });
});

// A million records only for performance runs: `RIOSOMA_PERF=1 pnpm --filter @riosoma/server test search`.
describe.skipIf(!process.env.RIOSOMA_PERF)('view search at a million records', () => {
  const RECORDS = 1_000_000;
  const big = { database: newId('database'), table: newId('table'), view: newId('view') };
  const fields = {
    name: newId('field'),
    amount: newId('field'),
    day: newId('field'),
    status: newId('field'),
  };
  const stages = [newId('choice'), newId('choice'), newId('choice')];

  beforeAll(async () => {
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: server.owner.headers,
      payload: {
        id: big.database,
        name: 'Large',
        table: {
          id: big.table,
          name: 'Orders',
          fields: [
            { id: fields.name, name: 'Name', type: 'text' },
            { id: fields.amount, name: 'Amount', type: 'number' },
            { id: fields.day, name: 'Day', type: 'date' },
            {
              id: fields.status,
              name: 'Status',
              type: 'singleSelect',
              options: { choices: stages.map((id, n) => ({ id, name: `Stage ${n}`, color: 'blue' })) },
            },
          ],
          view: { id: big.view, name: 'Grid' },
        },
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.data, big.table)}
        (__id, ${ident(fields.name)}, ${ident(fields.amount)}, ${ident(fields.day)}, ${ident(fields.status)})
      SELECT 'rec' || lpad(n::text, 14, '0'), 'Order ' || n, (n % 100000)::numeric,
        date '2025-01-01' + (n % 730), (${stages}::text[])[1 + n % 3]
      FROM generate_series(1, ${RECORDS}::int) AS n`,
    );
    await query(server.pool, sql`ANALYZE ${ident(server.schemas.data, big.table)}`);
  }, 600_000);

  async function timed(body: ViewSearchRequest) {
    const started = performance.now();
    const result = await found(big.view, body);
    return { ms: Math.round(performance.now() - started), result };
  }

  it('searches every record fast enough to type into', async () => {
    // The first read builds the view's snapshot, which the grid has already done.
    await server.app.inject({ url: `/api/views/${big.view}/rows?limit=1`, headers: server.owner.headers });
    const report: Array<[string, number, number]> = [];
    for (const query of ['Order 99999', 'order 12345', '12,345', 'Sep 3, 2026', 'stage 2', 'zzz']) {
      const { ms, result } = await timed({ query });
      const cached = await timed({ query, offset: 100 });
      report.push([query, ms, cached.ms]);
      expect(result.total, query).toBeGreaterThan(query === 'zzz' ? -1 : 0);
      expect(ms, query).toBeLessThan(5_000);
      expect(cached.ms, query).toBeLessThan(500);
    }
    const trigram = await query<{ available: boolean }>(
      server.pool,
      sql`SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_trgm') AS available`,
    );
    if (trigram.rows[0]?.available) {
      await query(server.pool, sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
      await query(
        server.pool,
        sql`CREATE INDEX ON ${ident(server.schemas.data, big.table)} USING gin (${ident(fields.name)} gin_trgm_ops)`,
      );
      await query(server.pool, sql`ANALYZE ${ident(server.schemas.data, big.table)}`);
      const { ms } = await timed({ query: 'Order 99999', fieldIds: [fields.name] });
      report.push(['Order 99999 (trigram index)', ms, 0]);
    }
    console.info(
      report.map(([query, first, cached]) => `${query}: ${first} ms, then ${cached} ms`).join('\n'),
    );
  }, 600_000);
});
