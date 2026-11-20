import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DatabaseSchema,
  LIST_FIELD_COUNT,
  newId,
  type CommandBatchResult,
  type ViewType,
} from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import type { SnapshotRead } from './snapshots.js';
import { readFixture } from './snapshots.test-helpers.js';

let kit: TestPostgres;
let server: ServerFixture;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'listmap');
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

async function createView(read: SnapshotRead, type: ViewType, config: Record<string, unknown> = {}) {
  const id = newId('view');
  expect(
    await send(read, { kind: 'view.create', view: { id, name: id, tableId: read.table.id, type, config } }),
  ).toMatchObject({ status: 'applied' });
  return id;
}

async function schema(read: SnapshotRead) {
  const response = await server.app.inject({
    url: `/api/databases/${read.table.databaseId}/schema`,
    headers: server.owner.headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  return DatabaseSchema.parse(response.json());
}

function rejected(setting: string) {
  return { status: 'rejected', error: { messageKey: 'data.view.badSetting', params: { setting } } };
}

/** A table with one field of each kind the settings care about, and links to itself and elsewhere. */
async function fixture() {
  const read = await readFixture(server, [
    { type: 'text' },
    { type: 'singleSelect' },
    { type: 'user' },
    { type: 'user', options: { allowMultiple: true } },
    { type: 'location' },
    { type: 'number' },
    { type: 'multipleSelect' },
  ]);
  const [text, select, person, people, location, number, multiple] = read.fields.map((field) => field.id) as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const parent = newId('field');
  expect(
    await send(read, {
      kind: 'field.create',
      tableId: read.table.id,
      field: { id: parent, name: 'Parent', type: 'link', options: { linkedTableId: read.table.id } },
    }),
  ).toMatchObject({ status: 'applied' });
  const other = newId('table');
  expect(
    await send(read, {
      kind: 'table.create',
      table: {
        id: other,
        name: 'Teams',
        fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
        view: { id: newId('view'), name: 'Grid' },
      },
    }),
  ).toMatchObject({ status: 'applied' });
  const team = newId('field');
  expect(
    await send(read, {
      kind: 'field.create',
      tableId: read.table.id,
      field: { id: team, name: 'Team', type: 'link', options: { linkedTableId: other } },
    }),
  ).toMatchObject({ status: 'applied' });
  const foreign = (await readFixture(server, [{ type: 'location' }])).fields[0]!.id;
  return { read, text, select, person, people, location, number, multiple, parent, team, foreign };
}

describe('list and map settings', () => {
  it('check each field setting on creation and update, including foreign and unknown fields', async () => {
    const f = await fixture();
    const cases: Array<{ key: string; type: ViewType; good: string[]; bad: string[] }> = [
      {
        key: 'list.groupFieldId',
        type: 'list',
        good: [f.select, f.person, f.people, f.parent, f.team],
        bad: [f.text, f.location, f.number, f.multiple],
      },
      { key: 'orgChart.parentFieldId', type: 'orgChart', good: [f.parent], bad: [f.team, f.select, f.text] },
      { key: 'list.parentFieldId', type: 'list', good: [f.parent], bad: [f.team, f.select, f.text] },
      { key: 'map.locationFieldId', type: 'map', good: [f.location], bad: [f.text, f.number, f.select] },
      { key: 'map.colorFieldId', type: 'map', good: [f.select], bad: [f.multiple, f.person, f.location] },
    ];
    for (const test of cases) {
      const [section, key] = test.key.split('.') as [string, string];
      const viewId = await createView(f.read, test.type);
      for (const fieldId of [...test.bad, f.foreign, newId('field')]) {
        const config = { [section]: { [key]: fieldId } };
        expect(
          await send(f.read, {
            kind: 'view.create',
            view: {
              id: newId('view'),
              name: newId('view'),
              tableId: f.read.table.id,
              type: test.type,
              config,
            },
          }),
          `${test.key} ${fieldId}`,
        ).toMatchObject(rejected(test.key));
        expect(await send(f.read, { kind: 'view.update', viewId, config })).toMatchObject(rejected(test.key));
      }
      for (const fieldId of test.good) {
        const config = { [section]: { [key]: fieldId } };
        await createView(f.read, test.type, config);
        expect(await send(f.read, { kind: 'view.update', viewId, config })).toMatchObject({
          status: 'applied',
        });
      }
    }
  });

  it('refuses a list that groups and nests at once, and keeps each setting whole', async () => {
    const f = await fixture();
    const both = { list: { groupFieldId: f.select, parentFieldId: f.parent } };
    expect(
      await send(f.read, {
        kind: 'view.create',
        view: { id: newId('view'), name: 'Both', tableId: f.read.table.id, type: 'list', config: both },
      }),
    ).toMatchObject(rejected('list.parentFieldId'));
    const list = await createView(f.read, 'list', {
      list: { parentFieldId: f.parent, visibleFieldCount: 4 },
    });
    expect(await send(f.read, { kind: 'view.update', viewId: list, config: both })).toMatchObject(
      rejected('list.parentFieldId'),
    );
    const map = await createView(f.read, 'map', {
      map: { locationFieldId: f.location, colorFieldId: f.select },
      list: { groupFieldId: f.person },
    });
    // A patch replaces the whole key, so the count left out goes back to its default.
    expect(
      await send(f.read, { kind: 'view.update', viewId: list, config: { list: { groupFieldId: f.team } } }),
    ).toMatchObject({ status: 'applied' });
    const views = (await schema(f.read)).views;
    expect(views.find((view) => view.id === list)).toMatchObject({
      type: 'list',
      config: {
        list: { groupFieldId: f.team, parentFieldId: null, visibleFieldCount: LIST_FIELD_COUNT.default },
      },
    });
    expect(views.find((view) => view.id === map)).toMatchObject({
      type: 'map',
      config: {
        map: { locationFieldId: f.location, colorFieldId: f.select },
        list: { groupFieldId: f.person, parentFieldId: null },
      },
    });
  });

  it('keeps a trashed field’s settings, so restoring the field restores the view', async () => {
    const f = await fixture();
    const map = await createView(f.read, 'map', { map: { locationFieldId: f.location } });
    expect(await send(f.read, { kind: 'field.trash', fieldId: f.location })).toMatchObject({
      status: 'applied',
    });
    expect(
      await send(f.read, {
        kind: 'view.update',
        viewId: map,
        config: { map: { locationFieldId: f.location, colorFieldId: f.select } },
      }),
    ).toMatchObject({ status: 'applied' });
    expect(await send(f.read, { kind: 'field.restore', fieldId: f.location })).toMatchObject({
      status: 'applied',
    });
    expect((await schema(f.read)).views.find((view) => view.id === map)?.config.map).toEqual({
      locationFieldId: f.location,
      colorFieldId: f.select,
    });
  });
});
