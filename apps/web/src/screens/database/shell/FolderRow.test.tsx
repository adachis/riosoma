import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { renderShell } from './test-support';
import { FolderRow } from './FolderRow';

afterEach(cleanup);

it('keeps navigation pending while a slower double-click chooses rename', async () => {
  const navigate = vi.fn();
  renderShell(<FolderRow name="Planning" onNavigate={navigate} onRename={() => undefined} />);
  const name = screen.getByRole('button', { name: 'Planning' });
  await userEvent.click(name);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  fireEvent.doubleClick(name);
  expect(await screen.findByRole('textbox', { name: 'Folder name' })).toBeTruthy();
  expect(navigate).not.toHaveBeenCalled();
});

it('cancels pending name navigation when another control receives the pointer', async () => {
  const navigate = vi.fn();
  renderShell(<FolderRow name="Planning" onNavigate={navigate} onRename={() => undefined} />);
  await userEvent.click(screen.getByRole('button', { name: 'Planning' }));
  fireEvent.pointerDown(document.body);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 550));
  });
  expect(navigate).not.toHaveBeenCalled();
});

it('keeps a failed rename available to retry and closes it only after saving', async () => {
  let reject: (error: Error) => void = () => undefined;
  const rename = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((_, fail) => {
          reject = fail;
        }),
    )
    .mockResolvedValue(undefined);
  renderShell(<FolderRow name="Planning" onRename={rename} />);
  const row = screen.getByRole('group', { name: 'Planning' });
  row.focus();
  await userEvent.keyboard('{F2}');
  const input = await screen.findByRole('textbox', { name: 'Folder name' });
  await userEvent.clear(input);
  await userEvent.type(input, 'Ready{Enter}');
  expect(input.hasAttribute('readonly')).toBe(true);
  await act(async () => reject(new Error('Save failed')));
  expect((input as HTMLInputElement).value).toBe('Ready');
  expect(input.hasAttribute('readonly')).toBe(false);
  await userEvent.type(input, '{Enter}');
  expect(rename).toHaveBeenNthCalledWith(2, 'Ready');
  expect(screen.queryByRole('textbox')).toBeNull();
});

it('cancels a rename without writing and preserves keyboard navigation', async () => {
  const rename = vi.fn();
  const navigate = vi.fn();
  renderShell(<FolderRow name="Planning" onRename={rename} onNavigate={navigate} />);
  const row = screen.getByRole('group', { name: 'Planning' });
  row.focus();
  await userEvent.keyboard('{F2}');
  const input = await screen.findByRole('textbox', { name: 'Folder name' });
  await userEvent.type(input, 'Canceled{Escape}');
  expect(rename).not.toHaveBeenCalled();
  row.focus();
  await userEvent.keyboard('{Enter}');
  expect(navigate).toHaveBeenCalledOnce();
});

it('opens a readable Home folder without exposing an empty action menu', async () => {
  const navigate = vi.fn();
  renderShell(<FolderRow name="Planning" onNavigate={navigate} />);
  await userEvent.click(screen.getByRole('button', { name: 'Open Planning' }));
  expect(navigate).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button', { name: 'More for Planning' })).toBeNull();
});
