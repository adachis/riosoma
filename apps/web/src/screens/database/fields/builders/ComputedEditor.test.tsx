import { useState } from 'react';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { FieldOptions, FieldSpec, type FieldOptionsOf } from '@riosoma/contracts';
import { evaluate, formulaBuilder, type FormulaBuilder } from '@riosoma/formula';
import { checkFormula } from '../../../../data/formulas';
import { loadModule } from '../../../../docs/loader';
import { field, renderField, selectOption } from '../fieldTestUtils';
import { ComputedEditor } from './ComputedEditor';
import { builderExpression, builderFields } from './model';

afterEach(cleanup);
const first = { ...field(), name: 'First' };
const last = { ...field(), tableId: first.tableId, name: 'Last' };
const amount = { ...field(FieldSpec.parse({ type: 'number' })), tableId: first.tableId, name: 'Amount' };
const start = { ...field(FieldSpec.parse({ type: 'date' })), tableId: first.tableId, name: 'Start' };
const end = { ...start, id: field().id, name: 'End' };
const links = {
  ...field(FieldSpec.parse({ type: 'link', options: { linkedTableId: field().tableId } })),
  tableId: first.tableId,
  name: 'Links',
};
const fields = [first, last, amount, start, end, links];
const context = { now: '2026-10-01T00:00:00Z', timeZone: 'UTC' };

it('uses formula types for date ranges, attachments, and signature timestamps', () => {
  const range = field(FieldSpec.parse({ type: 'dateRange' }));
  const attachment = field(FieldSpec.parse({ type: 'attachment' }));
  const signature = field(FieldSpec.parse({ type: 'signature' }));
  const special = [range, attachment, signature];
  expect(builderFields('mapping', special)).toEqual([]);
  expect(builderFields('difference', special)).toEqual([signature]);
  expect(builderFields('combine', special)).toEqual([signature]);
});

function mount(expression = '') {
  function Harness() {
    const [options, change] = useState<FieldOptionsOf<'formula'>>(() =>
      FieldOptions.formula.parse({ expression }),
    );
    return <ComputedEditor fields={fields} tableId={first.tableId} options={options} onChange={change} />;
  }
  return renderField(<Harness />);
}

it.each([
  [{ kind: 'combine', first: first.id, second: last.id, separator: '\n' }, 'Separator', 'separator'],
  [
    {
      kind: 'mapping',
      field: first.id,
      match: 'Ada\nLovelace',
      then: 'yes\nplease',
      otherwise: 'no\nthanks',
    },
    'If the value equals',
    'match',
  ],
  [
    {
      kind: 'mapping',
      field: first.id,
      match: 'Ada\nLovelace',
      then: 'yes\nplease',
      otherwise: 'no\nthanks',
    },
    'Then return',
    'then',
  ],
  [
    {
      kind: 'mapping',
      field: first.id,
      match: 'Ada\nLovelace',
      then: 'yes\nplease',
      otherwise: 'no\nthanks',
    },
    'Otherwise return',
    'otherwise',
  ],
  [
    { kind: 'bucket', field: amount.id, boundary: 10, then: 'low\nvalue', otherwise: 'high\nvalue' },
    'Then return',
    'then',
  ],
  [
    { kind: 'bucket', field: amount.id, boundary: 10, then: 'low\nvalue', otherwise: 'high\nvalue' },
    'Otherwise return',
    'otherwise',
  ],
] satisfies Array<[FormulaBuilder, string, 'separator' | 'match' | 'then' | 'otherwise']>)(
  'preserves line breaks when reopening and editing %j through %s',
  async (builder, label, key) => {
    mount(builderExpression(builder));
    const literal = (builder as Partial<Record<typeof key, string>>)[key]!;
    const control = screen.getByRole('textbox', { name: label });
    expect((control as HTMLTextAreaElement).value).toBe(literal);
    await userEvent.type(control, 'x');
    await selectOption('Edit as$', 'Formula');
    const expression = (screen.getByRole('textbox', { name: 'Formula' }) as HTMLTextAreaElement).value;
    const result = checkFormula(expression, fields, undefined, [], first.tableId);
    expect('ast' in result && formulaBuilder(result.ast)).toEqual({ ...builder, [key]: `${literal}x` });
    await selectOption(
      'Edit as$',
      builder.kind === 'combine'
        ? 'Combine text'
        : builder.kind === 'mapping'
          ? 'If-then mapping'
          : 'Bucket a number',
    );
    expect((screen.getByRole('textbox', { name: label }) as HTMLTextAreaElement).value).toBe(`${literal}x`);
  },
);

it.each(['\r', '\r\n'])('keeps carriage-return literals in the formula editor: %j', (separator) => {
  mount(builderExpression({ kind: 'combine', first: first.id, second: last.id, separator }));
  expect(screen.queryByRole('textbox', { name: 'Separator' })).toBeNull();
  const expression = (screen.getByRole('textbox', { name: 'Formula' }) as HTMLTextAreaElement).value;
  const result = checkFormula(expression, fields, undefined, [], first.tableId);
  expect('ast' in result && formulaBuilder(result.ast)).toMatchObject({ separator });
});

