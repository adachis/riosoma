import { describe, expect, it } from 'vitest';
import type { CellValue, FieldMeta, FieldSpec } from '@riosoma/contracts';
import { buildView, inferFilter, inferSorts, type RecordSnapshot } from './views.js';

function meta(id: string, name: string, spec: FieldSpec): FieldMeta {
  return {
    ...spec,
    id,
    tableId: 'tblT000000000000',
    name,
    description: '',
    position: 0,
    createdAt: '',
    updatedAt: '',
  };
}

const status = meta('fldStatus0000000', 'Status', {
  type: 'singleSelect',
  options: {
    choices: [
      { id: 'choTodo000000000', name: 'Todo', color: 'blue' },
      { id: 'choDoing00000000', name: 'Doing', color: 'teal' },
    ],
  },
});
const name = meta('fldName000000000', 'Name', { type: 'text', options: {} });
const budget = meta('fldBudget0000000', 'Budget', {
  type: 'currency',
  options: { code: 'USD', precision: 2, allowNegative: true },
});
const done = meta('fldDone000000000', 'Done', { type: 'checkbox', options: { color: 'green' } });
const start = meta('fldStart00000000', 'Start', {
  type: 'date',
  options: { includeTime: false, dateFormat: 'local', timeFormat: 'local', timeZone: 'client' },
});
const files = meta('fldFiles00000000', 'Files', { type: 'attachment', options: {} });
const formula = meta('fldFormula000000', 'Formula', {
  type: 'formula',
  options: {
    expression: '1',
    resultType: 'number',
    precision: null,
    dateFormat: 'local',
    timeFormat: 'local',
    timeZone: 'client',
    sortable: true,
  },
});
const fields = [name, status, budget, done, start, files, formula];

function snapshot(rows: Array<[string, Record<string, CellValue>]>): RecordSnapshot {
  return { order: rows.map(([id]) => id), values: new Map(rows) };
}

const records = snapshot([
  ['recA', { [name.id]: 'Website', [status.id]: 'choDoing00000000', [budget.id]: 800, [done.id]: true }],
  ['recB', { [name.id]: 'App', [status.id]: 'choTodo000000000', [budget.id]: 300 }],
  [
    'recC',
    { [name.id]: 'Docs', [status.id]: 'choDoing00000000', [budget.id]: 1200.5, [start.id]: '2026-03-01' },
  ],
]);

describe('working out a view’s filter', () => {
  it('finds a single condition that picks exactly the records the view shows', () => {
    expect(inferFilter(records, ['recA', 'recC'], fields)).toEqual({
      conjunction: 'and',
      conditions: [{ id: 'imported', fieldId: status.id, operator: 'is', value: 'choDoing00000000' }],
    });
    expect(inferFilter(records, ['recA'], fields)).toMatchObject({
      conditions: [{ fieldId: name.id, operator: 'is', value: 'Website' }],
    });
    expect(inferFilter(records, ['recB', 'recC'], [status, budget, done])).toMatchObject({
      conditions: [{ fieldId: done.id, operator: 'is', value: false }],
    });
    expect(inferFilter(records, ['recC'], [start])).toMatchObject({
      conditions: [{ fieldId: start.id, operator: 'isNotEmpty' }],
    });
  });

  it('needs no filter for a view that shows everything, and gives up when nothing explains it', () => {
    expect(inferFilter(records, ['recC', 'recA', 'recB'], fields)).toBe('none');
    expect(inferFilter(records, ['recA', 'recB'], [status, budget, files, formula])).toBeNull();
  });
});

