import { CHOICE_COLORS, Command, FieldMeta, isId, newId, type RowData } from '@riosoma/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { ParseContext } from '../parse';
import { pasteCommands } from './commands';
import { copyCells } from './copy';
import { planPaste, type PasteInput } from './plan';
import { readClipboard } from './read';
import { writeClipboard } from './write';

const tableId = 'tbl00000000000001';
const field = (type: string, options = {}, id = newId('field')): FieldMeta =>
  FieldMeta.parse({
    id,
    tableId,
    type,
    options,
    name: 'F',
    description: '',
    position: 0,
    createdAt: '2026-09-27T00:00:00.000Z',
    updatedAt: '2026-09-27T00:00:00.000Z',
  });
const context = (locale = 'en-US'): ParseContext => ({ locale, timeZone: 'UTC', collaborators: new Map() });
const recordId = (index: number) => `rec${String(index).padStart(14, '0')}`;
const input = (overrides: Partial<PasteInput> = {}): PasteInput => ({
  cells: [['value']],
  start: { row: 0, col: 0 },
  selection: { rows: 1, cols: 1 },
  fields: [field('text')],
  rowCount: 10,
  rowIdAt: recordId,
  context: context(),
  ...overrides,
});

describe('readClipboard', () => {
  it('prefers an Excel table, preserves merged columns and rows, and ignores styling', () => {
    const html = `<html><body>
      <!--StartFragment--><table style="border-collapse:collapse">
      <tr><th colspan="2" style="font-weight:bold">Quarter &amp; year</th><th>Notes</th></tr>
      <tr><td rowspan="2" style="mso-number-format:General">North</td><td>12</td><td>one<br>two</td></tr>
      <tr><td>14</td><td><span style="color:red">final</span></td></tr>
      </table><!--EndFragment--></body></html>`;
    expect(readClipboard({ text: 'fallback', html })).toEqual([
      ['Quarter & year', '', 'Notes'],
      ['North', '12', 'one\ntwo'],
      ['', '14', 'final'],
    ]);
  });

  it('reads a styled Sheets fragment with line breaks and a merged cell', () => {
    const html = `<meta charset="utf-8"><table><tbody>
      <tr><td style="white-space:pre-wrap"><b>  Alpha  </b><br>Beta</td><td colspan="2">3</td></tr>
      <tr><td>Delta</td><td style="background:#eee">&lt;tag&gt;</td><td>Last</td></tr>
      </tbody></table>`;
    expect(readClipboard({ text: '', html })).toEqual([
      ['  Alpha  \nBeta', '3', ''],
      ['Delta', '<tag>', 'Last'],
    ]);
  });

  it('limits zero rowspans to their row group and pads shorter rows', () => {
    const html = `<table><tbody><tr><td rowspan="0" colspan="2">A</td><td>B</td></tr>
      <tr><td>C</td></tr></tbody><tbody><tr><td>D</td></tr></tbody></table>`;
    expect(readClipboard({ text: '', html })).toEqual([
      ['A', '', 'B'],
      ['', '', 'C'],
      ['D', '', ''],
    ]);
  });

  it('does not treat nested table rows as additional clipboard rows', () => {
    expect(
      readClipboard({
        text: '',
        html: '<table><tr><td><table><tr><td>A</td></tr></table></td><td>B</td></tr></table>',
      }),
    ).toEqual([['A', 'B']]);
  });

  it('falls back to text when HTML has no table', () => {
    expect(readClipboard({ text: 'a\tb\r\nc\td\r\n', html: '<p>unrelated</p>' })).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('reads quoted tabs, newlines, doubled quotes, and a final terminator', () => {
    expect(readClipboard({ text: '"one\ttwo"\t"line 1\r\nline 2"\t"say ""yes"""\r\nlast\t\t\n' })).toEqual([
      ['one\ttwo', 'line 1\r\nline 2', 'say "yes"'],
      ['last', '', ''],
    ]);
  });

  it.each([
    ['', [['']]],
    ['\n', [['']]],
    ['\n\n', [[''], ['']]],
    ['a\t', [['a', '']]],
    ['""\t""', [['', '']]],
    ['literal"quote\tvalue', [['literal"quote', 'value']]],
    ['a\rb\r', [['a'], ['b']]],
  ] as const)('handles empty cells and row boundaries in %j', (text, expected) => {
    expect(readClipboard({ text })).toEqual(expected);
  });
});

describe('writeClipboard', () => {
  it('quotes TSV and escapes HTML without treating cell text as markup', () => {
    const result = writeClipboard([['a\tb', '"quoted"', '<img src=x onerror="bad()"> & \'x\'', 'one\ntwo']]);
    expect(result.text).toBe('"a\tb"\t"""quoted"""\t"<img src=x onerror=""bad()""> & \'x\'"\t"one\ntwo"\r\n');
    expect(result.html).toContain('&lt;img src=x onerror=&quot;bad()&quot;&gt; &amp; &#39;x&#39;');
    expect(result.html).toContain('<td>one<br>two</td>');
    expect(result.html).not.toContain('<img');
  });

  it.each([
    [
      ['plain', 'two'],
      ['three', 'four'],
    ],
    [
      ['a\tb', 'say "yes"'],
      ['one\ntwo', 'one\r\ntwo'],
    ],
    [
      ['', ''],
      ['', ''],
    ],
    [['last'], ['']],
    [['<b>&</b>', '  padded  ', '🦋']],
  ])('round-trips through both clipboard formats: %j', (...cells) => {
    const clipboard = writeClipboard(cells);
    expect(readClipboard(clipboard)).toEqual(cells);
    expect(readClipboard({ text: clipboard.text })).toEqual(cells);
  });

  it('writes an empty selection as an empty table', () => {
    expect(readClipboard(writeClipboard([]))).toEqual([]);
  });
});

describe('planPaste', () => {
  it('fills a 3 by 4 selection with one value starting at its target', () => {
    const fields = Array.from({ length: 5 }, () => field('text'));
    const rowIdAt = vi.fn(recordId);
    const plan = planPaste(
      input({ fields, start: { row: 2, col: 1 }, selection: { rows: 3, cols: 4 }, rowIdAt }),
    );
    expect(plan.cellCount).toBe(12);
    expect(plan.updates).toEqual(
      [2, 3, 4].map((row) => ({
        id: recordId(row),
        values: Object.fromEntries(fields.slice(1).map((f) => [f.id, 'value'])),
      })),
    );
    expect(rowIdAt.mock.calls).toEqual([[2], [3], [4]]);
  });

  it.each([4, 3])('tiles a 2 by 2 block only when a square selection of size %i is divisible', (size) => {
    const fields = Array.from({ length: 4 }, () => field('text'));
    const plan = planPaste(
      input({
        fields,
        cells: [
          ['a', 'b'],
          ['c', 'd'],
        ],
        selection: { rows: size, cols: size },
      }),
    );
    const extent = size === 4 ? 4 : 2;
    expect(plan.cellCount).toBe(extent * extent);
    expect(plan.updates.map((row) => fields.slice(0, extent).map((f) => row.values[f.id]))).toEqual(
      size === 4
        ? [
            ['a', 'b', 'a', 'b'],
            ['c', 'd', 'c', 'd'],
            ['a', 'b', 'a', 'b'],
            ['c', 'd', 'c', 'd'],
          ]
        : [
            ['a', 'b'],
            ['c', 'd'],
          ],
    );
  });

  it('pastes a block once when either selection dimension is smaller', () => {
    const fields = Array.from({ length: 4 }, () => field('text'));
    const plan = planPaste(
      input({
        fields,
        cells: [
          ['a', 'b'],
          ['c', 'd'],
        ],
        selection: { rows: 1, cols: 4 },
      }),
    );
    expect(plan.updates).toHaveLength(2);
    expect(plan.cellCount).toBe(4);
  });

  it('creates rows beyond the end and preserves their IDs on a second pass', () => {
    const data = input({ rowCount: 2, start: { row: 1, col: 0 }, cells: [['a'], ['b'], ['c']] });
    const plan = planPaste(data);
    expect(plan.updates.map((row) => row.id)).toEqual([recordId(1)]);
    expect(plan.creates.map((row) => row.values)).toEqual([
      { [data.fields[0]!.id]: 'b' },
      { [data.fields[0]!.id]: 'c' },
    ]);
    expect(plan.creates.every((row) => isId(row.id, 'record'))).toBe(true);
    expect(new Set(plan.creates.map((row) => row.id)).size).toBe(2);
    expect(plan.replan(new Map()).creates).toEqual(plan.creates);
  });

  it('clips columns and counts extra columns once across all rows', () => {
    const plan = planPaste(
      input({
        fields: [field('text'), field('text')],
        start: { row: 0, col: 1 },
        cells: [
          ['a', 'b', 'c'],
          ['d', 'e', 'f'],
        ],
      }),
    );
    expect(plan.extraColumns).toBe(2);
    expect(plan.cellCount).toBe(2);
    expect(plan.updates).toHaveLength(2);
    expect(plan.updates.map((row) => Object.values(row.values))).toEqual([['a'], ['d']]);
  });

  it('clips a tiled selection after computing its extent', () => {
    const plan = planPaste(input({ selection: { rows: 3, cols: 4 } }));
    expect(plan.extraColumns).toBe(3);
    expect(plan.updates).toHaveLength(3);
    expect(plan.cellCount).toBe(3);
  });

  it('reads German numbers and locale-specific date order', () => {
    const number = field('number');
    expect(
      planPaste(input({ fields: [number], cells: [['1.234,5']], context: context('de') })).updates[0]!.values[
        number.id
      ],
    ).toBe(1234.5);
    const date = field('date');
    for (const [locale, expected] of [
      ['en-US', '2026-03-04'],
      ['en-GB', '2026-04-03'],
    ]) {
      expect(
        planPaste(input({ fields: [date], cells: [['03/04/2026']], context: context(locale) })).updates[0]!
          .values[date.id],
      ).toBe(expected);
    }
  });

  it('reports unreadable cells at destination coordinates without clearing their values', () => {
    const fields = [field('text'), field('number'), field('date'), field('text')];
    const plan = planPaste(input({ fields, start: { row: 3, col: 1 }, cells: [['oops', 'never', 'valid']] }));
    expect(plan.problems).toEqual([
      { row: 3, col: 1, text: 'oops', reason: 'notNumber' },
      { row: 3, col: 2, text: 'never', reason: 'notDate' },
    ]);
    expect(plan.updates).toEqual([{ id: recordId(3), values: { [fields[3]!.id]: 'valid' } }]);
    expect(plan.cellCount).toBe(3);
  });

  it('skips all computed field types and omits empty update commands', () => {
    const fields = ['createdTime', 'lastModifiedTime', 'createdBy', 'lastModifiedBy', 'recordId'].map(
      (type) => field(type),
    );
    const plan = planPaste(input({ fields, selection: { rows: 2, cols: 5 } }));
    expect(plan.skippedComputed).toBe(10);
    expect(plan.updates).toEqual([]);
    expect(plan.problems).toEqual([]);
  });

  it('reports unknown pasted choices for source and cascade fields without schema changes', () => {
    for (const options of [
      { source: { tableId: newId('table') } },
      { cascade: { fieldId: newId('field'), mapping: {} } },
    ]) {
      const selected = field('singleSelect', options);
      const plan = planPaste(input({ fields: [selected], cells: [['Unknown']] }));
      expect(plan.problems).toHaveLength(1);
      expect(plan.newChoices.size).toBe(0);
      expect(pasteCommands(plan, tableId, new Map([[selected.id, selected]])).optionCommands).toEqual([]);
    }
  });

  it('deduplicates missing choice names per field using locale-aware case matching', () => {
    const fields = [field('singleSelect'), field('multipleSelect')];
    const plan = planPaste(
      input({
        fields,
        cells: [
          [' New ', 'New, Other, new'],
          ['new', 'other\nThird'],
        ],
      }),
    );
    expect(plan.newChoices).toEqual(
      new Map([
        [fields[0]!.id, ['New']],
        [fields[1]!.id, ['New', 'Other', 'Third']],
      ]),
    );
    expect(plan.updates).toEqual([]);
    const turkish = planPaste(input({ fields: [fields[0]!], cells: [['I'], ['ı']], context: context('tr') }));
    expect(turkish.newChoices.get(fields[0]!.id)).toEqual(['I']);
  });

  it('pads ragged clipboard rows with blanks and parses intentional clears', () => {
    const fields = [field('text'), field('checkbox')];
    const plan = planPaste(input({ fields, cells: [['', 'yes'], []] }));
    expect(plan.updates.map((row) => row.values)).toEqual([
      { [fields[0]!.id]: null, [fields[1]!.id]: true },
      { [fields[0]!.id]: null, [fields[1]!.id]: false },
    ]);
  });

  it.each([{ cells: [] }, { cells: [[]] }])(
    'handles an empty clipboard block without records',
    ({ cells }) => {
      const plan = planPaste(input({ cells, rowCount: 0 }));
      expect(plan.cellCount).toBe(0);
      expect(plan.creates).toEqual([]);
    },
  );

  it('does not create records when the paste is entirely beyond visible columns', () => {
    const rowIdAt = vi.fn(recordId);
    const plan = planPaste(input({ start: { row: 0, col: 5 }, rowCount: 0, rowIdAt }));
    expect(plan.extraColumns).toBe(1);
    expect(plan.cellCount).toBe(0);
    expect(plan.creates).toEqual([]);
    expect(rowIdAt).not.toHaveBeenCalled();
  });
});

describe('pasteCommands', () => {
  it('appends choices first, then resolves both select types and new records without changing inputs', () => {
    const existing = { id: newId('choice'), name: 'Known', color: 'red' };
    const fields = [field('singleSelect'), field('multipleSelect', { choices: [existing] })];
    const cells = [
      ['New', 'Known, New, Other'],
      ['new', 'Other'],
    ];
    const data = input({ fields, cells, rowCount: 1 });
    const plan = planPaste(data);
    const result = pasteCommands(plan, tableId, new Map(fields.map((f) => [f.id, f])));
    expect(result.optionCommands).toHaveLength(2);
    const options = result.optionCommands.map((command) => {
      expect(command.kind).toBe('field.update');
      if (command.kind !== 'field.update') throw new Error();
      return FieldMeta.parse({ ...fields.find((f) => f.id === command.fieldId), options: command.options });
    });
    const single = options[0]!;
    const multiple = options[1]!;
    if (single.type !== 'singleSelect' || multiple.type !== 'multipleSelect') throw new Error();
    expect(single.options.choices.map((choice) => choice.name)).toEqual(['New']);
    expect(multiple.options.choices.map((choice) => choice.name)).toEqual(['Known', 'New', 'Other']);
    expect(multiple.options.choices[0]).toEqual(existing);
    expect(multiple.options.choices.map((choice) => choice.color)).toEqual(['red', 'orange', 'yellow']);
    expect(single.options.choices.every((choice) => isId(choice.id, 'choice'))).toBe(true);
    cells[0]![0] = 'changed after planning';
    const records = result.recordCommands();
    expect(records).toEqual([
      {
        kind: 'record.update',
        tableId,
        records: [
          {
            id: recordId(0),
            values: {
              [single.id]: single.options.choices[0]!.id,
              [multiple.id]: multiple.options.choices.map((choice) => choice.id),
            },
          },
        ],
      },
      {
        kind: 'record.create',
        tableId,
        records: [
          {
            id: plan.creates[0]!.id,
            values: {
              [single.id]: single.options.choices[0]!.id,
              [multiple.id]: [multiple.options.choices[2]!.id],
            },
          },
        ],
      },
    ]);
    expect(result.recordCommands()).toEqual(records);
    expect(fields[0]!.options).toEqual({ choices: [] });
    expect(fields[1]!.options).toEqual({ choices: [existing] });
    for (const command of [...result.optionCommands, ...records]) {
      expect(Command.safeParse({ ...command, id: newId('command'), groupId: newId('action') }).success).toBe(
        true,
      );
    }
  });

  it('cycles choice colors without gray', () => {
    const select = field('singleSelect');
    const data = input({
      fields: [select],
      cells: Array.from({ length: 20 }, (_, index) => [String(index)]),
    });
    const result = pasteCommands(planPaste(data), tableId, new Map([[select.id, select]]));
    const command = result.optionCommands[0]!;
    if (command.kind !== 'field.update') throw new Error();
    const updated = FieldMeta.parse({ ...select, options: command.options });
    if (updated.type !== 'singleSelect') throw new Error();
    const colors = CHOICE_COLORS.filter((color) => color !== 'gray');
    expect(updated.options.choices.map((choice) => choice.color)).toEqual(
      Array.from({ length: 20 }, (_, index) => colors[index % colors.length]),
    );
  });

  it.each([10_000, 0])('chunks 10,000 pasted rows with %i existing rows', (rowCount) => {
    const data = input({ rowCount, cells: Array.from({ length: 10_000 }, (_, index) => [String(index)]) });
    const result = pasteCommands(planPaste(data), tableId, new Map(data.fields.map((f) => [f.id, f])));
    expect(result.optionCommands).toEqual([]);
    const commands = result.recordCommands();
    expect(commands).toHaveLength(10);
    const values: unknown[] = [];
    for (const command of commands) {
      expect(command.kind).toBe(rowCount === 0 ? 'record.create' : 'record.update');
      if (command.kind !== 'record.create' && command.kind !== 'record.update') throw new Error();
      expect(command.records).toHaveLength(1_000);
      values.push(...command.records.map((row) => row.values[data.fields[0]!.id]));
    }
    expect(values).toEqual(data.cells.map((row) => row[0]));
  });

  it('emits a partial final chunk and no empty commands', () => {
    const data = input({ rowCount: 1_001, cells: Array.from({ length: 1_001 }, () => ['x']) });
    const commands = pasteCommands(planPaste(data), tableId, new Map()).recordCommands();
    expect(
      commands.map((command) => (command.kind === 'record.update' ? command.records.length : 0)),
    ).toEqual([1_000, 1]);
    expect(pasteCommands(planPaste(input({ cells: [] })), tableId, new Map()).recordCommands()).toEqual([]);
  });
});

describe('copyCells', () => {
  it('formats the selected visible fields, including computed metadata, in column order', () => {
    const fields = [
      field('text'),
      field('recordId'),
      field('number'),
      field('singleSelect', {
        choices: [{ id: 'cho00000000000001', name: 'Ready', color: 'green' }],
      }),
      field('createdBy'),
    ];
    const rows: RowData[] = [0, 1, 2].map((index) => ({
      id: recordId(index),
      values: { [fields[2]!.id]: 1234.5, [fields[3]!.id]: 'cho00000000000001' },
      createdAt: '2026-09-27T00:00:00.000Z',
      updatedAt: '2026-09-27T00:00:00.000Z',
      createdBy: 'usr00000000000001',
      updatedBy: null,
    }));
    const format = { ...context('de'), collaborators: new Map([['usr00000000000001', { name: 'Ada' }]]) };
    const rowAt = vi.fn((index: number) => rows[index]!);
    const cells = copyCells({ start: { row: 1, col: 1 }, end: { row: 2, col: 9 } }, fields, rowAt, format);
    expect(cells).toEqual([
      [recordId(1), '1.234,5', 'Ready', 'Ada'],
      [recordId(2), '1.234,5', 'Ready', 'Ada'],
    ]);
    expect(rowAt.mock.calls).toEqual([[1], [2]]);
    expect(readClipboard(writeClipboard(cells))).toEqual(cells);
  });
});
