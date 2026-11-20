import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { describe, expect, it, vi } from 'vitest';
import { ListBoxItem } from './ListBox';
import { Select } from './Select';

// The select reads its own strings through Lingui, which needs a provider above it.
const wrapper = ({ children }: { children?: React.ReactNode }) => (
  <I18nProvider i18n={i18n}>{children}</I18nProvider>
);

function fruitSelect(props: Partial<Parameters<typeof Select>[0]> = {}, onSelectionChange = vi.fn()) {
  return (
    <Select aria-label="Fruit" onSelectionChange={onSelectionChange} {...props}>
      <ListBoxItem id="apple">Apple</ListBoxItem>
      <ListBoxItem id="banana">Banana</ListBoxItem>
      <ListBoxItem id="cherry" isDisabled>
        Cherry
      </ListBoxItem>
    </Select>
  );
}

/**
 * React Aria leaves focus on the panel in this DOM, while a browser moves it into the list.  Tests
 * make that move themselves so the arrow keys reach the options.
 */
async function open(user: ReturnType<typeof userEvent.setup>, name: RegExp = /Fruit/) {
  const trigger = screen.getByRole('button', { name });
  await user.click(trigger);
  const listbox = screen.getByRole('listbox');
  listbox.focus();
  return { trigger, listbox };
}

describe('Select', () => {
  it('shows its label, description, and placeholder before a choice', () => {
    render(fruitSelect({ label: 'Fruit', description: 'What goes in the basket' }), { wrapper });

    const trigger = screen.getByRole('button', { name: /Fruit/ });
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.textContent).toBe('Choose…');
    expect(screen.getByText('What goes in the basket')).toBeTruthy();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('takes a custom placeholder', () => {
    render(fruitSelect({ label: 'Fruit', placeholder: 'Pick one' }), { wrapper });

    expect(screen.getByRole('button', { name: /Fruit/ }).textContent).toBe('Pick one');
  });

  it('opens a list of options and picks one with the keyboard', async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    render(fruitSelect({ label: 'Fruit' }, onSelectionChange), { wrapper });

    const { trigger } = await open(user);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Apple',
      'Banana',
      'Cherry',
    ]);

    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');

    expect(onSelectionChange).toHaveBeenCalledWith('banana');
    expect(trigger.textContent).toBe('Banana');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('picks an option with a click', async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    render(fruitSelect({ label: 'Fruit' }, onSelectionChange), { wrapper });

    await open(user);
    await user.click(screen.getByRole('option', { name: 'Apple' }));

    expect(onSelectionChange).toHaveBeenCalledWith('apple');
    expect(screen.getByRole('button', { name: /Fruit/ }).textContent).toBe('Apple');
  });

  it('marks the chosen option with a check', async () => {
    const user = userEvent.setup();
    render(fruitSelect({ label: 'Fruit', selectedKey: 'banana' }), { wrapper });

    expect(screen.getByRole('button', { name: /Fruit/ }).textContent).toBe('Banana');

    await open(user);
    const options = screen.getAllByRole('option');
    expect(options[1]?.getAttribute('aria-selected')).toBe('true');
    expect(options[1]?.getAttribute('data-selected')).toBe('true');
    // Every option keeps the space for its check, so the labels line up.
    expect(options.every((option) => option.querySelector('.rio-listbox-item__check'))).toBe(true);
    expect(options[0]?.querySelector('.rio-listbox-item__indicator')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
  });

  it.each(['pointer', 'keyboard'])(
    'closes a long picker when its current choice is activated by %s',
    async (input) => {
      const user = userEvent.setup();
      const onSelectionChange = vi.fn();
      render(fruitSelect({ selectedKey: 'banana', filterable: true }, onSelectionChange), { wrapper });
      const trigger = screen.getByRole('button', { name: /Fruit/ });
      await user.click(trigger);
      const selected = screen.getByRole('option', { name: 'Banana' });
      if (input === 'pointer') await user.click(selected);
      else {
        selected.focus();
        await user.keyboard('{Enter}');
      }
      expect(screen.queryByRole('listbox')).toBeNull();
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      expect(onSelectionChange).not.toHaveBeenCalled();
    },
  );

  it('leaves a disabled option out of reach', async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    render(fruitSelect({ label: 'Fruit' }, onSelectionChange), { wrapper });

    await open(user);
    const cherry = screen.getByRole('option', { name: 'Cherry' });
    expect(cherry.getAttribute('data-disabled')).toBe('true');
    await user.click(cherry);

    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('closes with Escape', async () => {
    const user = userEvent.setup();
    render(fruitSelect({ label: 'Fruit' }), { wrapper });

    const { trigger } = await open(user);
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows its error only while invalid', () => {
    const { rerender } = render(fruitSelect({ label: 'Fruit', errorMessage: 'Pick a fruit' }), { wrapper });
    expect(screen.queryByText('Pick a fruit')).toBeNull();

    rerender(fruitSelect({ label: 'Fruit', errorMessage: 'Pick a fruit', isInvalid: true }));
    expect(screen.getByText('Pick a fruit')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /Fruit/ }).closest('.rio-select')?.getAttribute('data-invalid'),
    ).toBe('true');
  });

  it('carries its size and disabled state', () => {
    render(fruitSelect({ label: 'Fruit', size: 'sm', isDisabled: true }), { wrapper });

    const field = screen.getByRole('button', { name: /Fruit/ }).closest('.rio-select');
    expect(field?.getAttribute('data-size')).toBe('sm');
    expect(screen.getByRole('button', { name: /Fruit/ }).hasAttribute('disabled')).toBe(true);
  });

  it('passes its size on to the options', async () => {
    const user = userEvent.setup();
    render(fruitSelect({ label: 'Fruit', size: 'lg' }), { wrapper });

    const { listbox } = await open(user);
    expect(listbox.getAttribute('data-size')).toBe('lg');
  });
});
