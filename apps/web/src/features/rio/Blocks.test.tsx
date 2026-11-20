import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { newId, type RioBlock } from '@riosoma/contracts';
import { FakeServer } from '../../data/testing';
import { json, renderSharing } from '../../screens/database/share/testing';
import { Block } from './Blocks';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const longValue = 'A long record value that stays readable and available to everyone '.repeat(12).trim();

it('announces background-copy progress, allows cancellation, and waits to offer Undo', async () => {
  const jobId = newId('job');
  let state = 'running';
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith('/cancel')) state = 'canceled';
    return json({ id: jobId, state, copied: 500, total: 1200, result: null });
  });
  vi.stubGlobal('fetch', fetch);
  renderSharing(
    <Block
      block={{
        kind: 'receipt',
        planId: 'copy-plan',
        databaseId: newId('database'),
        groupId: newId('action'),
        summary: 'Table copied',
        jobId,
      }}
      session={null}
      disabled={false}
      onAnswer={vi.fn()}
      onReplace={vi.fn()}
      onReceipt={vi.fn()}
      onError={vi.fn()}
    />,
  );
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Copied 500 of 1200 records'));
  expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Cancel copy' }));
  expect((await screen.findByRole('alert')).textContent).toContain('canceled');
  expect(fetch).toHaveBeenCalledWith(
    `/api/duplicate-jobs/${jobId}/cancel`,
    expect.objectContaining({ method: 'POST' }),
  );
  expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
});

it('links to each table, view, and dashboard a plan created', () => {
  const databaseId = newId('database');
  const tableId = newId('table');
  const viewId = newId('view');
  const dashboardId = newId('dashboard');
  renderSharing(
    <Block
      block={{
        kind: 'receipt',
        planId: 'built-plan',
        databaseId,
        groupId: newId('action'),
        summary: 'Built the view and dashboard',
        created: [
          { kind: 'table', id: tableId, name: 'Sales' },
          { kind: 'view', id: viewId, tableId, name: 'Revenue by format' },
          { kind: 'dashboard', id: dashboardId, name: 'Overview' },
        ],
      }}
      session={null}
      disabled={false}
      onAnswer={vi.fn()}
      onReplace={vi.fn()}
      onReceipt={vi.fn()}
      onError={vi.fn()}
    />,
  );
  expect(screen.getByRole('link', { name: 'Open table' }).getAttribute('href')).toBe(
    `/${databaseId}/${tableId}`,
  );
  expect(screen.getByRole('link', { name: 'Open view' }).getAttribute('href')).toBe(
    `/${databaseId}/${tableId}/${viewId}`,
  );
  expect(screen.getByRole('link', { name: 'Open dashboard' }).getAttribute('href')).toBe(
    `/${databaseId}/dashboards/${dashboardId}`,
  );
  expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
});

it('offers Undo and refreshes the database when a background copy finishes', async () => {
  const jobId = newId('job');
  const onReceipt = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json({ id: jobId, state: 'finished', copied: 1200, total: 1200, result: null })),
  );
  renderSharing(
    <Block
      block={{
        kind: 'receipt',
        planId: 'finished-copy',
        databaseId: newId('database'),
        groupId: newId('action'),
        summary: 'Table copied',
        jobId,
      }}
      session={null}
      disabled={false}
      onAnswer={vi.fn()}
      onReplace={vi.fn()}
      onReceipt={onReceipt}
      onError={vi.fn()}
    />,
  );
  expect(((await screen.findByRole('button', { name: 'Undo' })) as HTMLButtonElement).disabled).toBe(false);
  expect(onReceipt).toHaveBeenCalledTimes(1);
});

function renderRecords(width: number, extraCount: number) {
  const server = new FakeServer();
  const f = server.createDatabase(1);
  const original = server.database(f.databaseId).schema;
  const primary = original.fields.find((field) => field.id === f.textFieldId)!;
  const extras = Array.from({ length: extraCount }, (_, index) => ({
    ...primary,
    id: newId('field'),
    name: `Detail ${index + 1}`,
    position: index + 1,
  }));
  const schema = {
    ...original,
    database: { ...original.database, name: 'Workspace' },
    tables: original.tables.map((table) => ({ ...table, name: 'Items' })),
    fields: [primary, ...extras],
  };
  const row = {
    id: f.recordId(0),
    values: Object.fromEntries([primary, ...extras].map((field) => [field.id, longValue])),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/databases') return json([schema.database]);
      if (url.endsWith('/schema')) return json(schema);
      return json(row);
    }),
  );
  const block: RioBlock = {
    kind: 'records',
    tableId: f.tableId,
    recordIds: [row.id],
    fieldIds: [primary.id, ...extras.map((field) => field.id), primary.id],
    total: 120,
  };
  return renderSharing(
    <div style={{ width }}>
      <Block
        block={block}
        session={null}
        disabled={false}
        onAnswer={vi.fn()}
        onReplace={vi.fn()}
        onReceipt={vi.fn()}
        onError={vi.fn()}
      />
    </div>,
  );
}

it('provides compact cards with a title, three labeled values, and accessible full values at 360 pixels', async () => {
  const app = renderRecords(360, 5);
  const cards = await screen.findByRole('list');
  expect(within(cards).getByRole('heading', { name: longValue })).toBeDefined();
  expect(cards.querySelectorAll('dt')).toHaveLength(3);
  expect(within(cards).getByRole('link', { name: `Open record: ${longValue}` })).toBeDefined();
  for (const value of cards.querySelectorAll('.rio-assistant__value')) {
    expect(value.getAttribute('aria-label')).toBe(value.textContent);
    expect(value.getAttribute('title')).toBe(value.textContent);
  }
  expect(screen.getByText('1 of 120 records in Items · Workspace', { selector: 'p' })).toBeDefined();
  expect(within(cards).queryByText('Detail 4')).toBeNull();
  app.client.clear();
});

it('provides a three-column table in a labeled, keyboard-focusable scroll region for a wide panel', async () => {
  const app = renderRecords(800, 2);
  const table = await screen.findByRole('table');
  expect(within(table).getAllByRole('columnheader')).toHaveLength(3);
  expect(table.closest('[data-columns]')?.getAttribute('data-columns')).toBe('3');
  const region = table.parentElement!;
  expect(region.getAttribute('tabindex')).toBe('0');
  expect(region.getAttribute('aria-label')).toBe('1 of 120 records in Items · Workspace');
  expect(within(table).getByRole('link', { name: `Open record: ${longValue}` })).toBeDefined();
  expect(table.querySelector('tbody th span')?.getAttribute('title')).toBe(longValue);
  app.client.clear();
});
