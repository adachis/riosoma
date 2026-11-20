import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { faPencil, faTrashCan } from '@fortawesome/free-solid-svg-icons';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button';
import { Menu, MenuItem, MenuSection, MenuSeparator, MenuTrigger, SubmenuTrigger } from './Menu';

/**
 * React Aria leaves focus on the panel in this DOM, while a browser moves it into the menu.  Tests
 * make that move themselves so the arrow keys reach the items.
 */
function focusMenu(name?: string | RegExp) {
  const menu = name == null ? screen.getByRole('menu') : screen.getByRole('menu', { name });
  menu.focus();
  return menu;
}

describe('Menu', () => {
  it('opens from its trigger and exposes the actions as menu items', async () => {
    const user = userEvent.setup();
    render(
      <MenuTrigger>
        <Button variant="quiet">Actions</Button>
        <Menu aria-label="Actions">
          <MenuItem id="rename" icon={faPencil} shortcut="⌘R">
            Rename
          </MenuItem>
          <MenuSeparator />
          <MenuItem id="delete" icon={faTrashCan} tone="danger">
            Delete
          </MenuItem>
        </Menu>
      </MenuTrigger>,
    );

    const trigger = screen.getByRole('button', { name: 'Actions' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('menu')).toBeNull();

    await user.click(trigger);

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('menu', { name: 'Actions' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Rename ⌘R' })).toBeTruthy();
    expect(screen.getByRole('separator')).toBeTruthy();
    // The visible shortcut is included in the item's name.
    expect(screen.getByRole('menuitem', { name: 'Rename ⌘R' }).textContent).toContain('⌘R');
    // Icons next to a visible label stay decorative.
    expect(
      screen.getByRole('menuitem', { name: 'Rename ⌘R' }).querySelector('svg')?.getAttribute('aria-hidden'),
    ).toBe('true');
  });

  it('closes again with Escape and gives focus back to the trigger', async () => {
    const user = userEvent.setup();
    render(
      <MenuTrigger>
        <Button>Actions</Button>
        <Menu aria-label="Actions">
          <MenuItem id="rename">Rename</MenuItem>
        </Menu>
      </MenuTrigger>,
    );

    const trigger = screen.getByRole('button', { name: 'Actions' });
    await user.click(trigger);
    focusMenu('Actions');
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('runs an action from the keyboard and closes', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(
      <MenuTrigger>
        <Button>Actions</Button>
        <Menu aria-label="Actions">
          <MenuItem id="rename" onAction={onAction}>
            Rename
          </MenuItem>
          <MenuItem id="delete">Delete</MenuItem>
        </Menu>
      </MenuTrigger>,
    );

    const trigger = screen.getByRole('button', { name: 'Actions' });
    trigger.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('menu', { name: 'Actions' })).toBeTruthy();

    focusMenu('Actions');
    // Opening with the keyboard puts focus on the first item, so one step down reaches Delete.
    await user.keyboard('{ArrowDown}');
    const items = screen.getAllByRole('menuitem');
    expect(items[1]?.getAttribute('data-focused')).toBe('true');
    expect(items[0]?.getAttribute('data-focused')).toBeNull();

    await user.keyboard('{ArrowUp}');
    await user.keyboard('{Enter}');
    expect(onAction).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('groups items under a section header and skips disabled ones', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(
      <MenuTrigger>
        <Button>Organize</Button>
        <Menu aria-label="Organize">
          <MenuSection title="Sort">
            <MenuItem id="name">Name</MenuItem>
            <MenuItem id="locked" isDisabled onAction={onAction}>
              Locked
            </MenuItem>
          </MenuSection>
        </Menu>
      </MenuTrigger>,
    );

    await user.click(screen.getByRole('button', { name: 'Organize' }));
    const group = screen.getByRole('group', { name: 'Sort' });
    expect(within(group).getAllByRole('menuitem')).toHaveLength(2);

    const locked = screen.getByRole('menuitem', { name: 'Locked' });
    expect(locked.getAttribute('data-disabled')).toBe('true');
    await user.click(locked);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('opens a submenu from its item and closes only the submenu on Escape', async () => {
    const user = userEvent.setup();
    render(
      <MenuTrigger>
        <Button>Actions</Button>
        <Menu aria-label="Actions">
          <SubmenuTrigger label="Sort">
            <MenuItem id="name">Name</MenuItem>
            <MenuItem id="date">Date</MenuItem>
          </SubmenuTrigger>
        </Menu>
      </MenuTrigger>,
    );

    await user.click(screen.getByRole('button', { name: 'Actions' }));
    const item = screen.getByRole('menuitem', { name: 'Sort' });
    expect(item.getAttribute('aria-haspopup')).toBe('menu');
    expect(item.getAttribute('data-has-submenu')).toBe('true');
    // The chevron that points at the submenu is decorative.
    expect(item.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');

    focusMenu('Actions');
    await user.keyboard('{ArrowRight}');

    const submenu = screen.getByRole('menu', { name: 'Sort' });
    expect(item.getAttribute('aria-expanded')).toBe('true');
    expect(
      within(submenu)
        .getAllByRole('menuitem')
        .map((node) => node.textContent),
    ).toEqual(['Name', 'Date']);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu', { name: 'Sort' })).toBeNull();
    expect(screen.getByRole('menu', { name: 'Actions' })).toBeTruthy();
    // Focus returns to the item that opened the submenu.
    expect(screen.getByRole('menuitem', { name: 'Sort' }).getAttribute('data-focused')).toBe('true');
  });

  it('marks a destructive item with its tone', async () => {
    const user = userEvent.setup();
    render(
      <MenuTrigger>
        <Button>Actions</Button>
        <Menu aria-label="Actions">
          <MenuItem id="rename">Rename</MenuItem>
          <MenuItem id="delete" tone="danger" description="Cannot be undone">
            Delete
          </MenuItem>
        </Menu>
      </MenuTrigger>,
    );

    await user.click(screen.getByRole('button', { name: 'Actions' }));
    const danger = screen.getByRole('menuitem', { name: 'Delete Cannot be undone' });
    expect(danger.getAttribute('data-tone')).toBe('danger');
    expect(danger.textContent).toContain('Cannot be undone');
    expect(screen.getByRole('menuitem', { name: 'Rename' }).getAttribute('data-tone')).toBe('default');
  });
});

it('includes every visible part of an action in its accessible name', async () => {
  render(
    <MenuTrigger>
      <Button>Actions</Button>
      <Menu aria-label="Actions">
        <MenuItem id="rename" description="Change the title" shortcut="⌘R">
          Rename
        </MenuItem>
      </Menu>
    </MenuTrigger>,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Actions' }));
  const item = screen.getByRole('menuitem', { name: 'Rename Change the title ⌘R' });
  expect(item.textContent).toContain('Change the title');
});
