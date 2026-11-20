import { setupI18n } from '@lingui/core';
import {
  FIELD_TYPES,
  FieldMeta,
  ViewMeta,
  presenceColor,
  type CellValue,
  type FieldType,
  type RowData,
  type RowHeight,
} from '@riosoma/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GridColumn } from '../../../../../packages/grid-core/src/types';
import type { FormatContext } from '../format';
import { gridColumns } from './columns';
import { describeCell } from './describe';
import { createHeaderRenderer } from './header';
import { createCellRenderer } from './renderers';
import { createRowHeaderRenderer } from './rowHeader';

const choices = [
  { id: 'cho00000000000001', name: 'Todo', color: 'gray' },
  { id: 'cho00000000000002', name: 'Done', color: 'green' },
];
const userId = 'usr00000000000001';
const collaborators = new Map([[userId, { name: 'Ada Lovelace' }]]);
const format: FormatContext = { locale: 'en-US', timeZone: 'UTC', collaborators };
const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
const t = i18n._.bind(i18n);

/** Options the relational types can't do without */
const REQUIRED: Partial<Record<FieldType, object>> = {
  link: { linkedTableId: 'tbl00000000000002' },
  lookup: { linkFieldId: 'fld00000000000098', targetFieldId: 'fld00000000000099' },
  rollup: { linkFieldId: 'fld00000000000098', targetFieldId: 'fld00000000000099' },
  count: { linkFieldId: 'fld00000000000098' },
};

function field(type: FieldType, options: object = {}, index = 1): FieldMeta {
  options = { ...REQUIRED[type], ...options };
  return FieldMeta.parse({
    id: `fld${String(index).padStart(14, '0')}`,
    tableId: 'tbl00000000000001',
    name: 'Field',
    description: '',
    position: index,
    createdAt: '2026-09-27T00:00:00.000Z',
    updatedAt: '2026-09-27T00:00:00.000Z',
    type,
    options,
  });
}

function row(f: FieldMeta, value: CellValue): RowData {
  return {
    id: 'rec00000000000001',
    values: { [f.id]: value },
    createdAt: '2026-09-27T15:05:00.000Z',
    updatedAt: '2026-09-28T15:05:00.000Z',
    createdBy: userId,
    updatedBy: userId,
  };
}

function column(f: FieldMeta, width = 180): GridColumn {
  return { id: f.id, width, edit: 'none' };
}

function setup(f: FieldMeta, rowHeight: RowHeight = 'short') {
  const fieldsById = new Map([[f.id, f]]);
  const context = { fieldsById, format: { ...format }, rowHeight };
  const render = createCellRenderer(context);
  const el = document.createElement('div');
  const draw = (value: CellValue, width = 180, current = f, data = row(current, value)) => {
    render(el, {
      row: data,
      rowIndex: 0,
      column: column(current, width),
      colIndex: 0,
      selected: false,
      active: false,
    });
  };
  return { el, draw, context, render };
}

afterEach(() => vi.restoreAllMocks());

const textCases: Array<[FieldType, CellValue, string]> = [
  ['text', '<b>Text</b>', '<b>Text</b>'],
  ['longText', 'Two\nlines', 'Two\nlines'],
  ['number', 1234.5, '1,234.5'],
  ['date', '2026-09-27', 'Sep 27, 2026'],
  ['email', 'ada@example.com', 'ada@example.com'],
  ['url', 'example.com', 'example.com'],
  ['phone', '+15551234567', '+15551234567'],
  ['createdTime', null, 'Sep 27, 2026, 3:05 PM'],
  ['lastModifiedTime', null, 'Sep 28, 2026, 3:05 PM'],
  ['recordId', null, 'rec00000000000001'],
];

