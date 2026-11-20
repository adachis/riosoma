import { i18n } from '@lingui/core';
import { describe, expect, it } from 'vitest';
import {
  DURATION_FORMATS,
  FieldMeta,
  RATING_ICONS,
  ViewMeta,
  type CellValue,
  type FieldType,
} from '@riosoma/contracts';
import { parseText } from './parse';
import { editText, formatCell, type FormatContext } from './format';
import { planPaste } from './clipboard/plan';
import { createCellRenderer } from './cells/renderers';
import { gridColumns } from './cells/columns';

const ada = 'usr00000000000001';
const grace = 'usr00000000000002';
const collaborators = new Map([
  [ada, { name: 'Ada Lovelace', email: 'ada@example.com' }],
  [grace, { name: 'Grace Hopper', email: 'grace@example.com' }],
]);
const context = (locale = 'en-US'): FormatContext => ({ locale, timeZone: 'UTC', collaborators });
function field(type: FieldType, options: object = {}): FieldMeta {
  return FieldMeta.parse({
    id: 'fld00000000000001',
    tableId: 'tbl00000000000001',
    name: type,
    description: '',
    position: 0,
    createdAt: '',
    updatedAt: '',
    type,
    options,
  });
}
const numericCases: Array<[FieldType, object, string, string, CellValue]> = [
  ['currency', {}, '$1,234.50', 'en-US', 1234.5],
  ['currency', {}, 'USD 1,234.50', 'en-US', 1234.5],
  ['currency', {}, '1234.50', 'en-US', 1234.5],
  ['currency', {}, '-$1,234.50', 'en-US', -1234.5],
  ['currency', { code: 'EUR' }, '1.234,50 €', 'de', 1234.5],
  ['currency', { code: 'EUR' }, '1 234,50 EUR', 'fr', 1234.5],
  ['currency', { code: 'INR' }, '₹1,23,456.50', 'en-IN', 123456.5],
  ['currency', { code: 'JPY' }, '￥1,234', 'ja', 1234],
  ['percent', {}, '25', 'en-US', 0.25],
  ['percent', {}, '25%', 'en-US', 0.25],
  ['percent', {}, '25,5 %', 'de', 0.255],
  ['percent', {}, '-25,5', 'de', -0.255],
  ['duration', {}, '90', 'en-US', 5400],
  ['duration', { format: 'h:mm:ss' }, '90', 'en-US', 90],
  ['duration', { format: 'h:mm:ss.s' }, '90,5', 'de', 90.5],
  ['rating', {}, '0', 'en-US', null],
  ['rating', {}, '5', 'en-US', 5],
  ['rating', { max: 10 }, '10', 'en-US', 10],
  ['user', {}, 'ADA@EXAMPLE.COM', 'en-US', [ada]],
  [
    'user',
    { allowMultiple: true },
    'Ada Lovelace, grace@example.com, ada@example.com',
    'en-US',
    [ada, grace],
  ],
  ...DURATION_FORMATS.flatMap((format): typeof numericCases => [
    ['duration', { format }, '1:30', 'en-US', 5400],
    ['duration', { format }, '1:30:15', 'en-US', 5415],
    ['duration', { format }, '1:30:15.5', 'en-US', 5415.5],
    ['duration', { format }, '1:30:15,5', 'de', 5415.5],
    ['duration', { format }, '15', 'en-US', format === 'h:mm' ? 900 : 15],
  ]),
];

