import { ContractTransport as FixtureBoundary, strictFixture } from '@riosoma/connectors';
import { SourceConnection } from '@riosoma/contracts';
/**
 * Airtable sources through the server, against the same stand-in for Airtable's API the import's
 * tests use: the connection test, the bases and tables a token offers, fields typed the way an
 * import types them with links as the linked records' names, and whole syncs into a table,
 * overrides and all.  Airtable is only ever read, and the token is nowhere it shouldn't be.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  newId,
  type CommandBatchResult,
  type DatabaseSchema,
  type FieldOptionsOf,
  type RowData,
  type SourceMeta,
  type SourceObject,
  type SourcePreview,
  type SourceTestResult,
  type TableMeta,
} from '@riosoma/contracts';
import { ConnectorError, registerConnector } from '@riosoma/connectors';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { startFakeAirtable, type FakeAirtable, type FakeRecord } from '../test/fake-airtable.js';
import { loadFields, loadTable } from '../data/metadata.js';
import { fetchRowsById } from '../data/physical/records.js';
import type { Clock } from '../data/imports/airtable/api.js';
import { BASE_REQUESTS_PER_SECOND, createAirtableSourceConnector, RECORD_ID } from './airtable.js';
import { fileNetwork } from './files.js';
import { claimSyncs, runSync } from './sync.js';

const TOKEN = 'patAirtableSourceToken.0123456789abcdef';
const BASE = 'appGarden00000000';
const PLANTS = 'tblPlants00000000';
const BEDS = 'tblBeds0000000000';
const ORCHARD = 'appOrchard0000000';

/** Another base the token sees, which a source offers only when an admin chooses it. */
function orchard() {
  return {
    id: ORCHARD,
    name: 'Orchard',
    tables: [
      {
        id: 'tblTrees000000000',
        name: 'Trees',
        primaryFieldId: 'fldTree',
        fields: [{ id: 'fldTree', name: 'Tree', type: 'singleLineText' }],
        views: [{ id: 'viwTrees', name: 'Grid', type: 'grid' }],
        records: [{ id: 'recApple000000000', fields: { fldTree: 'Apple' } }],
      },
    ],
  };
}

const basil: FakeRecord = {
  id: 'recBasil000000000',
  fields: {
    fldName: 'Basil',
    fldCount: 3,
    fldPrice: 2.5,
    fldKind: 'Herb',
    fldTags: ['Sun'],
    fldOrganic: true,
    fldPlanted: '2026-04-02',
    fldWatered: '2026-09-27T08:30:00.000Z',
    fldBed: ['recBedOne00000000'],
    fldTotal: 7.5,
    fldBedSun: ['Full'],
    fldPhotos: [{ id: 'attBasil', url: 'https://files.example/basil.jpg', filename: 'basil.jpg' }],
    fldRating: 4,
    fldRecordId: 'recBasil000000000',
    fldOpen: { label: 'Open', url: 'https://example.com/basil' },
  },
};
const rose: FakeRecord = {
  id: 'recRose0000000000',
  fields: {
    fldName: 'Rose',
    fldCount: 1,
    fldKind: 'Flower',
    fldTags: ['Sun', 'Shade'],
    fldPlanted: '2026-05-01',
    fldBed: ['recBedTwo00000000', 'recBedOne00000000'],
    fldTotal: 12,
    fldRating: 5,
  },
};
const fern: FakeRecord = { id: 'recFern0000000000', fields: { fldName: 'Fern', fldKind: 'Herb' } };

