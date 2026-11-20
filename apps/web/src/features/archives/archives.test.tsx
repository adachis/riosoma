import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newId, type DatabaseCopy, type SnapshotMeta, type TemplateSummary } from '@riosoma/contracts';
import { failure, json, renderSharing } from '../../screens/database/share/testing';
import { TemplatePicker } from '../../screens/home/TemplatePicker';
import { DuplicateDialog } from './DuplicateDialog';
import { SnapshotsDialog } from './SnapshotsDialog';
import { CopyProgress } from './CopyProgress';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));

const DATABASE = newId('database');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function snapshot(overrides: Partial<SnapshotMeta> = {}): SnapshotMeta {
  return {
    id: newId('snapshot'),
    name: 'Before the launch',
    kind: 'manual',
    createdBy: 'user_ada',
    createdAt: '2026-09-20T15:30:00.000Z',
    size: 2_560,
    tables: 2,
    records: 42,
    ...overrides,
  };
}

function copy(overrides: Partial<DatabaseCopy> = {}): DatabaseCopy {
  return {
    id: newId('job'),
    kind: 'snapshot',
    name: 'Projects (restored)',
    databaseId: null,
    state: 'queued',
    progress: { phase: null, tables: 0, tablesDone: 0, records: 0, recordsDone: 0 },
    version: 1,
    error: null,
    report: null,
    createdAt: '2026-09-27T12:00:00.000Z',
    finishedAt: null,
    ...overrides,
  };
}

const people = new Map([['user_ada', { name: 'Ada' }]]);

it('names copied link fields whose values were left empty because their target is unavailable', () => {
  renderSharing(
    <CopyProgress
      copy={copy({
        state: 'finished',
        report: {
          tables: 1,
          fields: 2,
          views: 1,
          records: 1,
          comments: 0,
          dashboards: 0,
          interfaces: 0,
          automations: 0,
          attachments: 0,
          missingAttachments: 0,
          syncedTables: 0,
          unsyncedTables: 0,
          droppedValues: 0,
          emptyLinkFields: [
            {
              fieldId: newId('field'),
              tableName: 'Projects',
              fieldName: 'Contact',
              reason: 'targetUnavailable',
            },
          ],
        },
      })}
      onChange={() => undefined}
    />,
  );
  expect(screen.getByRole('status').textContent).toContain(
    'Projects → Contact was copied with empty values because you cannot read its destination table.',
  );
});

describe('the snapshots dialog', () => {
  it('lists snapshots, takes one by name, and restores one as a new database', async () => {
    const newDatabase = newId('database');
    const manual = snapshot();
    const automatic = snapshot({
      kind: 'automatic',
      name: '',
      createdBy: null,
      records: 40,
      size: 3 * 1024 ** 2,
    });
    const listed = [manual, automatic];
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const started = copy();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options?: RequestInit) => {
        const method = options?.method ?? 'GET';
        const body: unknown = options?.body ? JSON.parse(String(options.body)) : undefined;
        requests.push({ method, url, body });
        if (url === `/api/databases/${DATABASE}/snapshots` && method === 'GET')
          return json({ snapshots: listed });
        if (url === `/api/databases/${DATABASE}/snapshots`) {
          const taken = snapshot({ name: (body as { name: string }).name });
          listed.unshift(taken);
          return json(taken);
        }
        if (url.endsWith('/restore')) return json(started);
        if (url.startsWith(`/api/database-copies/${started.id}`))
          return json(
            copy({
              ...started,
              state: 'finished',
              databaseId: newDatabase,
              version: 9,
              report: {
                tables: 2,
                fields: 12,
                views: 4,
                records: 42,
                comments: 3,
                dashboards: 1,
                interfaces: 0,
                automations: 2,
                attachments: 5,
                missingAttachments: 1,
                syncedTables: 0,
                unsyncedTables: 0,
                droppedValues: 0,
              },
            }),
          );
        return failure('errors.notFound', 404);
      }),
    );
    const onClose = vi.fn();
    renderSharing(
      <SnapshotsDialog databaseId={DATABASE} databaseName="Projects" people={people} onClose={onClose} />,
    );
    const list = await screen.findByRole('list', { name: 'Snapshots' });
    const items = within(list).getAllByRole('listitem');
    expect(items[0]!.textContent).toContain('Before the launch');
    expect(items[0]!.textContent).toContain('by Ada');
    expect(items[0]!.textContent).toContain('42 records');
    expect(items[0]!.textContent).toContain('2.5 kB');
    expect(items[1]!.textContent).toContain('Automatic snapshot');
    expect(items[1]!.textContent).toContain('3 MB');

    await userEvent.type(screen.getByRole('textbox', { name: 'Snapshot name' }), 'After the launch');
    await userEvent.click(screen.getByRole('button', { name: 'Take a snapshot' }));
    await screen.findByText('After the launch');
    expect(requests.find((request) => request.method === 'POST')!.body).toEqual({ name: 'After the launch' });

    await userEvent.click(screen.getByRole('button', { name: 'More for Before the launch' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Restore as a new database' }));
    const name = screen.getByRole('textbox', { name: 'New database name' });
    expect((name as HTMLInputElement).value).toBe('Projects (restored)');
    await userEvent.click(screen.getByRole('button', { name: 'Restore as a new database' }));
    await screen.findByText('Made Projects (restored) with 2 tables and 42 records.');
    expect(
      screen.getByText('Its 2 automations are turned off, so nothing runs until you turn them on.'),
    ).toBeTruthy();
    expect(
      screen.getByText('1 file was left out because it was deleted after the snapshot was taken.'),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Open the new database' }));
    expect(onClose).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith({ to: `/${newDatabase}` });
  });

  it('deletes a snapshot once the person confirms, and says why a copy is refused', async () => {
    const only = snapshot();
    let deleted = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options?: RequestInit) => {
        const method = options?.method ?? 'GET';
        if (method === 'DELETE') {
          deleted = true;
          return json({ deleted: true });
        }
        if (url.endsWith('/restore')) return failure('archives.restricted', 403);
        return json({ snapshots: deleted ? [] : [only] });
      }),
    );
    renderSharing(
      <SnapshotsDialog databaseId={DATABASE} databaseName="Projects" people={people} onClose={vi.fn()} />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'More for Before the launch' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Restore as a new database' }));
    await userEvent.click(screen.getByRole('button', { name: 'Restore as a new database' }));
    await screen.findByText(/You can’t see every table and field in this database/);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(await screen.findByRole('button', { name: 'More for Before the launch' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete snapshot' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Before the launch?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete snapshot' }));
    await screen.findByText('No snapshots yet.');
    expect(deleted).toBe(true);
  });
});

