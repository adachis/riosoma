import { join } from 'node:path';
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
import { checkTeableImport, TEABLE_RECORDING } from '../../../../test/platforms/teable-checks.js';
import type { Clock } from '../../core/clock.js';
import type { PlatformImporter } from '../importer.js';
import { conditionOf, filterOf, planField } from './reader.js';

/**
 * Imports from a recording of a real Teable, in the shape its API documents, so everything Teable
 * sends is exactly what it sends.  Every line the server logs is kept, to show the token never
 * reaches them.
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

const TOKEN = 'teable_pat_test_token_not_a_secret_01';
const RECORDING = join(import.meta.dirname, '../../../../test/platforms', TEABLE_RECORDING);

let kit: TestPostgres;
let server: ServerFixture;
let replay: Replay;
let importer: PlatformImporter;
let baseId: string;
/** The first table's records, which the import fetches once the database and its tables exist */
let recordsPath: string;
const time = { now: 0 };
const clock: Clock = {
  now: () => time.now,
  sleep: async (ms) => {
    time.now += ms;
  },
};

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'teable', { logLevel: 'trace' });
  const { readFileSync } = await import('node:fs');
  const recording = JSON.parse(readFileSync(RECORDING, 'utf8')) as Recording;
  const listing = recording.answers.find((answer) => answer.path === '/api/base/access/all')!;
  baseId = (JSON.parse(listing.body) as Array<{ id: string }>)[0]!.id;
  recordsPath = recording.answers.find((answer) => answer.path.includes('/record?'))!.path.split('?')[0]!;
  // Teable signs an address for each file it serves from a bucket, and serves the rest itself.
  replay = await startReplay(
    recording,
    (headers, path) => path.startsWith('/files/') || headers.authorization === `Bearer ${TOKEN}`,
  );
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

describe('listing Teable bases', () => {
  it('lists what the token can see, and says when Teable refuses it', async () => {
    const bases = await listBases(server, 'teable', request());
    expect(bases.map((base) => base.id)).toEqual([baseId]);
    const refused = await call<{ error: { messageKey: string; fields: Record<string, string> } }>(
      server,
      'POST',
      '/api/imports/teable/bases',
      request({ token: 'not-the-token' }),
      422,
    );
    expect(refused.error).toMatchObject({
      messageKey: 'import.platform.tokenInvalid',
      fields: { token: 'import.platform.tokenInvalid' },
    });
  });

  it('lists the bases of each space when the token can’t list them all', async () => {
    // A token scoped to some bases is refused the list of every one, and falls back to the spaces.
    replay.throttle('/api/base/access/all', 6);
    const bases = await listBases(server, 'teable', request());
    expect(bases.map((base) => `${base.name} in ${base.group}`)).toEqual(['Launch plan in Marketing']);
  });

  it('keeps to the private-network rule, and to https elsewhere', async () => {
    const blocked = await call<{ error: { messageKey: string } }>(
      server,
      'POST',
      '/api/imports/teable/bases',
      request({ address: 'http://10.0.0.7:3000' }),
      422,
    );
    expect(blocked.error.messageKey).toBe('import.platform.https');
    const privateHost = await call<{ error: { messageKey: string } }>(
      server,
      'POST',
      '/api/imports/teable/bases',
      request({ address: 'https://10.0.0.7' }),
      422,
    );
    expect(privateHost.error.messageKey).toBe('import.platform.private');
    // A password signs in to Baserow only.
    await call(
      server,
      'POST',
      '/api/imports/teable/bases',
      { address: replay.url, email: 'someone@example.com', password: 'a password' },
      422,
    );
  });
});

describe('importing a Teable base', () => {
  it('brings every table, field, record, link, file, and view across, as Teable had them', async () => {
    replay.requests.length = 0;
    const imported = await importBase(server, 'teable', request({ baseId, name: 'From Teable' }));
    expect(imported.schema.database.name).toBe('From Teable');
    expect(imported.job).toMatchObject({ platform: 'teable', address: replay.url, baseId });
    await checkTeableImport(imported);
    // Both files were fetched: one from the address Teable signed, one from its own route.
    expect(replay.requests.filter((entry) => entry.path.startsWith('/files/'))).toHaveLength(1);
    expect(replay.requests.filter((entry) => entry.path.startsWith('/api/attachments/read/'))).toHaveLength(
      1,
    );
  });

  it('never keeps or logs the token, and sends it only in its header', async () => {
    const recent = await call<{ imports: PlatformImport[] }>(server, 'GET', '/api/imports/teable');
    const done = recent.imports.find((entry) => entry.state === 'finished')!;
    expect(await sealedToken(server, done.id)).toBeNull();
    expect(await tablesHolding(server, TOKEN)).toEqual([]);
    expect(logs.lines.length).toBeGreaterThan(10);
    expect(logs.lines.filter((line) => line.includes(TOKEN))).toEqual([]);
    expect(replay.requests.every((entry) => !entry.path.includes(TOKEN))).toBe(true);
  });

  it('keeps the report with the database, for anyone who can read it', async () => {
    const recent = await call<{ imports: PlatformImport[] }>(server, 'GET', '/api/imports/teable');
    const done = recent.imports.find((entry) => entry.state === 'finished')!;
    const kept = await call<{ imports: PlatformImport[] }>(
      server,
      'GET',
      `/api/databases/${done.databaseId}/imports/teable`,
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
      url: `/api/databases/${done.databaseId}/imports/teable`,
      headers: stranger.headers,
    });
    expect(hidden.statusCode).toBe(404);
  });
});

