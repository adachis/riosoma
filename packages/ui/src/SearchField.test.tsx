import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { SearchField } from './SearchField';

// The field names its own clear button, which comes from the message catalog.
function renderField(ui: ReactElement) {
  return render(ui, {
    wrapper: ({ children }) => <I18nProvider i18n={i18n}>{children}</I18nProvider>,
  });
}

function fieldOf(input: Element) {
  return input.closest('.rio-field');
}

describe('SearchField', () => {
  it('offers a searchbox named by its label and takes what is typed', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderField(<SearchField label="Tables" placeholder="Filter by name" onChange={onChange} />);
    const input = screen.getByRole('searchbox', { name: 'Tables' }) as HTMLInputElement;
    expect(input.placeholder).toBe('Filter by name');
    expect(input.type).toBe('search');

    await user.tab();
    expect(document.activeElement).toBe(input);
    await user.keyboard('orders');
    expect(input.value).toBe('orders');
    expect(onChange).toHaveBeenLastCalledWith('orders');
  });

  it('shows the clear button only when there is something to clear', async () => {
    const user = userEvent.setup();
    renderField(<SearchField label="Tables" />);
    const input = screen.getByRole('searchbox', { name: 'Tables' });
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();

    await user.type(input, 'orders');
    const clear = screen.getByRole('button', { name: 'Clear search' });
    await user.click(clear);

    // Clearing leaves the reader where they were typing, and takes the button with the value.
    expect((input as HTMLInputElement).value).toBe('');
    expect(document.activeElement).toBe(input);
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
  });

  it('clears from the keyboard with Escape and says so to the caller', async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    renderField(<SearchField label="Tables" defaultValue="orders" onClear={onClear} />);
    const input = screen.getByRole('searchbox', { name: 'Tables' }) as HTMLInputElement;

    await user.click(input);
    await user.keyboard('{Escape}');
    expect(input.value).toBe('');
    expect(onClear).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(input);
  });

  it('leaves a value that cannot be changed alone', () => {
    const { rerender } = renderField(<SearchField label="Tables" defaultValue="orders" isReadOnly />);
    const input = screen.getByRole('searchbox', { name: 'Tables' }) as HTMLInputElement;
    expect(input.readOnly).toBe(true);
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();

    rerender(<SearchField label="Tables" defaultValue="orders" isDisabled />);
    expect(input.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
  });

  it('shows the error message only while the field is invalid', () => {
    renderField(<SearchField label="Tables" errorMessage="Enter a search" isInvalid />);
    const input = screen.getByRole('searchbox', { name: 'Tables' });
    const error = screen.getByText('Enter a search');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(fieldOf(input)?.hasAttribute('data-invalid')).toBe(true);
    expect((input.getAttribute('aria-describedby') ?? '').split(' ')).toContain(error.id);
  });

  it('keeps its icons out of the accessible name', () => {
    renderField(<SearchField label="Tables" defaultValue="orders" />);
    const input = screen.getByRole('searchbox', { name: 'Tables' });
    const icons = fieldOf(input)?.querySelectorAll('svg') ?? [];
    // The magnifying glass and the cross inside the clear button are both decoration.
    expect(icons.length).toBeGreaterThan(0);
    for (const icon of icons) expect(icon.getAttribute('aria-hidden')).toBe('true');
  });

  it('takes one of the three control heights', () => {
    const { rerender } = renderField(<SearchField label="Tables" />);
    const input = screen.getByRole('searchbox');
    expect(fieldOf(input)?.getAttribute('data-size')).toBe('md');
    rerender(<SearchField label="Tables" size="sm" />);
    expect(fieldOf(input)?.getAttribute('data-size')).toBe('sm');
    rerender(<SearchField label="Tables" size="lg" />);
    expect(fieldOf(input)?.getAttribute('data-size')).toBe('lg');
  });
});