function garden() {
  return {
    id: BASE,
    name: 'Garden',
    tables: [
      {
        id: PLANTS,
        name: 'Plants',
        primaryFieldId: 'fldName',
        fields: [
          { id: 'fldCount', name: 'Count', type: 'number', options: { precision: 0 } },
          { id: 'fldName', name: 'Name', type: 'singleLineText' },
          { id: 'fldPrice', name: 'Price', type: 'currency', options: { symbol: '$', precision: 2 } },
          {
            id: 'fldKind',
            name: 'Kind',
            type: 'singleSelect',
            options: {
              choices: [
                { id: 'selHerb', name: 'Herb', color: 'greenLight2' },
                { id: 'selFlower', name: 'Flower', color: 'pinkLight2' },
              ],
            },
          },
          {
            id: 'fldTags',
            name: 'Tags',
            type: 'multipleSelects',
            options: {
              choices: [
                { id: 'selSun', name: 'Sun' },
                { id: 'selShade', name: 'Shade' },
              ],
            },
          },
          {
            id: 'fldOrganic',
            name: 'Organic',
            type: 'checkbox',
            options: { icon: 'check', color: 'greenBright' },
          },
          { id: 'fldPlanted', name: 'Planted', type: 'date', options: { dateFormat: { name: 'iso' } } },
          {
            id: 'fldWatered',
            name: 'Watered',
            type: 'dateTime',
            options: { timeZone: 'utc', dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' } },
          },
          {
            id: 'fldBed',
            name: 'Bed',
            type: 'multipleRecordLinks',
            options: { linkedTableId: BEDS, inverseLinkFieldId: 'fldBedPlants' },
          },
          {
            id: 'fldTotal',
            name: 'Total',
            type: 'formula',
            options: {
              formula: '{fldCount} * {fldPrice}',
              isValid: true,
              result: { type: 'currency', options: { symbol: '$', precision: 2 } },
            },
          },
          {
            id: 'fldBedSun',
            name: 'Bed sun',
            type: 'multipleLookupValues',
            options: {
              recordLinkFieldId: 'fldBed',
              fieldIdInLinkedTable: 'fldSun',
              result: { type: 'singleLineText' },
            },
          },
          { id: 'fldPhotos', name: 'Photos', type: 'multipleAttachments' },
          {
            id: 'fldRating',
            name: 'Rating',
            type: 'rating',
            options: { max: 5, icon: 'star', color: 'yellowBright' },
          },
          {
            id: 'fldRecordId',
            name: 'Record ID',
            type: 'formula',
            options: { formula: 'RECORD_ID()', isValid: true, result: { type: 'singleLineText' } },
          },
          { id: 'fldOpen', name: 'Open', type: 'button' },
          { id: 'fldMystery', name: 'Mystery', type: 'somethingNew' },
        ],
        views: [{ id: 'viwGrid', name: 'Grid', type: 'grid' }],
        records: [basil, rose, fern],
      },
      {
        id: BEDS,
        name: 'Beds',
        primaryFieldId: 'fldBedName',
        fields: [
          { id: 'fldBedName', name: 'Name', type: 'singleLineText' },
          { id: 'fldSun', name: 'Sun', type: 'singleLineText' },
          {
            id: 'fldBedPlants',
            name: 'Plants',
            type: 'multipleRecordLinks',
            options: { linkedTableId: PLANTS },
          },
        ],
        views: [{ id: 'viwBeds', name: 'Grid', type: 'grid' }],
        records: [
          { id: 'recBedOne00000000', fields: { fldBedName: 'Bed one', fldSun: 'Full' } },
          { id: 'recBedTwo00000000', fields: { fldBedName: 'Bed two', fldSun: 'Part' } },
        ],
      },
    ],
  };
}

/**
 * Advance only through requested waits, so a wall-clock tick cannot subtract from the measured
 * retry delay.  A test can wait out Airtable's 30 seconds without spending them.
 */
const clockOrigin = Date.now();
let skipped = 0;
const clock: Clock = {
  now: () => clockOrigin + skipped,
  sleep: async (ms, signal) => {
    signal?.throwIfAborted();
    skipped += ms;
  },
};

const standIn = () =>
  fileNetwork({
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    // Only the stand-in on this machine may be reached on a private address.
    allowPrivate: (url) => url.hostname === '127.0.0.1',
  });

let kit: TestPostgres;
let server: ServerFixture;
let airtable: FakeAirtable;
let databaseId: string;

beforeAll(async () => {
  airtable = await startFakeAirtable({
    token: TOKEN,
    bases: [garden(), orchard()],
    // The bases list pages, as Airtable's does for a token that sees many.
    basesPerPage: 1,
  });
  kit = await startTestPostgres();
  server = await startServer(kit, 'airtablesrc', { automationsAllowPrivateHosts: true });
  registerConnector(
    createAirtableSourceConnector({
      network: standIn(),
      sockets: { connect: async () => undefined, handshake: async () => undefined },
      apiUrl: airtable.url,
      clock,
      // Fast enough for tests, and still paced.
      requestsPerSecond: 50,
    }),
  );
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: newId('database'),
      name: 'Airtable',
      table: {
        id: newId('table'),
        name: 'Local',
        fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
        view: { id: newId('view'), name: 'Grid' },
      },
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  databaseId = created.json<DatabaseSchema>().database.id;
}, 60_000);

afterAll(async () => {
  await server?.close();
  await kit?.stop();
  await airtable?.close();
});

async function createSource(token = TOKEN, bases = [BASE]): Promise<SourceMeta> {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/sources',
    headers: server.owner.headers,
    payload: {
      name: `Airtable ${newId('source')}`,
      connection: { kind: 'airtable', bases },
      secrets: { token },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<SourceMeta>();
}

async function test(source: SourceMeta): Promise<SourceTestResult & { body: string }> {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/sources/${source.id}/test`,
    headers: server.owner.headers,
  });
  return { ...response.json<SourceTestResult>(), body: response.body };
}

async function applied(input: Record<string, unknown>) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [{ id: newId('command'), groupId: newId('action'), ...input }],
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  const result = response.json<CommandBatchResult>().results[0]!;
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
}

async function sync(tableId: string): Promise<TableMeta> {
  await applied({ kind: 'table.sync', tableId, confirmRemovals: false });
  for (const job of await claimSyncs(server.ctx, 100)) await runSync(server.ctx, job);
  return (await loadTable(server.pool, server.schemas, tableId))!;
}

async function rows(tableId: string): Promise<RowData[]> {
  const ids = await query<{ __id: string }>(
    server.pool,
    sql`SELECT __id FROM ${ident(server.schemas.data, tableId)} WHERE NOT __source_gone ORDER BY __rid`,
  );
  const fields = await loadFields(server.pool, server.schemas, [tableId]);
  return fetchRowsById(
    server.pool,
    server.schemas.data,
    tableId,
    fields,
    ids.rows.map((row) => row.__id),
  );
}

const SELECT = { kind: 'object' as const, object: { schema: BASE, name: PLANTS } };

describe('testing an Airtable source', () => {
  it('climbs from finding Airtable to reading a table’s first rows', async () => {
    const result = await test(await createSource());
    expect(result.steps.map((step) => [step.step, step.status])).toEqual([
      ['resolve', 'ok'],
      ['connect', 'ok'],
      ['tls', 'skipped'],
      ['authenticate', 'ok'],
      ['tables', 'ok'],
      ['rows', 'ok'],
    ]);
  });

  it('says what usually fixes each failure, and never repeats the token', async () => {
    const wrong = await test(await createSource('patWrongToken.not-the-right-one'));
    expect(wrong.steps.at(-1)).toMatchObject({
      step: 'authenticate',
      status: 'failed',
      messageKey: 'sources.airtable.token',
    });
    expect(wrong.body).not.toContain('patWrongToken');
    airtable.refuseWith(403);
    try {
      const refused = await test(await createSource());
      expect(refused.steps.at(-1)).toMatchObject({
        step: 'tables',
        status: 'failed',
        messageKey: 'sources.airtable.base',
      });
      expect(refused.body).not.toContain(TOKEN);
    } finally {
      airtable.reset();
    }
    // The first chosen base is the one the test reads, so a base that's gone fails there.
    const gone = await test(await createSource(TOKEN, ['appGone0000000000', BASE]));
    expect(gone.steps.at(-1)).toMatchObject({
      step: 'tables',
      status: 'failed',
      messageKey: 'sources.airtable.base',
    });
  });

  it('reaches Airtable only on public addresses, and gives up on a refused one at once', async () => {
    const blocked = createAirtableSourceConnector({
      network: fileNetwork({
        resolve: async () => [{ address: '10.0.0.5', family: 4 }],
        allowPrivate: () => false,
      }),
      sockets: { connect: async () => undefined, handshake: async () => undefined },
    });
    const ctx = {
      connection: { kind: 'airtable' as const, bases: [BASE] },
      secrets: { token: TOKEN },
      timeoutMs: 20_000,
    };
    const result = await blocked.test(ctx);
    expect(result.steps).toEqual([
      expect.objectContaining({
        step: 'resolve',
        status: 'failed',
        messageKey: 'sources.airtable.unreachable',
      }),
    ]);
    const started = Date.now();
    const refused = await blocked.describe(ctx, SELECT).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(ConnectorError);
    expect((refused as ConnectorError).messageKey).toBe('sources.airtable.unreachable');
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('choosing an Airtable source’s bases', () => {
  it('lists the bases a token sees, before and after saving, without repeating the token', async () => {
    const before = airtable.requests.length;
    const draft = await server.app.inject({
      method: 'POST',
      url: '/api/sources/airtable-bases',
      headers: server.owner.headers,
      payload: { token: TOKEN },
    });
    expect(draft.statusCode, draft.body).toBe(200);
    expect(draft.json()).toEqual([
      { id: BASE, name: 'Garden' },
      { id: ORCHARD, name: 'Orchard' },
    ]);
    // One listing, a page a request, and nothing about any base's tables.
    expect(airtable.requests.slice(before).map((entry) => entry.path)).toEqual([
      '/v0/meta/bases',
      '/v0/meta/bases',
    ]);
    const wrong = await server.app.inject({
      method: 'POST',
      url: '/api/sources/airtable-bases',
      headers: server.owner.headers,
      payload: { token: 'patWrongToken.not-the-right-one' },
    });
    expect(wrong.json()).toMatchObject({ error: { messageKey: 'sources.airtable.token' } });
    expect(wrong.body).not.toContain('patWrongToken');

    const source = await createSource();
    const saved = await server.app.inject({
      method: 'POST',
      url: `/api/sources/${source.id}/airtable-bases`,
      headers: server.owner.headers,
    });
    expect(saved.json()).toEqual(draft.json());
    expect(saved.body).not.toContain(TOKEN);
  });

  it('can’t save a source without a base, and keeps the token when the bases change', async () => {
    for (const connection of [{ kind: 'airtable' }, { kind: 'airtable', bases: [] }]) {
      const refused = await server.app.inject({
        method: 'POST',
        url: '/api/sources',
        headers: server.owner.headers,
        payload: { name: 'No bases', connection, secrets: { token: TOKEN } },
      });
      expect(refused.statusCode, refused.body).toBe(422);
      expect(refused.json()).toMatchObject({ error: { fields: { 'connection.bases': expect.any(String) } } });
      expect(refused.body).not.toContain(TOKEN);
    }
    const source = await createSource();
    const more = await server.app.inject({
      method: 'PATCH',
      url: `/api/sources/${source.id}`,
      headers: server.owner.headers,
      payload: { connection: { kind: 'airtable', bases: [ORCHARD, BASE] } },
    });
    expect(more.statusCode, more.body).toBe(200);
    expect(more.json<SourceMeta>()).toMatchObject({
      secrets: ['token'],
      connection: { kind: 'airtable', bases: [ORCHARD, BASE] },
    });
  });
});

describe('what an Airtable source offers', () => {
  it('lists only the chosen bases’ tables, by ID, with their names', async () => {
    const objects = async (source: SourceMeta) =>
      (
        await server.app.inject({
          url: `/api/sources/${source.id}/objects`,
          headers: server.owner.headers,
        })
      ).json<SourceObject[]>();
    expect(await objects(await createSource())).toEqual([
      {
        schema: BASE,
        schemaLabel: 'Garden',
        name: PLANTS,
        label: 'Plants',
        type: 'table',
        rowEstimate: null,
      },
      { schema: BASE, schemaLabel: 'Garden', name: BEDS, label: 'Beds', type: 'table', rowEstimate: null },
    ]);
    const both = await objects(await createSource(TOKEN, [ORCHARD, BASE]));
    expect(both.map((object) => [object.schemaLabel, object.label])).toEqual([
      ['Orchard', 'Trees'],
      ['Garden', 'Plants'],
      ['Garden', 'Beds'],
    ]);
  });

  it('refuses a table in a base the source doesn’t offer, before asking Airtable', async () => {
    const source = await createSource();
    const before = airtable.requests.length;
    const refused = await server.app.inject({
      method: 'POST',
      url: `/api/sources/${source.id}/preview`,
      headers: server.owner.headers,
      payload: { select: { kind: 'object', object: { schema: ORCHARD, name: 'tblTrees000000000' } } },
    });
    expect(refused.json()).toMatchObject({ error: { messageKey: 'sources.sync.objectMissing' } });
    expect(airtable.requests.slice(before)).toEqual([]);
  });

  it('types fields as an import does, with links as names, and keys by record ID', async () => {
    const source = await createSource();
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/sources/${source.id}/preview`,
      headers: server.owner.headers,
      payload: { select: SELECT },
    });
    expect(response.statusCode, response.body).toBe(200);
    const shown = response.json<SourcePreview>();
    expect(
      shown.columns.map((column) => [
        column.name,
        column.suggested?.type ?? null,
        (column.notes ?? []).map((note) => note.messageKey),
      ]),
    ).toEqual([
      ['Name', 'text', []],
      ['Count', 'number', []],
      ['Price', 'currency', []],
      ['Kind', 'singleSelect', []],
      ['Tags', 'multipleSelect', []],
      ['Organic', 'checkbox', []],
      ['Planted', 'date', []],
      ['Watered', 'date', []],
      ['Bed', 'text', ['sources.airtable.linkText']],
      ['Total', 'currency', ['sources.airtable.computed']],
      ['Bed sun', 'text', ['sources.airtable.computed']],
      ['Photos', 'text', ['sources.airtable.filesText']],
      ['Rating', 'rating', []],
      ['Record ID_1', 'text', ['sources.airtable.computed']],
      ['Open', 'url', ['import.airtable.report.button']],
      ['Mystery', null, ['import.airtable.report.typeUnsupported']],
      [RECORD_ID, 'text', []],
    ]);
    expect(shown.columns.find((column) => column.name === 'Bed')!.notes).toEqual([
      { messageKey: 'sources.airtable.linkText', params: { table: 'Beds' } },
    ]);
    expect(shown.columns.at(-1)).toMatchObject({ role: 'recordId' });
    expect(shown.rows[0]).toEqual([
      'Basil',
      3,
      2.5,
      'Herb',
      ['Sun'],
      true,
      '2026-04-02',
      '2026-09-27T08:30:00.000Z',
      'Bed one',
      7.5,
      'Full',
      'basil.jpg',
      4,
      'recBasil000000000',
      'https://example.com/basil',
      null,
      'recBasil000000000',
    ]);
    expect(shown.rows[1]!.slice(0, 9)).toEqual([
      'Rose',
      1,
      null,
      'Flower',
      ['Sun', 'Shade'],
      null,
      '2026-05-01',
      null,
      'Bed two, Bed one',
    ]);
    expect(shown.rowEstimate).toBe(3);
    expect(shown.keyCandidates).toEqual([[RECORD_ID]]);
  });
});

