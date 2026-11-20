import { describe, expect, it } from 'vitest';
import { addDecimals } from '../cleaners.js';
import { generateArchetype } from '../corpus.js';
import { cell } from '../source.js';
import type { Cell, ExtractedSource } from '../source.js';
import type { ExampleRows } from '../storage.js';
import type { PairOutputFormat } from './compare.js';
import {
  ABSENT_VALUE_LIMIT,
  checkPair,
  ROW_SHORTFALL_FACTOR,
  ROW_SHORTFALL_MINIMUM,
  SUMMARY_MAX_ROWS,
  SUMMARY_MIN_DATA_ROWS,
  SUMMARY_MIN_NUMERIC_CELLS,
  type PairInput,
} from './check.js';

function generated(size = 5) {
  const example = generateArchetype(2, { seed: 20, size });
  const format: PairOutputFormat = {
    rowMeaning: '',
    identity: null,
    fields: Object.keys(example.expected[0]!.values).map((key) => ({ key, meaning: '', required: true })),
  };
  return {
    input: { source: example.source, sha256: 'a'.repeat(64) },
    expected: structuredClone(example.expected),
    format,
  };
}
function plain(size: number) {
  const example = generateArchetype(1, { seed: 20, size });
  const format: PairOutputFormat = {
    rowMeaning: '',
    identity: null,
    fields: Object.keys(example.expected[0]!.values).map((key) => ({ key, meaning: '', required: false })),
  };
  return { input: { source: example.source, sha256: 'a'.repeat(64) }, expected: example.expected, format };
}
const kinds = (input: PairInput, expected: ExampleRows, format: PairOutputFormat) =>
  checkPair(input, expected, format, []).map((finding) => finding.kind);

