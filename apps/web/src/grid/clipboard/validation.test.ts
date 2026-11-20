import { expect, it } from 'vitest';
import { FieldSpec } from '@riosoma/contracts';
import { meta } from '../../screens/import/columns';
import { planPaste } from './plan';

it('lists refused paste cells with their custom rule messages before applying', () => {
  const field = meta(
    FieldSpec.parse({
      type: 'text',
      options: {
        validation: {
          required: {},
          minLength: { value: 3, message: 'Use three characters' },
        },
      },
    }),
  );
  const plan = planPaste({
    cells: [['No'], ['Valid'], ['']],
    start: { row: 0, col: 0 },
    selection: { rows: 3, cols: 1 },
    fields: [field],
    rowCount: 3,
    rowIdAt: (index) => `rec0000000000000${index}`,
    context: { locale: 'en-US', timeZone: 'UTC', collaborators: new Map() },
  });
  expect(plan.problems).toMatchObject([
    { row: 0, col: 0, messageKey: 'data.validation.minLength', message: 'Use three characters' },
    { row: 2, col: 0, messageKey: 'data.validation.required' },
  ]);
  expect(plan.updates).toEqual([{ id: 'rec00000000000001', values: { [field.id]: 'Valid' } }]);
});
