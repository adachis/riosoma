import { renderSettings as renderSharing } from '../../screens/settings/testing';
import type { ReactNode } from 'react';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  FeedbackGithubSettings,
  FeedbackHubSettings,
  FeedbackIssuePreview,
  FeedbackItem,
  SentFeedbackList,
  SessionInfo,
} from '@riosoma/contracts';
import { json, session } from '../../screens/database/share/testing';
import { SettingsScreen } from '../../screens/settings/SettingsScreen';
import { FeedbackInbox } from './FeedbackInbox';
import { SentFeedback } from './SentFeedback';

// A stand-in token, built here so it never reads as a stored secret.
const FAKE_TOKEN = ['ghp', 'secret'].join('_');

const place = vi.hoisted(() => ({ section: 'feedback' }));
vi.mock('../../screens/settings/AppearanceSettings', () => ({ AppearanceSettings: () => null }));
vi.mock('../../screens/settings/LanguageSettings', () => ({ LanguageSettings: () => null }));
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => undefined,
  useNavigate: () => vi.fn(),
  useParams: () => ({ section: place.section }),
  useLocation: () => ({ pathname: `/settings/${place.section}`, href: `/settings/${place.section}` }),
  Link: ({ params, children }: { params: { section: string }; children: ReactNode }) => (
    <a href={`/settings/${params.section}`}>{children}</a>
  ),
}));

const context = {
  path: '/dbAAAAAAAAAAAAAA/tblAAAAAAAAAAAAAA/viwAAAAAAAAAAAAAA/:record',
  appVersion: '1.0.0',
  browser: 'Firefox 140',
  platform: 'Linux',
  theme: 'nature',
  language: 'en-US',
  errors: [],
};

function item(overrides: Partial<FeedbackItem> = {}): FeedbackItem {
  return {
    id: 'fbkAAAAAAAAAAAAAA',
    kind: 'broken',
    status: 'new',
    message: 'The grid freezes when I paste rows',
    context,
    screenshot: { bytes: 2048, type: 'image/png' },
    sender: { id: 'usrMIRAMIRAMIRAMI', name: 'Mira' },
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
    replies: [],
    issue: null,
    ...overrides,
  };
}

const member = (adminRoles: string[] = []): SessionInfo => ({
  ...session,
  membership: { kind: 'member', adminRoles },
});

