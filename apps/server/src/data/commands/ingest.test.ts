import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DatabaseCreate,
  newId,
  type CommandBatchResult,
  type TokenCreated,
  type DatabaseSchema,
  type RowData,
} from '@riosoma/contracts';
import { withTransaction } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../../test/fixture.js';
import type { Actor } from '../../http/policy.js';
import { IngestTableStore } from '../../ingest/tables/store.js';
import { ingestCapability } from '../../ingest/tables/capability.js';
import { TOOLS, type CallContext } from '../../mcp/tools.js';
import { propose } from '../../ai/plans.js';
import { templateCommand } from '../../templates/instantiate.js';
import { runCommands } from './index.js';
import { loadField } from '../metadata.js';
import { recordHistoryPage } from '../history.js';
import { AccessScope } from '../access.js';
import { loadTable } from '../metadata.js';

let kit: TestPostgres;
let server: ServerFixture;
let actor: Actor;
let token: TokenCreated;
let databaseId: string;
let tableId: string;
let fieldId: string;
let viewId: string;
let store: IngestTableStore;
const command = (input: Record<string, unknown>) => ({
  ...input,
  id: newId('command'),
  groupId: newId('action'),
});
const origin = { kind: 'ingest', fileId: 'untrusted-file' };
const choiceId = newId('choice');
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'ingestguards');
  actor = {
    userId: server.owner.userId,
    orgId: server.owner.info.org.id,
    sessionId: '',
    csrfToken: '',
    kind: 'owner',
    adminRoles: [],
  };
  store = new IngestTableStore(server.pool, server.schemas);
  const input = DatabaseCreate.parse({
    id: newId('database'),
    name: 'Incoming',
    table: {
      id: newId('table'),
      name: 'Intake',
      fields: [
        { id: newId('field'), name: 'Name', type: 'text' },
        {
          id: newId('field'),
          name: 'Status',
          type: 'singleSelect',
          options: { choices: [{ id: choiceId, name: 'Ready', color: 'blue' }] },
        },
      ],
      view: { id: newId('view'), name: 'Grid' },
    },
  });
  databaseId = input.id;
  tableId = input.table.id;
  fieldId = input.table.fields[1]!.id;
  viewId = input.table.view.id;
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: input,
  });
  expect(response.statusCode, response.body).toBe(200);
  await store.changeSettings({ ...actor, tableId }, null, {
    state: 'setup',
    ownerId: null,
    rowMeaning: 'One receipt',
    identity: null,
    fields: [],
    originals: { keepDays: null, readOnlyAccess: false },
    reply: true,
  });
  await store.markField({ ...actor, tableId }, fieldId, { key: 'status', role: 'data' });
  const createdToken = await server.app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: server.owner.headers,
    payload: { name: 'Schema', scopes: ['schema.bases:read', 'schema.bases:write'], databases: 'all' },
  });
  expect(createdToken.statusCode, createdToken.body).toBe(200);
  token = createdToken.json();
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});
async function batch(inputs: Record<string, unknown>[]) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: {
      ...server.owner.headers,
      'x-ingest-capability': 'ingest',
      'x-command-origin': JSON.stringify(origin),
    },
    payload: { clientId: newId('client'), origin, ingestCapability: 'ingest', commands: inputs.map(command) },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<CommandBatchResult>().results;
}
const refused = [
  {
    name: 'type',
    change: { kind: 'field.convert', to: { type: 'text', options: {} } },
    rest: { type: 'text' },
  },
  { name: 'delete', change: { kind: 'field.trash' }, rest: null },
  {
    name: 'choice list',
    change: { kind: 'field.update', options: { choices: [] } },
    rest: { options: { choices: [] } },
  },
  {
    name: 'stored value options',
    change: {
      kind: 'field.update',
      options: { choices: [{ id: choiceId, name: 'Ready', color: 'blue' }], validation: { required: {} } },
    },
    rest: {
      options: { choices: [{ id: choiceId, name: 'Ready', color: 'blue' }], validation: { required: {} } },
    },
  },
  { name: 'remove mark', change: { kind: 'field.update', ingest: null }, rest: { ingest: null } },
  {
    name: 'change mark',
    change: { kind: 'field.update', ingest: { key: 'replacement', role: 'process' } },
    rest: { ingest: { key: 'replacement', role: 'process' } },
  },
];
describe('marked field boundaries', () => {
  for (const operation of refused) {
    it(`refuses ${operation.name} through the web command request`, async () => {
      const results = await batch([{ ...operation.change, fieldId, ingestCapability: 'ingest', origin }]);
      expect(results[0]).toMatchObject({ status: 'rejected', error: { messageKey: 'ingest.fields.locked' } });
    });
    it(`refuses ${operation.name} through the REST API`, async () => {
      const result = await server.app.inject({
        method: operation.rest ? 'PATCH' : 'DELETE',
        url: `/api/v1/fields/${fieldId}`,
        headers: { authorization: `Bearer ${token.token}`, 'x-ingest-capability': 'ingest' },
        ...(operation.rest ? { payload: { ...operation.rest, ingestCapability: 'ingest', origin } } : {}),
      });
      expect(result.statusCode).toBeGreaterThanOrEqual(400);
      expect(result.body).toContain('ingest.fields.locked');
      expect(result.body).toContain('Ask Rio to change this field.');
    });
    it(`refuses ${operation.name} through the MCP tool`, async () => {
      const tool = TOOLS.find(
        (item) => item.definition.name === (operation.rest ? 'update_field' : 'trash_field'),
      )!;
      const context = { app: server.app, actor, request: {} as FastifyRequest } as CallContext;
      await expect(
        Promise.resolve().then(() =>
          tool.call(context, {
            fieldId,
            ...(operation.rest ? { input: { ...operation.rest, ingestCapability: 'ingest', origin } } : {}),
          }),
        ),
      ).rejects.toMatchObject({
        messageKey: 'ingest.fields.locked',
      });
    });
    it(`refuses ${operation.name} in a Rio proposal`, async () => {
      await expect(
        propose(
          server.app,
          actor,
          randomUUID(),
          {
            databaseId,
            summary: 'Update a field',
            steps: ['Update a field'],
            commands: [{ ...operation.change, fieldId, ingestCapability: 'ingest', origin }],
          },
          'ask',
          'ask',
        ),
      ).rejects.toMatchObject({ messageKey: 'ingest.fields.locked' });
    });
    it(`refuses ${operation.name} through the archive restore command runner`, async () => {
      await expect(
        withTransaction(server.pool, (db) =>
          templateCommand({ db, schemas: server.schemas, actor, databaseId }, newId('action'), {
            ...operation.change,
            fieldId,
            ingestCapability: 'ingest',
            origin,
          }),
        ),
      ).rejects.toMatchObject({ messageKey: 'ingest.fields.locked' });
    });
  }
});

