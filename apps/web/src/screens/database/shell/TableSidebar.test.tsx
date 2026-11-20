import { dragItem } from '../../../test/sortable';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncedFixture } from '../../../data/testing/synced';
import { TableSidebar } from './TableSidebar';
import { renderShell, table } from './test-support';

afterEach(cleanup);
function setup(count = 2, canEdit = true) {
  const tables = [table('Tasks'), table('People')].slice(0, count);
  const props = {
    tables,
    activeTableId: tables[0]!.id,
    hrefFor: (id: string) => `/database/${id}`,
    onNavigate: vi.fn(),
    canEdit,
    onCreate: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onMove: vi.fn(),
  };
  renderShell(<TableSidebar {...props} />);
  return props;
}

describe('TableSidebar', () => {
  it('allows an import without exposing schema actions to a record editor', async () => {
    const item = table('Tasks');
    const onImportInto = vi.fn();
    renderShell(
      <TableSidebar
        tables={[item]}
        activeTableId={item.id}
        hrefFor={(id) => `/database/${id}`}
        onNavigate={vi.fn()}
        canEdit={false}
        onCreate={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onMove={vi.fn()}
        onImportInto={onImportInto}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'More for Tasks' }));
    expect(screen.queryByRole('menuitem', { name: 'Rename' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Delete table' })).toBeNull();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Import into this table' }));
    expect(onImportInto).toHaveBeenCalledWith(item.id);
  });
  it('offers importing a file into a table from its menu, but not into a synced table', async () => {
    const onImportInto = vi.fn();
    const synced = { ...table('Warehouse'), source: syncedFixture().table.source };
    const tables = [table('Tasks'), synced];
    renderShell(
      <TableSidebar
        tables={tables}
        activeTableId={tables[0]!.id}
        hrefFor={(id) => `/database/${id}`}
        onNavigate={vi.fn()}
        canEdit
        onCreate={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onMove={vi.fn()}
        onImportInto={onImportInto}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'More for Tasks' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Import into this table' }));
    expect(onImportInto).toHaveBeenCalledWith(tables[0]!.id);
    await userEvent.click(screen.getByRole('button', { name: 'More for Warehouse' }));
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeDefined();
    expect(screen.queryByRole('menuitem', { name: 'Import into this table' })).toBeNull();
  });

  it('offers a table’s booking pages from its menu, but not a synced table’s', async () => {
    const onBookingPages = vi.fn();
    const synced = { ...table('Warehouse'), source: syncedFixture().table.source };
    const tables = [table('Appointments'), synced];
    renderShell(
      <TableSidebar
        tables={tables}
        activeTableId={tables[0]!.id}
        hrefFor={(id) => `/database/${id}`}
        onNavigate={vi.fn()}
        canEdit
        onCreate={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onMove={vi.fn()}
        onBookingPages={onBookingPages}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'More for Appointments' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Booking pages' }));
    expect(onBookingPages).toHaveBeenCalledWith(tables[0]!.id);
    await userEvent.click(screen.getByRole('button', { name: 'More for Warehouse' }));
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeDefined();
    expect(screen.queryByRole('menuitem', { name: 'Booking pages' })).toBeNull();
  });

  it('keeps native links, current state, and modifier navigation', () => {
    const props = setup();
    const link = screen.getByRole('link', { name: 'Tasks' });
    expect(link.getAttribute('href')).toBe(`/database/${props.tables[0]!.id}`);
    expect(link.getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'People' }).hasAttribute('aria-current')).toBe(false);
    for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey'])
      expect(fireEvent.click(link, { [modifier]: true })).toBe(true);
    expect(props.onNavigate).not.toHaveBeenCalled();
    expect(fireEvent.click(link)).toBe(false);
    expect(props.onNavigate).toHaveBeenCalledWith(props.tables[0]!.id);
  });

  it('reaches menus by keyboard, saves Enter, cancels Escape, and rejects empty names', async () => {
    const props = setup();
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add a table' }));
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Tasks' }));
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'More for Tasks' }));
    await userEvent.keyboard('{Enter}');
    screen.getByRole('menuitem', { name: 'Rename' }).focus();
    await userEvent.keyboard('{Enter}');
    const input = await screen.findByRole('textbox', { name: 'Rename' });
    await waitFor(() => expect(document.activeElement).toBe(input));
    await userEvent.clear(input);
    await userEvent.type(input, ' Work{Enter}');
    expect(props.onRename).toHaveBeenCalledWith(props.tables[0]!.id, 'Work');
    await userEvent.click(screen.getByRole('button', { name: 'More for Tasks' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    await userEvent.clear(screen.getByRole('textbox'));
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('textbox')).toBeDefined();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(props.onRename).toHaveBeenCalledTimes(1);
  });

  it('lets Tab leave an unfinished rename without saving or moving focus backward', async () => {
    const props = setup();
    await userEvent.click(screen.getByRole('button', { name: 'More for Tasks' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    await userEvent.clear(screen.getByRole('textbox'));
    await userEvent.keyboard('Unfinished{Tab}');
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'More for Tasks' }));
    expect(props.onRename).not.toHaveBeenCalled();
  });

  it('asks before deleting and supports cancellation', async () => {
    const props = setup();
    await userEvent.click(screen.getByRole('button', { name: 'More for Tasks' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete table' }));
    expect(screen.getByRole('dialog', { name: 'Delete Tasks?' })).toBeDefined();
    expect(props.onDelete).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(props.onDelete).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'More for Tasks' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete table' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete table' }));
    expect(props.onDelete).toHaveBeenCalledWith(props.tables[0]!.id);
  });

  it('disables deletion of the last table', async () => {
    const props = setup(1);
    await userEvent.click(screen.getByRole('button', { name: 'More for Tasks' }));
    const item = screen.getByRole('menuitem', { name: 'Delete table' });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(item);
    expect(screen.queryByRole('dialog', { name: 'Delete Tasks?' })).toBeNull();
    expect(props.onDelete).not.toHaveBeenCalled();
  });

  it('moves with Alt+arrows within bounds, and by dragging', async () => {
    const props = setup();
    screen.getByRole('link', { name: 'Tasks' }).focus();
    await userEvent.keyboard('{Alt>}{ArrowUp}{ArrowDown}{/Alt}');
    expect(props.onMove).toHaveBeenCalledExactlyOnceWith(props.tables[0]!.id, 1);
    screen.getByRole('link', { name: 'People' }).focus();
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(props.onMove).toHaveBeenLastCalledWith(props.tables[1]!.id, 0);
    const rows = screen.getAllByRole('listitem');
    await dragItem(screen.getByRole('button', { name: 'Move Tasks' }), rows[1]!);
    expect(props.onMove).toHaveBeenLastCalledWith(props.tables[0]!.id, 1);
    // With a blank table the only kind on offer, the button makes one without a menu.
    await userEvent.click(screen.getByRole('button', { name: 'Add a table' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(props.onCreate).toHaveBeenCalledOnce();
  });

  it('hides editing controls and disables reorder for readers', async () => {
    const props = setup(2, false);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    screen.getByRole('link', { name: 'Tasks' }).focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(props.onMove).not.toHaveBeenCalled();
    expect(screen.getAllByRole('listitem').every((item) => item.getAttribute('draggable') !== 'true')).toBe(
      true,
    );
  });
});
