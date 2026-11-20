import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FilterGroup, Sort } from '@riosoma/contracts';
import { RioApiError, RioClient, RioClientError, type RioRecord } from './index.js';
import { EVERY_SCOPE, startApiServer, type TestApiServer } from './test/server.js';

/**
 * The client against a real server.  Everything here goes over HTTP to a Riosoma server on a port
 * of this machine, with a real token and a real database, so what passes is what a caller's code
 * does, not what a stand-in was told to answer.
 */

let api: TestApiServer;

beforeAll(async () => {
  api = await startApiServer({ prefix: 'sdkclient' });
}, 120_000);

afterAll(async () => {
  await api?.close();
});

const names = (records: readonly RioRecord[]) => records.map((record) => record.fields.Name);

describe('the schema a caller reads first', () => {
  it('lists the databases a token reaches, with the caller’s own role in each', async () => {
    const databases = await api.client().databases.list();
    expect(databases.map((database) => database.id)).toContain(api.databaseId);
    expect(databases.find((database) => database.id === api.databaseId)).toMatchObject({
      name: 'SDK records',
      role: 'owner',
    });
  });

  it('lists a database’s tables with the fields and views a read needs IDs from', async () => {
    const tables = await api.client().tables.list(api.databaseId);
    expect(tables).toHaveLength(1);
    const table = tables[0]!;
    expect(table.id).toBe(api.tableId);
    expect(table.name).toBe('Records');
    expect(table.primaryFieldId).toBe(api.fields.Name!.id);
    expect(table.fields.map((field) => field.name)).toEqual(['Name', 'Amount', 'Status', 'Notes', 'Due']);
    expect(table.fields.find((field) => field.name === 'Status')?.type).toBe('singleSelect');
    expect(table.views.map((view) => view.name)).toEqual(['Grid']);
  });

  it('finds a table, a field, and a view by name, which is what a script says', async () => {
    const client = api.client();
    expect((await client.tables.get(api.databaseId, 'Records')).id).toBe(api.tableId);
    expect((await client.fields.get(api.databaseId, 'Records', 'Amount')).type).toBe('number');
    expect((await client.fields.list(api.databaseId, api.tableId)).map((field) => field.name)).toContain(
      'Due',
    );
    expect((await client.views.get(api.tableId, 'Grid')).tableId).toBe(api.tableId);
    await expect(client.tables.get(api.databaseId, 'Nothing')).rejects.toThrow(RioClientError);
  });

  it('reads the API’s own document with no credential at all', async () => {
    const document = await new RioClient({ baseUrl: api.baseUrl }).openapi();
    expect(document.openapi).toBe('3.1.0');
    expect(Object.keys(document.paths as Record<string, unknown>)).toContain(
      '/api/v1/tables/{tableId}/records',
    );
  });

  it('reaches a route it has no method for through `request`', async () => {
    const created = await api.client().records.create(api.tableId, [{ fields: { Name: 'Locked' } }]);
    const recordId = created.ids[0]!;
    const locked = await api
      .client()
      .request<{ recordIds: string[]; locked: boolean }>(
        'PUT',
        `/api/v1/tables/${api.tableId}/records/locks`,
        { body: { recordIds: [recordId], locked: true, reason: 'a test holds it' } },
      );
    expect(locked).toMatchObject({ recordIds: [recordId], locked: true });
  });
});

