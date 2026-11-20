import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { newId, type LinkTarget } from '@riosoma/contracts';
import { api } from '../../../api';
import type * as ApiModule from '../../../api';
import { FakeServer } from '../../../data/testing';
import { relationalFixture } from '../../../data/testing/relational';
import { openDatabase, type DatabaseSession } from '../../../data';
import { LinkPicker } from '../../../grid/editors/LinkEditor';
import { FieldDialog } from './FieldDialog';
import { renderField, selectOption } from './fieldTestUtils';

vi.mock('../../../api', async (original) => ({
  ...(await original<typeof ApiModule>()),
  api: vi.fn(),
}));
const sessions: DatabaseSession[] = [];
afterEach(() => {
  cleanup();
  sessions.splice(0).forEach((session) => session.close());
  vi.clearAllMocks();
});

async function setup(canEditSchema: boolean) {
  const server = new FakeServer();
  const f = relationalFixture(server);
  const session = await openDatabase(f.source.databaseId, server.deps());
  sessions.push(session);
  const target: LinkTarget = {
    table: {
      ...session.getSchema().tables[0]!,
      id: newId('table'),
      databaseId: newId('database'),
      name: 'People',
    },
    database: { id: newId('database'), name: 'Customer directory' },
    canEditSchema,
  };
  const otherDatabaseId = newId('database');
  const sameName: LinkTarget = {
    ...target,
    table: { ...target.table, id: newId('table'), databaseId: otherDatabaseId, name: 'Other people' },
    database: { ...target.database, id: otherDatabaseId },
  };
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === '/api/link-targets') return [target, sameName] as never;
    if (path === `/api/databases/${target.database.id}/schema`)
      return { tables: [target.table], fields: [], views: [] } as never;
    return target as never;
  });
  return { f, session, target };
}

it.each([true, false])(
  'filters tables grouped by database and saves the permitted link direction (%s)',
  async (canEditSchema) => {
    const { f, session, target } = await setup(canEditSchema);
    const submit = vi.fn();
    renderField(
      <FieldDialog
        mode="create"
        schema={session.getSchema()}
        tableId={f.source.tableId}
        existingNames={[]}
        isSaving={false}
        onSubmit={submit}
        onCancel={() => {}}
      />,
    );
    await selectOption('Type', 'Link to another record');
    await userEvent.click(screen.getByRole('button', { name: /Link to$/ }));
    await userEvent.type(screen.getByRole('searchbox'), 'People');
    await waitFor(() => expect(screen.getByRole('listbox').textContent).toContain('Customer directory'));
    expect(screen.getAllByRole('group', { name: 'Customer directory' })).toHaveLength(2);
    await userEvent.click(await screen.findByRole('option', { name: 'People' }));
    if (!canEditSchema) expect(screen.getByText(/This link will appear only in this table/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Create field' }));
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0]![0].spec.options).toMatchObject({
      linkedTableId: target.table.id,
      inverseFieldId: null,
    });
    expect(submit.mock.calls[0]![0].spec.options.oneWay).toBe(canEditSchema ? undefined : true);
  },
);

it('searches the destination through the session and identifies its database in the record picker', async () => {
  const { f, session, target } = await setup(false);
  if (f.link.type !== 'link') throw new Error('Missing link');
  const recordId = newId('record');
  const search = vi.spyOn(session, 'searchLinkChoices').mockResolvedValue({
    records: [{ id: recordId, name: 'Morgan', values: {} }],
    fields: [],
    hasMore: false,
    canCreate: false,
  });
  const change = vi.fn();
  renderField(
    <LinkPicker
      field={{ ...f.link, options: { ...f.link.options, linkedTableId: target.table.id, oneWay: true } }}
      selected={[]}
      session={session}
      format={{ locale: 'en-US', timeZone: 'UTC', collaborators: new Map() }}
      onChange={change}
    />,
  );
  expect(await screen.findByText('Records from Customer directory')).toBeTruthy();
  await userEvent.type(screen.getByRole('searchbox'), 'Morgan');
  await waitFor(() =>
    expect(search).toHaveBeenLastCalledWith(
      f.link.id,
      { query: 'Morgan', recordId: undefined, values: {} },
      expect.any(AbortSignal),
    ),
  );
  await userEvent.click(await screen.findByRole('option', { name: 'Morgan' }));
  expect(change).toHaveBeenCalledExactlyOnceWith([recordId]);
});

it.each(['Lookup', 'Rollup'])('selects external target fields when creating a %s', async (type) => {
  const { f, session } = await setup(true);
  const local = session.getSchema();
  const table = local.tableById.get(f.tableId)!;
  const target = { table, database: { id: newId('database'), name: 'Directory' }, canEditSchema: true };
  const external = {
    fields: local.fields.get(f.tableId),
    tables: [table],
    views: local.views.get(f.tableId),
  };
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === `/api/tables/${f.tableId}/link-target`) return target as never;
    if (path === `/api/databases/${target.database.id}/schema`) return external as never;
    throw new Error(`Unexpected request: ${path}`);
  });
  const sourceSchema = {
    ...local,
    tables: local.tables.filter((item) => item.id !== f.tableId),
    tableById: new Map([...local.tableById].filter(([id]) => id !== f.tableId)),
    fields: new Map([...local.fields].filter(([id]) => id !== f.tableId)),
    fieldById: new Map([...local.fieldById].filter(([, field]) => field.tableId !== f.tableId)),
  };
  const submit = vi.fn();
  renderField(
    <FieldDialog
      mode="create"
      schema={sourceSchema}
      tableId={f.source.tableId}
      existingNames={[]}
      isSaving={false}
      onSubmit={submit}
      onCancel={() => {}}
    />,
  );
  await selectOption('Type', type);
  await userEvent.type(screen.getByRole('textbox', { name: /^Name$/ }), 'External amount');
  await selectOption(type === 'Lookup' ? 'Field to look up' : 'Field to summarize', 'Price');
  if (type === 'Rollup') await selectOption('Summary', 'Sum');
  await userEvent.click(screen.getByRole('button', { name: 'Create field' }));
  expect(submit).toHaveBeenCalledOnce();
  expect(submit.mock.calls[0]![0].spec.options).toMatchObject({
    targetFieldId: f.price.id,
    resultType: 'number',
  });
});
