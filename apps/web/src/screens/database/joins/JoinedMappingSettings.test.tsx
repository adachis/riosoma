import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { FieldMeta, newId, type TableMeta } from '@riosoma/contracts';
import type { DatabaseSession } from '../../../data';
import { JoinedMappingSettings } from './JoinedMappingSettings';

const state = vi.hoisted(() => ({
  schema: {
    fields: new Map<string, FieldMeta[]>(),
    fieldById: new Map<string, FieldMeta>(),
    tableById: new Map<string, { name: string }>(),
  },
}));
vi.mock('../../../data', () => ({ useSchema: () => state.schema }));
vi.mock('../../../api', () => ({ api: async () => ({ suggestions: [] }) }));
afterEach(cleanup);

function fixture() {
  const first = newId('table');
  const second = newId('table');
  const id = newId('table');
  const now = new Date().toISOString();
  const field = (tableId: string, name: string, position: number) =>
    FieldMeta.parse({
      id: newId('field'),
      tableId,
      name,
      type: 'text',
      options: {},
      description: '',
      position,
      createdAt: now,
      updatedAt: now,
    });
  const left = [field(first, 'Week ending', 0), field(first, 'Customer', 1)];
  const right = [field(second, 'Date', 0), field(second, 'Customer', 1)];
  const output = [field(id, 'Weekly sales Week ending', 0), field(id, 'Customer', 1)];
  output[0]!.description = 'Weekly sales date';
  const table = {
    id,
    name: 'Combined',
    joined: {
      baseTableId: first,
      steps: [
        {
          tableId: second,
          leftTableId: first,
          leftFieldId: left[0]!.id,
          rightFieldId: right[0]!.id,
          kind: 'full',
        },
      ],
      fields: [
        { tableId: first, fieldId: left[0]!.id, outputFieldId: output[0]!.id },
        {
          tableId: first,
          fieldId: left[1]!.id,
          outputFieldId: output[1]!.id,
          sources: [left[1]!, right[1]!].map((field) => ({ tableId: field.tableId, fieldId: field.id })),
        },
      ],
    },
  } as TableMeta;
  state.schema.fields = new Map([
    [first, left],
    [second, right],
    [id, output],
  ]);
  state.schema.fieldById = new Map([...left, ...right, ...output].map((field) => [field.id, field]));
  state.schema.tableById = new Map([
    [first, { name: 'Weekly sales' }],
    [second, { name: 'Customers' }],
  ]);
  const run = vi.fn(() => ({ done: Promise.resolve({ rejected: false }) }));
  const session = { databaseId: newId('database'), run } as unknown as DatabaseSession;
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nProvider i18n={setupI18n({ locale: 'en-US', messages: { 'en-US': {} } })}>
      <QueryClientProvider client={client}>
        <h2>Map corresponding columns</h2>
        <JoinedMappingSettings session={session} table={table} onClose={onClose} />
      </QueryClientProvider>
    </I18nProvider>,
  );
  return { run, onClose, client, table, output };
}

it('preserves untouched output names and settings when renaming a mapping', async () => {
  const { run, output, client } = fixture();
  const name = screen.getByRole('textbox', { name: 'Output column name' });
  await userEvent.clear(name);
  await userEvent.type(name, 'Account name');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  const [command] = run.mock.calls[0]! as unknown as [Array<{ joinedFields: FieldMeta[] }>];
  expect(command[0]!.joinedFields[0]).toMatchObject({
    id: output[0]!.id,
    name: 'Weekly sales Week ending',
    description: 'Weekly sales date',
    type: output[0]!.type,
    options: output[0]!.options,
  });
  expect(command[0]!.joinedFields[1]!.name).toBe('Account name');
  client.clear();
});

it('shows the mapping title once', () => {
  const { client } = fixture();
  expect(screen.getAllByText('Map corresponding columns')).toHaveLength(1);
  client.clear();
});

it('announces progress until a mapping save completes', async () => {
  const { run, onClose, client } = fixture();
  let complete!: (value: { rejected: boolean }) => void;
  run.mockReturnValueOnce({
    done: new Promise((resolve) => {
      complete = resolve;
    }),
  });
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(screen.getByRole('status').textContent).toContain('Saving column mappings');
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => complete({ rejected: false }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(screen.queryByText(/Saving column mappings/)).toBeNull();
  client.clear();
});
