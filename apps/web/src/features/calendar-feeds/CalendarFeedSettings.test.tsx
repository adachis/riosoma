import { renderSettings as renderSharing } from '../../screens/settings/testing';
import type { ReactNode } from 'react';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastRegion, toastQueue } from '@riosoma/ui';
import { json, session } from '../../screens/database/share/testing';
import { SettingsScreen } from '../../screens/settings/SettingsScreen';
import { CalendarFeedSettings } from './CalendarFeedSettings';

vi.mock('../../screens/settings/AppearanceSettings', () => ({ AppearanceSettings: () => null }));
vi.mock('../../screens/settings/LanguageSettings', () => ({ LanguageSettings: () => null }));
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => undefined,
  useLocation: () => ({ pathname: '/settings/calendar-feeds', href: '/settings/calendar-feeds' }),
  useParams: () => ({ section: 'calendar-feeds' }),
  useNavigate: () => () => {},
  Link: ({ params, children }: { params: { section: string }; children: ReactNode }) => (
    <a href={`/settings/${params.section}`}>{children}</a>
  ),
}));

afterEach(() => {
  cleanup();
  for (const toast of toastQueue.visibleToasts) toastQueue.close(toast.key);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function server(initial = true) {
  let enabled = initial;
  const saved: boolean[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url !== '/api/admin/calendar-feeds/policy') return json({});
      if (init?.method === 'PUT') {
        enabled = (JSON.parse(String(init.body)) as { enabled: boolean }).enabled;
        saved.push(enabled);
      }
      return json({ enabled });
    }),
  );
  return saved;
}

describe('calendar feeds in settings', () => {
  it.each([
    { kind: 'owner' as const, adminRoles: [], visible: true },
    { kind: 'member' as const, adminRoles: ['security'], visible: true },
    { kind: 'member' as const, adminRoles: ['people'], visible: false },
  ])('are listed for $kind with $adminRoles: $visible', ({ kind, adminRoles, visible }) => {
    server();
    renderSharing(<SettingsScreen />, { ...session, membership: { kind, adminRoles } });
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(Boolean(within(nav).queryByRole('link', { name: 'Calendar feeds' }))).toBe(visible);
  });

  it('asks before turning every feed off, and turns them back on in one step', async () => {
    const saved = server();
    renderSharing(
      <>
        <CalendarFeedSettings />
        <ToastRegion />
      </>,
    );
    const toggle = await screen.findByRole('switch', {
      name: 'Let people subscribe to views in calendar apps',
    });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    await userEvent.click(toggle);
    const question = await screen.findByRole('dialog', { name: 'Turn calendar feeds off?' });
    expect(saved).toEqual([]);
    await userEvent.click(within(question).getByRole('button', { name: 'Turn feeds off' }));
    expect(saved).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved).toEqual([false]));
    expect(await screen.findByText('Turned calendar feeds off')).toBeDefined();
    await userEvent.click(
      screen.getByRole('switch', { name: 'Let people subscribe to views in calendar apps' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved).toEqual([false, true]));
  });
});
