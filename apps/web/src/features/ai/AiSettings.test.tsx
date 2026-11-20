import { renderSettings as renderSharing } from '../../screens/settings/testing';
import { KnowledgeSettings } from '@riosoma/contracts';
import type { ReactNode } from 'react';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminRoutine, AiFootprintReport, AiSettingsView, SessionInfo } from '@riosoma/contracts';
import { AiSettings } from './AiSettings';
import { SettingsScreen } from '../../screens/settings/SettingsScreen';
import { settingsRegistry } from '../../screens/settings/registry';
import { failure, json, session } from '../../screens/database/share/testing';

vi.mock('../../screens/settings/AppearanceSettings', () => ({ AppearanceSettings: () => null }));
vi.mock('../../screens/settings/LanguageSettings', () => ({ LanguageSettings: () => null }));
const navigation = vi.hoisted(() => ({
  block: vi.fn(),
  navigate: vi.fn(({ href }: { href: string }) => {
    window.history.pushState(null, '', href);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }),
}));

vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({ pathname: '/settings/ai', href: '/settings/ai' }),
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
  useParams: () => ({ section: 'ai' }),
  useRouter: () => ({
    navigate: navigation.navigate,
    history: {
      block: navigation.block,
      push: (path: string) => {
        window.history.pushState(null, '', path);
        window.dispatchEvent(new PopStateEvent('popstate'));
      },
      subscribe: (listener: () => void) => {
        window.addEventListener('popstate', listener);
        return () => window.removeEventListener('popstate', listener);
      },
      get location() {
        return { search: window.location.search };
      },
    },
  }),
  Link: ({ params, children }: { params: { section: string }; children: ReactNode }) => (
    <a href={`/settings/${params.section}`}>{children}</a>
  ),
}));

const initial: AiSettingsView = {
  revision: 'a'.repeat(64),
  settings: {
    enabled: false,
    providers: [],
    models: { everyday: null, power: null },
    autonomy: 'previewBig',
    monthlyBudgetUsd: null,
    ingest: false,
    ingestFileLimitUsd: 1,
    ingestBuildLimitUsd: 10,
    aiFields: true,
    automationDiagnose: true,
    automationAi: true,
    automationRunLimitUsd: 1,
    electricityZone: null,
    routines: true,
    routineRunLimitUsd: 1,
  },
  providers: [
    {
      providerId: 'remote',
      name: 'Remote service',
      hasKey: true,
      keyFromEnvironment: false,
      local: false,
      models: [
        {
          model: 'small',
          name: 'Small',
          tiers: ['everyday'],
          priceKnown: true,
          footprint: { leaves: 3, energyWh: { min: 0.031, max: 0.08 }, outputTokens: 500 },
        },
        {
          model: 'large',
          name: 'Large',
          tiers: ['power'],
          priceKnown: true,
          footprint: { leaves: 1, energyWh: { min: 5.7, max: 14 }, outputTokens: 500 },
        },
      ],
    },
    {
      providerId: 'local',
      name: 'Local service',
      hasKey: true,
      keyFromEnvironment: true,
      local: true,
      models: [
        { model: 'both', name: 'Both', tiers: ['everyday', 'power'], priceKnown: false, footprint: null },
      ],
    },
    {
      providerId: 'empty',
      name: 'Another service',
      hasKey: false,
      keyFromEnvironment: false,
      local: false,
      models: [],
    },
  ],
  spentThisMonthUsd: 12.5,
};
const totals = (
  calls: number,
  estimated: number,
  priced: number,
  costUsd: number,
  wh: number,
  g: number,
) => ({
  calls,
  estimatedCalls: estimated,
  pricedCalls: priced,
  costUsd,
  energyWh: { min: wh, max: wh * 2.5 },
  gwpG: { min: g, max: g * 2.5 },
});
const report: AiFootprintReport = {
  method: 'EcoLogits 0.11.1',
  zone: { effective: 'WOR', server: 'WOR', organization: null },
  zones: ['WOR', 'EEE', 'FRA', 'USA'],
  months: [
    { month: '2026-09-01', ...totals(12, 10, 12, 0.42, 1.2, 0.52) },
    { month: '2026-08-01', ...totals(3, 3, 0, 0, 0.2, 0.1) },
  ],
  byFeature: [
    { month: '2026-09-01', feature: 'rio', ...totals(9, 9, 9, 0.3, 1, 0.4) },
    { month: '2026-09-01', feature: 'aiFields', ...totals(3, 1, 3, 0.12, 0.2, 0.12) },
    { month: '2026-08-01', feature: 'diagnose', ...totals(3, 3, 0, 0, 0.2, 0.1) },
  ],
  byModel: [
    { month: '2026-09-01', providerId: 'remote', model: 'small', ...totals(10, 10, 10, 0.4, 1.2, 0.52) },
    { month: '2026-09-01', providerId: 'local', model: 'both', ...totals(2, 0, 2, 0.02, 0, 0) },
    { month: '2026-08-01', providerId: 'remote', model: 'large', ...totals(3, 3, 0, 0, 0.2, 0.1) },
  ],
};
const clients: Array<() => void> = [];
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/settings/ai');
  navigation.block.mockReset();
  navigation.navigate.mockClear();
  clients.splice(0).forEach((close) => close());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
