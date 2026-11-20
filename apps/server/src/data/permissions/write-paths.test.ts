import { afterAll, beforeAll, expect, it } from 'vitest';
import { AppError, newId, type RowData, type UndoResult } from '@riosoma/contracts';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../../test/fixture.js';
import { apiError } from '../../api-v1/messages.js';
import { fromAppError } from '../../airtable-api/errors.js';
import { mcpError } from '../../mcp/messages.js';
import {
  applied,
  command,
  inject,
  permissionFixture,
  tokenFor,
  type PermissionFixture,
} from './permissions.test-helpers.js';

let kit: TestPostgres;
let server: ServerFixture;
let f: PermissionFixture;

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'writepaths');
  f = await permissionFixture(server);
}, 180_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

async function reverse(groupId: string, who: SignedIn, direction = 'undo') {
  const response = await inject(server, who, 'POST', `/api/databases/${f.databaseId}/${direction}`, {
    commandId: newId('command'),
    groupId,
    clientId: newId('client'),
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<UndoResult>();
}

async function row(id: string) {
  const response = await inject(server, server.owner, 'GET', `/api/tables/${f.people.tableId}/records/${id}`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<RowData>();
}

async function create(values: Record<string, unknown>) {
  const id = newId('record');
  await applied(server, server.owner, f.databaseId, {
    kind: 'record.create',
    tableId: f.people.tableId,
    records: [{ id, values }],
  });
  return id;
}

async function edit(id: string, values: Record<string, unknown>, who = f.persons.creator.signed) {
  const groupId = newId('action');
  await applied(server, who, f.databaseId, {
    kind: 'record.update',
    groupId,
    tableId: f.people.tableId,
    records: [{ id, values }],
  });
  return groupId;
}

async function role(who: SignedIn, value: string) {
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'grants')} SET role = ${value}
    WHERE resource_id = ${f.databaseId} AND principal_id = ${who.userId}`,
  );
}

it.each(['undo', 'redo'])(
  'refuses %s after losing the original record role without consuming history',
  async (direction) => {
    const who = f.persons.creator.signed;
    const id = await create({ [f.people.fields.name]: 'Before' });
    const group = await edit(id, { [f.people.fields.name]: 'After' });
    if (direction === 'redo') expect(await reverse(group, who)).toMatchObject({ status: 'applied' });
    await role(who, 'reader');
    try {
      expect(await reverse(group, who, direction)).toMatchObject({
        status: 'rejected',
        error: { messageKey: 'data.access.denied' },
      });
      expect((await row(id)).values[f.people.fields.name]).toBe(direction === 'undo' ? 'After' : 'Before');
    } finally {
      await role(who, 'creator');
    }
    expect(await reverse(group, who, direction)).toMatchObject({ status: 'applied' });
  },
);

it('requires the schema role for schema history even when records remain editable', async () => {
  const who = f.persons.creator.signed;
  const groupId = newId('action');
  await applied(server, who, f.databaseId, {
    kind: 'field.create',
    groupId,
    tableId: f.people.tableId,
    field: { id: newId('field'), name: 'History field', type: 'text', options: {} },
  });
  await role(who, 'editor');
  try {
    expect(await reverse(groupId, who)).toMatchObject({
      status: 'rejected',
      error: { messageKey: 'data.access.denied' },
    });
  } finally {
    await role(who, 'creator');
  }
});

it('keeps undo within the current record rules', async () => {
  const id = await create({ [f.people.fields.region]: f.people.choices.east });
  const group = await edit(id, { [f.people.fields.region]: f.people.choices.west });
  const who = f.persons.creator.signed;
  await role(who, 'editor');
  try {
    expect(await reverse(group, who)).toMatchObject({ status: 'nothing', skipped: 1 });
    expect((await row(id)).values[f.people.fields.region]).toBe(f.people.choices.west);
  } finally {
    await role(who, 'creator');
  }
  expect(await reverse(group, who, 'redo')).toMatchObject({ status: 'nothing' });
  expect((await row(id)).values[f.people.fields.region]).toBe(f.people.choices.west);
  expect(await reverse(group, who)).toMatchObject({ status: 'applied' });
  expect((await row(id)).values[f.people.fields.region]).toBe(f.people.choices.east);
  expect(await reverse(group, who, 'redo')).toMatchObject({ status: 'applied' });
  expect((await row(id)).values[f.people.fields.region]).toBe(f.people.choices.west);
});

it.each([
  { direction: 'undo', hidden: 'kept', trashed: false },
  { direction: 'undo', hidden: 'merged', trashed: true },
  { direction: 'redo', hidden: 'kept', trashed: false },
  { direction: 'redo', hidden: 'merged', trashed: false },
  { direction: 'redo', hidden: 'merged', trashed: true },
])(
  'skips comment moves during $direction with a hidden $hidden record, trashed: $trashed',
  async ({ direction, hidden, trashed }) => {
    const who = f.persons.creator.signed;
    const kept = await create({
      [f.people.fields.region]: hidden === 'kept' ? f.people.choices.east : f.people.choices.west,
    });
    const merged = await create({
      [f.people.fields.region]: hidden === 'merged' ? f.people.choices.east : f.people.choices.west,
    });
    const commentId = newId('comment');
    await applied(server, server.owner, f.databaseId, {
      kind: 'comment.create',
      tableId: f.people.tableId,
      recordId: merged,
      comment: { id: commentId, body: 'Before merge' },
    });
    const groupId = newId('action');
    await applied(server, who, f.databaseId, {
      kind: 'record.merge',
      groupId,
      tableId: f.people.tableId,
      recordId: kept,
      mergeIds: [merged],
      choices: { [f.people.fields.region]: kept },
    });
    if (direction === 'redo') expect(await reverse(groupId, who)).toMatchObject({ status: 'applied' });
    await role(who, 'editor');
    try {
      const hiddenId = hidden === 'kept' ? kept : merged;
      expect(
        (await inject(server, who, 'GET', `/api/tables/${f.people.tableId}/records/${hiddenId}`)).statusCode,
      ).toBe(404);
      await applied(server, server.owner, f.databaseId, {
        kind: 'comment.update',
        commentId,
        body: 'Updated after access changed',
      });
      if (direction === 'redo' && trashed)
        await applied(server, server.owner, f.databaseId, {
          kind: 'record.trash',
          tableId: f.people.tableId,
          recordIds: [merged],
        });
      const result = await reverse(groupId, who, direction);
      expect(result.skipped).toBeGreaterThanOrEqual(1);
      const comments = await query<{ record_id: string; body: string }>(
        server.pool,
        sql`SELECT record_id, body FROM ${ident(server.schemas.app, 'comments')} WHERE id = ${commentId}`,
      );
      expect(comments.rows).toEqual([
        { record_id: direction === 'undo' ? kept : merged, body: 'Updated after access changed' },
      ]);
      if (direction === 'redo' && hidden === 'merged') {
        const visible = await inject(
          server,
          who,
          'GET',
          `/api/tables/${f.people.tableId}/records/${kept}/comments`,
        );
        expect(visible.statusCode, visible.body).toBe(200);
        expect(visible.json()).toMatchObject({ comments: [] });
      }
    } finally {
      await role(who, 'creator');
    }
  },
);

it('checks person membership when undo restores a value', async () => {
  const person = await server.addMember();
  const first = await create({ [f.people.fields.owner]: [person.userId] });
  const group = await edit(first, { [f.people.fields.owner]: [] });
  await query(
    server.pool,
    sql`DELETE FROM ${ident(server.schemas.app, 'memberships')} WHERE user_id = ${person.userId}`,
  );
  const undone = await reverse(group, f.persons.creator.signed);
  expect(undone.status).not.toBe('applied');
  expect((await row(first)).values[f.people.fields.owner]).toBeNull();
});

it.each(['undo', 'redo'])('skips hidden records during %s of a move', async (direction) => {
  const who = f.persons.creator.signed;
  const visible = await create({ [f.people.fields.region]: f.people.choices.west });
  const hidden = await create({ [f.people.fields.region]: f.people.choices.east });
  const anchor = await create({ [f.people.fields.region]: f.people.choices.west });
  const viewId = newId('view');
  await applied(server, who, f.databaseId, {
    kind: 'view.create',
    view: {
      id: viewId,
      tableId: f.people.tableId,
      name: `Move history ${direction}`,
      type: 'list',
      config: {},
    },
  });
  const positions = async () =>
    (
      await query<{ record_id: string; position: string }>(
        server.pool,
        sql`SELECT record_id, position::text FROM ${ident(server.schemas.app, 'record_positions')}
        WHERE view_id = ${viewId} ORDER BY record_id`,
      )
    ).rows;
  const groupId = newId('action');
  await applied(server, who, f.databaseId, {
    kind: 'record.move',
    groupId,
    tableId: f.people.tableId,
    viewId,
    recordIds: [visible, hidden],
    place: { before: anchor },
  });
  const moved = await positions();
  if (direction === 'redo') expect(await reverse(groupId, who)).toMatchObject({ status: 'applied' });
  const before = await positions();
  await role(who, 'editor');
  try {
    expect(
      await command(server, who, f.databaseId, {
        kind: 'record.move',
        tableId: f.people.tableId,
        viewId,
        recordIds: [hidden],
        place: { after: anchor },
      }),
    ).toMatchObject({ status: 'rejected', error: { messageKey: 'data.access.recordHidden' } });
    expect(await reverse(groupId, who, direction)).toMatchObject({ status: 'applied', skipped: 1 });
    expect(await positions()).toEqual(
      direction === 'undo'
        ? before.filter((entry) => entry.record_id === hidden)
        : moved.filter((entry) => entry.record_id === visible),
    );
  } finally {
    await role(who, 'creator');
  }
});

it('preserves the original signer and time when merging a signature', async () => {
  const fieldId = newId('field');
  await applied(server, server.owner, f.databaseId, {
    kind: 'field.create',
    tableId: f.people.tableId,
    field: { id: fieldId, name: 'Merge signature', type: 'signature', options: {} },
  });
  const kept = await create({});
  const source = await create({ [fieldId]: { name: 'Original signer' } });
  const original = (await row(source)).values[fieldId];
  const groupId = newId('action');
  await applied(server, f.persons.creator.signed, f.databaseId, {
    kind: 'record.merge',
    groupId,
    tableId: f.people.tableId,
    recordId: kept,
    mergeIds: [source],
    choices: { [fieldId]: source },
  });
  expect((await row(kept)).values[fieldId]).toEqual(original);
  expect(await reverse(groupId, f.persons.creator.signed)).toMatchObject({ status: 'applied' });
  expect((await row(kept)).values[fieldId]).toBeNull();
  expect((await row(source)).values[fieldId]).toEqual(original);
  expect(await reverse(groupId, f.persons.creator.signed, 'redo')).toMatchObject({ status: 'applied' });
  expect((await row(kept)).values[fieldId]).toEqual(original);
});

it.each([false, true])('merges only visible source links with a visible link present: %s', async (mixed) => {
  const keptHidden = await create({ [f.people.fields.region]: f.people.choices.east });
  const sourceHidden = await create({ [f.people.fields.region]: f.people.choices.east });
  const visible = await create({ [f.people.fields.region]: f.people.choices.west });
  const kept = newId('record');
  const source = newId('record');
  await applied(server, server.owner, f.databaseId, {
    kind: 'record.create',
    tableId: f.teams.tableId,
    records: [
      { id: kept, values: { [f.teams.fields.name]: 'Kept', [f.teams.fields.people]: [keptHidden] } },
      {
        id: source,
        values: {
          [f.teams.fields.name]: 'Source',
          [f.teams.fields.people]: [sourceHidden, ...(mixed ? [visible] : [])],
        },
      },
    ],
  });
  const read = async (id: string, who: SignedIn) => {
    const response = await inject(server, who, 'GET', `/api/tables/${f.teams.tableId}/records/${id}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<RowData>();
  };
  try {
    const editor = f.persons.editor.signed;
    expect((await read(source, editor)).values[f.teams.fields.people]).toEqual(mixed ? [visible] : []);
    await applied(server, editor, f.databaseId, {
      kind: 'record.merge',
      tableId: f.teams.tableId,
      recordId: kept,
      mergeIds: [source],
      choices: { [f.teams.fields.people]: 'combine' },
    });
    expect((await read(kept, editor)).values[f.teams.fields.people]).toEqual(mixed ? [visible] : []);
    expect((await read(kept, server.owner)).values[f.teams.fields.people]).toEqual([
      ...(mixed ? [visible] : []),
      keptHidden,
    ]);
  } finally {
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.restore',
      tableId: f.teams.tableId,
      recordIds: [source],
    });
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.update',
      tableId: f.teams.tableId,
      records: [kept, source].map((id) => ({ id, values: { [f.teams.fields.people]: [] } })),
    });
  }
});

