import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DateRange, DateTarget, FilterGroup, Operator } from '@riosoma/contracts';
import { join, query, sql } from '@riosoma/db';
import type { ReadContext, StoredField } from '../types.js';
import { columnRef, columnType, typeSql } from './columns.js';
import { compileFilter, filterUsesViewerTime } from './filters.js';
import {
  choiceIds,
  condition,
  ctx,
  field,
  fixture,
  group,
  userIds,
  type Fixture,
} from './order.test-helpers.js';

let kit: Fixture;
beforeAll(async () => {
  kit = await fixture();
}, 60_000);
afterAll(async () => {
  await kit?.close();
});

async function matches(f: StoredField, values: unknown[], filter: FilterGroup | null, context = ctx) {
  const type = columnType(f) ?? (f.type.endsWith('Time') ? 'timestamptz' : 'text');
  const rows = values.map((value, i) => sql`(${i}::integer, ${value}::${typeSql(type)})`);
  const result = await query<{ n: number }>(
    kit.pool,
    sql`
    SELECT n FROM (VALUES ${join(rows, ', ')}) cells(n, ${columnRef(f)})
    WHERE ${compileFilter(filter, new Map([[f.id, f]]), context)} ORDER BY n`,
  );
  return result.rows.map((r) => r.n);
}

async function check(f: StoredField, values: unknown[], cases: [Operator, unknown, number[]][]) {
  for (const [operator, value, expected] of cases) {
    expect(await matches(f, values, group(condition(f, operator, value))), operator).toEqual(expected);
  }
}

describe('filter operators', () => {
  it.each(['text', 'longText', 'email', 'url', 'phone', 'recordId'] as const)(
    '%s treats text literally and ignores case',
    async (type) => {
      const f = field(type);
      await check(
        f,
        [null, '', 'ALPHA', 'alphabet', '%_\\', 'anything', "' OR TRUE --"],
        [
          ['contains', 'aLp', [2, 3]],
          ['doesNotContain', 'aLp', [0, 1, 4, 5, 6]],
          ['is', 'alpha', [2]],
          ['isNot', 'alpha', [0, 1, 3, 4, 5, 6]],
          ['isEmpty', undefined, [0, 1]],
          ['isNotEmpty', undefined, [2, 3, 4, 5, 6]],
          ['contains', '%', [4]],
          ['contains', '_', [4]],
          ['contains', '\\', [4]],
          ['contains', "' OR TRUE --", [6]],
        ],
      );
    },
  );

  it('compares numbers and includes null in neq', async () => {
    await check(
      field('number'),
      [null, -1, 0, 2, 3],
      [
        ['eq', 2, [3]],
        ['neq', 2, [0, 1, 2, 4]],
        ['lt', 2, [1, 2]],
        ['lte', 2, [1, 2, 3]],
        ['gt', 2, [4]],
        ['gte', 2, [3, 4]],
        ['isEmpty', undefined, [0]],
        ['isNotEmpty', undefined, [1, 2, 3, 4]],
      ],
    );
  });

  it('treats null checkboxes as unchecked', async () => {
    await check(
      field('checkbox'),
      [null, false, true],
      [
        ['is', true, [2]],
        ['is', false, [0, 1]],
      ],
    );
  });

  it.each(['singleSelect', 'createdBy', 'lastModifiedBy'] as const)('%s compares IDs', async (type) => {
    const [a, b, c] = type === 'singleSelect' ? choiceIds : userIds;
    await check(
      field(type),
      [null, '', a, b, c],
      [
        ['is', a, [2]],
        ['isNot', a, [0, 1, 3, 4]],
        ['isAnyOf', [a, b], [2, 3]],
        ['isNoneOf', [a, b], [0, 1, 4]],
        ['isEmpty', undefined, [0, 1]],
        ['isNotEmpty', undefined, [2, 3, 4]],
      ],
    );
  });

  it('compares multiple selects as sets', async () => {
    const [a, b, c] = choiceIds;
    await check(
      field('multipleSelect'),
      [null, [], [a], [a, b], [b, a], [a, b, c], [c]],
      [
        ['hasAnyOf', [b], [3, 4, 5]],
        ['hasAllOf', [a, b], [3, 4, 5]],
        ['isExactly', [b, a, a], [3, 4]],
        ['hasNoneOf', [b], [0, 1, 2, 6]],
        ['isEmpty', undefined, [0, 1]],
        ['isNotEmpty', undefined, [2, 3, 4, 5, 6]],
      ],
    );
  });

  it('skips unusable conditions and leaves out groups with nothing usable', async () => {
    const f = field('number');
    const values = [null, 1, 2, 3];
    const unusable = [
      condition(f, 'eq'),
      condition(f, 'eq', ''),
      condition(f, 'eq', Infinity),
      condition(f, 'contains', '2'),
      condition(field('number'), 'eq', 2),
    ];
    for (const conjunction of ['and', 'or'] as const) {
      expect(await matches(f, values, { conjunction, conditions: unusable })).toEqual([0, 1, 2, 3]);
      expect(
        await matches(f, values, { conjunction, conditions: [...unusable, condition(f, 'eq', 2)] }),
      ).toEqual([2]);
    }
    const nested = group(
      { conjunction: 'or', conditions: [condition(f, 'eq', 1), condition(f, 'eq', 3), ...unusable] },
      condition(f, 'gt', 1),
    );
    expect(await matches(f, values, nested)).toEqual([3]);
    expect(
      await matches(f, values, {
        conjunction: 'or',
        conditions: [group(...unusable), condition(f, 'eq', 2)],
      }),
    ).toEqual([2]);
    expect(await matches(f, values, { conjunction: 'or', conditions: [group(...unusable)] })).toEqual([
      0, 1, 2, 3,
    ]);
    expect(await matches(f, values, null)).toEqual([0, 1, 2, 3]);
  });
});