describe('running Teable imports', () => {
  it('waits out 429 answers for the whole tool', async () => {
    replay.throttle('/api/table/', 2, 10);
    const before = time.now;
    const started = await startImport(server, 'teable', request({ baseId, name: 'Throttled' }));
    const job = await finished(server, 'teable', started.id);
    expect(job.state, JSON.stringify(job.error)).toBe('finished');
    expect(time.now - before).toBeGreaterThanOrEqual(20_000);
  });

  it('stops when asked, puts what it made in the trash, and forgets the token', async () => {
    const held = replay.hold(recordsPath);
    const started = await startImport(server, 'teable', request({ baseId, name: 'Stopped' }));
    await held.reached;
    const busy = await call<{ error: { messageKey: string } }>(
      server,
      'POST',
      '/api/imports/teable',
      request({ baseId, name: 'Second' }),
      409,
    );
    expect(busy.error.messageKey).toBe('import.platform.busy');
    const canceled = await call<PlatformImport>(server, 'POST', `/api/imports/teable/${started.id}/cancel`);
    expect(['running', 'canceled']).toContain(canceled.state);
    held.release();
    const ended = await finished(server, 'teable', started.id);
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
      '/api/imports/teable',
      request({ baseId: 'bsenothinghere0001', name: 'Missing' }),
      404,
    );
    expect(missing.error.messageKey).toBe('import.platform.baseUnavailable');
  });
});

