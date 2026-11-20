import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '@riosoma/ui';
import type { RowData } from '@riosoma/contracts';
import type { GridApi, GridSelection } from '../../../../packages/grid-core/src/types';
import { openDatabase } from '../data';
import { FakeServer } from '../data/testing';
import { i18n } from '../i18n';
import { renderShell } from '../screens/database/shell/test-support';
import { seedTable } from './test-support';
import { createGridController } from './view/controller';
import { GridMenu } from './view/GridMenu';

const dispose: Array<() => void> = [];
afterEach(() => {
  cleanup();
  for (const close of dispose.splice(0)) close();
});

/**
 * A view with `pins` pinned records of which the rows draw `drawn`, which is what a filter that
 * excludes some of them leaves on screen: the rest stay saved and still count toward the limit.
 */
async function setup(pins: number, drawn: number, records = 24) {
  i18n.load('en-US', {});
  i18n.activate('en-US');
  const server = new FakeServer();
  const fixture = seedTable(
    server,
    [
      { name: 'Name', type: 'text' },
      { name: 'Amount', type: 'number' },
    ],
    records,
    (index, ids) => ({ [ids[0]!]: `Record ${index}`, [ids[1]!]: index }),
  );
  const session = await openDatabase(fixture.databaseId, server.deps());
  const rows = session.openView(fixture.viewId);
  for (let index = 0; index < 80; index++) await Promise.resolve();
  const schema = session.getSchema();
  const view = schema.viewById.get(fixture.viewId)!;
  view.config.pinnedRecordIds = Array.from({ length: pins }, (_, index) => fixture.recordId(index));
  rows.pinnedCount = () => drawn;
  const onConfig = vi.fn();
  const state = {
    session,
    rows,
    fields: schema.fields.get(fixture.tableId)!,
    table: schema.tableById.get(fixture.tableId)!,
    view,
    format: { locale: 'en-US', timeZone: 'UTC', collaborators: schema.collaborators },
    peers: [],
    onConfig,
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
    rows.close();
    session.close();
  });
  const menu = (row: number) => {
    const selection: GridSelection = {
      active: { row, col: 0 },
      range: { start: { row, col: 0 }, end: { row, col: 0 } },
      rows: { kind: 'none' },
    };
    const grid = { getSelection: () => selection } as unknown as GridApi<RowData>;
    renderShell(
      <ConfirmProvider>
        <GridMenu
          state={state}
          target={{ kind: 'cell', cell: { row, col: 0 } }}
          point={{ x: 0, y: 0 }}
          grid={grid}
          controller={controller}
          signal={abort.signal}
          onClose={vi.fn()}
          onFilter={vi.fn()}
        />
      </ConfirmProvider>,
    );
  };
  return { state, onConfig, menu, recordId: fixture.recordId };
}

it('says how many pins the view does not draw and offers to unpin them', async () => {
  const f = await setup(20, 10);
  f.menu(22);
  const pin = screen.getByRole('menuitem', { name: /^Pin record(?: |$)/ });
  expect(pin.getAttribute('aria-disabled')).toBe('true');
  expect(pin.textContent).toContain('10 pinned records are not shown in this view');
  await userEvent.click(screen.getByRole('menuitem', { name: /^Unpin the 10 records not shown(?: |$)/ }));
  await waitFor(() =>
    expect(f.onConfig).toHaveBeenCalledWith({
      pinnedRecordIds: Array.from({ length: 10 }, (_, index) => f.recordId(index)),
    }),
  );
});

it('pins as usual while every pin is drawn', async () => {
  const f = await setup(3, 3);
  f.menu(22);
  const pin = screen.getByRole('menuitem', { name: /^Pin record(?: |$)/ });
  expect(pin.getAttribute('aria-disabled')).not.toBe('true');
  expect(pin.textContent).not.toContain('not shown in this view');
  expect(screen.queryByRole('menuitem', { name: /not shown/ })).toBeNull();
  await userEvent.click(pin);
  await waitFor(() =>
    expect(f.onConfig).toHaveBeenCalledWith({
      pinnedRecordIds: [0, 1, 2, 22].map((index) => f.recordId(index)),
    }),
  );
});
