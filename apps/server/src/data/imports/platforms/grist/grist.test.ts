import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type * as Logger from '../../../../logger.js';
import { startServer, type ServerFixture } from '../../../../test/fixture.js';
import { startReplay, type Recording, type Replay } from '../../../../test/platform-replay.js';
import { checkGristImport, GRIST_RECORDING } from '../../../../test/platforms/grist-checks.js';
import {
  call,
  importBase,
  listBases,
  sealedToken,
  tablesHolding,
} from '../../../../test/platforms/harness.js';
import type { Clock } from '../../core/clock.js';
import { lookedUp, translateGrist } from './formulas.js';
import { gristCondition } from './reader.js';

/**
 * Imports from a recording of a real Grist, made by the live suite, and Grist's formulas and filters
 * on their own.
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

const KEY = 'test-grist-key-not-a-secret-0001';

describe('importing a Grist document', () => {
  let kit: TestPostgres;
  let server: ServerFixture;
  let replay: Replay;
  let docId: string;
  const time = { now: 0 };
  const clock: Clock = {
    now: () => time.now,
    sleep: async (ms) => {
      time.now += ms;
    },
  };

  beforeAll(async () => {
    kit = await startTestPostgres();
    server = await startServer(kit, 'grist', { logLevel: 'trace' });
    const recording = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../../../test/platforms', GRIST_RECORDING), 'utf8'),
    ) as Recording;
    const workspaces = recording.answers.find((answer) => /^\/api\/orgs\/\d+\/workspaces/.test(answer.path))!;
    docId = (JSON.parse(workspaces.body) as Array<{ docs: Array<{ id: string }> }>).flatMap(
      (ws) => ws.docs,
    )[0]!.id;
    replay = await startReplay(recording, (headers) => headers.authorization === `Bearer ${KEY}`);
    const importer = server.ctx.platformImports!;
    importer.clock = clock;
    importer.allowPrivate = (url) => url.hostname === '127.0.0.1' && url.port === String(replay.port);
  }, 60_000);
  afterAll(async () => {
    await server?.close();
    await replay?.close();
    await kit?.stop();
  });

  it('lists the documents the key can see, and says when Grist refuses it', async () => {
    const bases = await listBases(server, 'grist', { address: replay.url, token: KEY });
    expect(bases.map((base) => base.id)).toEqual([docId]);
    expect(bases[0]!.group).toBe('Home');
    const refused = await call<{ error: { messageKey: string } }>(
      server,
      'POST',
      '/api/imports/grist/bases',
      { address: replay.url, token: 'not-the-key' },
      422,
    );
    expect(refused.error.messageKey).toBe('import.platform.tokenInvalid');
  });

  it('brings every table, column, record, reference, file, and widget across, as Grist had them', async () => {
    replay.requests.length = 0;
    const imported = await importBase(server, 'grist', { address: replay.url, token: KEY, baseId: docId });
    await checkGristImport(imported);
    // Files come from Grist's own API, with the key, since Grist serves them only to people who can read the document.
    const files = replay.requests.filter((entry) => entry.path.includes('/attachments/'));
    expect(files).toHaveLength(1);
    expect(files[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    // Records come a page at a time, in the order Grist keeps them.
    expect(replay.requests.some((entry) => entry.path.includes('/sql?'))).toBe(true);
    expect(await sealedToken(server, imported.job.id)).toBeNull();
    expect(await tablesHolding(server, KEY)).toEqual([]);
    expect(logs.lines.filter((line) => line.includes(KEY))).toEqual([]);
  });
});

describe('Grist formulas', () => {
  const kinds = (column: string) =>
    ({ Name: 'text', Price: 'number', Quantity: 'number', Active: 'boolean', Due: 'date', Tags: 'unknown' })[
      column
    ] as 'text' | 'number' | 'boolean' | 'date' | 'unknown' | undefined;
  const translated = (formula: string) => translateGrist(formula, kinds);

  it('translate when they are one expression over the record’s own columns', () => {
    expect(translated('$Price * $Quantity').expression).toBe('({Price} * {Quantity})');
    expect(translated('$Name + " x" + str($Quantity)').expression).toBe(
      '(({Name} & " x") & ({Quantity} & ""))',
    );
    expect(translated('UPPER($Name) if $Active else "no"').expression).toBe(
      'IF({Active}, UPPER({Name}), "no")',
    );
    expect(translated('round($Price / 3, 2)').expression).toBe('ROUND(({Price} / 3), 2)');
    expect(translated('rec.Price ** 2 % 7').expression).toBe('MOD(POWER({Price}, 2), 7)');
    expect(translated('$Price >= 10 and not $Active').expression).toBe('AND(({Price} >= 10), NOT({Active}))');
    expect(translated('$Due.year').expression).toBe('YEAR({Due})');
    expect(translated('return $Name.strip()').expression).toBe('TRIM({Name})');
    expect(translated('None').expression).toBe('BLANK()');
  });

  it('keep their values when they don’t, saying why', () => {
    expect(translated('x = $Price\nreturn x')).toMatchObject({ expression: null, problem: 'syntax' });
    expect(translated('[t for t in $Tags]')).toMatchObject({ expression: null, problem: 'syntax' });
    expect(translated('DATEADD($Due, days=3)')).toMatchObject({ expression: null, problem: 'syntax' });
    expect(translated('$id * 2')).toMatchObject({ expression: null, problem: 'syntax' });
    expect(translated('$Missing + 1')).toMatchObject({ expression: null, problem: 'syntax' });
    expect(translated('PROPER($Name)')).toEqual({
      expression: null,
      problem: 'functions',
      functions: ['PROPER'],
    });
    expect(translated('$Name.title()')).toEqual({
      expression: null,
      problem: 'functions',
      functions: ['title'],
    });
    expect(translated('f"{$Name}"')).toMatchObject({ expression: null, problem: 'syntax' });
    expect(translated('1 < $Price < 3')).toMatchObject({ expression: null, problem: 'syntax' });
  });

  it('that look records up become rollups, counts, and lookups', () => {
    expect(lookedUp('SUM(Tasks.lookupRecords(Project=$id).Hours)')).toEqual({
      kind: 'rollup',
      table: 'Tasks',
      field: 'Project',
      target: 'Hours',
      fn: 'sum',
    });
    expect(lookedUp('len(Tasks.lookupRecords(Project=$id))')).toEqual({
      kind: 'count',
      table: 'Tasks',
      field: 'Project',
    });
    expect(lookedUp('Tasks.lookupRecords(Project=$id).Name')).toEqual({
      kind: 'lookup',
      table: 'Tasks',
      field: 'Project',
      target: 'Name',
    });
    expect(lookedUp('SUM(Tasks.lookupRecords(Project=$id, Done=True).Hours)')).toBeNull();
    expect(lookedUp('STDEV(Tasks.lookupRecords(Project=$id).Hours)')).toBeNull();
  });
});

describe('Grist filters', () => {
  const column = (type: string) => ({ id: 'Col', fields: { type } });

  it('read as conditions here', () => {
    expect(gristCondition('{"included": ["Doing", "Done"]}', column('Choice'))).toEqual({
      field: 'Col',
      operator: 'isAnyOf',
      value: { kind: 'choices', names: ['Doing', 'Done'] },
    });
    expect(gristCondition('{"excluded": [false]}', column('Bool'))).toMatchObject({
      operator: 'is',
      value: { kind: 'boolean', value: true },
    });
    expect(gristCondition('{"min": 3, "max": 9}', column('Numeric'))).toEqual({
      conjunction: 'and',
      conditions: [
        { field: 'Col', operator: 'gte', value: { kind: 'number', number: 3 } },
        { field: 'Col', operator: 'lte', value: { kind: 'number', number: 9 } },
      ],
    });
    expect(gristCondition('{"included": ["a", "b"]}', column('Text'))).toMatchObject({
      conjunction: 'or',
      conditions: [{ operator: 'is' }, { operator: 'is' }],
    });
    expect(gristCondition('{"min": 1767571200}', column('Date'))).toMatchObject({
      operator: 'isOnOrAfter',
      value: { kind: 'date', target: { mode: 'exactDate', date: '2026-01-05' } },
    });
    expect(gristCondition('{"excluded": []}', column('Text'))).toEqual({
      conjunction: 'and',
      conditions: [],
    });
  });

  it('leave out what has no match here', () => {
    expect(gristCondition('{"included": [null, "a"]}', column('Text'))).toBeNull();
    expect(gristCondition('{"min": {"type": "relative", "offset": -7}}', column('Date'))).toBeNull();
    expect(gristCondition('{"included": [1]}', column('Any'))).toBeNull();
  });
});
