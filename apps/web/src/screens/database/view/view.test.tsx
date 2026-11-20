import { useState, type ReactElement } from 'react';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@lingui/react';
import { setupI18n } from '@lingui/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FieldMeta, GridConfig, LIMITS } from '@riosoma/contracts';
import type { FilterCondition, FilterGroup, Sort } from '@riosoma/contracts';
import { FilterEditor } from './FilterEditor';
import { dragItem } from '../../../test/sortable';
import { SortEditor } from './SortEditor';
import { HideFieldsEditor } from './HideFieldsEditor';
import { ViewToolbar } from './ViewToolbar';
import { conditionsOf } from './filterValues';
import { RestrictedFields } from '../permissions/restricted';
import { readFileSync } from 'node:fs';
const viewCss = readFileSync('src/screens/database/view/view.css', 'utf8');
const toolbarCss = readFileSync('src/components/responsive-toolbar.css', 'utf8');

const fields = [
  ['Name', 'text'],
  ['Amount', 'number'],
  ['Due', 'date'],
  ['Notes', 'longText'],
  ['Done', 'checkbox'],
  ['Status', 'singleSelect'],
  ['Tags', 'multipleSelect'],
  ['Author', 'createdBy'],
].map(([name, type], position) =>
  FieldMeta.parse({
    id: `fld${String(position).padStart(14, '0')}`,
    tableId: 'tbl00000000000000',
    name,
    type,
    position,
    description: '',
    createdAt: '',
    updatedAt: '',
    options:
      type === 'singleSelect' || type === 'multipleSelect'
        ? {
            choices: [
              { id: 'cho00000000000001', name: 'Open', color: 'blue' },
              { id: 'cho00000000000002', name: 'Closed', color: 'green' },
            ],
          }
        : {},
  }),
);
const primaryFieldId = fields[0]!.id;
const collaborators = new Map([
  ['usr00000000000001', { name: 'Alex' }],
  ['usr00000000000002', { name: 'Sam' }],
]);
const condition = (
  index = 0,
  operator: FilterCondition['operator'] = 'contains',
  value?: unknown,
): FilterCondition => ({
  id: `condition${index}`,
  fieldId: fields[index]!.id,
  operator,
  ...(value === undefined ? {} : { value }),
});

afterEach(cleanup);

function mount(ui: ReactElement, messages: Record<string, string> = {}) {
  const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': messages } });
  return { ...render(<I18nProvider i18n={i18n}>{ui}</I18nProvider>), i18n };
}

function filter(initial: FilterGroup | null = null) {
  const changed = vi.fn<(value: FilterGroup | null) => void>();
  function Host() {
    const [value, setValue] = useState(initial);
    return (
      <FilterEditor
        fields={fields}
        primaryFieldId={primaryFieldId}
        collaborators={collaborators}
        value={value}
        onChange={(value) => {
          setValue(value);
          changed(value);
        }}
      />
    );
  }
  mount(<Host />);
  return changed;
}

async function choose(name: RegExp, option: string, index = 0) {
  await userEvent.click(screen.getAllByRole('button', { name })[index]!);
  await userEvent.click(
    screen.getByRole('option', {
      name: (accessibleName) => accessibleName === option || accessibleName.startsWith(`${option} `),
    }),
  );
}

function latest(changed: ReturnType<typeof filter>) {
  return changed.mock.calls.at(-1)![0];
}

function sorts(initial: Sort[] = []) {
  const changed = vi.fn<(value: Sort[]) => void>();
  function Host() {
    const [value, setValue] = useState(initial);
    return (
      <SortEditor
        fields={fields}
        value={value}
        onChange={(value) => {
          setValue(value);
          changed(value);
        }}
      />
    );
  }
  mount(<Host />);
  return changed;
}

function hide(initial = { fieldOrder: [] as string[], hiddenFieldIds: [] as string[] }) {
  const changed = vi.fn<(value: typeof initial) => void>();
  function Host() {
    const [value, setValue] = useState(initial);
    return (
      <HideFieldsEditor
        {...value}
        fields={fields}
        primaryFieldId={primaryFieldId}
        onChange={(value) => {
          setValue(value);
          changed(value);
        }}
      />
    );
  }
  mount(<Host />);
  return changed;
}

