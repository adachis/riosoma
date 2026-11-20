import { afterAll, beforeAll, expect, it } from 'vitest';
import { joinedFieldSpec, newId, type Change, type RowsPage, type SharedViewLink } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { changeFor } from '../../realtime/redact.js';
import { startServer, type ServerFixture, type SignedIn } from '../../test/fixture.js';
import { AccessScope } from '../access.js';
import {
  applied,
  inject,
  permissionFixture,
  SALARY,
  schemaOf,
  type PermissionFixture,
} from './permissions.test-helpers.js';

let kit: TestPostgres;
let server: ServerFixture;
let f: PermissionFixture;

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'joined_permissions');
  f = await permissionFixture(server);
}, 60_000);

afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

const run = (input: Record<string, unknown>) => applied(server, server.owner, f.databaseId, input);

async function rows(viewId: string, who: SignedIn = server.owner) {
  const response = await inject(server, who, 'GET', `/api/views/${viewId}/rows`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<RowsPage>().rows.filter((row) => row !== null);
}

async function project(tableId: string, nameId: string, fieldId: string, key: string) {
  const side = newId('table');
  const sideKey = newId('field');
  await run({
    kind: 'table.create',
    table: {
      id: side,
      name: side,
      fields: [{ id: sideKey, name: 'Key', type: 'text' }],
      view: { id: newId('view'), name: 'Grid' },
    },
  });
  await run({
    kind: 'record.create',
    tableId: side,
    records: [{ id: newId('record'), values: { [sideKey]: key } }],
  });
  const schema = await schemaOf(server, server.owner, f.databaseId);
  const source = schema.fields.find((field) => field.id === fieldId)!;
  const id = newId('table');
  const name = newId('field');
  const value = newId('field');
  const view = newId('view');
  await run({
    kind: 'table.create',
    table: {
      id,
      name: id,
      fields: [
        { id: name, name: 'Name', type: 'text' },
        { id: value, name: 'Projected value', ...joinedFieldSpec(source) },
      ],
      view: { id: view, name: 'Grid' },
      joined: {
        baseTableId: tableId,
        steps: [
          { tableId: side, leftTableId: tableId, leftFieldId: nameId, rightFieldId: sideKey, kind: 'inner' },
        ],
        fields: [
          { tableId, fieldId: nameId, outputFieldId: name },
          { tableId, fieldId, outputFieldId: value },
        ],
      },
    },
  });
  return { id, name, value, view };
}

it('excludes restricted inputs from public joined views through multiple mappings', async () => {
  const first = await project(f.people.tableId, f.people.fields.name, f.people.fields.salary, 'Ana West');
  const second = await project(first.id, first.name, first.value, 'Ana West');
  for (const joined of [first, second]) {
    expect((await rows(joined.view))[0]?.values[joined.value]).toBe(SALARY.ana);
    const published = await inject(server, server.owner, 'PUT', `/api/views/${joined.view}/shared-view`);
    expect(published.statusCode, published.body).toBe(200);
    const { linkId } = published.json<SharedViewLink>();
    const response = await server.app.inject({ url: `/api/public/views/${linkId}/rows` });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<RowsPage>().rows[0]?.values).toEqual({ [joined.name]: 'Ana West' });
    const explicit = await inject(server, server.owner, 'PATCH', `/api/views/${joined.view}/shared-view`, {
      fieldIds: [joined.name, joined.value],
    });
    expect(explicit.json().error?.messageKey).toBe('data.access.restrictedShare');
  }
});