/** Routines as the admin list shows them: one in a database the admin can open, and one they can't */
const routines: AdminRoutine[] = [
  {
    id: 'rtnAAAAAAAAAAAAAA',
    databaseId: 'dbAAAAAAAAAAAAAA',
    databaseName: 'Sales',
    name: 'Lead summary',
    owner: { id: 'usrMORGANMORGANMO', name: 'Morgan' },
    paused: false,
    adminPaused: false,
    pausedBecause: null,
    failures: 0,
    nextRunAt: null,
    lastRun: null,
    waiting: 0,
    details: {
      instructions: 'Summarize new leads every Monday.',
      plan: {
        summary: 'Summarize new leads.',
        steps: ['Summarize'],
        reads: [],
        writes: [],
        sends: [],
        fetches: [{ tableId: 'tblLEADSLEADSLEAD', fieldId: 'fldWEBSITEWEBSITE' }],
      },
      schedule: { kind: 'daily', at: '09:00' },
      timeZone: 'UTC',
      costCapUsd: 0.25,
      approvedRecipients: [],
      approvedSites: ['https://acme.example.com', 'https://bolt.example.com'],
    },
  },
  {
    id: 'rtnBBBBBBBBBBBBBB',
    databaseId: 'dbBBBBBBBBBBBBBB',
    databaseName: 'Payroll',
    name: 'Friday list',
    owner: { id: 'usrMORGANMORGANMO', name: 'Morgan' },
    paused: true,
    adminPaused: true,
    pausedBecause: 'routines.paused.admin',
    failures: 0,
    nextRunAt: null,
    lastRun: null,
    waiting: 0,
    details: null,
  },
];
const paused: string[] = [];

