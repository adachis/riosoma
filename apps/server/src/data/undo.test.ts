import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Command,
  DatabaseCreate,
  DatabaseSchema,
  UndoResult,
  UndoPreview,
  newId,
  type CommandBatchResult,
  type FieldCreate,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { loadFields, loadView } from './metadata.js';
import { fetchRowsById } from './physical/records.js';

let kit: TestPostgres;
let server: ServerFixture;
const clientId = newId('client');

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'undo');
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

function command(input: Record<string, unknown>, groupId = newId('action')): Command {
  const parsed = Command.parse({ id: newId('command'), groupId, ...input });
  if (parsed.kind === 'view.update') parsed.config = input.config as typeof parsed.config;
  return parsed;
}

async function create(extraFields: FieldCreate[] = []) {
  const input = DatabaseCreate.parse({
    id: newId('database'),
    name: 'Database',
    table: {
      id: newId('table'),
      name: 'Table',
      fields: [{ id: newId('field'), name: 'Name', type: 'text' }, ...extraFields],
      view: { id: newId('view'), name: 'Grid' },
      records: [{ id: newId('record') }, { id: newId('record') }],
    },
  });
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: input,
  });
  expect(response.statusCode, response.body).toBe(200);
  return input;
}

async function send(databaseId: string, commands: Command[], who = server.owner) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: who.headers,
    payload: { clientId, commands },
  });
  expect(response.statusCode, response.body).toBe(200);
  const results = response.json<CommandBatchResult>().results;
  expect(
    results.map((r) => r.status),
    response.body,
  ).toEqual(commands.map(() => 'applied'));
  return results;
}

async function reverse(
  databaseId: string,
  groupId: string,
  direction: 'undo' | 'redo' = 'undo',
  who = server.owner,
  commandId = newId('command'),
  confirmedMajorCreation: boolean | null = true,
) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/${direction}`,
    headers: who.headers,
    payload: {
      clientId,
      groupId,
      commandId,
      ...(confirmedMajorCreation === null ? {} : { confirmedMajorCreation }),
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return UndoResult.parse(response.json());
}

async function schema(databaseId: string) {
  const response = await server.app.inject({
    method: 'GET',
    url: `/api/databases/${databaseId}/schema`,
    headers: server.owner.headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  return DatabaseSchema.parse(response.json());
}

async function rows(input: DatabaseCreate, ids = input.table.records.map((r) => r.id)) {
  const fields = await loadFields(server.pool, server.schemas, [input.table.id]);
  return fetchRowsById(server.pool, server.schemas.data, input.table.id, fields, ids);
}

async function grant(input: DatabaseCreate, who: SignedIn) {
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
    (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${who.info.org.id}, 'database', ${input.id}, 'user', ${who.userId}, 'creator')`,
  );
}

