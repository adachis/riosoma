import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CURRENT_PERSON,
  FieldMeta,
  type Collaborator,
  type DatabaseSchema,
  type RowData,
  type TableMeta,
  type TablePermissions,
} from '@riosoma/contracts';
import type { DatabaseSession } from '../../../data';
import { SchemaModel } from '../../../data/state';
import { createHeaderRenderer } from '../../../grid/cells/header';
import { createCellRenderer } from '../../../grid/cells/renderers';
import { json, renderSharing } from '../share/testing';
import { FieldSelect } from '../view/FieldSelect';
import { FieldPermissionsDialog } from './FieldPermissionsDialog';
import { RecordAccessDialog } from './RecordAccessDialog';
import { RestrictedFields } from './restricted';

const TABLE = 'tbl00000000000001';
const LINKED = 'tbl00000000000002';
const ada = 'usr00000000000001';
const sam = 'usr00000000000002';
const collaborators = new Map<string, Collaborator>([
  [ada, { id: ada, name: 'Ada', email: 'ada@example.com' }],
  [sam, { id: sam, name: 'Sam', email: 'sam@example.com' }],
]);

function field(index: number, type: string, name: string, options: object = {}): FieldMeta {
  return FieldMeta.parse({
    id: `fld${String(index).padStart(14, '0')}`,
    tableId: TABLE,
    name,
    description: '',
    position: index,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    type,
    options,
  });
}

const name = field(1, 'text', 'Name');
const salary = field(2, 'number', 'Salary');
const owner = field(3, 'user', 'Owner');
const team = field(4, 'link', 'Team', { linkedTableId: LINKED });
const table: TableMeta = {
  id: TABLE,
  databaseId: 'db00000000000001',
  name: 'People',
  description: '',
  primaryFieldId: name.id,
  position: 0,
  createdAt: '2026-09-28T00:00:00.000Z',
  updatedAt: '2026-09-28T00:00:00.000Z',
};

function permissions(overrides: Partial<TablePermissions> = {}): TablePermissions {
  return { tableId: TABLE, fields: [], records: [], ...overrides };
}

/** A fetch that answers the table's permissions and records what was saved. */
function server(initial: TablePermissions) {
  let current = initial;
  const saved: Array<{ url: string; body: unknown }> = [];
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'PUT') {
      const body = JSON.parse(options.body as string) as Record<string, unknown>;
      saved.push({ url, body });
      current = url.includes('record-rules')
        ? { ...current, records: body.rules as TablePermissions['records'] }
        : current;
      return json(current);
    }
    if (url === `/api/tables/${TABLE}/permissions`) return json(current);
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return { saved };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('FieldPermissionsDialog', () => {
  it('restricts a field to a role and saves it', async () => {
    const { saved } = server(permissions());
    const onClose = vi.fn();
    renderSharing(<FieldPermissionsDialog field={salary} collaborators={collaborators} onClose={onClose} />);
    expect(await screen.findByRole('dialog', { name: 'Permissions for Salary' })).toBeDefined();
    await userEvent.click(await screen.findByRole('switch', { name: /Restrict who can see this field/ }));
    const who = screen.getByRole('group', { name: 'Who can see this field' });
    await userEvent.click(within(who, 'checkbox', 'Editor'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(saved).toEqual([
      {
        url: `/api/fields/${salary.id}/permissions`,
        body: { restricted: { roles: ['editor'], users: [] }, locked: null },
      },
    ]);
  });

  it('shows the lock a field has and removes it', async () => {
    const { saved } = server(
      permissions({
        fields: [{ fieldId: salary.id, restricted: null, locked: { roles: [], users: [sam] } }],
      }),
    );
    renderSharing(<FieldPermissionsDialog field={salary} collaborators={collaborators} onClose={() => {}} />);
    const lock = await screen.findByRole('switch', { name: /Lock who can change its values/ });
    await waitFor(() => expect((lock as HTMLInputElement).checked).toBe(true));
    expect(screen.getByText('Sam')).toBeDefined();
    await userEvent.click(lock);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]!.body).toEqual({ restricted: null, locked: null });
  });
});

function within(container: HTMLElement, role: 'checkbox', name: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>(`[role="${role}"], input[type="${role}"]`)].find(
    (element) => element.closest('label')?.textContent?.includes(name),
  );
  if (!found) throw new Error(`No ${role} named ${name}`);
  return found;
}

