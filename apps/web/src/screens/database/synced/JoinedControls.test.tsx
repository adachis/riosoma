import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { newId, type FieldMeta, type RowData, type SyncHistoryPage } from '@riosoma/contracts';
import type { DatabaseSession } from '../../../data';
import type * as ApiModule from '../../../api';
import { renderShell } from '../shell/test-support';
import { ComputedPin } from './ComputedPin';
import { SyncHistory } from './SyncHistory';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../../api', async (original) => ({ ...(await original<typeof ApiModule>()), api: request }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('validates a computed pin and submits it through the record command', async () => {
  const run = vi.fn(() => ({ done: Promise.resolve({ rejected: false }) }));
  const field = {
    id: newId('field'),
    tableId: newId('table'),
    name: 'Total',
    type: 'rollup',
    options: { resultType: 'number' },
  } as FieldMeta;
  const row = { id: newId('record'), values: { [field.id]: 4 } } as RowData;
  renderShell(<ComputedPin field={field} row={row} session={{ run } as unknown as DatabaseSession} />);
  const input = screen.getByRole('textbox', { name: 'Pinned value for Total' });
  await userEvent.clear(input);
  await userEvent.type(input, 'invalid');
  expect(screen.getByRole('button', { name: 'Pin value' }).hasAttribute('disabled')).toBe(true);
  await userEvent.clear(input);
  await userEvent.type(input, '12');
  await userEvent.click(screen.getByRole('button', { name: 'Pin value' }));
  await waitFor(() =>
    expect(run).toHaveBeenCalledWith([
      {
        kind: 'record.update',
        tableId: field.tableId,
        records: [{ id: row.id, values: { [field.id]: 12 } }],
      },
    ]),
  );
});

it('reads sync outcomes and follows the older-runs cursor', async () => {
  const tableId = newId('table');
  const page: SyncHistoryPage = {
    runs: [
      {
        id: newId('job'),
        tableId,
        startedAt: '2026-01-01T00:00:00Z',
        endedAt: '2026-01-01T00:00:02Z',
        outcome: 'succeeded',
        errorKey: null,
        stats: { added: 2, changed: 1, removed: 0, unchanged: 3, overridesCleared: 1, ms: 2000 },
      },
    ],
    next: 'older',
  };
  request.mockResolvedValue(page);
  const onPage = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderShell(
    <QueryClientProvider client={client}>
      <SyncHistory tableId={tableId} onPage={onPage} />
    </QueryClientProvider>,
  );
  expect(await screen.findByText('Completed')).toBeDefined();
  expect(
    screen.getByText('2 added, 1 changed, 0 removed, 3 unchanged, and 1 overrides cleared'),
  ).toBeDefined();
  await userEvent.click(screen.getByRole('button', { name: 'Older runs' }));
  expect(onPage).toHaveBeenCalledWith('older');
  expect(request).toHaveBeenCalledWith(`/api/tables/${tableId}/sync-history`, expect.anything());
  client.clear();
});