function start(
  options: {
    github?: Partial<FeedbackGithubSettings>;
    hub?: Partial<FeedbackHubSettings>;
    items?: FeedbackItem[];
    pending?: boolean;
  } = {},
) {
  const items = options.items ?? [
    item(),
    item({ id: 'fbkBBBBBBBBBBBBBB', kind: 'idea', status: 'seen', message: 'Pin views', screenshot: null }),
  ];
  const github: FeedbackGithubSettings = {
    enabled: false,
    repository: null,
    hasToken: false,
    canChange: true,
    ...options.github,
  };
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const hub: FeedbackHubSettings = {
    enabled: false,
    canChange: true,
    url: 'https://hub.test/bugs',
    preview: {
      installId: 'd4201b2f-d156-41b8-a5f9-f27bd8a7d911',
      fingerprint: 'a'.repeat(64),
      version: '1.0.0',
      platform: 'Linux',
      title: 'Grid freezes',
      description: 'Grid freezes',
    },
    ...options.hub,
  };
  const preview: FeedbackIssuePreview = {
    repository: 'acme/app',
    title: 'The grid freezes when I paste rows',
    body: '> The grid freezes when I paste rows\n\n**Context**',
    screenshot: null,
    similar: [
      { number: 7, title: 'Grid freezes on paste', url: 'https://github.example.test/acme/app/issues/7' },
    ],
  };
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    calls.push({ method, url, body });
    if (url === '/api/admin/feedback/hub') {
      if (method === 'PUT') hub.enabled = (body as { enabled: boolean }).enabled;
      return json(hub);
    }
    if (url.endsWith('/hub/preview')) return json({ url: hub.url, payload: hub.preview });
    if (url.endsWith('/hub') && method === 'POST') {
      const pending = Boolean(
        options.pending && calls.filter((call) => call.url === url && call.method === 'POST').length === 1,
      );
      Object.assign(items[0]!, {
        upstreamIssueUrl: pending ? null : 'https://github.com/adachis/riosoma/issues/42',
        upstreamPending: pending,
      });
      return json(items[0]);
    }
    if (url === '/api/admin/feedback/count')
      return json({ new: items.filter((entry) => entry.status === 'new').length });
    if (url.startsWith('/api/admin/feedback?') || url === '/api/admin/feedback')
      return json({ items, next: null });
    if (url === '/api/admin/feedback/github') {
      if (method === 'PUT') {
        const update = body as { enabled: boolean; repository: string | null; token?: string | null };
        Object.assign(github, {
          enabled: update.enabled,
          repository: update.repository,
          hasToken: update.token === undefined ? github.hasToken : update.token !== null,
        });
      }
      return json(github);
    }
    if (url.endsWith('/github/preview')) {
      const include = (body as { includeScreenshot: boolean }).includeScreenshot;
      return json({
        ...preview,
        screenshot: include
          ? { path: '.github/feedback-screenshots/fbkAAAAAAAAAAAAAA.png', bytes: 2048 }
          : null,
      });
    }
    if (url.endsWith('/github') && method === 'POST')
      return json(item({ issue: { number: 7, url: 'https://github.example.test/acme/app/issues/7#c1' } }));
    if (url.endsWith('/replies') && method === 'POST') return json(item({ status: 'seen' }));
    if (url.endsWith('/status') && method === 'PUT') return json(item({ status: 'done' }));
    if (method === 'DELETE') return new Response(null, { status: 204 });
    if (url === '/api/feedback/mine')
      return json({
        items: [
          {
            id: 'fbkAAAAAAAAAAAAAA',
            kind: 'question',
            status: 'seen',
            message: 'How do I share a view?',
            createdAt: new Date().toISOString(),
            replies: [
              {
                id: 'fbrAAAAAAAAAAAAAA',
                body: 'Choose Share at the top of the view.',
                author: { id: 'usrADAADAADAADAAD', name: 'Ada' },
                createdAt: new Date().toISOString(),
              },
            ],
          },
        ],
      } satisfies SentFeedbackList);
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return { calls };
}