it('checks person membership when merge combines values', async () => {
  const person = await server.addMember();
  const first = await create({});
  const second = await create({ [f.people.fields.owner]: [person.userId] });
  await query(
    server.pool,
    sql`DELETE FROM ${ident(server.schemas.app, 'memberships')} WHERE user_id = ${person.userId}`,
  );
  const merged = await command(server, server.owner, f.databaseId, {
    kind: 'record.merge',
    tableId: f.people.tableId,
    recordId: first,
    mergeIds: [second],
    choices: { [f.people.fields.owner]: second },
  });
  expect(merged).toMatchObject({ status: 'rejected', error: { messageKey: 'data.user.unknown' } });
  expect((await row(first)).values[f.people.fields.owner]).toBeNull();
  await row(second);
});

it('rolls back a merge that would move the kept record outside its rules', async () => {
  const first = await create({ [f.people.fields.name]: 'Inside', [f.people.fields.notes]: 'Before' });
  const second = await create({ [f.people.fields.name]: 'Outside', [f.people.fields.notes]: 'Allowed' });
  const url = `/api/tables/${f.people.tableId}/record-rules`;
  const permissions = await inject(
    server,
    server.owner,
    'GET',
    `/api/tables/${f.people.tableId}/permissions`,
  );
  const rules = permissions.json<{ records: unknown[] }>().records;
  const added = await inject(server, server.owner, 'PUT', url, {
    rules: [
      ...rules,
      {
        id: newId('recordRule'),
        roles: [],
        users: [f.persons.creator.signed.userId],
        condition: {
          conjunction: 'or',
          conditions: [
            { id: 'name', fieldId: f.people.fields.name, operator: 'is', value: 'Inside' },
            { id: 'notes', fieldId: f.people.fields.notes, operator: 'is', value: 'Allowed' },
          ],
        },
      },
    ],
  });
  expect(added.statusCode, added.body).toBe(200);
  try {
    expect(
      await command(server, f.persons.creator.signed, f.databaseId, {
        kind: 'record.merge',
        tableId: f.people.tableId,
        recordId: first,
        mergeIds: [second],
        choices: { [f.people.fields.name]: second, [f.people.fields.notes]: first },
      }),
    ).toMatchObject({ status: 'rejected', error: { messageKey: 'data.access.recordOutsideRules' } });
    expect((await row(first)).values[f.people.fields.name]).toBe('Inside');
    await row(second);
  } finally {
    await inject(server, server.owner, 'PUT', url, { rules });
  }
});

