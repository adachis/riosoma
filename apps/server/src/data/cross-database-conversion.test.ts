import { afterAll, beforeAll, expect, it } from 'vitest';
import { newId, type RowData } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { applied, command, inject, schemaOf } from './permissions/permissions.test-helpers.js';

let kit: TestPostgres;
let server: ServerFixture;

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'crossconversion');
}, 120_000);

afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

async function database(name: string) {
  const id = newId('database');
  const tableId = newId('table');
  const nameId = newId('field');
  const textId = newId('field');
  const recordId = newId('record');
  const viewId = newId('view');
  const response = await inject(server, server.owner, 'POST', '/api/databases', {
    id,
    name,
    table: {
      id: tableId,
      name,
      fields: [
        { id: nameId, name: 'Name', type: 'text' },
        { id: textId, name: 'Contact text', type: 'text' },
      ],
      view: { id: viewId, name },
      records: [{ id: recordId, values: { [nameId]: name, [textId]: 'Allowed' } }],
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  await applied(server, server.owner, id, {
    kind: 'record.update',
    tableId,
    records: [{ id: recordId, values: { [nameId]: name, [textId]: 'Allowed' } }],
  });
  return { id, tableId, nameId, textId, recordId, viewId };
}

type Database = Awaited<ReturnType<typeof database>>;

function conversion(source: Database, target: Database, options: Record<string, unknown> = {}) {
  return {
    kind: 'field.convert',
    fieldId: source.textId,
    to: { type: 'link', options: { linkedTableId: target.tableId, oneWay: true, ...options } },
    dateOrder: 'mdy',
    timeZone: 'UTC',
  };
}

async function row(database: Database, recordId = database.recordId) {
  const response = await inject(
    server,
    server.owner,
    'GET',
    `/api/tables/${database.tableId}/records/${recordId}`,
  );
  expect(response.statusCode, response.body).toBe(200);
  return response.json<RowData>();
}

async function lock(database: Database, conditional = false) {
  if (!conditional)
    await applied(server, server.owner, database.id, {
      kind: 'record.setLock',
      tableId: database.tableId,
      recordIds: [database.recordId],
      locked: true,
      reason: 'Reviewed',
    });
  await applied(server, server.owner, database.id, {
    kind: 'table.update',
    tableId: database.tableId,
    recordLock: {
      bypass: 'nobody',
      reason: 'Reviewed',
      condition: conditional
        ? {
            conjunction: 'and',
            conditions: [{ id: 'reviewed', fieldId: database.nameId, operator: 'is', value: 'Allowed' }],
          }
        : null,
    },
  });
}

it('rejects conversion previews and writes for a record-limited source without exposing samples', async () => {
  const source = await database('Visible');
  const target = await database('Allowed');
  const hiddenId = newId('record');
  await applied(server, server.owner, source.id, {
    kind: 'record.create',
    tableId: source.tableId,
    records: [
      { id: hiddenId, values: { [source.nameId]: 'Hidden', [source.textId]: 'Hidden confidential payload' } },
    ],
  });
  const who = await server.addMember();
  for (const side of [source, target]) {
    const shared = await inject(server, server.owner, 'PUT', `/api/databases/${side.id}/grants`, {
      principal: { kind: 'user', id: who.userId },
      role: 'creator',
    });
    expect(shared.statusCode, shared.body).toBe(200);
  }
  const rules = await inject(server, server.owner, 'PUT', `/api/tables/${source.tableId}/record-rules`, {
    rules: [
      {
        id: newId('recordRule'),
        roles: ['creator'],
        users: [],
        condition: {
          conjunction: 'and',
          conditions: [{ id: 'visible', fieldId: source.nameId, operator: 'is', value: 'Visible' }],
        },
      },
    ],
  });
  expect(rules.statusCode, rules.body).toBe(200);
  expect(
    (await inject(server, who, 'GET', `/api/tables/${source.tableId}/records/${hiddenId}`)).statusCode,
  ).toBe(404);
  const input = conversion(source, target);
  const { kind: _kind, fieldId: _fieldId, ...previewInput } = input;
  for (const to of [input.to, { type: 'number' }]) {
    const preview = await inject(server, who, 'POST', `/api/fields/${source.textId}/conversion-preview`, {
      ...previewInput,
      to,
    });
    expect(preview.statusCode, preview.body).toBe(403);
    expect(preview.json()).toMatchObject({ error: { messageKey: 'data.access.recordHidden' } });
    expect(preview.body).not.toContain('Hidden confidential payload');
  }
  const before = await schemaOf(server, server.owner, target.id);
  expect(await command(server, who, source.id, input)).toMatchObject({
    status: 'rejected',
    error: { messageKey: 'data.access.recordHidden' },
  });
  expect((await row(source, hiddenId)).values[source.textId]).toBe('Hidden confidential payload');
  expect((await schemaOf(server, server.owner, target.id)).fields).toEqual(before.fields);
});

it('rejects link conversion writes for a record-limited source and preserves hidden text', async () => {
  const source = await database('Visible');
  const target = await database('Allowed');
  const who = await server.addMember();
  for (const side of [source, target]) {
    const shared = await inject(server, server.owner, 'PUT', `/api/databases/${side.id}/grants`, {
      principal: { kind: 'user', id: who.userId },
      role: 'creator',
    });
    expect(shared.statusCode, shared.body).toBe(200);
  }
  const rules = await inject(server, server.owner, 'PUT', `/api/tables/${source.tableId}/record-rules`, {
    rules: [
      {
        id: newId('recordRule'),
        roles: ['creator'],
        users: [],
        condition: {
          conjunction: 'and',
          conditions: [{ id: 'hidden', fieldId: source.nameId, operator: 'is', value: 'Other' }],
        },
      },
    ],
  });
  expect(rules.statusCode, rules.body).toBe(200);
  expect(await command(server, who, source.id, conversion(source, target))).toMatchObject({
    status: 'rejected',
    error: { messageKey: 'data.access.recordHidden' },
  });
  expect((await row(source)).values[source.textId]).toBe('Allowed');
});

it.each([true, false])('honors source record locks during link conversion (one way %s)', async (oneWay) => {
  const source = await database('Source');
  const target = await database('Allowed');
  await lock(source);
  const before = await schemaOf(server, server.owner, target.id);
  expect(
    await command(server, server.owner, source.id, conversion(source, target, { oneWay })),
  ).toMatchObject({
    status: 'rejected',
    error: { messageKey: 'data.locks.recordLocked' },
  });
  expect((await row(source)).values[source.textId]).toBe('Allowed');
  expect((await schemaOf(server, server.owner, target.id)).fields).toEqual(before.fields);
});

it.each([true, false])(
  'honors matched destination record locks before paired conversion (conditional %s)',
  async (conditional) => {
    const source = await database('Source');
    const target = await database('Allowed');
    await lock(target, conditional);
    const before = await schemaOf(server, server.owner, target.id);
    expect(
      await command(server, server.owner, source.id, conversion(source, target, { oneWay: false })),
    ).toMatchObject({
      status: 'rejected',
      error: { messageKey: 'data.locks.recordLocked' },
    });
    expect((await row(source)).values[source.textId]).toBe('Allowed');
    expect((await schemaOf(server, server.owner, target.id)).fields).toEqual(before.fields);
    const junctions = await query(
      server.pool,
      sql`SELECT 1 FROM ${ident(server.schemas.app, 'links')} WHERE left_field_id = ${source.textId}`,
    );
    expect(junctions.rowCount).toBe(0);
  },
);

it('allows one-way conversion to a locked destination and ignores unmatched locked records', async () => {
  const source = await database('Source');
  const target = await database('Excluded');
  const allowedId = newId('record');
  await applied(server, server.owner, target.id, {
    kind: 'record.create',
    tableId: target.tableId,
    records: [{ id: allowedId, values: { [target.nameId]: 'Allowed' } }],
  });
  await lock(target);
  await applied(server, server.owner, source.id, conversion(source, target, { oneWay: false }));
  expect((await row(source)).values[source.textId]).toEqual([allowedId]);
  const second = await database('Second source');
  await applied(server, server.owner, second.id, {
    kind: 'record.update',
    tableId: second.tableId,
    records: [{ id: second.recordId, values: { [second.textId]: 'Excluded' } }],
  });
  await applied(server, server.owner, second.id, conversion(second, target));
  expect((await row(second)).values[second.textId]).toEqual([target.recordId]);
});

it.each(['filter', 'view', 'current record'] as const)(
  'applies the link %s restriction to preview planning and conversion junctions',
  async (limit) => {
    const source = await database('Allowed');
    const target = await database('Excluded');
    const allowedId = newId('record');
    await applied(server, server.owner, target.id, {
      kind: 'record.create',
      tableId: target.tableId,
      records: [{ id: allowedId, values: { [target.nameId]: 'Allowed' } }],
    });
    const excludedSource = newId('record');
    await applied(server, server.owner, source.id, {
      kind: 'record.create',
      tableId: source.tableId,
      records: [{ id: excludedSource, values: { [source.nameId]: 'Excluded', [source.textId]: 'Allowed' } }],
    });
    await applied(server, server.owner, source.id, {
      kind: 'record.update',
      tableId: source.tableId,
      records: [{ id: source.recordId, values: { [source.textId]: 'Excluded, Allowed' } }],
    });
    const filter = {
      conjunction: 'and',
      conditions: [
        {
          id: 'allowed',
          fieldId: target.nameId,
          operator: 'is',
          ...(limit === 'current record' ? { currentFieldId: source.nameId } : { value: 'Allowed' }),
        },
      ],
    };
    if (limit === 'view')
      await applied(server, server.owner, target.id, {
        kind: 'view.update',
        viewId: target.viewId,
        config: { filter },
      });
    const input = conversion(
      source,
      target,
      limit === 'view' ? { limitToViewId: target.viewId } : { filter },
    );
    const { kind: _kind, fieldId: _fieldId, ...previewInput } = input;
    const preview = await inject(
      server,
      server.owner,
      'POST',
      `/api/fields/${source.textId}/conversion-preview`,
      previewInput,
    );
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({
      converted: limit === 'current record' ? 1 : 2,
      emptied: limit === 'current record' ? 1 : 0,
    });
    await applied(server, server.owner, source.id, input);
    expect((await row(source)).values[source.textId]).toEqual([allowedId]);
    expect((await row(source, excludedSource)).values[source.textId]).toEqual(
      limit === 'current record' ? [] : [allowedId],
    );
  },
);

it('resolves destination named functions for external derived fields within their database scope', async () => {
  const source = await database('Source');
  const target = await database('Allowed');
  for (const [side, body] of [
    [source, 'amount * 100'],
    [target, 'amount * 3'],
  ] as const)
    await applied(server, server.owner, side.id, {
      kind: 'namedFunction.create',
      functionId: newId('namedFunction'),
      definition: { name: 'TRIPLE', parameters: ['amount'], body },
    });
  const amountId = newId('field');
  const formulaId = newId('field');
  await applied(server, server.owner, target.id, {
    kind: 'field.create',
    tableId: target.tableId,
    field: { id: amountId, name: 'Amount', type: 'number' },
  });
  await applied(server, server.owner, target.id, {
    kind: 'record.update',
    tableId: target.tableId,
    records: [{ id: target.recordId, values: { [amountId]: 7 } }],
  });
  await applied(server, server.owner, target.id, {
    kind: 'field.create',
    tableId: target.tableId,
    field: {
      id: formulaId,
      name: 'Tripled',
      type: 'formula',
      options: { expression: `TRIPLE({${amountId}})` },
    },
  });
  expect((await row(target)).values[formulaId]).toBe(21);
  await applied(server, server.owner, source.id, conversion(source, target));
  const lookupId = newId('field');
  const rollupId = newId('field');
  for (const [id, type] of [
    [lookupId, 'lookup'],
    [rollupId, 'rollup'],
  ] as const)
    await applied(server, server.owner, source.id, {
      kind: 'field.create',
      tableId: source.tableId,
      field: {
        id,
        name: type,
        type,
        options: {
          linkFieldId: source.textId,
          targetFieldId: formulaId,
          ...(type === 'rollup' ? { fn: 'sum' } : {}),
        },
      },
    });
  const ownFormulaId = newId('field');
  await applied(server, server.owner, source.id, {
    kind: 'field.create',
    tableId: source.tableId,
    field: {
      id: ownFormulaId,
      name: 'Local function',
      type: 'formula',
      options: { expression: `TRIPLE({${rollupId}})` },
    },
  });
  const result = await row(source);
  expect(result.values[lookupId]).toEqual([21]);
  expect(result.values[rollupId]).toBe(21);
  expect(result.values[ownFormulaId]).toBe(2100);
  expect(result.errors).toBeUndefined();
});
