import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseSchema, newId, type CommandBatchResult, type ViewRanges } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import type { SnapshotRead } from './snapshots.js';
import { readFixture } from './snapshots.test-helpers.js';

let kit: TestPostgres;
let server: ServerFixture;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'colors');
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

async function send(read: SnapshotRead, input: Record<string, unknown>) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${read.table.databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [{ id: newId('command'), groupId: newId('action'), ...input }],
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<CommandBatchResult>().results[0]!;
}

async function insert(read: SnapshotRead, values: Record<string, unknown>[]) {
  const records = values.map((values) => ({ id: newId('record'), values }));
  expect(await send(read, { kind: 'record.create', tableId: read.table.id, records })).toMatchObject({
    status: 'applied',
  });
  return records.map((record) => record.id);
}

async function ranges(read: SnapshotRead, fieldIds: string[], who: SignedIn = server.owner, tz = 'UTC') {
  const query = new URLSearchParams({ fields: fieldIds.join(','), tz });
  return server.app.inject({ url: `/api/views/${read.view.id}/ranges?${query}`, headers: who.headers });
}

function rejected(setting: string) {
  return { status: 'rejected', error: { messageKey: 'data.view.badSetting', params: { setting } } };
}

const keep = (fieldId: string) => ({
  filter: { conjunction: 'and', conditions: [{ id: 'keep', fieldId, operator: 'is', value: 'keep' }] },
});