it('documents that blank numbers use the otherwise bucket result and distinguishes zero', async () => {
  const result = checkFormula(
    builderExpression({ kind: 'bucket', field: amount.id, boundary: 10, then: 'low', otherwise: 'high' }),
    fields,
    undefined,
    [],
    first.tableId,
  );
  expect('ast' in result).toBe(true);
  if (!('ast' in result)) return;
  for (const [value, expected] of [
    [0, 'low'],
    [10, 'high'],
    [null, 'high'],
  ] as const) {
    expect(
      evaluate(
        result.ast,
        { id: 'record', createdAt: context.now, updatedAt: context.now, values: { [amount.id]: value } },
        context,
      ),
    ).toBe(expected);
  }
  const help = await loadModule('formulas', 'en-US');
  const bucket = help?.body.split('\n').find((line) => line.startsWith('- {{ui:field.builder.bucket}}'));
  expect(bucket).toContain('Blank numbers use the otherwise result.');
});

it.each([
  [
    { kind: 'combine', first: first.id, second: last.id, separator: '"\\\n' },
    { [first.id]: 'Ada', [last.id]: 'Lovelace' },
    'Ada"\\\nLovelace',
  ],
  [
    { kind: 'difference', start: start.id, end: end.id, unit: 'days' },
    { [start.id]: '2026-09-29', [end.id]: '2026-10-01' },
    2,
  ],
  [
    { kind: 'mapping', field: first.id, match: 'Ada', then: 'yes', otherwise: 'no' },
    { [first.id]: 'Ada' },
    'yes',
  ],
  [
    { kind: 'bucket', field: amount.id, boundary: -2.5, then: 'low', otherwise: 'high' },
    { [amount.id]: -2.5 },
    'high',
  ],
  [{ kind: 'links', field: links.id, position: 2 }, { [links.id]: ['Ada', 'Grace'] }, 'Grace'],
] satisfies Array<[FormulaBuilder, Record<string, string | number | string[]>, string | number]>)(
  'round-trips and evaluates %j',
  (builder, values, expected) => {
    const result = checkFormula(builderExpression(builder), fields, undefined, [], first.tableId);
    expect('ast' in result).toBe(true);
    if ('ast' in result) {
      expect(formulaBuilder(result.ast)).toEqual(builder);
      expect(
        evaluate(
          result.ast,
          { id: 'record', createdAt: context.now, updatedAt: context.now, values },
          context,
        ),
      ).toBe(expected);
      const renamed = fields.map((field) => ({ ...field, name: `Renamed ${field.name}` }));
      expect(checkFormula(result.expression, renamed, undefined, [], first.tableId)).toMatchObject({
        type: result.type,
      });
    }
  },
);

it('opens a saved builder, edits it, and switches to and from the formula editor without losing text', async () => {
  mount(`CONCATENATE({${first.id}}, " ", {${last.id}})`);
  fireEvent.change(screen.getByRole('textbox', { name: 'Separator' }), { target: { value: ' / ' } });
  expect((screen.getByRole('textbox', { name: 'Formula' }) as HTMLInputElement).value).toContain('" / "');
  await selectOption('Edit as$', 'Formula');
  const editor = screen.getByRole('textbox', { name: 'Formula' });
  expect((editor as HTMLTextAreaElement).value).toContain('" / "');
  fireEvent.change(editor, { target: { value: 'CONCATENATE({First}, "!", {Last}) & "extra"' } });
  await selectOption('Edit as$', 'Combine text');
  expect((screen.getByRole('textbox', { name: 'Formula' }) as HTMLInputElement).value).not.toContain('extra');
});

it('keeps custom expressions and incompatible shapes in the formula editor and filters source types', async () => {
  mount(`ARRAYJOIN(ARRAYSLICE({${first.id}}, 1, 1), "")`);
  expect(screen.queryByRole('textbox', { name: 'Link position (starts at 1)' })).toBeNull();
  await selectOption('Edit as$', 'Bucket a number');
  await userEvent.click(screen.getByRole('button', { name: /Source field$/ }));
  expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Amount']);
  await userEvent.keyboard('{Escape}');
  fireEvent.change(screen.getByRole('textbox', { name: 'If the number is below' }), {
    target: { value: '' },
  });
  expect((screen.getByRole('textbox', { name: 'Formula' }) as HTMLInputElement).value).toBe('');
  expect(screen.getByRole('status').textContent).toContain('valid number');
});

it('offers keyboard selection and rejects fractional, zero, and missing link positions', async () => {
  mount();
  const selector = screen.getByRole('button', { name: /Edit as$/ });
  selector.focus();
  await userEvent.keyboard('{Enter}');
  await screen.findByRole('listbox', { name: 'Edit as' });
  screen.getByRole('option', { name: 'Formula' }).focus();
  await userEvent.keyboard('{End}');
  await userEvent.keyboard('{Enter}');
  const position = await screen.findByRole('textbox', { name: 'Link position (starts at 1)' });
  for (const value of ['1.5', '0', '']) {
    fireEvent.change(position, { target: { value } });
    expect((screen.getByRole('textbox', { name: 'Formula' }) as HTMLInputElement).value).toBe('');
  }
});
