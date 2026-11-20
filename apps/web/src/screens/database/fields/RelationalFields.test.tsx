import { cleanup, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FieldOptions, FieldSpec, newId, type FieldType } from '@riosoma/contracts';
import { openDatabase, type DatabaseSession } from '../../../data';
import { FakeServer } from '../../../data/testing';
import { relationalFixture } from '../../../data/testing/relational';
import { FieldDialog } from './FieldDialog';
import { FormulaEditor } from './FormulaEditor';
import { renderField, selectOption } from './fieldTestUtils';
import { rollupFunctions } from './RelationalOptions';

const sessions: DatabaseSession[] = [];
afterEach(() => {
  cleanup();
  sessions.splice(0).forEach((session) => session.close());
});

describe('relational field configuration', () => {
  it.each([
    ['link', 'Link to another record'],
    ['lookup', 'Lookup'],
    ['rollup', 'Rollup'],
    ['count', 'Count'],
    ['formula', 'Formula'],
  ] as const)('configures and persists %s', async (type: FieldType, label: string) => {
    const server = new FakeServer();
    const f = relationalFixture(server);
    const session = await openDatabase(f.source.databaseId, server.deps());
    sessions.push(session);
    const id = newId('field');
    let saving = Promise.resolve({ applied: 0, rejected: 0 });
    const submit = vi.fn(
      ({ name, description, spec }: { name: string; description: string; spec: FieldSpec }) => {
        saving = session.run([
          { kind: 'field.create', tableId: f.source.tableId, field: { id, name, description, ...spec } },
        ]).done;
      },
    );
    renderField(
      <FieldDialog
        mode="create"
        schema={session.getSchema()}
        tableId={f.source.tableId}
        existingNames={[]}
        isSaving={false}
        onSubmit={submit}
        onCancel={() => {}}
      />,
    );
    await selectOption('Type', label);
    if (type === 'link') {
      await selectOption('Link to$', 'Projects');
      await userEvent.click(screen.getByRole('switch', { name: 'Allow linking to more than one record' }));
    }
    if (type === 'lookup' || type === 'rollup')
      await selectOption(type === 'lookup' ? 'Field to look up' : 'Field to summarize', 'Price');
    if (type === 'rollup') await selectOption('Summary', 'Sum');
    if (type === 'formula')
      fireEvent.change(screen.getByRole('textbox', { name: 'Formula' }), {
        target: { value: '{Number} * 3' },
      });
    await userEvent.click(screen.getByRole('button', { name: 'Create field' }));
    expect(submit).toHaveBeenCalledOnce();
    expect(await saving).toEqual({ applied: 1, rejected: 0 });
    const saved = server.database(f.source.databaseId).field(id);
    expect(saved.type).toBe(type);
    if (type === 'link')
      expect(saved.options).toMatchObject({ linkedTableId: f.tableId, prefersSingle: true });
    if (type === 'lookup' || type === 'rollup')
      expect(saved.options).toMatchObject({ linkFieldId: f.link.id, targetFieldId: f.price.id });
    if (type === 'rollup') expect(saved.options).toMatchObject({ fn: 'sum', resultType: 'number' });
    if (type === 'count') expect(saved.options).toMatchObject({ linkFieldId: f.link.id });
    if (type === 'formula')
      expect(saved.options).toMatchObject({
        expression: `({${f.source.numberFieldId}} * 3)`,
        resultType: 'number',
      });
  });

  it('offers functions by target type and clears stale targets after changing links', async () => {
    const server = new FakeServer();
    const f = relationalFixture(server);
    expect(rollupFunctions(f.price)).toContain('sum');
    expect(rollupFunctions(f.title)).not.toContain('sum');
    expect(rollupFunctions(f.done)).toContain('and');
    expect(rollupFunctions(f.price)).not.toContain('and');
    expect(rollupFunctions(f.date)).toContain('earliest');
    expect(rollupFunctions(f.price)).not.toContain('earliest');
    const session = await openDatabase(f.source.databaseId, server.deps());
    sessions.push(session);
    renderField(
      <FieldDialog
        mode="create"
        schema={session.getSchema()}
        tableId={f.source.tableId}
        existingNames={[]}
        isSaving={false}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    await selectOption('Type', 'Rollup');
    await selectOption('Field to summarize', 'Price');
    await selectOption('Summary', 'Sum');
    await selectOption('Field to summarize', 'Done');
    await userEvent.click(screen.getByRole('button', { name: /Summary/ }));
    expect(screen.queryByRole('option', { name: /^Sum(?: |$)/ })).toBeNull();
    expect(screen.getByRole('option', { name: /^All true(?: |$)/ })).toBeTruthy();
  });

  it('autocompletes names and functions, checks result types, and highlights exact error spans', async () => {
    const server = new FakeServer();
    const f = relationalFixture(server);
    const fields = f.database.schema.fields.filter((field) => field.tableId === f.source.tableId);
    const options = FieldSpec.parse({ type: 'formula' });
    if (options.type !== 'formula') throw new Error('Expected formula');
    renderField(<FormulaEditor options={options.options} fields={fields} onChange={() => {}} />);
    const area = screen.getByRole('textbox', { name: 'Formula' });
    area.focus();
    fireEvent.change(area, { target: { value: '{Num', selectionStart: 4 } });
    fireEvent.select(area, { target: { selectionStart: 4 } });
    await userEvent.click(screen.getByRole('option', { name: /^Number(?: |$)/ }));
    expect((area as HTMLTextAreaElement).value).toBe('{Number}');
    expect(screen.getByText('Result: Number')).toBeTruthy();
    fireEvent.change(area, { target: { value: 'SU', selectionStart: 2 } });
    fireEvent.select(area, { target: { selectionStart: 2 } });
    await userEvent.click(screen.getByRole('option', { name: /^SUM(?: |$)/ }));
    expect((area as HTMLTextAreaElement).value).toBe('SUM(');
    fireEvent.change(area, { target: { value: '{Missing} + 1' } });
    expect(screen.getByText('There’s no field named Missing.')).toBeTruthy();
    const mark = document.querySelector('mark');
    expect(mark?.textContent).toBe('{Missing}');
    expect(mark?.getAttribute('data-start')).toBe('0');
    expect(mark?.getAttribute('data-end')).toBe('9');
    expect(area.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(area, { target: { value: 'NOW()' } });
    expect(screen.getByText('Result: Date and time')).toBeTruthy();
    // A lookup where one value belongs reads as that value, and the hint says so.
    fireEvent.change(area, { target: { value: '{Prices} * {Number}' } });
    expect(screen.getByText('Result: Number')).toBeTruthy();
    expect(
      screen.getByText(
        'Prices reads as its one value here: blank when it’s empty, and an error when it holds more than one.',
      ),
    ).toBeTruthy();
    fireEvent.change(area, { target: { value: 'SUM({Prices})' } });
    expect(screen.queryByText(/reads as its one value/)).toBeNull();
  });
});

it('edits a linked condition against the current record and saves its field ID', async () => {
  const server = new FakeServer();
  const f = relationalFixture(server);
  const session = await openDatabase(f.source.databaseId, server.deps());
  sessions.push(session);
  const submit = vi.fn();
  renderField(
    <FieldDialog
      mode="create"
      schema={session.getSchema()}
      tableId={f.source.tableId}
      existingNames={[]}
      isSaving={false}
      onSubmit={submit}
      onCancel={() => {}}
    />,
  );
  await selectOption('Type', 'Count');
  await userEvent.click(screen.getByRole('button', { name: 'Add condition' }));
  await selectOption(' Field$', 'Price');
  await selectOption(' Condition$', '>');
  await selectOption('Compare with', 'Number');
  await userEvent.click(screen.getByRole('button', { name: 'Create field' }));
  expect(submit).toHaveBeenCalledOnce();
  expect(submit.mock.calls[0]![0].spec.options.filter.conditions[0]).toMatchObject({
    fieldId: f.price.id,
    operator: 'gt',
    currentFieldId: f.source.numberFieldId,
  });
});

it('autocompletes a structured reference with the keyboard and validates a conditional total', async () => {
  const server = new FakeServer();
  const f = relationalFixture(server);
  const session = await openDatabase(f.source.databaseId, server.deps());
  sessions.push(session);
  const schema = session.getSchema();
  const onChange = vi.fn();
  renderField(
    <FormulaEditor
      options={FieldOptions.formula.parse({})}
      fields={[...schema.fieldById.values()]}
      tables={schema.tables}
      tableId={f.source.tableId}
      onChange={onChange}
    />,
  );
  const input = screen.getByRole('textbox', { name: 'Formula' });
  await userEvent.type(input, 'SUMIFS(Projects[[Pr');
  expect(screen.getByRole('option', { name: /^Projects\[Price\](?: |$)/ })).not.toBeNull();
  await userEvent.keyboard('{Enter}');
  expect((input as HTMLTextAreaElement).value).toBe('SUMIFS(Projects[Price]');
  fireEvent.change(input, { target: { value: 'SUMIFS(Projects[Price], Projects[Price], ">5")' } });
  expect(screen.getByText('Result: Number')).not.toBeNull();
});

it('keeps earlier quoted arguments when completing a quoted table reference', async () => {
  const server = new FakeServer();
  const f = relationalFixture(server);
  const session = await openDatabase(f.source.databaseId, server.deps());
  sessions.push(session);
  const schema = session.getSchema();
  renderField(
    <FormulaEditor
      options={FieldOptions.formula.parse({})}
      fields={[...schema.fieldById.values()]}
      tables={schema.tables.map((table) =>
        table.id === f.source.tableId ? table : { ...table, name: 'Sales Leads' },
      )}
      tableId={f.source.tableId}
      onChange={() => {}}
    />,
  );
  const input = screen.getByRole('textbox', { name: 'Formula' });
  const draft = "IF({Number} > 0, 'Earlier', SUMIFS('Sales Leads'[Pr";
  input.focus();
  fireEvent.change(input, { target: { value: draft, selectionStart: draft.length } });
  fireEvent.select(input, { target: { selectionStart: draft.length } });
  expect(screen.getByRole('option', { name: /^'Sales Leads'\[Price\](?: |$)/ })).not.toBeNull();
  await userEvent.keyboard('{Enter}');
  expect((input as HTMLTextAreaElement).value).toBe(
    "IF({Number} > 0, 'Earlier', SUMIFS('Sales Leads'[Price]",
  );
});

it('completes named functions with parameters and descriptions and shows call diagnostics', async () => {
  const definition = {
    id: newId('namedFunction'),
    databaseId: newId('database'),
    name: 'NET',
    parameters: ['amount', 'discount'],
    body: 'amount * (1 - discount)',
    description: 'Apply a discount',
    revision: 1,
    createdBy: null,
    updatedBy: null,
    createdAt: '',
    updatedAt: '',
  };
  const onChange = vi.fn();
  renderField(
    <FormulaEditor
      options={FieldOptions.formula.parse({ expression: 'NET(100, 0.2)' })}
      fields={[]}
      namedFunctions={[definition]}
      onChange={onChange}
    />,
  );
  const input = screen.getByRole('textbox', { name: 'Formula' });
  expect((input as HTMLTextAreaElement).value).toBe('NET(100, 0.2)');
  input.focus();
  fireEvent.change(input, { target: { value: 'NET', selectionStart: 3 } });
  fireEvent.select(input, { target: { selectionStart: 3 } });
  expect(
    screen.getByRole('option', { name: /^NET\(amount, discount\) Apply a discount(?: |$)/ }),
  ).not.toBeNull();
  await userEvent.keyboard('{Enter}');
  expect((input as HTMLTextAreaElement).value).toBe('NET(');
  fireEvent.change(input, { target: { value: 'NET(100)' } });
  expect(screen.getByText('Check how many arguments NET needs.')).not.toBeNull();
  expect(onChange.mock.lastCall?.[0].expression).toBe('NET(100)');
});
