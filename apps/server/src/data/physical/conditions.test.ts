import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  matchesFilter,
  type DateRange,
  type DateTarget,
  type FilterGroup,
  type Operator,
} from '@riosoma/contracts';
import { join, query, sql } from '@riosoma/db';
import type { ReadContext, StoredField } from '../types.js';
import { columnRef, columnType, decodeValue, selectExpr, typeSql } from './columns.js';
import { compileFilter } from './filters.js';
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

/**
 * Color rules test records in the browser with the contracts' `matchesFilter`, and a rule has to
 * color exactly the records the view's filter would admit.  These are the filter's own cases, run
 * through the SQL filter and through the shared evaluation of the values the API sends for the
 * same cells, which must agree with each other and with the expected answer.
 */
let kit: Fixture;
beforeAll(async () => {
  kit = await fixture();
}, 60_000);
afterAll(async () => {
  await kit?.close();
});

async function admitted(f: StoredField, values: unknown[], filter: FilterGroup | null, context = ctx) {
  const type = columnType(f) ?? (f.type.endsWith('Time') ? 'timestamptz' : 'text');
  // Objects go in as JSON for `jsonb` columns; ranges are written as Postgres range literals.
  const cell = (value: unknown) =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? JSON.stringify(value) : value;
  const rows = values.map((value, i) => sql`(${i}::integer, ${cell(value)}::${typeSql(type)})`);
  const cells = sql`(VALUES ${join(rows, ', ')}) cells(n, ${columnRef(f)})`;
  const fields = new Map([[f.id, f]]);
  const server = await query<{ n: number }>(
    kit.pool,
    sql`SELECT n FROM ${cells} WHERE ${compileFilter(filter, fields, context)} ORDER BY n`,
  );
  const sent = await query<{ n: number; value: unknown }>(
    kit.pool,
    sql`SELECT n, ${selectExpr(f)} AS value FROM ${cells} ORDER BY n`,
  );
  const client = sent.rows
    .filter((row) =>
      matchesFilter(filter, fields, () => decodeValue(f, row.value), {
        timeZone: context.timeZone,
        now: context.now,
      }),
    )
    .map((row) => row.n);
  return { server: server.rows.map((row) => row.n), client };
}

async function agree(f: StoredField, values: unknown[], filter: FilterGroup | null, context?: ReadContext) {
  const { server, client } = await admitted(f, values, filter, context);
  expect(client, JSON.stringify(filter)).toEqual(server);
  return server;
}

async function check(f: StoredField, values: unknown[], cases: [Operator, unknown, number[]][]) {
  for (const [operator, value, expected] of cases) {
    const { server, client } = await admitted(f, values, group(condition(f, operator, value)));
    expect(server, `filter ${operator}`).toEqual(expected);
    expect(client, `rule ${operator}`).toEqual(expected);
  }
}

