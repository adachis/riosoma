import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { newId, type CommandBatchResult, type TokenCreated } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import type * as formulas from './formula.js';
import { SCAN_LIMIT, matchingIds } from './formula.js';

/**
 * Filters only JavaScript can work out read every record they could keep into the server, so they
 * run as seldom as they can and never over too many records.  The scan is counted by watching
 * `matchingIds`, which does it.
 */

vi.mock('./formula.js', async (importOriginal) => {
  const original = await importOriginal<typeof formulas>();
  return { ...original, matchingIds: vi.fn(original.matchingIds) };
});

let kit: TestPostgres;
let server: ServerFixture;
let token: TokenCreated;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'airtablescan', { airtableApiSecondLimit: 100_000 });
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: server.owner.headers,
    payload: { name: 'Scans', scopes: ['data.records:read', 'data.records:write'], databases: 'all' },
  });
  expect(response.statusCode, response.body).toBe(200);
  token = response.json<TokenCreated>();
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

const scans = () => vi.mocked(matchingIds).mock.calls.length;

// Responses are loosely typed on purpose, as in the route tests.
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(method: 'GET' | 'POST', url: string, payload?: unknown) {
  return server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token.token}` },
    ...(payload === undefined ? {} : { payload: payload as string }),
  });
}

async function list(url: string, formula: string, extra: Record<string, string> = {}): Promise<Json> {
  const response = await call('GET', `${url}?${new URLSearchParams({ filterByFormula: formula, ...extra })}`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

async function newBase(name: string) {
  const databaseId = newId('database');
  const tableId = newId('table');
  const nameId = newId('field');
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: databaseId,
      name,
      table: {
        id: tableId,
        name: 'Rows',
        fields: [{ id: nameId, name: 'Name', type: 'text' }],
        view: { id: newId('view'), name: 'Grid view' },
        records: [],
      },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return { databaseId, tableId, nameId, url: `/v0/${databaseId}/Rows` };
}

const names = (page: Json) => page.records.map((record: Json) => record.fields.Name);

it('reuses the order a JavaScript filter made while the table is unchanged, and leaves SQL filters to the database', async () => {
  const base = await newBase('Reused');
  for (let start = 0; start < 30; start += 10) {
    const created = await call('POST', base.url, {
      records: Array.from({ length: 10 }, (_, i) => ({ fields: { Name: `Row ${start + i}` } })),
    });
    expect(created.statusCode, created.body).toBe(200);
  }
  const before = scans();
  const formula = "REGEX_MATCH({Name}, '1')";
  const first = await list(base.url, formula, { pageSize: '5' });
  expect(names(first)).toEqual(['Row 1', 'Row 10', 'Row 11', 'Row 12', 'Row 13']);
  expect(scans()).toBe(before + 1);
  // The same list again, from its start, and its next page both follow the order already made.
  expect(names(await list(base.url, formula, { pageSize: '5' }))).toEqual(names(first));
  expect(names(await list(base.url, formula, { pageSize: '5', offset: first.offset }))).toEqual([
    'Row 14',
    'Row 15',
    'Row 16',
    'Row 17',
    'Row 18',
  ]);
  expect(scans()).toBe(before + 1);
  // A change to the table means the records have to be read again.
  expect((await call('POST', base.url, { fields: { Name: 'Row 100' } })).statusCode).toBe(200);
  expect(names(await list(base.url, formula, { maxRecords: '3' }))).toEqual(['Row 1', 'Row 10', 'Row 11']);
  expect(scans()).toBe(before + 2);

  // These functions work in SQL now, so the database filters with them and nothing is scanned.
  for (const [sqlFormula, expected] of [
    ["LOWER({Name}) = 'row 12'", ['Row 12']],
    ["UPPER({Name}) = 'ROW 7'", ['Row 7']],
    ["FIND('2', {Name}, 6) = 6", ['Row 12', 'Row 22']],
    ["SEARCH('ROW 2', {Name})", ['Row 2', 'Row 20', 'Row 21', 'Row 22', 'Row 23', 'Row 24']],
    ["AND(ROUND(LEN({Name}) / 4, 0) = 1, TRIM({Name}) = 'Row 9')", ['Row 9']],
  ] as const)
    expect(names(await list(base.url, sqlFormula, { maxRecords: '6' })), sqlFormula).toEqual(expected);
  expect(scans()).toBe(before + 2);
});

it(`refuses a JavaScript filter over more than ${SCAN_LIMIT.toLocaleString('en-US')} records, naming the function, and lets SQL filters and views through`, async () => {
  const base = await newBase('Large');
  // Rows written straight into the table, which takes a moment where commands would take minutes.
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.data, base.tableId)} (__id, ${ident(base.nameId)})
    SELECT 'rec' || lpad(n::text, 14, '0'), 'Row ' || n FROM generate_series(1, ${SCAN_LIMIT + 1}) AS n`,
  );
  const before = scans();
  for (const formula of ["REGEX_MATCH({Name}, '^Row 5$')", "AND({Name}, MID({Name}, 5, 3) = '777')"]) {
    const response = await call('GET', `${base.url}?${new URLSearchParams({ filterByFormula: formula })}`);
    expect(response.statusCode, response.body).toBe(422);
    const body = response.json<{ error: { type: string; message: string } }>();
    expect(body.error.type).toBe('INVALID_FILTER_BY_FORMULA');
    expect(body.error.message).toBe(
      `The formula for filtering records is invalid: it uses ${formula.startsWith('REGEX') ? 'REGEX_MATCH' : 'MID'}, which Riosoma can't apply to a table of more than 100,000 records`,
    );
  }
  expect(scans()).toBe(before + 2);
  // The database works these out itself, however many records there are.
  expect(names(await list(base.url, "LOWER({Name}) = 'row 100001'"))).toEqual(['Row 100001']);
  expect(names(await list(base.url, "FIND('Row 5', {Name}) = 1", { maxRecords: '2' }))).toEqual([
    'Row 5',
    'Row 50',
  ]);
  // A view that leaves fewer records to work through lets the same formula filter them.
  const viewId = newId('view');
  const created = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${base.databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'view.create',
          view: {
            id: viewId,
            tableId: base.tableId,
            name: 'Fives',
            type: 'grid',
            config: {
              filter: {
                conjunction: 'and',
                conditions: [{ id: 'fives', fieldId: base.nameId, operator: 'contains', value: '55555' }],
              },
              sorts: [],
            },
          },
        },
      ],
    },
  });
  expect(created.json<CommandBatchResult>().results[0]?.status, created.body).toBe('applied');
  expect(names(await list(base.url, "REGEX_MATCH({Name}, '5$')", { view: 'Fives' }))).toEqual(['Row 55555']);
  expect(scans()).toBe(before + 3);
}, 120_000);

