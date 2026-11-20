import { describe, expect, it } from 'vitest';
import { interpretLayout, applyCleaners } from './interpreter.js';
import { layoutSchema, LayoutValidationError } from './layout.js';
import type { Layout, SkipRule } from './layout.js';
import { cell } from './source.js';
import type { ExtractedSource } from './source.js';

function source(rows: (string | number | null)[][], name = 'Orders'): ExtractedSource {
  return {
    kind: 'workbook',
    name: 'orders.xlsx',
    warnings: [],
    sheets: [{ name, hidden: false, rows: rows.map((row) => row.map(cell)) }],
  };
}
const basic: Layout = {
  header: { markers: ['ID'], searchRows: 5 },
  columns: {
    id: { aliases: ['ID', 'Identifier'], cleaners: [{ kind: 'identifier' }] },
    amount: {
      aliases: ['Amount', 'Value'],
      cleaners: [
        { kind: 'blank', placeholders: ['N/A'] },
        { kind: 'number', decimalMark: '.' },
      ],
    },
  },
  skip: [{ field: 'id', equals: 'Grand total' }],
  checks: [{ field: 'amount', label: 'Grand total', cleaner: { decimalMark: '.' } }],
};

describe('layout schema', () => {
  it('accepts plain data and returns an independent copy', () => {
    const parsed = layoutSchema.parse(basic);
    expect(parsed).toEqual(basic);
    parsed.header.markers.push('Extra');
    expect(basic.header.markers).toEqual(['ID']);
    expect(() =>
      layoutSchema.parse({
        ...basic,
        checks: [{ field: 'amount', label: 'Total', cleaner: { decimalMark: '.', units: ['$'] } }],
      }),
    ).not.toThrow();
  });
  it('refuses unknown keys at every structural level', () => {
    for (const input of [
      { ...basic, execute: 'anything' },
      { ...basic, header: { ...basic.header, pattern: 'ID' } },
      { ...basic, columns: { id: { aliases: ['ID'], cleaners: [{ kind: 'text', expression: 'ID' }] } } },
      { ...basic, columns: { id: { aliases: ['ID'], cleaners: [{ kind: 'text' }], optional: true } } },
      { ...basic, checks: [{ field: 'amount', label: 'Total', tolerance: 1 }] },
      { ...basic, skip: [{ field: 'id', regex: 'total' }] },
    ])
      expect(() => layoutSchema.parse(input)).toThrow(LayoutValidationError);
  });
  it('refuses pattern objects, functions, and accessors without executing them', () => {
    for (const value of [/ID/u, () => 'ID', Symbol('ID'), 1n, new Date(0), new Map()])
      expect(() => layoutSchema.parse({ ...basic, header: { markers: [value], searchRows: 5 } })).toThrow(
        LayoutValidationError,
      );
    let called = false;
    const accessor = {
      get header() {
        called = true;
        return basic.header;
      },
      columns: basic.columns,
    };
    expect(() => layoutSchema.parse(accessor)).toThrow(LayoutValidationError);
    expect(called).toBe(false);
    const markers = ['ID'];
    Object.setPrototypeOf(
      markers,
      Object.create(Array.prototype, {
        forEach: {
          value: () => {
            called = true;
          },
        },
      }),
    );
    expect(() => layoutSchema.parse({ ...basic, header: { markers, searchRows: 5 } })).toThrow(
      LayoutValidationError,
    );
    expect(called).toBe(false);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => layoutSchema.parse(cycle)).toThrow(LayoutValidationError);
    expect(() =>
      layoutSchema.parse(Object.defineProperty({ ...basic }, 'hiddenCode', { value: 'run' })),
    ).toThrow(LayoutValidationError);
    expect(() => layoutSchema.parse({ ...basic, header: { markers: Array(1), searchRows: 5 } })).toThrow(
      LayoutValidationError,
    );
  });
  it('refuses malformed options, unknown fields, and unsafe field keys', () => {
    for (const input of [
      { ...basic, fillDown: ['missing'] },
      { ...basic, skip: [{ field: 'id', blank: true, equals: null }] },
      { ...basic, constants: { id: 'fixed' } },
      { ...basic, header: { markers: [], searchRows: 5 } },
      { ...basic, header: { markers: ['ID'], searchRows: 0 } },
      { ...basic, columns: { id: { aliases: ['ID'], cleaners: [{ kind: 'date', formats: ['native'] }] } } },
      { ...basic, columns: { id: { aliases: ['ID'], cleaners: [{ kind: 'number', decimalMark: 'x' }] } } },
      { ...basic, columns: { id: { aliases: ['ID'], cleaners: [{ kind: 'identifier', width: -1 }] } } },
      { ...basic, columns: { constructor: { aliases: ['ID'], cleaners: [{ kind: 'text' }] } } },
    ])
      expect(() => layoutSchema.parse(input)).toThrow(LayoutValidationError);
  });
  it.each([
    'Net Revenue (USD)',
    'Supply Partner (group)',
    'New customers',
    'import duty paid',
    'A/B test',
    'Cost in US$',
    'Q1 2026; restated',
    'Why? Because: yes',
    'Price * Qty',
    'Start=End',
    'Ad Revenue {net}',
    '^ID',
    'Amount.*',
    '(value) => value',
    '=SUM(A1)',
    'eval(value)',
  ])('keeps text that resembles code as plain text: %s', (value) => {
    // A layout's text is matched against a file's text and never run, so headings like these are data.
    const parsed = layoutSchema.parse({
      ...basic,
      header: { markers: [value], searchRows: 5 },
      columns: {
        ...basic.columns,
        id: { aliases: [value], cleaners: [{ kind: 'text', placeholders: [value] }] },
      },
      constants: { note: value },
    });
    expect(parsed.header.markers).toEqual([value]);
    expect(parsed.columns.id!.aliases).toEqual([value]);
    expect(parsed.constants).toEqual({ note: value });
  });
  it('accepts literal wildcard segments on either side of an asterisk', () => {
    for (const wildcard of ['*', 'Total*', '*Cove', 'Cove*South', 'Cove * South'])
      expect(layoutSchema.parse({ ...basic, skip: [{ field: 'id', wildcard }] }).skip).toEqual([
        { field: 'id', wildcard },
      ]);
  });
  it('keeps literal dates, decimals, date formats, placeholders, and hyphenated identifiers as data', () => {
    for (const value of [
      '2026/03/15',
      '03/15/2026',
      '15/03/2026',
      'YYYY/MM/DD',
      'N/A',
      'INV-00412',
      '1e+3',
      '+1.25e+3',
      '-1.25e+3',
      '9007199254740993e+3',
    ])
      expect(layoutSchema.parse({ ...basic, constants: { reference: value } }).constants).toEqual({
        reference: value,
      });
  });
});

