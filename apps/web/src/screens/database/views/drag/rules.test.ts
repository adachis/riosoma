import { describe, expect, it, vi } from 'vitest';
import { FieldMeta, GridConfig, newId, type RowData } from '@riosoma/contracts';
import type { ViewComponentProps } from '../types';
import { stackValue } from '../kanban/model';
import { arrangementRefusal, dropRefusal, orderCommand } from './rules';

function fixture() {
  const field = FieldMeta.parse({
    id: newId('field'),
    tableId: newId('table'),
    name: 'Status',
    description: '',
    type: 'singleSelect',
    position: 0,
    createdAt: '',
    updatedAt: '',
    options: {},
  });
  const row: RowData = {
    id: newId('record'),
    values: {},
    createdAt: '',
    updatedAt: '',
    createdBy: null,
    updatedBy: null,
  };
  const access = { fields: new Map(), hiddenFields: new Map() };
  const props = {
    session: {
      role: () => 'editor',
      cachedRecord: vi.fn(() => row),
      getSchema: () => ({ access }),
      run: vi.fn(),
    },
    table: { id: field.tableId },
    view: { id: newId('view'), type: 'kanban', config: GridConfig.parse({}) },
    fields: [field],
  } as unknown as ViewComponentProps;
  return { field, row, access, props };
}

describe('view drop rules', () => {
  it('refuses a column move when access or the view lock changes during a gesture', () => {
    const { props } = fixture();
    props.canEdit = true;
    vi.spyOn(props.session, 'role').mockReturnValue('owner');
    expect(arrangementRefusal(props)).toBeNull();
    const schema = props.session.getSchema();
    vi.spyOn(props.session, 'getSchema').mockReturnValue({
      ...schema,
      viewById: new Map([[props.view.id, { ...props.view, config: { ...props.view.config, locked: true } }]]),
    });
    expect(arrangementRefusal(props)).toBe('view');
    vi.spyOn(props.session, 'role').mockReturnValue('reader');
    expect(arrangementRefusal(props)).toBe('access');
  });

  it('refuses read access and a record locked during a gesture before making a command', () => {
    const { props, row } = fixture();
    expect(dropRefusal({ ...props, readOnly: true }, row)).toBe('access');
    vi.spyOn(props.session, 'role').mockReturnValueOnce('reader');
    expect(dropRefusal(props, row)).toBe('access');
    row.lock = { manual: true, reason: '', canEdit: false };
    expect(dropRefusal(props, row)).toBe('record');
    expect(orderCommand(props, row, newId('record'), 'before')).toBeNull();
    expect(props.session.run).not.toHaveBeenCalled();
  });

  it('refuses locked, restricted, computed, and read-only source fields', () => {
    const { props, field, row, access } = fixture();
    access.fields.set(field.id, { editable: false, locked: true });
    expect(dropRefusal(props, row, [field])).toBe('field');
    access.fields.clear();
    access.hiddenFields.set(field.id, field);
    expect(dropRefusal(props, row, [field])).toBe('field');
    access.hiddenFields.clear();
    const computed = FieldMeta.parse({ ...field, type: 'createdTime', options: {} });
    expect(dropRefusal(props, row, [computed])).toBe('computed');
    const source = { ...field, source: { column: 'status', sourceType: 'text' } };
    const synced = {
      ...props,
      table: { ...props.table, source: { allowOverrides: false } },
    } as ViewComponentProps;
    expect(dropRefusal(synced, row, [source])).toBe('source');
  });

  it('saves manual order in this view and refuses sorted or locked views', () => {
    const { props, row, field } = fixture();
    const target = newId('record');
    expect(orderCommand(props, row, target, 'after')).toEqual({
      kind: 'record.move',
      tableId: props.table.id,
      viewId: props.view.id,
      recordIds: [row.id],
      place: { after: target },
    });
    expect(orderCommand(props, row, row.id, 'before')).toBeNull();
    props.view.config.sorts = [{ fieldId: field.id, direction: 'asc' }];
    expect(dropRefusal(props, row, [], true)).toBe('sorted');
    expect(orderCommand(props, row, target, 'before')).toBeNull();
    expect(dropRefusal(props, row, [field])).toBeNull();
    props.view.config.sorts = [];
    props.view.config.locked = true;
    expect(dropRefusal(props, row, [], true)).toBe('view');
  });

  it('sets the grouping value to the destination choice or person and clears an empty column', () => {
    const { field } = fixture();
    const choice = newId('choice');
    expect(stackValue(field, choice)).toBe(choice);
    expect(stackValue(field, '')).toBeNull();
    const user = FieldMeta.parse({ ...field, type: 'user', options: { allowMultiple: false } });
    const person = newId('user');
    expect(stackValue(user, person)).toEqual([person]);
    expect(stackValue(user, '')).toBeNull();
  });
});