describe('cell rendering', () => {
  it.each(textCases)('draws %s as formatted text', (type, value, expected) => {
    const { el, draw } = setup(field(type));
    draw(value);
    expect(el.textContent).toBe(expected);
    expect(el.querySelector('b')).toBeNull();
  });

  it.each([
    'text',
    'longText',
    'number',
    'date',
    'email',
    'url',
    'phone',
    'singleSelect',
    'multipleSelect',
  ] as const)('leaves empty %s cells empty', (type) => {
    const { el, draw } = setup(field(type));
    draw(null);
    expect(el.childNodes.length).toBe(0);
  });

  it.each(['short', 'medium', 'tall', 'extraTall'] as const)('clamps long text in %s rows', (height) => {
    const { el, draw } = setup(field('longText'), height);
    draw('A long line\nand another line');
    const text = el.firstElementChild as HTMLElement;
    expect(text.classList.contains('rio-cell-value--wrap')).toBe(height !== 'short');
    expect(text.style.getPropertyValue('--rio-cell-lines')).toBe(
      { short: '', medium: '2', tall: '4', extraTall: '6' }[height],
    );
  });

  it('draws checked and unchecked boxes in the field color and reuses the SVG', () => {
    const f = field('checkbox', { color: 'purple' });
    const { el, draw } = setup(f);
    draw(true);
    const box = el.firstElementChild as HTMLElement;
    const svg = box.querySelector('svg');
    expect(box.dataset.checked).toBe('true');
    expect(box.style.getPropertyValue('--rio-cell-check-color')).toBe('var(--rio-aa-choice-purple)');
    expect(svg?.querySelector('path')?.getAttribute('d')).toBeTruthy();
    draw(false);
    expect(el.firstElementChild).toBe(box);
    expect(box.querySelector('svg')).toBe(svg);
    expect(box.dataset.checked).toBe('false');
    draw(null);
    expect(box.dataset.checked).toBe('false');
  });

  it.each(['singleSelect', 'multipleSelect'] as const)(
    'uses shared %s pills and skips unknown choices',
    (type) => {
      const { el, draw } = setup(field(type, { choices }), 'tall');
      draw(type === 'singleSelect' ? choices[1]!.id : ['unknown', choices[1]!.id, choices[0]!.id]);
      const pills = el.querySelectorAll('.rio-choice-pill');
      expect(pills.length).toBe(type === 'singleSelect' ? 1 : 2);
      expect(pills[0]?.getAttribute('data-color')).toBe('green');
      expect(pills[0]?.getAttribute('data-size')).toBe('sm');
      expect(pills[0]?.querySelector('.rio-choice-pill__label')?.textContent).toBe('Done');
      expect(pills[0]?.querySelector('.rio-choice-pill__label')?.getAttribute('aria-label')).toBe('Done');
      expect(el.firstElementChild?.getAttribute('data-row-height')).toBe('tall');
      draw(type === 'singleSelect' ? 'unknown' : ['unknown']);
      expect(el.hasChildNodes()).toBe(false);
    },
  );

  it('reuses pills as choices change and removes leftover pills', () => {
    const { el, draw } = setup(field('multipleSelect', { choices }));
    draw(choices.map((choice) => choice.id));
    const first = el.querySelector('.rio-choice-pill');
    const label = first?.firstElementChild;
    draw([choices[1]!.id]);
    expect(el.querySelector('.rio-choice-pill')).toBe(first);
    expect(first?.firstElementChild).toBe(label);
    expect(el.querySelectorAll('.rio-choice-pill')).toHaveLength(1);
    expect(el.textContent).toBe('Done');
  });

  it.each(['createdBy', 'lastModifiedBy'] as const)('uses shared avatars for %s', (type) => {
    const f = field(type);
    const { el, draw } = setup(f);
    draw(null);
    const avatar = el.querySelector('.rio-person-avatar');
    expect(avatar?.getAttribute('data-size')).toBe('sm');
    expect(avatar?.getAttribute('data-color')).toBe(presenceColor(userId));
    expect(avatar?.getAttribute('aria-label')).toBe('Ada Lovelace');
    expect(avatar?.textContent).toBe('AL');
    expect(el.querySelector('.rio-cell-person__name')?.textContent).toBe('Ada Lovelace');
    draw(null, 180, f, { ...row(f, null), createdBy: null, updatedBy: 'unknown' });
    expect(el.hasChildNodes()).toBe(false);
  });
});

