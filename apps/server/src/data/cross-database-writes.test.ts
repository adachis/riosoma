import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  newId,
  type LinkTarget,
  type RowData,
  type ServerMessage,
  type TokenCreated,
  type TokenScope,
} from '@riosoma/contracts';
import type { FastifyRequest } from 'fastify';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { AccessScope } from './access.js';
import { actorFor } from '../automations/run.js';
import { RecordReader } from '../api-v1/reads.js';
import { callTool } from '../mcp/tools.js';
import { RioTools } from '../ai/tools.js';
import { RealtimeHub, type RealtimeTab } from '../realtime/hub.js';
import {
  applied,
  command,
  inject,
  permissionFixture,
  schemaOf,
  type PermissionFixture,
} from './permissions/permissions.test-helpers.js';

let kit: TestPostgres;
let server: ServerFixture;
let f: PermissionFixture;
let sourceId: string;

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'crosswrites');
  f = await permissionFixture(server);
  sourceId = newId('database');
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'databases')} (id, org_id, name)
    VALUES (${sourceId}, ${server.owner.info.org.id}, 'Projects')`,
  );
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'tables')} SET database_id = ${sourceId}
    WHERE id = ${f.teams.tableId}`,
  );
  for (const who of [server.owner, f.persons.editor.signed])
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
      (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
      VALUES (${who.info.org.id}, 'database', ${sourceId}, 'user', ${who.userId}, 'owner')`,
    );
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
    (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${server.owner.info.org.id}, 'database', ${sourceId}, 'user', ${f.persons.hr.signed.userId}, 'reader')`,
  );
}, 120_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

async function record(tableId: string, id: string, who = server.owner) {
  const response = await inject(server, who, 'GET', `/api/tables/${tableId}/records/${id}`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<RowData>();
}
async function reverse(groupId: string, direction: 'undo' | 'redo', who = server.owner) {
  const response = await inject(server, who, 'POST', `/api/databases/${sourceId}/${direction}`, {
    commandId: newId('command'),
    groupId,
    clientId: newId('client'),
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({ status: 'applied', skipped: 0 });
}

it('lists editable destinations with structure rights and hides unreadable destination metadata', async () => {
  const response = await inject(server, f.persons.editor.signed, 'GET', '/api/link-targets');
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json<LinkTarget[]>()).toContainEqual(
    expect.objectContaining({
      table: expect.objectContaining({ id: f.people.tableId }),
      database: expect.objectContaining({ id: f.databaseId }),
      canEditSchema: false,
    }),
  );
  const reader = await inject(server, f.persons.reader.signed, 'GET', '/api/link-targets');
  expect(reader.json()).toEqual([]);
  const denied = await inject(
    server,
    f.persons.reader.signed,
    'GET',
    `/api/tables/${f.teams.tableId}/link-target`,
  );
  expect(denied.statusCode).toBe(404);
});

it('creates an undoable one-way link without changing the destination schema or records', async () => {
  const who = f.persons.editor.signed;
  const fieldId = newId('field');
  const before = await schemaOf(server, server.owner, f.databaseId);
  const createGroup = newId('action');
  await applied(server, who, sourceId, {
    kind: 'field.create',
    groupId: createGroup,
    tableId: f.teams.tableId,
    field: {
      id: fieldId,
      name: 'One-way people',
      type: 'link',
      options: { linkedTableId: f.people.tableId, oneWay: true },
    },
  });
  const source = await schemaOf(server, who, sourceId);
  expect(source.fields.find((field) => field.id === fieldId)).toMatchObject({
    options: { inverseFieldId: null, oneWay: true },
  });
  expect((await schemaOf(server, server.owner, f.databaseId)).fields).toEqual(before.fields);
  const targetBefore = await record(f.people.tableId, f.people.records.ana);
  const groupId = newId('action');
  await applied(server, who, sourceId, {
    kind: 'record.update',
    groupId,
    tableId: f.teams.tableId,
    records: [{ id: f.teams.records.alpha, values: { [fieldId]: [f.people.records.ana] } }],
  });
  expect((await record(f.teams.tableId, f.teams.records.alpha, who)).values[fieldId]).toEqual([
    f.people.records.ana,
  ]);
  expect(await record(f.people.tableId, f.people.records.ana)).toEqual(targetBefore);
  await reverse(groupId, 'undo', who);
  expect((await record(f.teams.tableId, f.teams.records.alpha, who)).values[fieldId]).toEqual([]);
  await reverse(groupId, 'redo', who);
  expect((await record(f.teams.tableId, f.teams.records.alpha, who)).values[fieldId]).toEqual([
    f.people.records.ana,
  ]);
  const hidden = await command(server, who, sourceId, {
    kind: 'record.update',
    tableId: f.teams.tableId,
    records: [{ id: f.teams.records.alpha, values: { [fieldId]: [f.people.records.zulu] } }],
  });
  expect(hidden.status).toBe('rejected');
  await reverse(createGroup, 'undo', who);
  expect((await schemaOf(server, who, sourceId)).fields.some((field) => field.id === fieldId)).toBe(false);
  await reverse(createGroup, 'redo', who);
  expect((await record(f.teams.tableId, f.teams.records.alpha, who)).values[fieldId]).toEqual([
    f.people.records.ana,
  ]);
  const rejected = await command(server, f.persons.reader.signed, f.databaseId, {
    kind: 'field.create',
    tableId: f.people.tableId,
    field: {
      id: newId('field'),
      name: 'Denied source',
      type: 'link',
      options: { linkedTableId: f.teams.tableId, oneWay: true },
    },
  });
  expect(rejected).toMatchObject({ status: 'rejected', error: { code: 'forbidden' } });
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'grants')} SET role = 'reader'
    WHERE resource_kind = 'database' AND resource_id = ${f.databaseId} AND principal_id = ${who.userId}`,
  );
  try {
    const denied = await command(server, who, sourceId, {
      kind: 'field.create',
      tableId: f.teams.tableId,
      field: {
        id: newId('field'),
        name: 'Denied target',
        type: 'link',
        options: { linkedTableId: f.people.tableId, oneWay: true },
      },
    });
    expect(denied).toMatchObject({ status: 'rejected', error: { code: 'forbidden' } });
    const write = await command(server, who, sourceId, {
      kind: 'record.update',
      tableId: f.teams.tableId,
      records: [{ id: f.teams.records.alpha, values: { [fieldId]: [] } }],
    });
    expect(write).toMatchObject({ status: 'rejected', error: { code: 'forbidden' } });
  } finally {
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'grants')} SET role = 'editor'
      WHERE resource_kind = 'database' AND resource_id = ${f.databaseId} AND principal_id = ${who.userId}`,
    );
  }
});

