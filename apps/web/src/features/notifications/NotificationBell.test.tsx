import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DemoScript, newId, type Notification, type NotificationsPage } from '@riosoma/contracts';
import { DemoRunner } from '../../demos/runner';
import { json, renderSharing } from '../../screens/database/share/testing';
import { NotificationBell } from './NotificationBell';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));

const databaseId = newId('database');
const tableId = newId('table');
const viewId = newId('view');
const recordId = newId('record');
const automationId = newId('automation');
const sam = { id: newId('user'), name: 'Sam Stone' };
const justNow = () => new Date(Date.now() - 1_000).toISOString();
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

function note(kind: Notification['kind'], extra: Partial<Notification> = {}): Notification {
  return {
    id: newId('notification'),
    kind,
    createdAt: justNow(),
    readAt: null,
    actor: null,
    target: { databaseId, databaseName: 'Sales' },
    ...extra,
  };
}

const mention = note('mention', {
  actor: sam,
  target: {
    databaseId,
    databaseName: 'Sales',
    tableId,
    tableName: 'Leads',
    viewId,
    recordId,
    commentId: newId('comment'),
    excerpt: 'Can you check the totals?',
  },
});
const everyKind: Notification[] = [
  mention,
  note('share', {
    actor: sam,
    readAt: justNow(),
    target: { databaseId, databaseName: 'Sales', role: 'editor' },
  }),
  note('automationStopped', {
    target: {
      databaseId,
      databaseName: 'Sales',
      automationId,
      automationName: 'Weekly digest',
      reason: { messageKey: 'automations.runAs.denied' },
    },
  }),
  note('automationFailed', {
    createdAt: daysAgo(2),
    target: {
      databaseId,
      databaseName: 'Sales',
      automationId,
      automationName: 'Weekly digest',
      reason: { messageKey: 'automations.webhook.timeout' },
    },
  }),
  note('syncFailed', {
    createdAt: daysAgo(3),
    target: {
      databaseId,
      databaseName: 'Sales',
      tableId,
      tableName: 'Customers',
      reason: { messageKey: 'sources.sync.timeout' },
    },
  }),
  note('syncHeld', {
    createdAt: daysAgo(3),
    readAt: daysAgo(1),
    target: {
      databaseId,
      databaseName: 'Sales',
      tableId,
      tableName: 'Customers',
      held: { removing: 12, total: 30 },
    },
  }),
  note('reportStopped', {
    createdAt: daysAgo(4),
    readAt: daysAgo(1),
    target: {
      databaseId,
      databaseName: 'Sales',
      tableId,
      tableName: 'Customers',
      viewId,
      reportId: newId('report'),
      reportName: 'Monday pipeline',
      reason: { messageKey: 'reports.stopped.viewDeleted' },
    },
  }),
  note('feedbackReply', {
    createdAt: daysAgo(5),
    readAt: daysAgo(1),
    actor: sam,
    target: { feedbackId: newId('feedback'), excerpt: 'Fixed in the next version.' },
  }),
];

