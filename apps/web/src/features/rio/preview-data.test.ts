import { afterEach, expect, it, vi } from 'vitest';
import type { RioPlanPreview } from '@riosoma/contracts';
import { FakeServer } from '../../data/testing';
import { openDatabase } from '../../data/session';
import { MemoryOutboxStore } from '../../data/outbox';
import { beginSandbox, endSandbox } from '../../data/sandbox';
import { previewHttp } from './preview-data';

afterEach(() => {
  endSandbox();
  vi.restoreAllMocks();
});

it('serves sampled rows, record labels, and complete summary values from the snapshot', async () => {
  const server = new FakeServer();
  const fixture = server.createDatabase(2);
  const database = server.database(fixture.databaseId);
  const rows = [0, 1].map((index) => database.rows(fixture.tableId).get(fixture.recordId(index))!);
  const snapshot: RioPlanPreview = {
    schema: database.schema,
    dashboards: {},
    interfaces: {},
    records: {},
    views: { [fixture.viewId]: { kind: 'records', rows, total: 2000 } },
    aggregates: { [fixture.viewId]: { kind: 'summary', records: 2000, values: {} } },
    rowLimit: 1000,
    targets: [fixture.viewId],
  };
  const fetch = vi.spyOn(globalThis, 'fetch');
  const http = previewHttp(snapshot);
  expect(await http(`/api/views/${fixture.viewId}/rows?offset=1&limit=1`)).toMatchObject({
    total: 2,
    rows: [rows[1]],
  });
  expect(await http(`/api/tables/${fixture.tableId}/records/${rows[0]!.id}`)).toEqual(rows[0]);
  expect(await http(`/api/tables/${fixture.tableId}/records/names`, { method: 'POST' })).toEqual(
    Object.fromEntries(rows.map((row) => [row.id, row.values[fixture.textFieldId]])),
  );
  expect(
    await http(`/api/databases/${fixture.databaseId}/views/${fixture.viewId}/aggregate`, {
      method: 'POST',
      body: { timeZone: 'UTC', summary: true },
    }),
  ).toEqual(snapshot.aggregates![fixture.viewId]);
  expect(fetch).not.toHaveBeenCalled();
});

it('reads preview data without a request and discards local edits', async () => {
  const server = new FakeServer();
  const fixture = server.createDatabase(2);
  const schema = server.database(fixture.databaseId).schema;
  const snapshot: RioPlanPreview = {
    schema,
    dashboards: {},
    interfaces: {},
    records: {},
    views: {},
    rowLimit: 1000,
    targets: [],
  };
  const fetch = vi.spyOn(globalThis, 'fetch');
  const http = previewHttp(snapshot);
  beginSandbox();
  const session = await openDatabase(fixture.databaseId, {
    http,
    userId: server.userId,
    outbox: new MemoryOutboxStore(),
    webSocketFactory: () => ({
      send: () => undefined,
      close: () => undefined,
      addEventListener: () => undefined,
    }),
  });
  try {
    await session.run([{ kind: 'table.update', tableId: fixture.tableId, name: 'Preview name' }]).done;
    expect(session.getSchema().tableById.get(fixture.tableId)?.name).toBe('Preview name');
    expect(snapshot.schema.tables[0]!.name).not.toBe('Preview name');
    expect(session.canUndo()).toBe(false);
    await expect(http('/api/databases/unknown/commands', { method: 'POST', body: {} })).rejects.toMatchObject(
      { info: { messageKey: 'errors.notFound' } },
    );
    expect(fetch).not.toHaveBeenCalled();
    endSandbox();
    expect(session.getSchema().tableById.get(fixture.tableId)?.name).toBe(schema.tables[0]!.name);
  } finally {
    session.close();
  }
});

it('preserves sampled group boundaries and pinned rows when paging a view preview', async () => {
  const server = new FakeServer();
  const fixture = server.createDatabase(3);
  const database = server.database(fixture.databaseId);
  const rows = [0, 1, 2].map((index) => database.rows(fixture.tableId).get(fixture.recordId(index))!);
  const groups = [
    { key: 'alpha', level: 1, start: 1, count: 2, values: { [fixture.textFieldId]: 'Alpha' }, summaries: {} },
  ];
  const snapshot: RioPlanPreview = {
    schema: database.schema,
    dashboards: {},
    interfaces: {},
    records: {},
    views: {
      [fixture.viewId]: { kind: 'records', rows, total: 3000, groups, pinnedCount: 1 },
    },
    rowLimit: 200,
    targets: [fixture.viewId],
  };
  const http = previewHttp(snapshot);
  expect(await http(`/api/views/${fixture.viewId}/rows?offset=2&limit=1`)).toMatchObject({
    total: 3,
    offset: 2,
    rows: [rows[2]],
    groups,
    pinnedCount: 1,
  });
});
