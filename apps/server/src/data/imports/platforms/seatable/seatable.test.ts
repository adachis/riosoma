import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PlatformImport } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type * as Logger from '../../../../logger.js';
import { startServer, type ServerFixture } from '../../../../test/fixture.js';
import { startReplay, type Recording, type Replay } from '../../../../test/platform-replay.js';
import {
  call,
  finished,
  importBase,
  listBases,
  sealedToken,
  startImport,
  tablesHolding,
} from '../../../../test/platforms/harness.js';
import {
  checkSeaTableImport,
  RECORDED_TOKENS,
  SEATABLE_RECORDING,
} from '../../../../test/platforms/seatable-checks.js';
import type { Clock } from '../../core/clock.js';
import type { PlatformImporter } from '../importer.js';
import { conditionOf, planColumn, viewOf } from './reader.js';

/**
 * Imports from a recording of a real SeaTable, in the shape its API documents, so everything
 * SeaTable sends is exactly what it sends.  Every line the server logs is kept, to show neither the
 * API token nor the base token it opens reaches them.
 */
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

const TOKEN = RECORDED_TOKENS.api;
const RECORDING = join(import.meta.dirname, '../../../../test/platforms', SEATABLE_RECORDING);

let kit: TestPostgres;
let server: ServerFixture;
let replay: Replay;
let importer: PlatformImporter;
let baseId: string;
/** The base token SeaTable answers the API token with, which reads the base itself */
let baseToken: string;
/** The path of the first table's rows, which the import reads once the database exists */
let rowsPath: string;
const time = { now: 0 };
const clock: Clock = {
  now: () => time.now,
  sleep: async (ms) => {
    time.now += ms;
  },
};

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'seatable', { logLevel: 'trace' });
  const recording = JSON.parse(readFileSync(RECORDING, 'utf8')) as Recording;
  const exchange = recording.answers.find((answer) => answer.path === '/api/v2.1/dtable/app-access-token/')!;
  const opened = JSON.parse(exchange.body) as { access_token: string; dtable_uuid: string };
  baseToken = opened.access_token;
  baseId = opened.dtable_uuid;
  rowsPath = recording.answers.find((answer) => answer.path.includes('/rows/?'))!.path.split('?')[0]!;
  // SeaTable reads the base with the base token, and signs each file's link with the API token.
  replay = await startReplay(recording, (headers, path) => {
    const sent = String(headers.authorization ?? '');
    if (path.startsWith('/api-gateway/')) return sent === `Bearer ${baseToken}`;
    if (path.startsWith('/api/v2.1/')) return sent === `Bearer ${TOKEN}`;
    return true;
  });
  importer = server.ctx.platformImports!;
  importer.clock = clock;
  // The recording is served from this machine, and nothing else private is allowed.
  importer.allowPrivate = (url) => url.hostname === '127.0.0.1' && url.port === String(replay.port);
}, 60_000);
afterEach(() => replay.reset());
afterAll(async () => {
  await server?.close();
  await replay?.close();
  await kit?.stop();
});

const request = (extra: Record<string, unknown> = {}) => ({ address: replay.url, token: TOKEN, ...extra });

describe('listing SeaTable bases', () => {
  it('lists the base the API token is for, and says when SeaTable refuses it', async () => {
    const bases = await listBases(server, 'seatable', request());
    expect(bases).toEqual([{ id: baseId, name: 'Launch plan', group: null }]);
    const refused = await call<{ error: { messageKey: string; fields: Record<string, string> } }>(
      server,
      'POST',
      '/api/imports/seatable/bases',
      request({ token: 'not-the-token' }),
      422,
    );
    expect(refused.error).toMatchObject({
      messageKey: 'import.platform.tokenInvalid',
      fields: { token: 'import.platform.tokenInvalid' },
    });
  });

  it('keeps to the private-network rule, and to https elsewhere', async () => {
    const blocked = await call<{ error: { messageKey: string } }>(
      server,
      'POST',
      '/api/imports/seatable/bases',
      request({ address: 'http://10.0.0.7:8080' }),
      422,
    );
    expect(blocked.error.messageKey).toBe('import.platform.https');
    const privateHost = await call<{ error: { messageKey: string } }>(
      server,
      'POST',
      '/api/imports/seatable/bases',
      request({ address: 'https://10.0.0.7' }),
      422,
    );
    expect(privateHost.error.messageKey).toBe('import.platform.private');
    // A password signs in to Baserow only.
    await call(
      server,
      'POST',
      '/api/imports/seatable/bases',
      { address: replay.url, email: 'someone@example.com', password: 'a password' },
      422,
    );
  });
});

