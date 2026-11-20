import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ReportScheduleInput,
  type ReportRun,
  type ReportSchedule,
  type ViewReports,
} from '@riosoma/contracts';
import { toastQueue, ToastRegion } from '@riosoma/ui';
import { json, renderSharing, session } from '../../screens/database/share/testing';
import { ReportsDialog } from './ReportsDialog';
import { saveFile } from '../../screens/database/view/download';
import type * as Download from '../../screens/database/view/download';

vi.mock('../../screens/database/view/download', async (original) => ({
  ...(await original<typeof Download>()),
  saveFile: vi.fn(),
}));

const viewId = 'viwAAAAAAAAAAAAAA';
/** The person using the dialog, with an ID the contract accepts */
const me = { ...session, user: { ...session.user, id: 'usrADAADAADAADAAD' } };
const sam = { id: 'usrSAMSAMSAMSAMSA', name: 'Sam Stone', email: 'sam@example.com' };
const lee = { id: 'usrLEELEELEELEELE', name: 'Lee Park', email: 'lee@example.com' };

function schedule(overrides: Partial<ReportSchedule> = {}): ReportSchedule {
  return {
    id: 'rptAAAAAAAAAAAAAA',
    databaseId: 'dbAAAAAAAAAAAAAA',
    tableId: 'tblAAAAAAAAAAAAAA',
    viewId,
    databaseName: 'Sales',
    tableName: 'Deals',
    viewName: 'Open deals',
    name: 'Monday pipeline',
    format: 'xlsx',
    frequency: { kind: 'weekly', days: [1, 4], at: '09:00' },
    timeZone: 'America/Denver',
    enabled: true,
    recipients: [
      { kind: 'member', userId: me.user.id, name: 'Ada' },
      { kind: 'address', address: 'partner@elsewhere.example' },
    ],
    owner: { id: me.user.id, name: 'Ada' },
    nextRunAt: '2026-10-05T15:00:00.000Z',
    lastRunAt: null,
    stoppedBecause: null,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    canEdit: true,
    canDelete: true,
    receiving: true,
    ...overrides,
  };
}

const run: ReportRun = {
  id: 'jobAAAAAAAAAAAAAA',
  trigger: 'schedule',
  state: 'partial',
  dueAt: '2026-09-28T15:00:00.000Z',
  startedAt: '2026-09-28T15:00:01.000Z',
  finishedAt: '2026-09-28T15:00:02.000Z',
  retryAt: null,
  attempts: 4,
  deliveries: [
    {
      recipient: { kind: 'member', userId: me.user.id, name: 'Ada' },
      state: 'sent',
      records: 42,
      attachment: 'attached',
      attempts: 1,
      error: null,
    },
    {
      recipient: { kind: 'address', address: 'partner@elsewhere.example' },
      state: 'failed',
      records: null,
      attachment: null,
      attempts: 4,
      error: { messageKey: 'reports.delivery.mailFailed', code: 'EENVELOPE' },
    },
  ],
  error: null,
};

