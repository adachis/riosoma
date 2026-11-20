import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { faCopy, faPen, faTrashCan } from '@fortawesome/free-solid-svg-icons';
import { describe, expect, it } from 'vitest';
import { Button } from './Button';
import { Separator } from './Separator';
import { Toolbar } from './Toolbar';

function RowToolbar() {
  return (
    <Toolbar aria-label="Row actions">
      <Button variant="quiet" icon={faPen}>
        Edit
      </Button>
      <Separator orientation="vertical" />
      <Button variant="quiet" icon={faCopy}>
        Duplicate
      </Button>
      <Button variant="danger" icon={faTrashCan}>
        Delete
      </Button>
    </Toolbar>
  );
}

describe('Toolbar', () => {
  it('groups its controls under one toolbar', () => {
    render(<RowToolbar />);
    const toolbar = screen.getByRole('toolbar', { name: 'Row actions' });
    expect(toolbar.getAttribute('aria-orientation')).toBe('horizontal');
    expect(toolbar.getAttribute('data-density')).toBe('comfortable');
    expect(screen.getAllByRole('button')).toHaveLength(3);
    // The divider between the groups is announced, but is not a stop for the arrow keys.
    expect(screen.getAllByRole('separator')).toHaveLength(1);
  });

  it('moves between controls with the arrow keys', async () => {
    render(<RowToolbar />);
    const edit = screen.getByRole('button', { name: 'Edit' });
    const duplicate = screen.getByRole('button', { name: 'Duplicate' });
    const remove = screen.getByRole('button', { name: 'Delete' });
    edit.focus();
    await userEvent.keyboard('{ArrowRight}');
    // The separator takes no focus, so the next stop is the next control.
    expect(document.activeElement).toBe(duplicate);
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(remove);
    await userEvent.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(duplicate);
  });

  it('stays on the last control instead of wrapping out of the group', async () => {
    render(<RowToolbar />);
    const remove = screen.getByRole('button', { name: 'Delete' });
    remove.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(remove);
  });

  it('skips a control that is unavailable', async () => {
    render(
      <Toolbar aria-label="Row actions">
        <Button>Edit</Button>
        <Button isDisabled>Duplicate</Button>
        <Button>Delete</Button>
      </Toolbar>,
    );
    screen.getByRole('button', { name: 'Edit' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete' }));
  });

  it('uses the up and down arrows when it is a column', async () => {
    render(
      <Toolbar aria-label="View" orientation="vertical" density="compact">
        <Button variant="quiet">Group</Button>
        <Separator />
        <Button variant="quiet">Sort</Button>
      </Toolbar>,
    );
    const toolbar = screen.getByRole('toolbar', { name: 'View' });
    expect(toolbar.getAttribute('aria-orientation')).toBe('vertical');
    expect(toolbar.getAttribute('data-density')).toBe('compact');
    const group = screen.getByRole('button', { name: 'Group' });
    const sort = screen.getByRole('button', { name: 'Sort' });
    group.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(sort);
    await userEvent.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(group);
  });

  it('keeps the styles a caller adds', () => {
    render(<Toolbar aria-label="Row actions" className="table-header" />);
    expect(screen.getByRole('toolbar', { name: 'Row actions' }).className.split(' ')).toEqual([
      'rio-toolbar',
      'table-header',
    ]);
  });
});
