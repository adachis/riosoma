import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FilterableList, normalizeFilter } from './FilterableList';
import { Select } from './Select';
import { ComboBox } from './ComboBox';
import { ListBoxItem } from './ListBox';

const wrapper = ({ children }: { children?: React.ReactNode }) => (
  <I18nProvider i18n={i18n}>{children}</I18nProvider>
);
const items = [
  { id: 'one', name: 'Café plans', group: 'work', groupName: 'Work' },
  { id: 'two', name: 'Travel notes', group: 'personal', groupName: 'Personal' },
];
beforeEach(() => localStorage.clear());

describe('filterable lists', () => {
  it('reaches the scrollable options by keyboard while filtering keeps virtual focus', async () => {
    const user = userEvent.setup();
    render(<FilterableList label="Bases" items={items} onSelectionChange={vi.fn()} />, { wrapper });
    const search = screen.getByRole('searchbox');
    await user.click(search);
    await user.keyboard('travel{ArrowDown}');
    expect(document.activeElement).toBe(search);
    await waitFor(() =>
      expect(search.getAttribute('aria-activedescendant')).toBe(
        screen.getByRole('option', { name: 'Travel notes' }).id,
      ),
    );
    expect(screen.getByRole('listbox', { name: 'Bases' }).tabIndex).toBe(0);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('listbox', { name: 'Bases' }));
  });

  it('matches accents and substrings and announces the remaining count', async () => {
    const user = userEvent.setup();
    render(<FilterableList label="Bases" listId="bases" items={items} onSelectionChange={vi.fn()} />, {
      wrapper,
    });
    await user.type(screen.getByRole('searchbox'), 'afe');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option', { name: 'Café plans' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('1 matching item');
    expect(normalizeFilter('CAFÉ')).toBe('cafe');
  });

  it('remembers collapsed groups independently for each list', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <FilterableList label="Bases" listId="first" items={items} onSelectionChange={vi.fn()} />,
      { wrapper },
    );
    await user.click(screen.getByRole('button', { name: 'Work (1)' }));
    expect(screen.queryByRole('option', { name: 'Café plans' })).toBeNull();
    rerender(<FilterableList label="Bases" listId="second" items={items} onSelectionChange={vi.fn()} />);
    expect(screen.getByRole('option', { name: 'Café plans' })).toBeTruthy();
    rerender(<FilterableList label="Bases" listId="first" items={items} onSelectionChange={vi.fn()} />);
    expect(screen.queryByRole('option', { name: 'Café plans' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Work (1)' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('chooses with arrows and Enter and remembers recent IDs without names', async () => {
    const user = userEvent.setup();
    const select = vi.fn();
    render(
      <FilterableList label="Bases" listId="recent" items={items} onSelectionChange={select} recentlyUsed />,
      { wrapper },
    );
    await user.click(screen.getByRole('searchbox'));
    await user.keyboard('travel{ArrowDown}{Enter}');
    expect(select).toHaveBeenCalledWith(new Set(['two']));
    expect(localStorage.getItem('rio.picker.recent.recent')).toBe('["two"]');
    expect(screen.queryByRole('button', { name: 'Recently used (1)' })).toBeNull();
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Travel notes']);
  });

  it('keeps hidden multiple selections when filtering', async () => {
    const user = userEvent.setup();
    const select = vi.fn();
    render(
      <FilterableList
        label="Bases"
        listId="multi"
        items={items}
        selectionMode="multiple"
        selectedKeys={['one']}
        onSelectionChange={select}
      />,
      { wrapper },
    );
    await user.type(screen.getByRole('searchbox'), 'Travel');
    await user.click(screen.getByRole('option', { name: 'Travel notes' }));
    expect(select).toHaveBeenCalledWith(new Set(['one', 'two']));
  });

  it('filters a large Select and preserves its selected value and form name', async () => {
    const user = userEvent.setup();
    const select = vi.fn();
    render(
      <Select label="Database" name="database" defaultSelectedKey="db-0" onSelectionChange={select}>
        {Array.from({ length: 30 }, (_, index) => (
          <ListBoxItem id={`db-${index}`} key={index}>{`Database ${index}`}</ListBoxItem>
        ))}
      </Select>,
      { wrapper },
    );
    await user.click(screen.getByRole('button', { name: /Database/ }));
    await user.type(screen.getByRole('searchbox'), '29');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /Database 0/ })).toBeTruthy();
    expect((document.querySelector('select[name="database"]') as HTMLSelectElement).value).toBe('db-0');
    await user.click(screen.getByRole('option', { name: 'Database 29' }));
    expect(select).toHaveBeenCalledWith('db-29');
    expect(screen.getByRole('button', { name: /Database 29/ })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Database 29/ }));
    expect(
      within(screen.getByRole('listbox'))
        .getByRole('option', { name: 'Database 29' })
        .getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('keeps unavailable options disabled with their explanation in a large Select', async () => {
    const user = userEvent.setup();
    const select = vi.fn();
    render(
      <Select label="Database" onSelectionChange={select}>
        {Array.from({ length: 12 }, (_, index) => (
          <ListBoxItem
            id={`db-${index}`}
            key={index}
            isDisabled={index === 11}
            description={index === 11 ? 'Access is required' : undefined}
          >
            {`Database ${index}`}
          </ListBoxItem>
        ))}
      </Select>,
      { wrapper },
    );
    await user.click(screen.getByRole('button', { name: /Database/ }));
    const option = screen.getByRole('option', { name: 'Database 11 Access is required' });
    expect(option.getAttribute('aria-disabled')).toBe('true');
    expect(option.textContent).toContain('Access is required');
    await user.click(option);
    expect(select).not.toHaveBeenCalled();
  });

  it('keeps a saved value when its group was collapsed in an earlier visit', async () => {
    localStorage.setItem('rio.picker.saved.collapsed', '["group:Saved"]');
    const user = userEvent.setup();
    render(
      <Select label="Database" listId="saved" name="database" defaultSelectedKey="db-0">
        {Array.from({ length: 12 }, (_, index) => (
          <ListBoxItem
            id={`db-${index}`}
            key={index}
            group={index < 6 ? 'Saved' : 'Other'}
          >{`Database ${index}`}</ListBoxItem>
        ))}
      </Select>,
      { wrapper },
    );
    expect(screen.getByRole('button', { name: /Database 0/ })).toBeTruthy();
    expect((document.querySelector('select[name="database"]') as HTMLSelectElement).value).toBe('db-0');
    await user.click(screen.getByRole('button', { name: /Database 0/ }));
    expect(screen.getByRole('button', { name: 'Saved (6)' }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('option', { name: 'Database 0' })).toBeNull();
  });
});

