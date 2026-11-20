import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Command,
  DatabaseCreate,
  DatabaseSchema,
  DatabaseSummary,
  LIMITS,
  newId,
  type ChangeBody,
  type CommandBatchResult,
  type DatabaseRole,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { changesChannel, type ChangeNotice } from './notify.js';

let kit: TestPostgres;
let server: ServerFixture;
const clientId = newId('client');

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'commands');
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

function newTable(name = 'Table') {
  return {
    id: newId('table'),
    name,
    fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
    view: { id: newId('view'), name: 'Grid' },
    records: [{ id: newId('record') }],
  };
}

function command(input: Record<string, unknown>, groupId = newId('action')): Command {
  const parsed = Command.parse({ id: newId('command'), groupId, ...input });
  if (parsed.kind === 'view.update') parsed.config = input.config as typeof parsed.config;
  return parsed;
}

async function create(
  who = server.owner,
  input = DatabaseCreate.parse({ id: newId('database'), name: 'Database', table: newTable() }),
) {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: who.headers,
    payload: input,
  });
  expect(response.statusCode, response.body).toBe(200);
  return { input, schema: DatabaseSchema.parse(response.json()) };
}

async function send(databaseId: string, commands: unknown[], who = server.owner) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: who.headers,
    payload: { clientId, commands },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<CommandBatchResult>().results;
}