async function markedLinks(matched: boolean) {
  const left = {
    id: newId('table'),
    name: newId('table'),
    fields: [
      { id: newId('field'), name: 'Name', type: 'text' },
      { id: newId('field'), name: 'Key', type: 'text' },
    ],
    view: { id: newId('view'), name: 'Grid' },
  };
  const right = {
    id: newId('table'),
    name: newId('table'),
    fields: [{ id: newId('field'), name: 'Key', type: 'text' }],
    view: { id: newId('view'), name: 'Grid' },
  };
  const linkId = newId('field');
  const match = { fieldId: left.fields[1]!.id, linkedFieldId: right.fields[0]!.id };
  const created = await batch([
    { kind: 'table.create', table: left },
    { kind: 'table.create', table: right },
    {
      kind: 'field.create',
      tableId: left.id,
      field: {
        id: linkId,
        name: 'Related',
        type: 'link',
        options: { linkedTableId: right.id, ...(matched ? { match } : {}) },
      },
    },
  ]);
  expect(created.map((result) => result.status)).toEqual(['applied', 'applied', 'applied']);
  await store.changeSettings({ ...actor, tableId: left.id }, null, {
    state: 'setup',
    ownerId: null,
    rowMeaning: 'One incoming item',
    identity: null,
    fields: [],
    originals: { keepDays: null, readOnlyAccess: false },
    reply: true,
  });
  await store.markField({ ...actor, tableId: left.id }, linkId, { key: 'related', role: 'data' });
  const link = (await loadField(server.pool, server.schemas, linkId))!;
  if (link.type !== 'link') throw new Error('Expected link field');
  const inverse = (await loadField(server.pool, server.schemas, link.options.inverseFieldId!))!;
  return { link, inverse, keyId: match.fieldId, match };
}

