import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { faTable } from '@fortawesome/free-solid-svg-icons';
import { describe, expect, it, vi } from 'vitest';
import { ListBox, ListBoxItem, ListBoxSection } from './ListBox';

function fruits(mode: 'single' | 'multiple' = 'single', onSelectionChange = vi.fn()) {
  return (
    <ListBox aria-label="Fruit" selectionMode={mode} onSelectionChange={onSelectionChange}>
      <ListBoxSection title="Berries">
        <ListBoxItem id="strawberry" icon={faTable} description="Sweet and red">
          Strawberry
        </ListBoxItem>
        <ListBoxItem id="blueberry">Blueberry</ListBoxItem>
      </ListBoxSection>
      <ListBoxSection title="Citrus">
        <ListBoxItem id="lemon" isDisabled>
          Lemon
        </ListBoxItem>
      </ListBoxSection>
    </ListBox>
  );
}

describe('ListBox', () => {
  it('names itself and groups options under their section headers', () => {
    render(fruits());

    const list = screen.getByRole('listbox', { name: 'Fruit' });
    expect(within(list).getByRole('group', { name: 'Berries' })).toBeTruthy();
    expect(within(list).getByRole('group', { name: 'Citrus' })).toBeTruthy();
    // The name contains the visible label and description.
    const berry = within(list).getByRole('option', { name: 'Strawberry Sweet and red' });
    expect(berry.textContent).toContain('Sweet and red');
    expect(berry.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('selects one option with the keyboard', async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    render(fruits('single', onSelectionChange));

    const list = screen.getByRole('listbox', { name: 'Fruit' });
    list.focus();
    await user.keyboard('{ArrowDown}');
    const options = screen.getAllByRole('option');
    expect(options[1]?.getAttribute('data-focused')).toBe('true');

    await user.keyboard(' ');
    expect(options[1]?.getAttribute('aria-selected')).toBe('true');
    expect(onSelectionChange).toHaveBeenCalled();
  });

  it('selects an option with a click and moves the selection', async () => {
    const user = userEvent.setup();
    render(fruits());

    await user.click(screen.getByRole('option', { name: 'Strawberry Sweet and red' }));
    expect(
      screen.getByRole('option', { name: 'Strawberry Sweet and red' }).getAttribute('aria-selected'),
    ).toBe('true');

    await user.click(screen.getByRole('option', { name: 'Blueberry' }));
    expect(
      screen.getByRole('option', { name: 'Strawberry Sweet and red' }).getAttribute('aria-selected'),
    ).toBe('false');
    expect(screen.getByRole('option', { name: 'Blueberry' }).getAttribute('aria-selected')).toBe('true');
  });

  it('keeps several options selected in multiple selection', async () => {
    const user = userEvent.setup();
    render(fruits('multiple'));

    const list = screen.getByRole('listbox', { name: 'Fruit' });
    expect(list.getAttribute('aria-multiselectable')).toBe('true');

    await user.click(screen.getByRole('option', { name: 'Strawberry Sweet and red' }));
    await user.click(screen.getByRole('option', { name: 'Blueberry' }));
    expect(
      screen.getByRole('option', { name: 'Strawberry Sweet and red' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(screen.getByRole('option', { name: 'Blueberry' }).getAttribute('data-selection-mode')).toBe(
      'multiple',
    );
    expect(screen.getByRole('option', { name: 'Blueberry' }).getAttribute('data-selected')).toBe('true');

    // A second click on the same option takes it back out of the selection.
    await user.click(screen.getByRole('option', { name: 'Blueberry' }));
    expect(screen.getByRole('option', { name: 'Blueberry' }).getAttribute('aria-selected')).toBe('false');
    expect(
      screen.getByRole('option', { name: 'Strawberry Sweet and red' }).getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('shows which options are already selected', () => {
    render(
      <ListBox aria-label="Fruit" selectionMode="single" selectedKeys={['blueberry']}>
        <ListBoxItem id="strawberry">Strawberry</ListBoxItem>
        <ListBoxItem id="blueberry">Blueberry</ListBoxItem>
      </ListBox>,
    );

    const selected = screen.getByRole('option', { name: 'Blueberry' });
    expect(selected.getAttribute('data-selected')).toBe('true');
    // The check mark is there for every selectable option, so selecting one cannot shift the label.
    expect(
      screen.getAllByRole('option').every((option) => option.querySelector('.rio-listbox-item__indicator')),
    ).toBe(true);
    expect(selected.querySelector('.rio-listbox-item__indicator')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('leaves disabled options out of reach', async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    render(fruits('single', onSelectionChange));

    const lemon = screen.getByRole('option', { name: 'Lemon' });
    expect(lemon.getAttribute('data-disabled')).toBe('true');
    await user.click(lemon);
    expect(lemon.getAttribute('aria-selected')).toBe('false');
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it('has no selection column when nothing can be selected', () => {
    render(
      <ListBox aria-label="Recent">
        <ListBoxItem id="one">orders</ListBoxItem>
      </ListBox>,
    );

    expect(
      screen.getByRole('option', { name: 'orders' }).querySelector('.rio-listbox-item__indicator'),
    ).toBeNull();
  });
});

it('includes the visible option description in its accessible name', () => {
  render(
    <ListBox aria-label="Fields">
      <ListBoxItem id="name" description="Text field">
        Name
      </ListBoxItem>
    </ListBox>,
  );
  const item = screen.getByRole('option', { name: 'Name Text field' });
  expect(item.textContent).toContain('Text field');
});
