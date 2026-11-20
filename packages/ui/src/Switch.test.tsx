import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Switch } from './Switch';

function input(name: string): HTMLInputElement {
  return screen.getByRole('switch', { name }) as HTMLInputElement;
}

function control(name: string): HTMLElement | null {
  return screen.getByText(name).closest<HTMLElement>('.rio-switch__control');
}

/** The element the state attributes are styled from. */
function field(name: string): HTMLElement | null {
  return screen.getByText(name).closest<HTMLElement>('.rio-switch');
}

describe('Switch', () => {
  it('is named by its label and turns on and off', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Switch onChange={onChange}>Compact the log nightly</Switch>);
    const toggle = input('Compact the log nightly');
    const row = control('Compact the log nightly');
    expect(toggle.checked).toBe(false);
    expect(row).not.toBeNull();
    expect(row?.dataset.selected).toBeUndefined();

    await user.click(screen.getByText('Compact the log nightly'));
    expect(toggle.checked).toBe(true);
    expect(control('Compact the log nightly')?.dataset.selected).toBe('true');
    expect(onChange).toHaveBeenCalledWith(true);

    await user.click(screen.getByText('Compact the log nightly'));
    expect(toggle.checked).toBe(false);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('turns with the space bar while it has focus', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Switch onChange={onChange}>Read only mode</Switch>);

    input('Read only mode').focus();
    await user.keyboard(' ');

    expect(input('Read only mode').checked).toBe(true);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('keeps one track and one thumb in both states', () => {
    render(
      <>
        <Switch>Off</Switch>
        <Switch defaultSelected>On</Switch>
      </>,
    );
    expect(document.querySelectorAll('.rio-switch__track')).toHaveLength(2);
    const thumbs = Array.from(document.querySelectorAll('.rio-switch__thumb'));
    expect(thumbs).toHaveLength(2);
    for (const thumb of thumbs) {
      // The thumb only slides, so the track never gains or loses a child.
      expect(thumb.childNodes).toHaveLength(0);
    }
  });

  it('links its description to the switch', () => {
    render(<Switch description="Applies to new connections only.">Require encryption</Switch>);
    const toggle = input('Require encryption');
    const description = screen.getByText('Applies to new connections only.');
    expect(description.id).not.toBe('');
    expect(toggle.getAttribute('aria-describedby')).toContain(description.id);
  });

  it('marks itself invalid', () => {
    render(<Switch isInvalid>Allow anonymous access</Switch>);
    expect(field('Allow anonymous access')?.dataset.invalid).toBe('true');
    expect(control('Allow anonymous access')?.dataset.invalid).toBe('true');
  });

  it('stays put when disabled', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Switch isDisabled onChange={onChange}>
        Delete old snapshots
      </Switch>,
    );
    const toggle = input('Delete old snapshots');
    expect(toggle.disabled).toBe(true);
    expect(field('Delete old snapshots')?.dataset.disabled).toBe('true');

    await user.click(screen.getByText('Delete old snapshots'));

    expect(toggle.checked).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('stays put when read only', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Switch defaultSelected isReadOnly onChange={onChange}>
        Audit log
      </Switch>,
    );
    const toggle = input('Audit log');
    expect(field('Audit log')?.dataset.readonly).toBe('true');

    await user.click(screen.getByText('Audit log'));

    expect(toggle.checked).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });
});
