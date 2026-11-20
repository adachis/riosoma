import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { PlatformPreview, type RowData } from '@riosoma/contracts';
import type * as Logger from '../../../../logger.js';
import { startServer, type ServerFixture } from '../../../../test/fixture.js';
import { documentedReplay } from '../../../../test/platforms/documented-replay.js';
import { call, importBase, listBases, sealedToken } from '../../../../test/platforms/harness.js';
import { MondayApi, MONDAY_VERSION, planField } from './reader.js';
import { RateLimiter } from '../../core/clock.js';
import { PlatformClient } from '../http.js';

const logs = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('../../../../logger.js', async (original) => {
  const actual = await original<typeof Logger>();
  return {
    ...actual,
    loggerOptions: (level: string, production: boolean) => ({
      ...actual.loggerOptions(level, production),
      stream: {
        write(line: string) {
          logs.lines.push(line);
        },
      },
    }),
  };
});
const TOKEN = `monday-test-${randomUUID()}`;
let kit: TestPostgres;
let server: ServerFixture;
let replay: Awaited<ReturnType<typeof documentedReplay>>;
let now = 0;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'monday_import', { logLevel: 'trace' });
  replay = await documentedReplay(
    join(import.meta.dirname, 'test/responses.json'),
    (headers, path) =>
      path.startsWith('/files/') ||
      (headers.authorization === TOKEN && headers['api-version'] === MONDAY_VERSION),
  );
  const importer = server.ctx.platformImports!;
  importer.clock = {
    now: () => now,
    sleep: async (ms, signal) => {
      signal?.throwIfAborted();
      now += ms;
    },
  };
  importer.allowPrivate = (url) => url.origin === replay.url;
}, 60_000);
afterEach(() => replay.reset());
afterAll(async () => {
  await server?.close();
  await replay?.close();
  await kit?.stop();
});
const request = () => ({ address: replay.url, token: TOKEN, baseId: '100' });

async function emptyRecord(imported: Awaited<ReturnType<typeof importBase>>, table: string) {
  const tableId = imported.schema.tables.find((item) => item.name === table)!.id;
  const records = await call<Array<{ id: string }>>(
    server,
    'GET',
    `/api/tables/${tableId}/records/search?q=Empty`,
  );
  expect(records).toHaveLength(1);
  return call<RowData>(server, 'GET', `/api/tables/${tableId}/records/${records[0]!.id}`);
}

