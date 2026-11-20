import { cleanup, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { FieldOptions, NamedFunctionMeta, newId } from '@riosoma/contracts';
import { FormulaEditor } from './FormulaEditor';
import { renderField } from './fieldTestUtils';

afterEach(cleanup);

const definition = NamedFunctionMeta.parse({
  id: newId('namedFunction'),
  databaseId: newId('database'),
  name: 'DOUBLE',
  parameters: ['amount'],
  body: 'amount * 2',
  description: '',
  revision: 1,
  createdBy: null,
  updatedBy: null,
  createdAt: '',
  updatedAt: '',
});

it.each([
  ['DOU(5)', 3, 'DOUBLE(amount)', 'DOUBLE(5)', 7],
  ['DOUble(5)', 3, 'DOUBLE(amount)', 'DOUBLE(5)', 7],
  ['DOU (5)', 3, 'DOUBLE(amount)', 'DOUBLE (5)', 8],
  ['SU(5, 6)', 2, 'SUM', 'SUM(5, 6)', 4],
  ['SU', 2, 'SUM', 'SUM(', 4],
] as const)(
  'completes %s while preserving the call’s arguments',
  async (draft, caret, label, expected, position) => {
    const changes: string[] = [];
    renderField(
      <FormulaEditor
        options={FieldOptions.formula.parse({})}
        fields={[]}
        namedFunctions={[definition]}
        onChange={(options) => changes.push(options.expression)}
      />,
    );
    const area = screen.getByRole('textbox', { name: 'Formula' }) as HTMLTextAreaElement;
    area.focus();
    fireEvent.change(area, { target: { value: draft, selectionStart: caret } });
    fireEvent.select(area, { target: { selectionStart: caret } });
    await userEvent.click(screen.getByRole('option', { name: label }));
    expect(area.value).toBe(expected);
    expect(changes.at(-1)).toBe(expected);
    expect(area.selectionStart).toBe(position);
  },
);
