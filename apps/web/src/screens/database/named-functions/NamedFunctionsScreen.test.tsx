import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { FieldMeta, NamedFunctionMeta, newId } from '@riosoma/contracts';
import { openDatabase } from '../../../data/session';
import { FakeServer } from '../../../data/testing';
import type { DatabaseSession } from '../../../data/types';
import { renderShell } from '../shell/test-support';
import { NamedFunctionsScreen } from './NamedFunctionsScreen';

const sessions: DatabaseSession[] = [];
afterEach(() => {
  cleanup();
  sessions.splice(0).forEach((session) => session.close());
  vi.restoreAllMocks();
});

async function mount(options: { selected?: boolean; reader?: boolean } = {}) {
  const server = new FakeServer();
  const fixture = server.createDatabase(0);
  const session = await openDatabase(fixture.databaseId, server.deps());
  sessions.push(session);
  if (options.reader) vi.spyOn(session, 'role').mockReturnValue('reader');
  const schema = session.getSchema();
  const definition = NamedFunctionMeta.parse({
    id: newId('namedFunction'),
    databaseId: fixture.databaseId,
    name: 'DOUBLE',
    parameters: ['amount'],
    body: 'amount * 2',
    description: 'Double an amount',
    revision: 4,
    createdBy: null,
    updatedBy: null,
    createdAt: '',
    updatedAt: '',
  });
  schema.namedFunctions = [definition];
  const field = FieldMeta.parse({
    id: newId('field'),
    tableId: fixture.tableId,
    name: 'Total',
    type: 'formula',
    options: { expression: 'DOUBLE(5)' },
    description: '',
    position: 1,
    createdAt: '',
    updatedAt: '',
  });
  schema.fieldById = new Map([...schema.fieldById, [field.id, field]]);
  const run = vi
    .spyOn(session, 'run')
    .mockReturnValue({ groupId: newId('action'), done: Promise.resolve({ applied: 1, rejected: 0 }) });
  const onOpen = vi.fn();
  const rendered = renderShell(
    <NamedFunctionsScreen
      session={session}
      schema={schema}
      functionId={options.selected ? definition.id : 'new'}
      onOpen={onOpen}
    />,
  );
  return { session, schema, definition, run, onOpen, rendered };
}

it('completes a parameter with the keyboard, tests a draft, and creates it through a command', async () => {
  const { run, onOpen } = await mount();
  await userEvent.type(screen.getByRole('textbox', { name: 'Function name' }), 'TRIPLE');
  await userEvent.type(screen.getByRole('textbox', { name: 'Parameters (comma separated)' }), 'value');
  const body = screen.getByRole('textbox', { name: 'Formula' });
  body.focus();
  fireEvent.change(body, { target: { value: 'val', selectionStart: 3 } });
  fireEvent.select(body, { target: { selectionStart: 3 } });
  expect(screen.getByRole('option', { name: /^value$/ })).toBeDefined();
  await userEvent.keyboard('{Enter}');
  expect((body as HTMLTextAreaElement).value).toBe('value');
  fireEvent.change(body, { target: { value: 'value * 3' } });
  await userEvent.type(screen.getByRole('textbox', { name: 'Sample argument: value' }), '7');
  await userEvent.click(screen.getByRole('button', { name: 'Run test' }));
  expect(screen.getByText('Result: 21')).toBeDefined();
  await userEvent.click(screen.getByRole('button', { name: 'Save function' }));
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith());
  expect(run.mock.calls[0]![0]).toMatchObject([
    {
      kind: 'namedFunction.create',
      definition: { name: 'TRIPLE', parameters: ['value'], body: 'value * 3' },
    },
  ]);
});

it('renames and edits with the saved revision, and asks before deleting a caller', async () => {
  const { definition, run, onOpen } = await mount({ selected: true });
  const name = screen.getByRole('textbox', { name: 'Function name' });
  await userEvent.clear(name);
  await userEvent.type(name, 'TRIPLE');
  fireEvent.change(screen.getByRole('textbox', { name: 'Formula' }), { target: { value: 'amount * 3' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save function' }));
  await waitFor(() => expect(onOpen).toHaveBeenCalled());
  expect(run.mock.calls[0]![0]).toMatchObject([
    {
      kind: 'namedFunction.update',
      functionId: definition.id,
      revision: 4,
      definition: { name: 'TRIPLE', body: 'amount * 3' },
    },
  ]);
  run.mockClear();
  await userEvent.click(screen.getByRole('button', { name: 'Delete function' }));
  const dialog = screen.getByRole('dialog', { name: 'Delete DOUBLE?' });
  expect(within(dialog).getByText(/Total/)).toBeDefined();
  expect(run).not.toHaveBeenCalled();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Delete function' }));
  await waitFor(() => expect(run).toHaveBeenCalled());
  expect(run.mock.calls[0]![0]).toMatchObject([
    { kind: 'namedFunction.delete', revision: 4, confirmUsed: true },
  ]);
});

it('shows a translated diagnostic for oversized samples and can run another test', async () => {
  const { run } = await mount({ selected: true });
  const sample = screen.getByRole('textbox', { name: 'Sample argument: amount' });
  fireEvent.change(sample, { target: { value: Array.from({ length: 10_000 }, () => '1').join('+') } });
  await userEvent.click(screen.getByRole('button', { name: 'Run test' }));
  expect(screen.getByRole('status').textContent).toBe('This calculation exceeds the formula’s limits.');
  fireEvent.change(sample, { target: { value: '10' } });
  await userEvent.click(screen.getByRole('button', { name: 'Run test' }));
  expect(screen.getByRole('status').textContent).toBe('Result: 20');
  expect(run).not.toHaveBeenCalled();
});

it('shows readable definitions while withholding mutation controls from readers', async () => {
  await mount({ selected: true, reader: true });
  expect((screen.getByRole('textbox', { name: 'Function name' }) as HTMLInputElement).readOnly).toBe(true);
  expect((screen.getByRole('textbox', { name: 'Formula' }) as HTMLTextAreaElement).readOnly).toBe(true);
  for (const name of ['Create function', 'Save function', 'Delete function'])
    expect(screen.queryByRole('button', { name })).toBeNull();
});

it('refreshes a reader’s open definition when someone else changes it', async () => {
  const { session, schema, definition, onOpen, rendered } = await mount({ selected: true, reader: true });
  rendered.rerender(
    <NamedFunctionsScreen
      session={session}
      schema={{
        ...schema,
        namedFunctions: [{ ...definition, name: 'TRIPLE', body: 'amount * 3', revision: 5 }],
      }}
      functionId={definition.id}
      onOpen={onOpen}
    />,
  );
  expect((screen.getByRole('textbox', { name: 'Function name' }) as HTMLInputElement).value).toBe('TRIPLE');
  expect((screen.getByRole('textbox', { name: 'Formula' }) as HTMLTextAreaElement).value).toBe('amount * 3');
});

it('retains an editor’s draft and original revision when someone else changes the definition', async () => {
  const { session, schema, definition, onOpen, rendered, run } = await mount({ selected: true });
  fireEvent.change(screen.getByRole('textbox', { name: 'Formula' }), { target: { value: 'amount * 4' } });
  rendered.rerender(
    <NamedFunctionsScreen
      session={session}
      schema={{ ...schema, namedFunctions: [{ ...definition, body: 'amount * 3', revision: 5 }] }}
      functionId={definition.id}
      onOpen={onOpen}
    />,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Save function' }));
  expect(run.mock.calls[0]![0]).toMatchObject([
    { kind: 'namedFunction.update', revision: 4, definition: { body: 'amount * 4' } },
  ]);
});
