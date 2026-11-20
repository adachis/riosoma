import { afterEach, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { FakeServer } from '../data/testing';
import { openGrid } from './test-support';
import type { GridState } from './view/controller';

const dispose: Array<() => void> = [];
afterEach(() => dispose.splice(0).forEach((close) => close()));

it('follows arrow navigation and only delivers the newest selected record', async () => {
  const server = new FakeServer();
  const fixture = server.createDatabase(1_000);
  const app = await openGrid(server, fixture);
  dispose.push(app.close);
  const schema = app.session.getSchema();
  const selected = vi.fn();
  const state: GridState = {
    session: app.session,
    rows: app.rows,
    table: schema.tableById.get(fixture.tableId)!,
    view: schema.viewById.get(fixture.viewId)!,
    fields: schema.fields.get(fixture.tableId)!,
    format: { locale: 'en-US', timeZone: 'UTC', collaborators: schema.collaborators },
    peers: [],
    onConfig: vi.fn(),
    onExpand: vi.fn(),
    onField: vi.fn(),
    onMenu: vi.fn(),
    onPreview: vi.fn(),
    onSelectRecord: selected,
  };
  app.controller.update(state);
  const select = (row: number) =>
    app.grid.setSelection({
      active: { row, col: 0 },
      range: null,
      rows: { kind: 'none' },
    });
  select(0);
  await waitFor(() => expect(selected).toHaveBeenLastCalledWith(fixture.recordId(0)));
  app.grid.focus();
  app.press('ArrowDown');
  await waitFor(() => expect(selected).toHaveBeenLastCalledWith(fixture.recordId(1)));
  app.press('ArrowUp');
  await waitFor(() => expect(selected).toHaveBeenLastCalledWith(fixture.recordId(0)));
  selected.mockClear();
  select(800);
  select(2);
  await waitFor(() => expect(selected).toHaveBeenCalledOnce());
  expect(selected).toHaveBeenLastCalledWith(fixture.recordId(2));
  await waitFor(() => expect(app.rows.getRow(800)).toBeTruthy());
  expect(selected).toHaveBeenCalledOnce();
  app.controller.update({ ...state, onSelectRecord: undefined });
  select(3);
  await Promise.resolve();
  expect(selected).toHaveBeenCalledOnce();
});