describe('FilterEditor', () => {
  it('reports a complete tree with text, number, relative date, and a nested or group', async () => {
    const changed = filter();
    expect(screen.getByText('No filters')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Value' }), 'alpha');
    expect(conditionsOf(latest(changed))[0]?.value).toBe('alpha');
    await userEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    await choose(/Field/, 'Amount', 1);
    await userEvent.type(screen.getAllByRole('textbox', { name: 'Value' })[1]!, '12.5');
    expect(conditionsOf(latest(changed))[1]?.value).toBe(12.5);
    await userEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    await choose(/Field/, 'Due', 2);
    await choose(/Value/, 'number of days ago');
    await userEvent.clear(screen.getByRole('textbox', { name: 'Days' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Days' }), '7');
    expect(conditionsOf(latest(changed))[2]?.value).toEqual({ mode: 'daysAgo', days: 7 });
    await userEvent.click(screen.getByRole('button', { name: 'Add condition group' }));
    const groupId = (latest(changed)!.conditions[3] as FilterGroup).id;
    expect(groupId).toMatch(/^[a-f0-9]{32}$/);
    await userEvent.type(screen.getAllByRole('textbox', { name: 'Value' })[2]!, 'nested');
    await userEvent.click(screen.getAllByRole('button', { name: 'Add condition' })[0]!);
    await choose(/Match conditions/, 'or', 1);
    await userEvent.type(screen.getAllByRole('textbox', { name: 'Value' })[3]!, 'other');
    const result = latest(changed);
    const ids = conditionsOf(result).map((item) => item.id);
    expect(new Set(ids).size).toBe(5);
    expect(result).toEqual({
      conjunction: 'and',
      conditions: [
        { id: ids[0], fieldId: primaryFieldId, operator: 'contains', value: 'alpha' },
        { id: ids[1], fieldId: fields[1]!.id, operator: 'eq', value: 12.5 },
        { id: ids[2], fieldId: fields[2]!.id, operator: 'is', value: { mode: 'daysAgo', days: 7 } },
        {
          id: groupId,
          conjunction: 'or',
          conditions: [
            { id: ids[3], fieldId: primaryFieldId, operator: 'contains', value: 'nested' },
            { id: ids[4], fieldId: primaryFieldId, operator: 'contains', value: 'other' },
          ],
        },
      ],
    });
  });

  it('keeps compatible operators and values, resets incompatible ones, and clears foreign choices', async () => {
    const changed = filter({ conjunction: 'and', conditions: [condition(0, 'is', 'word')] });
    await choose(/Field/, 'Notes');
    expect(conditionsOf(latest(changed))[0]).toMatchObject({ operator: 'is', value: 'word' });
    await choose(/Field/, 'Due');
    expect(conditionsOf(latest(changed))[0]).toEqual({
      id: 'condition0',
      fieldId: fields[2]!.id,
      operator: 'is',
    });
    await choose(/Field/, 'Amount');
    expect(conditionsOf(latest(changed))[0]).toEqual({
      id: 'condition0',
      fieldId: fields[1]!.id,
      operator: 'eq',
    });
    await choose(/Condition/, 'is empty');
    expect(screen.queryByRole('textbox', { name: 'Value' })).toBeNull();
  });

  it('disables additions at the total count and nesting limits', () => {
    const leaf: FilterGroup = {
      conjunction: 'and',
      conditions: Array.from({ length: LIMITS.filterConditions }, (_, i) => ({
        ...condition(),
        id: String(i),
      })),
    };
    mount(
      <FilterEditor
        fields={fields}
        value={{ conjunction: 'and', conditions: [{ conjunction: 'and', conditions: [leaf] }] }}
        onChange={vi.fn()}
      />,
    );
    for (const button of screen.getAllByRole('button', { name: /^Add condition/ }))
      expect((button as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    mount(
      <FilterEditor
        fields={fields}
        value={{
          conjunction: 'and',
          conditions: [
            { conjunction: 'and', conditions: [{ conjunction: 'or', conditions: [condition()] }] },
          ],
        }}
        onChange={vi.fn()}
      />,
    );
    expect(
      (screen.getAllByRole('button', { name: 'Add condition group' })[0] as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getAllByRole('button', { name: 'Add condition group' })[1] as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('removes empty nested groups and reports null after the last condition', async () => {
    const changed = filter({
      conjunction: 'and',
      conditions: [{ conjunction: 'or', conditions: [condition()] }],
    });
    await userEvent.click(screen.getByRole('button', { name: 'Remove condition' }));
    expect(changed).toHaveBeenLastCalledWith(null);
    expect(screen.getByText('No filters')).toBeDefined();
  });

  it('shows the contract warning for an invalid condition but not an incomplete one', () => {
    mount(
      <FilterEditor
        fields={fields}
        value={{ conjunction: 'and', conditions: [condition(0, 'eq', 2), condition(1, 'eq')] }}
        onChange={vi.fn()}
      />,
    );
    const rows = screen.getAllByRole('group', { name: 'Condition' });
    expect(rows[0]!.getAttribute('aria-describedby')).toBeTruthy();
    expect(rows[1]!.getAttribute('aria-describedby')).toBeNull();
    expect(
      screen
        .getAllByText('This condition doesn’t fit this field’s type.')
        .filter((note) => note.getAttribute('aria-hidden') === 'false'),
    ).toHaveLength(1);
  });

  it('adds and removes choice pills, restricts is to one choice, and adds people avatars', async () => {
    const changed = filter({ conjunction: 'and', conditions: [condition(5, 'is')] });
    await userEvent.type(screen.getByRole('combobox', { name: 'Value' }), 'Open');
    await userEvent.click(screen.getByRole('option', { name: /^Open(?: |$)/ }));
    expect(conditionsOf(latest(changed))[0]?.value).toBe('cho00000000000001');
    await userEvent.type(screen.getByRole('combobox', { name: 'Value' }), 'Closed');
    await userEvent.click(screen.getByRole('option', { name: /^Closed(?: |$)/ }));
    expect(conditionsOf(latest(changed))[0]?.value).toBe('cho00000000000002');
    expect(screen.queryByRole('button', { name: 'Remove Open' })).toBeNull();
    await choose(/Condition/, 'is any of');
    for (const name of ['Open', 'Closed']) {
      await userEvent.type(screen.getByRole('combobox', { name: 'Value' }), name);
      await userEvent.click(
        screen.getByRole('option', {
          name: (accessibleName) => accessibleName === name || accessibleName.startsWith(`${name} `),
        }),
      );
    }
    expect(conditionsOf(latest(changed))[0]?.value).toEqual(['cho00000000000001', 'cho00000000000002']);
    await userEvent.click(screen.getByRole('button', { name: 'Remove Open' }));
    expect(conditionsOf(latest(changed))[0]?.value).toEqual(['cho00000000000002']);
    await choose(/Field/, 'Author');
    await userEvent.type(screen.getByRole('combobox', { name: 'Value' }), 'Alex');
    await userEvent.click(screen.getByRole('option', { name: /^Alex(?: |$)/ }));
    expect(screen.getByRole('img', { name: 'A: Alex' })).toBeDefined();
    expect(conditionsOf(latest(changed))[0]?.value).toEqual(['usr00000000000001']);
    await userEvent.click(screen.getByRole('button', { name: 'Remove Alex' }));
    expect(conditionsOf(latest(changed))[0]).not.toHaveProperty('value');
  });

  it('edits checkbox, exact date, and date ranges', async () => {
    const changed = filter({ conjunction: 'and', conditions: [condition(4, 'is', false)] });
    await userEvent.click(screen.getByRole('radio', { name: 'checked' }));
    expect(conditionsOf(latest(changed))[0]?.value).toBe(true);
    await choose(/Field/, 'Due');
    await choose(/Value/, 'exact date');
    expect(screen.getByRole('button', { name: /Choose a date/ })).toBeDefined();
    await choose(/Condition/, 'is within');
    await choose(/Value/, 'the past number of days');
    await userEvent.clear(screen.getByRole('textbox', { name: 'Days' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Days' }), '14');
    expect(conditionsOf(latest(changed))[0]?.value).toEqual({ mode: 'pastDays', days: 14 });
    await choose(/Value/, 'the next month');
    expect(conditionsOf(latest(changed))[0]?.value).toEqual({ mode: 'nextMonth' });
    expect(screen.queryByRole('textbox', { name: 'Days' })).toBeNull();
  });

  it('supports keyboard creation, field selection, typing, and removal', async () => {
    const changed = filter();
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add condition' }));
    await userEvent.keyboard('{Enter}');
    const field = screen.getByRole('button', { name: /Field/ });
    act(() => field.focus());
    await userEvent.keyboard('{Enter}');
    act(() => screen.getByRole('listbox').focus());
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(conditionsOf(latest(changed))[0]?.fieldId).toBe(fields[1]!.id);
    act(() => screen.getByRole('textbox', { name: 'Value' }).focus());
    await userEvent.keyboard('42');
    expect(conditionsOf(latest(changed))[0]?.value).toBe(42);
    act(() => screen.getByRole('button', { name: 'Remove condition' }).focus());
    await userEvent.keyboard('{Enter}');
    expect(changed).toHaveBeenLastCalledWith(null);
  });
});

describe('SortEditor', () => {
  async function addSort(name: string) {
    await userEvent.click(screen.getByRole('button', { name: 'Add sort' }));
    await userEvent.click(
      screen.getByRole('menuitem', {
        name: (accessibleName) => accessibleName === name || accessibleName.startsWith(`${name} `),
      }),
    );
  }

  it('picks a field before adding, changes direction, reorders with the keyboard, and removes', async () => {
    const changed = sorts();
    expect(screen.getByText('No sorts')).toBeDefined();
    // Opening the picker and dismissing it adds nothing, so the grid never sorts on a stray field.
    await userEvent.click(screen.getByRole('button', { name: 'Add sort' }));
    await userEvent.keyboard('{Escape}');
    expect(changed).not.toHaveBeenCalled();
    await addSort('Name');
    await addSort('Amount');
    await userEvent.click(screen.getByRole('radio', { name: '9 → 1' }));
    const handle = screen.getAllByRole('button', { name: 'Move sort' })[1]!;
    act(() => handle.focus());
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(changed).toHaveBeenLastCalledWith([
      { fieldId: fields[1]!.id, direction: 'desc' },
      { fieldId: primaryFieldId, direction: 'asc' },
    ]);
    expect(document.activeElement).toBe(handle);
    await userEvent.click(screen.getAllByRole('button', { name: /Field/ })[0]!);
    expect(screen.queryByRole('option', { name: /^Name(?: |$)/ })).toBeNull();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getAllByRole('button', { name: 'Remove sort' })[1]!);
    expect(changed).toHaveBeenLastCalledWith([{ fieldId: fields[1]!.id, direction: 'desc' }]);
  });

  it('uses direction labels for every family and supports dragging', async () => {
    const changed = sorts(fields.map((field) => ({ fieldId: field.id, direction: 'asc' })));
    for (const label of ['A → Z', '1 → 9', 'Oldest first', 'Unchecked first', 'First → last']) {
      expect(screen.getAllByRole('radio', { name: label }).length).toBeGreaterThan(0);
    }
    const handles = screen.getAllByRole('button', { name: 'Move sort' });
    await dragItem(handles[1]!, handles[2]!);
    expect(changed.mock.calls.at(-1)![0].map((sort) => sort.fieldId)).toEqual([
      fields[0]!.id,
      fields[2]!.id,
      fields[1]!.id,
      ...fields.slice(3).map((field) => field.id),
    ]);
    expect((screen.getByRole('button', { name: 'Add sort' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables adding at the sort limit even when more fields are available', () => {
    const manyFields = Array.from({ length: LIMITS.sortsPerView + 1 }, (_, index) => ({
      ...fields[0]!,
      id: `fld${String(index).padStart(14, '0')}`,
    }));
    mount(
      <SortEditor
        fields={manyFields}
        value={manyFields
          .slice(0, LIMITS.sortsPerView)
          .map((field) => ({ fieldId: field.id, direction: 'asc' }))}
        onChange={vi.fn()}
      />,
    );
    expect((screen.getByRole('button', { name: 'Add sort' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('HideFieldsEditor', () => {
  it('follows display order, searches, protects the primary field, and shows/hides all fields', async () => {
    const changed = hide({
      fieldOrder: [fields[2]!.id, fields[1]!.id],
      hiddenFieldIds: [primaryFieldId, fields[1]!.id],
    });
    expect(
      screen
        .getAllByRole('switch')
        .slice(0, 3)
        .map((item) => item.closest('.rio-switch')?.textContent),
    ).toEqual(['Name', 'Due', 'Amount']);
    const primary = screen.getByRole('switch', { name: 'Name' }) as HTMLInputElement;
    expect(primary.checked).toBe(true);
    expect(primary.disabled).toBe(true);
    await userEvent.click(primary);
    expect(changed).not.toHaveBeenCalled();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Find a field' }), 'AMO');
    expect(screen.getAllByRole('switch')).toHaveLength(1);
    await userEvent.click(screen.getByRole('switch', { name: 'Amount' }));
    expect(changed.mock.calls.at(-1)![0].hiddenFieldIds).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Hide all' }));
    expect(changed.mock.calls.at(-1)![0].hiddenFieldIds).toHaveLength(fields.length - 1);
    expect(changed.mock.calls.at(-1)![0].hiddenFieldIds).not.toContain(primaryFieldId);
    await userEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(changed.mock.calls.at(-1)![0].hiddenFieldIds).toEqual([]);
  });

  it('reorders by keyboard and drag while keeping primary first', async () => {
    const changed = hide();
    const handle = screen.getByRole('button', { name: 'Move Due' });
    act(() => handle.focus());
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(changed.mock.calls.at(-1)![0].fieldOrder.slice(0, 3)).toEqual([
      primaryFieldId,
      fields[2]!.id,
      fields[1]!.id,
    ]);
    expect(document.activeElement).toBe(handle);
    const count = changed.mock.calls.length;
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(changed).toHaveBeenCalledTimes(count);
    await dragItem(handle, screen.getByRole('button', { name: 'Move Notes' }));
    expect(changed.mock.calls.at(-1)![0].fieldOrder.slice(0, 4)).toEqual([
      primaryFieldId,
      fields[1]!.id,
      fields[3]!.id,
      fields[2]!.id,
    ]);
  });
});

describe('ViewToolbar', () => {
  it.each([false, true])('explains locked grips for a viewer with read-only access %s', async (readOnly) => {
    const changed = vi.fn();
    mount(
      <ViewToolbar
        config={GridConfig.parse({
          locked: true,
          filter: { conjunction: 'and', conditions: [condition()] },
          sorts: [{ fieldId: primaryFieldId, direction: 'asc' }],
          groups: [{ fieldId: primaryFieldId, direction: 'asc' }],
        })}
        fields={fields}
        primaryFieldId={primaryFieldId}
        readOnly={readOnly}
        groupable
        onConfigChange={changed}
      />,
    );
    // The group button reads its state, while its dialog keeps the name Group.
    for (const [button, dialog] of [
      ['Filtered by Name', 'Filtered by Name'],
      ['Sorted by Name', 'Sorted by Name'],
      ['Hide fields', 'Hide fields'],
      ['Grouped by 1 field', 'Group'],
    ] as const) {
      await userEvent.click(screen.getByRole('button', { name: button }));
      const panel = screen.getByRole('dialog', { name: dialog });
      const grips = panel.querySelectorAll<HTMLButtonElement>('.rio-sortable-handle');
      expect(grips.length).toBeGreaterThan(0);
      for (const grip of grips) {
        expect(grip.disabled).toBe(true);
        expect(grip.title).toBe(
          readOnly ? 'You don’t have permission to rearrange these items.' : 'This view is locked.',
        );
      }
      await userEvent.keyboard('{Escape}');
    }
    expect(changed).not.toHaveBeenCalled();
  });

  it('labels active controls, counts unique fields, and preserves explicit translation variables', () => {
    const config = GridConfig.parse({
      hiddenFieldIds: [fields[1]!.id, fields[2]!.id, primaryFieldId],
      filter: {
        conjunction: 'and',
        conditions: [
          condition(5, 'is', 'cho00000000000001'),
          { ...condition(5, 'isNot', 'cho00000000000002'), id: 'second' },
        ],
      },
      sorts: [
        { fieldId: primaryFieldId, direction: 'asc' },
        { fieldId: fields[1]!.id, direction: 'desc' },
      ],
      rowHeight: 'tall',
    });
    mount(
      <ViewToolbar
        config={config}
        fields={fields}
        primaryFieldId={primaryFieldId}
        onConfigChange={vi.fn()}
      />,
      {
        'view.toolbar.filteredBy': 'Filtered by {name}',
        'view.toolbar.sortedByMany': '{count, plural, one {Sorted by # field} other {Sorted by # fields}}',
        'view.toolbar.hidden': '{count, plural, one {# hidden field} other {# hidden fields}}',
      },
    );
    for (const name of ['2 hidden fields', 'Filtered by Status', 'Sorted by 2 fields', 'Row height']) {
      expect(screen.getByRole('button', { name }).hasAttribute('data-active')).toBe(true);
    }
  });

  it('makes the lock control a fingertip-size primary action like the other controls', () => {
    mount(
      <ViewToolbar
        config={GridConfig.parse({})}
        fields={fields}
        primaryFieldId={primaryFieldId}
        onConfigChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Lock view' }).hasAttribute('data-primary-action')).toBe(true);
  });

  it('counts a field the person can’t see as one field, and a field that’s gone not at all', async () => {
    const restricted = 'fld99999999999991';
    const gone = 'fld99999999999992';
    const shown = fields.filter((field) => field.name !== 'Amount');
    const toolbar = (config: GridConfig) => (
      <RestrictedFields.Provider value={new Set([restricted])}>
        <ViewToolbar
          config={config}
          fields={shown}
          primaryFieldId={primaryFieldId}
          readOnly
          onConfigChange={vi.fn()}
        />
      </RestrictedFields.Provider>
    );
    const { rerender } = mount(
      toolbar(
        GridConfig.parse({
          filter: {
            conjunction: 'and',
            conditions: [{ id: 'restricted', fieldId: restricted, operator: 'isNotEmpty' }],
          },
          sorts: [
            { fieldId: restricted, direction: 'desc' },
            { fieldId: gone, direction: 'asc' },
          ],
        }),
      ),
    );
    for (const name of ['Filtered by 1 field', 'Sorted by 1 field'])
      expect(screen.getByRole('button', { name }).hasAttribute('data-active')).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Sorted by 1 field' }));
    expect(
      within(screen.getByRole('dialog')).getByRole('button', { name: /Restricted field/ }),
    ).toBeDefined();
    await userEvent.keyboard('{Escape}');

    rerender(
      <I18nProvider i18n={setupI18n({ locale: 'en-US', messages: { 'en-US': {} } })}>
        {toolbar(
          GridConfig.parse({
            filter: {
              conjunction: 'or',
              conditions: [
                { id: 'restricted', fieldId: restricted, operator: 'isNotEmpty' },
                { ...condition(4, 'is', true), id: 'done' },
              ],
            },
            sorts: [
              { fieldId: gone, direction: 'asc' },
              { fieldId: primaryFieldId, direction: 'asc' },
            ],
          }),
        )}
      </I18nProvider>,
    );
    expect(screen.getByRole('button', { name: 'Filtered by 2 fields' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Sorted by Name' })).toBeDefined();

    rerender(
      <I18nProvider i18n={setupI18n({ locale: 'en-US', messages: { 'en-US': {} } })}>
        {toolbar(GridConfig.parse({ sorts: [{ fieldId: gone, direction: 'asc' }] }))}
      </I18nProvider>,
    );
    expect(screen.getByRole('button', { name: 'Sort' }).hasAttribute('data-active')).toBe(false);
  });

  it('opens controls by keyboard and reports complete config patches', async () => {
    const changed = vi.fn();
    mount(
      <ViewToolbar
        config={GridConfig.parse({})}
        fields={fields}
        primaryFieldId={primaryFieldId}
        onConfigChange={changed}
      />,
    );
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Hide fields' }));
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('dialog', { name: 'Hide fields' })).toBeDefined();
    await userEvent.click(screen.getByRole('switch', { name: 'Amount' }));
    expect(changed).toHaveBeenLastCalledWith({
      fieldOrder: fields.map((field) => field.id),
      hiddenFieldIds: [fields[1]!.id],
    });
    await userEvent.keyboard('{Escape}');
    await userEvent.keyboard('{ArrowRight}{Enter}');
    expect(screen.getByRole('dialog', { name: 'Filter' })).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    expect(changed).toHaveBeenLastCalledWith({
      filter: {
        conjunction: 'and',
        conditions: [{ id: expect.any(String), fieldId: primaryFieldId, operator: 'contains' }],
      },
    });
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'Row height' }));
    expect(screen.getByRole('menuitemradio', { name: 'Short' }).getAttribute('aria-checked')).toBe('true');
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'Tall' }));
    expect(changed).toHaveBeenLastCalledWith({ rowHeight: 'tall' });
  });

  it('explains why a read-only filter cannot be rearranged', async () => {
    mount(
      <ViewToolbar
        config={GridConfig.parse({
          filter: { conjunction: 'and', conditions: [condition(0, 'contains', 'Deal')] },
        })}
        fields={fields}
        primaryFieldId={primaryFieldId}
        readOnly
        onConfigChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Filtered by Name' }));
    expect(
      screen.getAllByRole('group', { name: 'You don’t have permission to rearrange these items.' }).length,
    ).toBeGreaterThan(0);
  });

  it('keeps controls inspectable but prevents all changes in read-only views', async () => {
    const changed = vi.fn();
    mount(
      <ViewToolbar
        config={GridConfig.parse({
          filter: { conjunction: 'and', conditions: [condition(4, 'is', false)] },
          sorts: [{ fieldId: primaryFieldId, direction: 'asc' }],
        })}
        fields={fields}
        primaryFieldId={primaryFieldId}
        onConfigChange={changed}
        readOnly
      />,
    );
    for (const name of ['Hide fields', 'Filtered by Done', 'Sorted by Name']) {
      await userEvent.click(screen.getByRole('button', { name }));
      const dialog = screen.getByRole('dialog', { name });
      const help = within(dialog).getByRole('button', { name: `Help with ${name}` }) as HTMLButtonElement;
      expect(help.disabled).toBe(false);
      for (const button of within(dialog).queryAllByRole('button'))
        if (button !== help) expect((button as HTMLButtonElement).disabled).toBe(true);
      await userEvent.click(help);
      expect(changed).not.toHaveBeenCalled();
      await userEvent.keyboard('{Escape}');
    }
    await userEvent.click(screen.getByRole('button', { name: 'Row height' }));
    for (const item of screen.getAllByRole('menuitemradio'))
      expect(item.getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'Tall' }));
    expect(changed).not.toHaveBeenCalled();
  });

  it('keeps accessible icon names independent of measured label visibility', () => {
    const { container } = mount(
      <div style={{ inlineSize: 220 }}>
        <ViewToolbar
          config={GridConfig.parse({})}
          fields={fields}
          primaryFieldId={primaryFieldId}
          onConfigChange={vi.fn()}
        />
      </div>,
    );
    for (const name of ['Hide fields', 'Filter', 'Sort', 'Row height']) {
      const button = screen.getByRole('button', { name });
      expect(button.textContent).toBe(name);
      expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    }
    expect(container.querySelector('.rio-view-toolbar-container')).not.toBeNull();
    // Measured modes keep whole labels and move overflow controls out of the visible row.
    expect(toolbarCss).not.toContain('text-overflow: ellipsis');
    expect(toolbarCss).toMatch(/\.rio-responsive-toolbar__label\s*\{[^}]*flex: none/);
    expect(toolbarCss).toMatch(/\[data-fit='overflow'\]\s*\{\s*display: none/);
    expect(viewCss).toMatch(/\.rio-view-toolbar\s*\{[^}]*block-size:/);
  });
});

it('keeps higher-priority view controls visible and opens overflow editors', async () => {
  let resize = (_width: number) => {};
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const width = this.classList.contains('rio-responsive-toolbar')
      ? 1000
      : this.dataset.fit === 'full'
        ? 120
        : this.dataset.fit === 'short'
          ? 70
          : 40;
    return { width, height: 40, top: 0, left: 0, right: width, bottom: 40, x: 0, y: 0, toJSON: () => ({}) };
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(element: Element) {
        if (element.classList.contains('rio-responsive-toolbar'))
          resize = (width) =>
            act(() =>
              this.callback(
                [{ contentRect: { width } } as ResizeObserverEntry],
                this as unknown as ResizeObserver,
              ),
            );
      }
      disconnect() {}
      unobserve() {}
    },
  );
  try {
    const changed = vi.fn();
    const { container } = mount(
      <ViewToolbar
        config={GridConfig.parse({
          filter: { conjunction: 'and', conditions: [condition(1, 'gt', 0)] },
          sorts: [{ fieldId: fields[1]!.id, direction: 'asc' }],
          colorRules: [{ id: 'amount', target: 'record', condition: condition(1, 'gt', 0), color: 'blue' }],
        })}
        fields={fields}
        primaryFieldId={primaryFieldId}
        onConfigChange={changed}
        groupable
        colorable
      />,
    );
    const modes = () =>
      [...container.querySelectorAll('[data-item]')].map((node) => [
        node.getAttribute('data-item'),
        node.getAttribute('data-fit'),
      ]);
    expect(modes().every(([, mode]) => mode === 'full')).toBe(true);
    resize(500);
    expect(modes()).toEqual([
      ['hide', 'icon'],
      ['filter', 'full'],
      ['sort', 'full'],
      ['group', 'icon'],
      ['color', 'icon'],
      ['height', 'icon'],
      ['lock', 'icon'],
    ]);
    resize(160);
    expect(modes()).toEqual([
      ['hide', 'overflow'],
      ['filter', 'icon'],
      ['sort', 'icon'],
      ['group', 'icon'],
      ['color', 'overflow'],
      ['height', 'overflow'],
      ['lock', 'overflow'],
    ]);
    const more = screen.getByRole('button', { name: 'More' });
    await userEvent.click(more);
    await userEvent.click(screen.getByRole('menuitem', { name: /^1 color rule(?: |$)/ }));
    expect(screen.getByRole('dialog', { name: '1 color rule' })).toBeDefined();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(more);
    await userEvent.click(screen.getByRole('menuitem', { name: /^Row height(?: |$)/ }));
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'Tall' }));
    expect(changed).toHaveBeenCalledWith({ rowHeight: 'tall' });
  } finally {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it('describes grouping state and makes locked status inspectable without an action', async () => {
  const changed = vi.fn();
  mount(
    <ViewToolbar
      config={GridConfig.parse({ locked: true, groups: [{ fieldId: primaryFieldId, direction: 'asc' }] })}
      fields={fields}
      primaryFieldId={primaryFieldId}
      groupable
      readOnly
      onConfigChange={changed}
    />,
  );
  expect(screen.getByRole('button', { name: 'Grouped by 1 field' })).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Locked view' })).toBeNull();
  const status = screen.getByRole('img', { name: 'Locked view' });
  expect(status.tabIndex).toBe(0);
  await userEvent.tab();
  act(() => status.focus());
  expect((await screen.findByRole('tooltip')).textContent).toBe('Locked view');
  await userEvent.keyboard('{Enter}');
  expect(changed).not.toHaveBeenCalled();
});

it('keeps the grouping dialog name stable while its button gains state', async () => {
  function Host() {
    const [config, setConfig] = useState(GridConfig.parse({}));
    return (
      <ViewToolbar
        config={config}
        fields={fields}
        primaryFieldId={primaryFieldId}
        groupable
        onConfigChange={(patch) => setConfig((current) => ({ ...current, ...patch }))}
      />
    );
  }
  mount(<Host />);
  await userEvent.click(screen.getByRole('button', { name: 'Group' }));
  await userEvent.click(
    within(screen.getByRole('dialog', { name: 'Group' })).getByRole('button', {
      name: 'Add group',
    }),
  );
  await userEvent.click(screen.getByRole('menuitem', { name: /^Status(?: |$)/ }));
  expect(screen.getByRole('dialog', { name: 'Group' })).toBeDefined();
  expect(screen.getByRole('button', { name: 'Grouped by 1 field' })).toBeDefined();
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
});