async function schema(databaseId: string, who = server.owner) {
  const response = await server.app.inject({
    method: 'GET',
    url: `/api/databases/${databaseId}/schema`,
    headers: who.headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  return DatabaseSchema.parse(response.json());
}

async function changes(databaseId: string) {
  return (
    await query<{ seq: string; body: ChangeBody; prev: unknown }>(
      server.pool,
      sql`SELECT seq, body, prev
    FROM ${ident(server.schemas.app, 'changes')} WHERE database_id = ${databaseId} ORDER BY seq`,
    )
  ).rows;
}

async function grant(databaseId: string, who: SignedIn, role: DatabaseRole) {
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
    (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${who.info.org.id}, 'database', ${databaseId}, 'user', ${who.userId}, ${role})`,
  );
}

describe('database routes and commands', () => {
  it('creates and opens a complete schema, records the first two changes, and retries creation safely', async () => {
    const { input, schema: opened } = await create();
    expect(opened).toMatchObject({
      seq: 2,
      database: { id: input.id, role: 'owner', createdBy: server.owner.userId },
      tables: [{ id: input.table.id, primaryFieldId: input.table.fields[0]!.id }],
    });
    expect(await schema(input.id)).toEqual(opened);
    expect((await changes(input.id)).map((c) => c.body)).toEqual([
      { kind: 'database.created', database: expect.objectContaining({ id: input.id, name: input.name }) },
      {
        kind: 'table.created',
        table: opened.tables[0],
        fields: opened.fields,
        views: opened.views,
        records: [
          expect.objectContaining({
            id: input.table.records[0]!.id,
            values: { [input.table.fields[0]!.id]: null },
          }),
        ],
      },
    ]);
    expect((await create(server.owner, input)).schema).toEqual(opened);
    const member = await server.addMember();
    const collision = await server.app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: member.headers,
      payload: input,
    });
    expect(collision.statusCode).toBe(409);
    expect(collision.json().error.code).toBe('conflict');
    await create(member);
    const guest = await server.addMember({ kind: 'guest' });
    const denied = await server.app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: guest.headers,
      payload: { ...input, id: newId('database') },
    });
    expect(denied.statusCode).toBe(403);
    const second = await create();
    await send(input.id, [command({ kind: 'database.update', description: 'Updated' })]);
    const listed = await server.app.inject({
      method: 'GET',
      url: '/api/databases',
      headers: server.owner.headers,
    });
    const summaries = DatabaseSummary.array().parse(listed.json());
    expect(summaries[0]!.id).toBe(input.id);
    expect(summaries.findIndex((d) => d.id === second.input.id)).toBeGreaterThan(0);
    const noGrant = await server.app.inject({
      method: 'GET',
      url: `/api/databases/${input.id}/schema`,
      headers: member.headers,
    });
    expect(noGrant.statusCode).toBe(404);
  });

  it('applies every command kind and stores only the documented broadcast shapes', async () => {
    const { input } = await create();
    const tableId = input.table.id;
    const primary = input.table.fields[0]!.id;
    const fieldId = newId('field');
    const viewId = newId('view');
    const recordId = newId('record');
    const extraTable = newTable('Second table');
    const edits = [
      command({ kind: 'table.create', table: extraTable }),
      command({
        kind: 'table.update',
        tableId: extraTable.id,
        name: 'Renamed table',
        description: 'Description',
      }),
      command({ kind: 'table.move', tableId: extraTable.id, position: -1 }),
      command({
        kind: 'field.create',
        tableId,
        field: { id: fieldId, name: 'Amount', type: 'text' },
        placement: { viewId: input.table.view.id, index: 1 },
      }),
      command({ kind: 'field.update', fieldId, name: 'Count', description: 'Counted items', options: {} }),
      command({ kind: 'field.convert', fieldId, to: { type: 'number' } }),
      command({ kind: 'field.setPrimary', tableId, fieldId }),
      command({ kind: 'field.trash', fieldId: primary }),
      command({ kind: 'field.restore', fieldId: primary }),
      command({ kind: 'view.create', view: { id: viewId, tableId, name: 'Other grid', type: 'grid' } }),
      command({
        kind: 'view.update',
        viewId,
        name: 'Wide grid',
        config: { columnWidths: { [fieldId]: 240 }, rowHeight: 'tall' },
      }),
      command({ kind: 'view.move', viewId, position: -2 }),
      command({ kind: 'view.trash', viewId }),
      command({ kind: 'view.restore', viewId }),
      command({ kind: 'record.create', tableId, records: [{ id: recordId, values: { [fieldId]: 4 } }] }),
      command({ kind: 'record.update', tableId, records: [{ id: recordId, values: { [fieldId]: 5 } }] }),
      command({ kind: 'record.trash', tableId, recordIds: [recordId] }),
      command({ kind: 'record.restore', tableId, recordIds: [recordId] }),
      command({ kind: 'table.trash', tableId: extraTable.id }),
      command({ kind: 'table.restore', tableId: extraTable.id }),
      command({
        kind: 'database.update',
        name: 'Renamed database',
        description: 'Database description',
        icon: 'table',
        color: 'green',
      }),
      command({ kind: 'database.trash' }),
      command({ kind: 'database.restore' }),
    ];
    expect((await send(input.id, edits)).map((result) => result.status)).toEqual(edits.map(() => 'applied'));
    const log = (await changes(input.id)).slice(2);
    expect(log.map((change) => change.body.kind)).toEqual([
      'table.created',
      'table.updated',
      'table.updated',
      'field.created',
      'field.updated',
      'field.converted',
      'field.primarySet',
      'field.trashed',
      'field.restored',
      'view.created',
      'view.updated',
      'view.updated',
      'view.trashed',
      'view.restored',
      'record.created',
      'record.updated',
      'record.trashed',
      'record.restored',
      'table.trashed',
      'table.restored',
      'database.updated',
      'database.trashed',
      'database.restored',
    ]);
    expect(log[3]!.body).toMatchObject({
      views: [{ id: input.table.view.id, config: { fieldOrder: [primary, fieldId] } }],
    });
    expect(log[4]!.body).toMatchObject({ removedChoiceIds: [] });
    expect(log[15]!.body).toEqual({
      kind: 'record.updated',
      tableId,
      records: [
        {
          id: recordId,
          values: { [fieldId]: 5 },
          updatedAt: expect.any(String),
          updatedBy: server.owner.userId,
        },
      ],
    });
    expect(log[15]!.prev).toEqual({ records: [{ id: recordId, values: { [fieldId]: 4 } }] });
    for (const { body } of log) {
      expect(body).not.toHaveProperty('prev');
      if ('field' in body)
        expect(Object.keys(body.field).sort()).toEqual(
          [
            'id',
            'tableId',
            'name',
            'description',
            'type',
            'options',
            'position',
            'createdAt',
            'updatedAt',
          ].sort(),
        );
      if ('table' in body)
        expect(Object.keys(body.table).sort()).toEqual(
          [
            'id',
            'databaseId',
            'name',
            'description',
            'primaryFieldId',
            'allowComputedOverrides',
            'historyRetentionDays',
            'position',
            'createdAt',
            'updatedAt',
          ].sort(),
        );
      if ('database' in body)
        expect(Object.keys(body.database).sort()).toEqual(
          ['id', 'name', 'description', 'icon', 'color', 'createdBy', 'createdAt', 'updatedAt'].sort(),
        );
    }
    const final = await schema(input.id);
    expect(final.seq).toBe(25);
    expect(final.tables.find((t) => t.id === tableId)?.primaryFieldId).toBe(fieldId);
    expect(final.views.find((v) => v.id === viewId)).toMatchObject({
      position: -2,
      config: { rowHeight: 'tall' },
    });
    const version = await query<{ data_version: string }>(
      server.pool,
      sql`SELECT data_version FROM ${ident(server.schemas.app, 'tables')} WHERE id = ${tableId}`,
    );
    expect(Number(version.rows[0]!.data_version)).toBe(5);
  });

  it.each(['owner', 'creator', 'editor', 'commenter', 'reader'] as const)(
    'enforces %s grants on every category of command',
    async (role) => {
      const { input } = await create();
      const person = await server.addMember();
      await grant(input.id, person, role);
      expect((await schema(input.id, person)).database.role).toBe(role);
      const results = await send(
        input.id,
        [
          command({
            kind: 'record.update',
            tableId: input.table.id,
            records: [{ id: input.table.records[0]!.id, values: { [input.table.fields[0]!.id]: 'Edited' } }],
          }),
          command({ kind: 'table.update', tableId: input.table.id, name: 'Changed' }),
          command({ kind: 'field.update', fieldId: input.table.fields[0]!.id, description: 'Changed' }),
          command({ kind: 'view.update', viewId: input.table.view.id, name: 'Changed' }),
          command({ kind: 'database.update', name: 'Changed' }),
          command({ kind: 'database.trash' }),
        ],
        person,
      );
      const permitted = [
        role === 'owner' || role === 'creator' || role === 'editor',
        ...Array<boolean>(4).fill(role === 'owner' || role === 'creator'),
        role === 'owner',
      ];
      results.forEach((result, i) => {
        expect(result.status).toBe(permitted[i] ? 'applied' : 'rejected');
        if (!permitted[i]) expect(result.error?.code).toBe('forbidden');
      });
    },
  );

  it('hides absent grants and rejects IDs belonging to a different database or table', async () => {
    const { input } = await create();
    const other = await create();
    const member = await server.addMember();
    const absent = await send(input.id, [command({ kind: 'database.update', name: 'Hidden' })], member);
    expect(absent[0]!.error?.code).toBe('not_found');
    const listed = await server.app.inject({ method: 'GET', url: '/api/databases', headers: member.headers });
    expect(listed.json()).toEqual([]);
    const results = await send(input.id, [
      command({ kind: 'table.trash', tableId: other.input.table.id }),
      command({ kind: 'field.update', fieldId: other.input.table.fields[0]!.id, name: 'Foreign' }),
      command({ kind: 'view.update', viewId: other.input.table.view.id, name: 'Foreign' }),
      command({
        kind: 'record.create',
        tableId: other.input.table.id,
        records: [{ id: newId('record'), values: {} }],
      }),
      command({
        kind: 'field.setPrimary',
        tableId: input.table.id,
        fieldId: other.input.table.fields[0]!.id,
      }),
      command({
        kind: 'field.create',
        tableId: input.table.id,
        field: { id: newId('field'), name: 'Foreign', type: 'text' },
        placement: { viewId: other.input.table.view.id, index: 0 },
      }),
      command({
        kind: 'view.update',
        viewId: input.table.view.id,
        config: { fieldOrder: [other.input.table.fields[0]!.id] },
      }),
    ]);
    expect(results.map((result) => result.error?.code)).toEqual(results.map(() => 'not_found'));
    expect((await schema(input.id)).seq).toBe(2);
  });

  it('stores successful and rejected results, applies valid neighbors, and normalizes cell values', async () => {
    const { input } = await create();
    const tableId = input.table.id;
    const fieldId = input.table.fields[0]!.id;
    const recordId = input.table.records[0]!.id;
    const good = command({
      kind: 'record.update',
      tableId,
      records: [{ id: recordId, values: { [fieldId]: 'One\nline' } }],
    });
    const bad = command({
      kind: 'record.update',
      tableId,
      records: [{ id: recordId, values: { [newId('field')]: 'Unknown' } }],
    });
    const last = command({ kind: 'database.update', name: 'After bad command' });
    const first = await send(input.id, [good, bad, last]);
    expect(first.map((r) => r.status)).toEqual(['applied', 'rejected', 'applied']);
    expect(first[1]!.error?.messageKey).toBe('data.field.unknown');
    expect(await send(input.id, [good, bad, last])).toEqual([
      { ...first[0], status: 'duplicate' },
      first[1],
      { ...first[2], status: 'duplicate' },
    ]);
    expect((await schema(input.id)).seq).toBe(4);
    expect((await changes(input.id))[2]!.body).toMatchObject({
      records: [{ values: { [fieldId]: 'One line' } }],
    });
    const malformed = { ...command({ kind: 'table.move', tableId, position: 0 }), position: 'wrong' };
    const mixed = await send(input.id, [
      malformed,
      command({ kind: 'table.update', tableId, description: 'Still applied' }),
    ]);
    expect(mixed.map((r) => r.status)).toEqual(['rejected', 'applied']);
    expect(await send(input.id, [malformed])).toEqual([mixed[0]]);
    const duplicate = command({ kind: 'record.create', tableId, records: [{ id: recordId, values: {} }] });
    expect((await send(input.id, [duplicate]))[0]!.error?.messageKey).toBe('data.record.exists');
    const missing = command({
      kind: 'record.update',
      tableId,
      records: [{ id: newId('record'), values: {} }],
    });
    expect((await send(input.id, [missing]))[0]!.error?.messageKey).toBe('data.record.missing');
    const changed = command({
      kind: 'record.update',
      tableId,
      records: [
        { id: newId('record'), values: { [fieldId]: 'Missing' } },
        { id: recordId, values: { [fieldId]: 'Actual' } },
      ],
    });
    await send(input.id, [changed]);
    expect((await changes(input.id)).at(-1)!.body).toMatchObject({
      records: [{ id: recordId, values: { [fieldId]: 'Actual' } }],
    });
  });

  it('rejects invalid values, duplicate names, primary-field changes, and last-table/view deletion', async () => {
    const { input } = await create();
    const tableId = input.table.id;
    const primary = input.table.fields[0]!.id;
    const numeric = newId('field');
    const computed = newId('field');
    const checkbox = newId('field');
    await send(input.id, [
      command({
        kind: 'field.create',
        tableId,
        field: { id: numeric, name: 'Number', type: 'number', options: { allowNegative: false } },
      }),
      command({
        kind: 'field.create',
        tableId,
        field: { id: computed, name: 'Created', type: 'createdTime' },
      }),
      command({ kind: 'field.create', tableId, field: { id: checkbox, name: 'Check', type: 'checkbox' } }),
    ]);
    const cases: Array<[Record<string, unknown>, string]> = [
      [
        { kind: 'record.create', tableId, records: [{ id: newId('record'), values: { [numeric]: 'text' } }] },
        'data.value.notNumber',
      ],
      [
        { kind: 'record.create', tableId, records: [{ id: newId('record'), values: { [numeric]: -1 } }] },
        'data.value.negative',
      ],
      [
        { kind: 'record.create', tableId, records: [{ id: newId('record'), values: { [computed]: null } }] },
        'data.value.computed',
      ],
      [
        { kind: 'field.create', tableId, field: { id: newId('field'), name: 'nAmE', type: 'text' } },
        'data.field.nameTaken',
      ],
      [{ kind: 'field.update', fieldId: numeric, name: 'nAmE' }, 'data.field.nameTaken'],
      [{ kind: 'field.update', fieldId: numeric, options: { precision: 9 } }, 'errors.validationFailed'],
      [{ kind: 'table.create', table: newTable('tAbLe') }, 'data.table.nameTaken'],
      [
        { kind: 'view.create', view: { id: newId('view'), tableId, name: 'gRiD', type: 'grid' } },
        'data.view.nameTaken',
      ],
      [{ kind: 'field.trash', fieldId: primary }, 'data.field.primary'],
      [{ kind: 'field.restore', fieldId: primary }, 'data.field.primary'],
      [{ kind: 'field.convert', fieldId: primary, to: { type: 'checkbox' } }, 'data.field.primaryType'],
      [{ kind: 'field.setPrimary', fieldId: checkbox, tableId }, 'data.field.primaryType'],
      [
        {
          kind: 'table.create',
          table: {
            ...newTable('Invalid primary'),
            fields: [{ id: newId('field'), name: 'Check', type: 'checkbox' }],
          },
        },
        'data.field.primaryType',
      ],
      [{ kind: 'table.trash', tableId }, 'data.table.last'],
      [{ kind: 'view.trash', viewId: input.table.view.id }, 'data.view.last'],
    ];
    const results = await send(
      input.id,
      cases.map(([input]) => command(input)),
    );
    expect(results.map((r) => r.error?.messageKey)).toEqual(cases.map(([, key]) => key));
    expect((await schema(input.id)).seq).toBe(5);
  });

  it('enforces the field limit and restores colliding names with a bounded suffix', async () => {
    const { input } = await create();
    const tableId = input.table.id;
    const fieldId = newId('field');
    await send(input.id, [
      command({ kind: 'field.create', tableId, field: { id: fieldId, name: 'Recovered', type: 'text' } }),
      command({ kind: 'field.trash', fieldId }),
      command({
        kind: 'field.create',
        tableId,
        field: { id: newId('field'), name: 'recovered', type: 'text' },
      }),
      command({ kind: 'field.restore', fieldId }),
    ]);
    expect((await schema(input.id)).fields.find((f) => f.id === fieldId)?.name).toBe('Recovered (restored)');
    const extras = Array.from({ length: LIMITS.fieldsPerTable - 3 }, (_, index) => ({
      id: newId('field'),
      name: `F${index}`,
    }));
    // Computed metadata fills the limit without creating hundreds of unrelated physical columns.
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'fields')}
      (id, org_id, table_id, name, type, column_name, position)
      SELECT item->>'id', ${server.owner.info.org.id}, ${tableId}, item->>'name', 'recordId', item->>'id', 10
      FROM jsonb_array_elements(${JSON.stringify(extras)}::jsonb) AS batch(item)`,
    );
    const results = await send(input.id, [
      command({
        kind: 'field.create',
        tableId,
        field: { id: newId('field'), name: 'Too many', type: 'text' },
      }),
    ]);
    expect(results[0]!.error?.messageKey).toBe('data.field.tooMany');
  });

  it('replaces whole view configuration keys and audits counts without values', async () => {
    const { input } = await create();
    const tableId = input.table.id;
    const fieldId = input.table.fields[0]!.id;
    const secret = 'private cell content';
    await send(input.id, [
      command({
        kind: 'view.update',
        viewId: input.table.view.id,
        config: { columnWidths: { [fieldId]: 400 }, rowHeight: 'tall' },
      }),
      command({ kind: 'view.update', viewId: input.table.view.id, config: { columnWidths: {} } }),
      command({
        kind: 'record.create',
        tableId,
        records: [
          { id: newId('record'), values: { [fieldId]: secret } },
          { id: newId('record'), values: {} },
        ],
      }),
    ]);
    expect((await schema(input.id)).views[0]!.config).toMatchObject({ columnWidths: {}, rowHeight: 'tall' });
    const audit = await query<{ action: string; metadata: Record<string, unknown> }>(
      server.pool,
      sql`SELECT action, metadata FROM ${ident(server.schemas.audit, 'events')}
      WHERE metadata->>'databaseId' = ${input.id} ORDER BY id`,
    );
    expect(audit.rows.map((r) => r.action).sort()).toEqual(
      [
        'data.database.created',
        'data.table.created',
        'data.view.updated',
        'data.view.updated',
        'data.records.created',
      ].sort(),
    );
    expect(audit.rows.find((r) => r.action === 'data.records.created')!.metadata).toEqual({
      databaseId: input.id,
      tableId,
      count: 2,
    });
    expect(JSON.stringify(audit.rows)).not.toContain(secret);
    expect(JSON.stringify(audit.rows)).not.toContain('values');
  });

  it('orders 20 concurrent commits with gapless notifications and serializes duplicate IDs', async () => {
    const listener = await server.pool.connect();
    const notices: ChangeNotice[] = [];
    const onNotice = (notice: { payload?: string }) => {
      if (notice.payload) notices.push(JSON.parse(notice.payload) as ChangeNotice);
    };
    listener.on('notification', onNotice);
    try {
      await query(listener, sql`LISTEN ${ident(changesChannel(server.schemas))}`);
      const { input } = await create();
      const requests = Array.from({ length: 20 }, (_, index) =>
        command({
          kind: 'record.create',
          tableId: input.table.id,
          records: [{ id: newId('record'), values: { [input.table.fields[0]!.id]: String(index) } }],
        }),
      );
      const results = await Promise.all(requests.map((cmd) => send(input.id, [cmd])));
      expect(
        results
          .flat()
          .map((r) => r.seq)
          .sort((a, b) => a! - b!),
      ).toEqual(Array.from({ length: 20 }, (_, i) => i + 3));
      await expect.poll(() => notices.filter((n) => n.databaseId === input.id).length).toBe(22);
      expect(notices.filter((n) => n.databaseId === input.id).map((n) => n.seq)).toEqual(
        Array.from({ length: 22 }, (_, i) => i + 1),
      );
      expect((await changes(input.id)).map((r) => Number(r.seq))).toEqual(
        Array.from({ length: 22 }, (_, i) => i + 1),
      );
      const shared = command({ kind: 'database.update', name: 'Once' });
      const duplicates = await Promise.all(Array.from({ length: 5 }, () => send(input.id, [shared])));
      expect(
        duplicates
          .flat()
          .map((r) => r.status)
          .sort(),
      ).toEqual(['applied', 'duplicate', 'duplicate', 'duplicate', 'duplicate']);
      expect((await schema(input.id)).seq).toBe(23);
    } finally {
      await query(listener, sql`UNLISTEN *`);
      listener.off('notification', onNotice);
      listener.release();
    }
  });

  it('rolls back changes, audits, and queued notifications on a system error, then safely resends the batch', async () => {
    const { input } = await create();
    const first = command({ kind: 'database.update', name: 'Committed first' });
    const failing = command({
      kind: 'record.create',
      tableId: input.table.id,
      records: [{ id: newId('record'), values: {} }],
    });
    await send(input.id, [first]);
    const listener = await server.pool.connect();
    const notices: ChangeNotice[] = [];
    const onNotice = (notice: { payload?: string }) => {
      if (notice.payload) notices.push(JSON.parse(notice.payload) as ChangeNotice);
    };
    listener.on('notification', onNotice);
    await query(listener, sql`LISTEN ${ident(changesChannel(server.schemas))}`);
    await query(
      server.pool,
      sql`CREATE FUNCTION ${ident(server.schemas.app, 'reject_command')}() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN RAISE EXCEPTION 'errors.unavailable'; END $body$`,
    );
    await query(
      server.pool,
      sql`CREATE TRIGGER reject_command BEFORE INSERT ON ${ident(server.schemas.app, 'commands')}
      FOR EACH ROW EXECUTE FUNCTION ${ident(server.schemas.app, 'reject_command')}()`,
    );
    try {
      const response = await server.app.inject({
        method: 'POST',
        url: `/api/databases/${input.id}/commands`,
        headers: server.owner.headers,
        payload: { clientId, commands: [first, failing] },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.messageKey).toBe('errors.unavailable');
      await query(listener, sql`SELECT pg_sleep(0.03)`);
      expect(notices).toEqual([]);
      expect((await changes(input.id)).map((c) => Number(c.seq))).toEqual([1, 2, 3]);
      const rows = await query(
        server.pool,
        sql`SELECT __id FROM ${ident(server.schemas.data, input.table.id)}`,
      );
      expect(rows.rowCount).toBe(1);
      const audit = await query(
        server.pool,
        sql`SELECT id FROM ${ident(server.schemas.audit, 'events')} WHERE action = 'data.records.created' AND metadata->>'databaseId' = ${input.id}`,
      );
      expect(audit.rowCount).toBe(0);
    } finally {
      await query(server.pool, sql`DROP TRIGGER reject_command ON ${ident(server.schemas.app, 'commands')}`);
      await query(server.pool, sql`DROP FUNCTION ${ident(server.schemas.app, 'reject_command')}()`);
      await query(listener, sql`UNLISTEN *`);
      listener.off('notification', onNotice);
      listener.release();
    }
    expect((await send(input.id, [first, failing])).map((r) => r.status)).toEqual(['duplicate', 'applied']);
    expect((await schema(input.id)).seq).toBe(4);
  });

  it.each(['40001', '40P01'])(
    'retries SQLSTATE %s three times without leaving sequence gaps',
    async (code) => {
      const { input } = await create();
      await query(server.pool, sql`CREATE SEQUENCE ${ident(server.schemas.app, 'retry_attempts')}`);
      // The sequence survives rollback and makes the fourth attempt succeed.
      const body =
        code === '40001'
          ? sql`CREATE FUNCTION ${ident(server.schemas.app, 'retry_command')}() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN IF nextval(TG_TABLE_SCHEMA || '.retry_attempts') <= 3 THEN RAISE EXCEPTION SQLSTATE '40001'; END IF; RETURN NEW; END $body$`
          : sql`CREATE FUNCTION ${ident(server.schemas.app, 'retry_command')}() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN IF nextval(TG_TABLE_SCHEMA || '.retry_attempts') <= 3 THEN RAISE EXCEPTION SQLSTATE '40P01'; END IF; RETURN NEW; END $body$`;
      await query(server.pool, body);
      await query(
        server.pool,
        sql`CREATE TRIGGER retry_command BEFORE INSERT ON ${ident(server.schemas.app, 'commands')}
      FOR EACH ROW EXECUTE FUNCTION ${ident(server.schemas.app, 'retry_command')}()`,
      );
      try {
        const results = await send(input.id, [command({ kind: 'database.update', name: 'Retried' })]);
        expect(results[0]).toMatchObject({ status: 'applied', seq: 3 });
        const attempts = await query<{ last_value: string }>(
          server.pool,
          sql`SELECT last_value FROM ${ident(server.schemas.app, 'retry_attempts')}`,
        );
        expect(Number(attempts.rows[0]!.last_value)).toBe(4);
        expect((await changes(input.id)).map((c) => Number(c.seq))).toEqual([1, 2, 3]);
      } finally {
        await query(server.pool, sql`DROP TRIGGER retry_command ON ${ident(server.schemas.app, 'commands')}`);
        await query(server.pool, sql`DROP FUNCTION ${ident(server.schemas.app, 'retry_command')}()`);
        await query(server.pool, sql`DROP SEQUENCE ${ident(server.schemas.app, 'retry_attempts')}`);
      }
    },
  );
});

