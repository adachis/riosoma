import { faFolder } from '@fortawesome/free-solid-svg-icons';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseHeader } from './DatabaseHeader';
import { SaveIndicator } from './SaveIndicator';
import { PresenceBar } from './PresenceBar';
import { renderShell } from './test-support';

afterEach(cleanup);
const database = { name: 'Projects', icon: 'folder', color: 'blue' as const };
it('renames through the keyboard and supports canceling and empty-name rejection', async () => {
  const onRename = vi.fn();
  renderShell(<DatabaseHeader database={database} canManage onRename={onRename} />);
  await userEvent.tab();
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: database.name, description: 'Rename' }),
  );
  await userEvent.keyboard('{Enter}');
  const input = screen.getByRole('textbox', { name: 'Database name' });
  await userEvent.clear(input);
  await userEvent.keyboard('{Enter}');
  expect(onRename).not.toHaveBeenCalled();
  await userEvent.type(input, ' Plans{Enter}');
  expect(onRename).toHaveBeenCalledWith('Plans');
  await userEvent.click(screen.getByRole('button', { name: database.name }));
  await userEvent.type(screen.getByRole('textbox'), 'Abandoned{Escape}');
  expect(onRename).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('textbox')).toBeNull();
});
it('shows the name, icon, color, and slots to readers without editing controls', async () => {
  const { container } = renderShell(
    <DatabaseHeader
      database={database}
      canManage={false}
      onRename={vi.fn()}
      saveIndicator={<SaveIndicator state={{ status: 'saving', pending: 1 }} />}
      presenceBar={<PresenceBar peers={[]} />}
    />,
  );
  expect(screen.getByRole('heading', { name: 'Projects' })).toBeDefined();
  expect(screen.getByRole('status').textContent).toBe('Saving…');
  expect(screen.getByRole('group', { name: 'People here' })).toBeDefined();
  expect(screen.queryAllByRole('button')).toHaveLength(0);
  await waitFor(() => expect(container.querySelector('svg path')?.getAttribute('d')).toBe(faFolder.icon[4]));
  expect(container.querySelector('.rio-database-icon')?.getAttribute('style')).toContain(
    '--rio-aa-choice-blue',
  );
});

it('names the rename button with the visible database name', () => {
  renderShell(<DatabaseHeader database={database} canManage onRename={vi.fn()} />);
  const trigger = screen.getByRole('button', { name: database.name });
  expect(trigger.textContent).toBe(database.name);
});
