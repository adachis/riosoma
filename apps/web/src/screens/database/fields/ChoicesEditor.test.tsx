import { dragItem } from '../../../test/sortable';
import { useState } from 'react';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIMITS, newId, type Choice } from '@riosoma/contracts';
import { ChoicesEditor } from './ChoicesEditor';
import { renderField } from './fieldTestUtils';

afterEach(cleanup);

function editor(initial: Choice[] = []) {
  const onChange = vi.fn();
  function Host() {
    const [choices, setChoices] = useState(initial);
    return (
      <ChoicesEditor
        choices={choices}
        onChange={(next) => {
          setChoices(next);
          onChange(next);
        }}
      />
    );
  }
  renderField(<Host />);
  return onChange;
}

function choice(name: string): Choice {
  return { id: newId('choice'), name, color: 'gray' };
}

describe('ChoicesEditor', () => {
  it('adds, focuses, renames, recolors, and removes options with stable IDs', async () => {
    const onChange = editor();
    await userEvent.click(screen.getByRole('button', { name: 'Add option' }));
    const name = screen.getByRole('textbox', { name: 'Option name' });
    expect(document.activeElement).toBe(name);
    const id: unknown = onChange.mock.lastCall?.[0][0].id;
    expect(id).toMatch(/^cho[0-9A-Za-z]{14}$/);
    await userEvent.type(name, 'Ready');
    await userEvent.click(screen.getByRole('button', { name: 'Color of Ready' }));
    expect(screen.getByRole('radiogroup', { name: 'Color of Ready' })).toBeDefined();
    screen.getByRole('radio', { name: 'Gray' }).focus();
    await userEvent.keyboard('{ArrowRight}{Escape}');
    expect(onChange).toHaveBeenLastCalledWith([{ id, name: 'Ready', color: 'red' }]);
    await userEvent.click(screen.getByRole('button', { name: 'Add option' }));
    expect(onChange.mock.lastCall?.[0][1].color).toBe('orange');
    await userEvent.click(screen.getByRole('button', { name: 'Remove Ready' }));
    expect(screen.getAllByRole('textbox', { name: 'Option name' })).toHaveLength(1);
  });

  it('marks case-insensitive duplicates invalid and clears the error after renaming', async () => {
    editor([choice('Ready'), choice(' ready ')]);
    const names = screen.getAllByRole('textbox', { name: 'Option name' });
    expect(names.every((name) => name.getAttribute('aria-invalid') === 'true')).toBe(true);
    expect(screen.getAllByText('Another option already has this name.')).toHaveLength(2);
    await userEvent.clear(names[1]!);
    await userEvent.type(names[1]!, 'Done');
    expect(screen.queryByText('Another option already has this name.')).toBeNull();
  });

  it('reorders with Alt+Arrow and keeps focus on the moved control', async () => {
    const first = choice('First');
    const second = choice('Second');
    const onChange = editor([first, second]);
    const handle = screen.getByRole('button', { name: 'Move Second' });
    handle.focus();
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(onChange).toHaveBeenLastCalledWith([second, first]);
    expect(document.activeElement).toBe(handle);
    const rows = within(screen.getByRole('list', { name: 'Options' })).getAllByRole('listitem');
    expect(within(rows[0]!).getByRole('button', { name: 'Move Second' })).toBe(handle);
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(onChange).toHaveBeenLastCalledWith([first, second]);
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('preserves editing shortcuts and moves the choice from its handle', async () => {
    const first = choice('First');
    const second = choice('Second');
    const onChange = editor([first, second]);
    const input = screen.getAllByRole('textbox', { name: 'Option name' })[0]!;
    input.focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    const handle = screen.getByRole('button', { name: 'Move First' });
    handle.focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(onChange).toHaveBeenLastCalledWith([second, first]);
    await vi.waitFor(() => expect(document.activeElement).toBe(handle));
    expect(document.querySelector('.rio-sortable-announcement')?.textContent).toContain(
      'Dropped First, position 2',
    );
  });

  it('reorders a dragged option at its drop target', async () => {
    const first = choice('First');
    const second = choice('Second');
    const onChange = editor([first, second]);
    await dragItem(
      screen.getByRole('button', { name: 'Move First' }),
      screen.getByRole('button', { name: 'Move Second' }),
    );
    expect(onChange).toHaveBeenLastCalledWith([second, first]);
  });

  it('disables adding at the choice limit', () => {
    editor(Array.from({ length: LIMITS.choicesPerField }, (_, index) => choice(String(index))));
    expect(screen.getByRole('button', { name: 'Add option' }).hasAttribute('disabled')).toBe(true);
  });
});