it('stores sidebar folders through commands and rejects foreign item membership', async () => {
  const { input } = await create();
  const other = await create();
  const folderId = newId('folder');
  const navigation = {
    folders: [{ id: folderId, name: 'Planning', section: 'table', parentId: null, position: 0 }],
    parents: { [input.table.id]: folderId },
  };
  const applied = await send(input.id, [command({ kind: 'database.update', navigation })]);
  expect(applied[0]?.status).toBe('applied');
  expect((await schema(input.id)).database.navigation).toEqual(navigation);
  const refused = await send(input.id, [
    command({
      kind: 'database.update',
      navigation: { ...navigation, parents: { [other.input.table.id]: folderId } },
    }),
  ]);
  expect(refused[0]?.status).toBe('rejected');
  expect((await schema(input.id)).database.navigation).toEqual(navigation);
});

it('undoes a name change without replacing later sidebar navigation', async () => {
  const { input } = await create();
  await send(input.id, [
    command({
      kind: 'database.update',
      navigation: {
        folders: [{ id: 'original', name: 'Original', section: 'table', parentId: null, position: 0 }],
        parents: {},
      },
    }),
  ]);
  const renamed = command({ kind: 'database.update', name: 'Renamed' });
  await send(input.id, [renamed]);
  const navigation = {
    folders: [{ id: 'later', name: 'Later', section: 'table', parentId: null, position: 0 }],
    parents: {},
  };
  await send(input.id, [command({ kind: 'database.update', navigation })]);
  const undone = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${input.id}/undo`,
    headers: server.owner.headers,
    payload: { groupId: renamed.groupId, clientId, commandId: newId('command') },
  });
  expect(undone.statusCode, undone.body).toBe(200);
  expect((await schema(input.id)).database.navigation).toEqual(navigation);
});

it('patches individual sidebar entries and preserves later peer changes during undo', async () => {
  const { input } = await create();
  const navigation = {
    folders: [
      { id: 'first', name: 'First', section: 'table', parentId: null, position: 0 },
      { id: 'second', name: 'Second', section: 'table', parentId: null, position: 1 },
    ],
    parents: {},
  };
  await send(input.id, [command({ kind: 'database.update', navigation })]);
  const moved = {
    id: newId('command'),
    groupId: newId('action'),
    kind: 'database.navigation',
    change: { kind: 'item.move', id: input.table.id, parentId: 'first' },
  };
  expect((await send(input.id, [moved]))[0]!.status).toBe('applied');
  await send(input.id, [
    {
      id: newId('command'),
      groupId: newId('action'),
      kind: 'database.navigation',
      change: { kind: 'folder.rename', id: 'second', name: 'Peer name' },
    },
  ]);
  const undo = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${input.id}/undo`,
    headers: server.owner.headers,
    payload: { groupId: moved.groupId, clientId, commandId: newId('command') },
  });
  expect(undo.statusCode, undo.body).toBe(200);
  const final = (await schema(input.id)).database.navigation!;
  expect(final.parents[input.table.id]).toBeUndefined();
  expect(final.folders.find((folder) => folder.id === 'second')!.name).toBe('Peer name');
});

