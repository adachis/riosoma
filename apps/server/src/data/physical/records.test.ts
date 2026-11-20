import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cellValue, FIELD_TYPES, FieldSpec, newId, type CellValue } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type { StoredField } from '../types.js';
import { addFieldColumn, createRecordTable, dropColumn, dropRecordTable } from './ddl.js';
import {
  clearChoices,
  currentValues,
  fetchRecord,
  fetchRowsById,
  fetchRowsByRid,
  insertRecords,
  restoreRecords,
  trashRecords,
  updateRecords,
} from './records.js';

let kit: TestPostgres;
let database: Awaited<ReturnType<TestPostgres['createDatabase']>>;
let db: pg.Client;
const schema = 'records_data';
const actor = newId('user');
const choice = { id: newId('choice'), name: 'First', color: 'blue' } as const;
const secondChoice = { id: newId('choice'), name: 'Second', color: 'red' } as const;

beforeAll(async () => {
  kit = await startTestPostgres();
  database = await kit.createDatabase('records');
  db = new pg.Client({ connectionString: database.url });
  await db.connect();
  await query(db, sql`CREATE SCHEMA ${ident(schema)}`);
}, 60_000);
afterAll(async () => {
  await db?.end();
  await database?.drop();
  await kit?.stop();
});
beforeEach(async () => {
  await query(db, sql`BEGIN`);
});
afterEach(async () => {
  await query(db, sql`ROLLBACK`);
});

function field(tableId: string, input: unknown): StoredField {
  const id = newId('field');
  return {
    id,
    columnName: `${id}_stored`,
    tableId,
    name: 'Field',
    description: '',
    position: 0,
    createdAt: '',
    updatedAt: '',
    ...FieldSpec.parse(input),
  };
}

async function table(specs: unknown[]) {
  const id = newId('table');
  const fields = specs.map((spec) => field(id, spec));
  await createRecordTable(db, schema, id, fields);
  return { id, fields };
}