/** An in-memory server for one view's reports, recording what the dialog sends. */
function start(initial: Partial<ViewReports> = {}, downloadFails = false) {
  const state: ViewReports = {
    reports: [],
    canAddMembers: true,
    members: [sam, lee],
    outsideAllowed: true,
    emailAvailable: true,
    ...initial,
  };
  const sent: Array<{ method: string; url: string; body: unknown }> = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    sent.push({ method, url, body });
    if (url === `/api/views/${viewId}/reports` && method === 'GET') return json(state);
    if (url === `/api/views/${viewId}/reports` && method === 'POST') {
      const input = ReportScheduleInput.parse(body);
      const created = schedule({
        id: 'rptNEWNEWNEWNEWNE',
        ...input,
        recipients: input.recipients.map((recipient) =>
          recipient.kind === 'member'
            ? { kind: 'member', userId: recipient.userId, name: recipient.userId }
            : recipient,
        ),
      });
      state.reports = [...state.reports, created];
      return json(created);
    }
    const match = /^\/api\/reports\/(rpt[0-9A-Za-z]{14})(\/[a-z]+)?/.exec(url);
    const report = state.reports.find((item) => item.id === match?.[1]);
    if (report && !match?.[2] && method === 'PUT') {
      const input = ReportScheduleInput.parse(body);
      const saved = { ...report, enabled: input.enabled, name: input.name };
      state.reports = state.reports.map((item) => (item.id === report.id ? saved : item));
      return json(saved);
    }
    if (report && !match?.[2] && method === 'DELETE') {
      state.reports = state.reports.filter((item) => item.id !== report.id);
      return new Response(null, { status: 204 });
    }
    if (report && match?.[2] === '/send') return json({ ...run, trigger: 'manual', state: 'sent' });
    if (report && match?.[2] === '/runs') return json({ runs: [run], next: null });
    if (report && match?.[2] === '/download')
      return downloadFails
        ? new Response(JSON.stringify({ error: { code: 'internal', messageKey: 'errors.internal' } }), {
            status: 500,
          })
        : new Response('%PDF-', {
            headers: {
              'content-type': 'application/pdf',
              'content-disposition': 'attachment; filename="Team.pdf"',
            },
          });
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  const onClose = vi.fn();
  renderSharing(
    <>
      <ReportsDialog viewId={viewId} viewName="Open deals" onClose={onClose} />
      <ToastRegion />
    </>,
    me,
  );
  return { sent, state, onClose };
}