describe('importing a SeaTable base', () => {
  it('brings every table, column, row, link, file, and view across, as SeaTable had them', async () => {
    replay.requests.length = 0;
    const imported = await importBase(server, 'seatable', request({ baseId, name: 'From SeaTable' }));
    expect(imported.schema.database.name).toBe('From SeaTable');
    expect(imported.job).toMatchObject({ platform: 'seatable', address: replay.url, baseId });
    await checkSeaTableImport(imported);
    // Links came from the link query, since a row's own link column stops at fifty of them.
    expect(replay.requests.filter((entry) => entry.path.includes('/query-links/'))).toHaveLength(2);
    // Each file was fetched from the link SeaTable signed for it, and the public image as it stood.
    expect(replay.requests.filter((entry) => entry.path.startsWith('/seafhttp/'))).toHaveLength(2);
    expect(replay.requests.filter((entry) => entry.path.startsWith('/media/'))).toHaveLength(1);
  });

  it('never keeps or logs either token, and sends them only in their header', async () => {
    const recent = await call<{ imports: PlatformImport[] }>(server, 'GET', '/api/imports/seatable');
    const done = recent.imports.find((entry) => entry.state === 'finished')!;
    expect(await sealedToken(server, done.id)).toBeNull();
    expect(await tablesHolding(server, TOKEN)).toEqual([]);
    expect(await tablesHolding(server, baseToken)).toEqual([]);
    expect(logs.lines.length).toBeGreaterThan(10);
    expect(logs.lines.filter((line) => line.includes(TOKEN) || line.includes(baseToken))).toEqual([]);
    expect(
      replay.requests.every((entry) => !entry.path.includes(TOKEN) && !entry.path.includes(baseToken)),
    ).toBe(true);
  });

  it('keeps the report with the database, for anyone who can read it', async () => {
    const recent = await call<{ imports: PlatformImport[] }>(server, 'GET', '/api/imports/seatable');
    const done = recent.imports.find((entry) => entry.state === 'finished')!;
    const kept = await call<{ imports: PlatformImport[] }>(
      server,
      'GET',
      `/api/databases/${done.databaseId}/imports/seatable`,
    );
    expect(kept.imports.map((entry) => entry.id)).toEqual([done.id]);
    const any = await call<{ imports: PlatformImport[] }>(
      server,
      'GET',
      `/api/databases/${done.databaseId}/platform-imports`,
    );
    expect(any.imports.map((entry) => entry.id).length).toBeGreaterThan(0);
    const stranger = await server.addMember();
    const hidden = await server.app.inject({
      url: `/api/databases/${done.databaseId}/imports/seatable`,
      headers: stranger.headers,
    });
    expect(hidden.statusCode).toBe(404);
  });
});

describe('running SeaTable imports', () => {
  it('waits out 429 answers for the whole tool', async () => {
    replay.throttle('/api-gateway/', 2, 10);
    const before = time.now;
    const started = await startImport(server, 'seatable', request({ baseId, name: 'Throttled' }));
    const job = await finished(server, 'seatable', started.id);
    expect(job.state, JSON.stringify(job.error)).toBe('finished');
    expect(time.now - before).toBeGreaterThanOrEqual(20_000);
  });

  it('stops when asked, puts what it made in the trash, and forgets the token', async () => {
    const held = replay.hold(rowsPath);
    const started = await startImport(server, 'seatable', request({ baseId, name: 'Stopped' }));
    await held.reached;
    const busy = await call<{ error: { messageKey: string } }>(
      server,
      'POST',
      '/api/imports/seatable',
      request({ baseId, name: 'Second' }),
      409,
    );
    expect(busy.error.messageKey).toBe('import.platform.busy');
    const canceled = await call<PlatformImport>(server, 'POST', `/api/imports/seatable/${started.id}/cancel`);
    expect(['running', 'canceled']).toContain(canceled.state);
    held.release();
    const ended = await finished(server, 'seatable', started.id);
    expect(ended.state).toBe('canceled');
    expect(await sealedToken(server, started.id)).toBeNull();
    const database = await server.pool.query<{ trashed_at: Date | null }>(
      `SELECT trashed_at FROM "${server.schemas.app}".databases WHERE id = $1`,
      [ended.databaseId],
    );
    expect(database.rows[0]!.trashed_at).not.toBeNull();
  });

  it('fails with a reason when the base is gone', async () => {
    const missing = await call<{ error: { messageKey: string } }>(
      server,
      'POST',
      '/api/imports/seatable',
      request({ baseId: 'd2b6f8a0-1c3e-4a5b-9d7f-000000000000', name: 'Missing' }),
      404,
    );
    expect(missing.error.messageKey).toBe('import.platform.baseUnavailable');
  });
});

