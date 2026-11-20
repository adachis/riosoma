import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseList } from './DatabaseList';
import { databaseSummary, renderHome } from './test-support';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function props() {
  return {
    databases: [databaseSummary(), databaseSummary({ name: 'Inventory' })],
    hrefFor: (id: string) => `/${id}`,
    onOpen: vi.fn(),
    onCreate: vi.fn(),
    loading: false,
  };
}
it('renders cards and the primary create action, reachable by keyboard', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-27T12:00:00Z'));
  const input = props();
  renderHome(<DatabaseList {...input} />);
  expect(screen.getByRole('heading', { name: 'Databases' })).toBeDefined();
  const links = screen.getAllByRole('link');
  expect(links.map((link) => link.getAttribute('href'))).toEqual(
    input.databases.map((database) => `/${database.id}`),
  );
  expect(links[0]!.textContent).toContain('Updated 3 hours ago');
  await userEvent.tab();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New database' }));
  expect(document.activeElement?.getAttribute('data-variant')).toBe('primary');
  await userEvent.keyboard('{Enter}');
  expect(input.onCreate).toHaveBeenCalledOnce();
  await userEvent.tab();
  await userEvent.keyboard('{Enter}');
  expect(input.onOpen).toHaveBeenCalledWith(input.databases[0]!.id);
});
it('renders placeholder cards while loading', () => {
  const { container } = renderHome(<DatabaseList {...props()} loading />);
  expect(screen.getByRole('progressbar', { name: 'Loading databases' })).toBeDefined();
  expect(container.querySelectorAll('.rio-database-card--placeholder')).toHaveLength(6);
  expect(screen.queryAllByRole('link')).toHaveLength(0);
  expect(screen.queryByText('No databases yet')).toBeNull();
});
it('offers just an empty title and one create action without cards', async () => {
  const input = props();
  renderHome(<DatabaseList {...input} databases={[]} />);
  expect(screen.getByRole('heading', { name: 'No databases yet' })).toBeDefined();
  expect(screen.queryAllByRole('link')).toHaveLength(0);
  expect(screen.getAllByRole('button')).toHaveLength(1);
  await userEvent.click(screen.getByRole('button', { name: 'New database' }));
  expect(input.onCreate).toHaveBeenCalledOnce();
});
it('shows a supplied error without a misleading empty state', () => {
  renderHome(<DatabaseList {...props()} databases={[]} error="Unavailable" />);
  expect(screen.getByRole('alert').textContent).toContain('Unavailable');
  expect(screen.queryByText('No databases yet')).toBeNull();
});

it('keeps creation controls mounted while the initial layout disables them', async () => {
  const input = { ...props(), onImport: vi.fn(), onImportAirtable: vi.fn(), onImportPlatform: vi.fn() };
  const view = renderHome(<DatabaseList {...input} actionsDisabled />);
  const labels = [
    'New database',
    'New database from a CSV or Excel file',
    'Import from Airtable',
    'Import from another tool',
  ];
  const buttons = labels.map((name) => screen.getByRole('button', { name }) as HTMLButtonElement);
  for (const button of buttons) {
    expect(button.disabled).toBe(true);
    await userEvent.click(button);
  }
  expect(input.onCreate).not.toHaveBeenCalled();
  expect(input.onImport).not.toHaveBeenCalled();
  expect(input.onImportAirtable).not.toHaveBeenCalled();
  expect(screen.queryByRole('menu')).toBeNull();
  view.rerender(<DatabaseList {...input} actionsDisabled={false} />);
  for (const [index, name] of labels.entries()) {
    expect(screen.getByRole('button', { name })).toBe(buttons[index]);
    expect(buttons[index]!.disabled).toBe(false);
  }
  await userEvent.click(buttons[0]!);
  expect(input.onCreate).toHaveBeenCalledOnce();
});