it('checks the inverse field lock during undo and merge', async () => {
  const first = await create({ [f.people.fields.name]: 'First' });
  const second = await create({ [f.people.fields.team]: [f.teams.records.alpha] });
  const group = await edit(first, { [f.people.fields.team]: [f.teams.records.alpha] });
  const url = `/api/fields/${f.teams.fields.people}/permissions`;
  expect(
    (await inject(server, server.owner, 'PUT', url, { restricted: null, locked: { roles: [], users: [] } }))
      .statusCode,
  ).toBe(200);
  try {
    expect(await reverse(group, f.persons.creator.signed)).toMatchObject({ status: 'nothing', skipped: 1 });
    const kept = await create({ [f.people.fields.name]: 'Kept' });
    expect(
      await command(server, f.persons.creator.signed, f.databaseId, {
        kind: 'record.merge',
        tableId: f.people.tableId,
        recordId: kept,
        mergeIds: [second],
        choices: { [f.people.fields.team]: second },
      }),
    ).toMatchObject({ status: 'rejected', error: { messageKey: 'data.access.fieldLocked' } });
    await row(second);
  } finally {
    await inject(server, server.owner, 'PUT', url, { restricted: null, locked: null });
  }
});

it('names the field and the second record in command value errors', async () => {
  const ids = [newId('record'), newId('record')];
  const result = await command(server, server.owner, f.databaseId, {
    kind: 'record.create',
    tableId: f.people.tableId,
    records: ids.map((id, index) => ({ id, values: { [f.people.fields.salary]: index ? 'bad' : 1 } })),
  });
  expect(result).toMatchObject({
    status: 'rejected',
    error: {
      params: {
        fieldId: f.people.fields.salary,
        field: 'Salary',
        recordId: ids[1],
        recordIndex: 1,
      },
    },
  });
});