describe('record storage', () => {
  it.each([false, true])('round-trips every type with alternate session settings: %s', async (alternate) => {
    if (alternate) {
      await query(db, sql`SET LOCAL TIME ZONE 'Pacific/Kiritimati'`);
      await query(db, sql`SET LOCAL DateStyle = 'SQL, DMY'`);
    }
    const { id, fields } = await table([
      ...FIELD_TYPES.map((type) => ({
        type,
        options: type.includes('Select')
          ? { choices: [choice] }
          : type === 'link'
            ? { linkedTableId: newId('table') }
            : type === 'count'
              ? { linkFieldId: newId('field') }
              : type === 'lookup' || type === 'rollup'
                ? { linkFieldId: newId('field'), targetFieldId: newId('field') }
                : {},
      })),
      { type: 'date', options: { includeTime: true } },
      { type: 'dateRange', options: { includeTime: true } },
    ]);
    const samples: Record<string, CellValue> = {
      text: "O'Brien; DROP TABLE records; $1",
      longText: 'First\nSecond',
      number: 1234.125,
      currency: 1234.56,
      percent: 0.25,
      duration: 3723.125,
      rating: 4,
      user: [actor],
      checkbox: true,
      date: '2024-02-29',
      singleSelect: choice.id,
      multipleSelect: [choice.id],
      attachment: [newId('attachment'), newId('attachment')],
      email: 'person@example.test',
      url: 'https://example.test/$1?a=1',
      phone: '+1 555 0100',
      barcode: '0012345678905',
      time: '23:12:13',
      multiCurrency: { amount: 1234.56, code: 'EUR' },
      dateRange: { start: '2024-02-28', end: '2024-03-01' },
      // Key order, number spelling, and repeated keys survive as written.
      json: '{"z":1,"a":[1.50,{"b":null}],"z":2}',
      location: { lat: 40.7128, lng: -74.006, label: 'New York' },
      signature: {
        drawing: { path: 'M10 20l3 -2 4 1 M50 60l0 0', width: 400, height: 150 },
        name: 'Ada Lovelace',
        signedBy: actor,
        signedAt: '2024-02-29T23:12:13.456Z',
      },
    };
    const values = Object.fromEntries(
      fields
        .filter((f) => f.type in samples)
        .map((f) => [
          f.id,
          f.type === 'date' && f.options.includeTime
            ? '2024-02-29T23:12:13.456Z'
            : f.type === 'dateRange' && f.options.includeTime
              ? { start: '2024-02-29T23:12:13.456Z', end: '2024-03-01T00:00:00.000Z' }
              : samples[f.type]!,
        ]),
    );
    const recordId = newId('record');
    const [created] = await insertRecords(db, schema, id, fields, [{ id: recordId, values }], actor);
    const computed = Object.fromEntries(
      fields.flatMap<[string, CellValue]>((f) => {
        if (f.type === 'link' || f.type === 'lineItems' || f.type === 'lookup') return [[f.id, []]];
        if (f.type === 'count') return [[f.id, 0]];
        if (f.type === 'autoNumber') return [[f.id, 1]];
        if (f.type === 'rollup') return [[f.id, null]];
        if (f.type === 'changeLog') return [[f.id, null]];
        return [];
      }),
    );
    expect(created!.values).toEqual({ ...values, ...computed });
    expect(created!.createdBy).toBe(actor);
    expect(created!.updatedBy).toBe(actor);
    expect(created!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(await fetchRecord(db, schema, id, fields, recordId)).toEqual(created);
    for (const f of fields) {
      if (f.type === 'createdTime') expect(cellValue(created!, f)).toBe(created!.createdAt);
      if (f.type === 'lastModifiedTime') expect(cellValue(created!, f)).toBe(created!.updatedAt);
      if (f.type === 'createdBy' || f.type === 'lastModifiedBy') expect(cellValue(created!, f)).toBe(actor);
      if (f.type === 'recordId') expect(cellValue(created!, f)).toBe(recordId);
    }
    const [empty] = await insertRecords(db, schema, id, fields, [{ id: newId('record'), values: {} }], null);
    expect(empty!.values[fields.find((f) => f.type === 'autoNumber')!.id]).toBe(2);
    for (const f of fields.filter((f) => f.type in samples)) {
      expect(empty!.values[f.id]).toBe(f.type === 'checkbox' ? false : null);
    }
  });

  it.each([60, 500])(
    'inserts 1,000 records with %i fields in input order',
    async (count) => {
      const { id, fields } = await table(Array.from({ length: count }, () => ({ type: 'number' })));
      const rows = Array.from({ length: 1_000 }, (_, i) => ({
        id: newId('record'),
        values: Object.fromEntries(fields.map((f, j) => [f.id, i * count + j])),
      }));
      const inserted = await insertRecords(db, schema, id, fields, rows, actor);
      expect(inserted.map(({ id, values }) => ({ id, values }))).toEqual(rows);
      const requested = [rows[998]!.id, rows[4]!.id, 'unknown', rows[10]!.id, rows[4]!.id];
      const fetched = await fetchRowsById(db, schema, id, fields, requested);
      expect(fetched.map((r) => r.id)).toEqual(requested.filter((id) => id !== 'unknown'));
      expect(await fetchRowsByRid(db, schema, id, fields, [999, 5, 1001, 11])).toEqual([
        inserted[998],
        inserted[4],
        inserted[10],
      ]);
    },
    30_000,
  );

  it('writes only changed cells, preserves unchanged timestamps, and reports missing records', async () => {
    const { id, fields } = await table([
      { type: 'text' },
      { type: 'checkbox' },
      { type: 'multipleSelect', options: { choices: [choice] } },
    ]);
    const [text, checkbox, multiple] = fields;
    const ids = Array.from({ length: 3 }, () => newId('record'));
    const original = await insertRecords(
      db,
      schema,
      id,
      fields,
      ids.map((id) => ({ id, values: { [text!.id]: 'Before', [multiple!.id]: [choice.id] } })),
      actor,
    );
    await trashRecords(db, schema, id, [ids[2]!], actor);
    const nextActor = newId('user');
    const result = await updateRecords(
      db,
      schema,
      id,
      fields,
      [
        { id: ids[0]!, values: { [text!.id]: 'After', [checkbox!.id]: false, [multiple!.id]: [choice.id] } },
        { id: ids[1]!, values: { [text!.id]: 'Before', [checkbox!.id]: null } },
        { id: ids[2]!, values: { [text!.id]: 'Trashed' } },
        { id: 'unknown', values: {} },
      ],
      nextActor,
    );
    expect(result.missing).toEqual([ids[2], 'unknown']);
    expect(result.updated).toEqual([
      {
        id: ids[0],
        values: { [text!.id]: 'After' },
        prev: { [text!.id]: 'Before' },
        updatedAt: expect.any(String),
        updatedBy: nextActor,
      },
    ]);
    expect(await fetchRecord(db, schema, id, fields, ids[1]!)).toEqual(original[1]);
    expect((await fetchRecord(db, schema, id, fields, ids[0]!))!.updatedAt).not.toBe(original[0]!.updatedAt);
    expect(await currentValues(db, schema, id, fields, ids)).toEqual(
      new Map([
        [ids[0], { ...original[0]!.values, [text!.id]: 'After' }],
        [ids[1], original[1]!.values],
      ]),
    );
  });

  it('updates 1,000 records with five fields in a batch', async () => {
    const { id, fields } = await table(Array.from({ length: 500 }, () => ({ type: 'number' })));
    const rows = Array.from({ length: 1_000 }, () => ({ id: newId('record'), values: {} }));
    await insertRecords(db, schema, id, fields, rows, actor);
    const updates = rows.map((row, i) => ({
      id: row.id,
      values: Object.fromEntries(fields.slice(0, 5).map((f) => [f.id, i])),
    }));
    const start = performance.now();
    const result = await updateRecords(db, schema, id, fields, updates, actor);
    const elapsed = performance.now() - start;
    expect(result.updated.map(({ id, values }) => ({ id, values }))).toEqual(updates);
    expect(elapsed).toBeLessThan(300);
  });

  it('hides trashed rows and restores their data once', async () => {
    const { id, fields } = await table([{ type: 'text' }]);
    const recordId = newId('record');
    const [original] = await insertRecords(
      db,
      schema,
      id,
      fields,
      [{ id: recordId, values: { [fields[0]!.id]: 'Saved' } }],
      actor,
    );
    expect(await trashRecords(db, schema, id, [recordId, 'missing'], actor)).toEqual([recordId]);
    expect(await trashRecords(db, schema, id, [recordId], actor)).toEqual([]);
    expect(await fetchRecord(db, schema, id, fields, recordId)).toBeNull();
    expect(await fetchRowsById(db, schema, id, fields, [recordId])).toEqual([]);
    expect(await fetchRowsByRid(db, schema, id, fields, [1])).toEqual([]);
    const restored = await restoreRecords(db, schema, id, fields, [recordId, 'missing']);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      id: recordId,
      values: original!.values,
      createdAt: original!.createdAt,
    });
    expect(await fetchRecord(db, schema, id, fields, recordId)).toEqual(restored[0]);
    expect(await restoreRecords(db, schema, id, fields, [recordId])).toEqual([]);
  });

  it.each(['singleSelect', 'multipleSelect'])(
    'clears removed choices from %s, including trash',
    async (type) => {
      const { id, fields } = await table([{ type, options: { choices: [choice, secondChoice] } }]);
      const f = fields[0]!;
      const values =
        type === 'singleSelect'
          ? [choice.id, secondChoice.id, null]
          : [[choice.id, secondChoice.id], [choice.id], null];
      const rows = values.map((value) => ({ id: newId('record'), values: { [f.id]: value } }));
      await insertRecords(db, schema, id, fields, rows, actor);
      await trashRecords(db, schema, id, [rows[0]!.id], actor);
      const cleared = await clearChoices(db, schema, id, f, [choice.id], actor);
      expect(cleared).toEqual(
        rows.slice(0, type === 'singleSelect' ? 1 : 2).map((r) => ({ id: r.id, prev: r.values[f.id] })),
      );
      await restoreRecords(db, schema, id, fields, [rows[0]!.id]);
      const fetched = await fetchRowsById(
        db,
        schema,
        id,
        fields,
        rows.map((r) => r.id),
      );
      expect(fetched.map((r) => r.values[f.id])).toEqual(
        type === 'singleSelect' ? [null, secondChoice.id, null] : [[secondChoice.id], null, null],
      );
      expect(await clearChoices(db, schema, id, f, [choice.id], actor)).toEqual([]);
      const raw = await query<{ value: unknown }>(
        db,
        sql`SELECT ${ident(f.columnName)} AS value
      FROM ${ident(schema, id)} WHERE __id = ${rows[type === 'singleSelect' ? 0 : 1]!.id}`,
      );
      expect(raw.rows[0]!.value).toBeNull();
    },
  );

  it('adds and drops physical columns and tables, rejecting unsafe identifiers', async () => {
    const { id } = await table([]);
    const existing = newId('record');
    await insertRecords(db, schema, id, [], [{ id: existing, values: {} }], null);
    const stored = field(id, { type: 'checkbox' });
    const computed = field(id, { type: 'createdTime' });
    await addFieldColumn(db, schema, id, stored);
    await addFieldColumn(db, schema, id, computed);
    expect((await fetchRecord(db, schema, id, [stored, computed], existing))!.values).toEqual({
      [stored.id]: false,
    });
    const [row] = await insertRecords(
      db,
      schema,
      id,
      [stored, computed],
      [{ id: newId('record'), values: {} }],
      null,
    );
    expect(row!.values).toEqual({ [stored.id]: false });
    await expect(dropColumn(db, schema, id, 'bad; DROP TABLE x')).rejects.toThrow('unsafe SQL identifier');
    await dropColumn(db, schema, id, stored.columnName);
    await dropRecordTable(db, schema, id);
    const exists = await query<{ exists: boolean }>(
      db,
      sql`SELECT EXISTS(SELECT FROM information_schema.tables
      WHERE table_schema = ${schema} AND table_name = ${id}) AS exists`,
    );
    expect(exists.rows[0]!.exists).toBe(false);
  });
});