describe('syncing an Airtable table', () => {
  it('syncs every record, keeps an override when Airtable changes, and only ever reads', async () => {
    const source = await createSource();
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/sources/${source.id}/preview`,
      headers: server.owner.headers,
      payload: { select: SELECT },
    });
    const shown = response.json<SourcePreview>();
    const names = ['Name', 'Kind', 'Tags', 'Price', 'Bed', 'Planted', 'Watered', 'Organic', 'Rating'];
    const field = Object.fromEntries(names.map((name) => [name, newId('field')]));
    const tableId = newId('table');
    await applied({
      kind: 'table.create',
      table: {
        id: tableId,
        name: 'Plants',
        source: { sourceId: source.id, select: SELECT, keyColumns: [RECORD_ID], everyMinutes: null },
        fields: names.map((name) => {
          const column = shown.columns.find((entry) => entry.name === name)!;
          return {
            id: field[name],
            name,
            type: column.suggested!.type,
            options: column.suggested!.options,
            source: { column: name, sourceType: column.sourceType },
          };
        }),
        view: { id: newId('view'), name: 'Grid' },
        records: [],
      },
    });
    const before = airtable.requests.length;
    const first = await sync(tableId);
    expect(first.source!.status, JSON.stringify(first.source!.status)).toMatchObject({
      state: 'idle',
      stats: { added: 3 },
    });
    const fields = await loadFields(server.pool, server.schemas, [tableId]);
    const choice = (fieldId: string, id: unknown) =>
      (fields.find((entry) => entry.id === fieldId)!.options as FieldOptionsOf<'singleSelect'>).choices.find(
        (entry) => entry.id === id,
      )?.name;
    const synced = await rows(tableId);
    expect(synced.map((row) => row.values[field.Name!])).toEqual(['Basil', 'Rose', 'Fern']);
    const roseRow = synced.find((row) => row.values[field.Name!] === 'Rose')!;
    expect(choice(field.Kind!, roseRow.values[field.Kind!])).toBe('Flower');
    expect((roseRow.values[field.Tags!] as string[]).map((id) => choice(field.Tags!, id))).toEqual([
      'Sun',
      'Shade',
    ]);
    expect(roseRow.values).toMatchObject({
      [field.Bed!]: 'Bed two, Bed one',
      [field.Planted!]: '2026-05-01',
      [field.Rating!]: 5,
      [field.Organic!]: false,
    });
    expect(synced[0]!.values).toMatchObject({
      [field.Price!]: 2.5,
      [field.Watered!]: '2026-09-27T08:30:00.000Z',
      [field.Organic!]: true,
    });
    // A sync asks only for the fields the table holds, and reads the linked table for its names.
    const reads = airtable.requests.slice(before).filter((entry) => entry.path === `/v0/${BASE}/${PLANTS}`);
    expect(reads.at(-1)!.query.getAll('fields[]').sort()).toEqual(
      [
        'fldBed',
        'fldKind',
        'fldName',
        'fldOrganic',
        'fldPlanted',
        'fldPrice',
        'fldRating',
        'fldTags',
        'fldWatered',
      ].sort(),
    );
    expect(airtable.requests.slice(before).some((entry) => entry.path === `/v0/${BASE}/${BEDS}`)).toBe(true);

    await applied({
      kind: 'record.update',
      tableId,
      records: [{ id: roseRow.id, values: { [field.Name!]: 'Tea rose' } }],
    });
    // Airtable changes: Rose is renamed, Fern leaves, and Mint arrives.
    const table = airtable.bases[0]!.tables[0]!;
    table.records = [
      basil,
      { ...rose, fields: { ...rose.fields, fldName: 'Wild rose', fldRating: 3 } },
      { id: 'recMint0000000000', fields: { fldName: 'Mint', fldKind: 'Herb' } },
    ];
    airtable.throttle(`/v0/${BASE}/${PLANTS}`, 1, 1);
    const second = await sync(tableId);
    expect(second.source!.status.stats, JSON.stringify(second.source!.status)).toMatchObject({
      added: 1,
      changed: 1,
      removed: 1,
    });
    const after = await rows(tableId);
    expect(after.map((row) => row.values[field.Name!])).toEqual(['Basil', 'Tea rose', 'Mint']);
    const kept = after.find((row) => row.id === roseRow.id)!;
    expect(kept.values).toMatchObject({ [field.Rating!]: 3 });
    expect(kept.overrides![field.Name!]).toMatchObject({ source: 'Wild rose' });

    // Airtable is only ever read, and the token is nowhere: not in the change history, the audit
    // log, the sync status, or the list.
    expect(airtable.requests.every((entry) => entry.method === 'GET')).toBe(true);
    const changes = await query<{ body: unknown }>(
      server.pool,
      sql`SELECT body FROM ${ident(server.schemas.app, 'changes')} WHERE table_id = ${tableId}`,
    );
    const events = await query<{ detail: unknown }>(
      server.pool,
      sql`SELECT * FROM ${ident(server.schemas.audit, 'events')}`,
    );
    const listed = await server.app.inject({ url: '/api/sources', headers: server.owner.headers });
    for (const text of [
      JSON.stringify(changes.rows),
      JSON.stringify(events.rows),
      JSON.stringify(second.source),
      listed.body,
    ])
      expect(text).not.toContain(TOKEN);
  });

  it('fails a sync when a field it reads is gone from Airtable, and changes nothing', async () => {
    airtable.bases.splice(0, 1, garden());
    const source = await createSource();
    const tableId = newId('table');
    const count = newId('field');
    await applied({
      kind: 'table.create',
      table: {
        id: tableId,
        name: 'Counts',
        source: { sourceId: source.id, select: SELECT, keyColumns: [RECORD_ID], everyMinutes: null },
        fields: [
          {
            id: newId('field'),
            name: 'Name',
            type: 'text',
            options: {},
            source: { column: 'Name', sourceType: 'singleLineText' },
          },
          {
            id: count,
            name: 'Count',
            type: 'number',
            options: { precision: 0 },
            source: { column: 'Count', sourceType: 'number' },
          },
        ],
        view: { id: newId('view'), name: 'Grid' },
        records: [],
      },
    });
    expect((await sync(tableId)).source!.status.stats).toMatchObject({ added: 3 });
    airtable.bases[0]!.tables[0]!.fields.find((entry) => entry.id === 'fldCount')!.name = 'How many';
    const failed = await sync(tableId);
    expect(failed.source!.status).toMatchObject({
      state: 'failed',
      error: { messageKey: 'sources.sync.columnMissing' },
    });
    expect((await rows(tableId)).map((row) => row.values[count])).toEqual([3, 1, null]);
  });
});

describe('manners with Airtable', () => {
  /** A synced table of plants' names and beds, whose beds are read from the linked table. */
  async function plantsTable(source: SourceMeta): Promise<string> {
    const tableId = newId('table');
    await applied({
      kind: 'table.create',
      table: {
        id: tableId,
        name: `Plants ${tableId}`,
        source: { sourceId: source.id, select: SELECT, keyColumns: [RECORD_ID], everyMinutes: null },
        fields: ['Name', 'Bed'].map((name) => ({
          id: newId('field'),
          name,
          type: 'text',
          options: {},
          source: { column: name, sourceType: 'singleLineText' },
        })),
        view: { id: newId('view'), name: 'Grid' },
        records: [],
      },
    });
    return tableId;
  }

  it('waits out the 30 seconds Airtable asks for when a sync has time for them', async () => {
    airtable.bases.splice(0, 1, garden());
    const tableId = await plantsTable(await createSource());
    // No Retry-After, so the wait is Airtable's own 30 seconds.
    airtable.throttle(`/v0/${BASE}/${PLANTS}`, 1);
    const before = skipped;
    const synced = await sync(tableId);
    expect(synced.source!.status, JSON.stringify(synced.source!.status)).toMatchObject({
      state: 'idle',
      stats: { added: 3 },
    });
    expect(skipped - before).toBeGreaterThanOrEqual(30_000);
  });

  it('stops at once and says so when a call has no time for the wait, and the next sync gets past it', async () => {
    const source = await createSource();
    const tableId = await plantsTable(source);
    expect((await sync(tableId)).source!.status.state).toBe('idle');
    // The sync starts by reading the table's fields, which has the 30 seconds any request has.
    airtable.throttle(`/v0/meta/bases/${BASE}/tables`, 1);
    const started = Date.now();
    const failed = await sync(tableId);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(failed.source!.status).toMatchObject({
      state: 'failed',
      error: { messageKey: 'sources.airtable.slowDown' },
    });
    // While Airtable's wait lasts, a preview and a test say the same, and neither asks Airtable.
    const before = airtable.requests.length;
    const previewed = await server.app.inject({
      method: 'POST',
      url: `/api/sources/${source.id}/preview`,
      headers: server.owner.headers,
      payload: { select: SELECT },
    });
    expect(previewed.json()).toMatchObject({ error: { messageKey: 'sources.airtable.slowDown' } });
    expect((await test(source)).steps.at(-1)).toMatchObject({
      step: 'tables',
      status: 'failed',
      messageKey: 'sources.airtable.slowDown',
    });
    expect(airtable.requests.slice(before).filter((entry) => entry.path.includes(BASE))).toEqual([]);
    // Once the wait is over, the next sync goes through.
    skipped += 30_000;
    const next = await sync(tableId);
    expect(next.source!.status, JSON.stringify(next.source!.status)).toMatchObject({ state: 'idle' });
  });

  it('keeps every request to a base, linked names and tests included, to four a second', async () => {
    const taken: string[] = [];
    const paused: Array<[string, number]> = [];
    const paced = createAirtableSourceConnector({
      network: standIn(),
      sockets: { connect: async () => undefined, handshake: async () => undefined },
      apiUrl: airtable.url,
      clock,
      // Counted against another limiter too, the way the server counts them against the import's.
      sharedLimiter: (key) => ({
        take: async () => {
          taken.push(key);
        },
        pause: (ms) => paused.push([key, ms]),
      }),
    });
    expect(BASE_REQUESTS_PER_SECOND).toBe(4);
    const ctx = {
      connection: { kind: 'airtable' as const, bases: [BASE] },
      secrets: { token: TOKEN },
      timeoutMs: 20_000,
    };
    const before = airtable.requests.length;
    airtable.throttle(`/v0/${BASE}/${BEDS}`, 1, 1);
    expect((await paced.test(ctx)).ok).toBe(true);
    await paced.preview(ctx, SELECT, 5);
    const requests = airtable.requests.slice(before).filter((entry) => entry.path.includes(BASE));
    // The test's schema and first page, then the preview's schema, first page, and bed names, twice.
    expect(requests.map((entry) => entry.path)).toEqual([
      `/v0/meta/bases/${BASE}/tables`,
      `/v0/${BASE}/${PLANTS}`,
      `/v0/meta/bases/${BASE}/tables`,
      `/v0/${BASE}/${PLANTS}`,
      `/v0/${BASE}/${BEDS}`,
      `/v0/${BASE}/${BEDS}`,
    ]);
    for (const [index, entry] of requests.entries())
      if (index > 0) expect(entry.at - requests[index - 1]!.at).toBeGreaterThanOrEqual(230);
    expect(taken.filter((key) => key === BASE)).toHaveLength(requests.length);
    expect(paused).toEqual([[BASE, 1_000]]);
  });
});

it('runs every declared capability against the account protocol fixture', async () => {
  const boundary = new FixtureBoundary();
  await strictFixture(
    createAirtableSourceConnector({
      network: boundary.wrap(standIn()),
      sockets: boundary.wrap({ connect: async () => undefined, handshake: async () => undefined }),
      apiUrl: airtable.url,
      clock,
      requestsPerSecond: 50,
    }),
    { connection: SourceConnection.parse({ kind: 'airtable', bases: [BASE] }), secrets: { token: TOKEN } },
    { kind: 'object', object: { schema: BASE, name: PLANTS } },
    [RECORD_ID],
    3,
    boundary,
  );
});