afterEach(() => {
  cleanup();
  place.section = 'feedback';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the feedback inbox in Settings', () => {
  it('offers an issue refresh for pending reports and shows the eventual issue link', async () => {
    const { calls } = start({ hub: { enabled: true }, pending: true });
    renderSharing(<FeedbackInbox />);
    const first = (await screen.findByText('The grid freezes when I paste rows')).closest('li')!;
    await userEvent.click(await within(first).findByRole('button', { name: 'Send upstream' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send upstream' });
    await userEvent.click(
      await within(dialog).findByRole('checkbox', { name: /I have confirmed this is a software bug/ }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send upstream' }));
    await userEvent.click(await within(first).findByRole('button', { name: 'Refresh upstream issue' }));
    const link = await within(first).findByRole('link', { name: 'Upstream issue' });
    expect(link.getAttribute('href')).toBe('https://github.com/adachis/riosoma/issues/42');
    expect(within(first).queryByRole('button', { name: 'Refresh upstream issue' })).toBeNull();
    expect(
      calls.filter(
        (call) => call.url === '/api/admin/feedback/fbkAAAAAAAAAAAAAA/hub' && call.method === 'POST',
      ),
    ).toHaveLength(2);
  });
  it('shows upstream fields before enabling and requires software-bug confirmation before sending', async () => {
    const { calls } = start({ hub: { enabled: true } });
    renderSharing(<FeedbackInbox />);
    const first = (await screen.findByText('The grid freezes when I paste rows')).closest('li')!;
    expect(screen.getByText(/This example shows every field sent/)).toBeDefined();
    const idea = screen.getByText('Pin views').closest('li')!;
    expect(within(idea).queryByRole('button', { name: 'Send upstream' })).toBeNull();
    await userEvent.click(await within(first).findByRole('button', { name: 'Send upstream' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send upstream' });
    await within(dialog).findByText(/This is exactly what goes to the hub/);
    const sendButton = within(dialog).getByRole('button', { name: 'Send upstream' });
    expect(sendButton.hasAttribute('disabled')).toBe(true);
    expect(dialog.querySelector('pre')?.textContent).toContain('fingerprint');
    expect(dialog.querySelector('pre')?.textContent).not.toContain('screenshot');
    await userEvent.click(
      within(dialog).getByRole('checkbox', { name: /I have confirmed this is a software bug/ }),
    );
    await userEvent.click(sendButton);
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        url: '/api/admin/feedback/fbkAAAAAAAAAAAAAA/hub',
        body: { softwareBug: true },
      }),
    );
  });
  it('is for owners and feedback admins, with a count while anything is new', async () => {
    const { calls } = start();
    renderSharing(<SettingsScreen />);
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    const link = within(nav).getByRole('link', { name: /^Feedback(?! you sent)/ });
    await waitFor(() => expect(link.textContent).toBe('Feedback1 new'));
    expect(within(nav).getByRole('link', { name: 'Feedback you sent' })).toBeDefined();
    cleanup();

    calls.length = 0;
    place.section = 'my-feedback';
    renderSharing(<SettingsScreen />, member());
    const plain = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(plain).queryByRole('link', { name: /^Feedback(?! you sent)/ })).toBeNull();
    expect(within(plain).getByRole('link', { name: 'Feedback you sent' })).toBeDefined();
    await screen.findByText('Choose Share at the top of the view.');
    expect(calls.some((call) => call.url.startsWith('/api/admin/'))).toBe(false);
    cleanup();

    renderSharing(<SettingsScreen />, member(['feedback']));
    expect(
      within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('link', {
        name: /^Feedback(?! you sent)/,
      }),
    ).toBeDefined();
  });

  it('answers, marks, and deletes feedback', async () => {
    const { calls } = start();
    renderSharing(<FeedbackInbox />);
    const first = (await screen.findByText('The grid freezes when I paste rows')).closest('li')!;
    const shot = within(first).getByRole('img', { name: 'The screenshot sent with this feedback' });
    expect(shot.getAttribute('src')).toBe('/api/admin/feedback/fbkAAAAAAAAAAAAAA/screenshot');

    await userEvent.type(within(first).getByRole('textbox', { name: /Reply/ }), 'Fixed next week');
    await userEvent.click(within(first).getByRole('button', { name: 'Send reply' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        url: '/api/admin/feedback/fbkAAAAAAAAAAAAAA/replies',
        body: { body: 'Fixed next week' },
      }),
    );

    await userEvent.click(within(first).getByRole('button', { name: /Status/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Done' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PUT',
        url: '/api/admin/feedback/fbkAAAAAAAAAAAAAA/status',
        body: { status: 'done' },
      }),
    );

    await userEvent.click(within(first).getByRole('button', { name: 'Delete' }));
    const confirm = await screen
      .findByRole('alertdialog', { name: 'Delete this feedback?' })
      .catch(() => screen.findByRole('dialog', { name: 'Delete this feedback?' }));
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'DELETE',
        url: '/api/admin/feedback/fbkAAAAAAAAAAAAAA',
        body: undefined,
      }),
    );
    // Only something broken can go to GitHub, and only once that's on.
    expect(within(first).queryByRole('button', { name: 'Send to GitHub' })).toBeNull();
  });

  it('shows exactly what goes to GitHub, and adds it to a close issue as a comment', async () => {
    const { calls } = start({ github: { enabled: true, repository: 'acme/app', hasToken: true } });
    renderSharing(<FeedbackInbox />);
    const first = (await screen.findByText('The grid freezes when I paste rows')).closest('li')!;
    const idea = screen.getByText('Pin views').closest('li')!;
    expect(within(idea).queryByRole('button', { name: 'Send to GitHub' })).toBeNull();
    await userEvent.click(await within(first).findByRole('button', { name: 'Send to GitHub' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send to GitHub' });
    expect(await within(dialog).findByText(/This is exactly what’s sent to acme\/app/)).toBeDefined();
    expect(dialog.querySelector('pre')?.textContent).toBe(
      '> The grid freezes when I paste rows\n\n**Context**',
    );
    expect(calls.filter((call) => call.url.endsWith('/github/preview')).at(-1)?.body).toEqual({
      includeScreenshot: false,
    });

    await userEvent.click(within(dialog).getByRole('checkbox', { name: /Send the screenshot too/ }));
    expect(
      await within(dialog).findByText(/The screenshot is added at \.github\/feedback-screenshots/),
    ).toBeDefined();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add as a comment on #7' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        url: '/api/admin/feedback/fbkAAAAAAAAAAAAAA/github',
        body: { mode: 'comment', issueNumber: 7, includeScreenshot: true },
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Send to GitHub' })).toBeNull());
  });

  it('saves where bug reports go without ever showing the token again', async () => {
    const { calls } = start();
    renderSharing(<FeedbackInbox />);
    const form = (
      await screen.findByRole('switch', { name: 'Let admins send bug reports to GitHub' })
    ).closest('form')!;
    await userEvent.click(within(form).getByRole('switch'));
    await userEvent.type(within(form).getByRole('textbox', { name: /Repository/ }), 'acme/app');
    const token = form.querySelector<HTMLInputElement>('input[type="password"]')!;
    await userEvent.type(token, FAKE_TOKEN);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PUT',
        url: '/api/admin/feedback/github',
        body: { enabled: true, repository: 'acme/app', token: FAKE_TOKEN },
      }),
    );
    await waitFor(() => expect(token.value).toBe(''));
    expect(
      await within(form).findByText(/^A token is saved\. +Type a new one to replace it\.$/),
    ).toBeDefined();
  });

  it('only describes the choice to admins who can’t change it', async () => {
    start({ github: { enabled: true, repository: 'acme/app', hasToken: true, canChange: false } });
    renderSharing(<FeedbackInbox />, member(['feedback']));
    // Text matchers see one space between sentences, however many the page has.
    expect(
      await screen.findByText(/^Broken things can be sent to acme\/app as issues\. +Owners/),
    ).toBeDefined();
    expect(screen.queryByRole('switch', { name: 'Let admins send bug reports to GitHub' })).toBeNull();
  });
});

describe('feedback the person sent', () => {
  it('lists it with the replies', async () => {
    start();
    renderSharing(<SentFeedback />);
    expect(await screen.findByText('How do I share a view?')).toBeDefined();
    expect(screen.getByText('Choose Share at the top of the view.')).toBeDefined();
    expect(screen.getByText(/Ada replied/)).toBeDefined();
  });
});

it('keeps upstream consent in the page draft, restores it on discard, and saves it from the footer', async () => {
  const { calls } = start();
  renderSharing(<FeedbackInbox />);
  const control = await screen.findByRole('switch', { name: 'Let admins send software bugs upstream' });
  const bar = screen.getByRole('region', { name: 'Save changes' });
  expect(screen.getAllByRole('button', { name: 'Save' })).toHaveLength(1);
  await userEvent.click(control);
  expect(
    calls.filter((call) => call.url === '/api/admin/feedback/hub' && call.method === 'PUT'),
  ).toHaveLength(0);
  expect(within(bar).getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false);
  await userEvent.click(within(bar).getByRole('button', { name: 'Discard' }));
  expect(control).toHaveProperty('checked', false);
  await userEvent.click(control);
  await userEvent.click(within(bar).getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(calls).toContainEqual({ method: 'PUT', url: '/api/admin/feedback/hub', body: { enabled: true } }),
  );
  await waitFor(() =>
    expect(within(bar).getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true),
  );
});
