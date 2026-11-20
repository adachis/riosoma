import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PlatformPreview, type PlatformImport } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type * as Logger from '../../../../logger.js';
import { startServer, type ServerFixture } from '../../../../test/fixture.js';
import { startReplay, type Recording, type Replay } from '../../../../test/platform-replay.js';
import {
  call,
  importBase,
  listBases,
  PIXEL,
  sealedToken,
  tablesHolding,
} from '../../../../test/platforms/harness.js';
import type { Clock } from '../../core/clock.js';
import { smartsheetFormula } from './formulas.js';
import { durationSeconds, pathGroup, planColumn } from './reader.js';

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
const TOKEN = randomUUID();
const SHEET = '6100000000000001';
const names = {
  parent: 'Parent row',
  attachments: 'Attachments',
  attachmentName: 'Attachment name',
  attachmentParent: 'Source location',
  predecessorDetails: 'Dependency details',
};
const time = { now: 0 };
const clock: Clock = {
  now: () => time.now,
  sleep: async (ms) => {
    time.now += ms;
  },
};
let kit: TestPostgres;
let server: ServerFixture;
let replay: Replay;
let files: Replay;
let recording: Recording;
const replacements = new Map<Recording['answers'][number], string>();
const request = (baseId = SHEET) => ({ address: replay.url, token: TOKEN, baseId, fieldNames: names });

function reply(path: string, body: unknown) {
  const answer = recording.answers.find((answer) => answer.path === path)!;
  replacements.set(answer, answer.body);
  answer.body = JSON.stringify(body);
}

beforeAll(async () => {
  files = await startReplay(
    {
      answers: [
        {
          method: 'GET',
          path: '/pixel.png',
          status: 200,
          type: 'image/png',
          encoding: 'base64',
          body: PIXEL.toString('base64'),
        },
      ],
    },
    () => true,
  );
  recording = JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures/responses.json'), 'utf8').replaceAll(
      '{{downloadOrigin}}',
      files.url,
    ),
  ) as Recording;
  const fidelity = JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures/value-fidelity.json'), 'utf8'),
  ) as Recording;
  const listing = recording.answers.find((answer) => answer.path === '/sheets?page=2&pageSize=200')!;
  const body = JSON.parse(listing.body) as { data: Array<{ id: number; name: string }> };
  body.data.push({ id: 6100000000000003, name: 'Value fidelity' });
  listing.body = JSON.stringify(body);
  recording.answers.push(...fidelity.answers.filter((answer) => !answer.path.startsWith('/sheets?')));
  replay = await startReplay(recording, (headers) => headers.authorization === `Bearer ${TOKEN}`);
  kit = await startTestPostgres();
  server = await startServer(kit, 'smartsheet', { logLevel: 'trace' });
  server.ctx.platformImports!.clock = clock;
  server.ctx.platformImports!.allowPrivate = (url) =>
    url.hostname === '127.0.0.1' && [replay.port, files.port].includes(Number(url.port));
}, 60_000);
afterEach(() => {
  for (const [answer, body] of replacements) answer.body = body;
  replacements.clear();
  replay.reset();
  files.reset();
});
afterAll(async () => {
  await server?.close();
  await replay?.close();
  await files?.close();
  await kit?.stop();
});

