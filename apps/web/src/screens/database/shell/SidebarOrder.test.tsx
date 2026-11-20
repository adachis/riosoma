import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { SortableItem } from '@riosoma/ui';
import type { SidebarSection } from '@riosoma/contracts';
import type { DatabaseSession, SchemaState } from '../../../data/types';
import { dragItem } from '../../../test/sortable';
import { renderShell } from './test-support';
import { SidebarNavigationProvider, SidebarOrder } from './SidebarOrder';

afterEach(cleanup);

it.each<SidebarSection>(['table', 'dashboard', 'automation', 'interface', 'script'])(
  'moves a %s into a folder in one command group and keeps the list still before drop',
  async (section) => {
    const run = vi.fn();
    const navigation = {
      folders: [{ id: 'folder', name: 'Planning', parentId: null, section, position: 1 }],
      parents: {},
    };
    const session = { run } as unknown as DatabaseSession;
    const schema = { database: { navigation } } as unknown as SchemaState;
    renderShell(
      <SidebarNavigationProvider session={session} schema={schema}>
        <SidebarOrder
          section={section}
          items={[{ id: 'item', name: 'Projects', position: 0 }]}
          onMove={vi.fn()}
        >
          <ul>
            <SortableItem id="item" as="li">
              {(handle) => (
                <>
                  {handle}
                  <span>Projects</span>
                </>
              )}
            </SortableItem>
          </ul>
        </SidebarOrder>
      </SidebarNavigationProvider>,
    );
    await dragItem(
      screen.getByRole('button', { name: 'Move Projects' }),
      screen.getByRole('button', { name: 'Move Planning' }),
      0.5,
      () => {
        expect(run).not.toHaveBeenCalled();
        expect(
          screen.getByRole('button', { name: 'Move Projects' }).closest('.rio-sidebar-folder'),
        ).toBeNull();
      },
    );
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]![0]).toEqual([
      expect.objectContaining({ kind: `${section}.move` }),
      { kind: 'database.navigation', change: { kind: 'item.move', id: 'item', parentId: 'folder' } },
    ]);
  },
);