it('filters a large combo box through its own input and chooses with the keyboard', async () => {
  const user = userEvent.setup();
  const select = vi.fn();
  render(
    <ComboBox label="Member" listId="members" onSelectionChange={select}>
      {Array.from({ length: 30 }, (_, index) => (
        <ListBoxItem id={`member-${index}`} key={index}>{`Member ${index}`}</ListBoxItem>
      ))}
    </ComboBox>,
    { wrapper },
  );
  await user.type(screen.getByRole('combobox'), '29');
  expect(screen.getAllByRole('option')).toHaveLength(1);
  await user.keyboard('{ArrowDown}{Enter}');
  expect(select).toHaveBeenCalledWith('member-29');
  expect(localStorage.getItem('rio.picker.members.recent')).toBe('["member-29"]');
  expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('Member 29');
});

it('keeps a combo box value when its saved group is collapsed', async () => {
  localStorage.setItem('rio.picker.saved-members.collapsed', '["group:Planning"]');
  const user = userEvent.setup();
  render(
    <ComboBox label="Member" listId="saved-members" defaultSelectedKey="member-0">
      {Array.from({ length: 12 }, (_, index) => (
        <ListBoxItem
          id={`member-${index}`}
          key={index}
          group={index < 6 ? 'Planning' : 'Operations'}
        >{`Member ${index}`}</ListBoxItem>
      ))}
    </ComboBox>,
    { wrapper },
  );
  await user.click(screen.getByRole('button', { name: /Show suggestions/ }));
  expect(screen.queryByRole('option', { name: 'Member 0' })).toBeNull();
  expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('Member 0');
  await user.click(screen.getByRole('button', { name: /^Planning/ }));
  expect(screen.getByRole('option', { name: 'Member 0' }).getAttribute('aria-disabled')).not.toBe('true');
});

it('collapses combo box groups and keeps keyboard choices inside the visible groups', async () => {
  const user = userEvent.setup();
  const select = vi.fn();
  render(
    <ComboBox label="Member" listId="grouped-members" onSelectionChange={select}>
      {Array.from({ length: 30 }, (_, index) => (
        <ListBoxItem id={`member-${index}`} key={index} group={index < 15 ? 'Planning' : 'Operations'}>
          {`Member ${index}`}
        </ListBoxItem>
      ))}
    </ComboBox>,
    { wrapper },
  );
  await user.click(screen.getByRole('button', { name: /Show suggestions/ }));
  await user.click(screen.getByRole('button', { name: 'Planning (15)' }));
  expect(screen.queryByRole('option', { name: 'Member 0' })).toBeNull();
  expect(screen.getAllByRole('option')).toHaveLength(15);
  await user.click(screen.getByRole('combobox'));
  await user.keyboard('{ArrowDown}{Enter}');
  expect(select).toHaveBeenCalledWith('member-15');
  await user.clear(screen.getByRole('combobox'));
  await user.type(screen.getByRole('combobox'), '29');
  expect(screen.getByRole('option', { name: 'Member 29' })).toBeTruthy();
});

it('keeps filtering available when browser storage is blocked', async () => {
  const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('Storage blocked');
  });
  const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('Storage blocked');
  });
  try {
    const user = userEvent.setup();
    const select = vi.fn();
    render(
      <FilterableList label="Bases" listId="blocked" items={items} onSelectionChange={select} recentlyUsed />,
      { wrapper },
    );
    await user.type(screen.getByRole('searchbox'), 'cafe');
    await user.click(screen.getByRole('option', { name: 'Café plans' }));
    expect(select).toHaveBeenCalledWith(new Set(['one']));
  } finally {
    get.mockRestore();
    set.mockRestore();
  }
});