describe('color settings', () => {
  it('keeps unchanged icon sets dormant after conversion and validates changed sets', async () => {
    const read = await readFixture(server, [{ type: 'text' }, { type: 'number' }, { type: 'number' }]);
    const [, number, other] = read.fields.map((field) => field.id) as [string, string, string];
    const iconSets = [number, other].map((fieldId) => ({
      fieldId,
      style: 'arrows',
      thresholds: [0, 10],
      labels: ['Low', 'Middle', 'High'],
    }));
    expect(
      await send(read, { kind: 'view.update', viewId: read.view.id, config: { iconSets } }),
    ).toMatchObject({ status: 'applied' });
    expect(await send(read, { kind: 'field.convert', fieldId: number, to: { type: 'text' } })).toMatchObject({
      status: 'applied',
    });
    expect(
      await send(read, { kind: 'view.update', viewId: read.view.id, config: { rowHeight: 'medium' } }),
    ).toMatchObject({ status: 'applied' });
    expect(
      await send(read, {
        kind: 'view.update',
        viewId: read.view.id,
        config: { rowHeight: 'tall', iconSets },
      }),
    ).toMatchObject({ status: 'applied' });
    const changed = [iconSets[0]!, { ...iconSets[1]!, thresholds: [5, 20] }];
    expect(
      await send(read, { kind: 'view.update', viewId: read.view.id, config: { iconSets: changed } }),
    ).toMatchObject({ status: 'applied' });
    for (const edit of [
      { thresholds: [1, 10] },
      { style: 'flags' },
      { labels: ['Below target', 'On target', 'Above target'] },
    ])
      expect(
        await send(read, {
          kind: 'view.update',
          viewId: read.view.id,
          config: { iconSets: [{ ...changed[0], ...edit }, changed[1]] },
        }),
      ).toMatchObject(rejected('iconSets'));
    const schema = await server.app.inject({
      url: `/api/databases/${read.table.databaseId}/schema`,
      headers: server.owner.headers,
    });
    const saved = DatabaseSchema.parse(schema.json());
    expect(saved.fields.find((field) => field.id === number)?.type).toBe('text');
    expect(saved.views.find((view) => view.id === read.view.id)?.config).toMatchObject({
      rowHeight: 'tall',
      iconSets: changed,
    });
    expect(
      await send(read, {
        kind: 'view.update',
        viewId: read.view.id,
        config: { iconSets: [changed[1]] },
      }),
    ).toMatchObject({ status: 'applied' });
    expect(
      await send(read, { kind: 'view.update', viewId: read.view.id, config: { iconSets: changed } }),
    ).toMatchObject(rejected('iconSets'));
  });

  it('saves icon sets through the command bus, audits them, and refuses incompatible fields', async () => {
    const read = await readFixture(server, [{ type: 'text' }, { type: 'number' }]);
    const [text, number] = read.fields.map((field) => field.id) as [string, string];
    const iconSets = [
      {
        fieldId: number,
        style: 'flags',
        thresholds: [-5, 10],
        labels: ['Needs work', 'On track', 'Complete'],
      },
    ];
    expect(
      await send(read, { kind: 'view.update', viewId: read.view.id, config: { iconSets } }),
    ).toMatchObject({ status: 'applied' });
    const schema = await server.app.inject({
      url: `/api/databases/${read.table.databaseId}/schema`,
      headers: server.owner.headers,
    });
    expect(
      DatabaseSchema.parse(schema.json()).views.find((view) => view.id === read.view.id)!.config.iconSets,
    ).toEqual(iconSets);
    const audit = await query(
      server.pool,
      sql`SELECT action FROM ${ident(server.schemas.audit, 'events')}
      WHERE action = 'data.view.updated' AND metadata->>'databaseId' = ${read.table.databaseId}`,
    );
    expect(audit.rows).toHaveLength(1);
    for (const fieldId of [text, newId('field')])
      expect(
        await send(read, {
          kind: 'view.update',
          viewId: read.view.id,
          config: { iconSets: [{ fieldId, thresholds: [0, 10] }] },
        }),
      ).toMatchObject(rejected('iconSets'));
    await send(read, { kind: 'field.trash', fieldId: number });
    expect(
      await send(read, { kind: 'view.update', viewId: read.view.id, config: { rowHeight: 'medium' } }),
    ).toMatchObject({ status: 'applied' });
  });
  it('saves rules, scales, and bars, and refuses scales and bars their fields can’t have', async () => {
    const choice = newId('choice');
    const read = await readFixture(server, [
      { type: 'text' },
      { type: 'number' },
      { type: 'date' },
      { type: 'singleSelect', options: { choices: [{ id: choice, name: 'Done', color: 'green' }] } },
    ]);
    const [text, number, date, status] = read.fields.map((field) => field.id) as [
      string,
      string,
      string,
      string,
    ];
    const colors = {
      colorRules: [
        {
          id: 'done',
          name: 'Finished',
          target: 'record',
          condition: { id: 'c', fieldId: status, operator: 'is', value: choice },
          color: 'green',
        },
        {
          id: 'blank',
          target: 'cell',
          condition: { id: 'c', fieldId: text, operator: 'isEmpty' },
          color: 'red',
        },
      ],
      colorScales: [
        { fieldId: number, stops: [{ color: 'red' }, { color: 'yellow', value: 50 }, { color: 'green' }] },
        { fieldId: date, stops: [{ color: 'gray', value: '2026-01-01' }, { color: 'blue' }] },
      ],
      dataBars: [{ fieldId: number, color: 'teal', showValue: false }],
    };
    expect(await send(read, { kind: 'view.update', viewId: read.view.id, config: colors })).toMatchObject({
      status: 'applied',
    });
    const response = await server.app.inject({
      url: `/api/databases/${read.table.databaseId}/schema`,
      headers: server.owner.headers,
    });
    const saved = DatabaseSchema.parse(response.json()).views.find((view) => view.id === read.view.id)!;
    expect(saved.config.colorRules.map((rule) => [rule.id, rule.name])).toEqual([
      ['done', 'Finished'],
      ['blank', ''],
    ]);
    expect(saved.config.colorScales[1]).toEqual({
      fieldId: date,
      stops: [
        { color: 'gray', value: '2026-01-01' },
        { color: 'blue', value: null },
      ],
    });
    expect(saved.config.dataBars).toEqual(colors.dataBars);
    // Other changes to the view keep its colors.
    expect(
      await send(read, { kind: 'view.update', viewId: read.view.id, config: { rowHeight: 'tall' } }),
    ).toMatchObject({
      status: 'applied',
    });

    const scale = (fieldId: string, value: unknown = null) => ({
      colorScales: [{ fieldId, stops: [{ color: 'red', value }, { color: 'green' }] }],
    });
    for (const [config, setting] of [
      [scale(text), 'colorScales'],
      [scale(status), 'colorScales'],
      [scale(number, '2026-01-01'), 'colorScales'],
      [scale(date, 5), 'colorScales'],
      [scale(newId('field')), 'colorScales'],
      [{ dataBars: [{ fieldId: date }] }, 'dataBars'],
      [{ dataBars: [{ fieldId: newId('field') }] }, 'dataBars'],
      [
        {
          colorRules: [
            {
              id: 'r',
              target: 'cell',
              condition: { id: 'c', fieldId: newId('field'), operator: 'isEmpty' },
              color: 'red',
            },
          ],
        },
        'colorRules',
      ],
    ] as const)
      expect(await send(read, { kind: 'view.update', viewId: read.view.id, config })).toMatchObject(
        rejected(setting),
      );
  });

  it('keeps a trashed field’s colors, so restoring the field restores them', async () => {
    const read = await readFixture(server, [{ type: 'text' }, { type: 'number' }]);
    const number = read.fields[1]!.id;
    const config = {
      dataBars: [{ fieldId: number }],
      colorScales: [{ fieldId: number, stops: [{ color: 'red' }, { color: 'green' }] }],
    };
    expect(await send(read, { kind: 'view.update', viewId: read.view.id, config })).toMatchObject({
      status: 'applied',
    });
    expect(await send(read, { kind: 'field.trash', fieldId: number })).toMatchObject({ status: 'applied' });
    expect(
      await send(read, { kind: 'view.update', viewId: read.view.id, config: { rowHeight: 'medium' } }),
    ).toMatchObject({
      status: 'applied',
    });
  });
});