describe('SeaTable columns and filters', () => {
  const context = {
    tables: new Map([['0000', { _id: '0000', name: 'Projects', columns: [], views: [] }]]),
    column: () => undefined,
    linked: () => undefined,
    inverse: () => null,
    people: new Map([['someone@auth.local', 'someone@example.com']]),
    fileUrl: (path: string) => `https://seatable.test${path}`,
    headers: () => ({}),
  };
  const column = (type: string, data?: Record<string, unknown>) => ({
    key: 'Cl01',
    name: 'Column',
    type,
    ...(data ? { data } : {}),
  });

  it('plan each of SeaTable’s column types', () => {
    const plan = (type: string, data?: Record<string, unknown>) =>
      planColumn(column(type, data) as never, context as never);
    expect(plan('long-text')).toMatchObject({
      kind: 'value',
      spec: { type: 'longText', options: { richText: true } },
    });
    expect(plan('number', { format: 'percent' })).toMatchObject({ kind: 'value', spec: { type: 'percent' } });
    expect(plan('number', { format: 'euro' })).toMatchObject({
      kind: 'value',
      spec: { type: 'currency', options: { code: 'EUR' } },
    });
    expect(plan('number', { format: 'custom_currency', currency_symbol: '¤' })).toMatchObject({
      kind: 'value',
      spec: { type: 'number' },
      notes: [{ status: 'changed', key: 'import.platform.report.currencyUnknown' }],
    });
    expect(plan('date', { format: 'YYYY-MM-DD HH:mm' })).toMatchObject({
      kind: 'value',
      spec: { type: 'date', options: { includeTime: true, dateFormat: 'iso', timeFormat: '24h' } },
    });
    expect(plan('duration', { duration_format: 'h:mm:ss' })).toMatchObject({
      kind: 'value',
      spec: { type: 'duration', options: { format: 'h:mm:ss' } },
    });
    expect(plan('rate', { rate_max_number: 5, rate_style_type: 'dtable-icon-like' })).toMatchObject({
      kind: 'value',
      spec: { type: 'rating', options: { max: 5, icon: 'thumbsUp' } },
    });
    // An icon Riosoma doesn't have rates with stars here, and the report says so.
    expect(plan('rate', { rate_max_number: 5, rate_style_type: 'dtable-icon-smiley' })).toMatchObject({
      kind: 'value',
      spec: { type: 'rating', options: { icon: 'star' } },
      notes: [{ status: 'changed', key: 'import.platform.report.ratingIcon' }],
    });
    // The type very old tables still carry holds text.
    expect(plan('default')).toMatchObject({ kind: 'value', spec: { type: 'text' } });
    expect(plan('geolocation', { geo_format: 'country_region' })).toMatchObject({
      kind: 'value',
      spec: { type: 'text' },
      notes: [{ status: 'changed', key: 'import.platform.report.placeText' }],
    });
    expect(plan('auto-number', { prefix_type: 'string', prefix: 'ID-' })).toMatchObject({
      kind: 'value',
      spec: { type: 'text' },
      notes: [{ status: 'changed', key: 'import.platform.report.autoNumberText' }],
    });
    expect(plan('auto-number', { format: '0000' })).toMatchObject({
      kind: 'value',
      spec: { type: 'number' },
      finish: { kind: 'autoNumber' },
    });
    expect(plan('digital-sign')).toMatchObject({
      kind: 'omitted',
      notes: [{ status: 'omitted', key: 'import.platform.report.signatureLeft' }],
    });
    expect(plan('button')).toMatchObject({ kind: 'omitted' });
    expect(plan('department-single-select')).toMatchObject({
      kind: 'value',
      spec: { type: 'text' },
      notes: [{ status: 'changed', key: 'import.platform.report.departmentText' }],
    });
    expect(plan('something-new')).toMatchObject({
      kind: 'omitted',
      notes: [{ status: 'omitted', key: 'import.platform.report.typeUnsupported' }],
    });
    // A link to a table that isn't in the base has nothing here to link to.
    expect(plan('link', { other_table_id: 'zz99', link_id: 'lk01' })).toMatchObject({ kind: 'omitted' });
  });

  it('read a filter as the closest condition here', () => {
    const condition = (predicate: string, term: unknown, type: string, modifier?: string) =>
      conditionOf(
        {
          column_key: 'Cl01',
          filter_predicate: predicate,
          filter_term: term,
          ...(modifier ? { filter_term_modifier: modifier } : {}),
        } as never,
        column(type) as never,
      );
    expect(condition('contains', 'web', 'text')).toEqual({
      field: 'Cl01',
      operator: 'contains',
      value: { kind: 'text', text: 'web' },
    });
    expect(condition('does not contain', 'web', 'formula')).toMatchObject({ operator: 'doesNotContain' });
    expect(condition('contains', 'Ada', 'creator')).toMatchObject({
      operator: 'contains',
      value: { kind: 'text', text: 'Ada' },
    });
    expect(condition('greater_or_equal', '50', 'number')).toMatchObject({
      operator: 'gte',
      value: { kind: 'number', number: 50 },
    });
    expect(condition('is', 'true', 'checkbox')).toMatchObject({
      operator: 'is',
      value: { kind: 'boolean', value: true },
    });
    expect(condition('is', 'Doing', 'single-select')).toMatchObject({
      operator: 'is',
      value: { kind: 'choices', names: ['Doing'] },
    });
    expect(condition('has_any_of', ['Web', 'Mobile'], 'multiple-select')).toMatchObject({
      operator: 'hasAnyOf',
      value: { kind: 'choices', names: ['Web', 'Mobile'] },
    });
    expect(condition('is', '', 'date', 'today')).toMatchObject({
      operator: 'is',
      value: { kind: 'date', target: { mode: 'today' } },
    });
    expect(condition('is_on_or_after', '2026-01-10', 'date', 'exact_date')).toMatchObject({
      operator: 'isOnOrAfter',
      value: { kind: 'date', target: { mode: 'exactDate', date: '2026-01-10' } },
    });
    expect(condition('is_within', '', 'date', 'the_past_month')).toMatchObject({
      operator: 'isWithin',
      value: { kind: 'range', range: { mode: 'pastMonth' } },
    });
    expect(condition('is_within', '14', 'date', 'the_next_numbers_of_days')).toMatchObject({
      operator: 'isWithin',
      value: { kind: 'range', range: { mode: 'nextDays', days: 14 } },
    });
    expect(condition('is_empty', '', 'image')).toMatchObject({ operator: 'isEmpty' });
  });

  it('leave out what has no match here', () => {
    const condition = (predicate: string, term: unknown, type: string, modifier?: string) =>
      conditionOf(
        {
          column_key: 'Cl01',
          filter_predicate: predicate,
          filter_term: term,
          ...(modifier ? { filter_term_modifier: modifier } : {}),
        } as never,
        column(type) as never,
      );
    // A collaborator's ID here is nobody's ID in SeaTable.
    expect(condition('include_me', '', 'collaborator')).toBeNull();
    expect(condition('is_within', '', 'date', 'this_week')).toBeNull();
    expect(condition('is_current_user_ID', '', 'text')).toBeNull();
  });

  it('read a view as the closest one here', () => {
    const columns = new Map(
      [
        { key: 'Cl01', name: 'Column', type: 'text' },
        { key: 'Cl02', name: 'Hidden', type: 'text' },
        { key: 'Cl03', name: 'Status', type: 'single-select' },
      ].map((item) => [item.key, item as never]),
    );
    const made = viewOf(
      {
        _id: 'Vw01',
        name: 'Doing',
        type: 'table',
        filter_conjunction: 'Or',
        filters: [{ column_key: 'Cl03', filter_predicate: 'is', filter_term: 'Doing' }],
        sorts: [{ column_key: 'Cl01', sort_type: 'down' }],
        groupbys: [{ column_key: 'Cl03', sort_type: 'up' }],
        hidden_columns: ['Cl02'],
        colors: { Vw01: [{ column: 'Cl01', color: '#C2E9C0' }] },
      } as never,
      columns,
    );
    expect(made).toMatchObject({
      name: 'Doing',
      type: 'table',
      kind: 'grid',
      shown: ['Cl01', 'Cl03'],
      group: 'Cl03',
      sorts: [{ field: 'Cl01', direction: 'desc' }],
      filter: {
        conjunction: 'or',
        conditions: [{ field: 'Cl03', operator: 'is', value: { kind: 'choices', names: ['Doing'] } }],
      },
      // What the view builder adds a line for once it knows the grid can't group.
      notes: [{ status: 'omitted', key: 'import.platform.report.viewColors' }],
    });
    // SeaTable's boards, calendars, and galleries are apps of their own, not views.
    expect(viewOf({ _id: 'Vw02', name: 'Board', type: 'kanban' } as never, columns)).toMatchObject({
      kind: null,
      type: 'kanban',
    });
  });
});
