import type { ReactNode } from 'react';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo, UpdateRelease, UpdateStatus } from '@riosoma/contracts';
import { json, renderSharing, session } from '../../screens/database/share/testing';
import { UpdateNotice } from './UpdateNotice';
import { UpdateSettings } from './UpdateSettings';

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => null,
  Link: ({ params, children }: { params: { section: string }; children: ReactNode }) => (
    <a href={`/settings/${params.section}`}>{children}</a>
  ),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const as = (kind: SessionInfo['membership']['kind'], adminRoles: string[] = []): SessionInfo => ({
  ...session,
  membership: { kind, adminRoles },
});

const release = (version: string, extra: Partial<UpdateRelease> = {}): UpdateRelease => ({
  version,
  date: '2026-09-28',
  notes: `Faster **grids** in ${version}.`,
  security: false,
  minimumVersion: '0.1.0',
  images: { 'linux/amd64': `sha256:${'a'.repeat(64)}` },
  ...extra,
});

function updates(over: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    checks: true,
    version: '1.0.0',
    install: 'compose',
    platform: 'linux/amd64',
    feed: { status: 'ok', checkedAt: new Date().toISOString(), issuedAt: new Date().toISOString() },
    repository: 'ghcr.io/adachis/riosoma',
    available: [release('1.1.0')],
    target: release('1.1.0'),
    security: false,
    updater: { configured: false, ready: false, problem: null },
    canUpdate: false,
    run: null,
    ...over,
  };
}

function serve(status: UpdateStatus | (() => UpdateStatus)) {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({
        url,
        method: init?.method ?? 'GET',
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      return json(typeof status === 'function' ? status() : status);
    }),
  );
  return requests;
}