describe('indirect changes to marked links', () => {
  for (const operation of ['add match', 'remove match', 'trash key', 'convert key'] as const) {
    for (const door of ['web', 'REST', 'MCP', 'proposal', 'archive'] as const) {
      it(`refuses ${operation} through ${door}, and preserves every affected field`, async () => {
        const fixture = await markedLinks(operation !== 'add match');
        const { match: _previous, ...options } = fixture.inverse.options as Record<string, unknown>;
        const matchedOptions =
          operation === 'add match'
            ? { ...options, match: { fieldId: fixture.match.linkedFieldId, linkedFieldId: fixture.keyId } }
            : options;
        const change =
          operation === 'trash key'
            ? { kind: 'field.trash', fieldId: fixture.keyId }
            : operation === 'convert key'
              ? { kind: 'field.convert', fieldId: fixture.keyId, to: { type: 'checkbox', options: {} } }
              : { kind: 'field.update', fieldId: fixture.inverse.id, options: matchedOptions };
        const input = operation === 'convert key' ? { type: 'checkbox' } : { options: matchedOptions };
        const before = await loadField(server.pool, server.schemas, change.fieldId);
        const untrusted = { ...change, ingestCapability: 'ingest', origin };
        if (door === 'web') {
          expect((await batch([untrusted]))[0]).toMatchObject({
            status: 'rejected',
            error: { messageKey: 'ingest.fields.locked' },
          });
        } else if (door === 'REST') {
          const response = await server.app.inject({
            method: operation === 'trash key' ? 'DELETE' : 'PATCH',
            url: `/api/v1/fields/${change.fieldId}`,
            headers: { authorization: `Bearer ${token.token}`, 'x-ingest-capability': 'ingest' },
            ...(operation === 'trash key'
              ? {}
              : { payload: { ...input, ingestCapability: 'ingest', origin } }),
          });
          expect(response.statusCode).toBeGreaterThanOrEqual(400);
          expect(response.body).toContain('ingest.fields.locked');
        } else if (door === 'MCP') {
          const tool = TOOLS.find(
            (item) => item.definition.name === (operation === 'trash key' ? 'trash_field' : 'update_field'),
          )!;
          const context = { app: server.app, actor, request: {} as FastifyRequest } as CallContext;
          await expect(
            Promise.resolve().then(() =>
              tool.call(context, {
                fieldId: change.fieldId,
                ...(operation === 'trash key'
                  ? {}
                  : { input: { ...input, ingestCapability: 'ingest', origin } }),
              }),
            ),
          ).rejects.toMatchObject({ messageKey: 'ingest.fields.locked' });
        } else if (door === 'proposal') {
          await expect(
            propose(
              server.app,
              actor,
              randomUUID(),
              {
                databaseId,
                summary: 'Change matching rules',
                steps: ['Change matching rules'],
                commands: [untrusted],
              },
              'ask',
              'ask',
            ),
          ).rejects.toMatchObject({ messageKey: 'ingest.fields.locked' });
        } else {
          await expect(
            withTransaction(server.pool, (db) =>
              templateCommand({ db, schemas: server.schemas, actor, databaseId }, newId('action'), untrusted),
            ),
          ).rejects.toMatchObject({ messageKey: 'ingest.fields.locked' });
        }
        expect(await loadField(server.pool, server.schemas, fixture.link.id)).toEqual(fixture.link);
        expect(await loadField(server.pool, server.schemas, fixture.inverse.id)).toEqual(fixture.inverse);
        expect(await loadField(server.pool, server.schemas, change.fieldId)).toEqual(before);
      });
    }
  }
});

it('allows the process to change matching rules and convert marked fields with its internal capability', async () => {
  const fixture = await markedLinks(false);
  const internal = async (input: Record<string, unknown>) => {
    const result = await runCommands(
      server.app,
      actor,
      databaseId,
      { clientId: newId('client'), commands: [command(input)] },
      undefined,
      undefined,
      undefined,
      { ingestCapability },
    );
    expect(result.results[0]).toMatchObject({ status: 'applied' });
  };
  await internal({
    kind: 'field.update',
    fieldId: fixture.inverse.id,
    options: {
      ...fixture.inverse.options,
      match: { fieldId: fixture.match.linkedFieldId, linkedFieldId: fixture.keyId },
    },
  });
  expect((await loadField(server.pool, server.schemas, fixture.link.id))?.options).toMatchObject({
    match: fixture.match,
  });
  await internal({ kind: 'field.trash', fieldId: fixture.keyId });
  expect((await loadField(server.pool, server.schemas, fixture.link.id))?.options).not.toHaveProperty(
    'match',
  );
  expect((await loadField(server.pool, server.schemas, fixture.inverse.id))?.options).not.toHaveProperty(
    'match',
  );
  await internal({ kind: 'field.convert', fieldId: fixture.link.id, to: { type: 'text', options: {} } });
  expect(await loadField(server.pool, server.schemas, fixture.link.id)).toMatchObject({
    type: 'text',
    ingest: fixture.link.ingest,
  });
});

