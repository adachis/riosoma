import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { PlatformPreview, type RowData } from '@riosoma/contracts';
import type * as Logger from '../../../../logger.js';
import { startServer, type ServerFixture } from '../../../../test/fixture.js';
import { documentedReplay } from '../../../../test/platforms/documented-replay.js';
import { call, importBase, listBases, sealedToken } from '../../../../test/platforms/harness.js';
import { notionFormula, NOTION_VERSION, planField } from './reader.js';

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
const TOKEN = `notion-test-${randomUUID()}`;
const BASE = '11111111-1111-4111-8111-111111111111';
const SOURCE = '22222222-2222-4222-8222-222222222222';
let kit: TestPostgres;
let server: ServerFixture;
let replay: Awaited<ReturnType<typeof documentedReplay>>;
let now = 0;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'notion_import', { logLevel: 'trace' });
  replay = await documentedReplay(
    join(import.meta.dirname, 'test/responses.json'),
    (headers, path) =>
      path.startsWith('/files/') ||
      (headers.authorization === `Bearer ${TOKEN}` && headers['notion-version'] === NOTION_VERSION),
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
const request = (extra: Record<string, unknown> = {}) => ({
  address: replay.url,
  token: TOKEN,
  baseId: BASE,
  ...extra,
});

describe('Notion databases', () => {
  it('pages through data-source search, deduplicates databases, and groups by parent page', async () => {
    expect(await listBases(server, 'notion', { address: replay.url, token: TOKEN })).toEqual([
      { id: BASE, name: 'Riosoma tests', group: 'Projects' },
    ]);
    expect(replay.requests.filter((request) => request.path === '/v1/search')).toHaveLength(2);
    const error = await call<{ error: { messageKey: string } }>(
      server,
      'POST',
      '/api/imports/notion/bases',
      { address: replay.url, token: 'wrong-token' },
      422,
    );
    expect(error.error.messageKey).toBe('import.platform.tokenInvalid');
  });

  it('previews the data sources and fidelity without creating an import or returning records', async () => {
    const preview = PlatformPreview.parse(
      await call(server, 'POST', '/api/imports/notion/preview', request()),
    );
    expect(preview.tables.map((table) => table.name)).toEqual(['Tasks', 'Related']);
    expect(preview.tables[0]!.fields).toContainEqual({ name: 'Page body', type: 'longText' });
    expect(preview.tables[0]!.fields).toContainEqual({ name: 'Related', type: 'link' });
    expect(preview.tables[0]!.views).toBeGreaterThan(0);
    expect(preview.notes.some((item) => item.messageKey === 'import.platform.report.pageBody')).toBe(true);
    expect(JSON.stringify(preview)).not.toContain('Long description');
    expect(JSON.stringify(preview)).not.toContain(TOKEN);
    expect(await call(server, 'GET', '/api/imports/notion')).toEqual({ imports: [] });
  });

  it('imports every property type, complete relations and rollups, files, views, and nested bodies', async () => {
    const imported = await importBase(server, 'notion', request());
    expect(imported.schema.tables.map((table) => table.name)).toEqual(['Tasks', 'Related']);
    expect(imported.job.report?.records).toBe(3);
    const row = await imported.record('Tasks', 'Launch');
    expect(row).toMatchObject({
      Quantity: 8,
      Double: 16,
      Total: 12,
      Median: 12,
      Ticket: 'TASK-9',
      'List formula': 'Related task',
      Due: '2026-09-01 – 2026-09-15',
    });
    expect(row['Page body']).toContain('Page text\nNested text');
    expect(row['Page body']).toContain('https://example.com/image.png');
    expect(imported.field('Tasks', 'Related').type).toBe('link');
    expect(row.Related).toHaveLength(1);
    expect(imported.field('Tasks', 'Names').type).toBe('lookup');
    expect(imported.field('Tasks', 'Double').type).toBe('formula');
    expect(imported.field('Tasks', 'Total').type).toBe('rollup');
    expect(imported.field('Tasks', 'Median').type).toBe('number');
    expect(imported.item('Tasks', 'Median', 'import.platform.report.rollupUnknown').status).toBe('changed');
    expect(imported.field('Tasks', 'Status').type).toBe('singleSelect');
    expect(imported.field('Tasks', 'Cost').type).toBe('currency');
    expect(imported.field('Tasks', 'Percent').type).toBe('percent');
    expect(row.Files).toHaveLength(1);
    const tableId = imported.schema.tables.find((table) => table.name === 'Tasks')!.id;
    const found = await call<Array<{ id: string }>>(
      server,
      'GET',
      `/api/tables/${tableId}/records/search?q=Empty`,
    );
    expect(found).toHaveLength(1);
    const empty = await call<RowData>(server, 'GET', `/api/tables/${tableId}/records/${found[0]!.id}`);
    expect(empty.values[imported.field('Tasks', 'Related').id] ?? []).toEqual([]);
    expect(empty.values[imported.field('Tasks', 'Files').id] ?? []).toEqual([]);
    expect(imported.item('Tasks', 'Page body', 'import.platform.report.pageBody').status).toBe('changed');
    expect(imported.item('Tasks', 'List formula', 'import.platform.report.formulaUnread').status).toBe(
      'changed',
    );
    expect(imported.view('Tasks', 'Working').type).toBe('grid');
    expect(
      replay.requests.some(
        (request) => request.path.includes('/properties/rel%3A?') && !request.path.includes('%253A'),
      ),
    ).toBe(true);
    expect(replay.requests.some((request) => request.path.includes('start_cursor=relation-next'))).toBe(true);
    expect(replay.requests.some((request) => request.path.includes('start_cursor=roll-next'))).toBe(true);
    expect(replay.requests.some((request) => request.path.includes('start_cursor=body-next'))).toBe(true);
    expect(
      replay.requests.filter((request) => request.path.startsWith('/files/'))[0]?.headers.authorization,
    ).toBeUndefined();
    expect(await sealedToken(server, imported.job.id)).toBeNull();
    expect(
      logs.lines.some(
        (line) => line.includes(TOKEN) || line.includes('Long description') || line.includes('Nested text'),
      ),
    ).toBe(false);
  });

  it('respects the three-request rate and retry-after while using the guarded download', async () => {
    replay.fault('/v1/search', { object: 'error', code: 'rate_limited' }, 429, 11);
    const before = now;
    await listBases(server, 'notion', { address: replay.url, token: TOKEN });
    expect(now - before).toBeGreaterThanOrEqual(11_000);
    expect(replay.requests.length).toBeGreaterThan(3);
    const blocked = await call<{ error: { messageKey: string } }>(
      server,
      'POST',
      '/api/imports/notion/bases',
      { address: 'https://10.0.0.1', token: TOKEN },
      422,
    );
    expect(blocked.error.messageKey).toBe('import.platform.private');
  });

  it('imports populated and empty places as locations and preserves their details', async () => {
    const imported = await importBase(server, 'notion', request());
    expect(imported.field('Tasks', 'Office').type).toBe('location');
    expect((await imported.record('Tasks', 'Launch')).Office).toEqual({
      lat: 37.7749,
      lng: -122.4194,
      label: 'San Francisco, 1 Market St, San Francisco, CA, place-aws-1, place-google-1',
    });
    const tableId = imported.schema.tables.find((table) => table.name === 'Tasks')!.id;
    const records = await call<Array<{ id: string }>>(
      server,
      'GET',
      `/api/tables/${tableId}/records/search?q=Empty`,
    );
    expect(records).toHaveLength(1);
    const empty = await call<RowData>(server, 'GET', `/api/tables/${tableId}/records/${records[0]!.id}`);
    expect(empty.values[imported.field('Tasks', 'Office').id] ?? null).toBeNull();
    expect(imported.item('Tasks', 'Office', 'import.platform.report.placeDetails').status).toBe('changed');
  });

  it('keeps zero coordinates when optional place details are absent', () => {
    const plan = planField(
      { id: 'plce', name: 'Office', type: 'place', place: {} },
      { tables: new Set(), address: replay.url },
    );
    expect(plan).toMatchObject({ kind: 'value', spec: { type: 'location' } });
    if (plan.kind !== 'value') throw new Error('Expected a location value');
    expect(
      plan.read({
        place: { lat: 0, lon: 0, name: null, address: null, aws_place_id: null, google_place_id: null },
      }),
    ).toEqual({ lat: 0, lng: 0 });
    expect(plan.read({ place: null })).toBeNull();
  });

  it('fails a repeated cursor instead of accepting truncated search results', async () => {
    replay.fault('/v1/search', { results: [], has_more: true, next_cursor: 'search-next' });
    replay.fault('/v1/search', { results: [], has_more: true, next_cursor: 'search-next' });
    const error = await call<{ error: { messageKey: string } }>(
      server,
      'POST',
      '/api/imports/notion/bases',
      { address: replay.url, token: TOKEN },
      503,
    );
    expect(error.error.messageKey).toBe('import.platform.unreadable');
  });
});

it('translates scalar formulas and preserves unsupported formulas and future property values', () => {
  expect(notionFormula('prop("Quantity") * 2').expression).toBe('({Quantity} * 2)');
  expect(notionFormula('prop("Related").map(current)').expression).toBeNull();
  const field = { id: 'future', name: 'Future', type: 'future_type', future_type: { config: true } };
  const plan = planField(field, { tables: new Set(), address: 'https://api.notion.com' });
  expect(plan).toMatchObject({ kind: 'value', notes: [{ key: 'import.platform.report.valueSnapshot' }] });
  if (plan.kind === 'value') expect(plan.read({ future_type: { value: 'preserved' } })).toBe('preserved');
  const source = replay.recording.answers.find((answer) => answer.path === `/v1/data_sources/${SOURCE}`)
    ?.response as { properties: Record<string, Parameters<typeof planField>[0]> };
  const types = Object.values(source.properties).map((field) => field.type);
  expect(new Set(types).size).toBeGreaterThanOrEqual(24);
  for (const field of Object.values(source.properties))
    expect(planField(field, { tables: new Set(), address: replay.url })).toHaveProperty('kind');
});
