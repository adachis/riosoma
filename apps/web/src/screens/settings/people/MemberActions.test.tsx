import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useQuery } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { ToastRegion, toastQueue } from '@riosoma/ui';
import type { Member } from '@riosoma/contracts';
import { api } from '../../../api';
import { MemberActions } from './MemberActions';
import { json, renderSharing, session } from '../../database/share/testing';

vi.mock('@tanstack/react-router', () => ({ useRouter: () => undefined }));

const member: Member = {
  id: 'sam',
  name: 'Sam',
  email: 'sam@example.com',
  kind: 'member',
  adminRoles: [],
  deactivated: false,
};

afterEach(() => {
  cleanup();
  toastQueue.clear();
  window.history.replaceState({}, '', '/settings/people');
  vi.unstubAllGlobals();
});

const changes = [
  {
    change: 'deactivation',
    action: 'deactivate',
    label: 'Deactivate',
    endpoint: 'status',
    deactivated: false,
  },
  {
    change: 'reactivation',
    action: 'reactivate',
    label: 'Reactivate',
    endpoint: 'status',
    deactivated: true,
  },
  { change: 'role change', action: 'make-owner', label: 'Make owner', endpoint: 'role', deactivated: false },
].flatMap((change) => ['Undo', 'Dismiss'].map((finish) => ({ ...change, finish })));

it.each(changes)(
  'keeps $change Undo available until $finish is pressed',
  async ({ action, label, endpoint, deactivated, finish }) => {
    const user = userEvent.setup();
    const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/api/auth/session') return json(session);
      if (url === `/api/org/members/sam/${endpoint}` && options?.method === 'PATCH')
        return json({ eventId: '42', undoable: true });
      if (url === '/api/org/members/sam/undo' && options?.method === 'POST') return json({ eventId: '43' });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    window.history.replaceState({}, '', `/settings/people?person=sam&action=${action}`);
    renderSharing(
      <>
        <MemberActions member={{ ...member, deactivated }} />
        <ToastRegion />
      </>,
    );

    await user.click(
      within(screen.getByRole('dialog', { name: `${label}: Sam` })).getByRole('button', {
        name: label,
      }),
    );
    await screen.findByRole('alertdialog', { name: 'Updated access for Sam' });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 6000));
    });

    const confirmation = screen.getByRole('alertdialog', { name: 'Updated access for Sam' });
    await user.click(within(confirmation).getByRole('button', { name: finish }));
    expect(screen.queryByRole('alertdialog', { name: 'Updated access for Sam' })).toBeNull();
    const undo = fetcher.mock.calls.find(([url]) => url === '/api/org/members/sam/undo');
    if (finish === 'Undo') {
      expect(undo?.[1]?.method).toBe('POST');
      expect(JSON.parse(undo?.[1]?.body as string)).toEqual({ eventId: '42' });
    } else expect(undo).toBeUndefined();
  },
);

function CurrentMemberActions() {
  const { data } = useQuery({
    queryKey: ['org', 'members'],
    queryFn: () => api<Member[]>('/api/org/members'),
    initialData: [member],
    staleTime: Infinity,
  });
  return (
    <>
      <MemberActions member={data[0]!} />
      <ToastRegion />
    </>
  );
}

it('replaces an earlier access confirmation and undoes only the latest change', async () => {
  let listed = member;
  let eventId = 41;
  let release!: () => void;
  let started!: () => void;
  const refreshing = new Promise<void>((resolve) => {
    release = resolve;
  });
  const refreshStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/auth/session') return json(session);
    if (url === '/api/org/members') {
      if (eventId === 43) {
        started();
        await refreshing;
      }
      return json([listed]);
    }
    if (url === '/api/org/members/sam/status' && options?.method === 'PATCH') {
      listed = { ...listed, deactivated: JSON.parse(options.body as string).deactivated };
      return json({ eventId: String(++eventId), undoable: true });
    }
    if (url === '/api/org/members/sam/undo' && options?.method === 'POST') return json({ eventId: '44' });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  const user = userEvent.setup();
  window.history.replaceState({}, '', '/settings/people?person=sam&action=deactivate');
  renderSharing(<CurrentMemberActions />);
  await user.click(
    within(screen.getByRole('dialog', { name: 'Deactivate: Sam' })).getByRole('button', {
      name: 'Deactivate',
    }),
  );
  const first = await screen.findByRole('alertdialog', { name: 'Updated access for Sam' });
  await user.click(screen.getByRole('button', { name: 'Actions for Sam' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Reactivate' }));
  await user.click(
    within(screen.getByRole('dialog', { name: 'Reactivate: Sam' })).getByRole('button', {
      name: 'Reactivate',
    }),
  );
  try {
    await act(async () => {
      await refreshStarted;
    });
    expect(first.isConnected).toBe(false);
    expect(toastQueue.visibleToasts).toHaveLength(0);
    expect(screen.queryByRole('alertdialog', { name: 'Updated access for Sam' })).toBeNull();
  } finally {
    release();
  }
  await screen.findByRole('alertdialog', { name: 'Updated access for Sam' });
  expect(toastQueue.visibleToasts).toHaveLength(1);
  const latest = screen.getByRole('alertdialog', { name: 'Updated access for Sam' });
  await user.click(within(latest).getByRole('button', { name: 'Undo' }));
  const undo = fetcher.mock.calls.find(([url]) => url === '/api/org/members/sam/undo');
  expect(JSON.parse(undo?.[1]?.body as string)).toEqual({ eventId: '43' });
});
