import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { newId } from '@riosoma/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { TableSidebar } from '../../screens/database/shell/TableSidebar';
import { renderShell, table } from '../../screens/database/shell/test-support';
import { TrashWindowProvider } from './window';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = (data: unknown) =>
  new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

/** Opens a table's delete confirmation with the server answering the window with `answer`. */
async function confirmation(answer: unknown): Promise<() => string> {
  const fetch = vi.fn(async () => json(answer));
  vi.stubGlobal('fetch', fetch);
  renderShell(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TrashWindowProvider databaseId={newId('database')}>
        <TableSidebar
          tables={[table('Tasks'), table('Notes')]}
          activeTableId={null}
          hrefFor={(id) => `/${id}`}
          onNavigate={vi.fn()}
          canEdit
          onCreate={vi.fn()}
          onRename={vi.fn()}
          onDelete={vi.fn()}
          onMove={vi.fn()}
        />
      </TrashWindowProvider>
    </QueryClientProvider>,
  );
  await userEvent.click(screen.getByRole('button', { name: 'More for Tasks' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Delete table' }));
  const dialog = screen.getByRole('dialog', { name: 'Delete Tasks?' });
  return () => dialog.textContent ?? '';
}

it('names the window the administrator chose in a delete confirmation', async () => {
  let body = await confirmation({ days: 90, legalHold: false });
  await waitFor(() => expect(body()).toContain('You can restore them from the trash for 90 days.'));
  cleanup();
  // A window with no limit, and a hold, promise the trash without naming days that never come.
  body = await confirmation({ days: null, legalHold: false });
  await waitFor(() => expect(body()).toContain('You can restore them from the trash with no time limit.'));
  cleanup();
  body = await confirmation({ days: 7, legalHold: true });
  await waitFor(() =>
    expect(body()).toContain('You can restore them from the trash while a legal hold keeps it.'),
  );
  cleanup();
  // An answer that isn't a window leaves the default in place rather than naming nothing.
  body = await confirmation([]);
  await waitFor(() => expect(body()).toContain('You can restore them from the trash for 30 days.'));
});
