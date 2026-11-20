import { describe, expect, it } from 'vitest';
import { EMPTY_STACK, type Command, type FieldMeta, type RowData } from '@riosoma/contracts';
import type { SchemaState } from '../../data/types';
import {
  boardFinished,
  checkedBoxes,
  checkedOff,
  doneStack,
  readChecklist,
  showsWholeTable,
} from './triggers';

const schema = {
  fieldById: new Map([
    ['field-done', { id: 'field-done', type: 'checkbox' }],
    ['field-name', { id: 'field-name', type: 'text' }],
  ]),
} as unknown as SchemaState;

function update(values: Record<string, unknown>): Command {
  return {
    id: 'command-one',
    groupId: 'action-one',
    kind: 'record.update',
    tableId: 'table-one',
    records: [{ id: 'record-one', values }],
  } as Command;
}

function rows(values: Array<boolean | null | undefined>) {
  return {
    rowCount: () => values.length,
    getRow: (index: number): RowData | undefined =>
      values[index] === undefined
        ? undefined
        : ({ id: `record-${index}`, values: { 'field-done': values[index] } } as unknown as RowData),
  };
}

describe('the person’s own checkboxes', () => {
  it('counts boxes they checked, and nothing else', () => {
    expect(checkedBoxes([update({ 'field-done': true })], schema)).toBe(1);
    expect(checkedBoxes([update({ 'field-done': false })], schema)).toBe(0);
    expect(checkedBoxes([update({ 'field-name': true })], schema)).toBe(0);
    expect(checkedBoxes([update({ 'field-done': true, 'field-name': 'x' })], schema)).toBe(1);
  });
});

describe('a finished board', () => {
  it('takes the last choice in the field’s own order as done, and a person field as having none', () => {
    const status = {
      type: 'singleSelect',
      options: { choices: [{ id: 'todo' }, { id: 'doing' }, { id: 'done' }] },
    } as unknown as FieldMeta;
    expect(doneStack(status)).toBe('done');
    expect(doneStack({ type: 'singleSelect', options: { choices: [] } } as unknown as FieldMeta)).toBeNull();
    expect(doneStack({ type: 'user', options: {} } as unknown as FieldMeta)).toBeNull();
  });

  it('is finished when every card of at least five is in the done stack', () => {
    expect(boardFinished(new Map([['done', 5]]), 'done')).toBe(true);
    expect(
      boardFinished(
        new Map([
          ['todo', 0],
          ['done', 7],
          [EMPTY_STACK, 0],
        ]),
        'done',
      ),
    ).toBe(true);
  });

  it('isn’t finished with fewer than five cards, or with any card elsewhere', () => {
    expect(boardFinished(new Map([['done', 4]]), 'done')).toBe(false);
    expect(
      boardFinished(
        new Map([
          ['done', 9],
          ['doing', 1],
        ]),
        'done',
      ),
    ).toBe(false);
    // A card in a stack that's hidden, or with no value at all, still counts as not done.
    expect(
      boardFinished(
        new Map([
          ['done', 9],
          ['archived', 1],
        ]),
        'done',
      ),
    ).toBe(false);
    expect(
      boardFinished(
        new Map([
          ['done', 9],
          [EMPTY_STACK, 1],
        ]),
        'done',
      ),
    ).toBe(false);
  });
});

describe('a finished checklist', () => {
  const state = (values: Array<boolean | null | undefined>) =>
    readChecklist(rows(values), 'field-done').state;

  it('is complete when every one of at least ten records is checked', () => {
    expect(state(Array(10).fill(true))).toBe('complete');
    expect(state([...Array(11).fill(true), false])).toBe('open');
    expect(state([...Array(11).fill(true), null])).toBe('open');
  });

  it('doesn’t count views with fewer than ten records', () => {
    expect(state(Array(9).fill(true))).toBe('unknown');
  });

  it('waits for records that haven’t loaded, unless one already isn’t checked', () => {
    expect(state([...Array(10).fill(true), undefined])).toBe('unknown');
    expect(state([false, ...Array(10).fill(undefined)])).toBe('open');
  });

  it('is checked off only when a record that was open is now checked', () => {
    const open = readChecklist(rows([...Array(11).fill(true), false]), 'field-done');
    expect(checkedOff(open, readChecklist(rows(Array(12).fill(true)), 'field-done'))).toBe(true);
    // The open record left the view rather than being checked.
    expect(checkedOff(open, readChecklist(rows(Array(11).fill(true)), 'field-done'))).toBe(false);
    expect(checkedOff(undefined, readChecklist(rows(Array(12).fill(true)), 'field-done'))).toBe(false);
  });
});

describe('a view’s count', () => {
  it('stands for the table’s only when the view has no filter', () => {
    expect(showsWholeTable({ config: { filter: null } } as never)).toBe(true);
    expect(showsWholeTable({ config: { filter: { conjunction: 'and', conditions: [] } } } as never)).toBe(
      true,
    );
    expect(
      showsWholeTable({
        config: { filter: { conjunction: 'and', conditions: [{ fieldId: 'f', operator: 'isEmpty' }] } },
      } as never),
    ).toBe(false);
  });
});