it('deletes a sidebar folder through one command', async () => {
  const run = vi.fn();
  const navigation = {
    folders: [{ id: 'folder', name: 'Planning', parentId: null, section: 'table', position: 0 }],
    parents: {},
  };
  renderShell(
    <SidebarNavigationProvider
      session={{ run } as unknown as DatabaseSession}
      schema={{ database: { navigation } } as unknown as SchemaState}
    >
      <SidebarOrder section="table" items={[]} onMove={vi.fn()}>
        <ul />
      </SidebarOrder>
    </SidebarNavigationProvider>,
  );
  await userEvent.click(screen.getByRole('button', { name: 'More for Planning' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete folder' }));
  expect(run).toHaveBeenCalledExactlyOnceWith([
    { kind: 'database.navigation', change: { kind: 'folder.delete', id: 'folder' } },
  ]);
});

function folderWithContents() {
  const run = vi.fn();
  renderShell(
    <SidebarNavigationProvider
      session={{ run } as unknown as DatabaseSession}
      schema={
        {
          database: {
            navigation: {
              folders: [{ id: 'folder', name: 'Planning', parentId: null, section: 'table', position: 0 }],
              parents: { item: 'folder' },
            },
          },
        } as unknown as SchemaState
      }
    >
      <SidebarOrder section="table" items={[{ id: 'item', name: 'Projects', position: 0 }]} onMove={vi.fn()}>
        <ul>
          <SortableItem id="item" as="li">
            <span>Projects</span>
          </SortableItem>
        </ul>
      </SidebarOrder>
    </SidebarNavigationProvider>,
  );
  return run;
}

it('saves an inline rename with Enter and cancels a double-click rename with Escape', async () => {
  const run = folderWithContents();
  const row = screen.getByRole('group', { name: 'Planning' });
  expect(within(row).queryByRole('textbox')).toBeNull();
  row.focus();
  await userEvent.keyboard('{F2}');
  const input = await screen.findByRole('textbox', { name: 'Folder name' });
  await userEvent.clear(input);
  await userEvent.type(input, 'Reference{Enter}');
  expect(run).toHaveBeenCalledExactlyOnceWith([
    { kind: 'database.navigation', change: { kind: 'folder.rename', id: 'folder', name: 'Reference' } },
  ]);
  await userEvent.dblClick(within(row).getByText('Planning'));
  await userEvent.type(await screen.findByRole('textbox', { name: 'Folder name' }), ' canceled{Escape}');
  expect(within(row).queryByRole('textbox')).toBeNull();
  expect(run).toHaveBeenCalledOnce();
});

it('opens folder actions from the context menu and creates a child through the command bus', async () => {
  const run = folderWithContents();
  fireEvent.contextMenu(screen.getByRole('group', { name: 'Planning' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'New folder inside' }));
  expect(run).toHaveBeenCalledExactlyOnceWith([
    {
      kind: 'database.navigation',
      change: {
        kind: 'folder.create',
        folder: expect.objectContaining({
          name: 'Folder 2',
          parentId: 'folder',
          section: 'table',
        }),
      },
    },
  ]);
});

it('retains a failed sidebar rename draft and retries it through the command bus', async () => {
  const run = folderWithContents();
  run.mockImplementationOnce(() => {
    throw new Error('Rename failed');
  });
  const row = screen.getByRole('group', { name: 'Planning' });
  row.focus();
  await userEvent.keyboard('{F2}');
  const input = await screen.findByRole('textbox', { name: 'Folder name' });
  await userEvent.clear(input);
  await userEvent.type(input, 'Reference{Enter}');
  expect(await screen.findByRole('textbox', { name: 'Folder name' })).toBe(input);
  expect((input as HTMLInputElement).value).toBe('Reference');
  await userEvent.tab();
  expect(screen.getByRole('textbox', { name: 'Folder name' })).toBe(input);
  await userEvent.click(input);
  await userEvent.keyboard('{Enter}');
  expect(run).toHaveBeenCalledTimes(2);
  expect(run).toHaveBeenLastCalledWith([
    { kind: 'database.navigation', change: { kind: 'folder.rename', id: 'folder', name: 'Reference' } },
  ]);
  expect(screen.queryByRole('textbox', { name: 'Folder name' })).toBeNull();
});

it('keeps the sidebar rename draft until the server accepts the command', async () => {
  const run = folderWithContents();
  let reply!: (result: { applied: number; rejected: number }) => void;
  run.mockReturnValueOnce({
    done: new Promise((resolve) => {
      reply = resolve;
    }),
  });
  screen.getByRole('group', { name: 'Planning' }).focus();
  await userEvent.keyboard('{F2}');
  const input = await screen.findByRole('textbox', { name: 'Folder name' });
  await userEvent.clear(input);
  await userEvent.type(input, 'Reference{Enter}');
  await waitFor(() => expect((input as HTMLInputElement).readOnly).toBe(true));
  expect(screen.getByRole('textbox', { name: 'Folder name' })).toBe(input);
  await act(async () => {
    reply({ applied: 0, rejected: 1 });
  });
  await waitFor(() => expect((input as HTMLInputElement).readOnly).toBe(false));
  expect(screen.getByRole('textbox', { name: 'Folder name' })).toBe(input);
  expect((input as HTMLInputElement).value).toBe('Reference');
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Folder name' })).toBeNull());
  expect(run).toHaveBeenCalledTimes(2);
});

it('explains reparenting before deleting a populated folder and applies one undoable command', async () => {
  const run = folderWithContents();
  await userEvent.click(screen.getByRole('button', { name: 'More for Planning' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete folder' }));
  const dialog = screen.getByRole('dialog', { name: 'Delete folder?' });
  expect(dialog.textContent).toContain('Nothing inside is deleted.');
  expect(run).not.toHaveBeenCalled();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(run).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'More for Planning' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete folder' }));
  await userEvent.click(
    within(screen.getByRole('dialog', { name: 'Delete folder?' })).getByRole('button', {
      name: 'Delete folder',
    }),
  );
  expect(run).toHaveBeenCalledExactlyOnceWith([
    { kind: 'database.navigation', change: { kind: 'folder.delete', id: 'folder' } },
  ]);
});
