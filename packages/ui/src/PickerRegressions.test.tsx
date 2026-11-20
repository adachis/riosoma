import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { ComboBox } from './ComboBox';
import { FilterableList, rememberPickerItem } from './FilterableList';
import { ListBoxItem } from './ListBox';

const wrapper = ({ children }: { children?: React.ReactNode }) => (
  <I18nProvider i18n={i18n}>{children}</I18nProvider>
);
const items = Array.from({ length: 12 }, (_, index) => ({
  id: `item-${index}`,
  name: `Item ${index}`,
  group: index < 6 ? 'Planning' : 'Operations',
}));
beforeEach(() => localStorage.clear());

it('keeps multiple selections when Escape clears the filter and is pressed again', async () => {
  const user = userEvent.setup();
  const select = vi.fn();
  render(
    <FilterableList
      label="Items"
      items={items}
      selectionMode="multiple"
      selectedKeys={['item-0', 'item-8']}
      onSelectionChange={select}
    />,
    { wrapper },
  );
  await user.type(screen.getByRole('searchbox'), 'Item 8{Escape}{Escape}');
  expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('');
  expect(select).not.toHaveBeenCalled();
  expect(screen.getAllByRole('option', { selected: true })).toHaveLength(2);
});

it.each(['single', 'multiple'] as const)(
  'keeps a %s selection on empty Enter without submitting',
  async (selectionMode) => {
    const user = userEvent.setup();
    const select = vi.fn();
    const submit = vi.fn((event) => event.preventDefault());
    render(
      <form onSubmit={submit}>
        <FilterableList
          label="Items"
          items={items}
          selectionMode={selectionMode}
          selectedKeys={['item-8']}
          onSelectionChange={select}
        />
        <button type="submit">Save</button>
      </form>,
      { wrapper },
    );
    await user.click(screen.getByRole('searchbox'));
    await user.keyboard('{Enter}');
    expect(submit).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  },
);

it('keeps an already selected first match when Enter accepts a multiple selection', async () => {
  const user = userEvent.setup();
  const select = vi.fn();
  render(
    <FilterableList
      label="Items"
      items={items}
      selectionMode="multiple"
      selectedKeys={['item-0', 'item-8']}
      onSelectionChange={select}
    />,
    { wrapper },
  );
  await user.type(screen.getByRole('searchbox'), 'Item 0{Enter}');
  expect(select).toHaveBeenCalledWith(new Set(['item-0', 'item-8']));
});

it.each(['group:Planning', 'recent'])(
  'searches matches inside the saved collapsed group %s',
  async (group) => {
    localStorage.setItem('rio.picker.matches.collapsed', JSON.stringify([group]));
    localStorage.setItem('rio.picker.matches.recent', '["item-0"]');
    const user = userEvent.setup();
    render(
      <FilterableList
        label="Items"
        listId="matches"
        items={items}
        recentlyUsed={group === 'recent'}
        onSelectionChange={vi.fn()}
      />,
      { wrapper },
    );
    expect(screen.queryByRole('option', { name: 'Item 0' })).toBeNull();
    await user.type(screen.getByRole('searchbox'), 'Item 0');
    expect(screen.getByRole('option', { name: 'Item 0' })).toBeTruthy();
    await user.clear(screen.getByRole('searchbox'));
    expect(screen.queryByRole('option', { name: 'Item 0' })).toBeNull();
    expect(localStorage.getItem('rio.picker.matches.collapsed')).toBe(JSON.stringify([group]));
  },
);

it('keeps a single named group expanded even if its collapse was saved', () => {
  localStorage.setItem('rio.picker.only.collapsed', '["group:Planning"]');
  render(
    <FilterableList label="Items" listId="only" items={items.slice(0, 6)} onSelectionChange={vi.fn()} />,
    { wrapper },
  );
  expect(screen.queryByRole('button', { name: 'Planning (6)' })).toBeNull();
  expect(screen.getAllByRole('option')).toHaveLength(6);
});

it('leaves ungrouped rows untitled beside named sections', () => {
  render(
    <FilterableList
      label="Items"
      items={[{ id: 'none', name: 'No image' }, ...items]}
      onSelectionChange={vi.fn()}
    />,
    { wrapper },
  );
  expect(within(screen.getByRole('listbox')).queryByText('All items')).toBeNull();
  expect(screen.getByRole('option', { name: 'No image' })).toBeTruthy();
});

