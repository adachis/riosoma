import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '@riosoma/ui';
import { createGrid } from '../../../../packages/grid-core/src';
import type { GridSelection } from '../../../../packages/grid-core/src/types';
import { openDatabase } from '../data';
import { syncedFixture } from '../data/testing/synced';
import { i18n } from '../i18n';
import { createGridController } from './view/controller';
import { GridMenu } from './view/GridMenu';
import { renderShell } from '../screens/database/shell/test-support';
import { RecordCard } from '../screens/database/record/RecordCard';
import { FieldDialog } from '../screens/database/fields/FieldDialog';

const dispose: Array<() => void> = [];
afterEach(() => {
  cleanup();
  for (const close of dispose.splice(0)) close();
});
async function setup(allowOverrides = true) {
  i18n.load('en-US', {});
  i18n.activate('en-US');
  const fixture = syncedFixture(2);
  fixture.table.source!.allowOverrides = allowOverrides;
  const session = await openDatabase(fixture.fixture.databaseId, fixture.server.deps());
  dispose.push(() => session.close());
  const rows = session.openView(fixture.fixture.viewId);
  for (let i = 0; i < 80; i++) await Promise.resolve();
  const fields = session.getSchema().fields.get(fixture.fixture.tableId)!;
  const format = { locale: 'en-US', timeZone: 'UTC', collaborators: new Map() };
  const state = {
    session,
    rows,
    fields,
    format,
    table: fixture.table,
    view: fixture.database.schema.views[0]!,
    peers: [],
    onConfig: vi.fn(),
    onExpand: vi.fn(),
    onField: vi.fn(),
    onMenu: vi.fn(),
    onPreview: vi.fn(),
  };
  const abort = new AbortController();
  const controller = createGridController(state, abort.signal);
  dispose.push(() => {
    abort.abort();
    controller.destroy();
  });
  const selection: GridSelection = {
    active: { row: 0, col: 0 },
    range: { start: { row: 0, col: 0 }, end: { row: 0, col: 0 } },
    rows: { kind: 'none' },
  };
  const commands = () =>
    fixture.server.requests.flatMap((request) =>
      request.path.endsWith('/commands')
        ? (request.options.body as { commands: Array<{ kind: string }> }).commands
        : [],
    );
  return { ...fixture, session, rows, state, controller, abort, selection, commands, fields, format };
}
it('shows source headers, override marks and descriptions, and clears pooled cell marks', async () => {
  const f = await setup();
  const column = f.controller.columns()[0]!;
  const el = document.createElement('div');
  f.controller.host.renderHeader(el, column, 0);
  expect(el.title).toBe('From Warehouse, column name');
  expect(el.querySelector('.rio-synced-source')).not.toBeNull();
  expect(f.controller.host.commitText?.({ row: 0, col: 0 }, 'Local')).toBeNull();
  await waitFor(() => expect(f.rows.getRow(0)?.values[f.fixture.textFieldId]).toBe('Local'));
  f.controller.host.renderCell(el, {
    row: f.rows.getRow(0)!,
    column,
    rowIndex: 0,
    colIndex: 0,
    selected: true,
    active: true,
  });
  expect(el.classList.contains('rio-synced-override')).toBe(true);
  expect(el.title).toBe('Changed here.  The source says Record 1.');
  expect(f.controller.host.describeCell?.({ row: 0, col: 0 })).toContain(
    'Changed here.  The source says Record 1.',
  );
  f.controller.host.renderCell(el, {
    row: f.rows.getRow(1)!,
    column,
    rowIndex: 1,
    colIndex: 0,
    selected: false,
    active: false,
  });
  expect(el.classList.contains('rio-synced-override')).toBe(false);
  expect(el.title).toBe('');
});
it.each([false, true])(
  'clears %s multiple source cells through an accessible menu and offers no record insertion or deletion',
  async (many) => {
    const f = await setup();
    await f.session.run([
      {
        kind: 'record.update',
        tableId: f.fixture.tableId,
        records: [0, 1].map((index) => ({
          id: f.fixture.recordId(index),
          values: { [f.fixture.textFieldId]: 'Local' },
        })),
      },
    ]).done;
    if (many) f.selection.range!.end.row = 1;
    const node = document.createElement('div');
    document.body.append(node);
    const grid = createGrid(node, {
      host: f.controller.host,
      columns: f.controller.columns(),
      rowCount: 2,
      rowHeight: 32,
      frozenColumnCount: 0,
      label: 'Records',
    });
    dispose.push(() => {
      grid.destroy();
      node.remove();
    });
    grid.setSelection(f.selection);
    renderShell(
      <ConfirmProvider>
        <GridMenu
          state={f.state}
          target={{ kind: 'cell', cell: { row: 0, col: 0 } }}
          point={{ x: 0, y: 0 }}
          grid={grid}
          controller={f.controller}
          signal={f.abort.signal}
          onClose={vi.fn()}
          onFilter={vi.fn()}
        />
      </ConfirmProvider>,
    );
    expect(screen.queryByRole('menuitem', { name: /Delete record|Insert record/ })).toBeNull();
    const item = screen.getByRole('menuitem', {
      name: many ? 'Use the source values' : 'Use the source value',
    });
    item.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(f.rows.getRow(0)?.overrides).toEqual({}));
    expect(f.rows.getRow(1)?.overrides?.[f.fixture.textFieldId] !== undefined).toBe(!many);
    expect(f.commands()).toContainEqual(expect.objectContaining({ kind: 'record.clearOverrides' }));
  },
);
it('blocks source editors, toggle and clear when overrides are off, while paste edits local fields and never extends the table', async () => {
  const f = await setup(false);
  expect(f.controller.columns()[0]?.edit).toBe('none');
  expect(f.controller.host.describeCell?.({ row: 0, col: 0 })).toContain(
    'This comes from the source, and this table doesn’t allow changes to source values.',
  );
  f.controller.host.commitText?.({ row: 0, col: 0 }, 'Denied');
  f.controller.host.toggle?.({ row: 0, col: 0 });
  f.controller.addRow(2);
  await f.controller.clear(f.selection);
  await f.controller.paste(f.selection, { text: 'Denied\t10\nDenied\t20\nDenied\t30', html: null });
  await waitFor(() => expect(f.rows.getRow(1)?.values[f.fixture.numberFieldId]).toBe(20));
  expect(f.rows.getRow(0)?.values[f.fixture.textFieldId]).toBe('Record 1');
  expect(f.rows.rowCount()).toBe(2);
  expect(f.commands().some((command) => command.kind === 'record.create')).toBe(false);
});
it('shows the record card override and its clear button and prevents editing locked source fields', async () => {
  const f = await setup(false);
  const row = {
    ...f.rows.getRow(0)!,
    overrides: { [f.fixture.textFieldId]: { source: null, by: null, at: '' } },
  };
  f.database.rows(f.fixture.tableId).set(row);
  const onChange = vi.fn();
  renderShell(
    <RecordCard
      session={f.session}
      fields={f.fields}
      primaryFieldId={f.fixture.textFieldId}
      row={row}
      format={f.format}
      readOnly={false}
      canEditOptions={true}
      position={null}
      onChange={onChange}
      onAddOption={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  expect(screen.getByText('Changed here. The source says nothing.')).toBeDefined();
  expect(screen.queryByRole('textbox', { name: f.fields[0]!.name })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Use the source value' }));
  await waitFor(() =>
    expect(f.commands()).toContainEqual(expect.objectContaining({ kind: 'record.clearOverrides' })),
  );
  expect(onChange).not.toHaveBeenCalled();
});
it('refuses source type conversion but keeps renaming available', async () => {
  const f = await setup();
  const onSubmit = vi.fn();
  renderShell(
    <FieldDialog
      mode="edit"
      initial={f.fields[0]!}
      existingNames={f.fields.map((field) => field.name)}
      onSubmit={onSubmit}
      onCancel={vi.fn()}
      isSaving={false}
    />,
  );
  expect(screen.getByRole('button', { name: /Type/ }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByText('Source fields keep the type their source gives them.')).toBeDefined();
  await userEvent.clear(screen.getByRole('textbox', { name: 'Name' }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Renamed');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'Renamed', spec: { type: 'text', options: {} } }),
  );
});

it('explains source cells on keyboard focus and hover with a dismissible tooltip', async () => {
  const { SourceHint } = await import('../screens/database/synced/SourceHint');
  const root = document.createElement('div');
  root.tabIndex = 0;
  const cell = document.createElement('div');
  cell.dataset.active = '';
  cell.dataset.syncedDescription = 'Changed here.  The source says Original.';
  root.append(cell);
  document.body.append(root);
  dispose.push(() => root.remove());
  renderShell(<SourceHint container={{ current: root }} />);
  root.focus();
  expect(await screen.findByRole('tooltip')).toBeDefined();
  expect(screen.getByRole('tooltip').textContent).toBe('Changed here.  The source says Original.');
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  await userEvent.hover(cell);
  expect(await screen.findByRole('tooltip')).toBeDefined();
});

it('updates the source hint when the pointer moves within a cell after an override arrives', async () => {
  const { SourceHint } = await import('../screens/database/synced/SourceHint');
  const root = document.createElement('div');
  const cell = document.createElement('div');
  cell.dataset.syncedDescription = '';
  root.append(cell);
  document.body.append(root);
  dispose.push(() => root.remove());
  renderShell(<SourceHint container={{ current: root }} />);
  await userEvent.hover(cell);
  expect(screen.queryByRole('tooltip')).toBeNull();
  // Saving an edit decorates the existing DOM cell without another pointer entry.
  cell.dataset.syncedDescription = 'Changed here.  The source says Original.';
  fireEvent.pointerMove(cell);
  expect((await screen.findByRole('tooltip')).textContent).toBe('Changed here.  The source says Original.');
});
