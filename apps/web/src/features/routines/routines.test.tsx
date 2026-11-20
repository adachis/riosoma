import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Notification,
  RoutineChanges,
  RioStatus,
  Routine,
  RoutineApproval,
  RoutineDraft,
  RoutineRun,
} from '@riosoma/contracts';
import { json, renderSharing, session } from '../../screens/database/share/testing';
import { NotificationItem } from '../notifications/NotificationItem';
import { ApprovalCard } from './ApprovalCard';
import { RoutineDialog } from './RoutineForm';
import { RoutineScreen } from './RoutineScreen';

const databaseId = 'dbAAAAAAAAAAAAAA';
const leads = 'tblLEADSLEADSLEAD';
const notes = 'tblNOTESNOTESNOTE';
const routineId = 'rtnAAAAAAAAAAAAAA';
const runId = 'rtrAAAAAAAAAAAAAA';
const groupId = 'actAAAAAAAAAAAAAA';

const status: RioStatus = {
  enabled: true,
  tiers: ['everyday'],
  autonomy: 'previewBig',
  paused: false,
  diagnose: true,
  routines: true,
  routineRunLimitUsd: 1,
};

const plan = {
  summary: 'Summarize new leads and email the summary.',
  steps: ['Find new leads', 'Write a summary', 'Email it'],
  reads: [leads],
  writes: [notes],
  sends: [{ to: ['owner', 'casey@example.com'], what: 'The summary' }],
  fetches: [{ tableId: leads, fieldId: 'fldWEBSITEWEBSITE' }],
};

/** A plan that trashes every lead under words that promise tags, as the server described it */
const trashing: RoutineChanges = {
  tables: [
    {
      tableId: leads,
      tableName: 'Leads',
      created: 0,
      updated: 0,
      trashed: 3,
      restored: 0,
      trashedNames: ['Acme', 'Bolt', 'Cask'],
      fields: [],
      signaturesCanceled: 1,
    },
  ],
  deletes: true,
  small: false,
};

/** Two small edits, which the bell may approve in one click */
const tagging: RoutineChanges = {
  tables: [
    {
      tableId: leads,
      tableName: 'Leads',
      created: 0,
      updated: 2,
      trashed: 0,
      restored: 0,
      trashedNames: [],
      fields: [
        {
          fieldId: 'fldINDUSTRYINDUST',
          fieldName: 'Industry',
          values: [{ before: '', after: 'Farming', records: 2, recordNames: ['Acme', 'Bolt'] }],
          more: 0,
        },
      ],
    },
  ],
  deletes: false,
  small: true,
};

const approvalNote = (approvalId: string): Notification => ({
  id: 'ntfAAAAAAAAAAAAAA',
  kind: 'routineApproval',
  createdAt: new Date().toISOString(),
  readAt: null,
  actor: null,
  target: { databaseId, databaseName: 'Sales', routineId, routineName: 'Lead summary', approvalId },
});

const draft: RoutineDraft = {
  name: 'Lead summary',
  plan,
  tableNames: { [leads]: 'Leads', [notes]: 'Notes' },
  fieldNames: { fldWEBSITEWEBSITE: 'Website' },
  estimate: {
    inputTokens: 4_000,
    outputTokens: 321,
    costUsd: 0.0123,
    footprint: {
      energyWh: { min: 0.4, max: 0.9 },
      gwpG: { min: 0.1, max: 0.3 },
      method: 'EcoLogits 0.11.1',
      zone: 'WOR',
    },
  },
  usage: { providerId: 'fixture', model: 'm', inputTokens: 10, outputTokens: 5, costUsd: 0.0001, ms: 5 },
  limitUsd: 1,
};

function routine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: routineId,
    databaseId,
    databaseName: 'Sales',
    name: 'Lead summary',
    instructions: 'Every Monday, summarize new leads and email the summary to me and Casey.',
    plan,
    schedule: { kind: 'weekly', days: [1], at: '09:00' },
    timeZone: 'America/Denver',
    locale: 'en-US',
    costCapUsd: 0.25,
    approvedRecipients: [],
    approvedSites: ['https://acme.example.test'],
    owner: { id: session.user.id, name: 'Ada' },
    paused: false,
    pausedBecause: null,
    failures: 0,
    nextRunAt: '2026-10-05T15:00:00.000Z',
    lastRun: null,
    adminPaused: false,
    waiting: 1,
    tableNames: { [leads]: 'Leads', [notes]: 'Notes' },
    fieldNames: { fldWEBSITEWEBSITE: 'Website' },
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    ...overrides,
  };
}