it('keeps the submitted position for invalid links after unchanged records are removed', async () => {
  const first = await create({ [f.people.fields.name]: 'Unchanged' });
  const second = await create({ [f.people.fields.name]: 'Invalid link' });
  const result = await command(server, server.owner, f.databaseId, {
    kind: 'record.update',
    tableId: f.people.tableId,
    records: [
      { id: first, values: { [f.people.fields.name]: 'Unchanged' } },
      { id: second, values: { [f.people.fields.team]: [newId('record')] } },
    ],
  });
  expect(result).toMatchObject({
    status: 'rejected',
    error: {
      messageKey: 'data.link.unknownRecord',
      params: { fieldId: f.people.fields.team, recordId: second, recordIndex: 1 },
    },
  });
  expect((await row(second)).values[f.people.fields.team]).toEqual([]);
});

it.each([false, true])(
  'keeps the invalid cell position when updates repeat a record, repeated field: %s',
  async (repeatedField) => {
    const id = await create({ [f.people.fields.name]: 'Before' });
    const result = await command(server, server.owner, f.databaseId, {
      kind: 'record.update',
      tableId: f.people.tableId,
      records: [
        {
          id,
          values: repeatedField
            ? { [f.people.fields.team]: [f.teams.records.alpha] }
            : { [f.people.fields.name]: 'After' },
        },
        { id, values: { [f.people.fields.team]: [newId('record')] } },
        { id, values: { [f.people.fields.name]: 'Last' } },
      ],
    });
    expect(result).toMatchObject({
      status: 'rejected',
      error: {
        messageKey: 'data.link.unknownRecord',
        params: { fieldId: f.people.fields.team, recordId: id, recordIndex: 1 },
      },
    });
    expect((await row(id)).values).toMatchObject({
      [f.people.fields.name]: 'Before',
      [f.people.fields.team]: [],
    });
  },
);

