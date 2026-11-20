import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIELD_TYPES, PRIMARY_FIELD_TYPES } from '@riosoma/contracts';
import { FieldTypePicker } from './FieldTypePicker';
import { renderField, selectOption } from './fieldTestUtils';

afterEach(cleanup);

describe('FieldTypePicker', () => {
  it('lists all types with decorative icons and reports a selection', async () => {
    const onChange = vi.fn();
    renderField(<FieldTypePicker value="text" onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /Type/ }));
    expect(screen.getAllByRole('option')).toHaveLength(FIELD_TYPES.length);
    for (const option of screen.getAllByRole('option')) {
      expect(option.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    }
    await userEvent.click(screen.getByRole('option', { name: 'Number' }));
    expect(onChange).toHaveBeenCalledWith('number');
  });

  it('disables unsupported primary types', async () => {
    const onChange = vi.fn();
    renderField(<FieldTypePicker value="text" onChange={onChange} allowed={PRIMARY_FIELD_TYPES} />);
    await userEvent.click(screen.getByRole('button', { name: /Type/ }));
    const checkbox = screen.getByRole('option', { name: 'Checkbox' });
    expect(checkbox.getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(checkbox);
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    await selectOption('Type', 'Number');
    expect(onChange).toHaveBeenCalledWith('number');
  });
});