describe('undo and redo through HTTP', () => {
  it('requires a deliberate confirmation for database creation, preserves current contents in trash, and restores them on redo', async () => {
    const input = await create();
    const groupId = (
      await query<{ group_id: string }>(
        server.pool,
        sql`
      SELECT group_id FROM ${ident(server.schemas.app, 'changes')}
      WHERE database_id = ${input.id} AND kind = 'database.created'`,
      )
    ).rows[0]!.group_id;
    const member = await server.addMember();
    await grant(input, member);
    await send(
      input.id,
      [
        command({
          kind: 'record.create',
          tableId: input.table.id,
          records: Array.from({ length: 12 }, () => ({ id: newId('record'), values: {} })),
        }),
      ],
      member,
    );
    const addedTableId = newId('table');
    await send(
      input.id,
      [
        command({
          kind: 'table.create',
          table: {
            id: addedTableId,
            name: 'Collaborator table',
            fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
            view: { id: newId('view'), name: 'Grid' },
          },
        }),
      ],
      member,
    );
    const reader = await server.addMember();
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
      (org_id, resource_kind, resource_id, principal_kind, principal_id, role, created_by)
      VALUES (${member.info.org.id}, 'database', ${input.id}, 'user', ${reader.userId}, 'reader', ${member.userId})`,
    );
    const preview = await server.app.inject({
      method: 'GET',
      url: `/api/databases/${input.id}/undo-preview/${groupId}`,
      headers: server.owner.headers,
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({
      creations: [
        {
          kind: 'database',
          name: 'Database',
          tables: 2,
          records: 14,
          changedSince: [
            { actorId: member.userId, name: member.info.user.name, records: 12, tables: 1, shares: 1 },
          ],
        },
      ],
    });
    for (let cycle = 0; cycle < 2; cycle++) {
      expect(
        await reverse(input.id, groupId, 'undo', server.owner, newId('command'), cycle ? false : null),
      ).toMatchObject({
        status: 'rejected',
        error: { messageKey: 'data.undo.majorCreationConfirmationRequired' },
      });
      expect((await schema(input.id)).tables).toHaveLength(2);
      expect(await reverse(input.id, groupId)).toMatchObject({ status: 'applied', skipped: 0 });
      const trash = await server.app.inject({
        method: 'GET',
        url: '/api/trash',
        headers: server.owner.headers,
      });
      expect(trash.statusCode, trash.body).toBe(200);
      expect(trash.json().databases).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: input.id })]),
      );
      expect(await reverse(input.id, groupId, 'redo', server.owner, newId('command'), false)).toMatchObject({
        status: 'applied',
      });
      expect((await schema(input.id)).tables.map((table) => table.id)).toContain(addedTableId);
      expect(
        (
          await query(
            server.pool,
            sql`SELECT __id FROM ${ident(server.schemas.data, input.table.id)} WHERE __deleted_at IS NULL`,
          )
        ).rows,
      ).toHaveLength(14);
    }
  });

  it('asks before undoing table creation with fresh counts and keeps collaborator records for redo', async () => {
    const input = await create();
    const tableId = newId('table');
    const viewId = newId('view');
    const created = command({
      kind: 'table.create',
      table: {
        id: tableId,
        name: 'Projects',
        fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
        view: { id: viewId, name: 'Grid' },
      },
    });
    await send(input.id, [created]);
    const member = await server.addMember();
    await grant(input, member);
    await send(
      input.id,
      [command({ kind: 'record.create', tableId, records: [{ id: newId('record'), values: {} }] })],
      member,
    );
    const shared = await server.app.inject({
      method: 'PUT',
      url: `/api/views/${viewId}/shared-view`,
      headers: member.headers,
    });
    expect(shared.statusCode, shared.body).toBe(200);
    const preview = await server.app.inject({
      method: 'GET',
      url: `/api/databases/${input.id}/undo-preview/${created.groupId}`,
      headers: server.owner.headers,
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({
      creations: [
        {
          kind: 'table',
          name: 'Projects',
          tables: 0,
          records: 1,
          changedSince: [{ actorId: member.userId, records: 1, shares: 1 }],
        },
      ],
    });
    expect(
      await reverse(input.id, created.groupId, 'undo', server.owner, newId('command'), null),
    ).toMatchObject({
      status: 'rejected',
      error: { messageKey: 'data.undo.majorCreationConfirmationRequired' },
    });
    expect(await reverse(input.id, created.groupId)).toMatchObject({ status: 'applied' });
    expect((await schema(input.id)).tables.map((table) => table.id)).not.toContain(tableId);
    const trashed = await query<{ trashed_at: Date | null }>(
      server.pool,
      sql`
      SELECT trashed_at FROM ${ident(server.schemas.app, 'tables')} WHERE id = ${tableId}`,
    );
    expect(trashed.rows[0]!.trashed_at).not.toBeNull();
    expect(
      await reverse(input.id, created.groupId, 'redo', server.owner, newId('command'), false),
    ).toMatchObject({ status: 'applied' });
    expect((await schema(input.id)).tables.map((table) => table.id)).toContain(tableId);
    expect(
      (
        await query(
          server.pool,
          sql`SELECT __id FROM ${ident(server.schemas.data, tableId)} WHERE __deleted_at IS NULL`,
        )
      ).rows,
    ).toHaveLength(1);
  });

  it('keeps field, view, and record creation as one-step undo', async () => {
    const input = await create();
    const config = (await schema(input.id)).views[0]!.config;
    for (const create of [
      command({
        kind: 'field.create',
        tableId: input.table.id,
        field: { id: newId('field'), name: 'Extra', type: 'text' },
      }),
      command({
        kind: 'view.create',
        view: { id: newId('view'), tableId: input.table.id, name: 'Extra', type: 'grid', config },
      }),
      command({
        kind: 'record.create',
        tableId: input.table.id,
        records: [{ id: newId('record'), values: {} }],
      }),
    ]) {
      await send(input.id, [create]);
      expect(
        await reverse(input.id, create.groupId, 'undo', server.owner, newId('command'), false),
      ).toMatchObject({ status: 'applied' });
    }
  });

  it.each(['create', 'duplicate'] as const)(
    'keeps line-items field %s as one-step undo through repeated cycles',
    async (operation) => {
      const input = await create();
      const sourceId = newId('field');
      const fieldId = operation === 'create' ? sourceId : newId('field');
      const source = command({
        kind: 'field.create',
        tableId: input.table.id,
        field: {
          id: sourceId,
          name: 'Lines',
          type: 'lineItems',
          options: { columns: [{ id: newId('field'), name: 'Description', type: 'text' }] },
        },
      });
      await send(input.id, [source]);
      const created =
        operation === 'create'
          ? source
          : command({
              kind: 'field.duplicate',
              fieldId: sourceId,
              newFieldId: fieldId,
              name: 'Copied lines',
              withValues: true,
            });
      if (operation === 'duplicate') await send(input.id, [created]);
      const field = (await schema(input.id)).fields.find((field) => field.id === fieldId)!;
      if (field.type !== 'lineItems') throw new Error('Missing line-items field');
      const childId = field.options.linkedTableId;
      for (let cycle = 0; cycle < 2; cycle++) {
        const preview = await server.app.inject({
          method: 'GET',
          url: `/api/databases/${input.id}/undo-preview/${created.groupId}`,
          headers: server.owner.headers,
        });
        expect(preview.statusCode, preview.body).toBe(200);
        expect(UndoPreview.parse(preview.json()).creations).toEqual([]);
        expect(
          await reverse(input.id, created.groupId, 'undo', server.owner, newId('command'), null),
        ).toMatchObject({
          status: 'applied',
          skipped: 0,
        });
        expect((await schema(input.id)).fields.map((field) => field.id)).not.toContain(fieldId);
        expect((await schema(input.id)).tables.map((table) => table.id)).not.toContain(childId);
        expect(
          await reverse(input.id, created.groupId, 'redo', server.owner, newId('command'), null),
        ).toMatchObject({
          status: 'applied',
          skipped: 0,
        });
        expect((await schema(input.id)).fields.find((field) => field.id === fieldId)).toEqual({
          ...field,
          updatedAt: expect.any(String),
        });
        expect((await schema(input.id)).tables.map((table) => table.id)).toContain(childId);
      }
    },
  );

  it('asks only about the parent table when undoing creation with line items and matches manual trash and restoration', async () => {
    const input = await create();
    const tableId = newId('table');
    const created = command({
      kind: 'table.create',
      table: {
        id: tableId,
        name: 'Invoices',
        fields: [
          { id: newId('field'), name: 'Name', type: 'text' },
          {
            id: newId('field'),
            name: 'Lines',
            type: 'lineItems',
            options: { columns: [{ id: newId('field'), name: 'Description', type: 'text' }] },
          },
        ],
        view: { id: newId('view'), name: 'Grid' },
      },
    });
    await send(input.id, [created]);
    const before = await schema(input.id);
    const preview = await server.app.inject({
      method: 'GET',
      url: `/api/databases/${input.id}/undo-preview/${created.groupId}`,
      headers: server.owner.headers,
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(UndoPreview.parse(preview.json()).creations).toEqual([
      { kind: 'table', id: tableId, name: 'Invoices', tables: 0, records: 0, changedSince: [] },
    ]);
    await send(input.id, [command({ kind: 'table.trash', tableId })]);
    const manualTrash = await schema(input.id);
    await send(input.id, [command({ kind: 'table.restore', tableId })]);
    for (let cycle = 0; cycle < 2; cycle++) {
      expect(await reverse(input.id, created.groupId)).toMatchObject({ status: 'applied', skipped: 0 });
      const undone = await schema(input.id);
      expect(undone.tables.map((table) => table.id)).toEqual(manualTrash.tables.map((table) => table.id));
      expect(undone.fields).toEqual(manualTrash.fields);
      expect(
        await reverse(input.id, created.groupId, 'redo', server.owner, newId('command'), null),
      ).toMatchObject({
        status: 'applied',
        skipped: 0,
      });
      expect((await schema(input.id)).tables.map((table) => table.id)).toEqual(
        before.tables.map((table) => table.id),
      );
      expect((await schema(input.id)).fields).toEqual(before.fields);
    }
  });

  it.each([
    ['create', false],
    ['create', true],
    ['duplicate', false],
    ['duplicate', true],
  ] as const)(
    'preserves inverse fields like manual trash and restoration for table %s with an external database=%s',
    async (operation, external) => {
      const input = await create();
      const projects = external ? await create() : input;
      const sourceId = newId('table');
      const source = command({
        kind: 'table.create',
        table: {
          id: sourceId,
          name: 'Tasks',
          fields: [
            { id: newId('field'), name: 'Name', type: 'text' },
            {
              id: newId('field'),
              name: 'Project',
              type: 'link',
              options: { linkedTableId: projects.table.id },
            },
          ],
          view: { id: newId('view'), name: 'Grid' },
        },
      });
      await send(input.id, [source]);
      const tableId = operation === 'create' ? sourceId : newId('table');
      const created =
        operation === 'create'
          ? source
          : command({
              kind: 'table.duplicate',
              tableId: sourceId,
              newTableId: tableId,
              name: 'Copied tasks',
              withRecords: true,
            });
      if (operation === 'duplicate') await send(input.id, [created]);
      const fields = (await schema(projects.id)).fields.filter(
        (field) => field.tableId === projects.table.id,
      );
      expect(fields.length).toBe(operation === 'create' ? 2 : 3);
      await send(input.id, [command({ kind: 'table.trash', tableId })]);
      expect(
        (await schema(projects.id)).fields.filter((field) => field.tableId === projects.table.id),
      ).toEqual(fields);
      await send(input.id, [command({ kind: 'table.restore', tableId })]);
      for (let cycle = 0; cycle < 2; cycle++) {
        expect(await reverse(input.id, created.groupId)).toMatchObject({ status: 'applied', skipped: 0 });
        expect((await schema(input.id)).tables.map((table) => table.id)).not.toContain(tableId);
        expect(
          (await schema(projects.id)).fields.filter((field) => field.tableId === projects.table.id),
        ).toEqual(fields);
        expect(
          await reverse(input.id, created.groupId, 'redo', server.owner, newId('command'), null),
        ).toMatchObject({
          status: 'applied',
          skipped: 0,
        });
        expect((await schema(input.id)).tables.map((table) => table.id)).toContain(tableId);
        expect(
          (await schema(projects.id)).fields.filter((field) => field.tableId === projects.table.id),
        ).toEqual(fields);
      }
    },
  );
  it('preserves collaborator view edits when reversing field placement through repeated cycles', async () => {
    const input = await create();
    const before = (await schema(input.id)).views[0]!;
    const fieldId = newId('field');
    const created = command({
      kind: 'field.create',
      tableId: input.table.id,
      field: { id: fieldId, name: 'Placed', type: 'text' },
      placement: { viewId: before.id, index: 0 },
    });
    await send(input.id, [created]);
    const placedOrder = (await schema(input.id)).views[0]!.config.fieldOrder;
    const member = await server.addMember();
    await grant(input, member);
    await send(input.id, [command({ kind: 'view.update', viewId: before.id, name: 'Shared grid' })], member);
    expect(await reverse(input.id, created.groupId)).toMatchObject({ status: 'applied', skipped: 0 });
    expect((await schema(input.id)).views[0]).toMatchObject({
      name: 'Shared grid',
      config: { fieldOrder: before.config.fieldOrder },
    });
    await send(
      input.id,
      [
        command({
          kind: 'view.update',
          viewId: before.id,
          name: 'Collaborator grid',
          config: { columnWidths: { [input.table.fields[0]!.id]: 377 } },
        }),
        command({ kind: 'view.move', viewId: before.id, position: before.position + 10 }),
      ],
      member,
    );
    const edited = (await schema(input.id)).views[0]!;
    for (let cycle = 0; cycle < 3; cycle++) {
      expect(await reverse(input.id, created.groupId, 'redo')).toMatchObject({
        status: 'applied',
        skipped: 0,
      });
      expect((await schema(input.id)).views[0]).toMatchObject({
        name: edited.name,
        position: edited.position,
        config: { ...edited.config, fieldOrder: placedOrder },
      });
      expect(await reverse(input.id, created.groupId)).toMatchObject({ status: 'applied', skipped: 0 });
      expect((await schema(input.id)).views[0]).toMatchObject({
        name: edited.name,
        position: edited.position,
        config: edited.config,
      });
    }
  });

  it.each([
    ['locked', 'undo'],
    ['trashed', 'undo'],
    ['locked', 'redo'],
    ['trashed', 'redo'],
  ] as const)(
    'reverses the field independently when its placement view is %s before %s',
    async (availability, direction) => {
      const input = await create();
      const viewId = input.table.view.id;
      const fieldId = newId('field');
      const created = command({
        kind: 'field.create',
        tableId: input.table.id,
        field: { id: fieldId, name: 'Placed', type: 'text' },
        placement: { viewId, index: 0 },
      });
      await send(input.id, [created]);
      if (direction === 'redo')
        expect(await reverse(input.id, created.groupId)).toMatchObject({ status: 'applied', skipped: 0 });
      const member = await server.addMember();
      await grant(input, member);
      if (availability === 'trashed')
        await send(
          input.id,
          [
            command({
              kind: 'view.create',
              view: { id: newId('view'), tableId: input.table.id, name: 'Other grid', type: 'grid' },
            }),
          ],
          member,
        );
      await send(
        input.id,
        [
          command(
            availability === 'locked'
              ? { kind: 'view.update', viewId, config: { locked: true } }
              : { kind: 'view.trash', viewId },
          ),
        ],
        member,
      );
      const unavailable = await loadView(server.pool, server.schemas, viewId);
      expect(await reverse(input.id, created.groupId, direction)).toMatchObject({
        status: 'applied',
        skipped: 1,
      });
      expect((await schema(input.id)).fields.some((field) => field.id === fieldId)).toBe(
        direction === 'redo',
      );
      const untouched = await loadView(server.pool, server.schemas, viewId);
      expect(untouched?.trashed).toBe(unavailable?.trashed);
      expect(untouched?.view).toEqual(unavailable?.view);
      const opposite = direction === 'undo' ? 'redo' : 'undo';
      expect(await reverse(input.id, created.groupId, opposite)).toMatchObject({
        status: 'applied',
        skipped: 0,
      });
      expect((await schema(input.id)).fields.some((field) => field.id === fieldId)).toBe(
        direction === 'undo',
      );
      expect((await loadView(server.pool, server.schemas, viewId))?.view).toEqual(unavailable?.view);
    },
  );

  it('restores the exact view order when undoing one field creation with placement through repeated cycles', async () => {
    const input = await create();
    const before = await schema(input.id);
    const fieldId = newId('field');
    const created = command({
      kind: 'field.create',
      tableId: input.table.id,
      field: { id: fieldId, name: 'Placed', type: 'text' },
      placement: { viewId: input.table.view.id, index: 0 },
    });
    await send(input.id, [created]);
    const after = await schema(input.id);
    expect(after.views[0]!.config.fieldOrder[0]).toBe(fieldId);
    for (let cycle = 0; cycle < 3; cycle++) {
      expect(await reverse(input.id, created.groupId)).toMatchObject({ status: 'applied', skipped: 0 });
      const undone = await schema(input.id);
      expect(undone.fields.map((field) => field.id)).toEqual(before.fields.map((field) => field.id));
      expect(undone.views[0]!.config).toEqual(before.views[0]!.config);
      expect(await reverse(input.id, created.groupId, 'redo')).toMatchObject({
        status: 'applied',
        skipped: 0,
      });
      const redone = await schema(input.id);
      expect(redone.fields.map((field) => field.id)).toEqual(after.fields.map((field) => field.id));
      expect(redone.views[0]!.config).toEqual(after.views[0]!.config);
    }
  });

  it('reverses database creation and its first table together through repeated cycles', async () => {
    const input = await create();
    const created = await query<{ group_id: string }>(
      server.pool,
      sql`SELECT group_id FROM ${ident(server.schemas.app, 'changes')}
      WHERE database_id = ${input.id} AND seq = 1`,
    );
    const groupId = created.rows[0]!.group_id;
    for (let cycle = 0; cycle < 2; cycle += 1) {
      expect(await reverse(input.id, groupId)).toMatchObject({ status: 'applied' });
      const hidden = await server.app.inject({
        method: 'GET',
        url: `/api/databases/${input.id}/schema`,
        headers: server.owner.headers,
      });
      expect(hidden.statusCode).toBe(404);
      expect(await reverse(input.id, groupId, 'redo')).toMatchObject({ status: 'applied' });
      expect((await schema(input.id)).tables).toHaveLength(1);
      expect(await rows(input)).toHaveLength(2);
    }
  });

  it('reverses groups in order, skips another author’s edits cell by cell, and redoes only cells it undid', async () => {
    const extra = newId('field');
    const input = await create([{ id: extra, name: 'Other', description: '', type: 'text', options: {} }]);
    const primary = input.table.fields[0]!.id;
    const recordId = input.table.records[0]!.id;
    const groupId = newId('action');
    await send(input.id, [
      command(
        {
          kind: 'record.update',
          tableId: input.table.id,
          records: [{ id: recordId, values: { [primary]: 'First', [extra]: 'First extra' } }],
        },
        groupId,
      ),
      command(
        {
          kind: 'record.update',
          tableId: input.table.id,
          records: [{ id: recordId, values: { [primary]: 'Second' } }],
        },
        groupId,
      ),
    ]);
    const member = await server.addMember();
    await grant(input, member);
    await send(
      input.id,
      [
        command({
          kind: 'record.update',
          tableId: input.table.id,
          records: [{ id: recordId, values: { [extra]: 'Their change' } }],
        }),
      ],
      member,
    );
    const commandId = newId('command');
    const undo = await reverse(input.id, groupId, 'undo', server.owner, commandId);
    expect(undo).toMatchObject({ status: 'applied', skipped: 1 });
    expect((await rows(input))[0]!.values).toEqual({ [primary]: null, [extra]: 'Their change' });
    expect(await reverse(input.id, groupId, 'undo', server.owner, commandId)).toEqual(undo);
    expect(await reverse(input.id, groupId)).toEqual({ status: 'nothing', skipped: 0 });
    expect(await reverse(input.id, groupId, 'redo')).toMatchObject({ status: 'applied', skipped: 0 });
    expect((await rows(input))[0]!.values).toEqual({ [primary]: 'Second', [extra]: 'Their change' });
    expect(await reverse(input.id, groupId, 'redo')).toEqual({ status: 'nothing', skipped: 0 });
    expect(await reverse(input.id, groupId)).toMatchObject({ status: 'applied', skipped: 0 });
    expect((await rows(input))[0]!.values).toEqual({ [primary]: null, [extra]: 'Their change' });
    const log = await query<{ undo_of: string | null; redo_of: string | null; actor_id: string }>(
      server.pool,
      sql`SELECT undo_of, redo_of, actor_id FROM ${ident(server.schemas.app, 'changes')} WHERE group_id = ${groupId} ORDER BY seq`,
    );
    expect(log.rows.map((r) => [r.undo_of, r.redo_of])).toEqual([
      [null, null],
      [null, null],
      [groupId, null],
      [groupId, null],
      [null, groupId],
      [null, groupId],
      [groupId, null],
      [groupId, null],
    ]);
    expect(log.rows.every((r) => r.actor_id === server.owner.userId)).toBe(true);
  });

  it('counts missing records and fields as skipped, and protects edits made after undo', async () => {
    const extra = newId('field');
    const input = await create([{ id: extra, name: 'Other', description: '', type: 'text', options: {} }]);
    const primary = input.table.fields[0]!.id;
    const [first, second] = input.table.records;
    const groupId = newId('action');
    await send(input.id, [
      command(
        {
          kind: 'record.update',
          tableId: input.table.id,
          records: [
            { id: first!.id, values: { [primary]: 'First', [extra]: 'Extra' } },
            { id: second!.id, values: { [primary]: 'Second', [extra]: 'Extra' } },
          ],
        },
        groupId,
      ),
    ]);
    await send(input.id, [
      command({ kind: 'record.trash', tableId: input.table.id, recordIds: [second!.id] }),
      command({ kind: 'field.trash', fieldId: extra }),
    ]);
    expect(await reverse(input.id, groupId)).toMatchObject({ status: 'applied', skipped: 3 });
    await send(input.id, [
      command({
        kind: 'record.update',
        tableId: input.table.id,
        records: [{ id: first!.id, values: { [primary]: 'After undo' } }],
      }),
    ]);
    expect(await reverse(input.id, groupId, 'redo')).toMatchObject({ status: 'nothing', skipped: 1 });
    expect((await rows(input))[0]!.values[primary]).toBe('After undo');
  });

  it('requires the group author, rejects unknown groups, and stores rejected undo results', async () => {
    const input = await create();
    const edit = command({ kind: 'database.update', name: 'Authored' });
    await send(input.id, [edit]);
    const member = await server.addMember();
    await grant(input, member);
    const commandId = newId('command');
    const denied = await reverse(input.id, edit.groupId, 'undo', member, commandId);
    expect(denied).toMatchObject({ status: 'rejected', skipped: 0, error: { code: 'forbidden' } });
    expect(await reverse(input.id, edit.groupId, 'undo', member, commandId)).toEqual(denied);
    expect(await reverse(input.id, newId('action'))).toMatchObject({
      status: 'rejected',
      error: { code: 'not_found' },
    });
    expect((await schema(input.id)).database.name).toBe('Authored');
  });

  it('reverses record creates and trashes, and repeats undo/redo cycles without reinserting IDs', async () => {
    const input = await create();
    const recordId = newId('record');
    const fieldId = input.table.fields[0]!.id;
    const created = command({
      kind: 'record.create',
      tableId: input.table.id,
      records: [{ id: recordId, values: { [fieldId]: 'Original' } }],
    });
    await send(input.id, [created]);
    expect(await reverse(input.id, created.groupId)).toMatchObject({ status: 'applied' });
    expect(await rows(input, [recordId])).toEqual([]);
    expect(await reverse(input.id, created.groupId, 'redo')).toMatchObject({ status: 'applied' });
    expect((await rows(input, [recordId]))[0]!.values[fieldId]).toBe('Original');
    const trashed = command({ kind: 'record.trash', tableId: input.table.id, recordIds: [recordId] });
    await send(input.id, [trashed]);
    await reverse(input.id, trashed.groupId);
    expect((await rows(input, [recordId]))[0]!.values[fieldId]).toBe('Original');
    await reverse(input.id, trashed.groupId, 'redo');
    expect(await rows(input, [recordId])).toEqual([]);
    await reverse(input.id, trashed.groupId);
    expect((await rows(input, [recordId]))[0]!.values[fieldId]).toBe('Original');
    const count = await query(
      server.pool,
      sql`SELECT __id FROM ${ident(server.schemas.data, input.table.id)} WHERE __id = ${recordId}`,
    );
    expect(count.rowCount).toBe(1);
  });

  it('swaps conversion columns through repeated undo and redo, restoring exact original values and dropping advisor indexes', async () => {
    const input = await create();
    const fieldId = input.table.fields[0]!.id;
    const tableId = input.table.id;
    await send(input.id, [
      command({
        kind: 'record.update',
        tableId,
        records: [
          { id: input.table.records[0]!.id, values: { [fieldId]: '001.00' } },
          { id: input.table.records[1]!.id, values: { [fieldId]: 'not a number' } },
        ],
      }),
    ]);
    const indexName = `rio_${tableId}_${fieldId}`;
    await query(
      server.pool,
      sql`CREATE INDEX ${ident(indexName)} ON ${ident(server.schemas.data, tableId)} (${ident(fieldId)})`,
    );
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'data_indexes')} (index_name, table_id, field_ids)
      VALUES (${indexName}, ${tableId}, ${[fieldId]}::text[])`,
    );
    const number = command({ kind: 'field.convert', fieldId, to: { type: 'number' } });
    const text = command({ kind: 'field.convert', fieldId, to: { type: 'text' } });
    await send(input.id, [number]);
    expect((await rows(input)).map((r) => r.values[fieldId])).toEqual([1, null]);
    const index = await query(
      server.pool,
      sql`SELECT indexname FROM pg_indexes WHERE schemaname = ${server.schemas.data} AND indexname = ${indexName}`,
    );
    expect(index.rowCount).toBe(0);
    await send(input.id, [text]);
    expect((await rows(input)).map((r) => r.values[fieldId])).toEqual(['1', null]);
    expect(await reverse(input.id, text.groupId)).toMatchObject({ status: 'applied' });
    expect((await rows(input)).map((r) => r.values[fieldId])).toEqual([1, null]);
    expect(await reverse(input.id, number.groupId)).toMatchObject({ status: 'applied' });
    expect((await rows(input)).map((r) => r.values[fieldId])).toEqual(['001.00', 'not a number']);
    await reverse(input.id, number.groupId, 'redo');
    await reverse(input.id, text.groupId, 'redo');
    expect((await rows(input)).map((r) => r.values[fieldId])).toEqual(['1', null]);
    await reverse(input.id, text.groupId);
    await reverse(input.id, number.groupId);
    expect((await rows(input)).map((r) => r.values[fieldId])).toEqual(['001.00', 'not a number']);
    const backup = await query<{ column_name: string }>(
      server.pool,
      sql`SELECT column_name FROM ${ident(server.schemas.app, 'column_backups')} WHERE field_id = ${fieldId}`,
    );
    expect(backup.rows.map((r) => r.column_name).sort()).toEqual([`${fieldId}_1`, `${fieldId}_2`]);
    const next = command({ kind: 'field.convert', fieldId, to: { type: 'number' } });
    await send(input.id, [next]);
    expect((await loadFields(server.pool, server.schemas, [tableId]))[0]!.columnName).toBe(`${fieldId}_3`);
  });

  it('passes collaborator names and date order through conversions, including computed columns', async () => {
    const author = newId('field');
    const date = newId('field');
    const input = await create([
      { id: author, name: 'Author', description: '', type: 'createdBy', options: {} },
      { id: date, name: 'Date', description: '', type: 'text', options: {} },
    ]);
    await send(input.id, [
      command({
        kind: 'record.update',
        tableId: input.table.id,
        records: [{ id: input.table.records[0]!.id, values: { [date]: '03/04/2025' } }],
      }),
    ]);
    const authorConversion = command({ kind: 'field.convert', fieldId: author, to: { type: 'text' } });
    const dateConversion = command({
      kind: 'field.convert',
      fieldId: date,
      to: { type: 'date' },
      dateOrder: 'dmy',
      timeZone: 'America/Los_Angeles',
    });
    await send(input.id, [authorConversion, dateConversion]);
    expect((await rows(input))[0]!.values).toMatchObject({ [author]: 'Owner', [date]: '2025-04-03' });
    await reverse(input.id, authorConversion.groupId);
    expect((await schema(input.id)).fields.find((f) => f.id === author)!.type).toBe('createdBy');
    await reverse(input.id, authorConversion.groupId, 'redo');
    expect((await rows(input))[0]!.values[author]).toBe('Owner');
  });

  it.each(['singleSelect', 'multipleSelect'] as const)(
    'restores removed %s choices and their cells, including trashed records',
    async (type) => {
      const fieldId = newId('field');
      const one = { id: newId('choice'), name: 'One', color: 'blue' as const };
      const two = { id: newId('choice'), name: 'Two', color: 'green' as const };
      const input = await create([
        { id: fieldId, name: 'Choice', description: '', type, options: { choices: [one, two] } },
      ]);
      const value = type === 'singleSelect' ? one.id : [one.id, two.id];
      await send(input.id, [
        command({
          kind: 'record.update',
          tableId: input.table.id,
          records: input.table.records.map(({ id }) => ({ id, values: { [fieldId]: value } })),
        }),
        command({ kind: 'record.trash', tableId: input.table.id, recordIds: [input.table.records[1]!.id] }),
      ]);
      const remove = command({ kind: 'field.update', fieldId, options: { choices: [two] } });
      await send(input.id, [remove]);
      expect((await rows(input))[0]!.values[fieldId]).toEqual(type === 'singleSelect' ? null : [two.id]);
      expect(await reverse(input.id, remove.groupId)).toMatchObject({ status: 'applied', skipped: 0 });
      expect((await rows(input))[0]!.values[fieldId]).toEqual(value);
      const raw = await query<{ value: unknown }>(
        server.pool,
        sql`SELECT ${ident(fieldId)} AS value FROM ${ident(server.schemas.data, input.table.id)} WHERE __id = ${input.table.records[1]!.id}`,
      );
      expect(raw.rows[0]!.value).toEqual(value);
      const restored = (await schema(input.id)).fields.find((f) => f.id === fieldId)!;
      expect(restored.options).toEqual({ choices: [one, two] });
      expect(await reverse(input.id, remove.groupId, 'redo')).toMatchObject({
        status: 'applied',
        skipped: 0,
      });
      expect((await rows(input))[0]!.values[fieldId]).toEqual(type === 'singleSelect' ? null : [two.id]);
      expect(await reverse(input.id, remove.groupId)).toMatchObject({ status: 'applied', skipped: 0 });
      expect((await rows(input))[0]!.values[fieldId]).toEqual(value);
    },
  );

  it('skips changed choice cells during undo without losing the removed option', async () => {
    const fieldId = newId('field');
    const one = { id: newId('choice'), name: 'One', color: 'blue' as const };
    const two = { id: newId('choice'), name: 'Two', color: 'green' as const };
    const input = await create([
      {
        id: fieldId,
        name: 'Choice',
        description: '',
        type: 'singleSelect',
        options: { choices: [one, two] },
      },
    ]);
    const recordId = input.table.records[0]!.id;
    await send(input.id, [
      command({
        kind: 'record.update',
        tableId: input.table.id,
        records: [{ id: recordId, values: { [fieldId]: one.id } }],
      }),
    ]);
    const remove = command({ kind: 'field.update', fieldId, options: { choices: [two] } });
    await send(input.id, [remove]);
    await send(input.id, [
      command({
        kind: 'record.update',
        tableId: input.table.id,
        records: [{ id: recordId, values: { [fieldId]: two.id } }],
      }),
    ]);
    expect(await reverse(input.id, remove.groupId)).toMatchObject({ status: 'applied', skipped: 1 });
    expect((await rows(input))[0]!.values[fieldId]).toBe(two.id);
    expect((await schema(input.id)).fields.find((f) => f.id === fieldId)!.options).toEqual({
      choices: [one, two],
    });
  });

  it('reverses names, descriptions, options, primary fields, positions, and complete view configurations', async () => {
    const extra = newId('field');
    const input = await create([
      {
        id: extra,
        name: 'Other',
        description: '',
        type: 'number',
        options: { precision: null, thousands: true, allowNegative: true },
      },
    ]);
    const before = await schema(input.id);
    const groupId = newId('action');
    await send(input.id, [
      command(
        {
          kind: 'table.update',
          tableId: input.table.id,
          name: 'Changed table',
          description: 'Changed description',
        },
        groupId,
      ),
      command({ kind: 'table.move', tableId: input.table.id, position: 7 }, groupId),
      command(
        {
          kind: 'field.update',
          fieldId: extra,
          name: 'Changed field',
          description: 'Field description',
          options: { precision: 2 },
        },
        groupId,
      ),
      command({ kind: 'field.setPrimary', fieldId: extra, tableId: input.table.id }, groupId),
      command(
        {
          kind: 'view.update',
          viewId: input.table.view.id,
          name: 'Changed view',
          config: {
            fieldOrder: [extra],
            columnWidths: { [extra]: 320 },
            rowHeight: 'extraTall',
            hiddenFieldIds: [input.table.fields[0]!.id],
          },
        },
        groupId,
      ),
      command({ kind: 'view.move', viewId: input.table.view.id, position: 8 }, groupId),
      command(
        {
          kind: 'database.update',
          name: 'Changed database',
          description: 'Description',
          icon: 'clipboard-list',
          color: 'blue',
        },
        groupId,
      ),
    ]);
    const changed = await schema(input.id);
    expect(await reverse(input.id, groupId)).toMatchObject({ status: 'applied', skipped: 0 });
    const restored = await schema(input.id);
    expect(restored.database).toMatchObject({
      name: before.database.name,
      description: '',
      icon: null,
      color: null,
    });
    expect(restored.tables[0]).toMatchObject({
      name: before.tables[0]!.name,
      description: '',
      position: 0,
      primaryFieldId: input.table.fields[0]!.id,
    });
    expect(restored.fields.find((f) => f.id === extra)).toMatchObject({
      name: 'Other',
      description: '',
      options: { precision: null, thousands: true, allowNegative: true },
    });
    expect(restored.views[0]).toMatchObject({
      name: before.views[0]!.name,
      position: 0,
      config: before.views[0]!.config,
    });
    expect(await reverse(input.id, groupId, 'redo')).toMatchObject({ status: 'applied', skipped: 0 });
    const redone = await schema(input.id);
    expect(redone.database.name).toBe(changed.database.name);
    expect(redone.tables[0]).toMatchObject({ name: 'Changed table', position: 7, primaryFieldId: extra });
    expect(redone.views[0]).toMatchObject({
      name: 'Changed view',
      position: 8,
      config: changed.views[0]!.config,
    });
  });

  it('reverses schema creates and trashes while retaining table records and view placement', async () => {
    const input = await create();
    const tableId = newId('table');
    const fieldId = newId('field');
    const viewId = newId('view');
    const recordId = newId('record');
    const tableCreate = command({
      kind: 'table.create',
      table: {
        id: tableId,
        name: 'Second table',
        fields: [{ id: newId('field'), name: 'Primary', type: 'text' }],
        view: { id: newId('view'), name: 'Grid' },
        records: [{ id: recordId }],
      },
    });
    const fieldCreate = command({
      kind: 'field.create',
      tableId: input.table.id,
      field: { id: fieldId, name: 'Added', type: 'text' },
      placement: { viewId: input.table.view.id, index: 1 },
    });
    const viewCreate = command({
      kind: 'view.create',
      view: { id: viewId, tableId: input.table.id, name: 'Second view', type: 'grid' },
    });
    await send(input.id, [tableCreate, fieldCreate, viewCreate]);
    for (const edit of [viewCreate, fieldCreate, tableCreate])
      expect(await reverse(input.id, edit.groupId)).toMatchObject({ status: 'applied' });
    const undone = await schema(input.id);
    expect(undone.tables).toHaveLength(1);
    expect(undone.fields).toHaveLength(1);
    expect(undone.views).toHaveLength(1);
    for (const edit of [tableCreate, fieldCreate, viewCreate])
      expect(await reverse(input.id, edit.groupId, 'redo')).toMatchObject({ status: 'applied' });
    const restored = await schema(input.id);
    expect(restored.tables).toHaveLength(2);
    expect(restored.fields).toHaveLength(3);
    expect(restored.views).toHaveLength(3);
    expect(restored.views.find((v) => v.id === input.table.view.id)!.config.fieldOrder).toContain(fieldId);
    const retained = await query(
      server.pool,
      sql`SELECT __id FROM ${ident(server.schemas.data, tableId)} WHERE __deleted_at IS NULL`,
    );
    expect(retained.rows).toEqual([{ __id: recordId }]);
    const groupId = newId('action');
    await send(input.id, [
      command({ kind: 'field.trash', fieldId }, groupId),
      command({ kind: 'view.trash', viewId }, groupId),
      command({ kind: 'table.trash', tableId }, groupId),
      command({ kind: 'database.trash' }, groupId),
    ]);
    expect(await reverse(input.id, groupId)).toMatchObject({ status: 'applied' });
    expect((await schema(input.id)).tables).toHaveLength(2);
    expect(await reverse(input.id, groupId, 'redo')).toMatchObject({ status: 'applied' });
    const hidden = await server.app.inject({
      method: 'GET',
      url: `/api/databases/${input.id}/schema`,
      headers: server.owner.headers,
    });
    expect(hidden.statusCode).toBe(404);
    expect(await reverse(input.id, groupId)).toMatchObject({ status: 'applied' });
    expect((await schema(input.id)).views).toHaveLength(3);
  });

  it('rolls back the whole undo group when a schema inverse conflicts', async () => {
    const fieldId = newId('field');
    const input = await create([
      { id: fieldId, name: 'Original', description: '', type: 'text', options: {} },
    ]);
    const groupId = newId('action');
    await send(input.id, [
      command({ kind: 'field.update', fieldId, name: 'Renamed' }, groupId),
      command({ kind: 'database.update', name: 'Changed' }, groupId),
    ]);
    await send(input.id, [
      command({
        kind: 'field.create',
        tableId: input.table.id,
        field: { id: newId('field'), name: 'Original', type: 'text' },
      }),
    ]);
    const before = await schema(input.id);
    const result = await reverse(input.id, groupId);
    expect(result).toMatchObject({ status: 'rejected', error: { messageKey: 'data.field.nameTaken' } });
    expect(await schema(input.id)).toEqual(before);
    const state = await query<{ state: string }>(
      server.pool,
      sql`SELECT state FROM ${ident(server.schemas.app, 'undo_groups')} WHERE group_id = ${groupId}`,
    );
    expect(state.rows[0]!.state).toBe('done');
  });
});