it('names the submitted cell when the inverse link would exceed its limit', async () => {
  await applied(server, server.owner, f.databaseId, {
    kind: 'field.update',
    fieldId: f.people.fields.team,
    options: { linkedTableId: f.teams.tableId, prefersSingle: true },
  });
  const id = newId('record');
  await applied(server, server.owner, f.databaseId, {
    kind: 'record.create',
    tableId: f.teams.tableId,
    records: [{ id, values: { [f.teams.fields.name]: 'Second team' } }],
  });
  expect(
    await command(server, server.owner, f.databaseId, {
      kind: 'record.update',
      tableId: f.teams.tableId,
      records: [
        { id: f.teams.records.alpha, values: {} },
        { id, values: { [f.teams.fields.people]: [f.people.records.ana] } },
      ],
    }),
  ).toMatchObject({
    status: 'rejected',
    error: {
      messageKey: 'data.link.single',
      params: {
        fieldId: f.teams.fields.people,
        recordId: id,
        recordIndex: 1,
      },
    },
  });
  await applied(server, server.owner, f.databaseId, {
    kind: 'field.update',
    fieldId: f.people.fields.team,
    options: { linkedTableId: f.teams.tableId, prefersSingle: false },
  });
});

it('names the record and field for an inactive person in a batch', async () => {
  const ids = [newId('record'), newId('record')];
  expect(
    await command(server, server.owner, f.databaseId, {
      kind: 'record.create',
      tableId: f.people.tableId,
      records: [
        { id: ids[0], values: { [f.people.fields.owner]: [server.owner.userId] } },
        { id: ids[1], values: { [f.people.fields.owner]: [newId('user')] } },
      ],
    }),
  ).toMatchObject({
    status: 'rejected',
    error: {
      messageKey: 'data.user.unknown',
      params: {
        fieldId: f.people.fields.owner,
        recordId: ids[1],
        recordIndex: 1,
      },
    },
  });
});

