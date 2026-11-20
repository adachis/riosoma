import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { json, renderSharing } from '../screens/database/share/testing';
import { NotificationBell } from '../features/notifications/NotificationBell';
import { HeaderOverflow } from './HeaderOverflow';
import { CompactHeaderStatus } from './CompactHeaderStatus';
import { updatesQuery } from '../features/updates/query';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('keeps an empty status overflow out of the header and shows it when an update arrives', async () => {
  const fetcher = vi.fn(async (_url: string) => json({ available: [] }));
  vi.stubGlobal('fetch', fetcher);
  const rendered = renderSharing(<CompactHeaderStatus />);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  // AI spending is shown in Rio's panel, so the header never asks for it.
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/admin/updates']);
  expect(screen.queryByRole('button', { name: 'More header controls' })).toBeNull();
  act(() => rendered.client.setQueryData(updatesQuery.queryKey, { available: [{ version: '99.0.0' }] }));
  expect(await screen.findByRole('button', { name: 'More header controls' })).toBeTruthy();
  rendered.client.clear();
});

it('opens secondary header controls from the keyboard and returns focus on Escape', async () => {
  renderSharing(
    <HeaderOverflow>
      <NotificationBell />
    </HeaderOverflow>,
  );
  const user = userEvent.setup();
  const trigger = screen.getByRole('button', { name: 'More header controls' });
  trigger.focus();
  await user.keyboard('{Enter}');
  await screen.findByRole('dialog', { name: 'More header controls' });
  expect(screen.getByRole('button', { name: 'Notifications' })).toBeTruthy();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(document.activeElement).toBe(trigger);
});