describe('links', () => {
  it.each([
    ['url', 'https://example.com/a?b=c', 'https://example.com/a?b=c'],
    ['url', 'http://example.com', 'http://example.com'],
    ['url', 'example.com', 'https://example.com'],
    ['url', 'example.com:8080/path', 'https://example.com:8080/path'],
    ['email', 'ada@example.com', 'mailto:ada@example.com'],
    ['phone', '+1(555)123-4567', 'tel:+1(555)123-4567'],
  ] as const)('links %s %s safely', (type, value, href) => {
    const { el, draw } = setup(field(type));
    draw(value);
    const link = el.querySelector('a');
    expect(link?.getAttribute('href')).toBe(href);
    expect(link?.target).toBe('_blank');
    expect(link?.rel).toBe('noopener noreferrer');
    expect(link?.textContent).toBe(value);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,test',
    'ftp://example.com',
    '//example.com',
    'hello world',
    'example.com/a b',
    'https://',
    'https://example.com/\npath',
    'example.com/\u0000',
    'mailto:ada@example.com',
  ])('leaves unsafe URL %s as text', (value) => {
    const { el, draw } = setup(field('url'));
    draw(value);
    expect(el.querySelector('a')).toBeNull();
    expect(el.textContent).toBe(value);
  });

  it.each(['email', 'phone'] as const)('rejects schemes and spaces in %s', (type) => {
    const { el, draw } = setup(field(type));
    for (const value of ['javascript:alert(1)', 'data:text/html,test', 'ada @example.com', '555 123 4567']) {
      draw(value);
      expect(el.querySelector('a')).toBeNull();
      expect(el.textContent).toBe(value);
    }
  });
});

describe('recycled cells', () => {
  it('replaces all content when its kind changes', () => {
    const f = field('url');
    const { el, draw, context } = setup(f);
    draw('example.com');
    const link = el.firstChild;
    const check = field('checkbox', { color: 'red' }, 2);
    context.fieldsById.set(check.id, check);
    draw(true, 180, check);
    expect(el.contains(link)).toBe(false);
    expect(el.querySelector('a')).toBeNull();
    expect(el.querySelector('svg')).not.toBeNull();
    const plain = field('text', {}, 3);
    context.fieldsById.set(plain.id, plain);
    draw('Hello', 180, plain);
    expect(el.textContent).toBe('Hello');
    expect(el.querySelector('svg')).toBeNull();
    expect(el.querySelector('[href]')).toBeNull();
    context.fieldsById.delete(plain.id);
    draw('Hello', 180, plain);
    expect(el.hasChildNodes()).toBe(false);
  });

  it('does not write unchanged text, attributes, styles, or children', () => {
    const { el, draw } = setup(field('text'));
    draw('Same');
    const text = el.firstElementChild as HTMLElement;
    const textSetter = vi.spyOn(text, 'textContent', 'set');
    const classSetter = vi.spyOn(text, 'className', 'set');
    const attributes = vi.spyOn(text, 'setAttribute');
    const styles = vi.spyOn(text.style, 'setProperty');
    const children = vi.spyOn(el, 'replaceChildren');
    draw('Same');
    expect(textSetter).not.toHaveBeenCalled();
    expect(classSetter).not.toHaveBeenCalled();
    expect(attributes).not.toHaveBeenCalled();
    expect(styles).not.toHaveBeenCalled();
    expect(children).not.toHaveBeenCalled();
    draw('Changed');
    expect(el.firstElementChild).toBe(text);
    expect(textSetter).toHaveBeenCalledOnce();
    classSetter.mockClear();
    draw('Changed', 240);
    expect(classSetter).toHaveBeenCalledOnce();
  });

  it('restores content the grid cleared even when the value did not change', () => {
    const { el, draw } = setup(field('text'));
    draw('Same');
    el.replaceChildren();
    draw('Same');
    expect(el.textContent).toBe('Same');
  });

  it('notices changed arrays, field metadata, row heights, locale, and collaborator names', () => {
    const f = field('multipleSelect', { choices });
    const { el, draw, context } = setup(f);
    const value = [choices[0]!.id];
    draw(value);
    value.push(choices[1]!.id);
    draw(value);
    expect(el.textContent).toBe('Todo Done');
    context.fieldsById.set(
      f.id,
      field('multipleSelect', { choices: [{ ...choices[0], name: 'Ready' }, choices[1]] }),
    );
    draw(value);
    expect(el.textContent).toBe('Ready Done');
    context.rowHeight = 'tall';
    draw(value);
    expect(el.firstElementChild?.getAttribute('data-row-height')).toBe('tall');
    const numeric = field('number');
    context.fieldsById.set(f.id, numeric);
    draw(1234.5);
    context.format.locale = 'de';
    draw(1234.5);
    expect(el.textContent).toBe('1.234,5');
    context.fieldsById.set(f.id, field('createdBy'));
    draw(null);
    context.format.collaborators = new Map([[userId, { name: 'Grace Hopper' }]]);
    draw(null);
    expect(el.querySelector('.rio-person-avatar')?.textContent).toBe('GH');
    expect(el.querySelector('.rio-cell-person__name')?.textContent).toBe('Grace Hopper');
  });
});

