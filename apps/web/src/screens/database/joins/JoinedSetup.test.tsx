import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LIMITS } from '@riosoma/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { openDatabase, type DatabaseSession } from '../../../data';
import { FakeServer } from '../../../data/testing';
import { relationalFixture } from '../../../data/testing/relational';
import { renderShell } from '../shell/test-support';
import { JoinedSetup } from './JoinedSetup';

let session: DatabaseSession | undefined;
afterEach(() => {
  cleanup();
  session?.close();
  vi.unstubAllGlobals();
});

it('keeps long joined field names within the table limit and distinguishes matching prefixes', async () => {
  const server = new FakeServer();
  const fixture = relationalFixture(server);
  const schema = server.database(fixture.source.databaseId).schema;
  const prefix = 'x'.repeat(249);
  for (const [id, tail] of [
    [fixture.source.textFieldId, 'a'],
    [fixture.source.numberFieldId, 'b'],
  ])
    schema.fields.find((field) => field.id === id)!.name = prefix + tail;
  session = await openDatabase(fixture.source.databaseId, server.deps());
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ suggestions: [] }))),
  );
  const onCreated = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderShell(
    <QueryClientProvider client={client}>
      <JoinedSetup session={session} tableId={fixture.source.tableId} onCreated={onCreated} />
    </QueryClientProvider>,
  );
  await userEvent.click(screen.getByRole('button', { name: /Next table$/ }));
  await userEvent.click(screen.getByRole('option', { name: 'Projects' }));
  await userEvent.click(screen.getByRole('button', { name: /Key from an earlier table$/ }));
  await userEvent.click(screen.getByRole('option', { name: `Table ${prefix}b` }));
  await userEvent.click(screen.getByRole('button', { name: /Key from the next table$/ }));
  await userEvent.click(screen.getByRole('option', { name: 'Price' }));
  const fields = within(screen.getByRole('group', { name: 'Fields to include' }));
  await userEvent.click(fields.getByText(`Table ${prefix}a`));
  await userEvent.click(fields.getByText(`Table ${prefix}b`));
  await userEvent.click(screen.getByRole('button', { name: 'Create joined table' }));
  const commands = server.requests.flatMap((request) =>
    request.path.endsWith('/commands')
      ? (request.options.body as { commands: Array<{ table: { fields: Array<{ name: string }> } }> }).commands
      : [],
  );
  const names = commands[0]!.table.fields.map((field) => field.name);
  expect(names).toHaveLength(2);
  expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(2);
  expect(names.every((name) => name.length === LIMITS.nameLength)).toBe(true);
  await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
  client.clear();
});