describe('pair arrival checks', () => {
  it('stays silent on a clean generated pair and does not change any input', () => {
    const pair = generated();
    const before = JSON.stringify(pair);
    expect(checkPair(pair.input, pair.expected, pair.format, [])).toEqual([]);
    expect(JSON.stringify(pair)).toBe(before);
  });

  it('blocks equal original hashes and accepts a different hash', () => {
    const pair = generated();
    const findings = checkPair(pair.input, pair.expected, pair.format, [
      { id: 'z', sha256: pair.input.sha256 },
      { id: 'a', sha256: pair.input.sha256 },
      { id: 'different', sha256: 'b'.repeat(64) },
    ]);
    expect(findings).toEqual([
      {
        kind: 'duplicate-file',
        messageId: 'ingest.pairs.duplicateFile',
        blocks: true,
        facts: { exampleIds: ['a', 'z'] },
      },
    ]);
    expect(
      checkPair(pair.input, pair.expected, pair.format, [{ id: 'different', sha256: 'b'.repeat(64) }]),
    ).toEqual([]);
  });

  it('asks to confirm a copied sheet despite key order and value normalization', () => {
    const pair = plain(4);
    const expected = pair.expected.map((row) => ({
      values: Object.fromEntries(Object.entries(row.values).toReversed()),
    }));
    expect(
      checkPair(pair.input, expected, pair.format, []).find((finding) => finding.kind === 'input-as-output'),
    ).toEqual({
      kind: 'input-as-output',
      messageId: 'ingest.pairs.inputAsOutput',
      blocks: false,
      facts: { table: 'Orders' },
    });
    expected[0]!.values.amount = 'changed';
    expect(kinds(pair.input, expected, pair.format)).not.toContain('input-as-output');
    expect(kinds(pair.input, pair.expected.slice(1), pair.format)).not.toContain('input-as-output');
  });

  it('recognizes an entire copied raw grid including its header and requires every column', () => {
    const pair = plain(3);
    const sheet = pair.input.source.sheets![0]!;
    sheet.rows = sheet.rows.slice(3);
    const expected = sheet.rows.map((row) => ({
      values: Object.fromEntries(row.map((item, index) => [`column${index}`, item.v])),
    }));
    expect(kinds(pair.input, expected, pair.format)).toContain('input-as-output');
    const subset = expected.map((row) => ({ values: { column0: row.values.column0 } }));
    expect(kinds(pair.input, subset, pair.format)).not.toContain('input-as-output');
  });

  it.each([false, true])(
    'asks to confirm normalized copies with alternate headings and renamed keys %s',
    (renameAll) => {
      const example = generateArchetype(1, { seed: 19, size: 4 });
      const format: PairOutputFormat = {
        identity: null,
        rowMeaning: '',
        fields: Object.keys(example.expected[0]!.values).map((key) => ({
          key,
          meaning: '',
          required: false,
        })),
      };
      if (renameAll)
        example.source.sheets![0]!.rows[3] = ['Record', 'Description', 'Charge', 'Calendar day'].map(cell);
      const expected = example.expected.map((row) => ({
        values: Object.fromEntries(Object.entries(row.values).toReversed()),
      }));
      const input = { source: example.source, sha256: 'a' };
      expect(
        checkPair(input, expected, format, []).find((finding) => finding.kind === 'input-as-output'),
      ).toEqual({
        kind: 'input-as-output',
        messageId: 'ingest.pairs.inputAsOutput',
        blocks: false,
        facts: { table: 'Orders' },
      });
      expect(kinds(input, expected.slice(1), format)).not.toContain('input-as-output');
      expect(
        kinds(
          input,
          expected.map((row) => ({ values: { amount: row.values.amount } })),
          format,
        ),
      ).not.toContain('input-as-output');
      expected[0]!.values.amount = addDecimals(String(expected[0]!.values.amount), '0.01');
      expect(kinds(input, expected, format)).not.toContain('input-as-output');
    },
  );

  it.each(['missing', 'empty'] as const)(
    'still blocks a copied raw table with unknown columns and a %s required field',
    (required) => {
      const expected: ExampleRows = ['A', 'B'].map((value) => ({
        values: { value, raw: 'extra', ...(required === 'empty' ? { finished: '' } : {}) },
      }));
      const keys = Object.keys(expected[0]!.values);
      const source: ExtractedSource = {
        kind: 'workbook',
        name: 'raw.xlsx',
        warnings: [],
        sheets: [
          {
            name: 'Raw',
            hidden: false,
            rows: [
              keys.map(cell),
              ...expected.map((row) => keys.map((key) => cell(String(row.values[key])))),
            ],
          },
        ],
      };
      const format: PairOutputFormat = {
        identity: null,
        rowMeaning: '',
        fields: ['value', 'finished'].map((key) => ({ key, meaning: '', required: true })),
      };
      const findings = checkPair({ source, sha256: 'a' }, expected, format, []);
      expect(findings.find((finding) => finding.kind === 'input-as-output')).toEqual({
        kind: 'input-as-output',
        messageId: 'ingest.pairs.inputAsOutput',
        blocks: false,
        facts: { table: 'Raw' },
      });
      expect(findings.filter((finding) => finding.blocks)).toEqual([
        {
          kind: 'columns',
          messageId: 'ingest.pairs.columns',
          blocks: true,
          facts: {
            unexpected: ['raw'],
            missing: required === 'missing' ? ['finished'] : [],
            rows: required === 'missing' ? { finished: [1, 2] } : {},
          },
        },
        {
          kind: 'empty-required',
          messageId: 'ingest.pairs.emptyRequired',
          blocks: true,
          facts: { field: 'finished', rows: [1, 2] },
        },
      ]);
    },
  );

  it('lists unknown columns, every missing required column, and their rows together', () => {
    const pair = generated();
    delete pair.expected[0]!.values.amount;
    delete pair.expected[2]!.values.amount;
    pair.expected[1]!.values.unknown = 'extra';
    expect(
      checkPair(pair.input, pair.expected, pair.format, []).find((finding) => finding.kind === 'columns'),
    ).toEqual({
      kind: 'columns',
      messageId: 'ingest.pairs.columns',
      blocks: true,
      facts: { unexpected: ['unknown'], missing: ['amount'], rows: { amount: [1, 3] } },
    });
    pair.format.fields = pair.format.fields.map((field) => ({ ...field, required: false }));
    delete pair.expected[1]!.values.unknown;
    expect(kinds(pair.input, pair.expected, pair.format)).not.toContain('columns');
  });

  it('reports required columns on an empty offering and accepts missing optional fields', () => {
    const pair = generated();
    expect(
      checkPair(pair.input, [], pair.format, []).find((finding) => finding.kind === 'columns'),
    ).toMatchObject({ facts: { missing: ['amount', 'department', 'product'] } });
    const optional = {
      ...pair.format,
      fields: pair.format.fields.map((field) => ({ ...field, required: false })),
    };
    expect(kinds(pair.input, [{ values: {} }], optional)).not.toContain('columns');
  });

  it('reports required inherited-property names as missing and empty', () => {
    const pair = generated();
    pair.format.fields = [{ key: 'toString', meaning: '', required: true }];
    const result = checkPair(pair.input, [{ values: {} }], pair.format, []);
    expect(result.find((finding) => finding.kind === 'columns')).toMatchObject({
      facts: { missing: ['toString'], rows: { toString: [1] } },
    });
    expect(result.find((finding) => finding.kind === 'empty-required')).toMatchObject({
      facts: { field: 'toString', rows: [1] },
    });
    expect(result.some((finding) => finding.kind === 'absent-value')).toBe(false);
  });

  it.each([null, undefined, '', ' \t '])(
    'blocks an empty required value %j with its one-based rows',
    (value) => {
      const pair = generated();
      pair.expected[1]!.values.amount = value;
      pair.expected[3]!.values.amount = value;
      expect(
        checkPair(pair.input, pair.expected, pair.format, []).find(
          (finding) => finding.kind === 'empty-required',
        ),
      ).toEqual({
        kind: 'empty-required',
        messageId: 'ingest.pairs.emptyRequired',
        blocks: true,
        facts: { field: 'amount', rows: [2, 4] },
      });
    },
  );

  it.each([0, 'N/A', false])('keeps nonempty required value %j distinct from blank', (value) => {
    const pair = generated();
    pair.expected[0]!.values.amount = value;
    expect(kinds(pair.input, pair.expected, pair.format)).not.toContain('empty-required');
    pair.format.fields = pair.format.fields.map((field) => ({ ...field, required: false }));
    pair.expected[0]!.values.amount = null;
    expect(kinds(pair.input, pair.expected, pair.format)).not.toContain('empty-required');
  });

  it('warns at the shortfall ratio and minimum, stays silent below either, and uses the largest table', () => {
    const at = plain(ROW_SHORTFALL_MINIMUM);
    const count = ROW_SHORTFALL_MINIMUM / ROW_SHORTFALL_FACTOR;
    expect(
      checkPair(at.input, at.expected.slice(0, count), at.format, []).find(
        (finding) => finding.kind === 'row-shortfall',
      ),
    ).toEqual({
      kind: 'row-shortfall',
      messageId: 'ingest.pairs.rowShortfall',
      blocks: false,
      facts: { table: 'Orders', inputRows: ROW_SHORTFALL_MINIMUM, expectedRows: count },
    });
    expect(kinds(at.input, at.expected.slice(0, count + 1), at.format)).not.toContain('row-shortfall');
    const below = plain(ROW_SHORTFALL_MINIMUM - 1);
    expect(kinds(below.input, below.expected.slice(0, 1), below.format)).not.toContain('row-shortfall');
    at.input.source.sheets!.unshift({
      name: 'Small',
      hidden: false,
      rows: [
        ['ID', 'Product', 'Amount', 'Date'],
        ['X', 'Small', '1', '2026-03-01'],
      ].map((row) => row.map(cell)),
    });
    expect(
      checkPair(at.input, [], at.format, []).find((finding) => finding.kind === 'row-shortfall'),
    ).toMatchObject({ facts: { table: 'Orders' }, blocks: false });
  });

  it('lists absent required values by field, groups repeated values, and ignores optional values', () => {
    const pair = generated();
    pair.expected[0]!.values.product = 'Absent';
    pair.expected[2]!.values.product = 'Absent';
    expect(
      checkPair(pair.input, pair.expected, pair.format, []).find(
        (finding) => finding.kind === 'absent-value',
      ),
    ).toEqual({
      kind: 'absent-value',
      messageId: 'ingest.pairs.absentValue',
      blocks: false,
      facts: { field: 'product', values: [{ value: 'Absent', rows: [1, 3] }] },
    });
    pair.format.fields = pair.format.fields.map((field) => ({ ...field, required: false }));
    expect(kinds(pair.input, pair.expected, pair.format)).not.toContain('absent-value');
  });

  it.each([
    ['(12.50)', '-12.5'],
    ['(1,200.50)', '-1200.5'],
    ['(1.200,50)', '-1200.5'],
    ['(12.50e2)', '-1250'],
  ])('preserves the accounting sign in page text %s', (written, expectedAmount) => {
    const source: ExtractedSource = {
      kind: 'pdf',
      name: 'adjustment.pdf',
      warnings: [],
      pages: [{ number: 1, textQuality: 'clean', text: `Adjustment: ${written}.` }],
    };
    const format: PairOutputFormat = {
      identity: null,
      rowMeaning: '',
      fields: [{ key: 'amount', meaning: '', required: true }],
    };
    const input = { source, sha256: 'a' };
    expect(kinds(input, [{ values: { amount: expectedAmount } }], format)).not.toContain('absent-value');
    expect(kinds(input, [{ values: { amount: expectedAmount.slice(1) } }], format)).toContain('absent-value');
    source.pages![0]!.text = `Adjustment: ${written.slice(1, -1)}.`;
    expect(kinds(input, [{ values: { amount: expectedAmount } }], format)).toContain('absent-value');
  });

  it('finds minute-precision timestamps in page text as exact instants', () => {
    const source: ExtractedSource = {
      kind: 'pdf',
      name: 'event.pdf',
      warnings: [],
      pages: [{ number: 1, textQuality: 'clean', text: 'Received at 2026-03-01T01:00-08:00.' }],
    };
    const format: PairOutputFormat = {
      identity: null,
      rowMeaning: '',
      fields: [{ key: 'instant', meaning: '', required: true }],
    };
    const input = { source, sha256: 'a' };
    expect(kinds(input, [{ values: { instant: '2026-03-01T09:00:00Z' } }], format)).not.toContain(
      'absent-value',
    );
    expect(
      kinds(input, [{ values: { instant: '2026-03-01T09:00:00.000000000000000001Z' } }], format),
    ).toContain('absent-value');
  });

  it.each(['workbook', 'email'] as const)(
    'counts every headerless %s record for shortfall and summary checks',
    (kind) => {
      const rows = Array.from({ length: ROW_SHORTFALL_MINIMUM }, (_, index) => [
        `Record ${index + 1}`,
        String(index + 1),
      ]);
      const source: ExtractedSource = { kind, name: 'records', warnings: [] };
      if (kind === 'workbook')
        source.sheets = [{ name: 'Data', hidden: false, rows: rows.map((row) => row.map(cell)) }];
      else source.email = { from: '', subject: '', date: '', messageId: '', bodyText: '', tables: [rows] };
      const format: PairOutputFormat = {
        identity: null,
        rowMeaning: '',
        fields: ['label', 'amount'].map((key) => ({ key, meaning: '', required: false })),
      };
      const input = { source, sha256: 'a' };
      const expected = [{ values: { label: 'Record 1', amount: '1' } }];
      expect(
        checkPair(input, expected, format, []).find((finding) => finding.kind === 'row-shortfall'),
      ).toMatchObject({ facts: { inputRows: ROW_SHORTFALL_MINIMUM, expectedRows: 1 } });
      if (source.sheets) source.sheets[0]!.rows = source.sheets[0]!.rows.slice(0, SUMMARY_MIN_DATA_ROWS);
      else source.email!.tables[0] = rows.slice(0, SUMMARY_MIN_DATA_ROWS);
      expect(kinds(input, expected, format)).not.toContain('row-shortfall');
      expect(kinds(input, [{ values: { label: 'Summary', amount: '6' } }], format)).toContain('summary');
      expect(kinds(input, [{ values: { label: 'Summary', amount: '5' } }], format)).not.toContain('summary');
      if (source.sheets) source.sheets[0]!.rows.pop();
      else source.email!.tables[0]!.pop();
      expect(kinds(input, [{ values: { label: 'Summary', amount: '3' } }], format)).not.toContain('summary');
    },
  );

  it('retains the first headerless record when every value is text', () => {
    const source: ExtractedSource = {
      kind: 'workbook',
      name: 'names.xlsx',
      warnings: [],
      sheets: [
        {
          name: 'Names',
          hidden: false,
          rows: Array.from({ length: ROW_SHORTFALL_MINIMUM }, (_, index) => [
            cell(`Person ${index}`),
            cell('Cedar'),
          ]),
        },
      ],
    };
    const format: PairOutputFormat = {
      identity: null,
      rowMeaning: '',
      fields: ['person', 'company'].map((key) => ({ key, meaning: '', required: false })),
    };
    const input = { source, sha256: 'a' };
    const expected = [{ values: { person: 'Person 0', company: 'Cedar' } }];
    expect(
      checkPair(input, expected, format, []).find((finding) => finding.kind === 'row-shortfall'),
    ).toMatchObject({ facts: { inputRows: ROW_SHORTFALL_MINIMUM } });
    source.sheets![0]!.rows.pop();
    expect(kinds(input, expected, format)).not.toContain('row-shortfall');
  });

  it.each([ABSENT_VALUE_LIMIT - 1, ABSENT_VALUE_LIMIT, ABSENT_VALUE_LIMIT + 1])(
    'caps %s distinct absent values at the named limit',
    (count) => {
      const pair = generated(count);
      pair.expected.forEach((row, index) => {
        row.values.product = `missing-${index}`;
      });
      const absent = checkPair(pair.input, pair.expected, pair.format, []).filter(
        (finding) => finding.kind === 'absent-value',
      );
      expect(absent.flatMap((finding) => finding.facts.values)).toHaveLength(
        Math.min(count, ABSENT_VALUE_LIMIT),
      );
    },
  );

  it('shares the ten-value limit across fields and returns deterministic, serializable findings', () => {
    const pair = generated(6);
    pair.expected.forEach((row, index) => {
      row.values.product = `missing-product-${index}`;
      row.values.department = `missing-department-${index}`;
    });
    const result = checkPair(pair.input, pair.expected, pair.format, []);
    expect(
      result
        .filter((finding) => finding.kind === 'absent-value')
        .map((finding) => [finding.facts.field, finding.facts.values.length]),
    ).toEqual([
      ['department', 6],
      ['product', 4],
    ]);
    expect(
      checkPair(pair.input, pair.expected, { ...pair.format, fields: [...pair.format.fields].reverse() }, []),
    ).toEqual(result);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('finds normalized values in cells and page text, with case-sensitive text', () => {
    const source: ExtractedSource = {
      kind: 'pdf',
      name: 'facts.pdf',
      warnings: [],
      pages: [
        {
          number: 1,
          textQuality: 'clean',
          text: 'Cafe\u0301 owes 1.200,50 on 03/01/2026 at 2026-03-01T01:00:00-08:00.',
        },
      ],
    };
    const expected = [
      { values: { name: ' Café ', amount: '1200.500', date: '2026-03-01', instant: '2026-03-01T09:00:00Z' } },
    ];
    const format: PairOutputFormat = {
      identity: null,
      rowMeaning: '',
      fields: Object.keys(expected[0]!.values).map((key) => ({ key, meaning: '', required: true })),
    };
    expect(checkPair({ source, sha256: 'a' }, expected, format, [])).toEqual([]);
    expected[0]!.values.name = 'café';
    expect(kinds({ source, sha256: 'a' }, expected, format)).toContain('absent-value');
    source.pages = [];
    source.sheets = [
      {
        name: 'Values',
        hidden: false,
        rows: [['Café', '1,200.50', '2026/3/1', '2026-03-01T01:00:00-08:00', 'Additional input']].map((row) =>
          row.map(cell),
        ),
      },
    ];
    expected[0]!.values.name = 'Café';
    expect(checkPair({ source, sha256: 'a' }, expected, format, [])).toEqual([]);
  });

  it('warns on one or two exact total rows and stays silent above the summary limit or below the data minimum', () => {
    const pair = plain(SUMMARY_MIN_DATA_ROWS);
    const amount = pair.expected.reduce((sum, row) => addDecimals(sum, String(row.values.amount)), '0');
    const summary = { values: { id: 'Summary', product: 'Summary', amount, date: null } };
    for (let size = 1; size <= SUMMARY_MAX_ROWS; size++)
      expect(
        checkPair(
          pair.input,
          Array.from({ length: size }, () => summary),
          pair.format,
          [],
        ).find((finding) => finding.kind === 'summary'),
      ).toMatchObject({ blocks: false, facts: { fields: ['amount'], expectedRows: size } });
    expect(
      kinds(
        pair.input,
        Array.from({ length: SUMMARY_MAX_ROWS + 1 }, () => summary),
        pair.format,
      ),
    ).not.toContain('summary');
    expect(
      kinds(
        pair.input,
        [{ values: { ...summary.values, amount: addDecimals(amount, '0.01') } }],
        pair.format,
      ),
    ).not.toContain('summary');
    const below = plain(SUMMARY_MIN_DATA_ROWS - 1);
    const smaller = below.expected.reduce((sum, row) => addDecimals(sum, String(row.values.amount)), '0');
    expect(
      kinds(below.input, [{ values: { ...summary.values, amount: smaller } }], below.format),
    ).not.toContain('summary');
  });

  it('requires the named number of numeric contributors and excludes explicit total rows', () => {
    const source: ExtractedSource = {
      kind: 'workbook',
      name: 'totals.xlsx',
      warnings: [],
      sheets: [
        {
          name: 'Data',
          hidden: false,
          rows: [
            ['label', 'amount'],
            ['a', '0.10'],
            ['b', '0.20'],
            ['c', 'none'],
            ['Total', '0.30'],
          ].map((row) => row.map(cell)),
        },
      ],
    };
    const format: PairOutputFormat = {
      identity: null,
      rowMeaning: '',
      fields: ['label', 'amount'].map((key) => ({ key, meaning: '', required: false })),
    };
    expect(SUMMARY_MIN_NUMERIC_CELLS).toBe(2);
    expect(
      kinds({ source, sha256: 'a' }, [{ values: { label: 'Summary', amount: '0.30' } }], format),
    ).toContain('summary');
    source.sheets![0]!.rows[2]![1] = cell('none');
    expect(
      kinds({ source, sha256: 'a' }, [{ values: { label: 'Summary', amount: '0.10' } }], format),
    ).not.toContain('summary');
  });

  it('counts email and document tables as well as workbook sheets', () => {
    const pair = plain(ROW_SHORTFALL_MINIMUM);
    const grid = pair.input.source
      .sheets![0]!.rows.slice(3)
      .map((row) => row.map((item) => String(item.v ?? '')));
    const email: ExtractedSource = {
      kind: 'email',
      name: 'table.eml',
      warnings: [],
      email: { from: '', subject: '', date: '', messageId: '', bodyText: '', tables: [grid] },
    };
    expect(kinds({ source: email, sha256: 'a' }, pair.expected.slice(0, 1), pair.format)).toContain(
      'row-shortfall',
    );
    const document: ExtractedSource = {
      kind: 'pdf',
      name: 'table.pdf',
      warnings: [],
      pages: [{ number: 1, textQuality: 'clean', text: grid.map((row) => row.join('  ')).join('\n') }],
    };
    expect(kinds({ source: document, sha256: 'a' }, pair.expected.slice(0, 1), pair.format)).toContain(
      'row-shortfall',
    );
  });

  it('estimates a large extracted table without exceeding the host argument limit', () => {
    const source: ExtractedSource = {
      kind: 'workbook',
      name: 'large.xlsx',
      warnings: [],
      sheets: [
        { name: 'Data', hidden: false, rows: [[cell('value')], ...Array<Cell[]>(200000).fill([cell(true)])] },
      ],
    };
    const format: PairOutputFormat = {
      identity: null,
      rowMeaning: '',
      fields: [{ key: 'value', meaning: '', required: true }],
    };
    expect(checkPair({ source, sha256: 'a' }, [{ values: { value: true } }], format, [])).toEqual([
      {
        kind: 'row-shortfall',
        messageId: 'ingest.pairs.rowShortfall',
        blocks: false,
        facts: { table: 'Data', inputRows: 200000, expectedRows: 1 },
      },
    ]);
  });
});
