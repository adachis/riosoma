import { describe, expect, it } from 'vitest';
import { GridConfig } from '@riosoma/contracts';
import {
  chosenFields,
  columnWidth,
  defaultOrientation,
  defaultPageSize,
  isPrintableViewType,
  pdfFileName,
  recordFieldChoices,
  viewFieldChoices,
} from './options';
import { allFields, fields, table } from './testing';

describe('paper for the reader', () => {
  it('uses Letter where Letter is the usual paper, and A4 everywhere else', () => {
    expect(defaultPageSize('en-US')).toBe('LETTER');
    expect(defaultPageSize('es')).toBe('A4');
    expect(defaultPageSize('fr')).toBe('A4');
    expect(defaultPageSize('ja')).toBe('A4');
    expect(defaultPageSize('pt-BR')).toBe('A4');
  });

  it('lets the browser’s own region decide for a language Riosoma offers without one', () => {
    expect(defaultPageSize('es', ['es-MX', 'es'])).toBe('LETTER');
    expect(defaultPageSize('fr', ['en-US', 'fr-CA'])).toBe('LETTER');
    expect(defaultPageSize('en-US', ['en-GB'])).toBe('A4');
    // A region for some other language says nothing about this one.
    expect(defaultPageSize('de', ['en-US'])).toBe('A4');
    expect(defaultPageSize('not a tag', ['nor this'])).toBe('A4');
  });

  it('starts a grid in landscape and everything else in portrait', () => {
    expect(defaultOrientation('grid')).toBe('landscape');
    expect(defaultOrientation('gallery')).toBe('portrait');
    expect(defaultOrientation('kanban')).toBe('portrait');
    expect(defaultOrientation('record')).toBe('portrait');
  });

  it('prints grids, galleries, and kanbans only', () => {
    expect(['grid', 'gallery', 'kanban'].every((type) => isPrintableViewType(type as 'grid'))).toBe(true);
    for (const type of ['calendar', 'timeline', 'gantt', 'form', 'chart', 'pivot'] as const)
      expect(isPrintableViewType(type)).toBe(false);
  });
});

describe('which fields print', () => {
  const config = GridConfig.parse({
    fieldOrder: [fields.due.id, fields.status.id],
    hiddenFieldIds: [fields.status.id, fields.budget.id],
  });

  it('lists every field in the view’s order, with the ones the view shows chosen to start', () => {
    const choices = viewFieldChoices(config, allFields, table.primaryFieldId);
    expect(choices.map(({ field }) => field.name)).toEqual([
      'Name',
      'Due',
      'Status',
      'Budget',
      'Owner',
      'Files',
      'Projects',
      'Approval',
      'Notes',
      'Done',
      'Site',
      'Data',
    ]);
    expect(choices.filter(({ chosen }) => !chosen).map(({ field }) => field.name)).toEqual([
      'Status',
      'Budget',
    ]);
  });

  it('keeps the primary field and the choices’ order whatever is picked', () => {
    const choices = viewFieldChoices(config, allFields, table.primaryFieldId);
    const picked = chosenFields(choices, new Set([fields.budget.id, fields.due.id]), table.primaryFieldId);
    expect(picked.map((field) => field.name)).toEqual(['Name', 'Due', 'Budget']);
    expect(chosenFields(choices, new Set(), table.primaryFieldId).map((field) => field.name)).toEqual([
      'Name',
    ]);
  });

  it('prints every field of a record, with its primary field first', () => {
    const choices = recordFieldChoices([fields.status, fields.name, fields.notes], table.primaryFieldId);
    expect(choices.map(({ field, chosen }) => [field.name, chosen])).toEqual([
      ['Name', true],
      ['Status', true],
      ['Notes', true],
    ]);
  });

  it('reads column widths the way the grid does', () => {
    const widths = GridConfig.parse({ columnWidths: { [fields.status.id]: 90 } });
    expect(columnWidth(widths, fields.status.id, table.primaryFieldId)).toBe(90);
    expect(columnWidth(widths, fields.name.id, table.primaryFieldId)).toBe(240);
    expect(columnWidth(widths, fields.notes.id, table.primaryFieldId)).toBe(180);
  });
});

describe('the file’s name', () => {
  it('names the file after the table and the title, safe for any file system', () => {
    expect(pdfFileName('Tasks', 'Launch board', 'Launch board')).toBe('Tasks - Launch board.pdf');
    expect(pdfFileName('Q1/Q2', 'Plan: "draft"?', 'x')).toBe('Q1 Q2 - Plan draft.pdf');
    expect(pdfFileName('Tasks', 'Tasks', 'x')).toBe('Tasks.pdf');
    expect(pdfFileName('', '  ', 'Launch board')).toBe('Launch board.pdf');
    expect(pdfFileName('', '', '')).toBe('records.pdf');
    expect(pdfFileName('Задачи', 'Сетка.', 'x')).toBe('Задачи - Сетка.pdf');
  });
});
