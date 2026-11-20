import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sort } from '@riosoma/contracts';
import { join, query, sql } from '@riosoma/db';
import type { StoredField } from '../types.js';
import { columnRef, columnType, typeSql } from './columns.js';
import { compileOrder } from './sorts.js';
import { choiceIds, ctx, field, fixture, schemas, userIds, type Fixture } from './order.test-helpers.js';

let kit: Fixture;
beforeAll(async () => {
  kit = await fixture();
}, 60_000);
afterAll(async () => {
  await kit?.close();
});

async function sorted(
  f: StoredField,
  values: unknown[],
  direction: Sort['direction'] = 'asc',
  natural = true,
) {
  const type = columnType(f) ?? (f.type.endsWith('Time') ? 'timestamptz' : 'text');
  const rows = values.map((value, i) => sql`(${i + 1}::integer, ${value}::${typeSql(type)})`);
  const result = await query<{ __rid: number }>(
    kit.pool,
    sql`
    SELECT __rid FROM (VALUES ${join(rows, ', ')}) cells(__rid, ${columnRef(f)})
    ORDER BY ${compileOrder([{ fieldId: f.id, direction }], new Map([[f.id, f]]), { ...ctx, natural }, schemas.data, schemas.app)}`,
  );
  return result.rows.map((r) => r.__rid);
}

describe('sort expressions', () => {
  it.each(['text', 'longText', 'email', 'url', 'phone', 'recordId'] as const)(
    '%s uses natural order and puts empties last',
    async (type) => {
      const f = field(type);
      const values = [null, 'Item 10', '', 'Item 2', 'Item 2', 'Item 1'];
      expect(await sorted(f, values)).toEqual([6, 4, 5, 2, 1, 3]);
      expect(await sorted(f, values, 'desc')).toEqual([2, 4, 5, 6, 1, 3]);
      expect(await sorted(f, values, 'asc', false)).toEqual([6, 2, 4, 5, 1, 3]);
    },
  );

  it.each(['singleSelect', 'multipleSelect'] as const)('%s uses choice positions', async (type) => {
    const [a, b, c] = choiceIds;
    const f = field(type, { choices: [c, a, b].map((id) => ({ id, name: id, color: 'gray' })) });
    const values = type === 'singleSelect' ? [null, b, a, c, ''] : [null, [b, c], [a, c], [c, a], []];
    expect(await sorted(f, values)).toEqual([4, 3, 2, 1, 5]);
    expect(await sorted(f, values, 'desc')).toEqual([2, 3, 4, 1, 5]);
  });

  it.each(['createdBy', 'lastModifiedBy'] as const)(
    '%s uses names in the specified app schema',
    async (type) => {
      const f = field(type);
      const [zoe, amy, empty] = userIds;
      expect(await sorted(f, [null, zoe, amy, empty, 'usr99999999999999'])).toEqual([3, 2, 1, 4, 5]);
      expect(await sorted(f, [null, zoe, amy, empty], 'desc')).toEqual([2, 3, 1, 4]);
    },
  );

  it('puts unchecked checkboxes first, treating null as unchecked', async () => {
    expect(await sorted(field('checkbox'), [null, true, false, true])).toEqual([1, 3, 2, 4]);
    expect(await sorted(field('checkbox'), [null, true, false, true], 'desc')).toEqual([2, 4, 1, 3]);
  });

  it.each(['number', 'date', 'createdTime', 'lastModifiedTime'] as const)(
    '%s sorts natively in both directions',
    async (type) => {
      const values = type === 'number' ? [null, 10, -1, 2] : [null, '2024-02-01', '2023-02-01', '2024-01-01'];
      expect(await sorted(field(type), values)).toEqual([3, 4, 2, 1]);
      expect(await sorted(field(type), values, 'desc')).toEqual([2, 4, 3, 1]);
    },
  );

  it('sorts timed dates by instant', async () => {
    expect(
      await sorted(field('date', { includeTime: true }), [
        null,
        '2024-01-01T01:00:00Z',
        '2024-01-01T03:00:00+03:00',
      ]),
    ).toEqual([3, 2, 1]);
  });

  it('applies multiple levels, ignores unknown fields, and breaks all ties by rid', async () => {
    const text = field('text');
    const number = field('number');
    const fields = new Map([text, number].map((f) => [f.id, f]));
    const sorts: Sort[] = [
      { fieldId: 'missing', direction: 'asc' },
      { fieldId: text.id, direction: 'asc' },
      { fieldId: number.id, direction: 'desc' },
    ];
    const result = await query<{ __rid: number }>(
      kit.pool,
      sql`SELECT __rid FROM
      (VALUES (4, 'A', 2), (2, 'A', 2), (1, 'B', 5), (3, 'A', 1)) cells(__rid, ${columnRef(text)}, ${columnRef(number)})
      ORDER BY ${compileOrder(sorts, fields, ctx, schemas.data, schemas.app)}`,
    );
    expect(result.rows.map((r) => r.__rid)).toEqual([2, 4, 3, 1]);
    const empty = await query<{ __rid: number }>(
      kit.pool,
      sql`SELECT __rid FROM (VALUES (4), (1), (3), (2)) cells(__rid)
      ORDER BY ${compileOrder([], fields, ctx, schemas.data, schemas.app)}`,
    );
    expect(empty.rows.map((r) => r.__rid)).toEqual([1, 2, 3, 4]);
  });
});