function approval(overrides: Partial<RoutineApproval> = {}): RoutineApproval {
  return {
    id: 'rtaAAAAAAAAAAAAAA',
    routineId,
    runId,
    databaseId,
    kind: 'email',
    status: 'pending',
    summary: 'Summary → casey@example.com',
    steps: [],
    changes: null,
    revision: 0,
    email: { to: ['casey@example.com'], subject: 'New leads', body: 'Three new leads.' },
    sites: [],
    receipt: null,
    messageKey: null,
    createdAt: '2026-09-28T15:00:00.000Z',
    decidedAt: null,
    expiresAt: '2026-10-05T15:00:00.000Z',
    ...overrides,
  };
}

const run: RoutineRun = {
  id: runId,
  routineId,
  trigger: 'schedule',
  state: 'stopped',
  messageKey: 'routines.run.costCap',
  // Words a fooled model might write after reading an injected record.
  report: 'Tagged **two** leads.  Confirm your account at [the portal](https://phish.example.test/login).',
  receipt: { databaseId, groupId, summary: 'Set the industry to Farming' },
  activity: [
    {
      kind: 'email',
      to: ['casey@example.com'],
      subject: 'New leads',
      status: 'sent',
      at: '2026-09-28T15:00:05.000Z',
    },
    {
      kind: 'email',
      to: ['ada@example.com'],
      subject: 'Digest',
      status: 'sending',
      at: '2026-09-28T15:00:07.000Z',
    },
    {
      kind: 'email',
      to: ['ada@example.com'],
      subject: 'Retry',
      status: 'failed',
      at: '2026-09-28T15:00:08.000Z',
    },
    { kind: 'fetch', url: 'https://acme.example.test/', status: 200, at: '2026-09-28T15:00:03.000Z' },
  ],
  approvals: [approval()],
  steps: 4,
  usage: {
    providerId: 'fixture',
    model: 'routine-model',
    inputTokens: 1_000,
    outputTokens: 200,
    costUsd: 0.0021,
    ms: 900,
    footprint: {
      energyWh: { min: 0.02, max: 0.05 },
      gwpG: { min: 0.01, max: 0.02 },
      method: 'EcoLogits 0.11.1',
      zone: 'WOR',
    },
  },
  createdAt: '2026-09-28T15:00:00.000Z',
  startedAt: '2026-09-28T15:00:01.000Z',
  finishedAt: '2026-09-28T15:00:09.000Z',
};

/** An in-memory server for routines, recording what the app sends. */
function start(answers: Record<string, unknown> = {}) {
  const sent: Array<{ method: string; url: string; body: unknown }> = [];
  let current = (answers.approval as RoutineApproval | undefined) ?? approval();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
      sent.push({ method, url, body });
      if (url === '/api/rio/status') return json(status);
      if (url === '/api/rio/routines/draft') return json(draft);
      if (url === '/api/rio/routines/sites')
        return json({ sites: ['https://acme.example.test', 'https://bolt.example.test'] });
      if (url === '/api/rio/routines' && method === 'POST') return json(routine());
      if (url === `/api/rio/routines/${routineId}`) return json(routine());
      if (url === `/api/rio/routines/${routineId}/runs`) return json([run]);
      if (url.startsWith('/api/rio/routine-approvals/')) {
        if (method === 'GET') return json(current);
        const action = url.split('/').at(-1);
        // A plan that changed since it was shown comes back refused, and reads anew.
        if (action === 'approve' && answers.moved) {
          current = answers.moved as RoutineApproval;
          answers.moved = undefined;
          return new Response(
            JSON.stringify({
              error: { code: 'conflict', messageKey: 'routines.approval.stale', userFault: true },
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          );
        }
        current = { ...current, status: action === 'skip' ? 'skipped' : 'approved' };
        return json(current);
      }
      if (url === `/api/databases/${databaseId}/undo`) return json({ status: 'applied', skipped: 0 });
      if (url.startsWith('/api/rio/routines')) return json([]);
      throw new Error(`Unexpected request: ${method} ${url}`);
    }),
  );
  return sent;
}