describe('monday.com boards', () => {
  it('paginates the boards the token can read and groups them by workspace', async () => {
    const bases = await listBases(server, 'monday', { address: replay.url, token: TOKEN });
    expect(bases).toHaveLength(101);
    expect(bases[0]).toEqual({ id: '100', name: 'Riosoma tests', group: 'Riosoma tests' });
    expect(bases[100]?.group).toBe('Other workspace');
    const error = await call<{ error: { messageKey: string } }>(
      server,
      'POST',
      '/api/imports/monday/bases',
      { address: replay.url, token: 'wrong-token' },
      422,
    );
    expect(error.error.messageKey).toBe('import.platform.tokenInvalid');
  });

  it('previews linked boards and the child table without record contents', async () => {
    const preview = PlatformPreview.parse(
      await call(server, 'POST', '/api/imports/monday/preview', request()),
    );
    expect(preview.tables.map((table) => table.name)).toEqual([
      'Riosoma tests',
      'Related board',
      'Riosoma tests · Subitems',
    ]);
    expect(preview.tables[0]!.fields).toContainEqual({ name: 'Group', type: 'singleSelect' });
    expect(preview.tables[0]!.fields).toContainEqual({ name: 'Subitems', type: 'link' });
    expect(preview.tables[0]!.views).toBeGreaterThan(0);
    expect(JSON.stringify(preview)).not.toContain('Launch text');
    expect(preview.notes.some((item) => item.messageKey === 'import.platform.report.subitemsTable')).toBe(
      true,
    );
  });

  it('imports every column type, connected boards, mirrors, groups, files, and classic subitems', async () => {
    const imported = await importBase(server, 'monday', request());
    const table = 'Riosoma tests';
    expect(imported.job.report?.records).toBe(4);
    const row = await imported.record(table, 'Launch');
    expect(row).toMatchObject({
      Quantity: 8,
      Double: 16,
      'Formula 4': 12,
      'Tracked time': 3661,
      'Item ID': '1001',
      Mirror: ['External value'],
      Timeline: { start: '2026-09-01', end: '2026-09-15' },
      Week: { start: '2026-09-01', end: '2026-09-07' },
      Location: { lat: 34.05, lng: -118.25, label: 'Los Angeles' },
    });
    expect(imported.field(table, 'Double').type).toBe('formula');
    expect(imported.field(table, 'Mirror').type).toBe('lookup');
    expect(imported.field(table, 'Related').type).toBe('link');
    expect(imported.field(table, 'Dependencies').type).toBe('link');
    expect(imported.field(table, 'Group').type).toBe('singleSelect');
    expect(imported.field(table, 'Timeline').type).toBe('dateRange');
    expect(imported.field(table, 'Week').type).toBe('dateRange');
    expect(imported.field(table, 'Location').type).toBe('location');
    expect(row.Related).toHaveLength(1);
    expect(row['Connections · Related board']).toHaveLength(1);
    expect(row['Connections · Riosoma tests']).toHaveLength(1);
    expect(row.Dependencies).toHaveLength(1);
    expect(row.Files).toHaveLength(1);
    expect(row.Subitems).toHaveLength(1);
    const child = await imported.record(`${table} · Subitems`, 'Child task');
    expect(child['Parent item']).toHaveLength(1);
    expect(imported.item(table, 'Auto number', 'import.platform.report.apiValueUnavailable').status).toBe(
      'omitted',
    );
    expect(imported.view(table, 'Planning view').type).toBe('grid');
    const formulaRequests = replay.requests.filter((request) =>
      (request.body as { query?: string } | undefined)?.query?.includes('query FormulaValues'),
    );
    expect(formulaRequests.length).toBeGreaterThanOrEqual(4);
    expect(
      formulaRequests.every(
        (request) => (request.body as { variables: { columns: string[] } }).variables.columns.length <= 5,
      ),
    ).toBe(true);
    expect(
      replay.requests.filter((request) => request.path.startsWith('/files/'))[0]?.headers.authorization,
    ).toBeUndefined();
    expect(await sealedToken(server, imported.job.id)).toBeNull();
    expect(
      logs.lines.some(
        (line) => line.includes(TOKEN) || line.includes('Launch text') || line.includes('Child text'),
      ),
    ).toBe(false);
  });

  it('preserves status and dropdown selections from current label settings', async () => {
    const imported = await importBase(server, 'monday', request());
    const table = 'Riosoma tests';
    const status = imported.field(table, 'Status');
    const dropdown = imported.field(table, 'Choices');
    expect(status.type).toBe('singleSelect');
    expect(dropdown.type).toBe('multipleSelect');
    if (status.type !== 'singleSelect' || dropdown.type !== 'multipleSelect')
      throw new Error('Expected selection fields');
    expect(status.options.choices).toEqual([
      { id: expect.any(String), name: 'Working', color: 'teal' },
      { id: expect.any(String), name: 'Done', color: 'green' },
      { id: expect.any(String), name: 'Retired', color: 'red' },
    ]);
    expect(dropdown.options.choices.map((choice) => choice.name)).toEqual(['One', 'Two']);
    const row = await imported.record(table, 'Launch');
    expect(row.Status).toBe(status.options.choices[0]!.id);
    expect(row.Choices).toEqual(dropdown.options.choices.map((choice) => choice.id));
    const empty = await emptyRecord(imported, table);
    expect(empty.values[status.id] ?? null).toBeNull();
    expect(empty.values[dropdown.id] ?? []).toEqual([]);
  });

  it('stores ratings above five with the current limit, symbol, and color', async () => {
    const imported = await importBase(server, 'monday', request());
    const table = 'Riosoma tests';
    expect(imported.field(table, 'Rating')).toMatchObject({
      type: 'rating',
      options: { max: 10, icon: 'heart', color: 'red' },
    });
    expect((await imported.record(table, 'Launch')).Rating).toBe(8);
    const empty = await emptyRecord(imported, table);
    expect(empty.values[imported.field(table, 'Rating').id] ?? null).toBeNull();
  });

  it('preserves five hierarchy levels on one board and reads calculated values from typed fields', async () => {
    const nested = await documentedReplay(
      join(import.meta.dirname, 'test/multilevel-responses.json'),
      (headers) => headers.authorization === TOKEN && headers['api-version'] === MONDAY_VERSION,
    );
    const importer = server.ctx.platformImports!;
    const previous = importer.allowPrivate;
    importer.allowPrivate = (url) => url.origin === nested.url || previous(url);
    try {
      const imported = await importBase(server, 'monday', {
        address: nested.url,
        token: TOKEN,
        baseId: '500',
      });
      const table = 'Riosoma tests';
      const children = `${table} · Subitems`;
      expect(imported.schema.tables.map((table) => table.name)).toEqual([table, children]);
      expect(imported.job.report?.records).toBe(5);
      const root = await imported.record(table, 'Root');
      expect(root).toMatchObject({
        Quantity: 1,
        Status: 'Done: 1',
        Due: '2026-09-15T00:00:00.000Z',
        Timeline: { start: '2026-09-01', end: '2026-09-15' },
      });
      // The API lists all descendants, but each link must represent its immediate children.
      expect(root.Subitems).toHaveLength(1);
      for (let level = 2; level <= 5; level++) {
        const row = await imported.record(children, `Level ${level}`);
        expect(row.Quantity).toBe(1);
        expect(row.Status).toBe('Done: 1');
        expect(row[level === 2 ? 'Parent item' : 'Parent item · Subitems']).toHaveLength(1);
        expect(row.Subitems ?? []).toHaveLength(level === 5 ? 0 : 1);
      }
      expect(imported.item(table, 'Status', 'import.platform.report.valueSnapshot').status).toBe('changed');
      expect(
        nested.requests.filter((request) =>
          (request.body as { query?: string })?.query?.includes('query ReadChildren'),
        ),
      ).toHaveLength(1);
    } finally {
      importer.allowPrivate = previous;
      await nested.close();
    }
  });

  it('waits for GraphQL complexity errors and proactively pauses when the budget is low', async () => {
    const error = (replay.recording as unknown as { complexityError: unknown }).complexityError;
    replay.fault('ListBoards', error);
    const before = now;
    await listBases(server, 'monday', { address: replay.url, token: TOKEN });
    expect(now - before).toBeGreaterThanOrEqual(17_000);
    replay.fault('ListBoards', {
      data: {
        complexity: { query: 100_000, after: 1, reset_in_x_seconds: 13 },
        boards: Array.from({ length: 100 }, (_, index) => ({
          id: String(index),
          name: 'Board',
          workspace: null,
        })),
      },
    });
    const low = now;
    await listBases(server, 'monday', { address: replay.url, token: TOKEN });
    expect(now - low).toBeGreaterThanOrEqual(13_000);
  });

  it('refuses partial GraphQL data and bounds retries for complexity errors', async () => {
    replay.fault('ListBoards', (replay.recording as unknown as { partialError: unknown }).partialError);
    const partial = await call<{ error: { messageKey: string } }>(
      server,
      'POST',
      '/api/imports/monday/bases',
      { address: replay.url, token: TOKEN },
      503,
    );
    expect(partial.error.messageKey).toBe('import.platform.unreadable');
    for (let count = 0; count < 6; count++)
      replay.fault(
        'ListBoards',
        (replay.recording as unknown as { complexityError: unknown }).complexityError,
      );
    const limited = await call<{ error: { messageKey: string } }>(
      server,
      'POST',
      '/api/imports/monday/bases',
      { address: replay.url, token: TOKEN },
      429,
    );
    expect(limited.error.messageKey).toBe('import.platform.rateLimited');
  });
});