it('works a JavaScript filter out again when a name it reads comes to mean another field', async () => {
  const base = await newBase('Renamed');
  const code = newId('field');
  const command = async (input: Record<string, unknown>) => {
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${base.databaseId}/commands`,
      headers: server.owner.headers,
      payload: {
        clientId: newId('client'),
        commands: [{ id: newId('command'), groupId: newId('action'), ...input }],
      },
    });
    expect(response.json<CommandBatchResult>().results[0]?.status, response.body).toBe('applied');
  };
  await command({
    kind: 'field.create',
    tableId: base.tableId,
    field: { id: code, name: 'Code', type: 'text' },
  });
  const created = await call('POST', base.url, {
    records: [{ fields: { Name: 'apple', Code: 'zeta' } }, { fields: { Name: 'zebra', Code: 'alpha' } }],
  });
  expect(created.statusCode, created.body).toBe(200);
  const [apple, zebra] = created.json<Json>().records.map((record: Json) => record.id);
  const ids = async () =>
    (await list(base.url, "REGEX_MATCH({Name}, '^a')")).records.map((record: Json) => record.id);
  expect(await ids()).toEqual([apple]);
  // Renaming changes no record, and the same formula now reads the other field.
  await command({ kind: 'field.update', fieldId: base.nameId, name: 'Label' });
  await command({ kind: 'field.update', fieldId: code, name: 'Name' });
  expect(await ids()).toEqual([zebra]);
});
