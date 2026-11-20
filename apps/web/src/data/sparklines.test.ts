import { afterEach, expect, it } from 'vitest';
import {
  GridConfig,
  Sparkline,
  newId,
  sparklineKey,
  sparklineValues,
  type RowsPage,
} from '@riosoma/contracts';
import { openDatabase } from './session';
import { FakeServer } from './testing';
import { relationalFixture, settle } from './testing/relational';
import type { DatabaseSession } from './types';

const sessions: DatabaseSession[] = [];
afterEach(() => sessions.splice(0).forEach((session) => session.close()));

it('keeps two loaded views of a rollup independent and invalidates sources after linked edits', async () => {
  const server = new FakeServer();
  const f = relationalFixture(server);
  const first = Sparkline.parse({ fieldId: f.rollup.id });
  const second = Sparkline.parse({ fieldId: f.rollup.id, order: { fieldId: f.price.id, direction: 'desc' } });
  const secondViewId = newId('view');
  const schema = f.database.schema;
  schema.views = schema.views.map((view) =>
    view.id === f.source.viewId ? { ...view, config: GridConfig.parse({ sparklines: [first] }) } : view,
  );
  schema.views.push({
    ...schema.views[0]!,
    id: secondViewId,
    config: GridConfig.parse({ sparklines: [second] }),
  });
  let points = [1, 2];
  server.afterRequest = async (request, answer) => {
    if (!request.path.includes('/rows')) return;
    const setting = request.path.includes(secondViewId) ? second : first;
    const values = setting === second ? [...points].reverse() : points;
    const page = answer as RowsPage;
    page.rows = page.rows.map(
      (row) => row && { ...row, sparklineValues: { [sparklineKey(setting)]: values } },
    );
  };
  const session = await openDatabase(f.source.databaseId, server.deps());
  sessions.push(session);
  const a = session.openView(f.source.viewId);
  await settle();
  expect(sparklineValues(a.getRow(0)!, f.rollup, first)).toEqual([1, 2]);
  const b = session.openView(secondViewId);
  await settle();
  expect(sparklineValues(b.getRow(0)!, f.rollup, second)).toEqual([2, 1]);
  expect(sparklineValues(a.getRow(0)!, f.rollup, first)).toEqual([1, 2]);

  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.beforeRequest = (request) =>
    request.path.includes(`/views/${secondViewId}/rows`) ? wait : Promise.resolve();
  points = [9, 2];
  server.remote(f.source.databaseId, [
    {
      kind: 'record.update',
      tableId: f.tableId,
      records: [{ id: f.recordIds[0]!, values: { [f.price.id]: 9 } }],
    },
  ]);
  await settle();
  expect(sparklineValues(a.getRow(0)!, f.rollup, first)).toEqual([9, 2]);
  expect(sparklineValues(b.getRow(0)!, f.rollup, second)).toEqual([]);
  release();
  await settle();
  expect(sparklineValues(b.getRow(0)!, f.rollup, second)).toEqual([2, 9]);
  expect(sparklineValues(a.getRow(0)!, f.rollup, first)).toEqual([9, 2]);
});
