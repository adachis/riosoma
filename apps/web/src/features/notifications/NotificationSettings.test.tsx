import { renderSettings as renderSharing } from '../../screens/settings/testing';
import type { ReactNode } from 'react';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_NOTIFICATION_EMAIL,
  NOTIFICATION_CHANNELS,
  NotificationCommand,
  type NotificationChannelPreferences,
  NotificationPreferencesUpdate,
  type NotificationPreferences,
} from '@riosoma/contracts';
import { failure, json, session } from '../../screens/database/share/testing';
import { SettingsScreen } from '../../screens/settings/SettingsScreen';
import { NotificationSettings } from './NotificationSettings';

vi.mock('../../screens/settings/AppearanceSettings', () => ({ AppearanceSettings: () => null }));
vi.mock('../../screens/settings/LanguageSettings', () => ({ LanguageSettings: () => null }));
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => undefined,
  useLocation: () => ({ pathname: '/settings/notifications', href: '/settings/notifications' }),
  useNavigate: () => vi.fn(),
  useParams: () => ({ section: 'notifications' }),
  Link: ({ params, children }: { params: { section: string }; children: ReactNode }) => (
    <a href={`/settings/${params.section}`}>{children}</a>
  ),
}));

const LABELS = [
  'Someone mentions me',
  'Someone shares a database with me',
  'An automation acting as me turns itself off',
  'An automation acting as me fails',
  'A synced table I made stops syncing',
  'A synced table I made waits for someone to confirm removals',
  'A scheduled report I set up turns itself off',
  'An admin replies to feedback I sent',
  'A post to a webhook I set up can’t be written',
  'A single sign-on domain loses its verification',
  'A custom domain for public pages loses its verification',
  'A credential vault becomes unavailable',
  'An automation’s calendar event stays after I undo it',
];

function start(options: { saved?: Partial<NotificationPreferences>; refuse?: boolean } = {}) {
  let preferences: NotificationPreferences = {
    email: { ...DEFAULT_NOTIFICATION_EMAIL },
    emailAvailable: true,
    ...options.saved,
  };
  const saves: unknown[] = [];
  const commands: NotificationCommand[] = [];
  const channels: NotificationChannelPreferences = {
    channels: Object.fromEntries(
      NOTIFICATION_CHANNELS.map((channel) => [
        channel,
        Object.fromEntries(
          Object.entries(DEFAULT_NOTIFICATION_EMAIL).map(([kind, email]) => [
            kind,
            channel === 'bell' || (channel === 'email' && email),
          ]),
        ),
      ]),
    ) as NotificationChannelPreferences['channels'],
    digest: { frequency: 'off', hour: 9, timeZone: 'UTC' },
    enabled: Object.fromEntries(
      NOTIFICATION_CHANNELS.map((channel) => [channel, true]),
    ) as NotificationChannelPreferences['enabled'],
    available: { bell: true, email: true, push: true, digest: true, sms: false, slack: false, teams: false },
    devices: [],
    phone: null,
    canAdminister: true,
    canReceiveSms: true,
  };
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/notifications/channels') return json(channels);
    if (url === '/api/notifications/commands') {
      const command = NotificationCommand.parse(JSON.parse(String(init?.body)));
      commands.push(command);
      if (options.refuse) return failure('errors.unavailable', 503);
      if (command.kind === 'notifications.preferences') {
        for (const [channel, kinds] of Object.entries(command.update.channels ?? {}))
          Object.assign(channels.channels[channel as keyof typeof channels.channels], kinds);
        if (command.update.digest) channels.digest = command.update.digest;
      }
      if (command.kind === 'notifications.organization')
        Object.assign(channels.enabled, command.update.enabled);
      if (command.kind === 'notifications.connection') channels.available[command.connection.channel] = true;
      return json({ status: 'applied', actionId: command.id });
    }
    if (url !== '/api/notifications/preferences') throw new Error(`Unexpected request: ${url}`);
    if (init?.method === 'PUT') {
      const body = NotificationPreferencesUpdate.parse(JSON.parse(String(init.body)));
      saves.push(body);
      if (options.refuse) return failure('errors.unavailable', 503);
      preferences = { ...preferences, email: { ...preferences.email, ...body.email } };
    }
    return json(preferences);
  });
  vi.stubGlobal('fetch', fetcher);
  return { fetcher, saves, commands, channels };
}