it('refuses same-type conversion of a marked attachment field, and preserves its cells and files', async () => {
  const attachmentFieldId = newId('field');
  expect(
    (
      await batch([
        {
          kind: 'field.create',
          tableId,
          field: { id: attachmentFieldId, name: 'Original files', type: 'attachment' },
        },
      ])
    )[0],
  ).toMatchObject({ status: 'applied' });
  const bytes = Buffer.from('Keep this original file');
  const uploaded = await server.app.inject({
    method: 'POST',
    url: `/api/tables/${tableId}/fields/${attachmentFieldId}/files`,
    headers: {
      ...server.owner.headers,
      'content-type': 'application/octet-stream',
      'x-file-name': 'original.txt',
    },
    payload: bytes,
  });
  expect(uploaded.statusCode, uploaded.body).toBe(200);
  const file = uploaded.json<{ id: string; url: string }>();
  const recordId = newId('record');
  expect(
    (
      await batch([
        {
          kind: 'record.create',
          tableId,
          records: [{ id: recordId, values: { [attachmentFieldId]: [file.id] } }],
        },
      ])
    )[0],
  ).toMatchObject({ status: 'applied' });
  await store.markField({ ...actor, tableId }, attachmentFieldId, { key: 'originals', role: 'data' });
  const before = await loadField(server.pool, server.schemas, attachmentFieldId);
  expect(
    (
      await batch([
        {
          kind: 'field.convert',
          fieldId: attachmentFieldId,
          to: { type: 'attachment', options: before!.options },
          ingestCapability: 'ingest',
        },
      ])
    )[0],
  ).toMatchObject({ status: 'rejected', error: { messageKey: 'ingest.fields.locked' } });
  expect(await loadField(server.pool, server.schemas, attachmentFieldId)).toEqual(before);
  const row = await server.app.inject({
    url: `/api/tables/${tableId}/records/${recordId}`,
    headers: server.owner.headers,
  });
  expect(row.statusCode, row.body).toBe(200);
  expect(row.json<RowData>().values[attachmentFieldId]).toEqual([file.id]);
  const downloaded = await server.app.inject({ url: file.url, headers: server.owner.headers });
  expect(downloaded.statusCode).toBe(200);
  expect(downloaded.rawPayload).toEqual(bytes);
});

it('allows presentation changes, while keeping the mark and stored values', async () => {
  const before = await loadField(server.pool, server.schemas, fieldId);
  const results = await batch([
    { kind: 'field.update', fieldId, name: 'Reading status', description: 'A receipt status' },
    {
      kind: 'view.update',
      viewId,
      config: { hiddenFieldIds: [fieldId], columnWidths: { [fieldId]: 250 }, fieldOrder: [fieldId] },
    },
  ]);
  expect(results.map((result) => result.status)).toEqual(['applied', 'applied']);
  const after = await loadField(server.pool, server.schemas, fieldId);
  expect(after?.ingest).toEqual(before?.ingest);
  expect(after?.options).toEqual(before?.options);
});