/** A server with an unread count and pages of notifications, recording what's marked read. */
function start(options: { unread?: number; pages?: NotificationsPage[] } = {}) {
  const state = { unread: options.unread ?? 0 };
  const pages = options.pages ?? [{ notifications: everyKind, next: null }];
  const marked: unknown[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/notifications/unread') return json({ count: state.unread });
    if (url === '/api/notifications/read' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { ids?: string[]; all?: true };
      marked.push(body);
      state.unread = body.all ? 0 : Math.max(0, state.unread - (body.ids?.length ?? 0));
      return json({ count: state.unread });
    }
    if (url.startsWith('/api/notifications')) {
      const before = new URL(url, 'http://localhost').searchParams.get('before');
      return json(before ? pages.find((_, index) => pages[index - 1]?.next === before) : pages[0]);
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  renderSharing(<NotificationBell />);
  return { fetcher, marked, state };
}

async function openBell() {
  await userEvent.click(await screen.findByRole('button', { name: /^Notifications/ }));
  return screen.findByRole('dialog', { name: 'Notifications' });
}

const badge = () => document.querySelector('.rio-notification-bell__badge')?.textContent ?? null;

afterEach(() => {
  cleanup();
  navigate.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('NotificationBell', () => {
  it.each([
    { state: 'empty', notifications: [] },
    { state: 'read', notifications: [{ ...mention, readAt: justNow() }] },
    { state: 'unread', notifications: [mention] },
  ])(
    'finishes its demo when the list is $state and Settings is absent, without changing anything',
    async ({ notifications }) => {
      const { fetcher, marked } = start({
        unread: notifications.filter((notification) => !notification.readAt).length,
        pages: [{ notifications, next: null }],
      });
      const script = DemoScript.parse(
        JSON.parse(
          readFileSync(
            join(import.meta.dirname, '../../../../../docs/modules/account/notifications/demo.json'),
            'utf8',
          ),
        ),
      );
      const said: string[] = [];
      const runner = new DemoRunner(script, {
        document,
        narrate: (line) => {
          said.push(line.text);
          return { done: Promise.resolve('ended'), stop: () => undefined };
        },
        stopNarration: () => undefined,
        sandbox: { begin: () => undefined, reset: () => undefined, end: () => undefined },
        say: (id) => id,
        lang: 'en-US',
        reducedMotion: () => true,
        aboveLevel: false,
        timing: { find: 0, beat: 0, gap: 0 },
      });
      try {
        await act(() => runner.start());
        await waitFor(() => expect(runner.getState().status).toBe('ended'));
        expect(runner.getState().outcome).toBe('finished');
        expect(said).toEqual(script.steps.map((step) => step.say));
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(marked).toEqual([]);
        expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
        expect(navigate).not.toHaveBeenCalled();
      } finally {
        await act(() => runner.stop());
      }
    },
  );

  it.each([
    { unread: 0, label: 'Notifications', shown: null },
    { unread: 1, label: 'Notifications, 1 unread', shown: '1' },
    { unread: 9, label: 'Notifications, 9 unread', shown: '9' },
    { unread: 10, label: 'Notifications, 10 unread, 9+', shown: '9+' },
    { unread: 120, label: 'Notifications, 120 unread, 9+', shown: '9+' },
  ])('counts $unread unread in its badge and its name', async ({ unread, label, shown }) => {
    start({ unread });
    expect(await screen.findByRole('button', { name: label })).toBeDefined();
    expect(badge()).toBe(shown);
  });

  it('asks again when the person comes back to the page', async () => {
    const { state } = start({ unread: 1 });
    await screen.findByRole('button', { name: 'Notifications, 1 unread' });
    state.unread = 4;
    window.dispatchEvent(new Event('focus'));
    expect(await screen.findByRole('button', { name: 'Notifications, 4 unread' })).toBeDefined();
    expect(badge()).toBe('4');
  });

  it('words each kind plainly, with who did what, where, and when', async () => {
    start({ unread: 4 });
    const dialog = await openBell();
    const today = await within(dialog).findByRole('region', { name: 'Today' });
    const earlier = within(dialog).getByRole('region', { name: 'Earlier' });
    const item = (region: HTMLElement, name: RegExp) => within(region).getByRole('link', { name });

    const mentioned = item(today, /Sam Stone mentioned you in Leads/);
    expect(mentioned.textContent).toContain('“Can you check the totals?”');
    expect(mentioned.textContent).toContain('Sales');
    expect(mentioned.textContent).toContain('just now');
    expect(item(today, /Sam Stone shared Sales with you/).textContent).toContain('You’re an editor.');
    expect(item(today, /Weekly digest turned itself off/).textContent).toContain(
      'It acts as you, and you can no longer make its changes.',
    );
    expect(item(earlier, /Weekly digest failed a run/).textContent).toContain(
      'The webhook didn’t answer within 10 seconds.',
    );
    expect(item(earlier, /Customers stopped syncing/).textContent).toContain(
      'The sync took too long and stopped.',
    );
    expect(item(earlier, /Customers is waiting for you to confirm a sync/).textContent).toContain(
      'It would remove 12 of 30 records.',
    );
    const report = item(earlier, /Monday pipeline turned itself off/);
    expect(report.textContent).toContain('Its view, table, or database was deleted.');
    expect(report.getAttribute('href')).toBe(`/${databaseId}/${tableId}/${viewId}`);
    // A reply to feedback belongs to no database, and opens what the person sent.
    const reply = item(earlier, /Sam Stone replied to your feedback/);
    expect(reply.textContent).toContain('“Fixed in the next version.”');
    expect(reply.textContent).not.toContain('Sales');
    expect(reply.getAttribute('href')).toBe('/settings/my-feedback');
    // Unread ones say so to everyone, not just by the dot.
    const unread = within(dialog)
      .getAllByRole('link')
      .filter((link) => link.hasAttribute('data-unread'))
      .map((link) => link.textContent?.startsWith('Unread:'));
    expect(unread).toEqual([true, true, true, true]);
    expect(item(today, /shared Sales/).hasAttribute('data-unread')).toBe(false);
    expect(mentioned.getAttribute('href')).toBe(`/${databaseId}/${tableId}/${viewId}/${recordId}`);
  });

  it('marks a mention read and opens its record, which starts on the comments', async () => {
    const { marked } = start({ unread: 4 });
    const dialog = await openBell();
    await userEvent.click(within(dialog).getByRole('link', { name: /Sam Stone mentioned you in Leads/ }));
    expect(navigate).toHaveBeenCalledWith({ to: `/${databaseId}/${tableId}/${viewId}/${recordId}` });
    await waitFor(() => expect(marked).toEqual([{ ids: [mention.id] }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByRole('button', { name: 'Notifications, 3 unread' })).toBeDefined();
  });

  it('marks everything read at once', async () => {
    const { marked } = start({ unread: 4 });
    const dialog = await openBell();
    await within(dialog).findByRole('region', { name: 'Today' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark all as read' }));
    await waitFor(() => expect(marked).toEqual([{ all: true }]));
    expect(
      within(dialog)
        .getAllByRole('link')
        .some((link) => link.hasAttribute('data-unread')),
    ).toBe(false);
    expect(await screen.findByRole('button', { name: 'Notifications' })).toBeDefined();
    expect(badge()).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Mark all as read' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('reads calmly when there’s nothing to see', async () => {
    start({ pages: [{ notifications: [], next: null }] });
    const dialog = await openBell();
    expect(await within(dialog).findByText('You’re all caught up')).toBeDefined();
    expect(within(dialog).queryByRole('link')).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Mark all as read' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('loads more as the list scrolls', async () => {
    const older = note('share', {
      actor: sam,
      createdAt: daysAgo(20),
      target: { databaseId, databaseName: 'Archive', role: 'reader' },
    });
    const { fetcher } = start({
      pages: [
        { notifications: [mention], next: 'page-two' },
        { notifications: [older], next: null },
      ],
    });
    const dialog = await openBell();
    await within(dialog).findByRole('link', { name: /mentioned you/ });
    expect(within(dialog).queryByRole('link', { name: /shared Archive/ })).toBeNull();
    const scroller = dialog.querySelector('.rio-notifications__scroller');
    fireEvent.scroll(scroller!);
    expect(
      await within(dialog).findByRole('link', { name: /Sam Stone shared Archive with you/ }),
    ).toBeDefined();
    expect(fetcher).toHaveBeenCalledWith('/api/notifications?before=page-two', expect.anything());
    // The last page ends the list, so scrolling again asks for nothing more.
    const asked = fetcher.mock.calls.length;
    fireEvent.scroll(scroller!);
    expect(fetcher.mock.calls.length).toBe(asked);
  });

  it('tells a webhook’s person that a post failed, and opens the sources', async () => {
    const failed = note('webhookFailed', {
      target: { sourceId: newId('source'), sourceName: 'Orders' },
    });
    start({ unread: 1, pages: [{ notifications: [failed], next: null }] });
    const dialog = await openBell();
    const link = await within(dialog).findByRole('link', { name: /A post to Orders couldn’t be written/ });
    expect(link.textContent).toContain(
      'It was tried for an hour, and it’s kept in the webhook’s delivery log.',
    );
    expect(link.getAttribute('href')).toBe('/settings/sources');
  });

  it('tells Security administrators a domain lost its verification, and opens provisioning', async () => {
    const lapsed = note('domainUnverified', { target: { domain: 'example.test' } });
    start({ unread: 1, pages: [{ notifications: [lapsed], next: null }] });
    const dialog = await openBell();
    const link = await within(dialog).findByRole('link', { name: /example.test is no longer verified/ });
    expect(link.textContent).toContain('Three daily checks in a row couldn’t find its DNS record.');
    expect(link.getAttribute('href')).toBe('/settings/scim');
  });

  it('tells Integrations administrators a custom domain lost its verification, and opens its settings', async () => {
    const lapsed = note('customDomainUnverified', { target: { domain: 'forms.example.test' } });
    start({ unread: 1, pages: [{ notifications: [lapsed], next: null }] });
    const dialog = await openBell();
    const link = await within(dialog).findByRole('link', {
      name: /forms.example.test is no longer verified/,
    });
    expect(link.textContent).toContain(
      'Three daily checks in a row couldn’t find its DNS record, so its public pages are unavailable.',
    );
    expect(link.getAttribute('href')).toBe('/settings/custom-domains');
  });

  it('shows the gateway fix to admins and opens that gateway’s settings', async () => {
    const gatewayAlert = note('securityEvent', {
      target: {
        gatewayProviderId: 'gateway-office',
        reason: { messageKey: 'ai.gateway.modelRestricted', params: { model: 'allowed-route' } },
      },
    });
    start({ unread: 1, pages: [{ notifications: [gatewayAlert], next: null }] });
    const dialog = await openBell();
    const link = await within(dialog).findByRole('link', { name: /Rio’s gateway needs attention/ });
    expect(link.textContent).toContain(
      'The gateway route only allows model allowed-route.  Set that model in the gateway’s model list.',
    );
    expect(link.getAttribute('href')).toBe('/settings/ai#gateway-office');
  });

  it('tells the owner and Integrations administrators what an unreachable vault held back, and opens the channels', async () => {
    const unreachable = note('vaultUnavailable', { target: {} });
    start({ unread: 1, pages: [{ notifications: [unreachable], next: null }] });
    const dialog = await openBell();
    const link = await within(dialog).findByRole('link', { name: /A credential vault can’t be reached/ });
    expect(link.textContent).toContain(
      'Slack, Teams, and text messages for that time weren’t sent, and each notification stays in the bell.',
    );
    expect(link.textContent).not.toContain('messages wait');
    expect(link.getAttribute('href')).toBe('/settings/notifications#organization');
  });
  it('shows ingest counts and localized hold reasons without quoting row values', async () => {
    const target = {
      databaseId,
      databaseName: 'Sales',
      tableId,
      tableName: 'Leads',
      excerpt: 'private row values',
      message: 'private row values',
    };
    const read = note('ingest.file.read', {
      target: { ...target, ingestCounts: { added: 2, updated: 3, identical: 4, flagged: 5, refused: 6 } },
    });
    const held = note('ingest.file.held', {
      target: { ...target, reason: { messageKey: 'ingest.fields.locked' } },
    });
    start({ unread: 2, pages: [{ notifications: [read, held], next: null }] });
    const dialog = await openBell();
    expect(dialog.textContent).toContain('Added: 2, updated: 3, identical: 4, flagged: 5, and refused: 6.');
    expect(dialog.textContent).toContain('A file is held on Leads.  Ask Rio to change this field.');
    expect(dialog.textContent).not.toContain('private row values');
  });
});
