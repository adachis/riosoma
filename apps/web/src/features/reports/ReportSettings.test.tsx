import { renderSettings as renderSharing } from '../../screens/settings/testing';
import type { ReactNode } from 'react';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MyReports, ReportPolicy, ReportSchedule } from '@riosoma/contracts';
import { toastQueue, ToastRegion } from '@riosoma/ui';
import { json, session } from '../../screens/database/share/testing';
import { SettingsScreen } from '../../screens/settings/SettingsScreen';
import { ReportSettings } from './ReportSettings';

const navigate = vi.fn();
vi.mock('../../screens/settings/AppearanceSettings', () => ({ AppearanceSettings: () => null }));
vi.mock('../../screens/settings/LanguageSettings', () => ({ LanguageSettings: () => null }));
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => undefined,
  useLocation: () => ({ pathname: '/settings/reports', href: '/settings/reports' }),
  useNavigate: () => navigate,
  useParams: () => ({ section: 'reports' }),
  Link: ({ params, children }: { params: { section: string }; children: ReactNode }) => (
    <a href={`/settings/${params.section}`}>{children}</a>
  ),
}));

function report(overrides: Partial<ReportSchedule>): ReportSchedule {
  return {
    id: 'rptAAAAAAAAAAAAAA',
    databaseId: 'dbAAAAAAAAAAAAAA',
    tableId: 'tblAAAAAAAAAAAAAA',
    viewId: 'viwAAAAAAAAAAAAAA',
    databaseName: 'Sales',
    tableName: 'Deals',
    viewName: 'Open deals',
    name: 'Monday pipeline',
    format: 'csv',
    frequency: { kind: 'daily', at: '08:00' },
    timeZone: 'Europe/Paris',
    enabled: true,
    recipients: [],
    owner: { id: session.user.id, name: 'Ada' },
    nextRunAt: null,
    lastRunAt: null,
    stoppedBecause: null,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    canEdit: true,
    canDelete: true,
    receiving: false,
    ...overrides,
  };
}

function start(options: { policy?: boolean } = {}) {
  const state: MyReports = {
    owned: [report({ enabled: false, stoppedBecause: 'reports.stopped.ownerLostAccess' })],
    receiving: [
      report({
        id: 'rptBBBBBBBBBBBBBB',
        name: 'Team digest',
        owner: { id: 'usrSAMSAMSAMSAMSA', name: 'Sam' },
        frequency: { kind: 'weekly', days: [5], at: '16:30' },
        format: 'xlsx',
        canEdit: false,
        canDelete: false,
        receiving: true,
      }),
    ],
  };
  const policy: ReportPolicy = { outsideRecipients: options.policy ?? false };
  const sent: Array<{ method: string; url: string; body: unknown }> = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    sent.push({ method, url, body });
    if (url === '/api/reports' && method === 'GET') return json(state);
    if (url === '/api/reports/rptBBBBBBBBBBBBBB/leave' && method === 'POST') {
      state.receiving = [];
      return new Response(null, { status: 204 });
    }
    if (url === '/api/admin/reports/policy') {
      if (method === 'PUT') policy.outsideRecipients = (body as ReportPolicy).outsideRecipients;
      return json(policy);
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return { sent, policy };
}

afterEach(() => {
  cleanup();
  for (const toast of toastQueue.visibleToasts) toastQueue.close(toast.key);
  navigate.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ReportSettings', () => {
  it('lists the reports the person set up and receives, and stops one they receive', async () => {
    const { sent } = start();
    renderSharing(
      <>
        <ReportSettings />
        <ToastRegion />
      </>,
      { ...session, membership: { kind: 'member', adminRoles: [] } },
    );
    const owned = await screen.findByRole('region', { name: 'Reports you set up' });
    expect(owned.textContent).toContain('Monday pipeline');
    expect(owned.textContent).toContain('Every day at 8:00 AM');
    expect(owned.textContent).toContain('(Europe/Paris)');
    expect(owned.textContent).toContain(
      'Turned itself off. The person who set it up can no longer open its database.',
    );
    const place = within(owned).getByRole('link', { name: 'Open deals in Deals, Sales' });
    expect(place.getAttribute('href')).toBe('/dbAAAAAAAAAAAAAA/tblAAAAAAAAAAAAAA/viwAAAAAAAAAAAAAA');
    await userEvent.click(place);
    expect(navigate).toHaveBeenCalledWith({ to: '/dbAAAAAAAAAAAAAA/tblAAAAAAAAAAAAAA/viwAAAAAAAAAAAAAA' });

    const receiving = screen.getByRole('region', { name: 'Reports you receive' });
    expect(receiving.textContent).toContain('Every Friday at 4:30 PM');
    expect(receiving.textContent).toContain('Excel workbook');
    await userEvent.click(within(receiving).getByRole('button', { name: 'Stop receiving Team digest' }));
    expect(await screen.findByText('You won’t get Team digest anymore')).toBeDefined();
    expect(within(receiving).getByText('Nobody else sends you a report.')).toBeDefined();
    expect(sent.filter((request) => request.method === 'POST').map((request) => request.url)).toEqual([
      '/api/reports/rptBBBBBBBBBBBBBB/leave',
    ]);
    // Only owners and security admins decide whether reports leave the organization.
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('lets an owner allow reports to addresses outside the organization', async () => {
    const { policy } = start();
    renderSharing(<ReportSettings />);
    const outside = await screen.findByRole('switch', {
      name: 'Let scheduled reports go to addresses outside the organization',
    });
    expect((outside as HTMLInputElement).checked).toBe(false);
    await userEvent.click(outside);
    expect(policy.outsideRecipients).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(policy.outsideRecipients).toBe(true));
    await waitFor(() => expect((outside as HTMLInputElement).checked).toBe(true));
  });

  it('is a section of settings for everyone', async () => {
    start();
    renderSharing(<SettingsScreen />, { ...session, membership: { kind: 'member', adminRoles: [] } });
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(nav).getByRole('link', { name: 'Scheduled reports' }).getAttribute('href')).toBe(
      '/settings/reports',
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Scheduled reports' })).toBeDefined();
    expect(await screen.findByRole('region', { name: 'Reports you set up' })).toBeDefined();
  });
});
