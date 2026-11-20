import { AccessScope } from './access.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  FieldSpec,
  newId,
  type CommandBatchResult,
  type Change,
  type ChangeBody,
  type DatabaseSchema,
  type RowData,
  type RowsPage,
} from '@riosoma/contracts';
import { check, evaluate, isError, parse, resolve } from '@riosoma/formula';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { loadFields } from './metadata.js';
import { formulaExpression, formulaSpec, prepareFormula } from './physical/formulas.js';
import { fetchPageByRid, fetchRecord } from './physical/records.js';
import type { StoredField } from './types.js';

let kit: TestPostgres;
let server: ServerFixture;
const clientId = newId('client');
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'formulas');
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

async function get<T>(url: string): Promise<T> {
  const response = await server.app.inject({ url, headers: server.owner.headers });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}
async function send(databaseId: string, input: Record<string, unknown>, error?: string) {
  const groupId = newId('action');
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: server.owner.headers,
    payload: { clientId, commands: [{ id: newId('command'), groupId, ...input }] },
  });
  expect(response.statusCode, response.body).toBe(200);
  const result = response.json<CommandBatchResult>().results[0]!;
  if (error) expect(result.error?.messageKey, response.body).toBe(error);
  else expect(result.status, response.body).toBe('applied');
  return { groupId, result };
}
async function setup() {
  const databaseId = newId('database'),
    tableId = newId('table'),
    viewId = newId('view');
  const textId = newId('field'),
    numberId = newId('field'),
    flagId = newId('field'),
    dateId = newId('field');
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: databaseId,
      name: 'Formulas',
      table: {
        id: tableId,
        name: 'Records',
        fields: [
          { id: textId, name: 'Name', type: 'text' },
          { id: numberId, name: 'Amount', type: 'number' },
          { id: flagId, name: 'Flag', type: 'checkbox' },
          { id: dateId, name: 'Day', type: 'date' },
        ],
        view: { id: viewId, name: 'Grid' },
        records: [],
      },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  const ids = Array.from({ length: 12 }, () => newId('record'));
  await send(databaseId, {
    kind: 'record.create',
    tableId,
    records: ids.map((id, index) => ({
      id,
      values: {
        [textId]: [null, '', 'Résumé 😀', 'plain'][index % 4],
        [numberId]: index % 4 === 0 ? null : index - 5,
        [flagId]: index % 2 === 0,
        [dateId]: index % 3 ? `2024-02-${String(index + 1).padStart(2, '0')}` : null,
      },
    })),
  });
  const add = async (expression: string, name = 'Computed', extra: Record<string, unknown> = {}) => {
    const id = newId('field');
    await send(databaseId, {
      kind: 'field.create',
      tableId,
      field: { id, name, type: 'formula', options: { expression, ...extra } },
    });
    return id;
  };
  const schema = () => get<DatabaseSchema>(`/api/databases/${databaseId}/schema`);
  const page = () => get<RowsPage>(`/api/views/${viewId}/rows`);
  const row = (id = ids[1]!) => get<RowData>(`/api/tables/${tableId}/records/${id}`);
  const undo = async (groupId: string, direction = 'undo') => {
    const result = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${databaseId}/${direction}`,
      headers: server.owner.headers,
      payload: { commandId: newId('command'), clientId, groupId },
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json(), result.body).toMatchObject({ status: 'applied', skipped: 0 });
  };
  return { databaseId, tableId, viewId, textId, numberId, flagId, dateId, ids, add, schema, page, row, undo };
}

describe('formula fields', () => {
  it('stores IDs and derived metadata, follows renames, and recovers after trash and restore', async () => {
    const f = await setup();
    const id = await f.add('{Amount} * 2', 'Double', { resultType: 'text', sortable: false });
    const field = (await f.schema()).fields.find((field) => field.id === id)!;
    expect(field.options).toMatchObject({
      expression: `({${f.numberId}} * 2)`,
      resultType: 'number',
      sortable: true,
    });
    expect(JSON.stringify(field)).not.toContain('columnName');
    await send(f.databaseId, { kind: 'field.update', fieldId: f.numberId, name: 'Renamed' });
    expect((await f.row()).values[id]).toBe(-8);
    await send(f.databaseId, { kind: 'field.trash', fieldId: f.numberId });
    expect(await f.row()).toMatchObject({
      values: { [id]: null },
      errors: { [id]: 'formula.field.unknown' },
    });
    await send(f.databaseId, { kind: 'field.restore', fieldId: f.numberId });
    expect((await f.row()).values[id]).toBe(-8);
    expect((await f.page()).rows[1]?.values[id]).toBe(-8);
  });

  it('rejects parse/type errors with positions and direct and indirect cycles', async () => {
    const f = await setup();
    for (const expression of ['{Amount} +', 'ABS({Name})', '{Missing}']) {
      const parsed = parse(expression);
      const resolved =
        'ast' in parsed
          ? resolve(parsed.ast, [
              { id: f.numberId, name: 'Amount', type: 'number' },
              { id: f.textId, name: 'Name', type: 'text' },
            ])
          : parsed;
      const checked = 'ast' in resolved ? check(resolved.ast) : resolved;
      if (!('error' in checked)) throw new Error('Expected invalid formula');
      const { result } = await send(
        f.databaseId,
        {
          kind: 'field.create',
          tableId: f.tableId,
          field: { id: newId('field'), name: 'Invalid', type: 'formula', options: { expression } },
        },
        checked.error.messageKey,
      );
      expect(result.error).toMatchObject({
        code: 'validation_failed',
        params: { start: checked.error.start, end: checked.error.end },
      });
    }
    await send(
      f.databaseId,
      {
        kind: 'field.create',
        tableId: f.tableId,
        field: { id: newId('field'), name: 'Self', type: 'formula', options: { expression: '{Self}' } },
      },
      'formula.field.circular',
    );
    const a = await f.add('{Amount} + 1', 'A');
    await f.add('{A} * 2', 'B');
    await f.add('{B} + 3', 'C');
    await send(
      f.databaseId,
      { kind: 'field.update', fieldId: a, options: { expression: '{C} + 1' } },
      'formula.field.circular',
    );
    await send(
      f.databaseId,
      {
        kind: 'field.convert',
        fieldId: f.numberId,
        to: { type: 'formula', options: { expression: '{B}' } },
        dateOrder: 'mdy',
        timeZone: 'UTC',
      },
      'formula.field.circular',
    );
  });

  it('returns cell errors, preserves lazy branches, and excludes formulas from changes', async () => {
    const f = await setup();
    const error = await f.add('1 / {Amount}', 'Ratio');
    const fallback = await f.add('REGEX_EXTRACT({Name}, "[0-9]+")', 'Digits');
    const caught = await f.add('IF(ISERROR({Ratio}), 42, {Ratio})', 'Caught');
    const lazy = await f.add('IF(TRUE(), 3, {Ratio})', 'Lazy');
    expect(await f.row(f.ids[5])).toMatchObject({
      values: { [error]: null, [fallback]: null, [caught]: 42, [lazy]: 3 },
      errors: { [error]: 'formula.runtime.divisionByZero' },
    });
    const id = newId('record');
    const created = await send(f.databaseId, {
      kind: 'record.create',
      tableId: f.tableId,
      records: [{ id, values: { [f.numberId]: 2 } }],
    });
    expect(JSON.stringify(created.result)).not.toContain(`"${error}":`);
    const changes = await query<{ body: { records?: RowData[] } }>(
      server.pool,
      sql`
      SELECT body FROM ${ident(server.schemas.app, 'changes')} WHERE database_id = ${f.databaseId} AND kind LIKE 'record.%'`,
    );
    for (const { body } of changes.rows)
      for (const record of body.records ?? []) expect(record.values).not.toHaveProperty(error);
  });

  it('filters and sorts compiled formulas and refuses either operation for fallback formulas', async () => {
    const f = await setup();
    const id = await f.add('{Amount} * 2');
    const fallback = await f.add('ROUNDUP({Amount}, 1)', 'Rounded');
    const config = (await f.schema()).views[0]!.config;
    await send(f.databaseId, {
      kind: 'view.update',
      viewId: f.viewId,
      config: {
        ...config,
        sorts: [{ fieldId: id, direction: 'desc' }],
        filter: {
          conjunction: 'and',
          conditions: [{ id: 'positive', fieldId: id, operator: 'gt', value: 0 }],
        },
      },
    });
    expect((await f.page()).rows.map((row) => row?.values[id])).toEqual([12, 10, 8, 4, 2]);
    await send(
      f.databaseId,
      {
        kind: 'view.update',
        viewId: f.viewId,
        config: { ...config, sorts: [{ fieldId: fallback, direction: 'asc' }] },
      },
      'data.formula.notSortable',
    );
    await send(
      f.databaseId,
      {
        kind: 'view.update',
        viewId: f.viewId,
        config: {
          ...config,
          filter: {
            conjunction: 'or',
            conditions: [
              {
                conjunction: 'and',
                conditions: [{ id: 'rounded', fieldId: fallback, operator: 'eq', value: 0 }],
              },
            ],
          },
        },
      },
      'data.formula.notSortable',
    );
    expect((await f.schema()).fields.find((field) => field.id === fallback)?.options).toMatchObject({
      sortable: false,
    });
  });

  it('converts both ways, preserves backups for undo, and undoes formula edits', async () => {
    const f = await setup();
    const converted = await send(f.databaseId, {
      kind: 'field.convert',
      fieldId: f.numberId,
      to: { type: 'formula', options: { expression: 'LEN({Name})' } },
      dateOrder: 'mdy',
      timeZone: 'UTC',
    });
    expect((await f.row(f.ids[2])).values[f.numberId]).toBe(9);
    await f.undo(converted.groupId);
    expect((await f.row(f.ids[2])).values[f.numberId]).toBe(-3);
    await f.undo(converted.groupId, 'redo');
    const edited = await send(f.databaseId, {
      kind: 'field.update',
      fieldId: f.numberId,
      options: { expression: 'LEN({Name}) + 10' },
    });
    expect((await f.row(f.ids[2])).values[f.numberId]).toBe(19);
    await f.undo(edited.groupId);
    expect((await f.row(f.ids[2])).values[f.numberId]).toBe(9);
    for (const expression of ['LEN({Name})', 'LEN(UPPER({Name}))']) {
      const id = await f.add(expression, newId('field'));
      const conversion = await send(f.databaseId, {
        kind: 'field.convert',
        fieldId: id,
        to: { type: 'number' },
        dateOrder: 'mdy',
        timeZone: 'UTC',
      });
      expect((await f.row(f.ids[2])).values[id]).toBe(9);
      await send(f.databaseId, {
        kind: 'record.update',
        tableId: f.tableId,
        records: [{ id: f.ids[2], values: { [f.textId]: 'Changed!!' } }],
      });
      expect((await f.row(f.ids[2])).values[id]).toBe(9);
      await f.undo(conversion.groupId);
    }
  });

  it('reads link and lookup arrays and numeric rollups and counts through the shared SQL paths', async () => {
    const f = await setup();
    const linkId = newId('field'),
      lookupId = newId('field'),
      countId = newId('field'),
      rollupId = newId('field');
    for (const field of [
      { id: linkId, name: 'Related', type: 'link', options: { linkedTableId: f.tableId } },
      {
        id: lookupId,
        name: 'Amounts',
        type: 'lookup',
        options: { linkFieldId: linkId, targetFieldId: f.numberId },
      },
      { id: countId, name: 'Count', type: 'count', options: { linkFieldId: linkId } },
      {
        id: rollupId,
        name: 'Total',
        type: 'rollup',
        options: { linkFieldId: linkId, targetFieldId: f.numberId, fn: 'sum' },
      },
    ])
      await send(f.databaseId, { kind: 'field.create', tableId: f.tableId, field });
    await send(f.databaseId, {
      kind: 'record.update',
      tableId: f.tableId,
      records: [{ id: f.ids[0], values: { [linkId]: [f.ids[1], f.ids[2]] } }],
    });
    const count = await f.add('{Count} + {Total}', 'Combined');
    const array = await f.add('ARRAYJOIN({Amounts}, "/")', 'Joined');
    const links = await f.add('COUNTALL({Related})', 'Link count');
    expect(await f.row(f.ids[0])).toMatchObject({ values: { [count]: -5, [array]: '-4/-3', [links]: 2 } });
    const schema = await f.schema();
    expect(schema.fields.find((field) => field.id === count)?.options).toMatchObject({
      sortable: true,
      resultType: 'number',
    });
    expect(schema.fields.find((field) => field.id === array)?.options).toMatchObject({
      sortable: true,
      resultType: 'text',
    });
    await send(f.databaseId, {
      kind: 'record.update',
      tableId: f.tableId,
      records: [{ id: f.ids[1], values: { [f.numberId]: 10 } }],
    });
    expect((await f.row(f.ids[0])).values[count]).toBe(9);
  });

  it('uses result types for date, text, and boolean filters and keeps error cells sortable', async () => {
    const f = await setup();
    const day = await f.add('{Day}', 'Computed day');
    const text = await f.add('TRIM({Name})', 'Computed name');
    const flag = await f.add('{Flag}', 'Computed flag');
    const ratio = await f.add('1 / {Amount}', 'Ratio');
    const config = (await f.schema()).views[0]!.config;
    for (const [fieldId, operator, value, expected] of [
      [day, 'is', { mode: 'exactDate', date: '2024-02-03' }, [f.ids[2]]],
      [text, 'contains', 'plain', [f.ids[3], f.ids[7], f.ids[11]]],
      [flag, 'is', true, f.ids.filter((_, index) => index % 2 === 0)],
    ] as const) {
      await send(f.databaseId, {
        kind: 'view.update',
        viewId: f.viewId,
        config: {
          ...config,
          filter: { conjunction: 'and', conditions: [{ id: 'condition', fieldId, operator, value }] },
        },
      });
      expect((await f.page()).rows.map((row) => row?.id)).toEqual(expected);
    }
    await send(f.databaseId, {
      kind: 'view.update',
      viewId: f.viewId,
      config: { ...config, filter: null, sorts: [{ fieldId: ratio, direction: 'asc' }] },
    });
    const rows = (await f.page()).rows;
    expect(rows.slice(-4).every((row) => row?.errors?.[ratio] === 'formula.runtime.divisionByZero')).toBe(
      true,
    );
  });

  it('invalidates snapshots and reports moves when a formula dependency changes', async () => {
    const f = await setup();
    const id = await f.add('{Amount} * 2');
    await send(f.databaseId, {
      kind: 'view.update',
      viewId: f.viewId,
      config: { sorts: [{ fieldId: id, direction: 'asc' }] },
    });
    const before = await f.page();
    const update = await send(f.databaseId, {
      kind: 'record.update',
      tableId: f.tableId,
      records: [{ id: f.ids[1], values: { [f.numberId]: 100 } }],
    });
    const result = await query<{ body: ChangeBody; seq: string }>(
      server.pool,
      sql`
      SELECT body, seq FROM ${ident(server.schemas.app, 'changes')}
      WHERE database_id = ${f.databaseId} AND kind = 'record.updated' ORDER BY seq DESC LIMIT 1`,
    );
    const change = {
      ...result.rows[0]!.body,
      databaseId: f.databaseId,
      seq: Number(result.rows[0]!.seq),
      commandId: newId('command'),
      groupId: update.groupId,
      clientId,
      actorId: server.owner.userId,
      at: new Date().toISOString(),
    } as Change;
    expect(
      await server.ctx.data?.viewDeltas(change, [{ viewId: f.viewId, snapshot: before.snapshot }]),
    ).toEqual([{ viewId: f.viewId, snapshot: before.snapshot, entered: [], left: [], moved: [f.ids[1]] }]);
    const after = await f.page();
    expect(after.snapshot).not.toBe(before.snapshot);
    expect(after.rows.at(-1)?.values[id]).toBe(200);
  });

  it('matches the evaluator in pages and records for 200 seeded generated formulas', async () => {
    const f = await setup();
    const fields = await loadFields(server.pool, server.schemas, [f.tableId]);
    const descriptors = fields.map((field) => ({
      id: field.id,
      name: field.name,
      type: field.type,
      options: { includeTime: false },
    }));
    const ctx = { now: new Date('2024-06-15T13:24:30Z'), timeZone: 'UTC' };
    const base = await fetchPageByRid(
      server.pool,
      server.schemas.data,
      f.tableId,
      fields,
      Array.from({ length: 12 }, (_, i) => i + 1),
    );
    let seed = 19351;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    let compiled = 0,
      fallback = 0;
    for (let i = 0; i < 200; i++) {
      const n = (random() % 37) + 1;
      const expressions = [
        `IF({Flag}, {Amount} * ${n}, {Amount} + ${i})`,
        `ABS({Amount} + ${i}) / (${n} + 1)`,
        `IF({Amount} > ${n}, ERROR(), {Amount} / ${i % 3})`,
        `CONCATENATE({Name}, " ${i} ", {Flag})`,
        `LEN(TRIM({Name})) + ${i}`,
        `ROUND({Amount} / ${n}, ${i % 4})`,
        `UPPER(CONCATENATE({Name}, "${i}"))`,
        `REGEX_MATCH({Name}, "[a-z]{${n}}")`,
        `DATEADD({Day}, ${i}, "days")`,
        `IF({Flag}, YEAR({Day}) + ${i}, ${n})`,
        `DATETIME_FORMAT(DATEADD({Day}, ${i}, "days"), "YYYY-MM-DD")`,
        `IF({Flag}, {Amount} > ${i}, LEN({Name}) > ${n})`,
        `ROUNDDOWN({Amount} / ${n}, ${i % 4})`,
      ];
      const expression = expressions[i % expressions.length]!;
      const id = newId('field');
      const spec = formulaSpec(FieldSpec.parse({ type: 'formula', options: { expression } }), id, fields);
      const field: StoredField = { ...fields[0]!, ...spec, id, name: `Formula ${i}`, columnName: id };
      field.formula = prepareFormula(field, fields);
      if (formulaExpression(field, undefined, ctx)) compiled++;
      else fallback++;
      const parsed = parse(expression);
      if (!('ast' in parsed)) throw new Error('Expected parsed formula');
      const resolved = resolve(parsed.ast, descriptors);
      if (!('ast' in resolved)) throw new Error('Expected resolved formula');
      const rows = await fetchPageByRid(
        server.pool,
        server.schemas.data,
        f.tableId,
        [field],
        Array.from({ length: 12 }, (_, i) => i + 1),
        sql`TRUE`,
        ctx,
      );
      for (let r = 0; r < base.length; r++) {
        const expected = evaluate(resolved.ast, base[r]!, ctx);
        expect(rows[r]?.values[id], `${i}: ${expression}, row ${r}`).toEqual(
          isError(expected) ? null : expected,
        );
        expect(rows[r]?.errors?.[id], expression).toBe(isError(expected) ? expected.messageKey : undefined);
        expect(Object.keys(rows[r]!.values)).toEqual([id]);
      }
      expect(await fetchRecord(server.pool, server.schemas.data, f.tableId, [field], f.ids[1]!, ctx)).toEqual(
        rows[1],
      );
    }
    expect(compiled).toBeGreaterThan(100);
    expect(fallback).toBeGreaterThan(40);
  }, 60_000);
});

describe('database named functions', () => {
  it.each(['editor', 'creator'] as const)(
    'protects transitive record-rule callers from mutations by a restricted %s',
    async (role) => {
      const f = await setup();
      const person = await server.addMember({ kind: 'guest' });
      await query(
        server.pool,
        sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
          (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
          VALUES (${server.owner.info.org.id}, 'database', ${f.databaseId}, 'user', ${person.userId}, ${role})`,
      );
      const functionId = newId('namedFunction');
      const definition = { name: 'POSITIVE', parameters: ['amount'], body: 'amount > 0' };
      await send(f.databaseId, { kind: 'namedFunction.create', functionId, definition });
      await send(f.databaseId, {
        kind: 'namedFunction.create',
        functionId: newId('namedFunction'),
        definition: { name: 'ALLOWED', parameters: ['amount'], body: 'positive(amount)' },
      });
      const caller = await f.add('allowed({Amount})', 'Allowed');
      const dependent = await f.add(`{${caller}}`, 'Rule value');
      const rules = await server.app.inject({
        method: 'PUT',
        url: `/api/tables/${f.tableId}/record-rules`,
        headers: server.owner.headers,
        payload: {
          rules: [
            {
              id: newId('recordRule'),
              roles: [role],
              users: [],
              condition: {
                conjunction: 'and',
                conditions: [{ id: 'allowed', fieldId: dependent, operator: 'is', value: true }],
              },
            },
          ],
        },
      });
      expect(rules.statusCode, rules.body).toBe(200);
      const privateRecord = () =>
        server.app.inject({
          url: `/api/tables/${f.tableId}/records/${f.ids[1]}`,
          headers: person.headers,
        });
      expect((await privateRecord()).statusCode).toBe(404);
      for (const input of [
        {
          kind: 'namedFunction.update',
          functionId,
          revision: 1,
          definition: { ...definition, body: 'TRUE()' },
        },
        {
          kind: 'namedFunction.update',
          functionId,
          revision: 1,
          definition: { ...definition, name: 'RENAMED' },
        },
        { kind: 'namedFunction.delete', functionId, revision: 1, confirmUsed: true },
      ]) {
        const response = await server.app.inject({
          method: 'POST',
          url: `/api/databases/${f.databaseId}/commands`,
          headers: person.headers,
          payload: { clientId, commands: [{ id: newId('command'), groupId: newId('action'), ...input }] },
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json<CommandBatchResult>().results[0], response.body).toMatchObject({
          status: 'rejected',
          error: { code: 'forbidden' },
        });
        expect((await privateRecord()).statusCode).toBe(404);
      }
      expect((await f.schema()).namedFunctions?.find((item) => item.id === functionId)).toMatchObject({
        body: definition.body,
        revision: 1,
      });
      const unrelated = await server.app.inject({
        method: 'POST',
        url: `/api/databases/${f.databaseId}/commands`,
        headers: person.headers,
        payload: {
          clientId,
          commands: [
            {
              id: newId('command'),
              groupId: newId('action'),
              kind: 'namedFunction.create',
              functionId: newId('namedFunction'),
              definition: { name: 'UNRELATED', parameters: [], body: '7' },
            },
          ],
        },
      });
      expect(unrelated.json<CommandBatchResult>().results[0]?.status, unrelated.body).toBe('applied');
      await send(f.databaseId, {
        kind: 'namedFunction.update',
        functionId,
        revision: 1,
        definition: { ...definition, body: 'amount > 1' },
      });
    },
  );

  it('rechecks current record rules before undoing a named function', async () => {
    const f = await setup();
    const person = await server.addMember({ kind: 'guest' });
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
      (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
      VALUES (${server.owner.info.org.id}, 'database', ${f.databaseId}, 'user', ${person.userId}, 'creator')`,
    );
    const functionId = newId('namedFunction');
    const groupId = newId('action');
    const created = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${f.databaseId}/commands`,
      headers: person.headers,
      payload: {
        clientId,
        commands: [
          {
            id: newId('command'),
            groupId,
            kind: 'namedFunction.create',
            functionId,
            definition: { name: 'POSITIVE', parameters: ['amount'], body: 'amount > 0' },
          },
        ],
      },
    });
    expect(created.json<CommandBatchResult>().results[0]?.status, created.body).toBe('applied');
    const caller = await f.add('POSITIVE({Amount})');
    const rule = await server.app.inject({
      method: 'PUT',
      url: `/api/tables/${f.tableId}/record-rules`,
      headers: server.owner.headers,
      payload: {
        rules: [
          {
            id: newId('recordRule'),
            roles: ['creator'],
            users: [],
            condition: {
              conjunction: 'and',
              conditions: [{ id: 'allowed', fieldId: caller, operator: 'is', value: true }],
            },
          },
        ],
      },
    });
    expect(rule.statusCode, rule.body).toBe(200);
    const undone = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${f.databaseId}/undo`,
      headers: person.headers,
      payload: { commandId: newId('command'), clientId, groupId },
    });
    expect(undone.statusCode, undone.body).toBe(200);
    expect(undone.json(), undone.body).toMatchObject({ status: 'nothing', skipped: 1 });
    expect((await f.schema()).namedFunctions).toMatchObject([{ id: functionId, revision: 1 }]);
  });

  it('retains calls, recomputes dependents, warns before deleting, and restores through undo', async () => {
    const f = await setup();
    const functionId = newId('namedFunction');
    const definition = {
      name: 'DOUBLE_AMOUNT',
      parameters: ['amount'],
      body: 'amount * 2',
      description: 'Double an amount',
    };
    const created = await send(f.databaseId, { kind: 'namedFunction.create', functionId, definition });
    expect((await f.schema()).namedFunctions).toMatchObject([
      { id: functionId, revision: 1, createdBy: server.owner.userId, updatedBy: server.owner.userId },
    ]);
    const id = await f.add('double_amount({Amount})');
    const dependent = await f.add(`{${id}} + 1`, 'Dependent');
    expect((await f.schema()).fields.find((field) => field.id === id)?.options).toMatchObject({
      expression: `DOUBLE_AMOUNT({${f.numberId}})`,
    });
    expect((await f.row()).values).toMatchObject({ [id]: -8, [dependent]: -7 });
    const edited = await send(f.databaseId, {
      kind: 'namedFunction.update',
      functionId,
      revision: 1,
      definition: { ...definition, body: 'amount * 3' },
    });
    expect((await f.row()).values).toMatchObject({ [id]: -12, [dependent]: -11 });
    expect((await f.page()).rows[1]?.values[id]).toBe(-12);
    await send(
      f.databaseId,
      { kind: 'namedFunction.update', functionId, revision: 1, definition },
      'errors.conflict',
    );
    await f.undo(edited.groupId);
    expect((await f.row()).values[id]).toBe(-8);
    await f.undo(edited.groupId, 'redo');
    expect((await f.row()).values[id]).toBe(-12);
    const revision = (await f.schema()).namedFunctions![0]!.revision;
    const warning = await send(
      f.databaseId,
      { kind: 'namedFunction.delete', functionId, revision },
      'formula.named.used',
    );
    expect(warning.result.error?.params).toMatchObject({
      name: 'DOUBLE_AMOUNT',
      callers: 'Records: Computed',
    });
    const deleted = await send(f.databaseId, {
      kind: 'namedFunction.delete',
      functionId,
      revision,
      confirmUsed: true,
    });
    expect(await f.row()).toMatchObject({
      values: { [id]: null, [dependent]: null },
      errors: { [id]: 'formula.function.unknown', [dependent]: 'formula.function.unknown' },
    });
    await f.undo(deleted.groupId);
    expect((await f.row()).values[id]).toBe(-12);
    const changes = await query<{ body: ChangeBody }>(
      server.pool,
      sql`SELECT body FROM ${ident(server.schemas.app, 'changes')} WHERE database_id = ${f.databaseId} AND kind = 'namedFunction.changed'`,
    );
    expect(
      changes.rows.some(({ body }) => body.kind === 'namedFunction.changed' && body.definition === null),
    ).toBe(true);
    const audit = await query(
      server.pool,
      sql`SELECT 1 FROM ${ident(server.schemas.audit, 'events')} WHERE action = 'data.namedFunction.changed' AND metadata ->> 'functionId' = ${functionId}`,
    );
    expect(audit.rowCount).toBeGreaterThanOrEqual(6);
    await f.undo(created.groupId);
    expect((await f.schema()).namedFunctions).toEqual([]);
  });

  it('validates the entire registry, keeps database isolation, and rechecks changed signatures', async () => {
    const f = await setup();
    const functionId = newId('namedFunction');
    const definition = { name: 'TOTAL', parameters: ['amount'], body: 'amount * 2' };
    await send(f.databaseId, { kind: 'namedFunction.create', functionId, definition });
    await send(
      f.databaseId,
      {
        kind: 'namedFunction.create',
        functionId: newId('namedFunction'),
        definition: { ...definition, name: 'total' },
      },
      'formula.named.invalid',
    );
    await send(
      f.databaseId,
      {
        kind: 'namedFunction.update',
        functionId,
        revision: 1,
        definition: { ...definition, body: 'TOTAL(amount)' },
      },
      'formula.named.circular',
    );
    await send(
      f.databaseId,
      {
        kind: 'namedFunction.update',
        functionId,
        revision: 1,
        definition: { ...definition, body: '{Unlisted}' },
      },
      'formula.named.parameter',
    );
    const id = await f.add('TOTAL({Amount})');
    await send(f.databaseId, {
      kind: 'namedFunction.update',
      functionId,
      revision: 1,
      definition: { ...definition, parameters: ['amount', 'extra'] },
    });
    expect((await f.row()).errors?.[id]).toBe('formula.function.arity');
    const other = await setup();
    await send(
      other.databaseId,
      {
        kind: 'field.create',
        tableId: other.tableId,
        field: {
          id: newId('field'),
          name: 'Unknown',
          type: 'formula',
          options: { expression: 'TOTAL({Amount})' },
        },
      },
      'formula.function.unknown',
    );
    await send(other.databaseId, {
      kind: 'namedFunction.create',
      functionId: newId('namedFunction'),
      definition,
    });
    await send(
      other.databaseId,
      { kind: 'namedFunction.update', functionId, revision: 2, definition },
      'errors.notFound',
    );
    await send(f.databaseId, {
      kind: 'namedFunction.update',
      functionId,
      revision: 2,
      definition: { ...definition, name: 'RENAMED' },
    });
    expect((await f.row()).errors?.[id]).toBe('formula.function.unknown');
  });

  it('asks before breaking restricted callers without exposing their names', async () => {
    const f = await setup();
    const functionId = newId('namedFunction');
    await send(f.databaseId, {
      kind: 'namedFunction.create',
      functionId,
      definition: { name: 'DOUBLE_AMOUNT', parameters: ['amount'], body: 'amount * 2' },
    });
    const id = await f.add('DOUBLE_AMOUNT({Amount})', 'Private caller');
    const visibility = vi.spyOn(AccessScope.prototype, 'visibleFields').mockImplementation(function <
      F extends { id: string },
    >(_tableId: string, fields: readonly F[]): F[] {
      return fields.filter((field) => field.id !== id);
    });
    try {
      const warning = await send(
        f.databaseId,
        { kind: 'namedFunction.delete', functionId, revision: 1 },
        'formula.named.usedRestricted',
      );
      expect(warning.result.error?.params).toMatchObject({ restricted: 1, callers: '' });
      expect(JSON.stringify(warning.result)).not.toContain('Private caller');
    } finally {
      visibility.mockRestore();
    }
  });

  it('requires database read access and schema editing access for mutations', async () => {
    const f = await setup();
    const person = await server.addMember({ kind: 'guest' });
    const request = async (method: 'GET' | 'POST', payload?: object) =>
      server.app.inject({
        method,
        url: `/api/databases/${f.databaseId}/${method === 'GET' ? 'schema' : 'commands'}`,
        headers: person.headers,
        payload,
      });
    expect((await request('GET')).statusCode).toBe(404);
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'grants')} (org_id, resource_kind, resource_id, principal_kind, principal_id, role) VALUES (${server.owner.info.org.id}, 'database', ${f.databaseId}, 'user', ${person.userId}, 'reader')`,
    );
    expect((await request('GET')).statusCode).toBe(200);
    const input = {
      clientId,
      commands: [
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'namedFunction.create',
          functionId: newId('namedFunction'),
          definition: { name: 'FIXED_VALUE', parameters: [], body: '2' },
        },
      ],
    };
    expect((await request('POST', input)).json<CommandBatchResult>().results[0]?.error?.messageKey).toBe(
      'data.access.denied',
    );
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'grants')} SET role = 'editor' WHERE resource_id = ${f.databaseId} AND principal_id = ${person.userId}`,
    );
    input.commands[0]!.id = newId('command');
    const accepted = await request('POST', input);
    expect(accepted.json<CommandBatchResult>().results[0]?.status, accepted.body).toBe('applied');
  });
});