describe('layout interpreter', () => {
  it('records drift, skipped rows, exact checks, and raw text with source locations', () => {
    const result = interpretLayout(
      source([['Cover'], ['ID', 'Value'], ['0042', ' 0.10 '], ['0043', '0.20'], ['Grand total', '0.30']]),
      basic,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toEqual([
      { values: { id: '0042', amount: '0.1' }, at: { sheet: 'Orders', row: 3 }, raw: { amount: ' 0.10 ' } },
      { values: { id: '0043', amount: '0.2' }, at: { sheet: 'Orders', row: 4 }, raw: { amount: '0.20' } },
    ]);
    expect(result.notes).toContainEqual({
      key: 'ingest.layout.drift',
      at: { sheet: 'Orders', row: 2 },
      field: 'amount',
      preferred: 'Amount',
      actual: 'Value',
    });
    expect(result.notes).toContainEqual({
      key: 'ingest.layout.skipped',
      at: { sheet: 'Orders', row: 5 },
      reason: 'ingest.layout.skipRule',
      rule: { field: 'id', equals: 'Grand total' },
    });
    expect(result.checks[0]).toMatchObject({
      status: 'passed',
      actual: '0.3',
      expected: '0.3',
      at: { sheet: 'Orders', row: 5 },
    });
  });
  it('returns typed failures for a missing header, column, ambiguous column, unsupported source, or no rows', () => {
    const cases = [
      { source: source([['Other']]), key: 'ingest.layout.headerNotFound' },
      { source: source([['ID'], ['0042']]), key: 'ingest.layout.columnMissing' },
      {
        source: source([
          ['ID', 'Amount', 'Amount'],
          ['0042', '1', '2'],
        ]),
        key: 'ingest.layout.columnAmbiguous',
      },
      { source: source([['ID', 'Amount']]), key: 'ingest.layout.noRows' },
      {
        source: source([
          ['ID', 'Amount'],
          ['Grand total', '0'],
        ]),
        key: 'ingest.layout.noRows',
      },
      {
        source: { kind: 'text' as const, name: 'empty.txt', warnings: [] },
        key: 'ingest.layout.unsupportedSource',
      },
    ];
    for (const test of cases)
      expect(interpretLayout(test.source, basic)).toMatchObject({ ok: false, failure: { key: test.key } });
    expect(interpretLayout(source([['ID']]), { ...basic, code: true })).toMatchObject({
      ok: false,
      failure: { key: 'ingest.layout.invalid' },
    });
  });
  it('never manufactures an expected total and exposes failed or uncertain checks', () => {
    expect(
      interpretLayout(
        source([
          ['ID', 'Amount'],
          ['0042', '1.20'],
        ]),
        basic,
      ).checks[0],
    ).toMatchObject({ status: 'unavailable', expected: null, reason: 'ingest.check.totalMissing' });
    expect(
      interpretLayout(
        source([
          ['ID', 'Amount'],
          ['0042', '1.20'],
          ['Grand total', '9'],
        ]),
        basic,
      ).checks[0],
    ).toMatchObject({ status: 'failed', expected: '9', actual: '1.2' });
    expect(
      interpretLayout(
        source([
          ['ID', 'Amount'],
          ['0042', 'bad'],
          ['Grand total', '1'],
        ]),
        basic,
      ).checks[0],
    ).toMatchObject({ status: 'unavailable', reason: 'ingest.check.uncertainValue' });
    expect(
      interpretLayout(
        source([
          ['ID', 'Amount'],
          ['0042', '1'],
          ['Grand total', '1'],
          ['Grand total', '1'],
        ]),
        basic,
      ).checks[0],
    ).toMatchObject({ status: 'unavailable', reason: 'ingest.check.totalAmbiguous' });
  });
  it('reads a stated total aligned with its field across intervening blank columns', () => {
    const result = interpretLayout(
      source([
        ['ID', 'Product', 'Amount'],
        ['0042', 'Orbit Sprocket', '1.25'],
        ['Grand total', null, '1.25'],
      ]),
      basic,
    );
    expect(result.checks[0]).toMatchObject({ status: 'passed', expected: '1.25', actual: '1.25' });
  });
  it('does not choose between conflicting adjacent and column-aligned totals', () => {
    const result = interpretLayout(
      source([
        ['ID', 'Product', 'Amount'],
        ['0042', 'Orbit Sprocket', '1.25'],
        ['Grand total', '1.25', '9'],
      ]),
      basic,
    );
    expect(result.checks[0]).toMatchObject({
      status: 'unavailable',
      expected: null,
      reason: 'ingest.check.totalAmbiguous',
    });
  });
  it('uses ordered cleaners without hiding earlier uncertainty', () => {
    expect(
      applyCleaners('n/a', [
        { kind: 'blank', placeholders: ['N/A'] },
        { kind: 'number', decimalMark: '.' },
      ]),
    ).toEqual({ value: null, certain: true });
    expect(applyCleaners('1,234', [{ kind: 'number' }, { kind: 'text' }])).toMatchObject({
      certain: false,
      issue: { input: 'decimalMark' },
    });
    expect(applyCleaners('active', [{ kind: 'boolean', trueValues: ['active'] }]).value).toBe(true);
    expect(applyCleaners('1.5', [{ kind: 'duration', unit: 'hours', decimalMark: '.' }]).value).toBe('5400');
    expect(applyCleaners('A', [{ kind: 'lookup', entries: { A: 'Crest' } }, { kind: 'text' }]).value).toBe(
      'Crest',
    );
  });
  it('preserves native numeric precision and identifier width through text cleaners', () => {
    for (const input of [412, cell(412)]) {
      expect(applyCleaners(input, [{ kind: 'text' }, { kind: 'identifier' }])).toEqual({
        value: '412',
        certain: false,
        issue: { key: 'ingest.cleaner.missingInput', input: 'width' },
      });
      expect(applyCleaners(input, [{ kind: 'text' }, { kind: 'identifier', width: 5 }])).toEqual({
        value: '00412',
        certain: true,
      });
      expect(
        applyCleaners(input, [{ kind: 'number' }, { kind: 'text' }, { kind: 'identifier' }]),
      ).toMatchObject({
        certain: false,
        issue: { input: 'width' },
      });
    }
    for (const input of [Number.MAX_SAFE_INTEGER + 1, cell(Number.MAX_SAFE_INTEGER + 1)]) {
      expect(applyCleaners(input, [{ kind: 'text' }, { kind: 'number', decimalMark: '.' }])).toEqual({
        value: null,
        certain: false,
        issue: { key: 'ingest.cleaner.missingInput', input: 'exactText' },
      });
      expect(applyCleaners(input, [{ kind: 'text' }, { kind: 'duration', unit: 'seconds' }])).toMatchObject({
        certain: false,
        issue: { input: 'exactText' },
      });
    }
    for (const input of [-1, 1.5])
      expect(applyCleaners(input, [{ kind: 'text' }, { kind: 'identifier', width: 5 }])).toMatchObject({
        certain: false,
        issue: { key: 'ingest.cleaner.invalid', input: 'identifier' },
      });
    for (let input = 0; input < 150; input++)
      expect(
        applyCleaners(input, [{ kind: 'text' }, { kind: 'blank' }, { kind: 'text' }, { kind: 'identifier' }])
          .certain,
      ).toBe(false);
  });
  it('honors native decimal notation, explicit width, placeholders, and lookup replacements', () => {
    expect(applyCleaners(1.234, [{ kind: 'text' }, { kind: 'number', decimalMark: ',' }])).toEqual({
      value: '1.234',
      certain: true,
    });
    expect(applyCleaners('9007199254740992', [{ kind: 'text' }, { kind: 'number' }])).toEqual({
      value: '9007199254740992',
      certain: true,
    });
    expect(
      applyCleaners(412, [
        { kind: 'text' },
        { kind: 'blank', placeholders: ['412'] },
        { kind: 'identifier' },
      ]),
    ).toEqual({ value: null, certain: true });
    expect(
      applyCleaners(412, [
        { kind: 'text' },
        { kind: 'identifier', width: 5 },
        { kind: 'text' },
        { kind: 'identifier' },
      ]),
    ).toEqual({ value: '00412', certain: true });
    expect(
      applyCleaners(412, [
        { kind: 'text' },
        { kind: 'lookup', entries: { '412': '00412' } },
        { kind: 'identifier' },
      ]),
    ).toEqual({ value: '00412', certain: true });
    expect(
      applyCleaners('Cove', [
        { kind: 'lookup', entries: { Cove: 412 } },
        { kind: 'text' },
        { kind: 'identifier' },
      ]),
    ).toMatchObject({ certain: false, issue: { input: 'width' } });
  });
  it('reports numeric provenance uncertainty in rows and makes their sum unavailable', () => {
    const result = interpretLayout(
      source([
        ['ID', 'Amount'],
        [412, Number.MAX_SAFE_INTEGER + 1],
        ['Grand total', '9007199254740992'],
      ]),
      {
        ...basic,
        columns: {
          id: { aliases: ['ID'], cleaners: [{ kind: 'text' }, { kind: 'identifier' }] },
          amount: { aliases: ['Amount'], cleaners: [{ kind: 'text' }, { kind: 'number' }] },
        },
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]?.values).toEqual({ id: '412', amount: null });
    expect(result.notes).toContainEqual({
      key: 'ingest.layout.uncertain',
      at: { sheet: 'Orders', row: 2 },
      field: 'id',
      issue: { key: 'ingest.cleaner.missingInput', input: 'width' },
    });
    expect(result.notes).toContainEqual({
      key: 'ingest.layout.uncertain',
      at: { sheet: 'Orders', row: 2 },
      field: 'amount',
      issue: { key: 'ingest.cleaner.missingInput', input: 'exactText' },
    });
    expect(result.checks[0]).toMatchObject({ status: 'unavailable', reason: 'ingest.check.uncertainValue' });
  });
  it('fills merged labels, preserves their raw blanks, applies constants, and resets at each sheet', () => {
    const layout: Layout = {
      header: { markers: ['Group', 'Amount'], searchRows: 5 },
      columns: {
        group: { aliases: ['Group'], cleaners: [{ kind: 'text' }] },
        amount: { aliases: ['Amount'], cleaners: [{ kind: 'number', decimalMark: '.' }] },
      },
      fillDown: ['group'],
      constants: { currency: 'USD' },
      skip: [{ field: 'group', wildcard: 'Total*' }],
    };
    const input = source([
      ['Group', 'Amount'],
      ['Crest', '1'],
      [null, '2'],
      ['Total Crest', '3'],
    ]);
    input.sheets!.push({
      name: 'Second',
      hidden: false,
      rows: [
        ['Group', 'Amount'],
        [null, '4'],
      ].map((row) => row.map(cell)),
    });
    const result = interpretLayout(input, layout);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.map((row) => row.values)).toEqual([
      { group: 'Crest', amount: '1', currency: 'USD' },
      { group: 'Crest', amount: '2', currency: 'USD' },
      { group: null, amount: '4', currency: 'USD' },
    ]);
    expect(result.rows[1]?.raw.group).toBe('');
  });
  it.each(['Subtotal: Cove', 'Grand total: Cove', 'Total:Cove'])(
    'excludes a skipped total with a colon from merged-label context: %s',
    (label) => {
      const result = interpretLayout(
        source([
          ['Group', 'Amount'],
          ['Cove', '1'],
          [label, '1'],
          [null, '2'],
        ]),
        {
          header: { markers: ['Group'], searchRows: 1 },
          columns: {
            group: { aliases: ['Group'], cleaners: [{ kind: 'text' }] },
            amount: { aliases: ['Amount'], cleaners: [{ kind: 'number', decimalMark: '.' }] },
          },
          fillDown: ['group'],
          skip: [
            { field: 'group', wildcard: 'Subtotal*' },
            { field: 'group', wildcard: 'Total*' },
            { field: 'group', wildcard: 'Grand total*' },
          ],
        },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.rows.map((row) => row.values)).toEqual([
        { group: 'Cove', amount: '1' },
        { group: 'Cove', amount: '2' },
      ]);
    },
  );
  it.each<SkipRule>([
    { field: 'status', equals: 'canceled' },
    { field: 'status', wildcard: 'canceled*' },
    { field: 'status', blank: true },
  ])('retains skipped group labels without carrying totals into later rows: %j', (skip) => {
    const skippedStatus = 'blank' in skip ? null : 'canceled';
    const layout: Layout = {
      header: { markers: ['Department'], searchRows: 1 },
      columns: {
        department: { aliases: ['Department'], cleaners: [{ kind: 'text' }] },
        status: { aliases: ['Status'], cleaners: [{ kind: 'text' }] },
        amount: { aliases: ['Amount'], cleaners: [{ kind: 'number', decimalMark: '.' }] },
      },
      fillDown: ['department'],
      skip: [skip],
      checks: [{ field: 'amount', label: 'Reported balance', cleaner: { decimalMark: '.' } }],
    };
    const result = interpretLayout(
      source([
        ['Department', 'Amount', 'Status'],
        ['Crest', '0.1', 'active'],
        ['Cove', 'bad', skippedStatus],
        [null, '0.2', 'active'],
        ['Subtotal Cove', '0.3', skippedStatus],
        [null, '0.3', 'active'],
        ['Grand total', '0.6', skippedStatus],
        ['Reported balance', '1', skippedStatus],
        [null, '0.4', 'active'],
      ]),
      layout,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.map((row) => row.values)).toEqual([
      { department: 'Crest', status: 'active', amount: '0.1' },
      { department: 'Cove', status: 'active', amount: '0.2' },
      { department: 'Cove', status: 'active', amount: '0.3' },
      { department: 'Cove', status: 'active', amount: '0.4' },
    ]);
    expect(result.rows.map((row) => row.at.row)).toEqual([2, 4, 6, 9]);
    expect(result.rows.slice(1).map((row) => row.raw.department)).toEqual(['', '', '']);
    expect(result.notes.filter((note) => note.key === 'ingest.layout.skipped')).toHaveLength(4);
    expect(result.notes.filter((note) => note.key === 'ingest.layout.uncertain')).toEqual([]);
    expect(result.checks[0]).toMatchObject({ status: 'passed', actual: '1', expected: '1' });
  });
  it('carries uncertainty from a skipped merged label into the rows that use it', () => {
    const result = interpretLayout(
      source([
        ['Department', 'Status'],
        [412, 'canceled'],
        [null, 'active'],
      ]),
      {
        header: { markers: ['Department'], searchRows: 1 },
        columns: {
          department: { aliases: ['Department'], cleaners: [{ kind: 'text' }, { kind: 'identifier' }] },
          status: { aliases: ['Status'], cleaners: [{ kind: 'text' }] },
        },
        fillDown: ['department'],
        skip: [{ field: 'status', equals: 'canceled' }],
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toEqual([
      {
        values: { department: '412', status: 'active' },
        at: { sheet: 'Orders', row: 3 },
        raw: { department: '' },
      },
    ]);
    expect(result.notes.filter((note) => note.key === 'ingest.layout.uncertain')).toEqual([
      {
        key: 'ingest.layout.uncertain',
        at: { sheet: 'Orders', row: 3 },
        field: 'department',
        issue: { key: 'ingest.cleaner.missingInput', input: 'width' },
      },
    ]);
  });
  it('keeps a failure atomic when a later sheet lacks a required column', () => {
    const input = source([
      ['ID', 'Amount'],
      ['0042', '1'],
    ]);
    input.sheets!.push({ name: 'Broken', hidden: false, rows: [[cell('ID')]] });
    const result = interpretLayout(input, basic);
    expect(result).toMatchObject({
      ok: false,
      failure: { key: 'ingest.layout.columnMissing', sheet: 'Broken' },
    });
    expect(result).not.toHaveProperty('rows');
  });
});

describe('column-wide date order', () => {
  const layout: Layout = {
    header: { markers: ['Date'], searchRows: 5 },
    columns: {
      date: {
        aliases: ['Date'],
        cleaners: [
          { kind: 'blank', placeholders: ['N/A'] },
          { kind: 'date', formats: ['MM/DD/YYYY', 'DD/MM/YYYY'] },
        ],
      },
    },
    skip: [{ field: 'date', equals: 'Skip' }],
  };
  it('reports ambiguity when every value permits both orders, including equal readings', () => {
    for (const values of [
      ['03/04/2026', '05/06/2026'],
      ['01/01/2026', '02/02/2026'],
    ]) {
      const result = interpretLayout(source([['Date'], ...values.map((value) => [value])]), layout);
      expect(result.notes.filter((note) => note.key === 'ingest.layout.uncertain')).toHaveLength(2);
    }
  });
  it('uses one decisive day to settle all values, regardless of position', () => {
    for (const values of [
      ['03/04/2026', '03/15/2026'],
      ['03/15/2026', '03/04/2026'],
    ]) {
      const result = interpretLayout(source([['Date'], ...values.map((value) => [value])]), layout);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.rows.map((row) => row.values.date)).toEqual(
        values.map((value) => (value === '03/04/2026' ? '2026-03-04' : '2026-03-15')),
      );
      expect(result.notes).toEqual([]);
    }
    const result = interpretLayout(
      source([['Date'], ['03/04/2026'], ['15/03/2026'], ['N/A'], ['Skip']]),
      layout,
    );
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.rows.map((row) => row.values.date)).toEqual(['2026-04-03', '2026-03-15', null]);
  });
  it('does not use invalid or skipped values to guess an order', () => {
    const result = interpretLayout(source([['Date'], ['03/04/2026'], ['bad']]), layout);
    expect(result.notes.filter((note) => note.key === 'ingest.layout.uncertain')).toHaveLength(2);
  });
  it('settles order across sheets and separators without making ISO dates uncertain', () => {
    const input = source([['Date'], ['03/04/2026']]);
    input.sheets!.push({
      name: 'Second',
      hidden: false,
      rows: [['Date'], ['03-15-2026'], ['2026-03-16']].map((row) => row.map(cell)),
    });
    const mixed: Layout = {
      ...layout,
      columns: {
        date: {
          aliases: ['Date'],
          cleaners: [
            { kind: 'date', formats: ['MM/DD/YYYY', 'DD/MM/YYYY', 'MM-DD-YYYY', 'DD-MM-YYYY', 'YYYY-MM-DD'] },
          ],
        },
      },
    };
    const result = interpretLayout(input, mixed);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.map((row) => row.values.date)).toEqual(['2026-03-04', '2026-03-15', '2026-03-16']);
    expect(result.notes).toEqual([]);
    const ambiguous = interpretLayout(source([['Date'], ['03/04/2026'], ['2026-03-16']]), mixed);
    expect(ambiguous.notes.filter((note) => note.key === 'ingest.layout.uncertain')).toHaveLength(1);
  });
  it('reports conflicting decisive date orders as uncertain', () => {
    const result = interpretLayout(source([['Date'], ['03/15/2026'], ['15/03/2026']]), layout);
    expect(result.notes.filter((note) => note.key === 'ingest.layout.uncertain')).toHaveLength(2);
    expect(result.notes).toContainEqual(
      expect.objectContaining({ issue: { key: 'ingest.cleaner.ambiguous', input: 'consistentFormats' } }),
    );
  });
});