describe('columns', () => {
  it('uses visible order, primary/default/saved widths, and every edit mode', () => {
    const fields = FIELD_TYPES.map((type, index) => field(type, {}, index + 1));
    const view = ViewMeta.parse({
      id: 'viw00000000000001',
      tableId: fields[0]!.tableId,
      name: 'Grid',
      type: 'grid',
      position: 0,
      createdBy: null,
      createdAt: '',
      updatedAt: '',
      config: {
        fieldOrder: [fields[2]!.id, fields[1]!.id],
        hiddenFieldIds: [fields[0]!.id, fields[7]!.id],
        columnWidths: { [fields[2]!.id]: 300 },
      },
    });
    const columns = gridColumns(view, fields, fields[0]!.id);
    expect(columns.map((entry) => entry.id)).toEqual([
      fields[0]!.id,
      fields[2]!.id,
      fields[1]!.id,
      ...fields
        .slice(3)
        .filter((entry) => entry !== fields[7])
        .map((entry) => entry.id),
    ]);
    expect(columns.slice(0, 3).map((entry) => entry.width)).toEqual([240, 300, 180]);
    view.config.hiddenFieldIds = [];
    view.config.columnWidths[fields[0]!.id] = 260;
    const all = gridColumns(view, fields, fields[0]!.id);
    expect(all[0]?.width).toBe(260);
    const modes = [
      'inline',
      'custom',
      'inline',
      'none',
      'custom',
      'custom',
      'custom',
      'inline',
      'inline',
      'inline',
      'none',
      'none',
      'none',
      'none',
      'none',
      'custom',
      'custom',
      'none',
      'none',
      'none',
      'none',
      'inline',
      'inline',
      'inline',
      'custom',
      'custom',
      'none',
      'custom',
      // Date range, JSON, location, and signature open editors, and a button's cell holds its link.
      'custom',
      'custom',
      'custom',
      'custom',
      'none',
      // Scanning, clock entry, and an amount with its currency use dedicated controls.
      'custom',
      'custom',
      'custom',
      'none',
    ];
    expect(modes).toHaveLength(FIELD_TYPES.length);
    fields.forEach((f, index) => {
      const spec = all.find((entry) => entry.id === f.id)!;
      expect(spec.edit).toBe(modes[index]);
      expect(spec.minWidth).toBe(60);
      expect(spec.toggle === true).toBe(f.type === 'checkbox');
      expect(spec.align === 'end').toBe(
        ['number', 'currency', 'percent', 'duration', 'autoNumber', 'count'].includes(f.type) ||
          (f.type === 'rollup' && f.options.resultType === 'number'),
      );
    });
  });
});

