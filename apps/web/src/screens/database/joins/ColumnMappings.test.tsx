import { useState } from 'react';
import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { FieldMeta, newId, type ColumnSuggestions } from '@riosoma/contracts';
import type { DatabaseSession } from '../../../data';
import { ColumnMappings, type MappingDraft } from './ColumnMappings';

const state = vi.hoisted(() => ({
  schema: {
    fields: new Map<string, FieldMeta[]>(),
    fieldById: new Map<string, FieldMeta>(),
    tableById: new Map<string, { name: string }>(),
  },
  response: undefined as unknown as ColumnSuggestions,
}));
vi.mock('../../../data', () => ({ useSchema: () => state.schema }));
vi.mock('../../../api', () => ({ api: async () => state.response }));
afterEach(cleanup);

it('keeps a refusal visible when accepting all proposals also applies a compatible mapping', async () => {
  const first = newId('table');
  const second = newId('table');
  const now = new Date().toISOString();
  const field = (tableId: string, name: string, type: string, position: number) =>
    FieldMeta.parse({
      id: newId('field'),
      tableId,
      name,
      type,
      options: {},
      description: '',
      position,
      createdAt: now,
      updatedAt: now,
    });
  const left = [field(first, 'Date key', 'date', 0), field(first, 'Customer', 'text', 1)];
  const right = [field(second, 'Text key', 'text', 0), field(second, 'Customer name', 'text', 1)];
  state.schema.fields = new Map([
    [first, left],
    [second, right],
  ]);
  state.schema.fieldById = new Map([...left, ...right].map((field) => [field.id, field]));
  state.schema.tableById = new Map([
    [first, { name: 'First' }],
    [second, { name: 'Second' }],
  ]);
  const sources = (index: number) =>
    [left[index]!, right[index]!].map((field) => ({ tableId: field.tableId, fieldId: field.id }));
  state.response = {
    suggestions: [0, 1].map((index) => ({
      sources: sources(index),
      confidence: 1,
      explanation: '',
      reason: {
        messageKey: index ? 'joined.mapping.agreement' : 'joined.mapping.keys',
        params: { percent: 100 },
      },
      matchingRows: 4,
      agreement: 1,
    })),
    profiledFields: 4,
    ms: 1,
  };
  const onChange = vi.fn();
  const session = { databaseId: newId('database') } as DatabaseSession;
  function Editor() {
    const [mappings, setMappings] = useState<MappingDraft[]>([]);
    return (
      <ColumnMappings
        session={session}
        input={{
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
        }}
        mappings={mappings}
        onInclude={vi.fn()}
        onChange={(value) => {
          onChange(value);
          setMappings(value);
        }}
      />
    );
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nProvider i18n={setupI18n({ locale: 'en-US', messages: { 'en-US': {} } })}>
      <QueryClientProvider client={client}>
        <Editor />
      </QueryClientProvider>
    </I18nProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: 'Accept all mappings' }));
  expect(onChange).toHaveBeenLastCalledWith([{ sources: sources(1), name: 'Customer' }]);
  expect((screen.getByRole('textbox', { name: 'Output column name' }) as HTMLInputElement).value).toBe(
    'Customer',
  );
  const refusal = screen.getByText(/These sources cannot share a column without losing information\./);
  expect(refusal.textContent).toBe(
    'These sources cannot share a column without losing information.  Choose compatible types or keep them separate.',
  );
  expect(refusal.closest('[hidden]')).toBeNull();
  client.clear();
});