async function choose(label: RegExp, option: string) {
  await userEvent.click(screen.getByRole('button', { name: label }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

beforeEach(() => {
  vi.mocked(saveFile).mockClear();
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
    ...new Intl.DateTimeFormat('en-US', { timeZone: 'UTC' }).resolvedOptions(),
    timeZone: 'America/Denver',
  });
});

afterEach(() => {
  cleanup();
  for (const toast of toastQueue.visibleToasts) toastQueue.close(toast.key);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ReportsDialog', () => {
  it('shows a PDF download failure inside the reports dialog', async () => {
    const { sent } = start({ reports: [schedule({ format: 'pdf' })] }, true);
    await userEvent.click(await screen.findByRole('button', { name: 'More for Monday pipeline' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Download PDF' }));
    expect(await screen.findByRole('alert')).toBeDefined();
    expect(saveFile).not.toHaveBeenCalled();
    expect(sent.some((request) => request.url.endsWith('/download'))).toBe(true);
    expect(screen.getByRole('dialog', { name: 'Scheduled reports' })).toBeDefined();
  });

  it('lets a reader download a received PDF without access to its management or history', async () => {
    start({
      canAddMembers: false,
      reports: [
        schedule({
          name: 'Team PDF',
          format: 'pdf',
          owner: { id: sam.id, name: sam.name },
          recipients: [],
          canEdit: false,
          canDelete: false,
        }),
      ],
    });
    await userEvent.click(await screen.findByRole('button', { name: 'More for Team PDF' }));
    for (const name of ['Edit', 'Send now', 'History', 'Delete'])
      expect(screen.queryByRole('menuitem', { name })).toBeNull();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Download PDF' }));
    await waitFor(() => expect(saveFile).toHaveBeenCalledWith(expect.any(Blob), 'Team.pdf'));
  });

  it('sets up a report for members of the database and an outside address', async () => {
    const { sent } = start();
    expect(await screen.findByText('No scheduled reports for this view yet.')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Set up a report' }));
    expect(screen.getByRole('heading', { name: 'Set up a report' })).toBeDefined();
    const name = screen.getByRole('textbox', { name: 'Name' });
    expect((name as HTMLInputElement).value).toBe('Open deals');
    await userEvent.clear(name);
    await userEvent.type(name, 'Weekly pipeline');
    // Every supported file format remains available when setting up a schedule.
    const files = screen.getByRole('radiogroup', { name: 'File' });
    expect(
      within(files)
        .getAllByRole('radio')
        .map((radio) => radio.closest('label')?.textContent),
    ).toEqual([
      'Excel workbook',
      'CSV file',
      'Word document',
      'PowerPoint deck',
      'PDF document',
      'Summary only',
    ]);
    await userEvent.click(screen.getByRole('radio', { name: 'CSV file' }));
    // Monday is chosen to start with, and Thursday is added.
    const days = screen.getByRole('group', { name: 'On' });
    expect(within(days).getByRole('checkbox', { name: 'Mon' })).toHaveProperty('checked', true);
    await userEvent.click(within(days).getByRole('checkbox', { name: 'Thu' }));
    await choose(/At$/, '7:30 AM');
    // The person setting it up is on it already.
    expect(screen.getByRole('button', { name: 'Remove Ada' })).toBeDefined();
    const member = screen.getByRole('combobox', { name: 'Add a member of this database' });
    await userEvent.type(member, 'sam');
    await userEvent.click(await screen.findByRole('option', { name: /Sam Stone/ }));
    // The suggestions close after a pick, as other people pickers do, leaving the box empty.
    await waitFor(() => expect(screen.queryByRole('listbox', { name: /^Suggestions/ })).toBeNull());
    expect((member as HTMLInputElement).value).toBe('');
    expect(screen.getByText('Sam Stone')).toBeDefined();
    const outside = screen.getByRole('textbox', { name: 'Add an address outside the organization' });
    await userEvent.type(outside, 'not an address');
    await userEvent.click(screen.getByRole('button', { name: 'Add address' }));
    expect(screen.getByText('Enter an email address, like name@example.com.')).toBeDefined();
    await userEvent.clear(outside);
    await userEvent.type(outside, 'Partner@Elsewhere.example{Enter}');
    expect(screen.getByText('partner@elsewhere.example')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Set up report' }));

    await waitFor(() => expect(sent.some((request) => request.method === 'POST')).toBe(true));
    expect(sent.find((request) => request.method === 'POST')!.body).toEqual({
      name: 'Weekly pipeline',
      format: 'csv',
      frequency: { kind: 'weekly', days: [1, 4], at: '07:30' },
      timeZone: 'America/Denver',
      enabled: true,
      recipients: [
        { kind: 'member', userId: me.user.id },
        { kind: 'member', userId: sam.id },
        { kind: 'address', address: 'partner@elsewhere.example' },
      ],
    });
    const item = (await screen.findByText('Every Monday and Thursday at 7:30 AM', { exact: false })).closest(
      'li',
    )!;
    expect(item.textContent).toContain('(America/Denver)');
    expect(item.textContent).toContain('CSV file');
  });

  it('closes the member picker after the only member left is picked, rather than saying no one matches', async () => {
    start({ members: [sam] });
    await userEvent.click(await screen.findByRole('button', { name: 'Set up a report' }));
    const member = screen.getByRole('combobox', { name: 'Add a member of this database' });
    const suggestions = () => screen.queryByRole('listbox', { name: /^Suggestions/ });
    await userEvent.type(member, 'sam');
    await userEvent.click(await screen.findByRole('option', { name: /Sam Stone/ }));
    await waitFor(() => expect(suggestions()).toBeNull());
    expect(screen.queryByText('No matches')).toBeNull();
    expect(screen.getByRole('button', { name: 'Set up report' })).toBeDefined();

    // Taken off the list, they're offered again, and picking them again closes it the same way.
    await userEvent.click(screen.getByRole('button', { name: 'Remove Sam Stone' }));
    await userEvent.type(member, 'st');
    await userEvent.click(await screen.findByRole('option', { name: /Sam Stone/ }));
    await waitFor(() => expect(suggestions()).toBeNull());
    expect((member as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: 'Remove Sam Stone' })).toBeDefined();
  });

  it('lets someone who can only read send one to themselves alone', async () => {
    start({ canAddMembers: false, members: [], outsideAllowed: false });
    await userEvent.click(await screen.findByRole('button', { name: 'Set up a report' }));
    expect(
      screen.getByText(/It goes to you\.\s+People who can change this view can send it to others\./),
    ).toBeDefined();
    expect(screen.queryByRole('combobox', { name: 'Add a member of this database' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Add an address outside the organization' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Ada' }));
    await userEvent.click(screen.getByRole('button', { name: 'Set up report' }));
    expect(screen.getByText('Add at least one person to send it to.')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Send it to me' }));
    await choose(/How often/, 'Every month');
    await choose(/Day of the month/, '31');
    expect(screen.getByText('In a shorter month, it goes on the last day.')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Set up report' }));
    expect(await screen.findByText('Monthly on day 31 at 9:00 AM', { exact: false })).toBeDefined();
  });

  it('turns a report off, sends it now, shows its history, and deletes it', async () => {
    const { sent } = start({ reports: [schedule()] });
    const toggle = await screen.findByRole('switch', { name: 'Monday pipeline' });
    const item = screen.getByRole('listitem');
    expect(item.textContent).toContain('Every Monday and Thursday at 9:00 AM');
    expect(item.textContent).toContain('Ada and partner@elsewhere.example');
    expect(item.textContent).toContain('Next goes Oct 5, 2026, 9:00 AM');
    await userEvent.click(toggle);
    await waitFor(() =>
      expect(sent.find((request) => request.method === 'PUT')?.body).toMatchObject({ enabled: false }),
    );
    expect(sent.find((request) => request.method === 'PUT')!.body).toEqual({
      name: 'Monday pipeline',
      format: 'xlsx',
      frequency: { kind: 'weekly', days: [1, 4], at: '09:00' },
      timeZone: 'America/Denver',
      enabled: false,
      recipients: [
        { kind: 'member', userId: me.user.id },
        { kind: 'address', address: 'partner@elsewhere.example' },
      ],
    });

    await userEvent.click(screen.getByRole('button', { name: 'More for Monday pipeline' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Send now' }));
    expect(await screen.findByText('Sent Monday pipeline')).toBeDefined();

    await userEvent.click(screen.getByRole('button', { name: 'More for Monday pipeline' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'History' }));
    await screen.findByText('Sent to some', { exact: false });
    const history = screen.getByRole('dialog');
    expect(history.textContent).toContain('Every time Monday pipeline went, or tried to.');
    expect(history.textContent).toContain('4 tries');
    expect(history.textContent).toContain('42 records, with the file');
    expect(history.textContent).toContain('The mail server didn’t accept it. (EENVELOPE)');
    await userEvent.click(screen.getByRole('button', { name: 'Back to reports' }));

    await userEvent.click(await screen.findByRole('button', { name: 'More for Monday pipeline' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete this report?' });
    expect(confirm.textContent).toContain('Monday pipeline stops going to everyone at once.');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('No scheduled reports for this view yet.')).toBeDefined();
    expect(sent.some((request) => request.method === 'DELETE')).toBe(true);
  });

  it('says why a report turned itself off, and shows others’ reports without changing them', async () => {
    start({
      canAddMembers: false,
      reports: [
        schedule({ enabled: false, nextRunAt: null, stoppedBecause: 'reports.stopped.viewDeleted' }),
        schedule({
          id: 'rptBBBBBBBBBBBBBB',
          name: 'Team digest',
          owner: { id: sam.id, name: 'Sam Stone' },
          recipients: [],
          canEdit: false,
          canDelete: false,
        }),
      ],
    });
    const [mine, theirs] = await screen.findAllByRole('listitem');
    expect(mine!.textContent).toContain('Turned itself off. Its view, table, or database was deleted.');
    expect(within(theirs!).queryByRole('switch')).toBeNull();
    expect(within(theirs!).queryByRole('button', { name: 'More for Team digest' })).toBeNull();
    expect(theirs!.textContent).toContain('Set up bySam Stone');
  });
});