describe('headers and descriptions', () => {
  it.each([{ sources: ['Customers Name'] }, { sources: ['Customers Name', 'Orders Customer'] }])(
    'names readable joined sources in the header when $sources are available',
    ({ sources }) => {
      const f = { ...field('text'), source: { sourceType: 'joined', column: 'name' } };
      const heading = document.createElement('div');
      heading.setAttribute('role', 'columnheader');
      const el = document.createElement('div');
      heading.append(el);
      createHeaderRenderer({
        fieldsById: new Map([[f.id, f]]),
        primaryFieldId: f.id,
        mappedSources: () => sources,
        t,
      })(el, column(f), 0);
      const label = `Mapped from ${sources.join(', ')}`;
      expect(heading.title).toBe(label);
      expect(heading.getAttribute('aria-description')).toContain(label);
      expect(el.querySelector('.rio-synced-source')?.getAttribute('aria-hidden')).toBe('true');
    },
  );

  it('draws every field icon and labels the primary column without changing its chevron', () => {
    const fields = FIELD_TYPES.map((type, index) => field(type, {}, index + 1));
    const renderer = createHeaderRenderer({
      fieldsById: new Map(fields.map((f) => [f.id, f])),
      primaryFieldId: fields[0]!.id,
      t,
    });
    const parent = document.createElement('div');
    parent.setAttribute('role', 'columnheader');
    const el = document.createElement('div');
    parent.append(el);
    for (const f of fields) {
      renderer(el, column(f), 0);
      expect(el.textContent).toBe(f.name);
      expect(el.querySelectorAll('svg')).toHaveLength(2);
      expect(parent.getAttribute('aria-haspopup')).toBe('menu');
      expect(parent.getAttribute('aria-description')).toBe(f === fields[0] ? 'Primary field' : null);
      expect(el.querySelector('.rio-cell-header__chevron')).not.toBeNull();
    }
    el.replaceChildren();
    renderer(el, column(fields[14]!), 0);
    expect(el.textContent).toBe('Field');
  });

  it('draws row positions, selected checkboxes, and accessible action buttons after recycling', () => {
    const renderer = createRowHeaderRenderer({ t });
    const el = document.createElement('div');
    renderer(el, 0, undefined, false);
    expect(el.querySelector('.rio-cell-row-header__number')?.textContent).toBe('1');
    expect(el.querySelector('[data-action="select"]')?.getAttribute('aria-checked')).toBe('false');
    el.replaceChildren();
    renderer(el, 11, row(field('text'), null), true);
    expect(el.querySelector('.rio-cell-row-header__number')?.textContent).toBe('12');
    const select = el.querySelector('[data-action="select"]');
    expect(select?.getAttribute('aria-label')).toBe('Select row 12');
    expect(select?.getAttribute('aria-checked')).toBe('true');
    expect(select?.getAttribute('role')).toBe('checkbox');
    const expand = el.querySelector('[data-action="expand"]');
    expect(expand?.getAttribute('aria-label')).toBe('Expand row 12');
    expect(expand?.querySelector('svg')).not.toBeNull();
  });

  it.each(textCases)('describes %s in English', (type, value, expected) => {
    const f = field(type);
    expect(describeCell(f, row(f, value), 11, format, t)).toBe(`Field, row 12: ${expected}`);
  });

  it.each([
    ['checkbox', true, 'checked'],
    ['checkbox', false, 'not checked'],
    ['checkbox', null, 'not checked'],
    ['text', null, 'empty'],
    ['number', 0, '0'],
    ['singleSelect', choices[0]!.id, 'Todo'],
    ['singleSelect', 'unknown', 'empty'],
    ['multipleSelect', choices.map((choice) => choice.id), 'Todo, Done'],
    ['multipleSelect', [], 'empty'],
    ['createdBy', null, 'Ada Lovelace'],
    ['lastModifiedBy', null, 'Ada Lovelace'],
  ] satisfies Array<[FieldType, CellValue, string]>)('describes %s value %s', (type, value, expected) => {
    const f = field(type, { choices });
    expect(describeCell(f, row(f, value), 0, format, t)).toBe(`Field, row 1: ${expected}`);
  });

  it('passes the exact IDs and named values to the translator', () => {
    const translated = setupI18n({
      locale: 'en-US',
      messages: {
        'en-US': {
          'grid.cell.describe': '{value} / {field} / {row}',
          'grid.cell.empty': 'EMPTY',
          'grid.row.select': 'SELECT {row}',
          'grid.row.expand': 'EXPAND {row}',
          'grid.header.primary': 'PRIMARY',
        },
      },
    });
    const translate = translated._.bind(translated);
    const f = field('text');
    expect(describeCell(f, row(f, null), 4, format, translate)).toBe('EMPTY / Field / 5');
    const el = document.createElement('div');
    createRowHeaderRenderer({ t: translate })(el, 4, undefined, false);
    expect(el.querySelector('[data-action="select"]')?.getAttribute('aria-label')).toBe('SELECT 5');
    expect(el.querySelector('[data-action="expand"]')?.getAttribute('aria-label')).toBe('EXPAND 5');
    createHeaderRenderer({ fieldsById: new Map([[f.id, f]]), primaryFieldId: f.id, t: translate })(
      el,
      column(f),
      0,
    );
    expect(el.getAttribute('aria-description')).toBe('PRIMARY');
  });
});
