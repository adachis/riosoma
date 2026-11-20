import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type * as Logger from '../../../../logger.js';
import { startServer, type ServerFixture } from '../../../../test/fixture.js';
import { startReplay, type Recording, type Replay } from '../../../../test/platform-replay.js';
import {
  BASEROW_RECORDING,
  checkBaserowImport,
  RECORDED_TOKENS,
} from '../../../../test/platforms/baserow-checks.js';
import { importBase, listBases, sealedToken, tablesHolding } from '../../../../test/platforms/harness.js';
import type { Clock } from '../../core/clock.js';
import { baserowCondition, baserowFormula } from './reader.js';

/**
 * Imports from a recording of a real Baserow, made by the live suite, with a database token and by
 * signing in, and Baserow's formulas and filters on their own.
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

const PASSWORD = 'test-baserow-password-not-a-secret';

describe('importing a Baserow database', () => {
  let kit: TestPostgres;
  let server: ServerFixture;
  let replay: Replay;
  let databaseId: string;
  const time = { now: 0 };
  const clock: Clock = {
    now: () => time.now,
    sleep: async (ms) => {
      time.now += ms;
    },
  };

  beforeAll(async () => {
    kit = await startTestPostgres();
    server = await startServer(kit, 'baserow', { logLevel: 'trace' });
    const recording = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../../../test/platforms', BASEROW_RECORDING), 'utf8'),
    ) as Recording;
    const tables = recording.answers.find((answer) =>
      answer.path.startsWith('/api/database/tables/all-tables/'),
    )!;
    databaseId = String((JSON.parse(tables.body) as Array<{ database_id: number }>)[0]!.database_id);
    // Baserow answers signing in and refreshing to anyone, serves files to anyone, and the rest only
    // with the database token or the access token it handed out.
    replay = await startReplay(
      recording,
      (headers, path) =>
        path.startsWith('/api/user/token-') ||
        path.startsWith('/media/') ||
        headers.authorization === `Token ${RECORDED_TOKENS.database}` ||
        headers.authorization === `JWT ${RECORDED_TOKENS.access}`,
    );
    const importer = server.ctx.platformImports!;
    importer.clock = clock;
    importer.allowPrivate = (url) => url.hostname === '127.0.0.1' && url.port === String(replay.port);
  }, 60_000);
  afterAll(async () => {
    await server?.close();
    await replay?.close();
    await kit?.stop();
  });

  it('with a database token, brings everything but views across', async () => {
    const bases = await listBases(server, 'baserow', {
      address: replay.url,
      token: RECORDED_TOKENS.database,
    });
    // A database token doesn't see databases' names, so each is named for its tables.
    expect(bases).toEqual([{ id: databaseId, name: 'People, Projects, Tasks', group: null }]);
    const imported = await importBase(server, 'baserow', {
      address: replay.url,
      token: RECORDED_TOKENS.database,
      baseId: databaseId,
      name: 'From Baserow',
    });
    await checkBaserowImport(imported, false);
    expect(replay.requests.some((entry) => entry.path.startsWith('/api/database/views/'))).toBe(false);
  });

  it('signing in, brings views across too, and keeps only the refresh token while it runs', async () => {
    replay.requests.length = 0;
    const bases = await listBases(server, 'baserow', {
      address: replay.url,
      email: 'owner@example.com',
      password: PASSWORD,
    });
    expect(bases.map((base) => base.id)).toEqual([databaseId]);
    expect(bases[0]!.group).not.toBeNull();
    const imported = await importBase(server, 'baserow', {
      address: replay.url,
      email: 'owner@example.com',
      password: PASSWORD,
      baseId: databaseId,
    });
    await checkBaserowImport(imported, true);
    // The password went to Baserow to sign in, and nowhere else.
    const signIns = replay.requests.filter((entry) => entry.path === '/api/user/token-auth/');
    expect(signIns.length).toBeGreaterThan(0);
    expect(replay.requests.filter((entry) => entry.body.includes(PASSWORD))).toEqual(signIns);
    // The import itself started from the refresh token.
    expect(replay.requests.some((entry) => entry.path === '/api/user/token-refresh/')).toBe(true);
    expect(await sealedToken(server, imported.job.id)).toBeNull();
    for (const secret of [
      PASSWORD,
      RECORDED_TOKENS.refresh,
      RECORDED_TOKENS.access,
      RECORDED_TOKENS.database,
    ]) {
      expect(await tablesHolding(server, secret)).toEqual([]);
      expect(logs.lines.filter((line) => line.includes(secret))).toEqual([]);
    }
  });
});

describe('Baserow formulas', () => {
  it('translate when they name fields and functions Riosoma has', () => {
    expect(baserowFormula("field('Price') * field('Quantity')")).toEqual({
      written: { expression: '({Price} * {Quantity})', functions: [] },
    });
    expect(baserowFormula("concat(field('First'), ' ', field(\"Last\"))")).toEqual({
      written: { expression: 'CONCATENATE({First}, " ", {Last})', functions: [] },
    });
    expect(baserowFormula("date_diff('dd', field('A'), field('B'))")).toEqual({
      written: { expression: null, problem: 'functions', functions: ['DATE_DIFF'] },
    });
  });

  it('that read linked records become rollups, counts, and lookups', () => {
    expect(baserowFormula("sum(lookup('Tasks', 'Hours'))")).toEqual({
      kind: 'rollup',
      link: 'Tasks',
      target: 'Hours',
      fn: 'sum',
      shown: "sum(lookup('Tasks', 'Hours'))",
    });
    expect(baserowFormula("count(field('Tasks'))")).toMatchObject({ kind: 'count', link: 'Tasks' });
    expect(baserowFormula("lookup('Tasks', 'Name')")).toMatchObject({
      kind: 'lookup',
      link: 'Tasks',
      target: 'Name',
    });
  });
});

describe('Baserow filters', () => {
  const field = (type: string, extra: Record<string, unknown> = {}) => ({
    id: 7,
    name: 'Field',
    type,
    ...extra,
  });
  const select = field('single_select', {
    select_options: [
      { id: 1, value: 'Todo' },
      { id: 2, value: 'Doing' },
    ],
  });

  it('read as conditions here', () => {
    expect(baserowCondition({ field: 7, type: 'single_select_is_any_of', value: '1,2' }, select)).toEqual({
      field: '7',
      operator: 'isAnyOf',
      value: { kind: 'choices', names: ['Todo', 'Doing'] },
    });
    expect(baserowCondition({ field: 7, type: 'higher_than', value: '4' }, field('number'))).toMatchObject({
      operator: 'gt',
      value: { kind: 'number', number: 4 },
    });
    expect(baserowCondition({ field: 7, type: 'equal', value: 'a' }, field('text'))).toMatchObject({
      operator: 'is',
    });
    expect(
      baserowCondition({ field: 7, type: 'date_is', value: 'UTC?3?nr_days_ago' }, field('date')),
    ).toMatchObject({
      operator: 'is',
      value: { kind: 'date', target: { mode: 'daysAgo', days: 3 } },
    });
    expect(
      baserowCondition({ field: 7, type: 'link_row_has', value: '12' }, field('link_row')),
    ).toMatchObject({
      operator: 'hasAnyOf',
      value: { kind: 'records', ids: ['12'] },
    });
    expect(baserowCondition({ field: 7, type: 'boolean', value: '1' }, field('boolean'))).toMatchObject({
      value: { kind: 'boolean', value: true },
    });
  });

  it('leave out what has no match here', () => {
    expect(
      baserowCondition({ field: 7, type: 'length_is_lower_than', value: '3' }, field('text')),
    ).toBeNull();
    expect(baserowCondition({ field: 7, type: 'single_select_equal', value: '99' }, select)).toBeNull();
    expect(
      baserowCondition({ field: 7, type: 'date_is', value: 'UTC??this_week' }, field('date')),
    ).toBeNull();
  });
});