it('accepts and returns cross-database link values through REST, protocol tools, and Rio plans', async () => {
  const fieldId = newId('field');
  await applied(server, server.owner, sourceId, {
    kind: 'field.create',
    tableId: f.teams.tableId,
    field: {
      id: fieldId,
      name: 'External people',
      type: 'link',
      options: { linkedTableId: f.people.tableId },
    },
  });
  const issued = await inject(server, server.owner, 'POST', '/api/tokens', {
    name: 'Cross-database access',
    scopes: ['data.records:read', 'data.records:write'],
    databases: 'all',
  });
  expect(issued.statusCode, issued.body).toBe(200);
  const token = issued.json<TokenCreated>();
  const updated = await server.app.inject({
    method: 'PATCH',
    url: `/api/v1/tables/${f.teams.tableId}/records`,
    headers: { authorization: `Bearer ${token.token}` },
    payload: {
      fieldKey: 'id',
      records: [{ id: f.teams.records.alpha, fields: { [fieldId]: [f.people.records.ana] } }],
    },
  });
  expect(updated.statusCode, updated.body).toBe(200);
  expect(updated.json().records[f.teams.records.alpha][fieldId]).toEqual([f.people.records.ana]);
  const actor = (await actorFor(server.pool, server.schemas, server.owner.userId, server.owner.info.org.id))!;
  const request = { actor, log: server.app.log, headers: {} } as unknown as FastifyRequest;
  const context = {
    app: server.app,
    request,
    reader: new RecordReader(server.app),
    actor: {
      ...actor,
      token: {
        id: token.id,
        databases: null,
        scopes: ['data.records:read', 'data.records:write'] as TokenScope[],
      },
    },
  };
  const read = await callTool(context, 'find_records', { tableId: f.teams.tableId });
  expect(read.isError).toBeUndefined();
  expect(read.structuredContent?.records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        fields: expect.objectContaining({ 'External people': [f.people.records.ana] }),
      }),
    ]),
  );
  const saved = await callTool(context, 'update_records', {
    tableId: f.teams.tableId,
    records: [{ id: f.teams.records.alpha, fields: { 'External people': [] } }],
  });
  expect(saved.isError).toBeUndefined();
  const conversation = await inject(server, server.owner, 'POST', '/api/rio/conversations');
  expect(conversation.statusCode, conversation.body).toBe(200);
  const panel = new RioTools(
    server.app,
    { ...request, actor } as FastifyRequest,
    conversation.json<{ id: string }>().id,
    'instant',
    'instant',
  );
  const plan = await panel.run({
    id: newId('command'),
    name: 'propose_changes',
    arguments: {
      databaseId: sourceId,
      summary: 'Link a person',
      steps: ['Set the contact'],
      commands: [
        {
          kind: 'record.update',
          tableId: f.teams.tableId,
          records: [{ id: f.teams.records.alpha, values: { [fieldId]: [f.people.records.ana] } }],
        },
      ],
    },
  });
  expect(plan.block?.kind).toBe('receipt');
  const result = await panel.run({
    id: newId('command'),
    name: 'find_records',
    arguments: { tableId: f.teams.tableId },
  });
  expect(result.data).toMatchObject({
    records: [expect.objectContaining({ [fieldId]: [f.people.records.ana] })],
  });
});

