import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { FilterableList, rememberPickerItem } from './FilterableList';
import { Select } from './Select';
import { ComboBox } from './ComboBox';
import { ListBoxItem } from './ListBox';

const wrapper = ({ children }: { children?: React.ReactNode }) => (
  <I18nProvider i18n={i18n}>{children}</I18nProvider>
);
const items = Array.from({ length: 12 }, (_, index) => ({ id: `item-${index}`, name: `Item ${index}` }));
beforeEach(() => localStorage.clear());

it.each(['root', ''])('keeps a selected option with key %j through a parent render', async (id) => {
  const user = userEvent.setup();
  const picker = () => (
    <Select label="Destination" selectedKey={id}>
      <ListBoxItem id={id}>None</ListBoxItem>
      {items.map((item) => (
        <ListBoxItem key={item.id} id={item.id} group={id}>
          {item.name}
        </ListBoxItem>
      ))}
    </Select>
  );
  const { rerender } = render(picker(), { wrapper });
  rerender(picker());
  expect(screen.getByRole('button', { name: /Destination/ }).textContent).toBe('None');
  await user.click(screen.getByRole('button', { name: /Destination/ }));
  expect(screen.getAllByRole('option')).toHaveLength(13);
});

it.each(['Item 11', 'missing'])('never submits a form from the filter with query %s', async (query) => {
  const user = userEvent.setup();
  const submit = vi.fn((event) => event.preventDefault());
  const select = vi.fn();
  render(
    <form onSubmit={submit}>
      <FilterableList
        label="Items"
        listId="enter"
        items={items}
        selectedKeys={['item-0']}
        onSelectionChange={select}
      />
      <button type="submit">Save</button>
    </form>,
    { wrapper },
  );
  await user.type(screen.getByRole('searchbox'), `${query}{Enter}`);
  expect(submit).not.toHaveBeenCalled();
  if (query === 'missing') expect(select).not.toHaveBeenCalled();
  else expect(select).toHaveBeenCalledWith(new Set(['item-11']));
});

it.each(['button', 'keyboard'])(
  'reopens every combo box option with a saved value using %s',
  async (trigger) => {
    const user = userEvent.setup();
    render(
      <ComboBox label="Item" defaultSelectedKey="item-0">
        {items.map((item) => (
          <ListBoxItem id={item.id} key={item.id}>
            {item.name}
          </ListBoxItem>
        ))}
      </ComboBox>,
      { wrapper },
    );
    for (let visit = 0; visit < 2; visit++) {
      if (trigger === 'button') await user.click(screen.getByRole('button', { name: /Show suggestions/ }));
      else {
        screen.getByRole('combobox').focus();
        await user.keyboard('{ArrowDown}');
      }
      expect(screen.getAllByRole('option')).toHaveLength(12);
      await user.keyboard('{Escape}');
    }
  },
);

it('searches optional keywords without changing the display label', async () => {
  const user = userEvent.setup();
  render(
    <FilterableList
      label="People"
      listId="people"
      items={[{ id: 'ada', name: 'Ada', searchText: 'ada@example.test' }]}
      onSelectionChange={vi.fn()}
    />,
    { wrapper },
  );
  await user.type(screen.getByRole('searchbox'), 'example');
  expect(screen.getByRole('option', { name: 'Ada' })).toBeTruthy();
});

it('announces only visible matches and names the collapse controls', async () => {
  const user = userEvent.setup();
  render(
    <FilterableList
      label="Items"
      listId="counts"
      items={items.map((item, index) => ({
        ...item,
        group: index < 6 ? 'First' : 'Second',
      }))}
      onSelectionChange={vi.fn()}
    />,
    { wrapper },
  );
  await user.click(screen.getByRole('button', { name: 'First (6)' }));
  expect(screen.getByRole('status').textContent).toBe('6 matching items');
  expect(within(screen.getByRole('group', { name: 'Groups' })).getAllByRole('button')).toHaveLength(2);
  await user.type(screen.getByRole('searchbox'), 'Item 0');
  expect(screen.getByRole('status').textContent).toBe('1 matching item');
  expect(screen.getByRole('option', { name: 'Item 0' })).toBeTruthy();
  await user.clear(screen.getByRole('searchbox'));
  expect(screen.getByRole('status').textContent).toBe('6 matching items');
  expect(screen.queryByRole('option', { name: 'Item 0' })).toBeNull();
});

it('ignores a saved collapse for the implicit group and offers no collapse toggle', () => {
  localStorage.setItem('rio.picker.ungrouped.collapsed', '["group:"]');
  render(<FilterableList label="Items" listId="ungrouped" items={items} onSelectionChange={vi.fn()} />, {
    wrapper,
  });
  expect(screen.getAllByRole('option')).toHaveLength(12);
  expect(screen.queryByRole('button', { name: 'All items (12)' })).toBeNull();
});

