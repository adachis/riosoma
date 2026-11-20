import { describe, expect, it } from 'vitest';
import { FieldMeta } from './fields.js';
import {
  Block,
  InterfaceCodeRequest,
  InterfacePage,
  filterBlockCondition,
  filterControls,
  filtersFor,
} from './interfaces.js';

const tableId = 'tbl00000000000001';
const otherTableId = 'tbl00000000000002';
const viewId = 'viw00000000000001';

function field(type: string, options: Record<string, unknown> = {}) {
  return FieldMeta.parse({
    id: 'fld00000000000001',
    tableId,
    name: 'Field',
    description: '',
    position: 0,
    createdAt: '2026-09-27T00:00:00.000Z',
    updatedAt: '2026-09-27T00:00:00.000Z',
    type,
    options,
  });
}

const place = { x: 0, y: 0, w: 6, h: 4 };
const choiceId = 'cho00000000000001';
const userId = 'usr00000000000001';

describe('interface blocks', () => {
  it('preserves the choice to hide field names', () => {
    expect(
      Block.parse({
        id: 'records01',
        kind: 'records',
        place,
        source: { tableId, viewId },
        showFieldNames: false,
      }),
    ).toMatchObject({ showFieldNames: false });
  });

  it('fill their defaults, like dashboard tiles', () => {
    expect(Block.parse({ id: 'records01', kind: 'records', place, source: { tableId, viewId } })).toEqual({
      id: 'records01',
      kind: 'records',
      title: '',
      place,
      source: { tableId, viewId, filter: null },
      fieldIds: [],
      display: 'list',
      showFieldNames: true,
    });
    expect(Block.parse({ id: 'text0001', kind: 'text', place })).toMatchObject({
      style: 'paragraph',
      text: '',
    });
    expect(
      Block.parse({
        id: 'chart001',
        kind: 'chart',
        place,
        source: { tableId },
        groupBy: { fieldId: 'fld00000000000001' },
        value: {},
      }),
    ).toMatchObject({ chart: 'column', value: { fn: 'count', fieldId: null }, limit: 20 });
  });

  it('open only web links', () => {
    const button = (url: string) =>
      Block.safeParse({ id: 'button01', kind: 'button', place, action: { kind: 'url', url } }).success;
    expect(button('https://example.com/help')).toBe(true);
    expect(button('javascript:alert(1)')).toBe(false);
    expect(button('example.com')).toBe(false);
  });
});

describe('filter blocks', () => {
  it('offer choices for fields with set values and search for fields that hold text', () => {
    expect(filterControls(field('singleSelect', { choices: [] }))).toEqual(['choice']);
    expect(filterControls(field('user'))).toEqual(['choice']);
    expect(filterControls(field('checkbox'))).toEqual(['choice']);
    expect(filterControls(field('text'))).toEqual(['search']);
    expect(filterControls(field('number'))).toEqual([]);
  });

  it('turn what someone chose into a condition that suits the field', () => {
    const select = field('singleSelect', { choices: [{ id: choiceId, name: 'Open', color: 'blue' }] });
    expect(filterBlockCondition('choice', select, choiceId)).toMatchObject({
      operator: 'is',
      value: choiceId,
    });
    const multiple = field('multipleSelect', { choices: [{ id: choiceId, name: 'Red', color: 'red' }] });
    expect(filterBlockCondition('choice', multiple, choiceId)).toMatchObject({
      operator: 'hasAnyOf',
      value: [choiceId],
    });
    expect(filterBlockCondition('choice', field('user'), userId)).toMatchObject({
      operator: 'hasAnyOf',
      value: [userId],
    });
    expect(filterBlockCondition('choice', field('createdBy'), userId)).toMatchObject({ operator: 'is' });
    expect(filterBlockCondition('choice', field('checkbox'), false)).toMatchObject({
      operator: 'is',
      value: false,
    });
    expect(filterBlockCondition('search', field('text'), '  lamp ')).toMatchObject({
      operator: 'contains',
      value: 'lamp',
    });
    // Nothing chosen, blank text, and values that don't suit the field narrow nothing.
    expect(filterBlockCondition('search', field('text'), '   ')).toBeNull();
    expect(filterBlockCondition('search', field('text'), undefined)).toBeNull();
    expect(filterBlockCondition('choice', field('checkbox'), 'yes')).toBeNull();
    expect(filterBlockCondition('choice', select, true)).toBeNull();
    expect(filterBlockCondition('choice', select, 'not a choice')).toBeNull();
    expect(filterBlockCondition('search', field('number'), '12')).toBeNull();
  });

  it('narrow the records blocks they name, or every one of their table', () => {
    const page = InterfacePage.parse({
      id: 'pageOne01',
      name: 'One',
      blocks: [
        { id: 'records01', kind: 'records', place, source: { tableId, viewId } },
        { id: 'records02', kind: 'records', place, source: { tableId, viewId } },
        { id: 'records03', kind: 'records', place, source: { tableId: otherTableId, viewId } },
        { id: 'filterAll', kind: 'filter', place, tableId, fieldId: 'fld00000000000001' },
        {
          id: 'filterTwo',
          kind: 'filter',
          place,
          tableId,
          fieldId: 'fld00000000000001',
          blockIds: ['records02'],
        },
      ],
    });
    const records = (id: string) => {
      const block = page.blocks.find((item) => item.id === id);
      if (block?.kind !== 'records') throw new Error('expected a records block');
      return block;
    };
    expect(filtersFor(page, records('records01')).map((block) => block.id)).toEqual(['filterAll']);
    expect(filtersFor(page, records('records02')).map((block) => block.id)).toEqual([
      'filterAll',
      'filterTwo',
    ]);
    expect(filtersFor(page, records('records03'))).toEqual([]);
  });
});

describe('custom code contracts', () => {
  it('bounds each source and accepts only the four page bridge operations', () => {
    const code = { id: 'custom01', kind: 'code', place };
    expect(Block.parse(code)).toMatchObject({ html: '', css: '', javascript: '' });
    for (const key of ['html', 'css', 'javascript'])
      expect(Block.safeParse({ ...code, [key]: 'x'.repeat(50_001) }).success).toBe(false);
    expect(InterfaceCodeRequest.parse({ method: 'records', blockId: 'records01' })).toEqual({
      method: 'records',
      blockId: 'records01',
      offset: 0,
    });
    expect(InterfaceCodeRequest.safeParse({ method: 'command', kind: 'interface.update' }).success).toBe(
      false,
    );
    expect(
      InterfaceCodeRequest.safeParse({
        method: 'change',
        blockId: 'records01',
        recordId: 'rec00000000000001',
        values: {},
      }).success,
    ).toBe(false);
  });
});