describe('additional field parsing and pasting', () => {
  it.each(numericCases)('reads and pastes %s %j %s (%s)', (type, options, text, locale, value) => {
    const item = field(type, options);
    expect(parseText(item, text, context(locale))).toEqual({ ok: true, value });
    const plan = planPaste({
      fields: [item],
      cells: [[text]],
      start: { row: 0, col: 0 },
      selection: { rows: 1, cols: 1 },
      rowCount: 1,
      rowIdAt: () => 'rec00000000000001',
      context: context(locale),
    });
    expect(plan.problems).toEqual([]);
    expect(plan.updates[0]?.values).toEqual({ [item.id]: value });
  });
  it.each([
    ['currency', { allowNegative: false }, '-1'],
    ['percent', { allowNegative: false }, '-1'],
    ['duration', {}, '-1'],
    ['duration', {}, '1:60'],
    ['duration', {}, '1:30:60'],
    ['rating', {}, '2.5'],
    ['rating', {}, '6'],
    ['rating', {}, '-1'],
    ['user', {}, 'Nobody'],
    ['user', {}, 'Ada Lovelace, Grace Hopper'],
  ] as const)('rejects invalid %s values %j %s without replacing pasted cells', (type, options, text) => {
    const item = field(type, options);
    expect(parseText(item, text, context()).ok).toBe(false);
    const plan = planPaste({
      fields: [item],
      cells: [[text]],
      start: { row: 0, col: 0 },
      selection: { rows: 1, cols: 1 },
      rowCount: 1,
      rowIdAt: () => 'rec00000000000001',
      context: context(),
    });
    expect(plan.problems).toHaveLength(1);
    expect(plan.updates).toEqual([]);
  });
  it('rejects ambiguous names while allowing unique email addresses', () => {
    const ctx = {
      ...context(),
      collaborators: new Map([
        [ada, { name: 'Alex', email: 'a@example.com' }],
        [grace, { name: 'Alex', email: 'b@example.com' }],
      ]),
    };
    expect(parseText(field('user'), 'Alex', ctx).ok).toBe(false);
    expect(parseText(field('user'), 'a@example.com', ctx)).toEqual({ ok: true, value: [ada] });
  });
  it.each(['currency', 'percent', 'duration', 'rating', 'user'] as const)('clears %s', (type) => {
    expect(parseText(field(type), '', context())).toEqual({ ok: true, value: null });
  });
  it('keeps autonumber read-only during typing and paste', () => {
    const item = field('autoNumber');
    expect(parseText(item, '5', context())).toEqual({ ok: false, reason: 'computed' });
    const plan = planPaste({
      fields: [item],
      cells: [['5']],
      start: { row: 0, col: 0 },
      selection: { rows: 1, cols: 1 },
      rowCount: 1,
      rowIdAt: () => 'rec00000000000001',
      context: context(),
    });
    expect(plan.skippedComputed).toBe(1);
    expect(plan.updates).toEqual([]);
  });
  it.each([
    ['currency', {}, 1234.5678, '1234,5678'],
    ['percent', {}, 0.255, '25,5'],
    ['percent', {}, 0.29, '29'],
    ['duration', {}, 5400, '90'],
    ['duration', { format: 'h:mm:ss' }, 90.5, '90,5'],
  ] as const)('edits %s without decoration or precision loss', (type, options, value, text) => {
    const item = field(type, options);
    expect(editText(item, value, context('de'))).toBe(text);
    expect(parseText(item, text, context('de'))).toEqual({ ok: true, value });
  });
});

describe('additional field drawing', () => {
  function draw(item: FieldMeta, value: CellValue) {
    const format = context();
    const host = document.createElement('div');
    const renderer = createCellRenderer({
      fieldsById: new Map([[item.id, item]]),
      format,
      rowHeight: 'short',
    });
    const row = {
      id: 'rec00000000000001',
      values: { [item.id]: value },
      createdAt: '',
      updatedAt: '',
      createdBy: null,
      updatedBy: null,
    };
    const props = {
      row,
      rowIndex: 0,
      column: { id: item.id, width: 200, edit: 'none' as const },
      colIndex: 0,
      selected: false,
      active: false,
    };
    renderer(host, props);
    return { host, format, redraw: () => renderer(host, props) };
  }
  it.each(['currency', 'percent', 'duration', 'autoNumber'] as const)(
    'draws %s as end-aligned formatted text',
    (type) => {
      const item = field(type);
      const { host } = draw(item, 1234);
      expect(host.textContent).toBe(formatCell(item, 1234, context()));
      const view = ViewMeta.parse({
        id: 'viw00000000000001',
        tableId: item.tableId,
        name: 'Grid',
        type: 'grid',
        config: {},
        position: 0,
        createdAt: '',
        updatedAt: '',
        createdBy: null,
      });
      expect(gridColumns(view, [item], item.id)[0]).toMatchObject({
        align: 'end',
        edit: type === 'autoNumber' ? 'none' : 'inline',
      });
    },
  );
  it.each(RATING_ICONS)('draws filled and faint %s rating icons in the field color', (icon) => {
    i18n.load('en-US', {});
    i18n.activate('en-US');
    const { host } = draw(field('rating', { icon, max: 7, color: 'purple' }), 3);
    expect(host.querySelectorAll('svg')).toHaveLength(7);
    expect(host.querySelectorAll('[data-filled="true"]')).toHaveLength(3);
    expect(host.firstElementChild?.getAttribute('aria-label')).toBe('3 of 7');
    expect((host.firstElementChild as HTMLElement).style.getPropertyValue('--rio-rating-color')).toBe(
      'var(--rio-aa-choice-purple)',
    );
  });
  it('draws empty ratings and refreshes user avatar pills after a rename', () => {
    expect(draw(field('rating'), null).host.querySelectorAll('[data-filled="false"]')).toHaveLength(5);
    const { host, format, redraw } = draw(field('user', { allowMultiple: true }), [ada, grace]);
    expect(host.querySelectorAll('.rio-person-avatar')).toHaveLength(2);
    expect(host.textContent).toContain('Ada Lovelace');
    format.collaborators = new Map([
      [ada, { name: 'Ada Byron' }],
      [grace, { name: 'Grace Hopper' }],
    ]);
    redraw();
    expect(host.textContent).toContain('Ada Byron');
  });
});