describe('calendar days', () => {
  it.each(['date', 'createdTime', 'lastModifiedTime'] as const)(
    '%s offers every date operator',
    async (type) => {
      const f = field(type, { timeZone: 'UTC' });
      await check(
        f,
        [null, '2024-01-30', '2024-01-31', '2024-02-01'],
        [
          ['is', { mode: 'exactDate', date: '2024-01-31' }, [2]],
          ['isNot', { mode: 'today' }, [0, 1, 3]],
          ['isBefore', { mode: 'today' }, [1]],
          ['isAfter', { mode: 'today' }, [3]],
          ['isOnOrBefore', { mode: 'today' }, [1, 2]],
          ['isOnOrAfter', { mode: 'today' }, [2, 3]],
          ['isWithin', { mode: 'pastWeek' }, [1, 2]],
          ['isEmpty', undefined, [0]],
          ['isNotEmpty', undefined, [1, 2, 3]],
        ],
      );
    },
  );

  it.each([false, true])(
    'resolves every relative target near midnight with includeTime=%s',
    async (includeTime) => {
      for (const timeZone of ['Pacific/Kiritimati', 'America/Adak']) {
        const today = timeZone === 'Pacific/Kiritimati' ? '2024-02-01' : '2024-01-31';
        const targets: [DateTarget, string][] = [
          [{ mode: 'today' }, today],
          [{ mode: 'tomorrow' }, timeZone === 'Pacific/Kiritimati' ? '2024-02-02' : '2024-02-01'],
          [{ mode: 'yesterday' }, timeZone === 'Pacific/Kiritimati' ? '2024-01-31' : '2024-01-30'],
          [{ mode: 'oneWeekAgo' }, timeZone === 'Pacific/Kiritimati' ? '2024-01-25' : '2024-01-24'],
          [{ mode: 'oneWeekFromNow' }, timeZone === 'Pacific/Kiritimati' ? '2024-02-08' : '2024-02-07'],
          [{ mode: 'oneMonthAgo' }, timeZone === 'Pacific/Kiritimati' ? '2024-01-01' : '2023-12-31'],
          [{ mode: 'oneMonthFromNow' }, timeZone === 'Pacific/Kiritimati' ? '2024-03-01' : '2024-02-29'],
          [{ mode: 'daysAgo', days: 2 }, timeZone === 'Pacific/Kiritimati' ? '2024-01-30' : '2024-01-29'],
          [{ mode: 'daysFromNow', days: 2 }, timeZone === 'Pacific/Kiritimati' ? '2024-02-03' : '2024-02-02'],
          [{ mode: 'daysAgo', days: 0 }, today],
          [{ mode: 'exactDate', date: '2024-02-29' }, '2024-02-29'],
        ];
        for (const fixed of [false, true]) {
          const f = field('date', { includeTime, timeZone: fixed ? timeZone : 'client' });
          const context = { ...ctx, timeZone: fixed ? 'UTC' : timeZone };
          for (const [target, expected] of targets) {
            const value = includeTime
              ? `${expected}T12:00:00${timeZone === 'Pacific/Kiritimati' ? '+14:00' : '-10:00'}`
              : expected;
            expect(
              await matches(f, [null, value], group(condition(f, 'is', target)), context),
              `${timeZone} ${target.mode}`,
            ).toEqual([1]);
          }
        }
      }
    },
  );

  it('uses inclusive range endpoints, clamping months and years', async () => {
    const f = field('date');
    const context = { ...ctx, now: new Date('2024-02-29T12:00:00Z') };
    const ranges: [DateRange, string, string][] = [
      [{ mode: 'pastWeek' }, '2024-02-22', '2024-02-29'],
      [{ mode: 'pastMonth' }, '2024-01-29', '2024-02-29'],
      [{ mode: 'pastYear' }, '2023-02-28', '2024-02-29'],
      [{ mode: 'nextWeek' }, '2024-02-29', '2024-03-07'],
      [{ mode: 'nextMonth' }, '2024-02-29', '2024-03-29'],
      [{ mode: 'nextYear' }, '2024-02-29', '2025-02-28'],
      [{ mode: 'pastDays', days: 3 }, '2024-02-26', '2024-02-29'],
      [{ mode: 'nextDays', days: 3 }, '2024-02-29', '2024-03-03'],
    ];
    for (const [range, start, end] of ranges) {
      const before = new Date(`${start}T00:00:00Z`);
      before.setUTCDate(before.getUTCDate() - 1);
      const after = new Date(`${end}T00:00:00Z`);
      after.setUTCDate(after.getUTCDate() + 1);
      expect(
        await matches(
          f,
          [null, before.toISOString().slice(0, 10), start, end, after.toISOString().slice(0, 10)],
          group(condition(f, 'isWithin', range)),
          context,
        ),
        range.mode,
      ).toEqual([2, 3]);
    }
    expect(
      await matches(f, ['2023-02-28', '2023-03-03'], group(condition(f, 'is', { mode: 'oneMonthFromNow' })), {
        ...ctx,
        now: new Date('2023-01-31T12:00:00Z'),
      }),
    ).toEqual([0]);
    expect(
      await matches(f, ['2024-02-29', '2024-03-02'], group(condition(f, 'is', { mode: 'oneMonthAgo' })), {
        ...ctx,
        now: new Date('2024-03-31T12:00:00Z'),
      }),
    ).toEqual([0]);
  });

  it('applies all ranges to local days in both zones, including timed and computed fields', async () => {
    const ranges: [DateRange, string, string][] = [
      [{ mode: 'pastWeek' }, '2024-02-22', '2024-02-29'],
      [{ mode: 'pastMonth' }, '2024-01-29', '2024-02-29'],
      [{ mode: 'pastYear' }, '2023-02-28', '2024-02-29'],
      [{ mode: 'nextWeek' }, '2024-02-29', '2024-03-07'],
      [{ mode: 'nextMonth' }, '2024-02-29', '2024-03-29'],
      [{ mode: 'nextYear' }, '2024-02-29', '2025-02-28'],
      [{ mode: 'pastDays', days: 3 }, '2024-02-26', '2024-02-29'],
      [{ mode: 'nextDays', days: 3 }, '2024-02-29', '2024-03-03'],
    ];
    for (const zone of ['Pacific/Kiritimati', 'America/Adak']) {
      const offset = zone === 'Pacific/Kiritimati' ? '+14:00' : '-10:00';
      const context = { ...ctx, timeZone: zone, now: new Date(`2024-02-29T00:30:00${offset}`) };
      for (const type of ['date', 'createdTime', 'lastModifiedTime'] as const) {
        for (const fixed of [false, true]) {
          const f = field(type, { includeTime: true, timeZone: fixed ? zone : 'client' });
          for (const [range, start, end] of ranges) {
            const before = new Date(`${start}T00:00:00Z`);
            before.setUTCDate(before.getUTCDate() - 1);
            const after = new Date(`${end}T00:00:00Z`);
            after.setUTCDate(after.getUTCDate() + 1);
            const days = [before.toISOString().slice(0, 10), start, end, after.toISOString().slice(0, 10)];
            expect(
              await matches(
                f,
                [null, ...days.map((day) => `${day}T12:00:00${offset}`)],
                group(condition(f, 'isWithin', range)),
                { ...context, timeZone: fixed ? 'UTC' : zone },
              ),
              `${type} ${zone} ${range.mode}`,
            ).toEqual([2, 3]);
          }
        }
      }
    }
  });

  it('keeps the entire local day across a daylight saving transition', async () => {
    const f = field('date', { includeTime: true, timeZone: 'America/Adak' });
    const context = { ...ctx, now: new Date('2024-03-10T10:30:00Z') };
    expect(
      await matches(
        f,
        [
          '2024-03-10T09:59:59.999Z',
          '2024-03-10T10:00:00Z',
          '2024-03-11T08:59:59.999Z',
          '2024-03-11T09:00:00Z',
        ],
        group(condition(f, 'is', { mode: 'today' })),
        context,
      ),
    ).toEqual([1, 2]);
  });

  it('ignores the session time zone for timestamps and computed times', async () => {
    const client = await kit.pool.connect();
    try {
      await query(client, sql`SELECT set_config('TimeZone', ${'Asia/Tokyo'}, false)`);
      for (const type of ['date', 'createdTime', 'lastModifiedTime'] as const) {
        const f = field(type, { includeTime: type === 'date', timeZone: 'client' });
        for (const timeZone of ['Pacific/Kiritimati', 'America/Adak']) {
          const context: ReadContext = { ...ctx, timeZone };
          const result = await query<{ matches: boolean }>(
            client,
            sql`SELECT ${compileFilter(group(condition(f, 'is', { mode: 'today' })), new Map([[f.id, f]]), context)} AS matches
            FROM (SELECT ${ctx.now.toISOString()}::timestamptz AS ${columnRef(f)}) cells`,
          );
          expect(result.rows[0]?.matches).toBe(true);
        }
      }
    } finally {
      await query(client, sql`RESET TIME ZONE`);
      client.release();
    }
  });

  it('reports usable time-dependent filters', () => {
    const viewer = field('date', { includeTime: true });
    const fixed = field('date', { timeZone: 'UTC' });
    const fields = new Map([viewer, fixed].map((f) => [f.id, f]));
    const uses = (f: StoredField, operator: Operator, value?: unknown) =>
      filterUsesViewerTime(group(group(condition(f, operator, value))), fields);
    expect(uses(viewer, 'is', { mode: 'exactDate', date: '2024-01-01' })).toBe(true);
    expect(uses(fixed, 'is', { mode: 'exactDate', date: '2024-01-01' })).toBe(false);
    expect(uses(fixed, 'is', { mode: 'today' })).toBe(true);
    expect(uses(fixed, 'isWithin', { mode: 'nextYear' })).toBe(true);
    expect(uses(viewer, 'isEmpty')).toBe(false);
    expect(uses(viewer, 'is')).toBe(false);
    expect(uses(viewer, 'eq', 1)).toBe(false);
    expect(filterUsesViewerTime(null, fields)).toBe(false);
  });
});