const toggle = (name: string) => screen.getByRole<HTMLInputElement>('switch', { name });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('NotificationSettings', () => {
  it('shows one switch per kind and channel, with email choices as the person left them', async () => {
    start({ saved: { email: { ...DEFAULT_NOTIFICATION_EMAIL, mention: false, automationFailed: true } } });
    renderSharing(<NotificationSettings />);
    const group = await screen.findByRole('table', { name: 'Notification channels' });
    expect(within(group).getAllByRole('switch')).toHaveLength(21 * 7);
    expect(LABELS.map((name) => toggle(name).checked)).toEqual([
      false,
      true,
      true,
      true,
      false,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(screen.getByText('At most once an hour for each automation')).toBeDefined();
    expect(screen.queryByText(/isn’t set up to send email/)).toBeNull();
  });

  it('offers each domain switch only to the owner and the administrators who verify those domains', async () => {
    const single = 'A single sign-on domain loses its verification';
    const custom = 'A custom domain for public pages loses its verification';
    start();
    renderSharing(<NotificationSettings />, {
      ...session,
      membership: { kind: 'member', adminRoles: ['people'] },
    });
    const group = await screen.findByRole('table', { name: 'Notification channels' });
    expect(within(group).getAllByRole('switch')).toHaveLength(17 * 7);
    expect(within(group).queryByText(single)).toBeNull();
    expect(within(group).queryByText(custom)).toBeNull();
    expect(within(group).queryByText('A credential vault becomes unavailable')).toBeNull();
    cleanup();
    start();
    renderSharing(<NotificationSettings />, {
      ...session,
      membership: { kind: 'member', adminRoles: ['security'] },
    });
    expect(await screen.findByText(single)).toBeDefined();
    expect(toggle('A credential vault becomes unavailable').checked).toBe(true);
    expect(screen.queryByText(custom)).toBeNull();
    cleanup();
    start();
    renderSharing(<NotificationSettings />, {
      ...session,
      membership: { kind: 'member', adminRoles: ['integrations'] },
    });
    expect(await screen.findByText(custom)).toBeDefined();
    expect(screen.queryByText(single)).toBeNull();
  });

  it('offers the vault alert only to the owner and Integrations administrators', async () => {
    const vault = 'A credential vault can’t be reached';
    for (const adminRoles of [[], ['people'], ['security']]) {
      start();
      renderSharing(<NotificationSettings />, { ...session, membership: { kind: 'member', adminRoles } });
      const group = await screen.findByRole('table', { name: 'Notification channels' });
      expect(within(group).queryByText(vault), adminRoles.join()).toBeNull();
      cleanup();
    }
    start();
    renderSharing(<NotificationSettings />, {
      ...session,
      membership: { kind: 'member', adminRoles: ['integrations'] },
    });
    expect(await screen.findByText(vault)).toBeDefined();
    expect(
      screen.getByText('For the owner and Integrations administrators, at most once an hour while it lasts'),
    ).toBeDefined();
    // They have to act on it, so its email starts on.
    expect(toggle(vault).checked).toBe(true);
    cleanup();
    start();
    renderSharing(<NotificationSettings />);
    expect(await screen.findByText(vault)).toBeDefined();
  });

  it('saves pending switches together from the page bar', async () => {
    const { saves } = start();
    renderSharing(<NotificationSettings />);
    await screen.findByRole('table', { name: 'Notification channels' });
    await userEvent.click(toggle('An automation acting as me fails'));
    await userEvent.click(toggle('Someone mentions me'));
    expect(saves).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saves).toEqual([{ email: { automationFailed: true, mention: false } }]));
    expect(toggle('An automation acting as me fails').checked).toBe(true);
    expect(toggle('Someone mentions me').checked).toBe(false);
  });

  it('retains a pending switch and says why when saving fails', async () => {
    const { saves } = start({ refuse: true });
    renderSharing(<NotificationSettings />);
    await screen.findByRole('table', { name: 'Notification channels' });
    await userEvent.click(toggle('Someone shares a database with me'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      (await screen.findAllByText(/^The server is busy\.\s+Try again in a moment\.$/)).length,
    ).toBeGreaterThan(0);
    expect(saves).toEqual([{ email: { share: false } }]);
    expect(toggle('Someone shares a database with me').checked).toBe(false);
  });

  it('says so calmly when the server can’t send email yet', async () => {
    start({ saved: { emailAvailable: false } });
    renderSharing(<NotificationSettings />);
    // Matching collapses runs of spaces, so the two after each sentence read as one here.
    expect(
      await screen.findByText(
        /^This server isn’t set up to send email yet\.\s+Your choices take effect once an administrator sets it up\.$/,
      ),
    ).toBeDefined();
  });

  it.each(['owner', 'member', 'guest'] as const)('is a settings section for every %s', async (kind) => {
    start();
    renderSharing(<SettingsScreen />, { ...session, membership: { kind, adminRoles: [] } });
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(nav).getByRole('link', { name: 'Notifications' }).getAttribute('href')).toBe(
      '/settings/notifications',
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Notifications' })).toBeDefined();
    expect(await screen.findByRole('table', { name: 'Notification channels' })).toBeDefined();
  });
});

it('saves channel choices, digest timing, and organization shutdown independently', async () => {
  const { commands } = start();
  renderSharing(<NotificationSettings />);
  await screen.findByRole('table', { name: 'Notification channels' });
  await userEvent.click(toggle('Push: Someone mentions me'));
  await waitFor(() => expect(toggle('Push: Someone mentions me').disabled).toBe(false));
  expect(toggle('Push: Someone mentions me').checked).toBe(true);
  await userEvent.selectOptions(screen.getByLabelText('Frequency'), 'weekly');
  await waitFor(() => expect(screen.getByLabelText('Frequency').hasAttribute('disabled')).toBe(false));
  expect(commands).toEqual([]);
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(commands).toHaveLength(1));
  expect(commands[0]).toMatchObject({
    kind: 'notifications.preferences',
    update: { digest: { frequency: 'weekly', hour: 9, timeZone: 'UTC' } },
  });
  await userEvent.click(screen.getByRole('switch', { name: 'Push' }));
  await waitFor(() => expect(toggle('Push: Someone mentions me').disabled).toBe(true));
  expect(toggle('Push: Someone mentions me').checked).toBe(true);
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(commands).toHaveLength(2));
  expect(commands[1]).toMatchObject({
    kind: 'notifications.organization',
    update: { enabled: { push: false } },
  });
  expect(toggle('Admin SMS: Someone mentions me').disabled).toBe(true);
  expect(screen.getByRole('link', { name: 'Your devices' }).getAttribute('href')).toBe('#devices');
});

