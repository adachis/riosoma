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
import { checkNocodbImport, NOCODB_RECORDING } from '../../../../test/platforms/nocodb-checks.js';
import type { Clock } from '../../core/clock.js';
import type { PlatformImporter } from '../importer.js';
import { conditionOf } from './reader.js';

/**
 * Imports from a recording of a real NocoDB, made by the live suite, so everything NocoDB sends is
 * exactly what it sent.  Every line the server logs is kept, to show the token never reaches them.
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

const TOKEN = 'test-nocodb-token-not-a-secret-0001';
const RECORDING = join(import.meta.dirname, '../../../../test/platforms', NOCODB_RECORDING);

let kit: TestPostgres;
let server: ServerFixture;
let replay: Replay;
let importer: PlatformImporter;
let baseId: string;
const time = { now: 0 };
const clock: Clock = {
  now: () => time.now,
  sleep: async (ms) => {
    time.now += ms;
  },
};

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'nocodb', { logLevel: 'trace' });
  const { readFileSync } = await import('node:fs');
  const recording = JSON.parse(readFileSync(RECORDING, 'utf8')) as Recording;
  const listing = recording.answers.find(
    (answer) => answer.path.startsWith('/api/v2/meta/bases?') || answer.path === '/api/v2/meta/bases',
  )!;
  baseId = (JSON.parse(listing.body) as { list: Array<{ id: string }> }).list[0]!.id;
  // NocoDB serves files at signed addresses to anyone, and everything else only with the token.
  replay = await startReplay(
    recording,
    (headers, path) => path.startsWith('/dltemp/') || headers['xc-token'] === TOKEN,
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

describe('listing NocoDB bases', () => {
  it('lists what the token can see, and says when NocoDB refuses it', async () => {
    const bases = await listBases(server, 'nocodb', request());
    expect(bases.map((base) => base.id)).toEqual([baseId]);
    const refused = await call<{ error: { messageKey: string; fields: Record<string, string> } }>(
      server,
      'POST',
      '/api/imports/nocodb/bases',
      request({ token: 'not-the-token' }),
      422,
    );
    expect(refused.error).toMatchObject({
      messageKey: 'import.platform.tokenInvalid',
      fields: { token: 'import.platform.tokenInvalid' },
    });
  });

  it('keeps to the private-network rule, and to https elsewhere', async () => {
    const blocked = await call<{ error: { messageKey: string; fields: Record<string, string> } }>(
      server,
      'POST',
      '/api/imports/nocodb/bases',
      request({ address: 'http://10.0.0.7:8080' }),
      422,
    );
    expect(blocked.error).toMatchObject({
      messageKey: 'import.platform.https',
      fields: { address: 'import.platform.https' },
    });
    const privateHost = await call<{ error: { messageKey: string } }>(
      server,
      'POST',
      '/api/imports/nocodb/bases',
      request({ address: 'https://10.0.0.7' }),
      422,
    );
    expect(privateHost.error.messageKey).toBe('import.platform.private');
    await call(server, 'POST', '/api/imports/nocodb/bases', request({ address: 'ftp://example.com' }), 422);
    // A password is only for Baserow.
    await call(
      server,
      'POST',
      '/api/imports/nocodb/bases',
      { address: replay.url, email: 'someone@example.com', password: 'a password' },
      422,
    );
  });
});

describe('importing a NocoDB base', () => {
  it('brings every table, field, record, link, file, and view across, as NocoDB had them', async () => {
    replay.requests.length = 0;
    const imported = await importBase(server, 'nocodb', request({ baseId, name: 'From NocoDB' }));
    expect(imported.schema.database.name).toBe('From NocoDB');
    expect(imported.job).toMatchObject({ platform: 'nocodb', address: replay.url, baseId });
    await checkNocodbImport(imported);
    // Views' conditions come across as NocoDB wrote them, and links from the cells or the links API.
    expect(replay.requests.some((entry) => entry.path.includes('/links/'))).toBe(true);
    // The file was fetched the way NocoDB serves it.
    expect(replay.requests.filter((entry) => entry.path.startsWith('/dltemp/'))).toHaveLength(1);
  });

  it('never keeps or logs the token, and sends it only in its header', async () => {
    const recent = await call<{ imports: PlatformImport[] }>(server, 'GET', '/api/imports/nocodb');
    const done = recent.imports.find((entry) => entry.state === 'finished')!;
    expect(await sealedToken(server, done.id)).toBeNull();
    expect(await tablesHolding(server, TOKEN)).toEqual([]);
    expect(logs.lines.length).toBeGreaterThan(10);
    expect(logs.lines.filter((line) => line.includes(TOKEN))).toEqual([]);
    expect(replay.requests.every((entry) => !entry.path.includes(TOKEN))).toBe(true);
    expect(
      replay.requests
        .filter((entry) => !entry.path.startsWith('/dltemp/'))
        .every((entry) => entry.headers['xc-token'] === TOKEN),
    ).toBe(true);
  });

  it('keeps the report with the database, for anyone who can read it', async () => {
    const recent = await call<{ imports: PlatformImport[] }>(server, 'GET', '/api/imports/nocodb');
    const done = recent.imports.find((entry) => entry.state === 'finished')!;
    const kept = await call<{ imports: PlatformImport[] }>(
      server,
      'GET',
      `/api/databases/${done.databaseId}/imports/nocodb`,
    );
    expect(kept.imports.map((entry) => entry.id)).toEqual([done.id]);
    const any = await call<{ imports: PlatformImport[] }>(
      server,
      'GET',
      `/api/databases/${done.databaseId}/platform-imports`,
    );
    expect(any.imports.map((entry) => entry.id)).toEqual([done.id]);
    const stranger = await server.addMember();
    const hidden = await server.app.inject({
      url: `/api/databases/${done.databaseId}/imports/nocodb`,
      headers: stranger.headers,
    });
    expect(hidden.statusCode).toBe(404);
    // Another tool's routes don't show it.
    const elsewhere = await server.app.inject({
      url: `/api/imports/grist/${done.id}`,
      headers: server.owner.headers,
    });
    expect(elsewhere.statusCode).toBe(404);
  });
});

describe('running NocoDB imports', () => {
  it('waits out 429 answers for the whole tool', async () => {
    replay.throttle('/api/v2/tables/', 2, 10);
    const before = time.now;
    const started = await startImport(server, 'nocodb', request({ baseId, name: 'Throttled' }));
    const job = await finished(server, 'nocodb', started.id);
    expect(job.state, JSON.stringify(job.error)).toBe('finished');
    expect(time.now - before).toBeGreaterThanOrEqual(20_000);
  });

  it('stops when asked, puts what it made in the trash, and forgets the token', async () => {
    const held = replay.hold('/api/v2/tables/');
    const started = await startImport(server, 'nocodb', request({ baseId, name: 'Stopped' }));
    await held.reached;
    const busy = await call<{ error: { messageKey: string } }>(
      server,
      'POST',
      '/api/imports/nocodb',
      request({ baseId, name: 'Second' }),
      409,
    );
    expect(busy.error.messageKey).toBe('import.platform.busy');
    const canceled = await call<PlatformImport>(server, 'POST', `/api/imports/nocodb/${started.id}/cancel`);
    expect(['running', 'canceled']).toContain(canceled.state);
    held.release();
    const ended = await finished(server, 'nocodb', started.id);
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
      '/api/imports/nocodb',
      request({ baseId: 'pnotthere00000', name: 'Missing' }),
      404,
    );
    expect(missing.error.messageKey).toBe('import.platform.baseUnavailable');
  });
});

describe('NocoDB view conditions', () => {
  const column = (uidt: string) => ({ id: 'col1', title: 'Field', uidt });
  const filter = (comparison_op: string, value: unknown, comparison_sub_op: string | null = null) => ({
    id: 'fi1',
    comparison_op,
    comparison_sub_op,
    value,
  });

  it('read as the closest condition here', () => {
    expect(conditionOf(filter('like', 'web'), column('SingleLineText'))).toEqual({
      field: 'col1',
      operator: 'contains',
      value: { kind: 'text', text: 'web' },
    });
    expect(conditionOf(filter('gte', '50'), column('Percent'))).toMatchObject({
      operator: 'gte',
      value: { kind: 'number', number: 0.5 },
    });
    expect(conditionOf(filter('checked', null), column('Checkbox'))).toMatchObject({
      operator: 'is',
      value: { kind: 'boolean', value: true },
    });
    expect(conditionOf(filter('isWithin', '14', 'pastNumberOfDays'), column('Date'))).toMatchObject({
      operator: 'isWithin',
      value: { kind: 'range', range: { mode: 'pastDays', days: 14 } },
    });
    expect(conditionOf(filter('lt', null, 'today'), column('DateTime'))).toMatchObject({
      operator: 'isBefore',
      value: { kind: 'date', target: { mode: 'today' } },
    });
    expect(conditionOf(filter('anyof', 'Web,Mobile'), column('SingleSelect'))).toMatchObject({
      operator: 'isAnyOf',
      value: { kind: 'choices', names: ['Web', 'Mobile'] },
    });
    expect(conditionOf(filter('allof', 'Web'), column('MultiSelect'))).toMatchObject({
      operator: 'hasAllOf',
    });
    expect(conditionOf(filter('blank', null), column('Attachment'))).toMatchObject({ operator: 'isEmpty' });
  });

  it('leave out what has no match here', () => {
    expect(conditionOf(filter('nallof', 'Web'), column('MultiSelect'))).toBeNull();
    expect(conditionOf(filter('eq', 'x'), column('User'))).toBeNull();
    expect(conditionOf(filter('eq', null, 'someNewOption'), column('Date'))).toBeNull();
  });
});