function start(identity: SessionInfo = session, navigation = false, initialView = initial) {
  let view = structuredClone(initialView);
  const footprint = structuredClone(report);
  let testFailure = false;
  let testRefusal = false;
  let testUnverified = false;
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/ai/footprint') return json(footprint);
    if (url === '/api/ai/settings' && options?.method === 'PUT') {
      const body = JSON.parse(options.body as string) as Partial<AiSettingsView['settings']>;
      if ('electricityZone' in body) {
        footprint.zone.organization = body.electricityZone ?? null;
        footprint.zone.effective = body.electricityZone ?? footprint.zone.server;
      }
    }
    if (url === '/api/ai/settings') {
      // The server keeps what a partial update leaves out.
      if (options?.method === 'PUT') {
        const body = JSON.parse(options.body as string);
        view.providers = view.providers.map((provider) =>
          body.keys?.[provider.providerId] ? { ...provider, hasKey: true } : provider,
        );
        for (const change of body.gatewayChanges ?? []) {
          view.settings.gateways = [
            ...(view.settings.gateways ?? []).filter(
              (gateway) => gateway.providerId !== change.gateway.providerId,
            ),
            change.gateway,
          ];
        }
        view.settings.gateways = view.settings.gateways?.filter(
          (gateway) => !body.removedGatewayIds?.includes(gateway.providerId),
        );
        delete body.gatewayChanges;
        delete body.removedGatewayIds;
        delete body.keys;
        delete body.expectedRevision;
        view = {
          ...view,
          settings: {
            ...view.settings,
            ...body,
          },
        };
      }
      return json(view);
    }
    if (url.startsWith('/api/ai/keys/')) {
      const providerId = url.split('/').at(-1);
      view.providers = view.providers.map((provider) =>
        provider.providerId === providerId ? { ...provider, hasKey: options?.method === 'PUT' } : provider,
      );
      return new Response(null, { status: 204 });
    }
    if (url === '/api/knowledge/libraries' || url === '/api/org/units') return json([]);
    if (url === '/api/admin/remote-tools') return json([]);
    if (url === '/api/knowledge/settings') return json(KnowledgeSettings.parse({}));
    if (url === '/api/ai/test')
      return testFailure
        ? failure('errors.internal', 500)
        : json({
            success: !testRefusal && !testUnverified,
            messageKey: testUnverified ? 'ai.test.unverified' : 'ai.provider.badRequest',
          });
    if (url === '/api/admin/routines') return json(routines);
    if (url.startsWith('/api/admin/routines/') && options?.method === 'DELETE') {
      paused.push(`${url.split('/').at(-1)!}:delete`);
      return new Response(null, { status: 204 });
    }
    if (url.startsWith('/api/admin/routines/')) {
      paused.push(`${url.split('/').at(-2)!}:${url.split('/').at(-1)!}`);
      return json({
        ...routines[0],
        paused: true,
        adminPaused: true,
        pausedBecause: 'routines.paused.admin',
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  const rendered = renderSharing(navigation ? <SettingsScreen /> : <AiSettings />, identity);
  clients.push(() => rendered.client.clear());
  return {
    ...rendered,
    fetcher,
    user: userEvent.setup(),
    failTest: () => {
      testFailure = true;
    },
    refuseTest: () => {
      testRefusal = true;
    },
    unverifiedTest: () => {
      testUnverified = true;
    },
  };
}

async function choose(user: ReturnType<typeof userEvent.setup>, label: RegExp, option: string) {
  await user.click(screen.getByRole('button', { name: label }));
  await user.click(
    await screen.findByRole('option', {
      name: (accessibleName) => accessibleName === option || accessibleName.startsWith(`${option} `),
    }),
  );
}

describe('AI settings', () => {
  it('saves ingest consent and both ceilings beside the monthly budget', async () => {
    const app = start();
    const ingest = await screen.findByRole('switch', { name: 'Turn on AI ingest' });
    expect((ingest as HTMLInputElement).checked).toBe(false);
    await app.user.click(ingest);
    const fileLimit = screen.getByRole('textbox', { name: 'Most ingest may spend per file (US dollars)' });
    const buildLimit = screen.getByRole('textbox', { name: 'Most ingest may spend per build (US dollars)' });
    await app.user.clear(fileLimit);
    await app.user.type(fileLimit, '2.5');
    await app.user.clear(buildLimit);
    await app.user.type(buildLimit, '25');
    await app.user.click(screen.getByRole('button', { name: 'Save' }));
    const puts = () =>
      app.fetcher.mock.calls.filter(([url, init]) => url === '/api/ai/settings' && init?.method === 'PUT');
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(JSON.parse(puts()[0]![1]!.body as string)).toMatchObject({
      ingest: true,
      ingestFileLimitUsd: 2.5,
      ingestBuildLimitUsd: 25,
    });
    await waitFor(() =>
      expect(
        (
          screen.getByRole('textbox', {
            name: 'Most ingest may spend per file (US dollars)',
          }) as HTMLInputElement
        ).value,
      ).toBe('2.5'),
    );
    expect(
      settingsRegistry.some((setting) => setting.page === 'ai' && setting.id === 'ingest-file-limit'),
    ).toBe(true);
    expect(
      settingsRegistry.some((setting) => setting.page === 'ai' && setting.id === 'ingest-build-limit'),
    ).toBe(true);
  });

  it.each([
    ['Most ingest may spend per file (US dollars)', '-1'],
    ['Most ingest may spend per build (US dollars)', '1000001'],
    ['Most ingest may spend per file (US dollars)', ''],
  ])('refuses an invalid ingest ceiling for %s', async (label, value) => {
    const app = start();
    const limit = await screen.findByRole('textbox', { name: label });
    await app.user.clear(limit);
    if (value) await app.user.type(limit, value);
    await app.user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findAllByText('Enter an amount from $0 to $1,000,000.')).not.toHaveLength(0);
    expect(
      app.fetcher.mock.calls.filter(([url, init]) => url === '/api/ai/settings' && init?.method === 'PUT'),
    ).toHaveLength(0);
  });

  it('keeps the month destination available before the first usage report', async () => {
    const app = start();
    await screen.findByRole('combobox', { name: 'Electricity zone' });
    act(() => app.client.setQueryData(['ai', 'footprint', 'report'], { ...report, months: [] }));
    const empty = await screen.findByText('No AI use yet.');
    expect(empty.closest<HTMLElement>('[data-setting-id]')?.dataset.settingId).toBe('footprint-month');
  });

  it('renders distinct registered model targets and registers the imported electricity zone', async () => {
    const app = start();
    for (const [label, id, role] of [
      ['Quick answers', 'everyday', 'button'],
      ['Thorough work', 'power', 'button'],
      ['Electricity zone', 'electricity-zone', 'combobox'],
    ] as const) {
      const control = await screen.findByRole(role, { name: new RegExp(label) });
      const target = control.closest<HTMLElement>('[data-setting-id]');
      expect(target?.dataset.settingId).toBe(id);
      expect(
        app.container.querySelectorAll(`[data-setting-page="ai"][data-setting-id="${id}"]`),
      ).toHaveLength(1);
      expect(settingsRegistry.some((setting) => setting.page === 'ai' && setting.id === id)).toBe(true);
    }
  });

  it('explains stored keys beside consent switches and keeps Rio off until consent is saved', async () => {
    const app = start();
    const remote = await screen.findByRole('region', { name: 'Remote service' });
    expect(within(remote).getByText('Turn on Remote service so Rio can use it')).toBeDefined();
    expect(
      within(screen.getByRole('region', { name: 'Local service' })).getByText(
        'Turn on Local service so Rio can use it',
      ),
    ).toBeDefined();
    const other = screen.getByRole('region', { name: 'Another service' });
    expect(within(other).queryByText('Turn on Another service so Rio can use it')).toBeNull();
    expect(screen.queryByText(/Rio stays off until/)).toBeNull();
    await app.user.click(screen.getByRole('switch', { name: 'Turn on AI' }));
    await screen.findByText('Rio stays off until you turn on a provider and save settings.');
    await app.user.type(within(other).getByLabelText('API key'), crypto.randomUUID());
    await app.user.click(screen.getByRole('button', { name: 'Save' }));
    await within(other).findByText('Turn on Another service so Rio can use it');
    expect((within(other).getByRole('switch') as HTMLInputElement).checked).toBe(false);
    await app.user.click(within(remote).getByRole('switch'));
    expect(within(remote).queryByText('Turn on Remote service so Rio can use it')).toBeNull();
    expect(screen.queryByText(/Rio stays off until/)).toBeNull();
    await app.user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByText(/Rio stays off until/)).toBeNull());
  });

  it('keeps edits after canceling a tab change and discards them only after confirming', async () => {
    const app = start();
    const budget = await screen.findByRole('textbox', { name: 'Monthly budget (US dollars)' });
    await app.user.type(budget, '15');
    await app.user.click(screen.getByRole('button', { name: 'Tools' }));
    const prompt = await screen.findByRole('dialog', { name: 'You have unsaved changes on this page.' });
    await app.user.click(within(prompt).getByRole('button', { name: 'Keep editing' }));
    expect((budget as HTMLInputElement).value).toBe('15');
    expect(window.location.search).toBe('');
    await app.user.click(screen.getByRole('button', { name: 'Tools' }));
    await app.user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Discard and continue' }),
    );
    await waitFor(() => expect(window.location.search).toBe('?tab=tools'));
    expect(screen.queryByRole('switch', { name: 'Turn on AI' })).toBeNull();
    await app.user.click(screen.getByRole('button', { name: 'General' }));
    expect(
      ((await screen.findByRole('textbox', { name: 'Monthly budget (US dollars)' })) as HTMLInputElement)
        .value,
    ).toBe('');
  });

  it('returns a Tools deep link to the General path without leaving the Tools suffix', async () => {
    const app = start();
    await screen.findByRole('textbox', { name: 'Monthly budget (US dollars)' });
    window.history.replaceState({}, '', '/admin/connections/ai/remote-tools?server=selected');
    await app.user.click(screen.getByRole('button', { name: 'General' }));
    await waitFor(() => expect(window.location.pathname).toBe('/admin/connections/ai'));
    expect(window.location.search).toBe('');
  });

  it('blocks leaving through the router, including Back, and allows leaving after saving', async () => {
    const app = start();
    await app.user.type(await screen.findByRole('textbox', { name: 'Monthly budget (US dollars)' }), '20');
    const leave = () =>
      navigation.block.mock.lastCall![0].blockerFn({
        currentLocation: { pathname: '/settings/ai', search: '' },
        nextLocation: { pathname: '/', search: '' },
        action: 'BACK',
      }) as Promise<boolean>;
    expect(navigation.block.mock.lastCall![0].enableBeforeUnload).toBe(false);
    let blocked!: Promise<boolean>;
    await act(async () => {
      blocked = leave();
    });
    await app.user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Keep editing' }),
    );
    expect(await blocked).toBe(true);
    await act(async () => {
      blocked = leave();
    });
    await app.user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Discard and continue' }),
    );
    expect(await blocked).toBe(false);
    await app.user.type(screen.getByRole('textbox', { name: 'Monthly budget (US dollars)' }), '21');
    await app.user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true),
    );
    expect(await leave()).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each([
    'Help with knowledge',
    'Help with document imports',
    'Help with web search',
    'Help with embeddings',
  ])('opens %s through the router and preserves unsaved settings', async (name) => {
    const app = start();
    const budget = await screen.findByRole('textbox', { name: 'Monthly budget (US dollars)' });
    await app.user.type(budget, '23');
    const link = await screen.findByRole('link', { name });
    const destination = new URL(link.getAttribute('href')!, window.location.href);
    if (name === 'Help with knowledge') {
      link.focus();
      await app.user.keyboard('{Enter}');
    } else await app.user.click(link);
    expect(navigation.navigate).toHaveBeenCalledWith({
      href: `${destination.pathname}${destination.search}${destination.hash}`,
    });
    expect(window.location.search).toBe(destination.search);
    expect((budget as HTMLInputElement).value).toBe('23');
    expect(screen.queryByRole('dialog')).toBeNull();
    await app.user.click(screen.getByRole('button', { name: 'Tools' }));
    expect(
      await screen.findByRole('dialog', { name: 'You have unsaved changes on this page.' }),
    ).toBeDefined();
  });

  it('asks before a document link leaves and navigates only after confirmation', async () => {
    const app = start();
    const budget = await screen.findByRole('textbox', { name: 'Monthly budget (US dollars)' });
    await app.user.type(budget, '24');
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    const nativeConfirm = vi.fn(() => true);
    vi.stubGlobal('confirm', nativeConfirm);
    const link = document.createElement('a');
    link.href = '/-/docs/remote-tools';
    document.body.append(link);
    try {
      await app.user.click(link);
      const prompt = await screen.findByRole('dialog', { name: 'You have unsaved changes on this page.' });
      expect(assign).not.toHaveBeenCalled();
      await app.user.click(within(prompt).getByRole('button', { name: 'Keep editing' }));
      expect((budget as HTMLInputElement).value).toBe('24');
      expect(assign).not.toHaveBeenCalled();
      await app.user.click(link);
      await app.user.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: 'Discard and continue' }),
      );
      expect(assign).toHaveBeenCalledExactlyOnceWith(link.href);
      expect(nativeConfirm).not.toHaveBeenCalled();
    } finally {
      link.remove();
    }
  });

  it('preserves downloads, modified clicks, and new-tab links while settings are unsaved', async () => {
    const app = start();
    await app.user.type(await screen.findByRole('textbox', { name: 'Monthly budget (US dollars)' }), '25');
    const link = document.createElement('a');
    link.href = '/-/docs/remote-tools';
    document.body.append(link);
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    try {
      for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey']) {
        const click = new MouseEvent('click', { bubbles: true, cancelable: true, [modifier]: true });
        link.dispatchEvent(click);
        expect(click.defaultPrevented).toBe(false);
      }
      for (const [attribute, value] of [
        ['download', ''],
        ['target', '_blank'],
      ]) {
        link.setAttribute(attribute!, value!);
        const click = new MouseEvent('click', { bubbles: true, cancelable: true });
        link.dispatchEvent(click);
        expect(click.defaultPrevented).toBe(false);
        link.removeAttribute(attribute!);
      }
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(assign).not.toHaveBeenCalled();
      expect(navigation.navigate).not.toHaveBeenCalled();
    } finally {
      link.remove();
    }
  });

  it('does not prompt for saved keys, the saved switch, or reverted form changes', async () => {
    const app = start();
    const enabled = await screen.findByRole('switch', { name: 'Turn on AI' });
    await app.user.click(enabled);
    const other = screen.getByRole('region', { name: 'Another service' });
    await app.user.type(within(other).getByLabelText('API key'), crypto.randomUUID());
    await app.user.click(screen.getByRole('button', { name: 'Save' }));
    await within(other).findByText('Stored');
    await app.user.click(screen.getByRole('switch', { name: 'Remote service' }));
    await app.user.click(screen.getByRole('switch', { name: 'Remote service' }));
    await app.user.click(screen.getByRole('button', { name: 'Tools' }));
    await waitFor(() => expect(window.location.search).toBe('?tab=tools'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each([
    ['Monthly budget (US dollars)', '-1', 'Enter a monthly budget from $0 to $1,000,000, or leave it blank.'],
    [
      'Most one routine run may spend (US dollars)',
      '0',
      'Enter an amount from $0.01 to $100 for each run limit.',
    ],
    [
      'Most one automation run may spend (US dollars)',
      '101',
      'Enter an amount from $0.01 to $100 for each run limit.',
    ],
  ])('refuses saving and focuses the invalid %s', async (label, value, note) => {
    const app = start();
    const input = await screen.findByRole('textbox', { name: label });
    await app.user.clear(input);
    await app.user.type(input, value);
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save.hasAttribute('disabled')).toBe(false);
    await app.user.click(save);
    expect(within(screen.getByRole('region', { name: 'Save changes' })).getByRole('status').textContent).toBe(
      note,
    );
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(app.fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
  });

  it('stages the master switch and disables both bar actions while saving', async () => {
    const app = start();
    const enabled = await screen.findByRole('switch', { name: 'Turn on AI' });
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const fetch = app.fetcher.getMockImplementation()!;
    app.fetcher.mockImplementation(async (url, options) => {
      if (url === '/api/ai/settings' && options?.method === 'PUT') await pending;
      return fetch(url, options);
    });
    const bar = within(screen.getByRole('region', { name: 'Save changes' }));
    try {
      await app.user.click(enabled);
      expect(app.fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
      expect(bar.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false);
      await app.user.click(bar.getByRole('button', { name: 'Save' }));
      expect(bar.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
      expect(bar.getByRole('button', { name: 'Discard' }).hasAttribute('disabled')).toBe(true);
      expect(bar.getByRole('status').textContent).toBe('Saving changes…');
      finish();
      await waitFor(() => expect(bar.getByRole('status').textContent).toBe('No unsaved changes'));
    } finally {
      finish();
    }
  });
  it.each([
    { kind: 'owner' as const, adminRoles: [], allowed: true },
    { kind: 'member' as const, adminRoles: ['ai'], allowed: true },
    { kind: 'member' as const, adminRoles: ['people'], allowed: false },
    { kind: 'guest' as const, adminRoles: [], allowed: false },
  ])(
    'gates navigation and direct visits for $kind with $adminRoles',
    async ({ kind, adminRoles, allowed }) => {
      const app = start({ ...session, membership: { kind, adminRoles } }, true);
      expect(Boolean(within(screen.getByRole('navigation')).queryByRole('link', { name: 'AI' }))).toBe(
        allowed,
      );
      if (allowed) await screen.findByRole('switch', { name: 'Turn on AI' });
      else {
        expect(screen.getByRole('alert')).toBeDefined();
        expect(screen.queryByRole('switch')).toBeNull();
        expect(app.fetcher).not.toHaveBeenCalled();
      }
    },
  );

  it('saves enabled providers, tier models, autonomy, AI fields, Diagnose, and budget with the month’s estimated spend', async () => {
    const app = start();
    await app.user.click(await screen.findByRole('switch', { name: 'Turn on AI' }));
    await app.user.click(screen.getByRole('switch', { name: 'Let AI fields run' }));
    await app.user.click(screen.getByRole('switch', { name: 'Let automation AI steps run' }));
    const automationLimit = screen.getByRole('textbox', {
      name: 'Most one automation run may spend (US dollars)',
    });
    await app.user.clear(automationLimit);
    await app.user.type(automationLimit, '0.25');
    await app.user.click(screen.getByRole('switch', { name: 'Let Rio diagnose automation runs' }));
    await app.user.click(screen.getByRole('switch', { name: 'Remote service' }));
    await choose(app.user, /Quick answers/, 'Remote service · Small');
    await choose(app.user, /Thorough work/, 'Remote service · Large');
    await choose(app.user, /What Rio may do without asking/, 'Ask before every change');
    await app.user.click(screen.getByRole('switch', { name: 'Let people set up routines' }));
    const limit = screen.getByRole('textbox', { name: 'Most one routine run may spend (US dollars)' });
    await app.user.clear(limit);
    await app.user.type(limit, '0.5');
    await app.user.type(screen.getByRole('textbox', { name: 'Monthly budget (US dollars)' }), '25.50');
    expect(screen.getByText('About $12.50 spent this month')).toBeDefined();
    const save = screen.getByRole('button', { name: 'Save' });
    await app.user.click(save);
    const puts = () =>
      app.fetcher.mock.calls
        .filter(([url, init]) => url === '/api/ai/settings' && init?.method === 'PUT')
        .map(([, init]) => JSON.parse(init!.body as string) as Record<string, unknown>);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]).toEqual({
      expectedRevision: initial.revision,
      gatewayChanges: [],
      removedGatewayIds: [],
      enabled: true,
      keys: {},
      providers: [{ providerId: 'remote' }],
      models: {
        everyday: { providerId: 'remote', model: 'small' },
        power: { providerId: 'remote', model: 'large' },
      },
      autonomy: 'ask',
      monthlyBudgetUsd: 25.5,
      ingest: false,
      ingestFileLimitUsd: 1,
      ingestBuildLimitUsd: 10,
      aiFields: false,
      automationDiagnose: false,
      automationAi: false,
      automationRunLimitUsd: 0.25,
      routines: false,
      routineRunLimitUsd: 0.5,
    });
  });

  it('keeps AI turned on after a provider key is stored and the page is left and opened again', async () => {
    const app = start();
    await app.user.click(await screen.findByRole('switch', { name: 'Turn on AI' }));
    const provider = screen.getByRole('region', { name: 'Another service' });
    await app.user.type(within(provider).getByLabelText('API key'), 'new-secret');
    await app.user.click(screen.getByRole('button', { name: 'Save' }));
    await within(provider).findByText('Stored');
    // Leave the page, then open it again with a fresh cache, which shows what the server kept.
    app.unmount();
    const reopened = renderSharing(<AiSettings />, session);
    clients.push(() => reopened.client.clear());
    const enabled = await screen.findByRole('switch', { name: 'Turn on AI' });
    expect((enabled as HTMLInputElement).checked).toBe(true);
  });

  it('saves the rest of the form while AI is on and no model is chosen', async () => {
    const app = start();
    await app.user.click(await screen.findByRole('switch', { name: 'Turn on AI' }));
    await app.user.type(screen.getByRole('textbox', { name: 'Monthly budget (US dollars)' }), '10');
    const save = screen.getByRole('button', { name: 'Save' });
    await waitFor(() => expect(save.hasAttribute('disabled')).toBe(false));
    await app.user.click(save);
    await waitFor(() =>
      expect(
        app.fetcher.mock.calls
          .filter(([url, init]) => url === '/api/ai/settings' && init?.method === 'PUT')
          .map(([, init]) => JSON.parse(init!.body as string) as Record<string, unknown>),
      ).toContainEqual(expect.objectContaining({ monthlyBudgetUsd: 10 })),
    );
  });

  it('lists everyone’s routines, pauses any of them, and lifts its own pauses', async () => {
    const app = start();
    expect(await screen.findByText('Lead summary')).toBeDefined();
    expect(screen.getByText(/Morgan’s, in Sales · Every day at 9:00 AM/)).toBeDefined();
    expect(screen.getByText('Summarize new leads.')).toBeDefined();
    // A database the admin can't open keeps what the routine does to itself.
    expect(
      screen.getByText('You can’t open its database, so what it does stays with its owner.'),
    ).toBeDefined();
    expect(
      screen.getByText('Reads the home pages of https://acme.example.com and https://bolt.example.com'),
    ).toBeDefined();
    await app.user.click(screen.getByRole('button', { name: 'Pause Lead summary' }));
    await app.user.click(screen.getByRole('button', { name: 'Resume Friday list' }));
    await waitFor(() => expect(paused).toEqual(['rtnAAAAAAAAAAAAAA:pause', 'rtnBBBBBBBBBBBBBB:resume']));
    // Only an admin deletes a routine an admin paused, after saying so.
    await app.user.click(screen.getByRole('button', { name: 'Delete Friday list' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete Friday list?' });
    expect(within(confirm).getByText(/It stops running for Morgan for good/)).toBeDefined();
    await app.user.click(within(confirm).getByRole('button', { name: 'Delete routine' }));
    await waitFor(() => expect(paused).toContain('rtnBBBBBBBBBBBBBB:delete'));
  });

  it('shows only allowed providers and tier-compatible models, and clears a disallowed model', async () => {
    const app = start();
    await screen.findByRole('switch', { name: 'Turn on AI' });
    await app.user.click(screen.getByRole('switch', { name: 'Remote service' }));
    await app.user.click(screen.getByRole('button', { name: /Quick answers/ }));
    expect(await screen.findByRole('option', { name: /^Remote service · Small(?: |$)/ })).toBeDefined();
    expect(screen.queryByRole('option', { name: /^Remote service · Large(?: |$)/ })).toBeNull();
    expect(screen.queryByRole('option', { name: /Local service/ })).toBeNull();
    await app.user.click(screen.getByRole('option', { name: /^Remote service · Small(?: |$)/ }));
    await app.user.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Save$/ })).toHaveProperty('disabled', true),
    );
    const writes = app.fetcher.mock.calls.filter(
      ([url, options]) => url === '/api/ai/settings' && options?.method === 'PUT',
    ).length;
    await app.user.click(screen.getByRole('switch', { name: 'Remote service' }));
    expect(screen.getByRole('button', { name: /Quick answers/ }).textContent).not.toContain('Small');
    await app.user.click(screen.getByRole('switch', { name: 'Remote service' }));
    expect(screen.getByRole('button', { name: /Quick answers/ }).textContent).toContain('Small');
    expect(screen.getByRole('button', { name: /^Save$/ })).toHaveProperty('disabled', true);
    expect(
      app.fetcher.mock.calls.filter(
        ([url, options]) => url === '/api/ai/settings' && options?.method === 'PUT',
      ),
    ).toHaveLength(writes);
  });

  it('stores, replaces, and removes masked keys without receiving or redisplaying stored secrets', async () => {
    const app = start();
    const replacement = crypto.randomUUID();
    const remote = await screen.findByRole('region', { name: 'Remote service' });
    expect(within(remote).getByText('Stored')).toBeDefined();
    expect(within(remote).queryByLabelText('API key')).toBeNull();
    await app.user.click(within(remote).getByRole('button', { name: 'Replace key' }));
    const input = within(remote).getByLabelText('API key') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.value).toBe('');
    await app.user.type(input, replacement);
    await app.user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(remote).queryByLabelText('API key')).toBeNull());
    expect(remote.textContent).not.toContain(replacement);
    expect(
      JSON.parse(
        app.fetcher.mock.calls.find(
          ([url, init]) => url === '/api/ai/settings' && init?.method === 'PUT',
        )![1]!.body as string,
      ),
    ).toMatchObject({ keys: { remote: replacement } });
    await app.user.click(within(remote).getByRole('button', { name: 'Remove key' }));
    await waitFor(() => expect(within(remote).queryByText('Stored')).toBeNull());
    expect((within(remote).getByLabelText('API key') as HTMLInputElement).value).toBe('');
    const empty = screen.getByRole('region', { name: 'Another service' });
    await app.user.type(within(empty).getByLabelText('API key'), crypto.randomUUID());
    await app.user.click(screen.getByRole('button', { name: 'Save' }));
    await within(empty).findByText('Stored');
    expect(within(empty).queryByLabelText('API key')).toBeNull();
  });

  it('marks local providers, locks environment keys, and reports provider test success and failure', async () => {
    const app = start();
    const local = await screen.findByRole('region', { name: 'Local service' });
    expect(within(local).getByText('Runs on your own hardware')).toBeDefined();
    expect(within(local).getByText('Set in the server’s environment')).toBeDefined();
    expect(within(local).queryByLabelText('API key')).toBeNull();
    expect(within(local).queryByRole('button', { name: 'Replace key' })).toBeNull();
    expect(within(local).queryByRole('button', { name: 'Remove key' })).toBeNull();
    await app.user.click(within(local).getByRole('button', { name: 'Test connection' }));
    expect(await within(local).findByText('Connected')).toBeDefined();
    const request = app.fetcher.mock.calls.find(([url]) => url === '/api/ai/test')!;
    expect(JSON.parse(request[1]!.body as string)).toEqual({ providerId: 'local' });
    app.failTest();
    await app.user.click(within(local).getByRole('button', { name: 'Test connection' }));
    await within(local).findByRole('alert');
    expect(within(local).queryByText('Connected')).toBeNull();
  });

  it('shows a provider refusal returned with a successful HTTP status', async () => {
    const app = start();
    const local = await screen.findByRole('region', { name: 'Local service' });
    app.refuseTest();
    await app.user.click(within(local).getByRole('button', { name: 'Test connection' }));
    expect(await within(local).findByRole('alert')).toBeDefined();
    expect(within(local).queryByText('Connected')).toBeNull();
  });

  it('announces unverified credentials without reporting a connection', async () => {
    const app = start();
    const local = await screen.findByRole('region', { name: 'Local service' });
    await app.user.click(within(local).getByRole('button', { name: 'Test connection' }));
    expect(await within(local).findByText('Connected')).toBeDefined();
    app.unverifiedTest();
    await app.user.click(within(local).getByRole('button', { name: 'Test connection' }));
    expect((await within(local).findByRole('status')).textContent).toBe('Credentials not verified');
    expect(within(local).queryByText('Connected')).toBeNull();
    expect(within(local).queryByRole('alert')).toBeNull();
  });

  it('validates the budget and saves a blank budget as no cap', async () => {
    const app = start();
    const budget = await screen.findByRole('textbox', { name: 'Monthly budget (US dollars)' });
    const save = screen.getByRole('button', { name: 'Save' });
    expect((budget as HTMLInputElement).placeholder).toBe('No budget');
    for (const invalid of ['-1', 'oops']) {
      await app.user.clear(budget);
      await app.user.type(budget, invalid);
      await app.user.click(save);
      expect(budget.getAttribute('aria-invalid')).toBe('true');
      expect(app.fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
    }
    await app.user.clear(budget);
    await app.user.type(budget, '10');
    await app.user.click(save);
    await waitFor(() => expect(save.hasAttribute('disabled')).toBe(true));
    await app.user.clear(budget);
    await app.user.click(save);
    await waitFor(() =>
      expect(app.fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(2),
    );
    const request = app.fetcher.mock.calls
      .filter(([url, init]) => url === '/api/ai/settings' && init?.method === 'PUT')
      .at(-1)!;
    expect(JSON.parse(request[1]!.body as string).monthlyBudgetUsd).toBeNull();
  });

  it('rates each model with leaves, reads the estimate out on hover or focus, and says when there’s none', async () => {
    const app = start();
    await screen.findByRole('switch', { name: 'Turn on AI' });
    await app.user.click(screen.getByRole('switch', { name: 'Remote service' }));
    await app.user.click(screen.getByRole('switch', { name: 'Local service' }));
    await app.user.click(screen.getByRole('button', { name: /Quick answers/ }));
    const small = await screen.findByRole('option', { name: /^Remote service · Small(?: |$)/ });
    expect(small.querySelectorAll('.rio-footprint-leaves__on')).toHaveLength(3);
    const description = small.querySelector('.rio-listbox-item__description')!;
    expect(description.textContent).toBe(
      '3 of 3 leaves.  Estimate: about 0.031 to 0.08 Wh for a typical reply of 500 tokens.  More leaves mean less energy.',
    );
    const both = screen.getByRole('option', { name: /^Local service · Both(?: |$)/ });
    expect(both.textContent).toContain('No estimate');
    expect(both.querySelector('.rio-listbox-item__description')!.textContent).toBe(
      'No estimate: the method has no data for this model',
    );
    await app.user.keyboard('{Escape}');
    await app.user.click(screen.getByRole('button', { name: /Thorough work/ }));
    const large = await screen.findByRole('option', { name: /^Remote service · Large(?: |$)/ });
    expect(large.querySelectorAll('.rio-footprint-leaves__on')).toHaveLength(1);
    expect(large.querySelectorAll('.rio-footprint-leaves__off')).toHaveLength(2);
  });

  it('shows the organization’s totals by month, feature, and model, with a CSV of them', async () => {
    const app = start();
    const section = await screen.findByRole('region', { name: 'AI footprint' });
    const byMonth = await within(section).findByRole('table', { name: 'By month' });
    const september = within(byMonth).getByRole('row', { name: /September 2026/ });
    expect(september.textContent).toContain('$0.42');
    expect(september.textContent).toContain('1.2 to 3 Wh');
    expect(september.textContent).toContain('0.52 to 1.3 g CO2e');
    expect(september.textContent).toContain('10 of 12 estimated');
    // A month whose models had no known price says so rather than showing nothing spent.
    expect(within(byMonth).getByRole('row', { name: /August 2026/ }).textContent).toContain('Unknown');
    const byFeature = within(section).getByRole('table', { name: 'By feature' });
    expect(within(byFeature).getByRole('row', { name: /Rio replies/ })).toBeDefined();
    expect(within(byFeature).getByRole('row', { name: /AI fields/ }).textContent).toContain(
      '1 of 3 estimated',
    );
    const byModel = within(section).getByRole('table', { name: 'By model' });
    expect(within(byModel).getByRole('row', { name: /both/ }).textContent).toContain('No estimate');
    await choose(app.user, /Show a month/, 'August 2026');
    expect(within(byFeature).getByRole('row', { name: /Diagnose/ })).toBeDefined();
    expect(within(byFeature).queryByRole('row', { name: /Rio replies/ })).toBeNull();
    expect(within(byModel).getByRole('row', { name: /large/ })).toBeDefined();
    const download = within(section).getByRole('link', { name: 'Download as CSV' });
    expect(download.getAttribute('href')).toBe('/api/ai/footprint.csv');
    expect(download.hasAttribute('download')).toBe(true);
    expect(section.textContent).toContain('EcoLogits 0.11.1');
  });

  it('saves the organization’s electricity zone on its own, and never with the rest of the form', async () => {
    const app = start();
    const section = await screen.findByRole('region', { name: 'AI footprint' });
    const zone = await within(section).findByRole('combobox', { name: 'Electricity zone' });
    expect((zone as HTMLInputElement).value).toBe('The server’s setting: World average (WOR)');
    await app.user.clear(zone);
    await app.user.type(zone, 'Fra');
    await app.user.click(await screen.findByRole('option', { name: /^France \(FRA\)(?: |$)/ }));
    expect(app.fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
    await app.user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true),
    );
    const puts = () =>
      app.fetcher.mock.calls
        .filter(([url, init]) => url === '/api/ai/settings' && init?.method === 'PUT')
        .map(([, init]) => JSON.parse(init!.body as string) as Record<string, unknown>);
    expect(puts()).toEqual([{ electricityZone: 'FRA' }]);
    await waitFor(() => expect((zone as HTMLInputElement).value).toBe('France (FRA)'));
    await app.user.type(screen.getByRole('textbox', { name: 'Monthly budget (US dollars)' }), '12');
    await app.user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(puts()[1]).not.toHaveProperty('electricityZone');
  });
});