describe('RecordAccessDialog', () => {
  const session = { linked: new Map(), searchRecords: async () => [] } as unknown as DatabaseSession;

  it('lists the rules, keeps a rule from saving until it’s complete, and saves the list', async () => {
    const rule = {
      id: 'rul00000000000001',
      roles: ['editor' as const],
      users: [],
      condition: {
        conjunction: 'and' as const,
        conditions: [
          { id: 'mine', fieldId: owner.id, operator: 'hasAnyOf' as const, value: [CURRENT_PERSON] },
        ],
      },
    };
    const { saved } = server(permissions({ records: [rule] }));
    const onClose = vi.fn();
    renderSharing(
      <RecordAccessDialog
        session={session}
        table={table}
        fields={[name, owner]}
        collaborators={collaborators}
        onClose={onClose}
      />,
    );
    expect(await screen.findByRole('dialog', { name: 'Record access for People' })).toBeDefined();
    expect(await screen.findByText('Rule 1')).toBeDefined();
    // The current person reads as themselves, not as an ID.
    expect(screen.getAllByText('Current person').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    expect(
      screen.getByText('Each rule needs at least one role or person and at least one condition.'),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
    // The lock settings' button has a name of its own, so a query for Save finds one button.
    expect(screen.getByRole('button', { name: 'Apply record locks' })).toBeDefined();
    await userEvent.click(screen.getAllByRole('button', { name: 'Remove rule' })[1]!);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(saved).toEqual([{ url: `/api/tables/${TABLE}/record-rules`, body: { rules: [rule] } }]);
  });
});

describe('restricted fields in the grid', () => {
  const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
  const t = i18n._.bind(i18n);

  it('marks restricted and locked fields in their headers for the people who can see them', () => {
    const renderer = createHeaderRenderer({
      fieldsById: new Map([[salary.id, salary]]),
      primaryFieldId: name.id,
      access: () =>
        new Map([[salary.id, { fieldId: salary.id, restricted: true, locked: true, editable: false }]]),
      t,
    });
    const parent = document.createElement('div');
    parent.setAttribute('role', 'columnheader');
    const el = document.createElement('div');
    parent.append(el);
    renderer(el, { id: salary.id, width: 120, edit: 'none' }, 0);
    const marks = [...el.querySelectorAll<HTMLElement>('.rio-permission-mark')].map((mark) => mark.title);
    expect(marks).toEqual([
      'Locked: only some people can change this field',
      'Restricted: only some people can see this field',
    ]);
    expect(parent.getAttribute('aria-description')).toContain('Locked');
    expect(el.textContent).toBe('Salary');
  });

  it('shows linked records a rule hides as “Hidden record”, with nothing about them', () => {
    const renderer = createCellRenderer({
      fieldsById: new Map([[team.id, team]]),
      format: {
        locale: 'en-US',
        timeZone: 'UTC',
        collaborators: new Map(),
        linked: new Map([['rec00000000000009', 'Alpha']]),
      },
      rowHeight: 'short',
    });
    const row: RowData = {
      id: 'rec00000000000001',
      values: { [team.id]: ['rec00000000000009'] },
      hiddenLinks: { [team.id]: 2 },
      createdAt: '',
      createdBy: null,
      updatedAt: '',
      updatedBy: null,
    };
    const el = document.createElement('div');
    renderer(el, {
      row,
      rowIndex: 0,
      column: { id: team.id, width: 300, edit: 'none' },
      colIndex: 0,
      selected: false,
      active: false,
    });
    const pills = [...el.querySelectorAll('.rio-choice-pill')].map((pill) => pill.textContent);
    expect(pills).toEqual(['Alpha', 'Hidden record', 'Hidden record']);
  });

  it('names a field someone can’t see only as “Restricted field”', () => {
    const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
    render(
      <I18nProvider i18n={i18n}>
        <RestrictedFields.Provider value={new Set([salary.id])}>
          <FieldSelect fields={[name]} value={salary.id} onChange={() => {}} />
        </RestrictedFields.Provider>
      </I18nProvider>,
    );
    expect(screen.getAllByText('Restricted field').length).toBeGreaterThan(0);
    expect(screen.queryByText('Salary')).toBeNull();
  });
});

describe('the schema’s access', () => {
  it('turns what the server says into maps, and empty ones when it says nothing', () => {
    const schema: DatabaseSchema = {
      database: {
        id: 'db00000000000001',
        name: 'Company',
        description: '',
        icon: null,
        color: null,
        createdBy: null,
        createdAt: '',
        updatedAt: '',
        role: 'editor',
      },
      tables: [table],
      fields: [name],
      views: [],
      collaborators: [...collaborators.values()],
      access: {
        hiddenFields: [{ id: salary.id, tableId: TABLE, position: 2 }],
        fields: [{ fieldId: name.id, restricted: false, locked: true, editable: false }],
        limitedTables: [TABLE],
        ruledTables: [],
      },
      seq: 3,
    };
    const model = new SchemaModel(schema);
    model.apply({ kind: 'access.changed' });
    const access = model.clone().snapshot().access;
    expect([...access.hiddenFields.keys()]).toEqual([salary.id]);
    expect(access.fields.get(name.id)?.editable).toBe(false);
    expect(access.limitedTables.has(TABLE)).toBe(true);
    const plain = new SchemaModel({ ...schema, access: undefined }).snapshot().access;
    expect(plain.hiddenFields.size + plain.fields.size + plain.limitedTables.size).toBe(0);
  });
});
