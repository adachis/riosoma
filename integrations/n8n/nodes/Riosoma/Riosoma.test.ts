import { NodeApiError, NodeOperationError, type IDataObject } from 'n8n-workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADDRESS, executeContext } from '../../test/fake-context';
import { DATABASE_ID, FakeRiosoma, FIELDS, TABLE_ID } from '../../test/fake-riosoma';
import { getColumns, getMatchFields } from './methods';
import { Riosoma } from './Riosoma.node';

const locators = {
  database: { __rl: true, mode: 'list', value: DATABASE_ID },
  table: { __rl: true, mode: 'id', value: TABLE_ID },
};

async function run(
  api: FakeRiosoma,
  parameters: Record<string, unknown>,
  items?: IDataObject[],
  continueOnFail?: boolean,
) {
  const context = executeContext(api, { ...locators, ...parameters }, items, continueOnFail);
  const [output] = await new Riosoma().execute.call(context);
  return output!;
}

let api: FakeRiosoma;
beforeEach(() => {
  api = new FakeRiosoma();
});

describe('databases and tables', () => {
  it('lists databases, and tables with their fields and views', async () => {
    const databases = await run(api, { resource: 'database', operation: 'getAll' });
    expect(databases.map((item) => item.json.name)).toEqual(['Sales']);
    const tables = await run(api, { resource: 'table', operation: 'getAll' });
    expect(tables[0]!.json).toMatchObject({
      id: TABLE_ID,
      name: 'Orders',
      fields: expect.arrayContaining([{ id: FIELDS.count.id, name: 'Count', type: 'number' }]),
      views: [{ id: 'viwAll00000000000', name: 'All orders', type: 'grid' }],
    });
  });
});