it('keeps a channel draft when its command fails', async () => {
  start({ refuse: true });
  renderSharing(<NotificationSettings />);
  await screen.findByRole('table', { name: 'Notification channels' });
  await userEvent.click(toggle('Slack: Someone mentions me'));
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(
    (await screen.findAllByText(/^The server is busy\.\s+Try again in a moment\.$/)).length,
  ).toBeGreaterThan(0);
  expect(toggle('Slack: Someone mentions me').checked).toBe(true);
});

it('requires a delivery connection and saves its draft with the organization switch', async () => {
  const { commands } = start();
  renderSharing(<NotificationSettings />);
  await screen.findByRole('table', { name: 'Notification channels' });
  const channel = screen.getByRole('switch', { name: /^Slack$/ });
  const save = screen.getByRole('button', { name: 'Save' });
  await userEvent.click(channel);
  await userEvent.click(save);
  await waitFor(() => expect(commands).toHaveLength(1));
  await waitFor(() => expect(save).toHaveProperty('disabled', true));
  await userEvent.click(channel);
  await userEvent.click(save);
  expect(commands).toHaveLength(1);
  await waitFor(() => expect(document.activeElement).toBe(channel));
  expect(channel.closest('.rio-switch')?.textContent).toContain(
    'Complete each field for this delivery connection.',
  );
  await userEvent.type(screen.getByLabelText('Bot token'), 'test-token');
  await userEvent.click(save);
  await waitFor(() => expect(commands).toHaveLength(3));
  expect(commands[1]).toMatchObject({
    kind: 'notifications.connection',
    connection: { channel: 'slack', token: 'test-token' },
  });
  expect(commands[2]).toMatchObject({
    kind: 'notifications.organization',
    update: { enabled: { slack: true } },
  });
  await waitFor(() => expect(save).toHaveProperty('disabled', true));
});
