import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DatabaseRole } from '@riosoma/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../data';
import { useSchema } from '../data/hooks';
import { FakeServer } from '../data/testing';
import type { DatabaseSession, ViewRows } from '../data/types';
import { i18n } from '../i18n';
import { useViewConfig } from '../screens/database/screen/useViewConfig';
import { renderShell } from '../screens/database/shell/test-support';
import { GridView } from './GridView';
import { seedTable } from './test-support';
import { attachment, MockUpload } from '../files/testing';

/**
 * The document these tests run in lays nothing out, so the grid is given a size to draw into:
 * its scroller reports one, and every observer of sizes hears about it at once.
 */
const layout = {
  width: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')!,
  height: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')!,
};
beforeEach(() => {
  i18n.load('en-US', {});
  i18n.activate('en-US');
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly callback: (entries: readonly ResizeObserverEntry[]) => void) {}
      observe() {
        queueMicrotask(() => this.callback([]));
      }
      unobserve() {}
      disconnect() {}
    },
  );
  const sized = (size: number, original: PropertyDescriptor) => ({
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('rio-grid__scroller') ? size : original.get!.call(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', sized(1400, layout.width));
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', sized(400, layout.height));
});

const dispose: Array<() => void> = [];
afterEach(() => {
  cleanup();
  for (const close of dispose.splice(0)) close();
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', layout.width);
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', layout.height);
  vi.unstubAllGlobals();
});

/** The grid as the database screen shows it, drawn again whenever the schema changes. */
function Grid({
  session,
  rows,
  viewId,
  tableId,
}: {
  session: DatabaseSession;
  rows: ViewRows;
  viewId: string;
  tableId: string;
}) {
  const schema = useSchema(session)!;
  const view = schema.viewById.get(viewId)!;
  const fields = schema.fields.get(tableId)!;
  const { config, change } = useViewConfig(session, view, fields);
  return (
    <GridView
      session={session}
      rows={rows}
      table={schema.tableById.get(tableId)!}
      view={{ ...view, config }}
      fields={fields}
      format={{ locale: 'en-US', timeZone: 'UTC', collaborators: schema.collaborators }}
      peers={[]}
      onConfig={change}
      onExpand={vi.fn()}
      onField={vi.fn()}
      onFilter={vi.fn()}
    />
  );
}

/** Three crew members' grid, opened by someone with the role given. */
async function open(role: DatabaseRole, canEditLockedRecord?: boolean, withFiles = false) {
  const server = new FakeServer();
  const fixture = seedTable(
    server,
    [{ name: 'Name', type: 'text' }, ...(withFiles ? [{ name: 'Files', type: 'attachment' as const }] : [])],
    3,
    (index, [name]) => ({
      [name!]: ['Mara', 'Tomas', 'Iris'][index]!,
    }),
  );
  fixture.database.schema.database.role = role;
  if (canEditLockedRecord !== undefined) {
    const records = fixture.database.rows(fixture.tableId);
    records.set({
      ...records.get(fixture.recordId(1))!,
      lock: { manual: true, reason: 'Reviewed', canEdit: canEditLockedRecord },
    });
  }
  const session = await openDatabase(fixture.databaseId, server.deps());
  const rows = session.openView(fixture.viewId);
  dispose.push(() => {
    rows.close();
    session.close();
  });
  for (let i = 0; i < 80; i++) await Promise.resolve();
  const view = renderShell(
    <Grid session={session} rows={rows} viewId={fixture.viewId} tableId={fixture.tableId} />,
  );
  const grid = await screen.findByRole('grid');
  await screen.findByRole('gridcell', { name: 'Tomas' });
  const input = view.container.querySelector<HTMLTextAreaElement>('.rio-grid-view__engine textarea')!;
  /** The owner changes this person's role, and their open tab reloads what they may do. */
  async function becomes(next: DatabaseRole) {
    fixture.database.schema.database.role = next;
    await act(async () => {
      server.dropSubscriptions(fixture.databaseId, 'accessChanged');
      for (let i = 0; i < 80; i++) await Promise.resolve();
    });
  }
  /** Tries to start changing the second name by typing over it. */
  async function typeOverTomas() {
    await userEvent.click(screen.getByRole('gridcell', { name: 'Tomas' }));
    input.focus();
    await userEvent.keyboard('H');
    return input.hasAttribute('data-editing');
  }
  return { grid, input, becomes, typeOverTomas, session, fixture };
}

it('shows file-drop permissions before release and uploads only after an allowed drop', async () => {
  MockUpload.install();
  const { grid, becomes, fixture } = await open('reader', undefined, true);
  const cell = grid.querySelector<HTMLElement>('[role="gridcell"][data-rio-row="0"][data-rio-col="1"]')!;
  expect(cell).not.toBeNull();
  const transfer = { types: ['Files'], files: [new File(['Draft'], 'Draft.txt')], dropEffect: 'none' };
  fireEvent.dragOver(cell, { dataTransfer: transfer });
  expect(cell.getAttribute('data-file-drop')).toBe('refused');
  expect(screen.getByText('You cannot add files to this cell.')).toBeDefined();
  fireEvent.drop(cell, { dataTransfer: transfer });
  expect(MockUpload.requests).toHaveLength(0);
  await becomes('editor');
  fireEvent.dragOver(cell, { dataTransfer: transfer });
  expect(cell.getAttribute('data-file-drop')).toBe('ready');
  expect(MockUpload.requests).toHaveLength(0);
  fireEvent.drop(cell, { dataTransfer: transfer });
  await waitFor(() => expect(MockUpload.requests).toHaveLength(1));
  const file = attachment('Draft.txt', 'text/plain');
  await act(async () => {
    MockUpload.requests[0]!.respond(file);
  });
  await waitFor(() =>
    expect(fixture.database.rows(fixture.tableId).get(fixture.recordId(0))?.values[fixture.ids[1]!]).toEqual([
      file.id,
    ]),
  );
});

describe('a grid open while its person’s role changes', () => {
  it.each([false, true])('honors record lock editing permission %s when typing', async (canEdit) => {
    const view = await open('editor', canEdit);
    expect(await view.typeOverTomas()).toBe(canEdit);
  });

  it('can be edited at once when a commenter is made an editor', async () => {
    const view = await open('commenter');
    expect(view.grid.getAttribute('aria-readonly')).toBe('true');
    expect(await view.typeOverTomas()).toBe(false);

    await view.becomes('editor');
    await waitFor(() => expect(view.grid.getAttribute('aria-readonly')).toBe('false'));
    expect(await view.typeOverTomas()).toBe(true);
  });

  it('turns read only at once, ending an edit under way, when an editor is made a commenter', async () => {
    const view = await open('editor');
    expect(view.grid.getAttribute('aria-readonly')).toBe('false');
    expect(await view.typeOverTomas()).toBe(true);

    await view.becomes('commenter');
    await waitFor(() => expect(view.grid.getAttribute('aria-readonly')).toBe('true'));
    expect(view.input.hasAttribute('data-editing')).toBe(false);
    expect(await view.typeOverTomas()).toBe(false);
  });
});

it('announces a read-only record move before a keyboard drop', async () => {
  await open('reader');
  const handle = screen.getAllByRole('button', { name: 'Move record' })[0]!;
  handle.focus();
  await userEvent.keyboard(' [ArrowDown]');
  await waitFor(() =>
    expect(document.querySelector('.rio-grid__drag-hint')?.textContent).toContain('You do not have access'),
  );
  await userEvent.keyboard('{Escape}');
  expect(document.querySelector('.rio-grid__drag-hint')?.hasAttribute('hidden')).toBe(true);
});

it('announces a locked record before a keyboard drop', async () => {
  await open('creator', false);
  const handle = screen.getAllByRole('button', { name: 'Move record' })[1]!;
  handle.focus();
  await userEvent.keyboard(' [ArrowDown]');
  await waitFor(() =>
    expect(document.querySelector('.rio-grid__drag-hint')?.textContent).toContain('This record is locked'),
  );
  await userEvent.keyboard('{Escape}');
});