describe('records', () => {
  it('creates records and reads back what the server made of them', async () => {
    const client = api.client();
    const created = await client.records.create(api.tableId, [
      { fields: { Name: 'First', Amount: 10, Status: 'Open', Due: '2026-03-01' } },
      { fields: { Name: 'Second', Amount: 20, Status: 'Done' } },
    ]);
    expect(created.ids).toHaveLength(2);
    expect(created.records[0]!.id).toMatch(/^rec[0-9A-Za-z]{14}$/);
    expect(created.records[0]!.createdTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(created.records[0]!.fields).toMatchObject({ Name: 'First', Amount: 10, Status: 'Open' });
    // A write answers with the group that undoes it, so a caller can offer that.
    expect(created.undoGroupId).toMatch(/^act[0-9A-Za-z]{14}$/);

    const read = await client.records.get(api.tableId, created.ids[0]!);
    expect(read.fields).toMatchObject({ Name: 'First', Due: '2026-03-01' });
  });

  it('changes only the fields a record names, and replaces the ones it leaves out', async () => {
    const client = api.client();
    const created = await client.records.create(api.tableId, [
      { fields: { Name: 'Patch', Amount: 1, Notes: 'kept' } },
    ]);
    const recordId = created.ids[0]!;
    const patched = await client.records.update(api.tableId, [{ id: recordId, fields: { Amount: 2 } }]);
    expect(patched.records[0]!.fields).toMatchObject({ Name: 'Patch', Amount: 2, Notes: 'kept' });

    const replaced = await client.records.replace(api.tableId, [{ id: recordId, fields: { Amount: 3 } }]);
    expect(replaced.records[0]!.fields).toMatchObject({ Name: null, Amount: 3, Notes: null });
  });

  it('moves records to the trash and says what they held', async () => {
    const client = api.client();
    const created = await client.records.create(api.tableId, [{ fields: { Name: 'Trashed' } }]);
    const removed = await client.records.delete(api.tableId, created.ids);
    expect(names(removed.records)).toEqual(['Trashed']);
    await expect(client.records.get(api.tableId, created.ids[0]!)).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
  });

  it('merges records on a key field, making the ones that match nothing', async () => {
    const client = api.client();
    await client.records.create(api.tableId, [{ fields: { Name: 'Merge', Amount: 1 } }]);
    const first = await client.records.upsert(
      api.tableId,
      [{ fields: { Name: 'Merge', Amount: 2 } }, { fields: { Name: 'Fresh', Amount: 3 } }],
      { databaseId: api.databaseId, keys: ['Name'] },
    );
    expect(first.updated).toHaveLength(1);
    expect(first.created).toHaveLength(1);
    expect(first.records.map((record) => record.fields.Name).sort()).toEqual(['Fresh', 'Merge']);

    const merged = await client.records.list(api.tableId, {
      filter: {
        conjunction: 'and',
        conditions: [{ id: 'c1', fieldId: api.fields.Name!.id, operator: 'is', value: 'Merge' }],
      },
    });
    expect(merged.records).toHaveLength(1);
    expect(merged.records[0]!.fields.Amount).toBe(2);

    // A record that names an ID is changed, whatever the keys say.
    const second = await client.records.upsert(
      api.tableId,
      [{ id: first.created[0]!, fields: { Amount: 9 } }],
      { databaseId: api.databaseId, keys: ['Name'] },
    );
    expect(second.updated).toEqual([first.created[0]]);
    await expect(
      client.records.upsert(api.tableId, [{ fields: { Name: 'x' } }], {
        databaseId: api.databaseId,
        keys: [],
      }),
    ).rejects.toThrow(RioClientError);
  });

  it('filters, sorts, and pages, and iterates every page of a read', async () => {
    const client = api.client();
    const made = await client.records.create(
      api.tableId,
      Array.from({ length: 12 }, (_, index) => ({
        fields: {
          Name: `Page ${String(index).padStart(2, '0')}`,
          Amount: index,
          Status: index % 2 ? 'Done' : 'Open',
        },
      })),
    );
    expect(made.ids).toHaveLength(12);

    const amount = api.fields.Amount!.id;
    const status = api.fields.Status!.id;
    const name = api.fields.Name!.id;
    const sort: Sort[] = [{ fieldId: amount, direction: 'desc' }];
    const filter: FilterGroup = {
      conjunction: 'and',
      conditions: [
        // Only this test's own records, since the table holds what the tests before it wrote.
        { id: 'c1', fieldId: name, operator: 'contains', value: 'Page ' },
        { id: 'c2', fieldId: status, operator: 'is', value: 'Done' },
        { id: 'c3', fieldId: amount, operator: 'gte', value: 5 },
      ],
    };
    const page = await client.records.list(api.tableId, { filter, sort, pageSize: 2 });
    expect(page.records.map((record) => record.fields.Amount)).toEqual([11, 9]);
    expect(page.next).toBeTruthy();

    // The same read, page by page, holds one order from its first page to its last, and the last
    // page carries no cursor, which is what ends the loop.
    const all: number[] = [];
    let pages = 0;
    for await (const next of client.records.pages(api.tableId, { filter, sort, pageSize: 2 })) {
      pages += 1;
      expect(next.records.length).toBeLessThanOrEqual(2);
      all.push(...next.records.map((record) => record.fields.Amount as number));
    }
    expect(pages).toBe(2);
    expect(all).toEqual([11, 9, 7, 5]);

    const seen: string[] = [];
    for await (const record of client.records.iterate(api.tableId, { filter, sort, pageSize: 2 }))
      seen.push(record.fields.Name as string);
    expect(seen).toEqual(['Page 11', 'Page 09', 'Page 07', 'Page 05']);
  });

  it('stops paging when a caller stops reading', async () => {
    let calls = 0;
    const client = api.client({
      fetch: (url, init) => {
        calls += 1;
        return fetch(url, init);
      },
    });
    const iterator = client.records.iterate(api.tableId, { pageSize: 2 });
    const first = await iterator.next();
    expect(first.value?.id).toBeTruthy();
    expect(calls).toBe(1);
    // A caller that breaks out of the loop asks for no further page, so none is fetched.
    await iterator.return(undefined);
    expect(calls).toBe(1);
  });

  it('reads values as the app shows them, and keys fields by ID', async () => {
    const client = api.client();
    const created = await client.records.create(api.tableId, [
      { fields: { Name: 'Text', Amount: 1234.5, Due: '2026-07-04', Status: 'Open' } },
    ]);
    const text = await client.records.get(api.tableId, created.ids[0]!, { cellFormat: 'string' });
    expect(text.fields.Amount).toBe('1,234.5');
    expect(text.fields.Due).toBe('Jul 4, 2026');

    const byId = await client.records.get(api.tableId, created.ids[0]!, { fieldKey: 'id' });
    expect(byId.fields[api.fields.Amount!.id]).toBe(1234.5);
    expect(byId.fields.Name).toBeUndefined();

    const narrow = await client.records.list(api.tableId, { fields: ['Name'], pageSize: 1 });
    expect(Object.keys(narrow.records[0]!.fields)).toEqual(['Name']);
  });

  it('takes a whole write back with the group it answered with', async () => {
    const client = api.client();
    const created = await client.records.create(api.tableId, [{ fields: { Name: 'Undone' } }]);
    await api.command({
      kind: 'record.trash',
      tableId: api.tableId,
      recordIds: created.ids,
    });
    await expect(client.records.get(api.tableId, created.ids[0]!)).rejects.toMatchObject({ status: 404 });
  });
});

describe('failures a caller can act on', () => {
  it('says which field a value was refused for', async () => {
    const client = api.client();
    const failure = await client.records
      .create(api.tableId, [{ fields: { Name: 'Bad', Amount: 'not a number' } }])
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RioApiError);
    const error = failure as RioApiError;
    expect(error.status).toBe(422);
    expect(error.code).toBe('validation_failed');
    expect(error.messageKey).toBeTruthy();
    expect(error.message.length).toBeGreaterThan(0);
    expect(error.issues?.[0]?.fieldId ?? error.params?.fieldId ?? error.params?.field).toBeTruthy();
  });

  it('answers not found for a table a token can’t reach', async () => {
    const client = api.client();
    await expect(client.records.list(`tbl${'0'.repeat(14)}`)).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
  });

  it('refuses a write a token has no scope for, and says which scope it needs', async () => {
    const readOnly = await api.session<{ token: string }>({
      url: '/api/tokens',
      payload: { name: 'Read only', scopes: ['data.records:read'], databases: 'all' },
    });
    const client = api.client({ token: readOnly.token });
    expect((await client.records.list(api.tableId, { pageSize: 1 })).records).toBeDefined();
    await expect(client.records.create(api.tableId, [{ fields: { Name: 'No' } }])).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
      messageKey: 'errors.tokenScope',
    });
  });

  it('refuses a write of more records than one request carries, before it sends anything', async () => {
    const client = api.client();
    const records = Array.from({ length: 1_001 }, (_, index) => ({ fields: { Name: `Row ${index}` } }));
    await expect(client.records.create(api.tableId, records)).rejects.toThrow(RioClientError);
    await expect(client.records.update(api.tableId, [{ fields: { Name: 'No ID' } }])).rejects.toThrow(
      RioClientError,
    );
    await expect(client.records.delete(api.tableId, [])).rejects.toThrow(RioClientError);
  });

  it('stops a call a caller gave up on', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = api.client();
    const failure = await client.records
      .list(api.tableId, { signal: controller.signal })
      .catch((error: unknown) => error);
    expect((failure as Error).name).toBe('AbortError');
  });

  it('needs an address that a request can be sent to', () => {
    expect(() => new RioClient({ baseUrl: 'not an address', token: 'rio_pat_x' })).toThrow(RioClientError);
    expect(() => new RioClient({ baseUrl: 'ftp://riosoma.example.com' })).toThrow(RioClientError);
    expect(() => new RioClient({ baseUrl: api.baseUrl, token: 'x', accessToken: 'y' })).toThrow(
      RioClientError,
    );
    expect(new RioClient({ baseUrl: `${api.baseUrl}/` }).baseUrl).toBe(api.baseUrl);
  });

  it('keeps every scope a token was given, and says which kind of credential is in use', async () => {
    const client = api.client();
    expect(client.credential).toMatchObject({ kind: 'token' });
    expect(new RioClient({ baseUrl: api.baseUrl }).credential).toMatchObject({ kind: 'none' });
    expect(EVERY_SCOPE).toContain('schema.bases:write');
  });
});