describe('Smartsheet recorded API responses', () => {
  it.each([0, 1])(
    'imports a sheet without attachments when the empty list reports page %i',
    async (pageNumber) => {
      const requestsBefore = replay.requests.length;
      const filesBefore = files.requests.length;
      reply(`/sheets/${SHEET}/attachments?page=1&pageSize=200`, {
        pageNumber,
        pageSize: 100,
        totalPages: 0,
        totalCount: 0,
        data: [],
      });
      const imported = await importBase(server, 'smartsheet', request());
      expect(imported.schema.tables.map((table) => table.name)).toEqual(['Launch plan']);
      expect((await imported.rows('Launch plan')).rows).toHaveLength(202);
      expect((await imported.record('Launch plan', 'Launch')).Attachments).toBeNull();
      expect(imported.job.report!.files).toBe(0);
      expect(files.requests).toHaveLength(filesBefore);
      expect(
        replay.requests.slice(requestsBefore).filter((entry) => entry.path.includes('/attachments')),
      ).toHaveLength(1);
    },
  );

  it.each([0, 1])('lists no sheets when the empty list reports page %i', async (pageNumber) => {
    const requestsBefore = replay.requests.length;
    reply('/sheets?page=1&pageSize=200', {
      pageNumber,
      pageSize: 100,
      totalPages: 0,
      totalCount: 0,
      data: [],
    });
    expect(await listBases(server, 'smartsheet', { address: replay.url, token: TOKEN })).toEqual([]);
    expect(replay.requests.slice(requestsBefore)).toHaveLength(1);
  });

  it.each([0, 2])('refuses a non-empty attachment list reporting the wrong page %i', async (pageNumber) => {
    const path = `/sheets/${SHEET}/attachments?page=1&pageSize=200`;
    const body = JSON.parse(recording.answers.find((answer) => answer.path === path)!.body) as object;
    reply(path, { ...body, pageNumber });
    const answer = await call<{ error: { messageKey: string } }>(
      server,
      'POST',
      '/api/imports/smartsheet/preview',
      request(),
      503,
    );
    expect(answer.error.messageKey).toBe('import.platform.unreadable');
  });

  it.each([
    { pageNumber: 0, totalPages: 1 },
    { pageNumber: 1, totalPages: 2 },
  ])('refuses an inconsistent empty page with metadata %j', async (metadata) => {
    reply(`/sheets/${SHEET}/attachments?page=1&pageSize=200`, { ...metadata, data: [] });
    const answer = await call<{ error: { messageKey: string } }>(
      server,
      'POST',
      '/api/imports/smartsheet/preview',
      request(),
      503,
    );
    expect(answer.error.messageKey).toBe('import.platform.unreadable');
  });

  it('preserves numeric and observed dropdown choices across pages and keeps unsupported values as text', async () => {
    const imported = await importBase(server, 'smartsheet', request('6100000000000003'));
    const first = await imported.record('Value fidelity', 'First');
    const second = await imported.record('Value fidelity', 'Second');
    const empty = await imported.record('Value fidelity', 'Empty');
    const labels = (field: string, value: unknown) => {
      const meta = imported.field('Value fidelity', field);
      if (meta.type !== 'singleSelect' && meta.type !== 'multipleSelect') throw new Error('Expected choices');
      return (Array.isArray(value) ? value : [value]).map(
        (id) => meta.options.choices.find((choice) => choice.id === id)?.name,
      );
    };
    expect(labels('Numeric choice', first['Numeric choice'])).toEqual(['42']);
    expect(labels('Numeric choice', second['Numeric choice'])).toEqual(['7']);
    expect(labels('Status', second.Status)).toEqual(['Unlisted']);
    expect(labels('Tags', second.Tags)).toEqual(['Web', 'Unlisted']);
    expect(first['Loose choice']).toBe('false');
    expect(second['Loose choice']).toBe('Planned');
    expect(first['Loose tags']).toBe('Web');
    expect(second['Loose tags']).toBe('Free-form tags');
    expect(empty['Numeric choice']).toBeNull();
    expect(empty.Tags).toBeNull();
    imported.item('Value fidelity', 'Loose choice', 'import.platform.report.selectText');
    imported.item('Value fidelity', 'Loose tags', 'import.platform.report.selectText');
  });

  it('keeps offset-free project datetimes as text and converts only explicit instants', async () => {
    const imported = await importBase(server, 'smartsheet', request('6100000000000003'));
    expect(imported.field('Value fidelity', 'Local start').type).toBe('text');
    expect(imported.field('Value fidelity', 'Zoned start').type).toBe('date');
    const first = await imported.record('Value fidelity', 'First');
    const second = await imported.record('Value fidelity', 'Second');
    expect(first['Local start']).toBe('2025-03-03T16:59:59');
    expect(second['Local start']).toBe('2025-03-03T16:59:59Z');
    expect(first['Zoned start']).toBe('2025-03-04T00:59:59.000Z');
    expect(second['Zoned start']).toBe('2025-03-03T16:59:59.000Z');
    imported.item('Value fidelity', 'Local start', 'import.platform.report.datetimeText');
  });

  it('requires localized companion field names before a Smartsheet preview or import can start', async () => {
    const requestsBefore = replay.requests.length;
    const before = await server.pool.query(`SELECT count(*) FROM "${server.schemas.app}".platform_imports`);
    for (const path of ['/api/imports/smartsheet/preview', '/api/imports/smartsheet']) {
      const answer = await call<{ error: { messageKey: string; fields: Record<string, string> } }>(
        server,
        'POST',
        path,
        { address: replay.url, token: TOKEN, baseId: SHEET },
        422,
      );
      expect(answer.error.messageKey).toBe('errors.validationFailed');
      expect(answer.error.fields).toHaveProperty('fieldNames');
    }
    expect(replay.requests).toHaveLength(requestsBefore);
    const after = await server.pool.query(`SELECT count(*) FROM "${server.schemas.app}".platform_imports`);
    expect(after.rows).toEqual(before.rows);
  });

  it('pages through visible sheets and groups nested paths without hiding individually shared sheets', async () => {
    const listed = await listBases(server, 'smartsheet', { address: replay.url, token: TOKEN });
    expect(listed).toEqual([
      { id: SHEET, name: 'Launch plan', group: 'Riosoma tests / Marketing / Campaigns' },
      { id: '6100000000000002', name: 'Archived plan', group: null },
      { id: '6100000000000003', name: 'Value fidelity', group: 'Riosoma tests' },
    ]);
    expect(replay.requests.some((entry) => entry.path.includes('page=2'))).toBe(true);
    const refused = await call<{ error: { messageKey: string } }>(
      server,
      'POST',
      '/api/imports/smartsheet/bases',
      { address: replay.url, token: randomUUID() },
      422,
    );
    expect(refused.error.messageKey).toBe('import.platform.tokenInvalid');
  });

  it('returns the shared preview contract with all pages and scoped fidelity notes without writing a database', async () => {
    const before = await server.pool.query(`SELECT count(*) FROM "${server.schemas.app}".databases`);
    const preview = await call<PlatformPreview>(server, 'POST', '/api/imports/smartsheet/preview', request());
    expect(PlatformPreview.parse(preview)).toEqual(preview);
    expect(preview.tables[0]).toMatchObject({ id: SHEET, name: 'Launch plan', views: 3 });
    expect(preview.notes).toContainEqual({
      status: 'changed',
      subject: 'table',
      table: 'Launch plan',
      name: null,
      messageKey: 'import.platform.report.crossSheetFixed',
      params: {},
    });
    expect(preview.tables[0]!.fields).toContainEqual({ name: 'Cost', type: 'number' });
    expect(preview.tables[0]!.fields).toContainEqual({ name: 'Mixed', type: 'text' });
    expect(preview.notes.map((note) => note.messageKey)).toContain('import.platform.report.crossSheetFixed');
    expect(JSON.stringify(preview)).not.toContain('keep this text');
    expect(JSON.stringify(preview)).not.toContain(TOKEN);
    const after = await server.pool.query(`SELECT count(*) FROM "${server.schemas.app}".databases`);
    expect(after.rows).toEqual(before.rows);
    expect(files.requests).toHaveLength(0);
  });

  it('imports all column types, hierarchy, dependencies, formulas, filters, and guarded files', async () => {
    const imported = await importBase(server, 'smartsheet', request());
    expect(imported.schema.tables.map((table) => table.name)).toEqual(['Launch plan', 'Attachments']);
    expect((await imported.rows('Launch plan')).rows).toHaveLength(202);
    const types: Record<string, string> = {
      Task: 'text',
      Cost: 'number',
      Mixed: 'text',
      Due: 'date',
      'Start time': 'date',
      Owner: 'text',
      Reviewers: 'text',
      Status: 'singleSelect',
      Tags: 'multipleSelect',
      Complete: 'checkbox',
      Health: 'singleSelect',
      Flag: 'checkbox',
      Sequence: 'autoNumber',
      Reference: 'text',
      Effort: 'duration',
      'Depends on': 'link',
      Created: 'date',
      Modified: 'date',
      Creator: 'text',
      Editor: 'text',
      'Double cost': 'formula',
      'Portfolio total': 'number',
      'One-off': 'number',
      Progress: 'percent',
      'Parent row': 'link',
      Attachments: 'attachment',
    };
    for (const [name, type] of Object.entries(types))
      expect(imported.field('Launch plan', name).type, name).toBe(type);
    const launch = await imported.record('Launch plan', 'Launch');
    const design = await imported.record('Launch plan', 'Design');
    const late = await imported.record('Launch plan', 'Later text');
    expect(launch.Cost).toBe(12.5);
    expect(launch.Due).toBe('2026-10-05');
    expect(launch.Created).toBe('2026-09-01T12:00:00.000Z');
    expect(launch.Effort).toBe(37800);
    expect(launch['Double cost']).toBe(25);
    expect(launch.Reviewers).toBe('one@example.test, two@example.test');
    expect(launch.Tags).toHaveLength(2);
    expect(design.Tags).toBeNull();
    expect(design.Complete).toBe(false);
    expect((await imported.record('Launch plan', 'Task 3')).Complete).toBe(false);
    expect(late.Mixed).toBe('keep this text');
    expect(design['Parent row']).toHaveLength(1);
    expect(design['Depends on']).toHaveLength(1);
    expect(design['Depends on (Dependency details)']).toBe('1FS +2d, #REF');
    expect(launch.Attachments).toHaveLength(1);
    expect(imported.job.report!.files).toBe(3);
    expect(files.requests).toHaveLength(3);
    expect(files.requests.every((entry) => entry.headers.authorization === undefined)).toBe(true);
    expect(imported.view('Launch plan', 'Planned tasks').config.filter?.conditions).toHaveLength(1);
    imported.item('Launch plan', 'Depends on', 'import.platform.report.linksDropped');
    imported.item('Launch plan', 'Portfolio total', 'import.platform.report.cellLinksFixed');
    imported.item('Launch plan', 'Attachments', 'import.platform.report.filesBlocked');
    imported.item('Launch plan', 'Attachments', 'import.platform.report.filesFailed');
    expect(
      imported.job.report!.items.some((item) => item.messageKey === 'import.platform.report.formulaUnread'),
    ).toBe(true);
    expect(await sealedToken(server, imported.job.id)).toBeNull();
    expect(await tablesHolding(server, TOKEN)).toEqual([]);
    expect(logs.lines.join('\n')).not.toContain(TOKEN);
    expect(logs.lines.join('\n')).not.toContain('keep this text');
    expect(replay.requests.every((entry) => entry.method === 'GET' && !entry.path.includes(TOKEN))).toBe(
      true,
    );
  });

  it('handles empty archived sheets and deleted sheets using documented errors', async () => {
    const imported = await importBase(server, 'smartsheet', request('6100000000000002'));
    expect(imported.job.report!.records).toBe(0);
    const answer = await call<{ error: { messageKey: string } }>(
      server,
      'POST',
      '/api/imports/smartsheet/preview',
      request('6100000000000999'),
      404,
    );
    expect(answer.error.messageKey).toBe('import.platform.baseUnavailable');
  });

  it('shares a conservative rate limit and uses exponential waits after 429 responses', async () => {
    replay.throttle('/sheets', 2);
    const before = time.now;
    await listBases(server, 'smartsheet', { address: replay.url, token: TOKEN });
    expect(time.now - before).toBeGreaterThanOrEqual(180_000);
    expect(server.ctx.platformImports!.limiter('smartsheet', replay.url)).toBe(
      server.ctx.platformImports!.limiter('smartsheet', replay.url),
    );
    const started = await call<PlatformImport>(server, 'GET', '/api/imports/smartsheet');
    expect(started).not.toHaveProperty('token');
  });
});