it('keeps gateway fields, keys, and headers in the page draft until the footer saves', async () => {
  const gateway = {
    providerId: 'gateway-office',
    name: 'Office',
    baseUrl: 'https://gateway.example.test/v1',
    auth: { mode: 'bearer' as const },
    headerNames: ['X-Route'],
    models: [{ model: 'office-chat', contextTokens: 8192, mapping: null }],
  };
  const app = start(session, false, {
    ...initial,
    settings: { ...initial.settings, gateways: [gateway], providers: [{ providerId: gateway.providerId }] },
    providers: [
      ...initial.providers,
      {
        providerId: gateway.providerId,
        name: gateway.name,
        local: false,
        hasKey: true,
        keyFromEnvironment: false,
        models: [],
      },
    ],
  });
  const region = await screen.findByRole('region', { name: 'Office' });
  expect(within(region).queryByRole('button', { name: /^Save/ })).toBeNull();
  const name = within(region).getByLabelText('Display name');
  await app.user.clear(name);
  await app.user.type(name, 'Renamed');
  expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false);
  expect(app.fetcher.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(0);
  await app.user.click(screen.getByRole('button', { name: 'Discard' }));
  expect(name).toHaveProperty('value', 'Office');
  const key = crypto.randomUUID();
  const header = crypto.randomUUID();
  await app.user.type(within(region).getByLabelText('API key'), key);
  await app.user.type(within(region).getByLabelText('Extra header value'), header);
  await app.user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(app.fetcher.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1),
  );
  const [, options] = app.fetcher.mock.calls.find(([, options]) => options?.method === 'PUT')!;
  const body = JSON.parse(options!.body as string);
  expect(body.gateways).toBeUndefined();
  expect(body.gatewayChanges).toEqual([{ gateway, key, headers: { 'X-Route': header } }]);
});