it('preserves the original signer and time when restoring a signature', async () => {
  const fieldId = newId('field');
  await applied(server, server.owner, f.databaseId, {
    kind: 'field.create',
    tableId: f.people.tableId,
    field: { id: fieldId, name: 'Signed review', type: 'signature', options: {} },
  });
  const id = await create({ [fieldId]: { name: 'First signer' } });
  const original = (await row(id)).values[fieldId];
  const group = await edit(id, { [fieldId]: { name: 'Second signer' } });
  const edited = (await row(id)).values[fieldId];
  expect(await reverse(group, f.persons.creator.signed)).toMatchObject({ status: 'applied' });
  expect((await row(id)).values[fieldId]).toEqual(original);
  expect(await reverse(group, f.persons.creator.signed, 'redo')).toMatchObject({ status: 'applied' });
  expect((await row(id)).values[fieldId]).toEqual(edited);
});

it('passes value context through REST, compatible, and tool error shapes', async () => {
  const params = { fieldId: newId('field'), field: 'Count', recordId: newId('record'), recordIndex: 1 };
  const error = new AppError('validation_failed', 'data.value.notNumber', { params });
  for (const body of [apiError(error), fromAppError(error).body(), mcpError(error)])
    expect(body).toMatchObject({ error: { params } });
  const token = await tokenFor(server, server.owner);
  for (const url of [
    `/api/v1/tables/${f.people.tableId}/records`,
    `/v0/${f.databaseId}/${f.people.tableId}`,
  ]) {
    const response = await server.app.inject({
      method: 'PATCH',
      url,
      headers: { authorization: `Bearer ${token.token}` },
      payload: {
        records: [
          { id: f.people.records.ana, fields: { Salary: 10 } },
          { id: f.people.records.zanzibar, fields: { Salary: 'bad' } },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json()).toMatchObject({
      error: {
        params: {
          fieldId: f.people.fields.salary,
          field: 'Salary',
          recordId: f.people.records.zanzibar,
          recordIndex: 1,
        },
      },
    });
  }
});

it('refuses conversion of a locked field even for the owner', async () => {
  for (const who of [server.owner, f.persons.creator.signed]) {
    expect(
      await command(server, who, f.databaseId, {
        kind: 'field.convert',
        fieldId: f.people.fields.notes,
        to: { type: 'longText', options: {} },
      }),
    ).toMatchObject({ status: 'rejected', error: { messageKey: 'data.access.fieldLockedConversion' } });
  }
});

it('requires the owner to remove choices from a locked field even for a named creator', async () => {
  const fieldId = newId('field');
  const choice = { id: newId('choice'), name: 'Ready', color: 'gray' };
  await applied(server, server.owner, f.databaseId, {
    kind: 'field.create',
    tableId: f.people.tableId,
    field: { id: fieldId, name: 'Locked choices', type: 'singleSelect', options: { choices: [choice] } },
  });
  const id = await create({ [fieldId]: choice.id });
  await inject(server, server.owner, 'PUT', `/api/fields/${fieldId}/permissions`, {
    restricted: null,
    locked: { roles: ['creator'], users: [] },
  });
  const change = { kind: 'field.update', fieldId, options: { choices: [] } };
  expect(await command(server, f.persons.creator.signed, f.databaseId, change)).toMatchObject({
    status: 'rejected',
    error: { messageKey: 'data.access.fieldLockedChoices' },
  });
  expect((await row(id)).values[fieldId]).toBe(choice.id);
  await applied(server, server.owner, f.databaseId, change);
  expect((await row(id)).values[fieldId]).toBeNull();
});

it('rechecks locks when undo restores a schema change', async () => {
  for (const conversion of [false, true]) {
    const fieldId = newId('field');
    const choice = { id: newId('choice'), name: 'Ready', color: 'gray' };
    await applied(server, server.owner, f.databaseId, {
      kind: 'field.create',
      tableId: f.people.tableId,
      field: {
        id: fieldId,
        name: `Schema history ${conversion}`,
        type: 'singleSelect',
        options: { choices: [choice] },
      },
    });
    const id = await create({ [fieldId]: choice.id });
    const groupId = newId('action');
    await applied(
      server,
      f.persons.creator.signed,
      f.databaseId,
      conversion
        ? {
            kind: 'field.convert',
            groupId,
            fieldId,
            to: { type: 'text', options: {} },
          }
        : {
            kind: 'field.update',
            groupId,
            fieldId,
            options: { choices: [] },
          },
    );
    const before = (await row(id)).values[fieldId];
    await inject(server, server.owner, 'PUT', `/api/fields/${fieldId}/permissions`, {
      restricted: null,
      locked: { roles: ['creator'], users: [] },
    });
    expect(await reverse(groupId, f.persons.creator.signed)).toMatchObject({ status: 'nothing', skipped: 1 });
    expect((await row(id)).values[fieldId]).toEqual(before);
  }
});

it('lets a person limited by record rules attach only files they could already open', async () => {
  const files = newId('field');
  await applied(server, server.owner, f.databaseId, {
    kind: 'field.create',
    tableId: f.people.tableId,
    field: { id: files, name: 'Files', type: 'attachment', options: {} },
  });
  const upload = async (who: SignedIn, name: string) => {
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/tables/${f.people.tableId}/fields/${files}/files`,
      headers: { ...who.headers, 'content-type': 'text/plain', 'x-file-name': name },
      payload: Buffer.from(name),
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ id: string; url: string }>();
  };
  const who = f.persons.editor.signed;
  const { ana, zanzibar } = f.people.records;
  const attach = (id: string, ids: string[], by = who) =>
    command(server, by, f.databaseId, {
      kind: 'record.update',
      tableId: f.people.tableId,
      records: [{ id, values: { [files]: ids } }],
    });
  const status = async (url: string) => (await inject(server, who, 'GET', url)).statusCode;

  // One file sits in a record the rule hides, and another is someone else's upload in no record.
  const hidden = await upload(server.owner, 'hidden.txt');
  const pending = await upload(server.owner, 'pending.txt');
  expect(await attach(zanzibar, [hidden.id], server.owner)).toMatchObject({ status: 'applied' });
  expect(await status(hidden.url)).toBe(404);
  // A third is their own upload, now held only by a record with no Region, where the rule's
  // condition is neither true nor false.
  const unset = await upload(who, 'unset.txt');
  expect(await status(unset.url)).toBe(200);
  const blank = await create({ [f.people.fields.name]: 'No region', [files]: [unset.id] });
  expect(await status(unset.url)).toBe(404);
  for (const file of [hidden, pending, unset]) {
    expect(await attach(ana, [file.id])).toMatchObject({
      status: 'rejected',
      error: { messageKey: 'data.file.unknown', params: { fieldId: files, recordId: ana } },
    });
    expect(
      await command(server, who, f.databaseId, {
        kind: 'record.create',
        tableId: f.people.tableId,
        records: [
          { id: newId('record'), values: { [f.people.fields.region]: f.people.choices.west } },
          {
            id: newId('record'),
            values: { [f.people.fields.region]: f.people.choices.west, [files]: [file.id] },
          },
        ],
      }),
    ).toMatchObject({
      status: 'rejected',
      error: { messageKey: 'data.file.unknown', params: { fieldId: files, recordIndex: 1 } },
    });
    expect(await status(file.url)).toBe(404);
    const details = await inject(server, who, 'GET', `/api/files?ids=${file.id}`);
    expect(details.json()).toEqual([]);
  }
  expect((await row(ana)).values[files] ?? null).toBeNull();

  // Their own upload, and a file from a record they see, go where they put them.
  const own = await upload(who, 'own.txt');
  const shared = await upload(server.owner, 'shared.txt');
  expect(await attach(ana, [own.id])).toMatchObject({ status: 'applied' });
  expect(await attach(ana, [own.id, shared.id], server.owner)).toMatchObject({ status: 'applied' });
  const copy = newId('record');
  await applied(server, who, f.databaseId, {
    kind: 'record.create',
    tableId: f.people.tableId,
    records: [
      { id: copy, values: { [f.people.fields.region]: f.people.choices.west, [files]: [shared.id] } },
    ],
  });
  expect((await row(copy)).values[files]).toEqual([shared.id]);
  expect(await status(shared.url)).toBe(200);

  // Undo puts back a file someone else uploaded, which the change being undone took out.
  const kept = await upload(server.owner, 'kept.txt');
  expect(await attach(ana, [kept.id], server.owner)).toMatchObject({ status: 'applied' });
  const groupId = newId('action');
  await applied(server, who, f.databaseId, {
    kind: 'record.update',
    groupId,
    tableId: f.people.tableId,
    records: [{ id: ana, values: { [files]: [] } }],
  });
  expect(await reverse(groupId, who)).toMatchObject({ status: 'applied', skipped: 0 });
  expect((await row(ana)).values[files]).toEqual([kept.id]);
  expect(await reverse(groupId, who, 'redo')).toMatchObject({ status: 'applied', skipped: 0 });
  expect(await reverse(groupId, who)).toMatchObject({ status: 'applied', skipped: 0 });
  expect((await row(ana)).values[files]).toEqual([kept.id]);

  // Someone the rules don't limit still shares any file of the field between records.
  expect(await attach(ana, [hidden.id, pending.id], server.owner)).toMatchObject({ status: 'applied' });
  await applied(server, server.owner, f.databaseId, {
    kind: 'record.trash',
    tableId: f.people.tableId,
    recordIds: [copy, blank],
  });
  await applied(server, server.owner, f.databaseId, {
    kind: 'record.update',
    tableId: f.people.tableId,
    records: [
      { id: ana, values: { [files]: [] } },
      { id: zanzibar, values: { [files]: [] } },
    ],
  });
});

it.each(['folders', 'folder_databases', 'group_members'])(
  'invalidates SQL views for every mutation of %s',
  async (table) => {
    for (const operation of ['insert', 'update', 'delete', 'truncate']) {
      await withTransaction(server.pool, async (db) => {
        const schema = `access_${newId('action').replaceAll('-', '_')}`;
        await query(db, sql`CREATE SCHEMA ${ident(schema)}`);
        await query(db, sql`CREATE VIEW ${ident(schema, 'records')} AS SELECT 1 AS value`);
        await query(
          db,
          sql`INSERT INTO ${ident(server.schemas.app, 'sql_logins')}
        (database_id, role_name, schema_name, ready) VALUES (${f.databaseId}, ${schema}, ${schema}, true)`,
        );
        const target = ident(server.schemas.app, table);
        if (operation === 'insert')
          await query(db, sql`INSERT INTO ${target} SELECT * FROM ${target} WHERE false`);
        if (operation === 'update') await query(db, sql`UPDATE ${target} SET org_id = org_id WHERE false`);
        if (operation === 'delete') await query(db, sql`DELETE FROM ${target} WHERE false`);
        if (operation === 'truncate') await query(db, sql`TRUNCATE ${target} CASCADE`);
        expect(
          (
            await query(
              db,
              sql`SELECT ready FROM ${ident(server.schemas.app, 'sql_logins')}
        WHERE database_id = ${f.databaseId}`,
            )
          ).rows,
          operation,
        ).toEqual([{ ready: false }]);
        expect((await query(db, sql`SELECT to_regclass(${`${schema}.records`}) AS name`)).rows).toEqual([
          { name: null },
        ]);
        await query(db, sql`ROLLBACK`);
      });
    }
  },
);
