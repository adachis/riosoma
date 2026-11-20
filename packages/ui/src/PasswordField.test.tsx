import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { PasswordField } from './PasswordField';

// The field names its own reveal button, which comes from the message catalog.
function renderField(ui: ReactElement) {
  return render(ui, {
    wrapper: ({ children }) => <I18nProvider i18n={i18n}>{children}</I18nProvider>,
  });
}

function fieldOf(input: Element) {
  return input.closest('.rio-field');
}

// A masked input has no role of its own, so it is found by the name its label gives it.
function passwordInput(name = 'Password') {
  return screen.getByLabelText(name) as HTMLInputElement;
}

describe('PasswordField', () => {
  it('masks the value and passes the autocomplete hint through', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderField(
      <PasswordField
        label="Password"
        autoComplete="current-password"
        placeholder="Enter it"
        onChange={onChange}
      />,
    );
    const input = passwordInput();
    expect(input.type).toBe('password');
    expect(input.getAttribute('autocomplete')).toBe('current-password');
    expect(input.placeholder).toBe('Enter it');

    await user.tab();
    expect(document.activeElement).toBe(input);
    await user.keyboard('hunter2');
    expect(input.value).toBe('hunter2');
    expect(onChange).toHaveBeenLastCalledWith('hunter2');
  });

  it('reveals and masks again, and keeps focus in the input', async () => {
    const user = userEvent.setup();
    renderField(<PasswordField label="Password" defaultValue="hunter2" />);
    const input = passwordInput();
    const reveal = screen.getByRole('button', { name: 'Show password' });

    await user.click(input);
    await user.click(reveal);
    expect(input.type).toBe('text');
    // Now that the value is visible it is a plain textbox, and the button offers the way back.
    expect(screen.getByRole('textbox', { name: 'Password' })).toBe(input);
    expect(screen.getByRole('button', { name: 'Hide password' })).toBeTruthy();
    expect(document.activeElement).toBe(input);

    await user.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(input.type).toBe('password');
    expect(input.value).toBe('hunter2');
    expect(screen.getByRole('button', { name: 'Show password' })).toBeTruthy();
    expect(document.activeElement).toBe(input);
  });

  it('reveals from the keyboard and leaves focus on the button', async () => {
    const user = userEvent.setup();
    renderField(<PasswordField label="Password" />);
    const input = passwordInput();

    await user.tab();
    expect(document.activeElement).toBe(input);
    await user.tab();
    const reveal = screen.getByRole('button', { name: 'Show password' });
    expect(document.activeElement).toBe(reveal);

    await user.keyboard('{Enter}');
    expect(input.type).toBe('text');
    expect(document.activeElement).toBe(reveal);

    await user.keyboard(' ');
    expect(input.type).toBe('password');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Show password' }));
  });

  it('can start out revealed', () => {
    renderField(<PasswordField label="Password" defaultValue="hunter2" defaultRevealed />);
    expect(passwordInput().type).toBe('text');
    expect(screen.getByRole('button', { name: 'Hide password' })).toBeTruthy();
  });

  it('carries the states a form needs', () => {
    renderField(<PasswordField label="Password" isRequired isDisabled isReadOnly />);
    const input = passwordInput();
    const field = fieldOf(input);
    expect(input.hasAttribute('required')).toBe(true);
    expect(input.disabled).toBe(true);
    expect(input.readOnly).toBe(true);
    expect(field?.hasAttribute('data-required')).toBe(true);
    expect(field?.hasAttribute('data-disabled')).toBe(true);
    expect(field?.hasAttribute('data-readonly')).toBe(true);
  });

  it('shows the error message only while the field is invalid', () => {
    renderField(<PasswordField label="Password" errorMessage="Use 12 characters or more" isInvalid />);
    const input = passwordInput();
    const error = screen.getByText('Use 12 characters or more');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(fieldOf(input)?.hasAttribute('data-invalid')).toBe(true);
    expect((input.getAttribute('aria-describedby') ?? '').split(' ')).toContain(error.id);
  });

  it('takes one of the three control heights', () => {
    const { rerender } = renderField(<PasswordField label="Password" />);
    const input = passwordInput();
    expect(fieldOf(input)?.getAttribute('data-size')).toBe('md');
    rerender(<PasswordField label="Password" size="sm" />);
    expect(fieldOf(input)?.getAttribute('data-size')).toBe('sm');
    rerender(<PasswordField label="Password" size="lg" />);
    expect(fieldOf(input)?.getAttribute('data-size')).toBe('lg');
  });

  it('keeps the eye icons out of the accessible name', () => {
    renderField(<PasswordField label="Password" />);
    const icons = fieldOf(passwordInput())?.querySelectorAll('svg') ?? [];
    expect(icons).toHaveLength(1);
    expect(icons[0]?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('button', { name: 'Show password' }).textContent).toBe('');
  });
});