it('closes the new gateway fields when the page draft is saved or discarded', async () => {
  const app = start(session, false, {
    ...initial,
    providers: [
      ...initial.providers,
      {
        providerId: 'gateway',
        name: 'Gateway',
        local: false,
        hasKey: false,
        keyFromEnvironment: false,
        models: [],
      },
    ],
  });
  await app.user.click(await screen.findByRole('button', { name: 'Add gateway' }));
  expect(screen.getByLabelText('Display name').getAttribute('aria-invalid')).not.toBe('true');
  await app.user.type(screen.getByLabelText('Display name'), 'Office');
  await app.user.click(screen.getByRole('button', { name: 'Discard' }));
  expect(await screen.findByRole('button', { name: 'Add gateway' })).toBeDefined();
  expect(screen.queryByLabelText('Display name')).toBeNull();
  await app.user.click(screen.getByRole('button', { name: 'Add gateway' }));
  await app.user.type(screen.getByLabelText('Display name'), 'Office');
  await app.user.type(screen.getByLabelText('Base URL'), 'https://gateway.example.test/v1');
  await app.user.type(
    within(screen.getByRole('region', { name: 'AI gateway' })).getByLabelText('API key'),
    crypto.randomUUID(),
  );
  await app.user.click(screen.getByRole('button', { name: 'Add model' }));
  await app.user.type(screen.getByLabelText('Model name'), 'office-chat');
  await app.user.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('button', { name: 'Add gateway' })).toBeDefined();
  expect(screen.queryByLabelText('Display name')).toBeNull();
});
