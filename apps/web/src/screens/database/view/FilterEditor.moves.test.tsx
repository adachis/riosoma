import { useState } from 'react';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@lingui/react';
import { setupI18n } from '@lingui/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FieldMeta, isGroup, type FilterCondition, type FilterGroup } from '@riosoma/contracts';
import { FilterEditor } from './FilterEditor';
import { conditionsOf } from './filterValues';
import { identifyFilter } from './filterTree';

const fields = ['Name', 'Amount', 'Due', 'Notes'].map((name, index) =>
  FieldMeta.parse({
    id: `fld${String(index).padStart(14, '0')}`,
    tableId: 'tbl00000000000000',
    name,
    type: 'text',
    position: index,
    description: '',
    createdAt: '',
    updatedAt: '',
    options: {},
  }),
);
const condition = (index: number): FilterCondition => ({
  id: `c${index}`,
  fieldId: fields[index]!.id,
  operator: 'isNotEmpty',
});
const initial: FilterGroup = {
  conjunction: 'and',
  conditions: [
    condition(0),
    {
      id: 'outer',
      conjunction: 'or',
      conditions: [condition(1), { id: 'inner', conjunction: 'and', conditions: [condition(2)] }],
    },
    condition(3),
  ],
};
afterEach(cleanup);

function mount(value = initial, readOnly = false, readOnlyReason?: string) {
  const changed = vi.fn();
  function Host() {
    const [filter, setFilter] = useState<FilterGroup | null>(value);
    return (
      <FilterEditor
        fields={fields}
        value={filter}
        readOnly={readOnly}
        readOnlyReason={readOnlyReason}
        onChange={(next) => {
          setFilter(structuredClone(next));
          changed(next);
        }}
      />
    );
  }
  const result = render(
    <I18nProvider i18n={setupI18n({ locale: 'en-US', messages: { 'en-US': {} } })}>
      <Host />
    </I18nProvider>,
  );
  return { ...result, changed, latest: () => changed.mock.lastCall![0] as FilterGroup };
}
async function menu(handleName: string, action: string) {
  const row = screen.getByRole('button', { name: handleName }).closest('.rio-sortable-item') as HTMLElement;
  await userEvent.click(within(row).getByRole('button', { name: /^Move options for / }));
  await userEvent.click(screen.getByRole('menuitem', { name: action }));
}
function leads(container: HTMLElement) {
  return [...container.querySelectorAll('.rio-view-filter-group')].map((group) =>
    [...group.querySelectorAll(':scope > .rio-view-filter-entry > .rio-view-lead')].map(
      (lead) => lead.querySelector('.rio-select__value')?.textContent ?? lead.textContent,
    ),
  );
}

