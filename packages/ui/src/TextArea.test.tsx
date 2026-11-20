import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TextArea } from './TextArea';

function fieldOf(input: Element) {
  return input.closest('.rio-field');
}

describe('TextArea', () => {
  it('names the textarea with its label and takes several lines', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TextArea label="Notes" placeholder="Anything worth remembering" onChange={onChange} />);
    const area = screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement;
    expect(area.tagName).toBe('TEXTAREA');
    expect(area.placeholder).toBe('Anything worth remembering');

    await user.tab();
    expect(document.activeElement).toBe(area);
    await user.keyboard('First line{Enter}Second line');
    expect(area.value).toBe('First line\nSecond line');
    expect(onChange).toHaveBeenLastCalledWith('First line\nSecond line');
  });

  it('shows a fixed number of rows and lets the caller choose it', () => {
    const { rerender } = render(<TextArea label="Notes" />);
    const area = screen.getByRole('textbox', { name: 'Notes' });
    expect(area.getAttribute('rows')).toBe('3');
    rerender(<TextArea label="Notes" rows={8} />);
    expect(area.getAttribute('rows')).toBe('8');
  });

  it('shows the error message only while the field is invalid', () => {
    const { rerender } = render(<TextArea label="Notes" errorMessage="Say something" />);
    const area = screen.getByRole('textbox', { name: 'Notes' });
    expect(screen.queryByText('Say something')).toBeNull();

    rerender(<TextArea label="Notes" errorMessage="Say something" isInvalid />);
    const error = screen.getByText('Say something');
    expect(area.getAttribute('aria-invalid')).toBe('true');
    expect((area.getAttribute('aria-describedby') ?? '').split(' ')).toContain(error.id);
  });

  it('carries the states a form needs', () => {
    render(<TextArea label="Notes" isRequired isDisabled isReadOnly />);
    const area = screen.getByRole('textbox') as HTMLTextAreaElement;
    const field = fieldOf(area);
    expect(area.hasAttribute('required')).toBe(true);
    expect(area.disabled).toBe(true);
    expect(area.readOnly).toBe(true);
    expect(field?.hasAttribute('data-required')).toBe(true);
    expect(field?.hasAttribute('data-disabled')).toBe(true);
    expect(field?.hasAttribute('data-readonly')).toBe(true);
  });

  it('takes one of the three sizes', () => {
    const { rerender } = render(<TextArea label="Notes" />);
    const area = screen.getByRole('textbox');
    expect(fieldOf(area)?.getAttribute('data-size')).toBe('md');
    rerender(<TextArea label="Notes" size="sm" />);
    expect(fieldOf(area)?.getAttribute('data-size')).toBe('sm');
    rerender(<TextArea label="Notes" size="lg" />);
    expect(fieldOf(area)?.getAttribute('data-size')).toBe('lg');
  });
});