it('broadcasts paired additions and removals, audits both databases, and reverses both in one step', async () => {
  const fieldId = newId('field');
  await applied(server, server.owner, sourceId, {
    kind: 'field.create',
    tableId: f.teams.tableId,
    field: { id: fieldId, name: 'Paired people', type: 'link', options: { linkedTableId: f.people.tableId } },
  });
  const source = await schemaOf(server, server.owner, sourceId);
  const link = source.fields.find((field) => field.id === fieldId);
  if (link?.type !== 'link') throw new Error('Missing link');
  const inverseId = link.options.inverseFieldId!;
  const hub = new RealtimeHub(server.app);
  const sourceMessages: ServerMessage[] = [];
  const targetMessages: ServerMessage[] = [];
  function tab(who: SignedIn, messages: ServerMessage[]): RealtimeTab {
    const scope = new AccessScope(server.pool, server.schemas, {
      userId: who.userId,
      orgId: who.info.org.id,
      kind: 'member',
      sessionId: 'ses',
      csrfToken: '',
      adminRoles: [],
    });
    return {
      actor: scope.actor,
      clientId: newId('client'),
      name: 'Reader',
      open: true,
      send(message) {
        messages.push(message);
        return true;
      },
      terminate() {},
    };
  }
  const sourceTab = tab(server.owner, sourceMessages);
  const targetTab = tab(f.persons.hr.signed, targetMessages);
  hub.attach(sourceTab);
  hub.attach(targetTab);
  try {
    await hub.handle(sourceTab, { type: 'subscribe', databaseId: sourceId, sinceSeq: source.seq });
    await hub.handle(targetTab, {
      type: 'subscribe',
      databaseId: f.databaseId,
      sinceSeq: (await schemaOf(server, f.persons.hr.signed, f.databaseId)).seq,
    });
    sourceMessages.length = 0;
    targetMessages.length = 0;
    const audits = () =>
      query<{ database_id: string }>(
        server.pool,
        sql`SELECT metadata->>'databaseId' AS database_id
        FROM ${ident(server.schemas.audit, 'events')} WHERE metadata->>'tableId' IN (${f.teams.tableId}, ${f.people.tableId})
        AND action IN ('data.records.updated', 'data.records.linksChanged') ORDER BY id`,
      );
    for (const values of [[f.people.records.ana], []]) {
      const beforeAudit = (await audits()).rows.length;
      const groupId = newId('action');
      const result = await command(server, server.owner, sourceId, {
        kind: 'record.update',
        groupId,
        tableId: f.teams.tableId,
        records: [{ id: f.teams.records.alpha, values: { [fieldId]: values } }],
      });
      expect(result.status).toBe('applied');
      await vi.waitFor(() => {
        expect(sourceMessages).toContainEqual(
          expect.objectContaining({
            type: 'change',
            change: expect.objectContaining({ kind: 'record.updated', groupId }),
          }),
        );
        expect(targetMessages).toContainEqual(
          expect.objectContaining({
            type: 'change',
            change: expect.objectContaining({ kind: 'record.linksChanged', fieldId: inverseId, groupId }),
          }),
        );
      });
      const audit = await audits();
      expect(audit.rows.length).toBe(beforeAudit + 2);
      expect(new Set(audit.rows.slice(beforeAudit).map((event) => event.database_id))).toEqual(
        new Set([sourceId, f.databaseId]),
      );
      expect((await record(f.people.tableId, f.people.records.ana)).values[inverseId]).toEqual(
        values.length ? [f.teams.records.alpha] : [],
      );
      await reverse(groupId, 'undo');
      expect((await record(f.teams.tableId, f.teams.records.alpha)).values[fieldId]).toEqual(
        values.length ? [] : [f.people.records.ana],
      );
      expect((await record(f.people.tableId, f.people.records.ana)).values[inverseId]).toEqual(
        values.length ? [] : [f.teams.records.alpha],
      );
      await reverse(groupId, 'redo');
      expect((await record(f.people.tableId, f.people.records.ana)).values[inverseId]).toEqual(
        values.length ? [f.teams.records.alpha] : [],
      );
    }
  } finally {
    await hub.close();
  }
});
