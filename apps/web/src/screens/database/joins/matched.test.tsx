import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newId, type FieldMeta, type FieldSpec } from '@riosoma/contracts';
import { openDatabase, type DatabaseSession } from '../../../data';
import { FakeServer } from '../../../data/testing';
import { relationalFixture, settle } from '../../../data/testing/relational';
import { createGridController } from '../../../grid/view/controller';
import { i18n } from '../../../i18n';
import { FieldDialog } from '../fields/FieldDialog';
import { renderField, selectOption } from '../fields/fieldTestUtils';
import { RecordCard } from '../record/RecordCard';
import { renderShell } from '../shell/test-support';

const dispose: Array<() => void> = [];
afterEach(() => {
  cleanup();
  for (const close of dispose.splice(0)) close();
});

const tooltip = 'These links follow matching values, so they change when the values do.';

describe('the link setting to follow matching values', () => {
  it('offers fields that can hold keys on both sides and saves the match', async () => {
    const server = new FakeServer();
    const f = relationalFixture(server);
    const session = await openDatabase(f.source.databaseId, server.deps());
    dispose.push(() => session.close());
    const id = newId('field');
    let saving = Promise.resolve({ applied: 0, rejected: 0 });
    const submit = vi.fn(({ name, spec }: { name: string; spec: FieldSpec }) => {
      saving = session.run([
        { kind: 'field.create', tableId: f.source.tableId, field: { id, name, ...spec } },
      ]).done;
    });
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
    await selectOption('Link to$', 'Projects');
    await userEvent.click(screen.getByRole('switch', { name: 'Link by matching values' }));
    const create = screen.getByRole('button', { name: 'Create field' });
    // Both fields have to be chosen first.
    expect(create.hasAttribute('disabled')).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: /This table’s field/ }));
    const own = screen.getAllByRole('option').map((option) => option.textContent);
    expect(own).toEqual(['Name', 'Number']);
    await userEvent.click(screen.getByRole('option', { name: 'Number' }));
    await userEvent.click(screen.getByRole('button', { name: /Matches this field in the linked table/ }));
    const linked = screen.getAllByRole('option').map((option) => option.textContent);
    expect(linked).toEqual(['Title', 'Price']);
    await userEvent.click(screen.getByRole('option', { name: 'Price' }));
    await userEvent.click(create);
    expect(submit).toHaveBeenCalledOnce();
    expect(await saving).toEqual({ applied: 1, rejected: 0 });
    expect(server.database(f.source.databaseId).field(id).options).toMatchObject({
      linkedTableId: f.tableId,
      match: { fieldId: f.source.numberFieldId, linkedFieldId: f.price.id },
    });
  });

  it('turns off, keeping the link to the same table', async () => {
    const server = new FakeServer();
    const f = relationalFixture(server);
    const onSubmit = vi.fn();
    const initial = {
      ...f.link,
      options: { ...f.link.options, match: { fieldId: f.source.numberFieldId, linkedFieldId: f.price.id } },
    } as FieldMeta;
    const session = await openDatabase(f.source.databaseId, server.deps());
    dispose.push(() => session.close());
    renderField(
      <FieldDialog
        mode="edit"
        schema={session.getSchema()}
        initial={initial}
        existingNames={[]}
        isSaving={false}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    const toggle = screen.getByRole('switch', { name: 'Link by matching values' });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('button', { name: /This table’s field/ }).textContent).toContain('Number');
    await userEvent.click(toggle);
    expect(screen.queryByRole('button', { name: /This table’s field/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    const spec = onSubmit.mock.calls[0]![0].spec as FieldSpec;
    expect(spec.type === 'link' && spec.options).toEqual({
      linkedTableId: f.tableId,
      inverseFieldId: f.inverse.id,
      prefersSingle: false,
    });
  });
});

/** The relational fixture with its link following Number and Price, opened in a grid controller. */
async function matchedGrid() {
  i18n.load('en-US', {});
  i18n.activate('en-US');
  const server = new FakeServer();
  const f = relationalFixture(server);
  const match = { fieldId: f.source.numberFieldId, linkedFieldId: f.price.id };
  f.database.schema.fields = f.database.schema.fields.map((field) =>
    field.type === 'link' && field.id === f.link.id
      ? { ...field, options: { ...field.options, match } }
      : field,
  );
  const session: DatabaseSession = await openDatabase(f.source.databaseId, server.deps());
  dispose.push(() => session.close());
  const rows = session.openView(f.source.viewId);
  await settle();
  await waitFor(() => expect(rows.getRow(0)).toBeDefined());
  const fields = session.getSchema().fields.get(f.source.tableId)!;
  const format = { locale: 'en-US', timeZone: 'UTC', collaborators: new Map() };
  const abort = new AbortController();
  const controller = createGridController(
    {
      session,
      rows,
      fields,
      format,
      table: session.getSchema().tableById.get(f.source.tableId)!,
      view: session.getSchema().viewById.get(f.source.viewId)!,
      peers: [],
      onConfig: vi.fn(),
      onExpand: vi.fn(),
      onField: vi.fn(),
      onMenu: vi.fn(),
      onPreview: vi.fn(),
    },
    abort.signal,
  );
  dispose.push(() => {
    abort.abort();
    controller.destroy();
  });
  const col = controller.columns().findIndex((column) => column.id === f.link.id);
  const commands = () =>
    server.requests.flatMap((request) =>
      request.path.endsWith('/commands')
        ? (request.options.body as { commands: Array<{ kind: string }> }).commands
        : [],
    );
  return { f, session, rows, fields, format, controller, col, commands };
}

describe('cells of links that follow matching values', () => {
  it('show their links, open no editor, explain why, and ignore typing, deleting, and pasting', async () => {
    const g = await matchedGrid();
    const column = g.controller.columns()[g.col]!;
    expect(column.edit).toBe('none');
    const el = document.createElement('div');
    g.controller.host.renderCell(el, {
      row: g.rows.getRow(0)!,
      column,
      rowIndex: 0,
      colIndex: g.col,
      selected: true,
      active: true,
    });
    expect(el.title).toBe(tooltip);
    expect(el.dataset.syncedDescription).toBe(tooltip);
    expect(el.textContent).not.toBe('');
    expect(g.controller.host.describeCell?.({ row: 0, col: g.col })).toContain(tooltip);
    expect(g.controller.host.commitText?.({ row: 0, col: g.col }, 'Gamma')).toBeNull();
    const selection = {
      active: { row: 0, col: g.col },
      range: { start: { row: 0, col: g.col }, end: { row: 0, col: g.col } },
      rows: { kind: 'none' as const },
    };
    await g.controller.clear(selection);
    await g.controller.paste(selection, { text: 'Gamma', html: null });
    await settle();
    expect(g.commands()).toEqual([]);
    expect(g.rows.getRow(0)!.values[g.f.link.id]).toEqual(g.f.recordIds.slice(0, 2));
  });

  it('read as fixed in the record card, with the same explanation', async () => {
    const g = await matchedGrid();
    const onChange = vi.fn();
    renderShell(
      <RecordCard
        session={g.session}
        fields={g.fields}
        primaryFieldId={g.f.source.textFieldId}
        row={g.rows.getRow(0)!}
        format={g.format}
        readOnly={false}
        canEditOptions={true}
        position={null}
        onChange={onChange}
        onAddOption={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(tooltip)).toBeDefined();
    expect(within(dialog).queryByRole('button', { name: 'Link a record' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /^Remove / })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
