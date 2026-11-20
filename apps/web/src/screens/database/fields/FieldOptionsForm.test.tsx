import { useState } from 'react';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FieldSpec, type FieldType } from '@riosoma/contracts';
import { FieldOptionsForm } from './FieldOptionsForm';
import { renderField, selectOption } from './fieldTestUtils';

afterEach(cleanup);

function optionsFor(type: FieldType) {
  const onChange = vi.fn();
  function Host() {
    const [options, setOptions] = useState(FieldSpec.parse({ type }).options);
    return (
      <FieldOptionsForm
        type={type}
        options={options}
        onChange={(next) => {
          setOptions(next);
          onChange(next);
        }}
      />
    );
  }
  renderField(<Host />);
  return onChange;
}

describe('FieldOptionsForm', () => {
  it('controls precision and both number switches with contract defaults', async () => {
    const onChange = optionsFor('number');
    expect(screen.getByRole('button', { name: /Decimal places/ }).textContent).toBe('As entered');
    await selectOption('Decimal places', '2 (1.00)');
    expect(onChange).toHaveBeenLastCalledWith({ precision: 2, thousands: true, allowNegative: true });
    await userEvent.click(screen.getByRole('switch', { name: 'Thousands separators' }));
    await userEvent.click(screen.getByRole('switch', { name: 'Negative numbers' }));
    expect(onChange).toHaveBeenLastCalledWith({ precision: 2, thousands: false, allowNegative: false });
    await selectOption('Decimal places', 'As entered');
    expect(onChange).toHaveBeenLastCalledWith({ precision: null, thousands: false, allowNegative: false });
  });

  it('changes the checkbox color by keyboard', async () => {
    const onChange = optionsFor('checkbox');
    expect(screen.getByRole('radiogroup', { name: 'Color' })).toBeDefined();
    screen.getByRole('radio', { name: 'Green' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith({ color: 'teal' });
  });

  it.each(['date', 'createdTime', 'lastModifiedTime'] as const)(
    'controls %s formatting and filters time zones',
    async (type) => {
      const onChange = optionsFor(type);
      const includeTime = screen.getByRole('switch', { name: 'Include a time' });
      if (type === 'date') {
        expect(screen.queryByRole('combobox', { name: 'Time zone' })).toBeNull();
        await userEvent.click(includeTime);
      }
      await selectOption('Date format', /^ISO \(\d{4}-\d{2}-\d{2}\)$/);
      await selectOption('Time format', '24-hour');
      const zone = screen.getByRole('combobox', { name: 'Time zone' });
      expect((zone as HTMLInputElement).value).toBe('Each person’s own');
      await userEvent.clear(zone);
      await userEvent.type(zone, 'America/Los_Angeles');
      await userEvent.click(await screen.findByRole('option', { name: 'America/Los_Angeles' }));
      expect(onChange).toHaveBeenLastCalledWith({
        includeTime: true,
        dateFormat: 'iso',
        timeFormat: '24h',
        timeZone: 'America/Los_Angeles',
      });
      await userEvent.click(includeTime);
      expect(screen.queryByRole('combobox', { name: 'Time zone' })).toBeNull();
      expect(screen.queryByRole('button', { name: /Time format/ })).toBeNull();
    },
  );

  it('turns rich text on and off for long text, off to start', async () => {
    const onChange = optionsFor('longText');
    const option = screen.getByRole('switch', { name: 'Rich text' });
    expect((option as HTMLInputElement).checked).toBe(false);
    expect(option.getAttribute('aria-describedby')).toBeTruthy();
    await userEvent.click(option);
    expect(onChange).toHaveBeenLastCalledWith({ richText: true });
    await userEvent.click(option);
    expect(onChange).toHaveBeenLastCalledWith({ richText: false });
  });

  it.each(['text', 'email', 'url', 'phone'] as const)(
    'offers validation and uniqueness for %s',
    async (type) => {
      const changed = optionsFor(type);
      expect(screen.getByRole('switch', { name: 'Unique values' })).toBeDefined();
      expect(screen.getByRole('button', { name: /Pattern/ })).toBeDefined();
      await userEvent.click(screen.getByRole('switch', { name: 'Required' }));
      expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ validation: { required: {} } }));
      expect(screen.getByRole('textbox', { name: 'Custom message' })).toBeDefined();
    },
  );

  it.each(['createdBy', 'lastModifiedBy', 'recordId'] as const)('has no options for %s', (type) => {
    const { container } = renderField(<FieldOptionsForm type={type} options={{}} onChange={vi.fn()} />);
    expect(container.textContent).toBe('');
  });
});
