import { useState } from 'react';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FieldSpec, newId, type FieldType } from '@riosoma/contracts';
import { FieldOptionsForm } from './FieldOptionsForm';
import { followOptions } from './DefaultValueOptions';
import { renderField, selectOption } from './fieldTestUtils';

afterEach(cleanup);

function optionsFor(type: FieldType, options: Record<string, unknown> = {}, noDefault = false) {
  const onChange = vi.fn();
  function Host() {
    const [current, setCurrent] = useState(FieldSpec.parse({ type, options }).options);
    return (
      <FieldOptionsForm
        type={type}
        options={current}
        noDefault={noDefault}
        onChange={(next) => {
          setCurrent(next);
          onChange(next);
        }}
      />
    );
  }
  renderField(<Host />);
  return onChange;
}

const lastDefault = (onChange: ReturnType<typeof vi.fn>) =>
  (onChange.mock.lastCall?.[0] as { defaultValue?: unknown }).defaultValue;

describe('the default value control', () => {
  it('sets and clears a text default', async () => {
    const onChange = optionsFor('text');
    expect(screen.getByRole('group', { name: 'Default value' })).toBeDefined();
    await userEvent.type(screen.getByRole('textbox', { name: 'Value' }), 'New');
    expect(lastDefault(onChange)).toEqual({ kind: 'value', value: 'New' });
    await userEvent.clear(screen.getByRole('textbox', { name: 'Value' }));
    expect(onChange.mock.lastCall?.[0]).not.toHaveProperty('defaultValue');
  });

  it('checks a box by default and fills in the person who adds a record', async () => {
    const box = optionsFor('checkbox');
    await userEvent.click(screen.getByRole('switch', { name: 'Checked in new records' }));
    expect(box).toHaveBeenLastCalledWith({ color: 'green', defaultValue: { kind: 'value', value: true } });
    cleanup();
    const user = optionsFor('user');
    await userEvent.click(screen.getByRole('switch', { name: 'The person who adds the record' }));
    expect(lastDefault(user)).toEqual({ kind: 'creator' });
  });

  it('offers a select’s options and its first option, and drops one that is removed', async () => {
    const [a, b] = [
      { id: newId('choice'), name: 'Low', color: 'blue' as const },
      { id: newId('choice'), name: 'High', color: 'red' as const },
    ];
    const onChange = optionsFor('singleSelect', { choices: [a, b] });
    await selectOption('Default option', 'High');
    expect(lastDefault(onChange)).toEqual({ kind: 'value', value: b.id });
    await selectOption('Default option', 'The first option');
    expect(lastDefault(onChange)).toEqual({ kind: 'firstChoice' });
    expect(
      followOptions('singleSelect', { choices: [a], defaultValue: { kind: 'value', value: b.id } }),
    ).not.toHaveProperty('defaultValue');
    expect(
      followOptions('multipleSelect', { choices: [a], defaultValue: { kind: 'value', value: [a.id, b.id] } }),
    ).toMatchObject({ defaultValue: { kind: 'value', value: [a.id] } });
  });

  it('gives a date today, which reads now once the field includes a time', async () => {
    const onChange = optionsFor('date');
    await selectOption('Default date', 'Today');
    expect(lastDefault(onChange)).toEqual({ kind: 'today' });
    await userEvent.click(screen.getByRole('switch', { name: 'Include a time' }));
    expect(lastDefault(onChange)).toEqual({ kind: 'now' });
    expect(screen.getByRole('button', { name: /Default date/ }).textContent).toContain('Now');
  });

  it('chooses a rating up to the field’s maximum', async () => {
    const onChange = optionsFor('rating', { max: 3 });
    await userEvent.click(screen.getByRole('button', { name: /Default rating/ }));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'None',
      '1',
      '2',
      '3',
    ]);
    await userEvent.click(screen.getByRole('option', { name: '2' }));
    expect(lastDefault(onChange)).toEqual({ kind: 'value', value: 2 });
  });

  it('says why a default doesn’t fit, such as on a field with unique values', async () => {
    optionsFor('text', { unique: true, defaultValue: { kind: 'value', value: 'Same' } });
    expect(screen.getByRole('alert').textContent).toContain(
      'A field with unique values can’t have a default.',
    );
    cleanup();
    optionsFor('number', { validation: { max: { value: 5 } }, defaultValue: { kind: 'value', value: 9 } });
    expect(screen.getByRole('alert').textContent).toBe(
      'This default doesn’t fit the field’s options or rules.',
    );
  });

  it('stays out of computed fields, AI fields, and fields of synced tables', () => {
    optionsFor('longText');
    expect(screen.queryByRole('group', { name: 'Default value' })).toBeNull();
    cleanup();
    optionsFor('text', {}, true);
    expect(screen.queryByRole('group', { name: 'Default value' })).toBeNull();
  });
});