describe('the update notice', () => {
  it('shows nothing to people who don’t run the server, and asks for nothing', async () => {
    const requests = serve(updates());
    renderSharing(<UpdateNotice />, as('member'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('button')).toBeNull();
    expect(requests).toEqual([]);
  });

  it('is quiet for the owner and admins, with the notes and a way to settings', async () => {
    serve(updates());
    renderSharing(<UpdateNotice />, as('member', ['audit']));
    const notice = await screen.findByRole('button', { name: 'Update available: Riosoma 1.1.0' });
    expect(notice.className).not.toContain('security');
    await userEvent.setup().click(notice);
    const dialog = await screen.findByRole('dialog', { name: 'Riosoma 1.1.0 is available' });
    expect(within(dialog).getByRole('heading', { name: 'Riosoma 1.1.0' })).toBeDefined();
    expect(dialog.querySelector('strong')?.textContent).toBe('grids');
    expect(within(dialog).getByRole('link', { name: 'Open update settings' }).getAttribute('href')).toBe(
      '/settings/updates',
    );
    expect(within(dialog).getByRole('button', { name: 'About updates' })).toBeDefined();
    // Without the updater, the notice shows the steps for this kind of install.
    expect(within(dialog).getByLabelText('Commands to update').textContent).toContain(
      'docker compose pull riosoma',
    );
  });

  it('points the owner to the one-click update where the updater is ready', async () => {
    serve(updates({ updater: { configured: true, ready: true, problem: null }, canUpdate: true }));
    renderSharing(<UpdateNotice />);
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Update available: Riosoma 1.1.0' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Update in one click from the update settings.');
    expect(within(dialog).queryByLabelText('Commands to update')).toBeNull();
  });

  it('is stronger for a security release', async () => {
    serve(updates({ available: [release('1.1.0'), release('1.0.1', { security: true })], security: true }));
    renderSharing(<UpdateNotice />);
    const notice = await screen.findByRole('button', { name: 'Security update: Riosoma 1.1.0' });
    expect(notice.className).toContain('rio-update-notice--security');
    await userEvent.setup().click(notice);
    expect((await screen.findByRole('dialog')).textContent).toContain(
      'A newer release fixes a security problem.',
    );
  });

  it('shows nothing when this server runs the newest release', async () => {
    const requests = serve(updates({ available: [], target: null }));
    renderSharing(<UpdateNotice />);
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders notes without letting them become markup', async () => {
    serve(
      updates({
        available: [release('1.1.0', { notes: '<img src=x onerror=alert(1)> [x](javascript:alert(1))' })],
      }),
    );
    renderSharing(<UpdateNotice />);
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Update available: Riosoma 1.1.0' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.querySelector('img')).toBeNull();
    expect(
      [...dialog.querySelectorAll('a')].some((link) => link.getAttribute('href')?.startsWith('javascript')),
    ).toBe(false);
    expect(dialog.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('update settings', () => {
  it('say why no notice can show, and don’t offer a check that can’t happen', async () => {
    serve(
      updates({ feed: { status: 'noKeys', checkedAt: null, issuedAt: null }, available: [], target: null }),
    );
    renderSharing(<UpdateSettings />);
    expect(await screen.findByText(/no key to verify the update feed with/)).toBeDefined();
    expect((screen.getByRole('button', { name: 'Check now' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('show the exact steps for an install the updater doesn’t run, pulling by the signed digest', async () => {
    serve(updates({ install: 'helm' }));
    renderSharing(<UpdateSettings />);
    const commands = await screen.findByLabelText('Commands to update');
    expect(commands.textContent).toContain(
      `--set image.tag=1.1.0 --set image.digest=sha256:${'a'.repeat(64)}`,
    );
    expect(screen.queryByRole('button', { name: 'Update to 1.1.0' })).toBeNull();
    expect(screen.getByText(/installed with the Helm chart/)).toBeDefined();
    cleanup();
    for (const [install, expected] of [
      ['docker', `docker pull ghcr.io/adachis/riosoma:1.1.0@sha256:${'a'.repeat(64)}`],
      ['kubernetes', `riosoma=ghcr.io/adachis/riosoma:1.1.0@sha256:${'a'.repeat(64)}`],
      ['container-apps', `--image ghcr.io/adachis/riosoma:1.1.0@sha256:${'a'.repeat(64)}`],
      ['ecs', `|ghcr.io/adachis/riosoma:1.1.0@sha256:${'a'.repeat(64)}|`],
      [
        'cloud-run',
        `docker pull --platform linux/amd64 ghcr.io/adachis/riosoma:1.1.0@sha256:${'a'.repeat(64)}`,
      ],
    ] as const) {
      serve(updates({ install }));
      renderSharing(<UpdateSettings />);
      expect((await screen.findByLabelText('Commands to update')).textContent).toContain(expected);
      cleanup();
    }
  });

  it('pull by tag, and say so, where the feed names no image for this platform', async () => {
    serve(updates({ install: 'docker', platform: null }));
    renderSharing(<UpdateSettings />);
    const commands = await screen.findByLabelText('Commands to update');
    // The connector service's image goes by the release's tag too.
    expect(commands.textContent).toBe(
      'docker pull ghcr.io/adachis/riosoma:1.1.0\ndocker pull ghcr.io/adachis/riosoma-connectors:1.1.0',
    );
    expect(screen.getByText(/pull the release by its tag/)).toBeDefined();
  });

  it('point a Compose install without the updater at it, beside the steps', async () => {
    serve(updates());
    renderSharing(<UpdateSettings />);
    expect(await screen.findByText(/Turn on the updater profile/)).toBeDefined();
    expect((await screen.findByLabelText('Commands to update')).textContent).toContain(
      `RIOSOMA_IMAGE=ghcr.io/adachis/riosoma:1.1.0@sha256:${'a'.repeat(64)}`,
    );
  });

  it('show the steps instead of the button when the updater is older than Riosoma', async () => {
    serve(updates({ updater: { configured: true, ready: false, problem: 'outdated' } }));
    renderSharing(<UpdateSettings />);
    expect(await screen.findByText(/The updater runs an older release than Riosoma/)).toBeDefined();
    expect(screen.getByLabelText('Commands to update').textContent).toContain('docker compose up -d');
    expect(screen.queryByRole('button', { name: 'Update to 1.1.0' })).toBeNull();
  });

  it('update in one click for the owner, after confirming, and follow the run', async () => {
    let current = updates({ updater: { configured: true, ready: true, problem: null }, canUpdate: true });
    const requests = serve(() => current);
    renderSharing(<UpdateSettings />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Update to 1.1.0' }));
    current = updates({
      updater: { configured: true, ready: false, problem: 'busy' },
      run: {
        id: 'run',
        fromVersion: '1.0.0',
        toVersion: '1.1.0',
        state: 'backing_up',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        backup: null,
        problem: null,
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Update now' }));
    await waitFor(() =>
      expect(requests.find((item) => item.method === 'POST')).toEqual({
        url: '/api/admin/updates/apply',
        method: 'POST',
        body: { version: '1.1.0' },
      }),
    );
    expect(await screen.findByRole('progressbar', { name: 'Updating to 1.1.0' })).toBeDefined();
    expect(screen.getByRole('status').textContent).toBe('Backing up the database');
  });

  it('say what happened when an update was rolled back', async () => {
    serve(
      updates({
        run: {
          id: 'run',
          fromVersion: '1.0.0',
          toVersion: '1.1.0',
          state: 'rolled_back',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          backup: 'riosoma-20261001T000000Z.dump',
          problem: 'health',
        },
      }),
    );
    renderSharing(<UpdateSettings />);
    const banner = await screen.findByText(/was rolled back/);
    expect(banner.closest('[data-variant]')?.textContent).toContain(
      'didn’t answer that it was running in time',
    );
    expect(banner.closest('[data-variant]')?.textContent).toContain('riosoma-20261001T000000Z.dump');
  });

  it('are for the owner and admins only', () => {
    serve(updates());
    renderSharing(<UpdateSettings />, as('member'));
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
  });
});