it('keeps the internal capability and origin out of public contracts and records internal origins in audit and history', async () => {
  const recordId = newId('record');
  const input = {
    kind: 'record.create',
    tableId,
    records: [{ id: recordId, values: {} }],
    origin,
    ingestCapability: 'ingest',
  };
  expect((await batch([input]))[0]).toMatchObject({ status: 'applied' });
  const changes = await server.pool.query(
    `SELECT origin FROM ${server.schemas.app}.changes WHERE body->'records' @> $1::jsonb`,
    [JSON.stringify([{ id: recordId }])],
  );
  expect(changes.rows).toEqual([{ origin: null }]);
  const internalOrigin = { kind: 'ingest' as const, fileId: 'trusted-file' };
  const primaryFieldId = (await loadTable(server.pool, server.schemas, tableId))!.primaryFieldId;
  const result = await runCommands(
    server.app,
    actor,
    databaseId,
    {
      clientId: newId('client'),
      commands: [
        command({
          kind: 'record.update',
          tableId,
          records: [{ id: recordId, values: { [primaryFieldId]: 'Read from file' } }],
        }),
      ],
    },
    undefined,
    undefined,
    undefined,
    { origin: internalOrigin, ingestCapability },
  );
  expect(result.results[0]).toMatchObject({ status: 'applied' });
  const audit = await server.pool.query(
    `SELECT actor_id, metadata FROM ${server.schemas.audit}.events WHERE metadata->'origin'->>'fileId' = 'trusted-file'`,
  );
  expect(audit.rows).toEqual([
    { actor_id: actor.userId, metadata: expect.objectContaining({ origin: internalOrigin }) },
  ]);
  const parent = (await loadTable(server.pool, server.schemas, tableId))!;
  const scope = new AccessScope(server.pool, server.schemas, actor);
  await scope.prepare(databaseId);
  const history = await recordHistoryPage(server.pool, server.schemas, scope, parent, recordId);
  expect(history.entries[0]).toMatchObject({ actorId: actor.userId, origin: internalOrigin });
  expect(history.entries[1]?.origin).toBeUndefined();
  const current = await loadField(server.pool, server.schemas, fieldId);
  const changed = await runCommands(
    server.app,
    actor,
    databaseId,
    {
      clientId: newId('client'),
      commands: [
        command({
          kind: 'field.update',
          fieldId,
          options: { ...current!.options, validation: { required: {} } },
        }),
      ],
    },
    undefined,
    undefined,
    undefined,
    { ingestCapability },
  );
  expect(changed.results[0]).toMatchObject({ status: 'applied' });
  expect((await loadField(server.pool, server.schemas, fieldId))?.options).toMatchObject({
    validation: { required: {} },
  });
});

it('duplicates a CDI table as an ordinary table with ordinary fields', async () => {
  const newTableId = newId('table');
  const results = await batch([
    { kind: 'table.duplicate', tableId, newTableId, name: 'Copy', withRecords: false },
  ]);
  expect(results[0]).toMatchObject({ status: 'applied' });
  const response = await server.app.inject({
    url: `/api/databases/${databaseId}/schema`,
    headers: server.owner.headers,
  });
  const schema = response.json<DatabaseSchema>();
  expect(schema.tables.find((item) => item.id === newTableId)?.ingest).toBeUndefined();
  expect(
    schema.fields.filter((item) => item.tableId === newTableId).every((item) => item.ingest === undefined),
  ).toBe(true);
});

it('allows schema changes after the setting and all its marks are removed', async () => {
  const renameGroup = newId('action');
  const renamed = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [
        {
          id: newId('command'),
          groupId: renameGroup,
          kind: 'field.update',
          fieldId,
          name: 'Renamed before removal',
        },
      ],
    },
  });
  expect(renamed.json<CommandBatchResult>().results[0]).toMatchObject({ status: 'applied' });
  await store.changeSettings({ ...actor, tableId }, 1, null);
  const undone = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/undo`,
    headers: server.owner.headers,
    payload: { clientId: newId('client'), commandId: newId('command'), groupId: renameGroup },
  });
  expect(undone.statusCode, undone.body).toBe(200);
  expect(undone.json()).toMatchObject({ status: 'applied' });
  expect((await loadField(server.pool, server.schemas, fieldId))?.ingest).toBeUndefined();
  const results = await batch([{ kind: 'field.convert', fieldId, to: { type: 'text', options: {} } }]);
  expect(results[0]).toMatchObject({ status: 'applied' });
  expect((await loadField(server.pool, server.schemas, fieldId))?.ingest).toBeUndefined();
  expect((await batch([{ kind: 'field.trash', fieldId }]))[0]).toMatchObject({ status: 'applied' });
});

it('stores no mark that a request plants on a new field, through the web command request or the REST API', async () => {
  const id = newId('field');
  const results = await batch([
    {
      kind: 'field.create',
      tableId,
      field: { id, name: 'Planted', type: 'text', options: {}, ingest: { key: 'planted', role: 'data' } },
    },
  ]);
  expect(results[0]).toMatchObject({ status: 'applied' });
  expect((await loadField(server.pool, server.schemas, id))?.ingest ?? null).toBeNull();
  const rest = await server.app.inject({
    method: 'POST',
    url: `/api/v1/tables/${tableId}/fields`,
    headers: { authorization: `Bearer ${token.token}`, 'x-ingest-capability': 'ingest' },
    payload: { name: 'Planted again', type: 'text', ingest: { key: 'plantedAgain', role: 'data' } },
  });
  expect(rest.statusCode, rest.body).toBe(200);
  const made = rest.json<{ field: { id: string } }>().field.id;
  expect((await loadField(server.pool, server.schemas, made))?.ingest ?? null).toBeNull();
});