it('carries hidden fields through a joined mapping, a rollup, and another joined mapping', async () => {
  const first = await project(f.people.tableId, f.people.fields.name, f.people.fields.salary, 'Ana West');
  const link = newId('field');
  const rollup = newId('field');
  await run({
    kind: 'field.create',
    tableId: f.teams.tableId,
    field: { id: link, name: 'Joined people', type: 'link', options: { linkedTableId: first.id } },
  });
  await run({
    kind: 'field.create',
    tableId: f.teams.tableId,
    field: {
      id: rollup,
      name: 'Joined total',
      type: 'rollup',
      options: { linkFieldId: link, targetFieldId: first.value, fn: 'sum' },
    },
  });
  await run({
    kind: 'record.update',
    tableId: f.teams.tableId,
    records: [{ id: f.teams.records.alpha, values: { [link]: [(await rows(first.view))[0]!.id] } }],
  });
  const second = await project(f.teams.tableId, f.teams.fields.name, rollup, 'Alpha');
  expect((await rows(second.view))[0]?.values[second.value]).toBe(SALARY.ana);
  const reader = f.persons.creator.signed;
  expect((await rows(first.view, reader))[0]?.values).not.toHaveProperty(first.value);
  expect((await rows(f.teams.viewId, reader))[0]?.values).not.toHaveProperty(rollup);
  expect((await rows(second.view, reader))[0]?.values).toEqual({ [second.name]: 'Alpha' });
  const schema = await schemaOf(server, reader, f.databaseId);
  expect(schema.fields.map((field) => field.id)).not.toContain(second.value);
});

it('rereads realtime override sources through recipient access and preserves clearing notifications', async () => {
  const fieldId = f.teams.fields.names;
  await run({ kind: 'table.update', tableId: f.teams.tableId, allowComputedOverrides: true });
  await run({
    kind: 'record.update',
    tableId: f.teams.tableId,
    records: [{ id: f.teams.records.alpha, values: { [fieldId]: ['Pinned'] } }],
  });
  const stored = (await rows(f.teams.viewId))[0]!;
  expect(stored.overrides?.[fieldId]?.source).toContain('Zanzibar East');
  const person = f.persons.editor.signed;
  const scope = new AccessScope(server.pool, server.schemas, {
    userId: person.userId,
    orgId: person.info.org.id,
    sessionId: newId('session'),
    kind: 'member',
    adminRoles: [],
    csrfToken: '',
  });
  await scope.require(f.databaseId, 'read');
  const change: Change = {
    kind: 'record.updated',
    databaseId: f.databaseId,
    seq: 1,
    commandId: newId('command'),
    groupId: newId('action'),
    actorId: server.owner.userId,
    clientId: null,
    at: stored.updatedAt,
    tableId: f.teams.tableId,
    records: [{ ...stored, values: { [fieldId]: stored.values[fieldId]! } }],
  };
  const redacted = await changeFor(server.pool, server.schemas, scope, f.databaseId, change);
  expect(redacted?.kind).toBe('record.updated');
  if (redacted?.kind !== 'record.updated') throw new Error('expected an updated record');
  const scoped = (await rows(f.teams.viewId, person))[0]!;
  expect(redacted.records[0]?.overrides?.[fieldId]).toEqual(scoped.overrides?.[fieldId]);
  expect(JSON.stringify(redacted)).not.toContain('Zanzibar');
  expect(JSON.stringify(redacted)).not.toContain('Zulu');
  await run({
    kind: 'record.clearOverrides',
    tableId: f.teams.tableId,
    records: [{ id: stored.id, fieldIds: [fieldId] }],
  });
  const cleared = await changeFor(server.pool, server.schemas, scope, f.databaseId, {
    ...change,
    records: [{ ...change.records[0]!, overrides: { [fieldId]: null } }],
  });
  expect(cleared?.kind === 'record.updated' && cleared.records[0]?.overrides).toEqual({ [fieldId]: null });
});

it('hides joined link projections when linked records are restricted', async () => {
  const joined = await project(f.teams.tableId, f.teams.fields.name, f.teams.fields.people, 'Alpha');
  const ownerValue = (await rows(joined.view))[0]?.values[joined.value];
  expect(String(ownerValue)).toContain(f.people.records.zanzibar);
  expect((await rows(f.teams.viewId, f.persons.editor.signed))[0]?.values[f.teams.fields.people]).toEqual([
    f.people.records.ana,
  ]);
  expect((await rows(joined.view, f.persons.editor.signed))[0]?.values).toEqual({ [joined.name]: 'Alpha' });
  expect((await rows(joined.view, f.persons.creator.signed))[0]?.values[joined.value]).toEqual(ownerValue);
});
