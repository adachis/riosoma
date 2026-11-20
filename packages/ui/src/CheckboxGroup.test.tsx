import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Checkbox } from './Checkbox';
import { CheckboxGroup } from './CheckboxGroup';

function checkboxes(name: string): HTMLInputElement[] {
  const group = screen.getByRole('group', { name });
  return Array.from(group.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
}

function items(name: string): HTMLElement | null {
  return screen.getByRole('group', { name }).querySelector<HTMLElement>('.rio-checkbox-group__items');
}

describe('CheckboxGroup', () => {
  it('names the group and collects every chosen value', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <CheckboxGroup label="Export formats" onChange={onChange}>
        <Checkbox value="csv">CSV</Checkbox>
        <Checkbox value="json">JSON</Checkbox>
        <Checkbox value="parquet">Parquet</Checkbox>
      </CheckboxGroup>,
    );
    const group = screen.getByRole('group', { name: 'Export formats' });
    expect(group.querySelectorAll('input[type="checkbox"]')).toHaveLength(3);

    await user.click(screen.getByText('CSV'));
    await user.click(screen.getByText('Parquet'));

    expect(checkboxes('Export formats').map((checkbox) => checkbox.checked)).toEqual([true, false, true]);
    expect(onChange).toHaveBeenLastCalledWith(['csv', 'parquet']);
  });

  it('toggles a checkbox with the space bar', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <CheckboxGroup label="Notifications" onChange={onChange}>
        <Checkbox value="email">Email</Checkbox>
        <Checkbox value="webhook">Webhook</Checkbox>
      </CheckboxGroup>,
    );

    await user.tab();
    expect(document.activeElement).toBe(checkboxes('Notifications')[0]);
    await user.keyboard(' ');

    expect(checkboxes('Notifications')[0]?.checked).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith(['email']);
  });

  it('links its description and shows its error only while invalid', () => {
    const { rerender } = render(
      <CheckboxGroup label="Retention" description="Applies to every table.">
        <Checkbox value="keep">Keep history</Checkbox>
      </CheckboxGroup>,
    );
    const group = screen.getByRole('group', { name: 'Retention' });
    const description = screen.getByText('Applies to every table.');
    expect(group.getAttribute('aria-describedby')).toContain(description.id);
    expect(screen.queryByText('Choose at least one option.')).toBeNull();

    rerender(
      <CheckboxGroup
        label="Retention"
        description="Applies to every table."
        isInvalid
        errorMessage="Choose at least one option."
      >
        <Checkbox value="keep">Keep history</Checkbox>
      </CheckboxGroup>,
    );
    const error = screen.getByText('Choose at least one option.');
    expect(screen.getByRole('group', { name: 'Retention' }).dataset.invalid).toBe('true');
    expect(screen.getByRole('group', { name: 'Retention' }).getAttribute('aria-describedby')).toContain(
      error.id,
    );
  });

  it('lays its checkboxes out in a row or a column', () => {
    const { rerender } = render(
      <CheckboxGroup label="Columns">
        <Checkbox value="name">Name</Checkbox>
      </CheckboxGroup>,
    );
    expect(items('Columns')?.dataset.orientation).toBe('vertical');

    rerender(
      <CheckboxGroup label="Columns" orientation="horizontal">
        <Checkbox value="name">Name</Checkbox>
      </CheckboxGroup>,
    );
    expect(items('Columns')?.dataset.orientation).toBe('horizontal');
  });

  it('disables every checkbox at once', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <CheckboxGroup label="Danger zone" isDisabled onChange={onChange}>
        <Checkbox value="drop">Drop tables</Checkbox>
        <Checkbox value="vacuum">Vacuum</Checkbox>
      </CheckboxGroup>,
    );
    expect(screen.getByRole('group', { name: 'Danger zone' }).dataset.disabled).toBe('true');

    await user.click(screen.getByText('Drop tables'));

    for (const checkbox of checkboxes('Danger zone')) {
      expect(checkbox.disabled).toBe(true);
      expect(checkbox.checked).toBe(false);
    }
    expect(onChange).not.toHaveBeenCalled();
  });
});