describe('duplicating', () => {
  it('asks for a name and whether to bring the records', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options?: RequestInit) => {
        if (options?.body) bodies.push(JSON.parse(String(options.body)));
        if (url.endsWith('/duplicate')) return json(copy({ kind: 'duplicate', name: 'Budget copy' }));
        return json(copy({ kind: 'duplicate', name: 'Budget copy', state: 'running', version: 2 }));
      }),
    );
    renderSharing(<DuplicateDialog databaseId={DATABASE} databaseName="Budget" onClose={vi.fn()} />);
    expect((screen.getByRole('textbox', { name: 'New database name' }) as HTMLInputElement).value).toBe(
      'Budget copy',
    );
    await userEvent.click(screen.getByRole('checkbox', { name: 'Include records, files, and comments' }));
    await userEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    await screen.findByText(/The copy keeps going/);
    expect(bodies[0]).toEqual({ name: 'Budget copy', withRecords: false });
    expect(screen.getByRole('button', { name: 'Open the new database' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('organization templates in the picker', () => {
  const own: TemplateSummary = {
    id: newId('template'),
    name: 'Team tracker',
    description: 'How our team tracks things',
    icon: 'table',
    color: 'blue',
    category: 'work',
    tables: ['Items'],
    organization: { createdBy: 'user_ada', createdAt: '2026-09-20T00:00:00.000Z', samples: 2 },
  };
  const builtIn: TemplateSummary = {
    id: 'project-tracker',
    name: 'Project tracker',
    description: 'Projects and tasks',
    icon: 'list-check',
    color: 'green',
    category: 'work',
    tables: ['Projects', 'Tasks'],
  };

  it('shows them first, and lets an admin remove one', async () => {
    let removed = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, options?: RequestInit) => {
        if (options?.method === 'DELETE') {
          removed = true;
          return json({ deleted: true });
        }
        return json(removed ? [builtIn] : [own, builtIn]);
      }),
    );
    renderSharing(<TemplatePicker selected={null} onSelect={vi.fn()} disabled={false} canRemove />);
    const section = await screen.findByRole('region', { name: 'From your organization' });
    expect(within(section).getByRole('button', { name: /^Team tracker/ })).toBeTruthy();
    await userEvent.click(within(section).getByRole('button', { name: 'Remove Team tracker' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove Team tracker?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove template' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'From your organization' })).toBeNull());
  });

  it('offers no way to remove one to people who aren’t admins', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json([own, builtIn])),
    );
    renderSharing(<TemplatePicker selected={null} onSelect={vi.fn()} disabled={false} />);
    await screen.findByRole('region', { name: 'From your organization' });
    expect(screen.queryByRole('button', { name: 'Remove Team tracker' })).toBeNull();
  });
});