describe('filter moves', () => {
  it('moves conditions into and out of nested groups with correct conjunction labels', async () => {
    const { changed, latest, container } = mount();
    await menu('Move Notes', 'Move into the group above');
    expect(changed).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move Notes' })),
    );
    expect(document.querySelector('.rio-sortable-announcement')?.textContent).toContain('Dropped Notes');
    const outer = latest().conditions[1]!;
    expect(isGroup(outer) && outer.conditions.at(-1)).toEqual(condition(3));
    expect(leads(container)).toEqual([['Where', 'and'], ['Where', 'or', 'or'], ['Where']]);
    await menu('Move Notes', 'Move into the group above');
    expect(leads(container)).toEqual([
      ['Where', 'and'],
      ['Where', 'or'],
      ['Where', 'and'],
    ]);
    await menu('Move Notes', 'Move out of this group');
    await menu('Move Notes', 'Move out of this group');
    expect(latest()).toEqual(initial);
    expect(changed).toHaveBeenCalledTimes(4);
    await menu('Move Notes', 'Move up');
    expect(latest().conditions[1]).toEqual(condition(3));
    expect(leads(container)[0]).toEqual(['Where', 'and', 'and']);
  });

  it('moves a whole group, duplicates its conditions with new IDs, and removes the duplicate', async () => {
    const { latest } = mount();
    await menu('Move Condition group 2', 'Move down');
    expect(latest().conditions[2]).toEqual(initial.conditions[1]);
    const before = conditionsOf(latest()).map((entry) => entry.id);
    await userEvent.click(screen.getAllByRole('button', { name: 'Duplicate group' })[0]!);
    const all = conditionsOf(latest()).map((entry) => entry.id);
    expect(new Set(all).size).toBe(6);
    expect(all).toEqual(expect.arrayContaining(before));
    await userEvent.click(screen.getAllByRole('button', { name: 'Remove group' })[2]!);
    expect(conditionsOf(latest()).map((entry) => entry.id)).toEqual(before);
  });

  it('previews keyboard moves without changes, cancels, and commits one change on drop', async () => {
    const { changed, latest } = mount();
    const handle = screen.getByRole('button', { name: 'Move Notes' });
    act(() => handle.focus());
    await userEvent.keyboard(' {ArrowLeft}{ArrowUp}{Escape}');
    expect(changed).not.toHaveBeenCalled();
    expect(document.querySelector('.rio-sortable-announcement')?.textContent).toContain(
      'Canceled moving Notes',
    );
    await userEvent.keyboard('{Enter}{ArrowRight}{ArrowRight}');
    expect(changed).not.toHaveBeenCalled();
    expect(document.querySelector('.rio-sortable-announcement')?.textContent).toContain('Notes, position 2');
    await userEvent.keyboard(' ');
    expect(changed).toHaveBeenCalledTimes(1);
    const group = latest().conditions[1] as FilterGroup;
    expect((group.conditions[1] as FilterGroup).conditions[1]).toEqual(condition(3));
  });

  it('keeps a nested input focused when saved filters return as new objects', async () => {
    const { latest } = mount({
      conjunction: 'and',
      conditions: [{ conjunction: 'or', conditions: [{ ...condition(0), operator: 'contains', value: '' }] }],
    });
    const input = screen.getByRole('textbox', { name: 'Value' });
    await userEvent.type(input, 'Every character');
    expect(conditionsOf(latest())[0]?.value).toBe('Every character');
    expect(document.activeElement).toBe(input);
  });

  it('prunes groups emptied by moving a nested group out and accepts conditions into the remaining group', async () => {
    const empty: FilterGroup = { id: 'empty', conjunction: 'or', conditions: [] };
    const { changed, latest } = mount({
      conjunction: 'and',
      conditions: [condition(0), { conjunction: 'and', conditions: [empty] }, condition(1)],
    });
    await menu('Move Condition group 2.1', 'Move out of this group');
    expect(changed).toHaveBeenCalledTimes(1);
    expect(latest().conditions).toEqual([condition(0), empty, condition(1)]);
    await menu('Move Amount', 'Move into the group above');
    expect(changed).toHaveBeenCalledTimes(2);
    expect((latest().conditions[1] as FilterGroup).conditions).toEqual([condition(1)]);
  });

  it('keeps nested add controls mounted when their group gains children', async () => {
    mount();
    const add = screen.getAllByRole('button', { name: 'Add condition' })[0]!;
    await userEvent.click(add);
    expect(add.isConnected).toBe(true);
    expect(document.activeElement).toBe(add);
  });

  it('names move menus for their items', () => {
    mount();
    expect(screen.getByRole('button', { name: 'Move options for Notes' })).toBeDefined();
  });

  it('disables unavailable destinations and all editing in a read-only filter', async () => {
    const { changed } = mount();
    const row = screen
      .getByRole('button', { name: 'Move Name' })
      .closest('.rio-sortable-item') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /^Move options for / }));
    for (const name of ['Move up', 'Move into the group above', 'Move out of this group'])
      expect(screen.getByRole('menuitem', { name }).getAttribute('aria-disabled')).toBe('true');
    await userEvent.keyboard('{Escape}');
    expect(changed).not.toHaveBeenCalled();
    cleanup();
    mount(initial, true);
    for (const handle of screen.getAllByRole('button', { name: /^Move / }))
      expect((handle as HTMLButtonElement).disabled).toBe(true);
  });
  it('explains temporary read-only states without claiming a permission denial', () => {
    mount(initial, true, 'Saving changes');
    expect(screen.getByRole('button', { name: 'Move Notes' }).getAttribute('title')).toBe('Saving changes');
    cleanup();
    mount(initial, true);
    expect(screen.getByRole('button', { name: 'Move Notes' }).getAttribute('title')).toBe(
      'Rearranging is unavailable right now.',
    );
  });

  it('preserves nested input state when a peer adds a condition during editing', async () => {
    const group: FilterGroup = {
      id: 'nested',
      conjunction: 'or',
      conditions: [{ ...condition(0), operator: 'contains', value: '' }],
    };
    const value: FilterGroup = { conjunction: 'and', conditions: [group] };
    const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
    const changed = vi.fn();
    const result = render(
      <I18nProvider i18n={i18n}>
        <FilterEditor fields={fields} value={value} onChange={changed} />
      </I18nProvider>,
    );
    const input = screen.getByRole('textbox', { name: 'Value' });
    await userEvent.click(input);
    result.rerender(
      <I18nProvider i18n={i18n}>
        <FilterEditor
          fields={fields}
          value={{ ...value, conditions: [{ ...group, conditions: [...group.conditions, condition(1)] }] }}
          onChange={changed}
        />
      </I18nProvider>,
    );
    expect(screen.getByRole('textbox', { name: 'Value' })).toBe(input);
    expect(document.activeElement).toBe(input);
  });
  it('keeps focus when a peer first saves IDs for a legacy group', async () => {
    const value: FilterGroup = {
      conjunction: 'and',
      conditions: [{ conjunction: 'or', conditions: [{ ...condition(0), operator: 'contains', value: '' }] }],
    };
    const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
    const changed = vi.fn();
    const result = render(
      <I18nProvider i18n={i18n}>
        <FilterEditor fields={fields} value={value} onChange={changed} />
      </I18nProvider>,
    );
    const input = screen.getByRole('textbox', { name: 'Value' });
    await userEvent.click(input);
    const peer = identifyFilter(structuredClone(value));
    (peer.conditions[0] as FilterGroup).conditions.push(condition(1));
    result.rerender(
      <I18nProvider i18n={i18n}>
        <FilterEditor fields={fields} value={peer} onChange={changed} />
      </I18nProvider>,
    );
    expect(screen.getByRole('textbox', { name: 'Value' })).toBe(input);
    expect(document.activeElement).toBe(input);
  });
  it('announces the final position when moving the last child prunes its group', async () => {
    const { latest } = mount();
    await menu('Move Due', 'Move out of this group');
    expect((latest().conditions[1] as FilterGroup).conditions).toEqual([condition(1), condition(2)]);
    expect(document.querySelector('.rio-sortable-announcement')?.textContent).toBe(
      'Dropped Due, position 2 in Condition group 2.',
    );
  });
});