describe('Teable fields and filters', () => {
  const context = {
    tables: new Set(['tblOther00000000001']),
    address: 'https://teable.test',
    headers: () => ({}),
  };
  const field = (
    type: string,
    options: Record<string, unknown> = {},
    extra: Record<string, unknown> = {},
  ) => ({
    id: 'fldField0000000001',
    name: 'Field',
    type,
    options,
    ...extra,
  });

  it('plan each of Teable’s field types', () => {
    const plans = (type: string, options?: Record<string, unknown>, extra?: Record<string, unknown>) =>
      planField(field(type, options, extra) as never, context);
    expect(plans('singleLineText', { showAs: { type: 'url' } })).toMatchObject({
      kind: 'value',
      spec: { type: 'url' },
    });
    expect(plans('longText', { showAs: { type: 'markdown' } })).toMatchObject({
      kind: 'value',
      spec: { type: 'longText', options: { richText: true } },
    });
    expect(plans('number', { formatting: { type: 'percent', precision: 1 } })).toMatchObject({
      kind: 'value',
      spec: { type: 'percent', options: { precision: 1 } },
    });
    expect(plans('number', { formatting: { type: 'currency', precision: 2, symbol: '€' } })).toMatchObject({
      kind: 'value',
      spec: { type: 'currency', options: { code: 'EUR', precision: 2 } },
    });
    expect(
      plans('date', { formatting: { date: 'M/D/YYYY', time: 'hh:mm A', timeZone: 'UTC' } }),
    ).toMatchObject({
      kind: 'value',
      spec: {
        type: 'date',
        options: { includeTime: true, dateFormat: 'us', timeFormat: '12h', timeZone: 'UTC' },
      },
    });
    expect(plans('rating', { icon: 'flame', color: 'redBright', max: 5 })).toMatchObject({
      kind: 'value',
      notes: [{ status: 'changed', key: 'import.platform.report.ratingIcon' }],
    });
    expect(
      plans('number', { formatting: { type: 'decimal', precision: 0 }, showAs: { type: 'bar' } }),
    ).toMatchObject({
      kind: 'value',
      notes: [{ status: 'changed', key: 'import.platform.report.numberShowAs' }],
    });
    expect(plans('button')).toMatchObject({
      kind: 'omitted',
      notes: [{ status: 'omitted', key: 'import.platform.report.button' }],
    });
    // A link to a table in another base has nothing here to link to.
    expect(plans('link', { foreignTableId: 'tblElsewhere000001', relationship: 'manyMany' })).toMatchObject({
      kind: 'omitted',
    });
    expect(plans('link', { foreignTableId: 'tblOther00000000001', relationship: 'manyOne' })).toMatchObject({
      kind: 'link',
      prefersSingle: true,
    });
    // A field Teable filled in by generating it keeps the values and leaves the generation there.
    expect(plans('longText', {}, { aiConfig: { type: 'generateText' } })).toMatchObject({
      kind: 'value',
      notes: [{ status: 'changed', key: 'import.platform.report.aiGenerated' }],
    });
    // A rollup that reads only the records its filter picks has no match here.
    expect(
      plans(
        'conditionalRollup',
        { expression: 'sum({values})' },
        {
          cellValueType: 'number',
          lookupOptions: { linkFieldId: 'fldLink0000000001', lookupFieldId: 'fldTarget0000001' },
        },
      ),
    ).toMatchObject({
      kind: 'value',
      spec: { type: 'number' },
      notes: [{ status: 'changed', key: 'import.platform.report.conditionalRead' }],
    });
    // A formula Teable itself reports as broken keeps its values, and the report says why.
    const broken = plans('formula', { expression: '{fldGone0000000001} + 1' }, { hasError: true });
    expect(broken.kind === 'value' && broken.finish).toMatchObject({ kind: 'formula', problem: 'invalid' });
    // A lookup with a filter of its own still becomes a lookup, and says the filter stayed behind.
    expect(
      plans(
        'singleLineText',
        {},
        {
          isLookup: true,
          isConditionalLookup: true,
          lookupOptions: { linkFieldId: 'fldLink0000000001', lookupFieldId: 'fldTarget0000001' },
        },
      ),
    ).toMatchObject({
      kind: 'value',
      finish: { kind: 'lookup', link: 'fldLink0000000001', target: 'fldTarget0000001' },
      notes: [{ status: 'changed', key: 'import.platform.report.conditionalRead' }],
    });
    // A rollup whose function has no match here keeps its values and names the function.
    expect(
      plans(
        'rollup',
        { expression: 'xor({values})' },
        {
          cellValueType: 'boolean',
          lookupOptions: { linkFieldId: 'fldLink0000000001', lookupFieldId: 'fldTarget0000001' },
        },
      ),
    ).toMatchObject({
      kind: 'value',
      notes: [{ status: 'changed', key: 'import.platform.report.rollupUnknown', params: { fn: 'xor' } }],
    });
  });

  it('read a filter as the closest condition here', () => {
    const condition = (operator: string, value: unknown, type = 'singleLineText') =>
      filterOf(
        { conjunction: 'and', filterSet: [{ fieldId: 'fldField0000000001', operator, value }] },
        new Map([['fldField0000000001', field(type) as never]]),
      );
    expect(condition('contains', 'web').filter).toEqual({
      conjunction: 'and',
      conditions: [
        { field: 'fldField0000000001', operator: 'contains', value: { kind: 'text', text: 'web' } },
      ],
    });
    expect(condition('isGreater', '50', 'number').filter).toMatchObject({
      conditions: [{ operator: 'gt', value: { kind: 'number', number: 50 } }],
    });
    expect(condition('is', true, 'checkbox').filter).toMatchObject({
      conditions: [{ operator: 'is', value: { kind: 'boolean', value: true } }],
    });
    expect(condition('hasAnyOf', ['Web'], 'multipleSelect').filter).toMatchObject({
      conditions: [{ operator: 'hasAnyOf', value: { kind: 'choices', names: ['Web'] } }],
    });
    expect(
      condition('isOnOrAfter', { mode: 'exactDate', exactDate: '2026-01-10T00:00:00.000Z' }, 'date').filter,
    ).toMatchObject({
      conditions: [
        {
          operator: 'isOnOrAfter',
          value: { kind: 'date', target: { mode: 'exactDate', date: '2026-01-10' } },
        },
      ],
    });
    expect(
      condition('isWithIn', { mode: 'pastNumberOfDays', numberOfDays: 14 }, 'date').filter,
    ).toMatchObject({
      conditions: [{ operator: 'isWithin', value: { kind: 'range', range: { mode: 'pastDays', days: 14 } } }],
    });
    expect(condition('isEmpty', null).filter).toMatchObject({
      conditions: [{ operator: 'isEmpty', value: { kind: 'none' } }],
    });
  });

  it('leave out what has no match here', () => {
    const fields = new Map([['fldField0000000001', field('singleSelect') as never]]);
    // A multiple select's "is any of" is Teable's own reading of a single select's operator.
    expect(
      filterOf(
        {
          conjunction: 'and',
          filterSet: [{ fieldId: 'fldField0000000001', operator: 'isAnyOf', value: ['Done'] }],
        },
        new Map([['fldField0000000001', field('multipleSelect') as never]]),
      ),
    ).toEqual({ filter: null, unmatched: 1 });
    expect(
      filterOf(
        {
          conjunction: 'and',
          filterSet: [{ fieldId: 'fldField0000000001', operator: 'isNotExactly', value: ['Done'] }],
        },
        fields,
      ),
    ).toEqual({
      filter: null,
      unmatched: 1,
    });
    expect(
      filterOf(
        {
          conjunction: 'and',
          filterSet: [{ fieldId: 'fldField0000000001', operator: 'is', value: { mode: 'currentWeek' } }],
        },
        new Map([['fldField0000000001', field('date') as never]]),
      ),
    ).toEqual({ filter: null, unmatched: 1 });
    expect(
      conditionOf({ fieldId: 'fldField0000000001', operator: 'is', value: 'x' }, field('user') as never),
    ).toBeNull();
  });
});
