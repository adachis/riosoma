import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { NumberField } from './NumberField';

// The field names its own stepper buttons, which come from the message catalog.
function renderField(ui: ReactElement) {
  return render(ui, {
    wrapper: ({ children }) => <I18nProvider i18n={i18n}>{children}</I18nProvider>,
  });
}

function fieldOf(input: Element) {
  return input.closest('.rio-field');
}

// A stepper is named for what it changes, so the field's label joins the button's own name.
const INCREASE = 'Increase Pool size';
const DECREASE = 'Decrease Pool size';

describe('NumberField', () => {
  it('names the input with its label and steps with the buttons', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderField(<NumberField label="Pool size" defaultValue={4} onChange={onChange} />);
    const input = screen.getByRole('textbox', { name: 'Pool size' }) as HTMLInputElement;
    expect(input.value).toBe('4');

    await user.click(screen.getByRole('button', { name: INCREASE }));
    expect(input.value).toBe('5');
    expect(onChange).toHaveBeenLastCalledWith(5);

    await user.click(screen.getByRole('button', { name: DECREASE }));
    await user.click(screen.getByRole('button', { name: DECREASE }));
    expect(input.value).toBe('3');
    expect(onChange).toHaveBeenLastCalledWith(3);
  });

  it('steps with the arrow keys while the input has focus', async () => {
    const user = userEvent.setup();
    renderField(<NumberField label="Pool size" defaultValue={4} minValue={1} maxValue={6} />);
    const input = screen.getByRole('textbox', { name: 'Pool size' }) as HTMLInputElement;

    await user.tab();
    expect(document.activeElement).toBe(input);
    await user.keyboard('{ArrowUp}');
    expect(input.value).toBe('5');
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(input.value).toBe('3');

    // A typed value is the reader's, and it lands in the caller's hands as a number.
    await user.clear(input);
    await user.keyboard('42');
    expect(input.value).toBe('42');
    await user.tab();
    expect(input.value).toBe('6');
  });

  it('makes a stepper unavailable at its bound without moving the value', async () => {
    const user = userEvent.setup();
    renderField(<NumberField label="Pool size" defaultValue={6} minValue={1} maxValue={6} />);
    const input = screen.getByRole('textbox', { name: 'Pool size' }) as HTMLInputElement;
    const increase = screen.getByRole('button', { name: INCREASE });
    const decrease = screen.getByRole('button', { name: DECREASE });
    expect(increase.hasAttribute('data-disabled')).toBe(true);
    expect(decrease.hasAttribute('data-disabled')).toBe(false);

    await user.click(increase);
    expect(input.value).toBe('6');

    await user.click(decrease);
    expect(increase.hasAttribute('data-disabled')).toBe(false);
    expect(input.value).toBe('5');
  });

  it('formats the value for the reader and keeps a number for the caller', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderField(
      <NumberField
        label="Storage"
        formatOptions={{ style: 'currency', currency: 'USD' }}
        step={0.5}
        onChange={onChange}
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Storage' }) as HTMLInputElement;
    await user.click(input);
    await user.keyboard('12.5');
    await user.tab();
    expect(input.value).toBe('$12.50');
    expect(onChange).toHaveBeenLastCalledWith(12.5);
  });

  it('carries the states a form needs', () => {
    renderField(<NumberField label="Pool size" isRequired isDisabled isReadOnly />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    const field = fieldOf(input);
    expect(input.hasAttribute('required')).toBe(true);
    expect(input.disabled).toBe(true);
    expect(input.readOnly).toBe(true);
    expect(field?.hasAttribute('data-required')).toBe(true);
    expect(field?.hasAttribute('data-disabled')).toBe(true);
    expect(field?.hasAttribute('data-readonly')).toBe(true);
    expect(screen.getByRole('button', { name: INCREASE }).hasAttribute('data-disabled')).toBe(true);
  });

  it('shows the error message only while the field is invalid', () => {
    renderField(<NumberField label="Pool size" errorMessage="Enter 1 or more" isInvalid />);
    const input = screen.getByRole('textbox', { name: 'Pool size' });
    const error = screen.getByText('Enter 1 or more');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(fieldOf(input)?.hasAttribute('data-invalid')).toBe(true);
    expect((input.getAttribute('aria-describedby') ?? '').split(' ')).toContain(error.id);
  });

  it('takes one of the three control heights', () => {
    const { rerender } = renderField(<NumberField label="Pool size" />);
    const input = screen.getByRole('textbox');
    expect(fieldOf(input)?.getAttribute('data-size')).toBe('md');
    rerender(<NumberField label="Pool size" size="sm" />);
    expect(fieldOf(input)?.getAttribute('data-size')).toBe('sm');
    rerender(<NumberField label="Pool size" size="lg" />);
    expect(fieldOf(input)?.getAttribute('data-size')).toBe('lg');
  });

  it('keeps the stepper icons out of the accessible name', () => {
    renderField(<NumberField label="Pool size" />);
    expect(screen.getByRole('button', { name: INCREASE }).textContent).toBe('');
    const icons = fieldOf(screen.getByRole('textbox'))?.querySelectorAll('svg') ?? [];
    expect(icons).toHaveLength(2);
    for (const icon of icons) expect(icon.getAttribute('aria-hidden')).toBe('true');
  });
});