describe('view ranges', () => {
  it('span every record the view admits, not only a page, and follow changes', async () => {
    const read = await readFixture(
      server,
      [
        { type: 'text' },
        { type: 'number' },
        { type: 'currency' },
        { type: 'date' },
        { type: 'date', options: { includeTime: true } },
        { type: 'rating' },
      ],
      {},
    );
    const [text, number, currency, day, moment, rating] = read.fields.map((field) => field.id) as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    expect(await send(read, { kind: 'view.update', viewId: read.view.id, config: keep(text) })).toMatchObject(
      {
        status: 'applied',
      },
    );
    const records = await insert(read, [
      {
        [text]: 'keep',
        [number]: 12.5,
        [currency]: 3.25,
        [day]: '2026-03-01',
        [moment]: '2026-03-01T08:00:00Z',
      },
      { [text]: 'keep', [number]: -4, [currency]: 10, [day]: '2025-12-31', [moment]: '2026-05-02T23:30:00Z' },
      { [text]: 'keep', [number]: null },
      { [text]: 'omit', [number]: 1_000, [currency]: -50, [day]: '2020-01-01' },
      { [text]: 'keep', [number]: 99, [day]: '2030-01-01' },
    ]);
    expect(
      await send(read, { kind: 'record.trash', tableId: read.table.id, recordIds: [records[4]] }),
    ).toMatchObject({
      status: 'applied',
    });
    const response = await ranges(read, [number, currency, day, moment, rating, text, number]);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<ViewRanges>().ranges).toEqual([
      { fieldId: number, min: -4, max: 12.5 },
      { fieldId: currency, min: 3.25, max: 10 },
      { fieldId: day, min: '2025-12-31', max: '2026-03-01' },
      { fieldId: moment, min: '2026-03-01T08:00:00.000Z', max: '2026-05-02T23:30:00.000Z' },
      { fieldId: rating, min: null, max: null },
    ]);
    await insert(read, [{ [text]: 'keep', [number]: 40 }]);
    expect((await ranges(read, [number])).json<ViewRanges>().ranges).toEqual([
      { fieldId: number, min: -4, max: 40 },
    ]);
  });

  it('apply the reader’s access and refuse malformed requests', async () => {
    const read = await readFixture(server, [{ type: 'number' }]);
    const number = read.fields[0]!.id;
    await insert(read, [{ [number]: 7 }, { [number]: 3 }]);
    const stranger = await server.addMember();
    expect((await ranges(read, [number], stranger)).statusCode).toBe(404);
    const reader = await server.addMember();
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
      (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
      VALUES (${read.table.orgId}, 'database', ${read.table.databaseId}, 'user', ${reader.userId}, 'reader')`,
    );
    const allowed = await ranges(read, [number], reader);
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(allowed.json<ViewRanges>().ranges).toEqual([{ fieldId: number, min: 3, max: 7 }]);
    // Another table's field isn't this view's to measure.
    const other = await readFixture(server, [{ type: 'number' }]);
    expect((await ranges(read, [other.fields[0]!.id])).json<ViewRanges>()).toEqual({ ranges: [] });
    const missing = await server.app.inject({
      url: `/api/views/${newId('view')}/ranges?fields=${number}`,
      headers: server.owner.headers,
    });
    expect(missing.statusCode).toBe(404);
    for (const search of ['', 'fields=', 'fields=amount', `fields=${number}&tz=Mars/Olympus`]) {
      const response = await server.app.inject({
        url: `/api/views/${read.view.id}/ranges?${search}`,
        headers: server.owner.headers,
      });
      expect(response.statusCode, search).toBe(422);
    }
    const signedOut = await server.app.inject({ url: `/api/views/${read.view.id}/ranges?fields=${number}` });
    expect(signedOut.statusCode).toBe(401);
  });
});
