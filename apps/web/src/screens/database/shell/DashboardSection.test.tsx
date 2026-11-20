import { dragItem } from '../../../test/sortable';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newId, type DashboardMeta } from '@riosoma/contracts';
import { TableSidebar } from './TableSidebar';
import { renderShell, table } from './test-support';

afterEach(cleanup);

function dashboard(name: string, position: number): DashboardMeta {
  return {
    id: newId('dashboard'),
    databaseId: newId('database'),
    name,
    position,
    config: { tiles: [] },
    createdAt: '',
    updatedAt: '',
  };
}

function setup(names: string[] = ['Sales', 'Support'], canEdit = true) {
  const dashboards = names.map((name, index) => dashboard(name, index));
  const section = {
    dashboards,
    activeDashboardId: dashboards[0]?.id ?? null,
    hrefFor: (id: string) => `/database/dashboards/${id}`,
    onNavigate: vi.fn(),
    onCreate: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onMove: vi.fn(),
  };
  const tables = [table('Tasks')];
  renderShell(
    <TableSidebar
      tables={tables}
      activeTableId={null}
      hrefFor={(id) => `/database/${id}`}
      onNavigate={vi.fn()}
      canEdit={canEdit}
      onCreate={vi.fn()}
      onRename={vi.fn()}
      onDelete={vi.fn()}
      onMove={vi.fn()}
      dashboards={section}
    />,
  );
  return { ...section, tables };
}

const region = () => screen.getByRole('region', { name: 'Dashboards' });

describe('the dashboards section of the sidebar', () => {
  it('lists dashboards as links below the tables, with the open one current', () => {
    const section = setup();
    expect(screen.getByRole('heading', { level: 2, name: 'Dashboards' })).toBeDefined();
    const links = within(region()).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['Sales', 'Support']);
    expect(links[0]!.getAttribute('href')).toBe(`/database/dashboards/${section.dashboards[0]!.id}`);
    expect(links[0]!.getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Tasks' }).hasAttribute('aria-current')).toBe(false);
    expect(fireEvent.click(links[1]!)).toBe(false);
    expect(section.onNavigate).toHaveBeenCalledWith(section.dashboards[1]!.id);
    expect(fireEvent.click(links[1]!, { metaKey: true })).toBe(true);
    expect(section.onNavigate).toHaveBeenCalledOnce();
  });

  it('adds a dashboard and renames one from its menu by keyboard', async () => {
    const section = setup();
    await userEvent.click(within(region()).getByRole('button', { name: 'Add a dashboard' }));
    expect(section.onCreate).toHaveBeenCalledOnce();
    within(region()).getByRole('link', { name: 'Sales' }).focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'More for Sales' }));
    await userEvent.keyboard('{Enter}');
    screen.getByRole('menuitem', { name: 'Rename' }).focus();
    await userEvent.keyboard('{Enter}');
    const input = await screen.findByRole('textbox', { name: 'Rename' });
    await waitFor(() => expect(document.activeElement).toBe(input));
    await userEvent.clear(input);
    await userEvent.type(input, 'Revenue{Enter}');
    expect(section.onRename).toHaveBeenCalledWith(section.dashboards[0]!.id, 'Revenue');
  });

  it('asks before deleting, and allows deleting the last dashboard', async () => {
    const section = setup(['Sales']);
    await userEvent.click(screen.getByRole('button', { name: 'More for Sales' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete dashboard' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete Sales?' });
    expect(dialog.textContent).toContain(
      'It’s deleted for everyone.  You can restore it from the trash for 30 days.',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(section.onDelete).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'More for Sales' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete dashboard' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete dashboard' }));
    expect(section.onDelete).toHaveBeenCalledWith(section.dashboards[0]!.id);
  });

  it('reorders with Alt and the arrow keys and by dragging', async () => {
    const section = setup(['Sales', 'Support', 'Hiring']);
    within(region()).getByRole('link', { name: 'Sales' }).focus();
    await userEvent.keyboard('{Alt>}{ArrowUp}{ArrowDown}{/Alt}');
    expect(section.onMove).toHaveBeenCalledExactlyOnceWith(section.dashboards[0]!.id, 1);
    const items = within(region()).getAllByRole('listitem');
    await dragItem(within(items[2]!).getByRole('button', { name: 'Move Hiring' }), items[0]!, 0.05);
    expect(section.onMove).toHaveBeenLastCalledWith(section.dashboards[2]!.id, 0);
  });

  it('shows people who can’t change the schema the list without controls', async () => {
    const section = setup(['Sales'], false);
    expect(within(region()).queryAllByRole('button')).toHaveLength(0);
    const link = within(region()).getByRole('link', { name: 'Sales' });
    link.focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(section.onMove).not.toHaveBeenCalled();
    expect(within(region()).getByRole('listitem').getAttribute('draggable')).toBeNull();
  });

  it('offers only “Add a dashboard” when there are none, and nothing to readers', () => {
    setup([]);
    expect(within(region()).queryByRole('list')).toBeNull();
    expect(within(region()).getByRole('button', { name: 'Add a dashboard' })).toBeDefined();
    cleanup();
    setup([], false);
    expect(screen.queryByRole('region', { name: 'Dashboards' })).toBeNull();
  });
});