describe('working out a view’s sort', () => {
  it('finds the field that orders the records the view’s way', () => {
    expect(inferSorts(records, ['recC', 'recA', 'recB'], [status, budget])).toEqual([
      { fieldId: budget.id, direction: 'desc' },
    ]);
    expect(inferSorts(records, ['recB', 'recC', 'recA'], [name])).toEqual([
      { fieldId: name.id, direction: 'asc' },
    ]);
  });

  it('breaks ties with a second field when the order needs one', () => {
    // Both Doing records come first, the one not done yet ahead.
    expect(inferSorts(records, ['recC', 'recA', 'recB'], [status, done, start])).toEqual([
      { fieldId: status.id, direction: 'desc' },
      { fieldId: done.id, direction: 'asc' },
    ]);
  });

  it('sets aside empty values, which Airtable may put first', () => {
    const sparse = snapshot([
      ['recA', { [budget.id]: 5 }],
      ['recB', {}],
      ['recC', { [budget.id]: 1 }],
      ['recD', { [budget.id]: 3 }],
    ]);
    expect(inferSorts(sparse, ['recB', 'recC', 'recD', 'recA'], [budget])).toEqual([
      { fieldId: budget.id, direction: 'asc' },
    ]);
  });

  it('needs no sort for records in the order they were added, and gives up when nothing explains the order', () => {
    expect(inferSorts(records, ['recA', 'recC'], fields)).toBe('none');
    expect(inferSorts(records, ['recC', 'recB', 'recA'], [done, files])).toBeNull();
  });
});

describe('building views', () => {
  const base = {
    fields,
    primaryFieldId: name.id,
    fieldId: (id: string) => ({ fldAirName: name.id, fldAirStatus: status.id, fldAirBudget: budget.id })[id],
    extra: new Set([files.id]),
  };

  it('keeps a grid’s fields, their order, and what it hides', () => {
    const grid = buildView({
      ...base,
      source: { id: 'viwGrid', name: 'Grid', type: 'grid', visibleFieldIds: ['fldAirBudget', 'fldAirName'] },
    });
    expect(grid.type).toBe('grid');
    expect(grid.config.fieldOrder?.slice(0, 2)).toEqual([budget.id, name.id]);
    expect(grid.config.hiddenFieldIds).toEqual([status.id, done.id, start.id, files.id, formula.id]);
    expect(grid.notes).toEqual([]);
  });

  it('stacks a kanban, dates a calendar, covers a gallery, and asks a form every question it can', () => {
    const kanban = buildView({ ...base, source: { id: 'viwK', name: 'Board', type: 'kanban' } });
    expect(kanban.config.kanban?.stackFieldId).toBe(status.id);
    expect(kanban.notes.map((note) => note.key)).toEqual([
      'import.airtable.report.viewFields',
      'import.airtable.report.viewStack',
    ]);
    const calendar = buildView({ ...base, source: { id: 'viwC', name: 'Calendar', type: 'calendar' } });
    expect(calendar.config.calendar?.startFieldId).toBe(start.id);
    const gallery = buildView({
      ...base,
      extra: new Set(),
      source: { id: 'viwG', name: 'Pictures', type: 'gallery' },
    });
    expect(gallery.config.gallery?.coverFieldId).toBe(files.id);
    const form = buildView({ ...base, source: { id: 'viwF', name: 'Intake', type: 'form' } });
    expect(form.config.form?.title).toBe('Intake');
    expect(form.config.form?.questions.map((question) => question.fieldId)).toEqual([
      name.id,
      status.id,
      budget.id,
      done.id,
      start.id,
    ]);
  });

  it('works filters and sorts out from the records a view shows, and says so', () => {
    const doing = buildView({
      ...base,
      source: { id: 'viwD', name: 'Doing', type: 'grid' },
      records,
      shown: ['recC', 'recA'],
    });
    expect(doing.config.filter?.conditions).toEqual([
      { id: 'imported', fieldId: status.id, operator: 'is', value: 'choDoing00000000' },
    ]);
    expect(doing.config.sorts).toEqual([{ fieldId: name.id, direction: 'asc' }]);
    expect(doing.notes.map((note) => `${note.status}:${note.key}`)).toEqual([
      'changed:import.airtable.report.viewFilter',
      'changed:import.airtable.report.viewSort',
    ]);
  });

  it('leaves out views Riosoma has no match for', () => {
    expect(buildView({ ...base, source: { id: 'viwB', name: 'Chart', type: 'block' } })).toEqual({
      type: null,
      config: {},
      notes: [
        { status: 'omitted', key: 'import.airtable.report.viewUnsupported', params: { type: 'block' } },
      ],
    });
  });
});
