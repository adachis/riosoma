import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DatabaseTrash } from '@riosoma/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import type { DatabaseSession } from '../../../data/types';
import { renderHome } from '../../home/test-support';
import { TrashDialog } from '../../trash/TrashDialog';
import { interfaceFixture } from './test-support';

let session: DatabaseSession | undefined;
afterEach(() => {
  cleanup();
  session?.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const json = (data: unknown) =>
  new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

it('lists a deleted interface in the trash and restores it through the session', async () => {
  const setup = await interfaceFixture();
  session = setup.session;
  await session.run([{ kind: 'interface.trash', interfaceId: setup.value.id }]).done;
  expect(session.getSchema().interfaceById.has(setup.value.id)).toBe(false);
  const item: DatabaseTrash['items'][number] = {
    kind: 'interface',
    id: setup.value.id,
    name: 'Front desk',
    tableId: null,
    tableName: null,
    trashedAt: new Date(Date.now() - 86_400_000).toISOString(),
    trashedBy: setup.server.userId,
  };
  const database = setup.server.database(setup.fixture.databaseId);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      json({
        items: database.schema.interfaces?.some((value) => value.id === item.id) ? [] : [item],
        records: [],
      }),
    ),
  );
  renderHome(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TrashDialog session={session} onClose={() => undefined} />
    </QueryClientProvider>,
  );
  const restore = await screen.findByRole('button', { name: 'Restore Front desk' });
  expect(screen.getByText('Interface')).toBeDefined();
  await userEvent.click(restore);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Restore Front desk' })).toBeNull());
  expect(session.getSchema().interfaceById.get(setup.value.id)?.name).toBe('Front desk');
  await waitFor(() => expect(database.schema.interfaces?.map((value) => value.id)).toEqual([setup.value.id]));
  expect(setup.commands().map((command) => command.kind)).toEqual(['interface.trash', 'interface.restore']);
});
