import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { describe, expect, it, vi } from 'vitest';
import { ComboBox } from './ComboBox';
import { ListBoxItem } from './ListBox';

// The combo box reads its own strings through Lingui, which needs a provider above it.
const wrapper = ({ children }: { children?: React.ReactNode }) => (
  <I18nProvider i18n={i18n}>{children}</I18nProvider>
);

function fruitComboBox(props: Partial<Parameters<typeof ComboBox>[0]> = {}) {
  return (
    <ComboBox label="Fruit" {...props}>
      <ListBoxItem id="apple">Apple</ListBoxItem>
      <ListBoxItem id="apricot">Apricot</ListBoxItem>
      <ListBoxItem id="banana">Banana</ListBoxItem>
    </ComboBox>
  );
}

async function openList(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /Show suggestions/ }));
  return screen.getByRole('listbox');
}

describe('ComboBox', () => {
  it('keeps hidden outside controls out of the tab order and restores them on dismissal', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button>Before</button>
        {fruitComboBox({})}
        <button>After</button>
      </>,
      { wrapper },
    );
    const before = screen.getByRole('button', { name: 'Before' });
    const after = screen.getByRole('button', { name: 'After' });
    await openList(user);
    expect(before.tabIndex).toBe(-1);
    expect(after.tabIndex).toBe(-1);
    await user.keyboard('{Escape}');
    expect(before.tabIndex).toBe(0);
    expect(after.tabIndex).toBe(0);
    await user.type(screen.getByRole('combobox', { name: 'Fruit' }), 'ap');
    await user.tab();
    expect(document.activeElement).toBe(after);
  });

  it('labels its input and names its own button', () => {
    render(fruitComboBox({ description: 'Type to narrow it down' }), { wrapper });

    const input = screen.getByRole('combobox', { name: 'Fruit' });
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('button', { name: /Show suggestions/ })).toBeTruthy();
    expect(screen.getByText('Type to narrow it down')).toBeTruthy();
  });

  it('takes a placeholder', () => {
    render(fruitComboBox({ placeholder: 'Search fruit' }), { wrapper });

    expect(screen.getByRole('combobox', { name: 'Fruit' }).getAttribute('placeholder')).toBe('Search fruit');
  });

  it('lists every option when the button opens it', async () => {
    const user = userEvent.setup();
    render(fruitComboBox({}), { wrapper });

    const listbox = await openList(user);
    expect(screen.getByRole('combobox', { name: 'Fruit' }).getAttribute('aria-expanded')).toBe('true');
    expect(listbox.getAttribute('data-size')).toBe('md');
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Apple',
      'Apricot',
      'Banana',
    ]);
  });

  it('filters while typing and picks with the keyboard', async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    render(fruitComboBox({ onSelectionChange }), { wrapper });

    const input = screen.getByRole('combobox', { name: 'Fruit' });
    await user.type(input, 'ap');
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Apple', 'Apricot']);

    await user.keyboard('{ArrowDown}');
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');

    expect(onSelectionChange).toHaveBeenCalledWith('apricot');
    expect((input as HTMLInputElement).value).toBe('Apricot');
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('isolates hidden controls and restores the next tab stop when suggestions close', async () => {
    const user = userEvent.setup();
    render(
      <>
        {fruitComboBox({})}
        <button>Continue</button>
      </>,
      { wrapper },
    );
    const next = screen.getByRole('button', { name: 'Continue' });
    await openList(user);
    expect(next.tabIndex).toBe(-1);
    await user.keyboard('{Tab}');
    expect(next.tabIndex).toBe(0);
    expect(document.activeElement).toBe(next);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('answers with an empty state instead of closing when nothing matches', async () => {
    const user = userEvent.setup();
    render(fruitComboBox({}), { wrapper });

    const input = screen.getByRole('combobox', { name: 'Fruit' });
    await user.type(input, 'durian');

    const listbox = screen.getByRole('listbox');
    expect(listbox.getAttribute('data-empty')).toBe('true');
    expect(screen.queryAllByRole('option', { name: /Apple|Banana/ })).toEqual([]);
    expect(screen.getByText('No matches')).toBeTruthy();
    expect(input.getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps a typed value that is not in the list when custom values are allowed', async () => {
    const user = userEvent.setup();
    render(fruitComboBox({ allowsCustomValue: true }), { wrapper });

    const input = screen.getByRole('combobox', { name: 'Fruit' }) as HTMLInputElement;
    await user.type(input, 'durian');
    await user.tab();

    expect(input.value).toBe('durian');
  });

  it('drops a typed value that is not in the list by default', async () => {
    const user = userEvent.setup();
    render(fruitComboBox({}), { wrapper });

    const input = screen.getByRole('combobox', { name: 'Fruit' }) as HTMLInputElement;
    await user.type(input, 'durian');
    await user.tab();

    expect(input.value).toBe('');
  });

  it('shows its error only while invalid', () => {
    const { rerender } = render(fruitComboBox({ errorMessage: 'Pick a fruit' }), { wrapper });
    expect(screen.queryByText('Pick a fruit')).toBeNull();

    rerender(fruitComboBox({ errorMessage: 'Pick a fruit', isInvalid: true }));
    expect(screen.getByText('Pick a fruit')).toBeTruthy();
    expect(
      screen.getByRole('combobox', { name: 'Fruit' }).closest('.rio-combobox')?.getAttribute('data-invalid'),
    ).toBe('true');
  });

  it('carries its size and disabled state', () => {
    render(fruitComboBox({ size: 'lg', isDisabled: true }), { wrapper });

    const field = screen.getByRole('combobox', { name: 'Fruit' }).closest('.rio-combobox');
    expect(field?.getAttribute('data-size')).toBe('lg');
    expect((screen.getByRole('combobox', { name: 'Fruit' }) as HTMLInputElement).disabled).toBe(true);
  });
});