it('keeps recent rows stable until the picker mounts again', async () => {
  const user = userEvent.setup();
  const picker = (
    <FilterableList label="Items" listId="stable" items={items} recentlyUsed onSelectionChange={vi.fn()} />
  );
  const { unmount } = render(picker, { wrapper });
  await user.click(screen.getByRole('option', { name: 'Item 11' }));
  await user.click(screen.getByRole('option', { name: 'Item 10' }));
  expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(
    items.map((item) => item.name),
  );
  expect(JSON.parse(localStorage.getItem('rio.picker.stable.recent')!)).toEqual(['item-10', 'item-11']);
  unmount();
  render(picker, { wrapper });
  expect(
    screen
      .getAllByRole('option')
      .slice(0, 2)
      .map((option) => option.textContent),
  ).toEqual(['Item 10', 'Item 11']);
});

it('does not clear a required single choice when it is clicked again', async () => {
  const select = vi.fn();
  render(
    <FilterableList
      label="Items"
      listId="single"
      items={items}
      selectedKeys={['item-0']}
      onSelectionChange={select}
    />,
    { wrapper },
  );
  await userEvent.click(screen.getByRole('option', { name: 'Item 0' }));
  expect(select.mock.calls.every(([keys]) => keys.size === 1)).toBe(true);
  expect(screen.getByRole('option', { name: 'Item 0' }).getAttribute('aria-selected')).toBe('true');
});

it('keeps combo box display labels separate from searchable text', async () => {
  render(
    <ComboBox label="Member">
      {items.map((item) => (
        <ListBoxItem
          id={item.id}
          key={item.id}
          textValue={`${item.name} person@example.test`}
          description="person@example.test"
        >
          {item.name}
        </ListBoxItem>
      ))}
    </ComboBox>,
    { wrapper },
  );
  await userEvent.click(screen.getByRole('button', { name: /Show suggestions/ }));
  const option = screen.getByRole('option', { name: 'Item 0 person@example.test' });
  expect(option.querySelector('.rio-listbox-item__label')?.textContent).toBe('Item 0');
  expect(option.textContent).toBe('Item 0person@example.test');
});

it('commits native validation after choosing a long Select option', async () => {
  render(
    <form>
      <Select label="Item" isRequired errorMessage="Choose an item">
        {items.map((item) => (
          <ListBoxItem id={item.id} key={item.id}>
            {item.name}
          </ListBoxItem>
        ))}
      </Select>
    </form>,
    { wrapper },
  );
  fireEvent.invalid(document.querySelector('select')!);
  expect(await screen.findByText('Choose an item')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: /Item/ }));
  await userEvent.click(screen.getByRole('option', { name: 'Item 1' }));
  await waitFor(() => expect(screen.queryByText('Choose an item')).toBeNull());
});

it.each(['select', 'combo'])('does not persist an anonymous long %s', async (kind) => {
  const Picker = kind === 'select' ? Select : ComboBox;
  render(
    <Picker label="Items">
      {items.map((item) => (
        <ListBoxItem id={item.id} key={item.id}>
          {item.name}
        </ListBoxItem>
      ))}
    </Picker>,
    { wrapper },
  );
  await userEvent.click(
    screen.getByRole('button', { name: kind === 'select' ? /Items/ : /Show suggestions/ }),
  );
  await userEvent.click(screen.getByRole('option', { name: 'Item 1' }));
  expect(Object.keys(localStorage).filter((key) => key.startsWith('rio.picker.'))).toEqual([]);
});

it('links helper and error text to a listbox named by the question', () => {
  render(
    <>
      <span id="question">Assignees</span>
      <FilterableList
        label="People"
        aria-labelledby="question"
        listId="help"
        items={items}
        description="Choose a person"
        isInvalid
        errorMessage="A person is required"
        onSelectionChange={vi.fn()}
      />
    </>,
    { wrapper },
  );
  const list = screen.getByRole('listbox', { name: /Assignees/ });
  const descriptions = list
    .getAttribute('aria-describedby')
    ?.split(' ')
    .map((id) => document.getElementById(id)?.textContent);
  expect(descriptions).toEqual(expect.arrayContaining(['Choose a person', 'A person is required']));
});

it('caps stored picker identities and preserves unrelated preferences', () => {
  localStorage.setItem('theme', 'saved');
  for (let index = 0; index < 120; index++) rememberPickerItem(`list-${index}`, `item-${index}`);
  expect(Object.keys(localStorage).filter((key) => key.startsWith('rio.picker.'))).toHaveLength(100);
  expect(localStorage.getItem('rio.picker.list-119.recent')).toBe('["item-119"]');
  expect(localStorage.getItem('theme')).toBe('saved');
});

it('chooses the virtually focused match instead of the first match on Enter', async () => {
  const user = userEvent.setup();
  const submit = vi.fn((event) => event.preventDefault());
  const select = vi.fn();
  render(
    <form onSubmit={submit}>
      <FilterableList label="Items" listId="focus" items={items} onSelectionChange={select} />
      <button type="submit">Save</button>
    </form>,
    { wrapper },
  );
  await user.type(screen.getByRole('searchbox'), 'Item');
  await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
  expect(submit).not.toHaveBeenCalled();
  expect(select).toHaveBeenCalledWith(new Set(['item-1']));
});
