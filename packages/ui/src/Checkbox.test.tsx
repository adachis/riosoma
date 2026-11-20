import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Checkbox } from './Checkbox';

/** The checkbox role sits on the visually hidden input that carries the semantics. */
function input(name: string): HTMLInputElement {
  return screen.getByRole('checkbox', { name }) as HTMLInputElement;
}

/** The label element that wraps the box and the text, which is where the state attributes live. */
function control(name: string): HTMLElement | null {
  return screen.getByText(name).closest<HTMLElement>('.rio-checkbox__control');
}

/** The element the state attributes are styled from. */
function field(name: string): HTMLElement | null {
  return screen.getByText(name).closest<HTMLElement>('.rio-checkbox');
}

describe('Checkbox', () => {
  it('is named by its label and toggles from the label text', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Checkbox onChange={onChange}>Include archived rows</Checkbox>);
    const checkbox = input('Include archived rows');
    const row = control('Include archived rows');
    expect(checkbox.checked).toBe(false);
    expect(row).not.toBeNull();
    expect(row?.dataset.selected).toBeUndefined();

    await user.click(screen.getByText('Include archived rows'));

    expect(checkbox.checked).toBe(true);
    expect(control('Include archived rows')?.dataset.selected).toBe('true');
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('toggles with the space bar while it has focus', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Checkbox defaultSelected onChange={onChange}>
        Compact rows
      </Checkbox>,
    );
    const checkbox = input('Compact rows');

    checkbox.focus();
    await user.keyboard(' ');

    expect(checkbox.checked).toBe(false);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('shows a dash instead of a tick while indeterminate', () => {
    render(<Checkbox isIndeterminate>All rows</Checkbox>);
    const checkbox = input('All rows');
    // Indeterminate is a property of the input; assistive technology reads it as mixed.
    expect(checkbox.indeterminate).toBe(true);
    expect(control('All rows')?.dataset.indeterminate).toBe('true');
  });

  it('keeps both marks mounted in one box, so no state changes its size', () => {
    render(
      <>
        <Checkbox>Empty</Checkbox>
        <Checkbox defaultSelected>Filled</Checkbox>
        <Checkbox isIndeterminate>Mixed</Checkbox>
      </>,
    );
    const boxes = Array.from(document.querySelectorAll('.rio-checkbox__box'));
    expect(boxes).toHaveLength(3);
    for (const box of boxes) {
      // The tick and the dash are always mounted and only fade, so the box keeps its children.
      expect(box.querySelectorAll('.rio-checkbox__tick, .rio-checkbox__dash')).toHaveLength(2);
    }
  });

  it('links its description to the checkbox', () => {
    render(<Checkbox description="At most one message a day.">Email me about failures</Checkbox>);
    const checkbox = input('Email me about failures');
    const description = screen.getByText('At most one message a day.');
    expect(description.id).not.toBe('');
    expect(checkbox.getAttribute('aria-describedby')).toContain(description.id);
  });

  it('marks itself invalid', () => {
    render(<Checkbox isInvalid>Overwrite existing rows</Checkbox>);
    expect(field('Overwrite existing rows')?.dataset.invalid).toBe('true');
    expect(control('Overwrite existing rows')?.dataset.invalid).toBe('true');
  });

  it('stays put when disabled', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Checkbox isDisabled onChange={onChange}>
        Delete backups
      </Checkbox>,
    );
    const checkbox = input('Delete backups');
    expect(checkbox.disabled).toBe(true);
    expect(field('Delete backups')?.dataset.disabled).toBe('true');

    await user.click(screen.getByText('Delete backups'));

    expect(checkbox.checked).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('stays put when read only', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Checkbox defaultSelected isReadOnly onChange={onChange}>
        Keep audit log
      </Checkbox>,
    );
    const checkbox = input('Keep audit log');
    expect(field('Keep audit log')?.dataset.readonly).toBe('true');

    await user.click(screen.getByText('Keep audit log'));

    expect(checkbox.checked).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });
});
