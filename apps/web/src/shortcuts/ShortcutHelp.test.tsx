import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderSharing } from '../screens/database/share/testing';
import { filterShortcutGroups, shortcutGroups, shortcutKeys } from './registry';
import { ShortcutHelp } from './ShortcutHelp';

afterEach(cleanup);

it('puts the current context first and lists each action once per context', () => {
  const groups = shortcutGroups(['calendar', 'records', 'general']);
  expect(groups.slice(0, 3).map((group) => group.context)).toEqual(['calendar', 'records', 'general']);
  for (const group of groups)
    expect(new Set(group.shortcuts.map((action) => action.id)).size).toBe(group.shortcuts.length);
  expect(shortcutGroups(['settings'])[0]?.context).toBe('settings');
  expect(groups.find((group) => group.context === 'demos')?.shortcuts[0]?.id).toBe('demo.stop');
  expect(
    groups
      .find((group) => group.context === 'reordering')
      ?.shortcuts.filter((action) => action.combo === 'Escape').length,
  ).toBe(1);
});

it('filters translated action names and the keys for each platform', () => {
  const groups = shortcutGroups();
  const translate = (label: { message?: string }) => label.message ?? '';
  expect(
    filterShortcutGroups(groups, 'SAVE settings', translate, false).map((group) => group.context),
  ).toEqual(['settings']);
  expect(
    filterShortcutGroups(groups, 'Ctrl+K', translate, false)[0]?.shortcuts.map((action) => action.id),
  ).toEqual(['palette.open']);
  expect(
    filterShortcutGroups(groups, '⌘K', translate, true)[0]?.shortcuts.map((action) => action.id),
  ).toEqual(['palette.open']);
  expect(filterShortcutGroups(groups, 'no match here', translate, false)).toEqual([]);
  expect(shortcutKeys('views.moveLeft', true)).toBe('⌥←');
  expect(shortcutKeys('views.moveLeft', false)).toBe('Alt+←');
  expect(shortcutKeys('grid.pageUp', false)).toBe('Page Up');
  expect(shortcutKeys('grid.pageDown', true)).toBe('Page Down');
  expect(shortcutKeys('grid.context', false)).toBe('Context Menu / Shift+F10');
});

it('lists working grid history, selection, fill, and search keys from the registry', () => {
  const grid = shortcutGroups(['grid'])[0]!;
  const ids = ['undo', 'redo', 'all', 'fillDown', 'fillRight', 'find', 'replace'];
  for (const id of ids) expect(grid.shortcuts.some((shortcut) => shortcut.id === `grid.${id}`)).toBe(true);
  const translate = (label: { message?: string }) => label.message ?? '';
  expect(filterShortcutGroups([grid], 'Ctrl+Z', translate, false)[0]?.shortcuts[0]?.id).toBe('grid.undo');
  expect(shortcutKeys('grid.replace', true)).toBe('⇧⌘H');
  expect(shortcutKeys('grid.replace', false)).toBe('Ctrl+H');
  expect(filterShortcutGroups([grid], 'Ctrl+H', translate, true)).toEqual([]);
  expect(shortcutKeys('grid.redo', false)).toBe('Ctrl+Shift+Z / Ctrl+Y');
  expect(shortcutKeys('grid.fillDown', true)).toBe('⌘D / ⌃D');
});

it('flows complete groups into balanced columns and uses one column on phones', () => {
  const css = readFileSync(join(import.meta.dirname, 'ShortcutHelp.css'), 'utf8');
  expect(css).toContain('columns: 19rem');
  expect(css).toContain('break-inside: avoid');
  expect(css).toContain('columns: 1');
  expect(css).toContain('text-align: start');
  expect(css).toContain('text-align: end');
});

it('filters the panel without submitting and provides one header close control', async () => {
  const onOpenChange = vi.fn();
  const root = createRootRoute();
  const route = createRoute({
    getParentRoute: () => root,
    path: '/settings',
    component: () => <ShortcutHelp isOpen onOpenChange={onOpenChange} />,
  });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ['/settings'] }),
  });
  renderSharing(<RouterProvider router={router} />);
  const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
  expect(within(dialog).getAllByRole('button', { name: 'Close' })).toHaveLength(1);
  const user = userEvent.setup();
  await user.type(
    within(dialog).getByRole('searchbox', { name: 'Filter shortcuts' }),
    'Save settings{Enter}',
  );
  expect(within(dialog).getAllByRole('term')).toHaveLength(1);
  expect(within(dialog).getByRole('term').textContent).toBe('Save settings changes');
  await user.keyboard('{Escape}');
  expect(onOpenChange).toHaveBeenCalledWith(false);
});