describe('Smartsheet formula and duration fidelity', () => {
  it('translates only current-row references and preserves quoted reference-like text', () => {
    expect(smartsheetFormula('=[Cost]@row * 2').expression).toBe('({Cost} * 2)');
    expect(smartsheetFormula('=IF(Complete@row, "[Cost]@row", "")').expression).toContain('"[Cost]@row"');
    for (const formula of ['=SUM({Other sheet})', '=SUM([Cost]:[Cost])', '=[Cost]1 + 2', '=CHILDREN()'])
      expect(smartsheetFormula(formula).expression, formula).toBeNull();
  });

  it('uses workdays for project durations and calendar days for elapsed durations', () => {
    const sheet = {
      projectSettings: { lengthOfDay: 6, workingDays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY'] },
    };
    expect(durationSeconds('1w 2d 30m', sheet)).toBe(131400);
    expect(durationSeconds('e1d', sheet)).toBe(86400);
    expect(durationSeconds({ objectType: 'DURATION', days: 2, hours: 1, milliseconds: 500 }, sheet)).toBe(
      46800.5,
    );
    expect(durationSeconds({ objectType: 'DURATION', days: 1, elapsed: true, negative: true }, sheet)).toBe(
      -86400,
    );
    expect(durationSeconds('', sheet)).toBeNull();
    expect(durationSeconds('half a day', sheet)).toBe('half a day');
    expect(pathGroup({ name: 'Workspace', folders: [{ name: 'Folder', sheets: [{ id: 5 }] }] }, '5')).toBe(
      'Workspace / Folder',
    );
  });

  it('keeps masks and unknown values with fidelity notes rather than discarding them', () => {
    const sheet = { id: '1', rows: [], columns: [], totalRowCount: 0, name: 'Empty' };
    const column = {
      id: '2',
      index: 0,
      title: 'Value',
      type: 'TEXT_NUMBER',
      systemColumnType: 'AUTO_NUMBER',
      autoNumberFormat: { prefix: 'TASK-', fill: '000' },
    };
    expect(planColumn(column, sheet)).toMatchObject({
      kind: 'value',
      spec: { type: 'text' },
      notes: [{ key: 'import.platform.report.autoNumberMask' }],
    });
    expect(planColumn({ ...column, systemColumnType: null, type: 'FUTURE_TYPE' }, sheet)).toMatchObject({
      kind: 'value',
      spec: { type: 'text' },
      notes: [{ key: 'import.platform.report.unknownColumn' }],
    });
  });
});
