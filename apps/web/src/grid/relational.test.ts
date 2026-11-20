import { i18n } from '@lingui/core';
import { FieldSpec, newId, type CellValue, type FieldMeta, type RowData } from '@riosoma/contracts';
import { describe, expect, it } from 'vitest';
import { FakeServer } from '../data/testing';
import { relationalFixture } from '../data/testing/relational';
import { createCellRenderer } from './cells/renderers';
import { gridColumns } from './cells/columns';
import { formatCell } from './format';

describe('relational cells', () => {
  it('draws links by name, repaints renamed pills, and falls back to unknown IDs', () => {
    const f = relationalFixture(new FakeServer());
    const linked = new Map([[f.recordIds[0]!, 'Alpha']]);
    const fieldsById = new Map(f.database.schema.fields.map((field) => [field.id, field]));
    const format = { locale: 'en-US', timeZone: 'UTC', collaborators: new Map(), fieldsById, linked };
    const render = createCellRenderer({ fieldsById, format, rowHeight: 'short' });
    const el = document.createElement('div');
    const row = f.database.rows(f.source.tableId).get(f.source.recordId(0))!;
    const draw = () =>
      render(el, {
        row,
        rowIndex: 0,
        column: { id: f.link.id, width: 180, edit: 'custom' },
        colIndex: 0,
        selected: false,
        active: false,
      });
    draw();
    expect([...el.querySelectorAll('.rio-choice-pill')].map((pill) => pill.textContent)).toEqual([
      'Alpha',
      f.recordIds[1],
    ]);
    linked.set(f.recordIds[0]!, 'Renamed');
    draw();
    expect(el.textContent).toContain('Renamed');
    expect(formatCell(f.link, f.recordIds.slice(0, 2), format)).toBe(`Renamed, ${f.recordIds[1]}`);
  });

  it('formats lookup targets, rollups, counts, and every formula result type and error', () => {
    i18n.load('en-US', {});
    i18n.activate('en-US');
    const f = relationalFixture(new FakeServer());
    const fieldsById = new Map(f.database.schema.fields.map((field) => [field.id, field]));
    const format = { locale: 'en-US', timeZone: 'UTC', collaborators: new Map(), fieldsById };
    const render = createCellRenderer({ fieldsById, format, rowHeight: 'short' });
    const el = document.createElement('div');
    const base = f.database.rows(f.source.tableId).get(f.source.recordId(0))!;
    function draw(field: FieldMeta, value: CellValue, errors?: RowData['errors']) {
      fieldsById.set(field.id, field);
      render(el, {
        row: { ...base, values: { [field.id]: value }, errors },
        rowIndex: 0,
        column: { id: field.id, width: 180, edit: 'none' },
        colIndex: 0,
        selected: false,
        active: false,
      });
      return el.textContent;
    }
    expect(draw(f.lookup, [1234.5, 2])).toBe('1,234.50, 2.00');
    expect(draw(f.rollup, 1234.5)).toBe('1,234.50');
    expect(draw(f.count, 1234)).toBe('1,234');
    for (const [resultType, value, expected] of [
      ['number', 1234.5, '1,234.50'],
      ['text', '<script>', '<script>'],
      ['date', '2026-09-27', '2026-09-27'],
      ['datetime', '2026-09-27T13:30:00Z', '2026-09-27 13:30'],
      ['array', [1, 'Text'], '1, Text'],
    ] as const) {
      const field = {
        ...f.formula,
        ...FieldSpec.parse({
          type: 'formula',
          options: { resultType, precision: 2, dateFormat: 'iso', timeFormat: '24h' },
        }),
      };
      expect(draw(field, Array.isArray(value) ? [...value] : (value as CellValue))).toBe(expected);
    }
    const boolean = {
      ...f.formula,
      ...FieldSpec.parse({ type: 'formula', options: { resultType: 'boolean' } }),
    };
    draw(boolean, true);
    expect(el.querySelector('[data-checked="true"]')).toBeTruthy();
    const checkboxLookup = {
      ...f.lookup,
      ...FieldSpec.parse({
        type: 'lookup',
        options: { linkFieldId: f.link.id, targetFieldId: f.done.id, resultType: 'boolean' },
      }),
    };
    draw(checkboxLookup, [true, false]);
    expect(
      [...el.querySelectorAll('.rio-cell-check')].map((check) => check.getAttribute('data-checked')),
    ).toEqual(['true', 'false']);
    expect(draw(f.formula, null, { [f.formula.id]: 'formula.runtime.divisionByZero' })).toBe('#ERROR');
    expect(el.firstElementChild?.classList.contains('rio-cell-value--error')).toBe(true);
    expect(el.firstElementChild?.getAttribute('title')).toBe('A number can’t be divided by zero.');
    expect(draw(f.formula, 2)).toBe('2');
    expect(el.querySelector('.rio-cell-value--error')).toBeNull();
    const choiceId = newId('choice');
    const target = {
      ...f.price,
      ...FieldSpec.parse({
        type: 'singleSelect',
        options: { choices: [{ id: choiceId, name: 'Ready', color: 'green' }] },
      }),
    };
    fieldsById.set(target.id, target);
    expect(draw(f.lookup, [choiceId])).toBe('Ready');
    expect(el.querySelector('.rio-choice-pill')?.getAttribute('data-color')).toBe('green');
    const columns = gridColumns(
      f.database.schema.views[0]!,
      f.database.schema.fields.filter((field) => field.tableId === f.source.tableId),
      f.source.textFieldId,
    );
    expect(columns.find((column) => column.id === f.link.id)?.edit).toBe('custom');
    for (const field of [f.lookup, f.rollup, f.count, f.formula])
      expect(columns.find((column) => column.id === field.id)?.edit).toBe('none');
  });
});