beforeEach(() => {
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
    ...new Intl.DateTimeFormat('en-US', { timeZone: 'UTC' }).resolvedOptions(),
    timeZone: 'America/Denver',
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('setting up a routine', () => {
  it('has Rio restate the words, shows the plan and estimate, and saves what the person checked', async () => {
    const sent = start();
    renderSharing(<RoutineDialog databaseId={databaseId} onClose={() => undefined} />);
    const words = await screen.findByRole('textbox', { name: /What should Rio do\?/ });
    await userEvent.type(words, 'Every Monday, summarize new leads and email the summary to me and Casey.');
    // Saving waits for a plan the person has seen.
    await userEvent.click(screen.getByRole('button', { name: 'Save routine' }));
    expect(screen.getByText(/Ask Rio to restate it, so you can check the plan/)).toBeDefined();
    expect(sent.some((request) => request.url === '/api/rio/routines' && request.method === 'POST')).toBe(
      false,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Ask Rio to restate it' }));
    expect(await screen.findByText('Summarize new leads and email the summary.')).toBeDefined();
    expect(screen.getByText('Leads')).toBeDefined();
    expect(screen.getByText('Notes')).toBeDefined();
    expect(screen.getByText('$0.0123 and 4,321 tokens')).toBeDefined();
    expect(screen.getByText('Estimate: about 0.4 to 0.9 Wh and 0.1 to 0.3 g CO2e')).toBeDefined();
    expect(screen.getByText('The summary, to you and casey@example.com')).toBeDefined();
    expect((screen.getByRole('textbox', { name: /^Name/ }) as HTMLInputElement).value).toBe('Lead summary');
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Send to exactly these people without asking me each time' }),
    );
    // The sites its fields name now are listed to approve, none of them checked until the person does.
    const acme = await screen.findByRole('checkbox', { name: 'https://acme.example.test' });
    expect(acme).toHaveProperty('checked', false);
    expect(sent.find((request) => request.url === '/api/rio/routines/sites')!.body).toEqual({
      databaseId,
      fetches: plan.fetches,
    });
    await userEvent.click(acme);
    await userEvent.click(screen.getByRole('button', { name: 'Save routine' }));
    await waitFor(() =>
      expect(sent.some((request) => request.url === '/api/rio/routines' && request.method === 'POST')).toBe(
        true,
      ),
    );
    expect(sent.find((request) => request.url === '/api/rio/routines')!.body).toMatchObject({
      databaseId,
      name: 'Lead summary',
      plan,
      schedule: { kind: 'weekly', days: [1], at: '09:00' },
      timeZone: 'America/Denver',
      costCapUsd: 0.25,
      approvedRecipients: [['ada@example.com', 'casey@example.com']],
      approvedSites: ['https://acme.example.test'],
    });
  });

  it('asks for a fresh restatement once the words change', async () => {
    start();
    renderSharing(<RoutineDialog databaseId={databaseId} onClose={() => undefined} />);
    const words = await screen.findByRole('textbox', { name: /What should Rio do\?/ });
    await userEvent.type(words, 'Tag new leads.');
    await userEvent.click(screen.getByRole('button', { name: 'Ask Rio to restate it' }));
    await screen.findByText('Summarize new leads and email the summary.');
    await userEvent.type(words, ' Every day.');
    expect(screen.getByText('The words changed, so ask Rio to restate them before saving.')).toBeDefined();
    expect(screen.queryByText('Summarize new leads and email the summary.')).toBeNull();
  });
});

describe('what waits for the owner', () => {
  it('changes an email before it goes', async () => {
    const sent = start();
    renderSharing(<ApprovalCard approval={approval()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    const subject = screen.getByRole('textbox', { name: 'Subject' });
    await userEvent.clear(subject);
    await userEvent.type(subject, 'This week’s leads');
    await userEvent.click(screen.getByRole('button', { name: 'Send it' }));
    await waitFor(() => expect(sent.some((request) => request.url.endsWith('/approve'))).toBe(true));
    expect(sent.find((request) => request.url.endsWith('/approve'))!.body).toEqual({
      always: false,
      email: { to: ['casey@example.com'], subject: 'This week’s leads', body: 'Three new leads.' },
    });
  });

  it('shows what a plan does before the model’s words, whatever they say', async () => {
    start();
    const misleading = approval({
      kind: 'plan',
      email: null,
      summary: 'Set the industry of three leads to Farming',
      steps: ['Set the industry of three leads to Farming'],
      changes: trashing,
    });
    renderSharing(<ApprovalCard approval={misleading} />);
    const card = screen.getByRole('article');
    const text = card.textContent ?? '';
    expect(screen.getByText('This deletes things.')).toBeDefined();
    expect(screen.getByText('Deletes 3 records from Leads')).toBeDefined();
    expect(screen.getByText('Acme, Bolt, and Cask')).toBeDefined();
    expect(
      screen.getByText('Cancels 1 signature request in Leads, by removing the document it was made from'),
    ).toBeDefined();
    // The server's account comes before the model's.
    expect(text.indexOf('Deletes 3 records')).toBeLessThan(text.indexOf('Set the industry of three leads'));
    cleanup();
    // A plan whose changes couldn't be worked out can't be approved.
    renderSharing(<ApprovalCard approval={{ ...misleading, changes: null }} />);
    expect(screen.getByRole('button', { name: 'Approve changes' })).toHaveProperty('disabled', true);
  });

  it('skips a plan, and asks Rio to prepare one again with a note', async () => {
    const sent = start();
    const planned = approval({
      kind: 'plan',
      email: null,
      summary: 'Trash old leads',
      steps: ['Trash 30 leads'],
      changes: trashing,
    });
    renderSharing(<ApprovalCard approval={planned} />);
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    await userEvent.type(
      screen.getByRole('textbox', { name: 'What should Rio do differently?' }),
      'Only leads older than a year.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Ask Rio to prepare it again' }));
    await waitFor(() => expect(sent.some((request) => request.url.endsWith('/change'))).toBe(true));
    expect(sent.find((request) => request.url.endsWith('/change'))!.body).toEqual({
      note: 'Only leads older than a year.',
    });
    cleanup();
    renderSharing(<ApprovalCard approval={planned} />);
    await userEvent.click(screen.getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(sent.some((request) => request.url.endsWith('/skip'))).toBe(true));
  });

  it('asks before reading new sites, and reads or skips them', async () => {
    const sent = start();
    const sites = approval({
      kind: 'hosts',
      email: null,
      summary: 'https://acme.example.test, https://bolt.example.test',
      sites: ['https://acme.example.test', 'https://bolt.example.test'],
    });
    renderSharing(<ApprovalCard approval={sites} />);
    expect(screen.getByText('Read these new sites?')).toBeDefined();
    expect(screen.getByText('https://bolt.example.test')).toBeDefined();
    expect(screen.getByText(/Approving lets it read the home page of each one/)).toBeDefined();
    // Sites are read or skipped, with nothing to change.
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Read them' }));
    await waitFor(() => expect(sent.some((request) => request.url.endsWith('/approve'))).toBe(true));
    expect(sent.find((request) => request.url.endsWith('/approve'))!.body).toEqual({ revision: 0 });
  });

  it('approves only small edits in the bell, and sends everything else to be reviewed', async () => {
    const note = (approvalId: string): Notification => ({
      id: 'ntfAAAAAAAAAAAAAA',
      kind: 'routineApproval',
      createdAt: new Date().toISOString(),
      readAt: null,
      actor: null,
      target: { databaseId, databaseName: 'Sales', routineId, routineName: 'Lead summary', approvalId },
    });
    for (const waiting of [
      approval({ kind: 'plan', email: null, summary: 'Tag three leads', changes: trashing }),
      approval(),
      approval({
        kind: 'hosts',
        email: null,
        summary: 'Tag three leads',
        sites: ['https://acme.example.test'],
      }),
    ]) {
      start({ approval: waiting });
      renderSharing(<NotificationItem notification={approvalNote(waiting.id)} onOpen={() => undefined} />);
      expect(await screen.findByRole('link', { name: 'Review it to approve' })).toBeDefined();
      expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
      expect(screen.queryByText('Tag three leads')).toBeNull();
      cleanup();
    }
    start({ approval: approval({ kind: 'plan', email: null, changes: trashing }) });
    renderSharing(<NotificationItem notification={note('rtaAAAAAAAAAAAAAA')} onOpen={() => undefined} />);
    expect(await screen.findByText('Deletes 3 records from Leads')).toBeDefined();
    cleanup();
    // A plan with more changes of a field than the bell lists is read on its card, whatever it says.
    const many: RoutineChanges = {
      ...tagging,
      tables: [
        {
          ...tagging.tables[0]!,
          updated: 4,
          fields: [
            {
              ...tagging.tables[0]!.fields[0]!,
              values: ['Farming', 'Retail', 'Tech', 'Closed'].map((after) => ({
                before: '',
                after,
                records: 1,
              })),
            },
          ],
        },
      ],
    };
    start({ approval: approval({ kind: 'plan', email: null, changes: many }) });
    renderSharing(<NotificationItem notification={note('rtaAAAAAAAAAAAAAA')} onOpen={() => undefined} />);
    expect(await screen.findByText('and 1 more change, shown when you review it')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Review it to approve' })).toBeDefined();
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
    cleanup();
    start({ approval: approval({ kind: 'hosts', email: null, sites: ['https://acme.example.test'] }) });
    renderSharing(<NotificationItem notification={note('rtaAAAAAAAAAAAAAA')} onOpen={() => undefined} />);
    expect(await screen.findByText('Read these new sites? https://acme.example.test')).toBeDefined();
  });

  it('shows a plan anew in the bell when it changed since it was shown', async () => {
    const shown = approval({ kind: 'plan', email: null, changes: tagging });
    const moved = approval({
      kind: 'plan',
      email: null,
      changes: {
        ...tagging,
        tables: [
          {
            ...tagging.tables[0]!,
            fields: [
              {
                ...tagging.tables[0]!.fields[0]!,
                values: [{ before: 'Retail', after: 'Farming', records: 2 }],
              },
            ],
          },
        ],
      },
    });
    const sent = start({ approval: shown, moved });
    const note: Notification = {
      id: 'ntfAAAAAAAAAAAAAA',
      kind: 'routineApproval',
      createdAt: new Date().toISOString(),
      readAt: null,
      actor: null,
      target: {
        databaseId,
        databaseName: 'Sales',
        routineId,
        routineName: 'Lead summary',
        approvalId: shown.id,
      },
    };
    renderSharing(<NotificationItem notification={note} onOpen={() => undefined} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Approve changes' }));
    expect(await screen.findByText(/This plan changed since you saw it/)).toBeDefined();
    // What it would do now is read again, and nothing was approved.
    expect(await screen.findByText('“Retail” to “Farming” in 2 records', { exact: false })).toBeDefined();
    expect(sent.filter((request) => request.url.endsWith('/approve'))).toHaveLength(1);
  });

  it.each([
    ['1111', '9999'],
    [String.raw`x\u28000`, String.raw`x\u{28000}`],
    [String.raw`x\u005Cu{28000}`, String.raw`x\u{28000}`],
  ])(
    'keeps created record values %s and %s together in the bell and on the approval card',
    async (firstValue, secondValue) => {
      const changes: RoutineChanges = {
        ...tagging,
        tables: [
          {
            ...tagging.tables[0]!,
            created: 2,
            updated: 0,
            records: [
              {
                recordId: 'recAAAAAAAAAAAAAA',
                name: 'Acme',
                showId: true,
                kind: 'created',
                fields: [
                  { fieldId: 'fldACCOUNTACCOUNT', fieldName: 'Account', before: '', after: firstValue! },
                ],
              },
              {
                recordId: 'recBBBBBBBBBBBBBB',
                name: 'Acme',
                showId: true,
                kind: 'created',
                fields: [
                  { fieldId: 'fldACCOUNTACCOUNT', fieldName: 'Account', before: '', after: secondValue! },
                ],
              },
            ],
          },
        ],
      };
      const waiting = approval({ kind: 'plan', email: null, changes });
      for (const compact of [true, false]) {
        start({ approval: waiting });
        renderSharing(
          compact ? (
            <NotificationItem notification={approvalNote(waiting.id)} onOpen={() => undefined} />
          ) : (
            <ApprovalCard approval={waiting} />
          ),
        );
        const first = (await screen.findByText('Acme [recAAAAAAAAAAAAAA]')).closest('li')!;
        expect(within(first).getByText(`Account: empty to “${firstValue}”`)).toBeDefined();
        expect(within(first).queryByText(secondValue!, { exact: false })).toBeNull();
        const second = screen.getByText('Acme [recBBBBBBBBBBBBBB]').closest('li')!;
        expect(within(second).getByText(`Account: empty to “${secondValue}”`)).toBeDefined();
        cleanup();
      }
    },
  );

  it('requires review when the bell cannot show every field of a record', async () => {
    const changes: RoutineChanges = {
      ...tagging,
      tables: [
        {
          ...tagging.tables[0]!,
          updated: 1,
          records: [
            {
              recordId: 'recAAAAAAAAAAAAAA',
              name: 'Acme',
              showId: true,
              kind: 'updated',
              fields: Array.from({ length: 4 }, (_, i) => ({
                fieldId: `field${i}`,
                fieldName: `Field ${i}`,
                before: '',
                after: `${i}`,
              })),
            },
          ],
        },
      ],
    };
    const waiting = approval({ kind: 'plan', email: null, changes });
    start({ approval: waiting });
    renderSharing(<NotificationItem notification={approvalNote(waiting.id)} onOpen={() => undefined} />);
    expect(await screen.findByRole('link', { name: 'Review it to approve' })).toBeDefined();
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
  });

  it('approves or skips in the bell, and undoes a run’s changes there', async () => {
    const sent = start({ approval: approval({ kind: 'plan', email: null, changes: tagging }) });
    const note = (kind: Notification['kind'], target: Notification['target']): Notification => ({
      id: 'ntfAAAAAAAAAAAAAA',
      kind,
      createdAt: new Date().toISOString(),
      readAt: null,
      actor: null,
      target: { databaseId, databaseName: 'Sales', routineId, routineName: 'Lead summary', ...target },
    });
    renderSharing(
      <ul>
        <li>
          <NotificationItem
            notification={note('routineApproval', {
              approvalId: 'rtaAAAAAAAAAAAAAA',
              excerpt: 'Trash old leads',
            })}
            onOpen={() => undefined}
          />
        </li>
        <li>
          <NotificationItem
            notification={note('routineReport', { runId, groupId, excerpt: 'Tagged two leads.' })}
            onOpen={() => undefined}
          />
        </li>
      </ul>,
    );
    expect(screen.getByRole('link', { name: /Lead summary is waiting for your approval/ })).toBeDefined();
    // The notice carries the server's account of the change, never the model's words.
    // Each change names the records it's made in.
    expect(await screen.findByText('“Farming” in 2 records: Acme and Bolt', { exact: false })).toBeDefined();
    expect(screen.queryByText('Trash old leads')).toBeNull();
    // A report notice shows what the server recorded, and points to the page for the report itself.
    expect(screen.queryByText('Tagged two leads.')).toBeNull();
    expect(screen.getByText('Its report is on the routine’s page.')).toBeDefined();
    await userEvent.click(await screen.findByRole('button', { name: 'Approve changes' }));
    await waitFor(() => expect(sent.some((request) => request.url.endsWith('/approve'))).toBe(true));
    // The bell says it's a one-click approval, which the server holds to small edits.
    expect(sent.find((request) => request.url.endsWith('/approve'))!.body).toEqual({
      oneClick: true,
      revision: 0,
    });
    expect(await screen.findByText('Approved')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Undo these changes' }));
    await waitFor(() =>
      expect(sent.find((request) => request.url === `/api/databases/${databaseId}/undo`)?.body).toMatchObject(
        {
          groupId,
        },
      ),
    );
    expect(await screen.findByText('Undone')).toBeDefined();
  });
});

describe('a routine’s page', () => {
  it('shows what it does, what waits, and each run with its report, changes, cost, and tokens', async () => {
    start();
    renderSharing(<RoutineScreen routineId={routineId} databaseName="Sales" />);
    expect(await screen.findByRole('heading', { name: 'Lead summary' })).toBeDefined();
    expect(screen.getByText('Every Monday at 9:00 AM')).toBeDefined();
    expect(await screen.findByText('Stopped at a limit')).toBeDefined();
    expect(screen.getByText(/The run stopped at its cost cap/)).toBeDefined();
    // The report is plain text: its markup and its link stay words, never a live link.
    expect(screen.getByText(/Tagged \*\*two\*\* leads\./)).toBeDefined();
    expect(screen.queryByRole('link', { name: 'the portal' })).toBeNull();
    expect(document.querySelector('a[href^="https://phish"]')).toBeNull();
    // What it sent and fetched is shown as the server recorded it.
    expect(screen.getByText('Emailed casey@example.com: New leads')).toBeDefined();
    expect(screen.getByText('Was still emailing ada@example.com when the run ended: Digest')).toBeDefined();
    expect(screen.getByText('Couldn’t email ada@example.com: Retry')).toBeDefined();
    expect(screen.getByText('https://acme.example.test')).toBeDefined();
    expect(screen.getByText('Fetched https://acme.example.test/ (200)')).toBeDefined();
    expect(screen.getByText('Website in Leads')).toBeDefined();
    expect(screen.getByText('Set the industry to Farming')).toBeDefined();
    expect(screen.getByText(/routine-model · 1,200 tokens · \$0\.0021/)).toBeDefined();
    expect(screen.getByText('Estimate: about 0.02 to 0.05 Wh and 0.01 to 0.02 g CO2e')).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Waiting for you' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Approve and send' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Undo these changes' })).toBeDefined();
  });
});
