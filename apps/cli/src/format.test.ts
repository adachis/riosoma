import { describe, expect, it } from 'vitest';
import { cellText, counted, renderHeader, renderRow, renderRule, renderTable, widthsOf } from './format.js';
import type { Column } from './format.js';

/**
 * How an answer looks.  A person reads a table at a terminal and a script reads JSON, and the table
 * has to line up whether a value is a name, a number, or a file that would otherwise run off the
 * screen, so widths come from what's in the rows and anything longer is clipped.
 */

const COLUMNS: Column[] = [
  { name: 'name', header: 'Name' },
  { name: 'amount', header: 'Amount', align: 'right' },
  { name: 'id', header: 'ID' },
];

describe('a table', () => {
  it('lines its columns up under their headings', () => {
    const rows = [
      { name: 'Ada', amount: 10, id: 'rec1' },
      { name: 'Grace Hopper', amount: 1234, id: 'rec2' },
    ];
    const widths = widthsOf(rows, COLUMNS);
    const printed = [
      renderHeader(COLUMNS, widths),
      renderRule(widths),
      ...rows.map((row) => renderRow(COLUMNS, widths, row)),
    ];
    expect(printed[0]).toBe('Name          Amount  ID');
    expect(printed[1]).toBe('------------  ------  ----');
    expect(printed[2]).toBe('Ada               10  rec1');
    expect(printed[3]).toBe('Grace Hopper    1234  rec2');
    // The rule and every row line up, which is what makes it a table rather than a list.  A
    // heading shorter than its column is trimmed, so it can be shorter than the rule under it.
    expect(new Set([printed[1]!, printed[2]!, printed[3]!].map((line) => line.length)).size).toBe(1);
    expect(printed[0]!.length).toBeLessThanOrEqual(printed[1]!.length);
  });

  it('says there’s nothing to show, rather than showing headings alone', () => {
    expect(renderTable([], COLUMNS)).toBe('Nothing to show.');
    expect(renderTable([], [])).toBe('');
  });

  it('clips a value too long for its column, and folds a line break into a space', () => {
    const rows = [{ name: 'x'.repeat(80), amount: 1, id: 'a\nb' }];
    const printed = renderTable(rows, COLUMNS);
    expect(printed).toContain(`${'x'.repeat(59)}…`);
    expect(printed).toContain('a b');
    expect(printed.split('\n')[2]!.length).toBeLessThanOrEqual(60 + 6 + 4 + 4);
  });

  it('writes a value as text, whatever it holds', () => {
    expect(cellText(null)).toBe('');
    expect(cellText(undefined)).toBe('');
    expect(cellText('plain')).toBe('plain');
    expect(cellText(12.5)).toBe('12.5');
    expect(cellText(true)).toBe('true');
    expect(cellText({ id: 'att1', filename: 'a.txt' })).toBe('{"id":"att1","filename":"a.txt"}');
    expect(cellText(['one', 'two'])).toBe('["one","two"]');
    expect(cellText(new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02T03:04:05.000Z');
  });

  it('counts in the English a summary reads as', () => {
    expect(counted(1, 'record')).toBe('1 record');
    expect(counted(2, 'record')).toBe('2 records');
    expect(counted(0, 'request')).toBe('0 requests');
    expect(counted(1, 'entry', 'entries')).toBe('1 entry');
  });
});