it('maps all documented column types and preserves future types as snapshots', () => {
  const board = replay.recording.answers.find(
    (answer) => answer.operation === 'ReadBoard' && JSON.stringify(answer.variables) === '{"ids":["100"]}',
  )?.response as { data: { boards: Array<{ columns: Parameters<typeof planField>[0][] }> } };
  const columns = board.data.boards[0]!.columns;
  expect(new Set(columns.map((column) => column.type)).size).toBeGreaterThanOrEqual(35);
  const context = { board: '100', tables: new Map([['200', '200']]), address: replay.url, children: '300' };
  for (const column of columns) expect(planField(column, context)).toHaveProperty('kind');
  expect(planField({ id: 'new', title: 'New', type: 'future_type' }, context)).toMatchObject({
    kind: 'value',
    notes: [{ key: 'import.platform.report.valueSnapshot' }],
  });
});

it('shares the formula-value quota across imports', async () => {
  let time = 0;
  const clock = {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
  };
  const limiter = new RateLimiter(clock, 5);
  const client = () =>
    new PlatformClient({
      address: 'https://api.monday.com',
      clock,
      limiter,
      resolve: async () => [],
      allowPrivate: () => false,
      credentials: () => ({}),
      secrets: () => [],
    });
  await new MondayApi(client()).formulaValues(160);
  expect(time).toBe(0);
  await new MondayApi(client()).formulaValues(1);
  expect(time).toBe(1_000);
});

it.each([
  ['stars', 'star'],
  ['hearts', 'heart'],
])('maps the documented rating symbol %s', (symbol, icon) => {
  expect(
    planField(
      { id: 'rating', title: 'Rating', type: 'rating', settings: { limit: 10, symbol, color: '#579bfc' } },
      { board: '100', tables: new Map(), address: 'https://api.monday.com' },
    ),
  ).toMatchObject({ kind: 'value', spec: { type: 'rating', options: { max: 10, icon, color: 'blue' } } });
});

it.each([
  ['saladish', 'yellow'],
  ['sunset', 'red'],
  [7, 'blue'],
])('maps the current status color %s', (color, expected) => {
  expect(
    planField(
      {
        id: 'status',
        title: 'Status',
        type: 'status',
        settings: { labels: [{ id: 1, label: 'Selected', color, index: 0 }] },
      },
      { board: '100', tables: new Map(), address: 'https://api.monday.com' },
    ),
  ).toMatchObject({ kind: 'value', spec: { options: { choices: [{ name: 'Selected', color: expected }] } } });
});
