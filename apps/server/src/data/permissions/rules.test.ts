import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CURRENT_PERSON, newId, type RowData, type RowsPage } from '@riosoma/contracts';
import { compile, ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../../test/fixture.js';
import { AccessScope } from '../access.js';
import { applied, inject, schemaOf } from './permissions.test-helpers.js';

/**
 * How record rules decide: several rules together, the current person, people no rule names, a
 * rule whose condition can't be read, and a rule that reads through the very link a query follows.
 */

let kit: TestPostgres;
let server: ServerFixture;
let editor: SignedIn;
let other: SignedIn;
let reader: SignedIn;

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'permrules');
  editor = await server.addMember({ name: 'Eve Editor' });
  other = await server.addMember({ name: 'Otto Other' });
  reader = await server.addMember({ name: 'Rita Reader' });
}, 120_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

async function grant(databaseId: string, who: SignedIn, role: string) {
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
    (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${server.owner.info.org.id}, 'database', ${databaseId}, 'user', ${who.userId}, ${role})`,
  );
}

async function names(who: SignedIn, viewId: string): Promise<string[]> {
  const response = await inject(server, who, 'GET', `/api/views/${viewId}/rows?limit=100`);
  expect(response.statusCode, response.body).toBe(200);
  return response
    .json<RowsPage>()
    .rows.filter((row): row is RowData => row !== null)
    .map((row) => String(Object.values(row.values).find((value) => typeof value === 'string')))
    .sort();
}

async function rules(tableId: string, list: unknown[]) {
  const response = await inject(server, server.owner, 'PUT', `/api/tables/${tableId}/record-rules`, {
    rules: list,
  });
  expect(response.statusCode, response.body).toBe(200);
}

/** People who report to one another, with an owner field and a tag. */
async function org() {
  const databaseId = newId('database');
  const tableId = newId('table');
  const viewId = newId('view');
  const f = { name: newId('field'), owner: newId('field'), tag: newId('field'), manager: newId('field') };
  const created = await inject(server, server.owner, 'POST', '/api/databases', {
    id: databaseId,
    name: 'Org',
    table: {
      id: tableId,
      name: 'People',
      fields: [{ id: f.name, name: 'Name', type: 'text' }],
      view: { id: viewId, name: 'Everyone' },
      records: [],
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  const run = (input: Record<string, unknown>) => applied(server, server.owner, databaseId, input);
  const field = (id: string, name: string, type: string, options: unknown = {}) =>
    run({ kind: 'field.create', tableId, field: { id, name, type, description: '', options } });
  await field(f.owner, 'Owner', 'user');
  await field(f.tag, 'Tag', 'text');
  await field(f.manager, 'Reports to', 'link', { linkedTableId: tableId });
  const [boss, alice, bob, eve] = [newId('record'), newId('record'), newId('record'), newId('record')];
  await run({
    kind: 'record.create',
    tableId,
    records: [
      { id: boss, values: { [f.name]: 'Boss', [f.tag]: 'lead' } },
      { id: alice, values: { [f.name]: 'Alice', [f.manager]: [boss], [f.owner]: [editor.userId] } },
      { id: bob, values: { [f.name]: 'Bob', [f.manager]: [alice], [f.tag]: 'lead' } },
      { id: eve, values: { [f.name]: 'Eve', [f.owner]: [other.userId] } },
    ],
  });
  for (const [who, role] of [
    [editor, 'editor'],
    [other, 'editor'],
    [reader, 'reader'],
  ] as const)
    await grant(databaseId, who, role);
  return { databaseId, tableId, viewId, f, records: { boss, alice, bob, eve } };
}

const condition = (fieldId: string, operator: string, value: unknown) => ({
  conjunction: 'and',
  conditions: [{ id: 'c', fieldId, operator, value }],
});

describe('record rules', () => {
  it('combine with OR, follow the current person, and leave people no rule names alone', async () => {
    const o = await org();
    await rules(o.tableId, [
      {
        id: newId('recordRule'),
        roles: ['editor'],
        users: [],
        condition: condition(o.f.owner, 'hasAnyOf', [CURRENT_PERSON]),
      },
      {
        id: newId('recordRule'),
        roles: [],
        users: [editor.userId],
        condition: condition(o.f.tag, 'is', 'lead'),
      },
    ]);
    expect(await names(editor, o.viewId)).toEqual(['Alice', 'Bob', 'Boss']);
    expect(await names(other, o.viewId)).toEqual(['Eve']);
    expect(await names(reader, o.viewId)).toEqual(['Alice', 'Bob', 'Boss', 'Eve']);
    expect(await names(server.owner, o.viewId)).toEqual(['Alice', 'Bob', 'Boss', 'Eve']);
  });

  it('show someone with no role in the database no records at all', async () => {
    const o = await org();
    await rules(o.tableId, [
      {
        id: newId('recordRule'),
        roles: ['editor'],
        users: [],
        condition: condition(o.f.tag, 'is', 'lead'),
      },
    ]);
    const stranger = await server.addMember({ name: 'Sid Stranger' });
    const scope = new AccessScope(server.pool, server.schemas, {
      userId: stranger.userId,
      orgId: stranger.info.org.id,
      sessionId: '',
      kind: 'member',
      adminRoles: [],
      csrfToken: '',
    });
    await scope.prepare(o.databaseId);
    expect(compile(scope.recordPredicate(o.tableId)).text.trim()).toBe('FALSE');
    expect(scope.limitsRecords(o.tableId)).toBe(true);
  });

  it('match nothing when a condition can’t be read, rather than everything', async () => {
    const o = await org();
    await rules(o.tableId, [
      { id: newId('recordRule'), roles: ['editor'], users: [], condition: condition(o.f.tag, 'is', 'lead') },
    ]);
    expect(await names(editor, o.viewId)).toEqual(['Bob', 'Boss']);
    await applied(server, server.owner, o.databaseId, { kind: 'field.trash', fieldId: o.f.tag });
    expect(await names(editor, o.viewId)).toEqual([]);
    expect(await names(reader, o.viewId)).toEqual(['Alice', 'Bob', 'Boss', 'Eve']);
  });

  it('read a link to the same table under the rule’s own name, so the rule checks the linked record', async () => {
    const o = await org();
    // Editors see the people who report to Boss.
    await rules(o.tableId, [
      {
        id: newId('recordRule'),
        roles: ['editor'],
        users: [],
        condition: condition(o.f.manager, 'contains', 'Boss'),
      },
    ]);
    expect(await names(editor, o.viewId)).toEqual(['Alice']);
    const inverse = (await schemaOf(server, server.owner, o.databaseId)).fields.find(
      (field) => field.type === 'link' && field.id !== o.f.manager,
    )!.id;
    const response = await inject(
      server,
      editor,
      'GET',
      `/api/tables/${o.tableId}/records/${o.records.alice}`,
    );
    const alice = response.json<RowData>();
    // Boss and Bob are outside the rule, so Alice's links to them are only counted.
    expect(alice.values[o.f.manager]).toEqual([]);
    expect(alice.values[inverse]).toEqual([]);
    expect(alice.hiddenLinks).toEqual({ [o.f.manager]: 1, [inverse]: 1 });
    // A linked record inside the rule shows, which it could only do if the rule checked that
    // record's own manager rather than the record doing the linking.
    const [junior, xavier] = [newId('record'), newId('record')];
    await applied(server, server.owner, o.databaseId, {
      kind: 'record.create',
      tableId: o.tableId,
      records: [
        { id: junior, values: { [o.f.name]: 'Boss Junior', [o.f.manager]: [o.records.boss] } },
        { id: xavier, values: { [o.f.name]: 'Xavier', [o.f.manager]: [junior] } },
      ],
    });
    expect(await names(editor, o.viewId)).toEqual(['Alice', 'Boss Junior', 'Xavier']);
    const read = async (id: string) =>
      (await inject(server, editor, 'GET', `/api/tables/${o.tableId}/records/${id}`)).json<RowData>();
    const x = await read(xavier);
    expect(x.values[o.f.manager]).toEqual([junior]);
    expect(x.hiddenLinks).toBeUndefined();
    const j = await read(junior);
    expect(j.values[o.f.manager]).toEqual([]);
    expect(j.values[inverse]).toEqual([xavier]);
    expect(j.hiddenLinks).toEqual({ [o.f.manager]: 1 });
  });
});
