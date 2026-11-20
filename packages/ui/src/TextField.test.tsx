import { faServer } from '@fortawesome/free-solid-svg-icons';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TextField } from './TextField';

function fieldOf(input: Element) {
  return input.closest('.rio-field');
}

describe('TextField', () => {
  it('names the input with its label and reports what is typed', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TextField
        label="Host"
        description="Where the database lives"
        placeholder="db.example.com"
        onChange={onChange}
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Host' }) as HTMLInputElement;
    expect(input.placeholder).toBe('db.example.com');
    expect(screen.getByText('Where the database lives')).toBeTruthy();

    // The input is reached by keyboard and takes what is typed.
    await user.tab();
    expect(document.activeElement).toBe(input);
    await user.keyboard('db.example.com');
    expect(input.value).toBe('db.example.com');
    expect(onChange).toHaveBeenLastCalledWith('db.example.com');
  });

  it('shows the error message only while the field is invalid', () => {
    const { rerender } = render(<TextField label="Host" errorMessage="Enter a host name" />);
    const input = screen.getByRole('textbox', { name: 'Host' });
    expect(screen.queryByText('Enter a host name')).toBeNull();
    expect(fieldOf(input)?.hasAttribute('data-invalid')).toBe(false);

    rerender(<TextField label="Host" errorMessage="Enter a host name" isInvalid />);
    const error = screen.getByText('Enter a host name');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(fieldOf(input)?.hasAttribute('data-invalid')).toBe(true);
    // The message is tied to the input, so it is announced with it.
    expect((input.getAttribute('aria-describedby') ?? '').split(' ')).toContain(error.id);
  });

  it('carries the states a form needs', () => {
    render(<TextField label="Host" isRequired isDisabled isReadOnly />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    const field = fieldOf(input);
    expect(input.hasAttribute('required')).toBe(true);
    expect(input.disabled).toBe(true);
    expect(input.readOnly).toBe(true);
    expect(field?.hasAttribute('data-required')).toBe(true);
    expect(field?.hasAttribute('data-disabled')).toBe(true);
    expect(field?.hasAttribute('data-readonly')).toBe(true);
  });

  it('marks a required label with a symbol assistive technology ignores', () => {
    render(<TextField label="Host" isRequired />);
    // The accessible name is the label alone; the symbol is not read out and does not join it.
    const input = screen.getByRole('textbox', { name: 'Host' });
    const mark = fieldOf(input)?.querySelector('.rio-field__required');
    expect(mark?.textContent).toBe('*');
    expect(mark?.getAttribute('aria-hidden')).toBe('true');
  });

  it('takes one of the three control heights', () => {
    const { rerender } = render(<TextField label="Host" />);
    const input = screen.getByRole('textbox');
    expect(fieldOf(input)?.getAttribute('data-size')).toBe('md');
    rerender(<TextField label="Host" size="sm" />);
    expect(fieldOf(input)?.getAttribute('data-size')).toBe('sm');
    rerender(<TextField label="Host" size="lg" />);
    expect(fieldOf(input)?.getAttribute('data-size')).toBe('lg');
  });

  it('keeps a leading icon out of the accessible name', () => {
    render(<TextField label="Host" icon={faServer} />);
    const input = screen.getByRole('textbox', { name: 'Host' });
    const icons = fieldOf(input)?.querySelectorAll('svg') ?? [];
    expect(icons).toHaveLength(1);
    expect(icons[0]?.getAttribute('aria-hidden')).toBe('true');
  });
});