it('evicts the least recently used list independently of storage key order', () => {
  const index: Record<string, number> = {};
  for (let number = 98; number >= 0; number--) {
    localStorage.setItem(`rio.picker.list-${number}.recent`, '["item-0"]');
    index[`list-${number}`] = number + 1;
  }
  localStorage.setItem('rio.picker.index', JSON.stringify(index));
  rememberPickerItem('new', 'item-8');
  expect(localStorage.getItem('rio.picker.list-0.recent')).toBeNull();
  expect(localStorage.getItem('rio.picker.list-98.recent')).toBe('["item-0"]');
  expect(JSON.parse(localStorage.getItem('rio.picker.index')!)).not.toHaveProperty('list-0');
  expect(Object.keys(localStorage)).toHaveLength(100);
});

it('refreshes a list when opened and evicts both preferences of the oldest list', () => {
  const index: Record<string, number> = {};
  for (let number = 0; number < 98; number++) {
    localStorage.setItem(`rio.picker.list-${number}.recent`, '["item-0"]');
    index[`list-${number}`] = number + 1;
  }
  localStorage.setItem('rio.picker.list-1.collapsed', '["group:Planning"]');
  localStorage.setItem('rio.picker.index', JSON.stringify(index));
  render(<FilterableList label="Items" listId="list-0" items={items} onSelectionChange={vi.fn()} />, {
    wrapper,
  });
  rememberPickerItem('new', 'item-8');
  expect(localStorage.getItem('rio.picker.list-0.recent')).toBe('["item-0"]');
  expect(localStorage.getItem('rio.picker.list-1.recent')).toBeNull();
  expect(localStorage.getItem('rio.picker.list-1.collapsed')).toBeNull();
});

it('focuses the saved choice after a controlled query closes on blur', async () => {
  const user = userEvent.setup();
  const select = vi.fn();
  const opened = vi.fn();
  const picker = (query: string) => (
    <ComboBox
      label="Item"
      selectedKey="item-0"
      inputValue={query}
      onSelectionChange={select}
      onOpenChange={opened}
    >
      {items.map((item) => (
        <ListBoxItem key={item.id} id={item.id}>
          {item.name}
        </ListBoxItem>
      ))}
    </ComboBox>
  );
  const { rerender } = render(picker('Item 0'), { wrapper });
  const input = screen.getByRole('combobox');
  await user.click(screen.getByRole('button', { name: /Show suggestions/ }));
  rerender(picker('Item 8'));
  expect(screen.getAllByRole('option')).toHaveLength(1);
  await user.keyboard('{Tab}');
  expect(input.getAttribute('aria-expanded')).toBe('false');
  opened.mockClear();
  rerender(picker('Item 0'));
  expect(input.getAttribute('aria-expanded')).toBe('false');
  input.focus();
  await user.keyboard('{ArrowDown}');
  expect(document.getElementById(input.getAttribute('aria-activedescendant')!)?.textContent).toBe('Item 0');
  await user.keyboard('{Enter}');
  expect(select.mock.calls.every(([value]) => value === 'item-0')).toBe(true);
  expect(opened.mock.calls.map(([isOpen]) => isOpen)).toEqual([true, false]);
});

it('names recent and home sections in long combo boxes and searches collapsed recent choices', async () => {
  localStorage.setItem('rio.picker.sections.recent', '["item-8"]');
  localStorage.setItem('rio.picker.sections.collapsed', '["recent"]');
  const user = userEvent.setup();
  const select = vi.fn();
  render(
    <ComboBox label="Item" listId="sections" onSelectionChange={select}>
      {items.map((item) => (
        <ListBoxItem key={item.id} id={item.id} group={item.group}>
          {item.name}
        </ListBoxItem>
      ))}
    </ComboBox>,
    { wrapper },
  );
  await user.click(screen.getByRole('button', { name: /Show suggestions/ }));
  expect(within(screen.getByRole('group', { name: 'Planning' })).getAllByRole('option')).toHaveLength(6);
  await user.type(screen.getByRole('combobox'), 'Item 8');
  expect(
    within(screen.getByRole('group', { name: 'Recently used' })).getByRole('option', {
      name: 'Item 8',
    }),
  ).toBeTruthy();
  await user.keyboard('{ArrowDown}{Enter}');
  expect(select).toHaveBeenCalledWith('item-8');
});