describe('search', () => {
  it('reads every page when asked for all records, sending each cursor back', async () => {
    for (let n = 0; n < 230; n++) api.add({ [FIELDS.name.id]: `Order ${n}` });
    const output = await run(api, {
      resource: 'record',
      operation: 'search',
      filterBy: 'none',
      returnAll: true,
      options: {},
    });
    expect(output).toHaveLength(230);
    const reads = api.requests.filter((request) => request.path.endsWith('/records'));
    expect(reads.map((request) => [request.query.get('pageSize'), request.query.get('cursor')])).toEqual([
      ['100', null],
      ['100', '100'],
      ['100', '200'],
    ]);
    expect(output[0]!.pairedItem).toEqual({ item: 0 });
  });

  it('stops at the limit, asking only for what it still needs', async () => {
    for (let n = 0; n < 230; n++) api.add({ [FIELDS.name.id]: `Order ${n}` });
    const output = await run(api, {
      resource: 'record',
      operation: 'search',
      filterBy: 'none',
      returnAll: false,
      limit: 150,
      options: {},
    });
    expect(output).toHaveLength(150);
    expect(
      api.requests.filter((r) => r.path.endsWith('/records')).map((r) => r.query.get('pageSize')),
    ).toEqual(['100', '50']);
  });

  it('finds records by a field value, read as the field compares them', async () => {
    api.add({ [FIELDS.name.id]: 'A', [FIELDS.count.id]: 12 });
    api.add({ [FIELDS.name.id]: 'B', [FIELDS.count.id]: 13 });
    const output = await run(api, {
      resource: 'record',
      operation: 'search',
      filterBy: 'field',
      matchField: FIELDS.count.id,
      matchValue: '12',
      returnAll: true,
      options: {},
    });
    expect(output.map((item) => item.json.Name)).toEqual(['A']);
    const filter = JSON.parse(api.requests.at(-1)!.query.get('filter')!);
    expect(filter.conditions[0]).toMatchObject({ fieldId: FIELDS.count.id, operator: 'eq', value: 12 });
  });

  it('returns nothing, without asking, for an option the field lacks', async () => {
    const output = await run(api, {
      resource: 'record',
      operation: 'search',
      filterBy: 'field',
      matchField: FIELDS.status.id,
      matchValue: 'Pending',
      returnAll: true,
      options: {},
    });
    expect(output).toEqual([]);
    expect(api.requests.some((request) => request.path.endsWith('/records'))).toBe(false);
  });

  it('sends a JSON filter with names turned into IDs, with the view, sorts, and fields', async () => {
    await run(api, {
      resource: 'record',
      operation: 'search',
      filterBy: 'filter',
      filter: '{"conjunction":"and","conditions":[{"field":"Name","operator":"contains","value":"box"}]}',
      returnAll: false,
      limit: 5,
      options: {
        view: 'viwAll00000000000',
        fields: [FIELDS.name.id],
        sort: { property: [{ field: 'Count', direction: 'desc' }] },
      },
    });
    const query = api.requests.at(-1)!.query;
    expect(JSON.parse(query.get('filter')!).conditions[0].fieldId).toBe(FIELDS.name.id);
    expect(JSON.parse(query.get('sort')!)).toEqual([{ fieldId: FIELDS.count.id, direction: 'desc' }]);
    expect(query.get('view')).toBe('viwAll00000000000');
    expect(query.getAll('fields')).toEqual([FIELDS.name.id]);
    expect(query.get('shape')).toBe('airtable');
  });

  it("asks for values as text in the workflow's time zone", async () => {
    api.add({ [FIELDS.name.id]: 'A' });
    await run(api, {
      resource: 'record',
      operation: 'search',
      filterBy: 'none',
      returnAll: true,
      options: { valuesAsText: true },
    });
    const query = api.requests.at(-1)!.query;
    expect([query.get('cellFormat'), query.get('timeZone')]).toEqual(['string', 'America/New_York']);
  });

  it('stops before sending a filter Riosoma would quietly ignore', async () => {
    const failure = await run(api, {
      resource: 'record',
      operation: 'search',
      filterBy: 'filter',
      filter: { conjunction: 'and', conditions: [{ field: 'Count', operator: 'eq', value: 'twelve' }] },
      returnAll: true,
      options: {},
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NodeOperationError);
    expect((failure as Error).message).toContain('"Count"');
    expect(api.requests.some((request) => request.path.endsWith('/records'))).toBe(false);
  });
});

describe('writes', () => {
  it('creates a record from values set in the node, converting each for its field', async () => {
    const output = await run(api, {
      resource: 'record',
      operation: 'create',
      columns: {
        mappingMode: 'defineBelow',
        value: {
          Name: 'Crate',
          Count: '3',
          Done: 'yes',
          Due: '2026-10-15T08:00:00-07:00',
          Status: 'Open',
          Related: 'rec00000000000077',
          Files: `${ADDRESS}/api/files/att00000000000001/label.pdf`,
          Total: null,
        },
      },
      options: {},
    });
    const sent = api.requests.at(-1)!;
    expect(sent.method).toBe('POST');
    expect(sent.body).toEqual({
      records: [
        {
          fields: {
            [FIELDS.name.id]: 'Crate',
            [FIELDS.count.id]: 3,
            [FIELDS.done.id]: true,
            [FIELDS.due.id]: '2026-10-15',
            [FIELDS.status.id]: 'Open',
            [FIELDS.related.id]: ['rec00000000000077'],
            [FIELDS.files.id]: ['att00000000000001'],
          },
        },
      ],
      typecast: false,
      fieldKey: 'id',
    });
    expect(sent.query.get('fieldKey')).toBe('name');
    expect(output[0]!.json).toMatchObject({
      Name: 'Crate',
      Count: 3,
      Files: [{ id: 'att00000000000001', url: `${ADDRESS}/api/files/att00000000000001/file.pdf` }],
    });
    expect(output[0]!.json.id).toMatch(/^rec/);
  });

  it('maps an item automatically, leaving out what Riosoma fills in and the ID of a read', async () => {
    await run(
      api,
      { resource: 'record', operation: 'create', columns: { mappingMode: 'autoMapInputData' }, options: {} },
      [
        {
          id: 'rec00000000000001',
          createdTime: '2026-10-01T00:00:00.000Z',
          Name: 'Copy',
          Total: 9,
          Done: null,
        },
      ],
    );
    expect(api.requests.at(-1)!.body).toMatchObject({
      records: [{ fields: { [FIELDS.name.id]: 'Copy', [FIELDS.done.id]: null } }],
    });
  });

  it('stops on a value named for no field, unless told to leave it out', async () => {
    const parameters = {
      resource: 'record',
      operation: 'create',
      columns: { mappingMode: 'autoMapInputData' },
    };
    await expect(run(api, { ...parameters, options: {} }, [{ Name: 'X', Color: 'red' }])).rejects.toThrow(
      'no field named "Color"',
    );
    await run(api, { ...parameters, options: { ignoreUnknownFields: true } }, [{ Name: 'X', Color: 'red' }]);
    expect(api.records).toHaveLength(1);
  });

  it('updates only the fields set, leaving empty ones out unless asked to send them', async () => {
    const id = api.add({ [FIELDS.name.id]: 'Old', [FIELDS.count.id]: 1 });
    const parameters = {
      resource: 'record',
      operation: 'update',
      recordId: id,
      columns: { mappingMode: 'defineBelow', value: { Name: 'New', Count: '' } },
    };
    await run(api, { ...parameters, options: {} });
    expect(api.requests.at(-1)!.body).toMatchObject({
      records: [{ id, fields: { [FIELDS.name.id]: 'New' } }],
    });
    expect(api.valueOf(id, FIELDS.count.id)).toBe(1);
    await run(api, { ...parameters, options: { sendEmptyValues: true } });
    expect(api.valueOf(id, FIELDS.count.id)).toBeNull();
  });

  it('refuses a record ID in the wrong form before asking', async () => {
    await expect(
      run(api, { resource: 'record', operation: 'get', recordId: 'Order 5', options: {} }),
    ).rejects.toThrow('"Order 5" isn\'t a record ID');
  });

  it('gets and deletes a record by ID', async () => {
    const id = api.add({ [FIELDS.name.id]: 'Gone soon' });
    const got = await run(api, {
      resource: 'record',
      operation: 'get',
      recordId: id,
      options: { nestFields: true },
    });
    expect(got[0]!.json).toMatchObject({ id, fields: { Name: 'Gone soon' } });
    const deleted = await run(api, { resource: 'record', operation: 'delete', recordId: id, options: {} });
    expect(deleted[0]!.json).toEqual({ id, deleted: true });
    expect(api.records).toHaveLength(0);
    expect(api.requests.at(-1)!.query.getAll('records')).toEqual([id]);
  });
});

describe('create or update', () => {
  const upsert = (value: Record<string, unknown>, matchingColumns = ['Name']) => ({
    resource: 'record',
    operation: 'upsert',
    columns: { mappingMode: 'defineBelow', value, matchingColumns },
    options: {},
  });

  it('updates the one record with the value, matching text without regard to case', async () => {
    const id = api.add({ [FIELDS.name.id]: 'Crate 7', [FIELDS.count.id]: 1 });
    api.add({ [FIELDS.name.id]: 'Crate 70', [FIELDS.count.id]: 1 });
    const output = await run(api, upsert({ Name: 'crate 7', Count: 5 }));
    expect(output[0]!.json.id).toBe(id);
    expect(api.valueOf(id, FIELDS.count.id)).toBe(5);
    expect(api.records).toHaveLength(2);
  });

  it('creates a record when none has the value', async () => {
    api.add({ [FIELDS.name.id]: 'Crate 7' });
    await run(api, upsert({ Name: 'Crate 8', Count: 2 }));
    expect(api.records).toHaveLength(2);
    expect(api.requests.at(-1)!.method).toBe('POST');
  });

  it('creates rather than asks when a single select lacks the option', async () => {
    await run(api, { ...upsert({ Name: 'X', Status: 'Pending' }, ['Status']), options: { typecast: true } });
    expect(api.requests.map((request) => request.method)).toEqual(['GET', 'POST']);
  });

  it('stops when more than one record has the value', async () => {
    api.add({ [FIELDS.name.id]: 'Twin' });
    api.add({ [FIELDS.name.id]: 'twin' });
    await expect(run(api, upsert({ Name: 'Twin' }))).rejects.toThrow('2 records have "Twin" in "Name"');
  });

  it('never updates a record whose value differs, even if the server returned it', async () => {
    api.add({ [FIELDS.name.id]: 'Something else' });
    // A filter the server couldn't use would return every record.
    const original = api.handle.bind(api);
    api.handle = (method, url, body) =>
      original(
        method,
        method === 'GET' && url.includes('filter=') ? url.replace(/filter=[^&]+/, '') : url,
        body,
      );
    await run(api, upsert({ Name: 'Wanted' }));
    expect(api.records.map((record) => record.values[FIELDS.name.id])).toEqual(['Something else', 'Wanted']);
  });

  it('needs a value for the field it matches on', async () => {
    await expect(run(api, upsert({ Count: 2 }))).rejects.toThrow('Set a value for "Name"');
  });
});

describe('errors', () => {
  it("surfaces Riosoma's message, field, and key as an n8n error", async () => {
    api.failNext = {
      status: 422,
      body: {
        error: {
          code: 'validation_failed',
          messageKey: 'data.value.notEmail',
          message: 'The field requires a valid email address.',
          params: { field: 'Contact', value: 'nobody' },
        },
      },
    };
    const failure = await run(api, { resource: 'database', operation: 'getAll' }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(NodeApiError);
    expect((failure as NodeApiError).message).toBe('Contact: The field requires a valid email address.');
    expect((failure as NodeApiError).description).toContain('data.value.notEmail');
  });

  it('carries on past a failed item when the workflow says to', async () => {
    const output = await run(
      api,
      { resource: 'record', operation: 'create', columns: { mappingMode: 'autoMapInputData' }, options: {} },
      [{ Name: 'Good' }, { Count: 'lots' }, { Name: 'Also good' }],
      true,
    );
    expect(output.map((item) => item.pairedItem)).toEqual([{ item: 0 }, { item: 1 }, { item: 2 }]);
    expect(output[1]!.json.error).toBe('Count: Expected a number, but got "lots".');
    expect(api.records).toHaveLength(2);
  });
});

describe('pickers', () => {
  const loadContext = (parameters: Record<string, unknown>) =>
    ({
      ...executeContext(api, {}),
      getNodeParameter: (name: string, fallback?: unknown, options?: { extractValue?: boolean }) => {
        const value = parameters[name] as { value?: unknown } | undefined;
        return (options?.extractValue ? value?.value : value) ?? fallback;
      },
    }) as never;

  it('offers the writable fields to map, with matching on the fields that can match', async () => {
    const { fields } = await getColumns.call(loadContext(locators));
    expect(fields.map((field) => field.id)).toEqual([
      'Name',
      'Count',
      'Done',
      'Due',
      'Status',
      'Related',
      'Files',
    ]);
    expect(fields.find((field) => field.id === 'Status')).toMatchObject({
      type: 'options',
      options: [
        { name: 'Open', value: 'Open' },
        { name: 'Closed', value: 'Closed' },
      ],
      canBeUsedToMatch: true,
    });
    expect(fields.find((field) => field.id === 'Related')?.canBeUsedToMatch).toBe(false);
    expect(fields.find((field) => field.id === 'Due')?.type).toBe('dateTime');
  });

  it('lists the fields a search can match on, formulas included', async () => {
    const options = await getMatchFields.call(loadContext(locators));
    expect(options.map((option) => option.name)).toEqual(['Name', 'Count', 'Done', 'Due', 'Status', 'Total']);
  });
});