describe('rules and filters agree on every operator', () => {
  it.each(['text', 'longText', 'email', 'url', 'phone', 'recordId'] as const)(
    '%s treats text literally and ignores case',
    async (type) => {
      await check(
        field(type),
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

  it.each(['number', 'currency', 'percent', 'duration', 'rating', 'autoNumber'] as const)(
    '%s compares numbers and includes empty in neq',
    async (type) => {
      const values = type === 'rating' ? [null, 1, 2, 3, 4] : [null, -1, 0, 2, 3];
      const two = values[3]!;
      await check(field(type), values, [
        ['eq', two, [3]],
        ['neq', two, [0, 1, 2, 4]],
        ['lt', two, [1, 2]],
        ['lte', two, [1, 2, 3]],
        ['gt', two, [4]],
        ['gte', two, [3, 4]],
        ['isEmpty', undefined, [0]],
        ['isNotEmpty', undefined, [1, 2, 3, 4]],
      ]);
    },
  );

  it('compares fractions exactly', async () => {
    await check(
      field('currency'),
      [0.1, 0.2, 0.30000000000000004],
      [
        ['eq', 0.1, [0]],
        ['gt', 0.2, [2]],
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

  it.each([
    ['multipleSelect', choiceIds],
    ['user', userIds],
  ] as const)('%s compares sets', async (type, [a, b, c]) => {
    await check(
      field(type, type === 'user' ? { allowMultiple: true } : {}),
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

  it('finds empty attachment cells', async () => {
    await check(
      field('attachment'),
      [null, [], ['att00000000000001']],
      [
        ['isEmpty', undefined, [0, 1]],
        ['isNotEmpty', undefined, [2]],
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
      expect(await agree(f, values, { conjunction, conditions: unusable })).toEqual([0, 1, 2, 3]);
      expect(
        await agree(f, values, { conjunction, conditions: [...unusable, condition(f, 'eq', 2)] }),
      ).toEqual([2]);
    }
    const nested = group(
      { conjunction: 'or', conditions: [condition(f, 'eq', 1), condition(f, 'eq', 3), ...unusable] },
      condition(f, 'gt', 1),
    );
    expect(await agree(f, values, nested)).toEqual([3]);
    expect(
      await agree(f, values, { conjunction: 'or', conditions: [group(...unusable), condition(f, 'eq', 2)] }),
    ).toEqual([2]);
    expect(await agree(f, values, { conjunction: 'or', conditions: [group(...unusable)] })).toEqual([
      0, 1, 2, 3,
    ]);
    expect(await agree(f, values, null)).toEqual([0, 1, 2, 3]);
  });
});

describe('rules and filters agree on compound fields', () => {
  it('reads date ranges by their days, and by the day they start', async () => {
    const f = field('dateRange');
    await check(
      f,
      [
        '[2024-01-21,2024-01-26]',
        '[2024-01-29,2024-02-02]',
        '[2024-02-01,2024-02-03]',
        '[2024-02-20,2024-03-11]',
        null,
      ],
      [
        ['containsDate', { mode: 'today' }, [1]],
        ['containsDate', { mode: 'exactDate', date: '2024-01-26' }, [0]],
        ['overlaps', { mode: 'nextWeek' }, [1, 2]],
        ['overlaps', { mode: 'pastDays', days: 7 }, [0, 1]],
        ['isWithin', { mode: 'nextWeek' }, [2]],
        ['isWithin', { mode: 'pastMonth' }, [0]],
        ['is', { mode: 'exactDate', date: '2024-02-01' }, [2]],
        ['isNot', { mode: 'exactDate', date: '2024-02-01' }, [0, 1, 3, 4]],
        ['isBefore', { mode: 'today' }, [0, 1]],
        ['isOnOrAfter', { mode: 'tomorrow' }, [2, 3]],
        ['isEmpty', undefined, [4]],
        ['isNotEmpty', undefined, [0, 1, 2, 3]],
      ],
    );
  });

  it('reads timed ranges on the days of the field’s time zone', async () => {
    const f = field('dateRange', { includeTime: true, timeZone: 'Asia/Tokyo' });
    // 23:30 on the 27th in UTC is already the 28th in Tokyo, and 10:00 on the 27th is still the 27th.
    const values = [
      '[2026-09-27T23:30:00Z,2026-09-28T01:00:00Z]',
      '[2026-09-26T00:00:00Z,2026-09-27T10:00:00Z]',
    ];
    await check(f, values, [
      ['containsDate', { mode: 'exactDate', date: '2026-09-28' }, [0]],
      ['containsDate', { mode: 'exactDate', date: '2026-09-27' }, [1]],
      ['is', { mode: 'exactDate', date: '2026-09-28' }, [0]],
      ['is', { mode: 'exactDate', date: '2026-09-26' }, [1]],
    ]);
  });

  it('measures locations by distance, reads JSON as text, and finds signatures', async () => {
    await check(
      field('location'),
      [
        { lat: 48.8566, lng: 2.3522, label: 'Paris' },
        { lat: 45.764, lng: 4.8357, label: 'Lyon' },
        { lat: 51.5072, lng: -0.1276, label: null },
        null,
      ],
      [
        ['isWithin', { lat: 48.8566, lng: 2.3522, km: 1 }, [0]],
        ['isWithin', { lat: 48.8566, lng: 2.3522, km: 350 }, [0, 2]],
        ['isWithin', { lat: 48.8566, lng: 2.3522, km: 400 }, [0, 1, 2]],
        ['isEmpty', undefined, [3]],
        ['isNotEmpty', undefined, [0, 1, 2]],
      ],
    );
    await check(
      field('json'),
      ['{"city":"Paris"}', '["Lyon"]', '42', null],
      [
        ['contains', 'paris', [0]],
        ['doesNotContain', 'paris', [1, 2, 3]],
        ['isEmpty', undefined, [3]],
      ],
    );
    const signed = { drawing: null, name: 'Ada', signedBy: null, signedAt: '2026-09-27T00:00:00.000Z' };
    await check(
      field('signature'),
      [signed, null, signed, null],
      [
        ['isNotEmpty', undefined, [0, 2]],
        ['isEmpty', undefined, [1, 3]],
      ],
    );
  });
});

describe('rules and filters agree on calendar days', () => {
  it.each(['date', 'createdTime', 'lastModifiedTime'] as const)(
    '%s offers every date operator',
    async (type) => {
      await check(
        field(type, { timeZone: 'UTC' }),
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
        const kiritimati = timeZone === 'Pacific/Kiritimati';
        const today = kiritimati ? '2024-02-01' : '2024-01-31';
        const targets: [DateTarget, string][] = [
          [{ mode: 'today' }, today],
          [{ mode: 'tomorrow' }, kiritimati ? '2024-02-02' : '2024-02-01'],
          [{ mode: 'yesterday' }, kiritimati ? '2024-01-31' : '2024-01-30'],
          [{ mode: 'oneWeekAgo' }, kiritimati ? '2024-01-25' : '2024-01-24'],
          [{ mode: 'oneWeekFromNow' }, kiritimati ? '2024-02-08' : '2024-02-07'],
          [{ mode: 'oneMonthAgo' }, kiritimati ? '2024-01-01' : '2023-12-31'],
          [{ mode: 'oneMonthFromNow' }, kiritimati ? '2024-03-01' : '2024-02-29'],
          [{ mode: 'daysAgo', days: 2 }, kiritimati ? '2024-01-30' : '2024-01-29'],
          [{ mode: 'daysFromNow', days: 2 }, kiritimati ? '2024-02-03' : '2024-02-02'],
          [{ mode: 'daysAgo', days: 0 }, today],
          [{ mode: 'exactDate', date: '2024-02-29' }, '2024-02-29'],
        ];
        for (const fixed of [false, true]) {
          const f = field('date', { includeTime, timeZone: fixed ? timeZone : 'client' });
          const context = { ...ctx, timeZone: fixed ? 'UTC' : timeZone };
          for (const [target, expected] of targets) {
            const value = includeTime ? `${expected}T12:00:00${kiritimati ? '+14:00' : '-10:00'}` : expected;
            expect(
              await agree(f, [null, value], group(condition(f, 'is', target)), context),
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
      const days = [null, before.toISOString().slice(0, 10), start, end, after.toISOString().slice(0, 10)];
      expect(await agree(f, days, group(condition(f, 'isWithin', range)), context), range.mode).toEqual([
        2, 3,
      ]);
    }
    expect(
      await agree(f, ['2023-02-28', '2023-03-03'], group(condition(f, 'is', { mode: 'oneMonthFromNow' })), {
        ...ctx,
        now: new Date('2023-01-31T12:00:00Z'),
      }),
    ).toEqual([0]);
  });

  it('applies ranges to local days in both zones, for timed and computed times', async () => {
    const ranges: DateRange[] = [{ mode: 'pastWeek' }, { mode: 'nextMonth' }, { mode: 'pastDays', days: 3 }];
    for (const zone of ['Pacific/Kiritimati', 'America/Adak']) {
      const offset = zone === 'Pacific/Kiritimati' ? '+14:00' : '-10:00';
      const context = { ...ctx, timeZone: zone, now: new Date(`2024-02-29T00:30:00${offset}`) };
      for (const type of ['date', 'createdTime', 'lastModifiedTime'] as const) {
        for (const fixed of [false, true]) {
          const f = field(type, { includeTime: true, timeZone: fixed ? zone : 'client' });
          const days = [
            '2024-02-21',
            '2024-02-22',
            '2024-02-26',
            '2024-02-29',
            '2024-03-01',
            '2024-03-29',
            '2024-03-30',
          ];
          for (const range of ranges)
            await agree(
              f,
              [null, ...days.map((day) => `${day}T12:00:00${offset}`)],
              group(condition(f, 'isWithin', range)),
              { ...context, timeZone: fixed ? 'UTC' : zone },
            );
        }
      }
    }
  });

  it('keeps the entire local day across a daylight saving transition', async () => {
    const f = field('date', { includeTime: true, timeZone: 'America/Adak' });
    const context = { ...ctx, now: new Date('2024-03-10T10:30:00Z') };
    expect(
      await agree(
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
});