it('deletes a sidebar folder and reparents its contents in one undoable command', async () => {
  const { input } = await create();
  const navigation = {
    folders: [
      { id: 'parent', name: 'Parent', section: 'table', parentId: null, position: 0 },
      { id: 'child', name: 'Child', section: 'table', parentId: 'parent', position: 1 },
      { id: 'nested', name: 'Nested', section: 'table', parentId: 'child', position: 2 },
    ],
    parents: { [input.table.id]: 'child' },
  };
  await send(input.id, [command({ kind: 'database.update', navigation })]);
  const deleted = {
    id: newId('command'),
    groupId: newId('action'),
    kind: 'database.navigation',
    change: { kind: 'folder.delete', id: 'child' },
  };
  expect((await send(input.id, [deleted]))[0]!.status).toBe('applied');
  const after = (await schema(input.id)).database.navigation!;
  expect(after.folders.map((folder) => folder.id)).toEqual(['parent', 'nested']);
  expect(after.folders[1]!.parentId).toBe('parent');
  expect(after.parents[input.table.id]).toBe('parent');
  const undo = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${input.id}/undo`,
    headers: server.owner.headers,
    payload: { groupId: deleted.groupId, clientId, commandId: newId('command') },
  });
  expect(undo.statusCode, undo.body).toBe(200);
  const restored = (await schema(input.id)).database.navigation!;
  expect(restored.parents).toEqual(navigation.parents);
  expect(restored.folders).toEqual(expect.arrayContaining(navigation.folders));
});
