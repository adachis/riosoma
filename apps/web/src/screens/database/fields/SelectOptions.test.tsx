import { useState } from 'react';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { FieldMeta, newId, type FieldOptionsOf } from '@riosoma/contracts';
import type { SchemaState } from '../../../data';
import { SelectOptions } from './SelectOptions';
import { renderField } from './fieldTestUtils';

afterEach(cleanup);
it('edits one parent at a time and removes empty mappings', async () => {
  const tableId = newId('table');
  const parent = FieldMeta.parse({
    id: newId('field'),
    tableId,
    name: 'Parent',
    type: 'singleSelect',
    description: '',
    position: 0,
    createdAt: '',
    updatedAt: '',
    options: {
      choices: Array.from({ length: 200 }, (_, i) => ({
        id: newId('choice'),
        name: `Parent ${i}`,
        color: 'gray',
      })),
    },
  });
  if (parent.type !== 'singleSelect') throw new Error();
  const parentChoice = parent.options.choices[0]!.id;
  const choices = Array.from({ length: 100 }, (_, i) => ({
    id: newId('choice'),
    name: `Child ${i}`,
    color: 'gray' as const,
  }));
  const onChange = vi.fn();
  const schema = { fields: new Map([[tableId, [parent]]]), tables: [] } as unknown as SchemaState;
  function Host() {
    const [options, setOptions] = useState<FieldOptionsOf<'singleSelect'>>({
      choices,
      cascade: { fieldId: parent.id, mapping: { [parentChoice]: [choices[0]!.id] } },
    });
    return (
      <SelectOptions
        options={options}
        schema={schema}
        tableId={tableId}
        onChange={(value) => {
          onChange(value);
          setOptions(value);
        }}
      />
    );
  }
  renderField(<Host />);
  expect(screen.getAllByRole('checkbox')).toHaveLength(100);
  const search = screen.getByRole('searchbox', { name: 'Find child options' });
  await userEvent.type(search, 'Child 0');
  expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  await userEvent.click(screen.getByRole('checkbox', { name: 'Child 0' }));
  expect(onChange.mock.lastCall?.[0].cascade.mapping).toEqual({});
});
