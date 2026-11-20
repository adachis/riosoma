import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { newId, type TokenCreated } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { AirtableClient, RateLimiter, systemClock } from '../data/imports/airtable/api.js';
import { startServer, type ServerFixture } from '../test/fixture.js';

/**
 * The calls the `airtable` JavaScript client makes, written out by hand from what it sends, with
 * no dependency on it: the same paths (a trailing slash when it writes), the same query strings
 * (`fields[]=…`, `sort[0][field]=…`, spaces as `+`), the same headers, a JSON content type even
 * on a GET or DELETE, and a retry after a 429.  Riosoma's own Airtable import client reads a base
 * through these routes too.
 */

/** More requests a second than a test can make, so a slow or fast machine meets no limit */
const UNLIMITED = 100_000;

let kit: TestPostgres;
let server: ServerFixture;
let token: TokenCreated;
beforeAll(async () => {
  kit = await startTestPostgres();
  // Only the rate limit's own test, on a server of its own, should meet the limit.
  server = await startServer(kit, 'airtablejs', { airtableApiSecondLimit: UNLIMITED });
  token = await makeToken(server);
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

async function makeToken(on: ServerFixture) {
  const response = await on.app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: on.owner.headers,
    payload: {
      name: 'Client library',
      scopes: ['data.records:read', 'data.records:write', 'schema.bases:read'],
      databases: 'all',
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<TokenCreated>();
}

/** The client's query strings: arrays of scalars as `key[]`, objects and their lists by index. */
function queryString(params: Record<string, unknown>): string {
  const parts: string[] = [];
  const add = (key: string, value: unknown) =>
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  const build = (prefix: string, value: unknown): void => {
    if (Array.isArray(value))
      value.forEach((item, index) => {
        if (/\[\]$/.test(prefix)) add(prefix, item);
        else build(`${prefix}[${typeof item === 'object' && item !== null ? index : ''}]`, item);
      });
    else if (value !== null && typeof value === 'object')
      for (const [key, item] of Object.entries(value)) build(`${prefix}[${key}]`, item);
    else add(prefix, value);
  };
  for (const [key, value] of Object.entries(params)) build(key, value);
  return parts.join('&').replace(/%20/g, '+');
}

class ClientError extends Error {
  constructor(
    readonly error: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

interface Row {
  id: string;
  fields: Record<string, unknown>;
  createdTime?: string;
}

/** What `new Airtable({ apiKey, endpointUrl }).base(id)` does with each call. */
/** Waits the seconds given, as the client does before trying again */
type Wait = (seconds: number) => Promise<void>;
const realWait: Wait = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1_000));

class Base {
  /** Requests answered 429 and tried again */
  retried = 0;
  constructor(
    private readonly on: ServerFixture,
    private readonly apiKey: string,
    private readonly id: string,
    private readonly wait: Wait = realWait,
  ) {}

  async runAction(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    params: Record<string, unknown>,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      const response = await this.on.app.inject({
        method,
        url: `/v0/${this.id}${path}?${queryString(params)}`,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'x-api-version': '0.1.0',
          'x-airtable-application-id': this.id,
          'x-airtable-user-agent': 'Airtable.js/0.12.2',
          'content-type': 'application/json',
        },
        ...(body === null ? {} : { payload: JSON.stringify(body) }),
      });
      // The client waits and tries again, longer each time.  Its first wait is five seconds, and
      // this one waits as long as Retry-After says, so the test stays quick.
      if (response.statusCode === 429 && attempt < 5) {
        this.retried += 1;
        await this.wait(Number(response.headers['retry-after'] ?? 1));
        continue;
      }
      const json = response.json<{ error?: { type?: string; message?: string } }>();
      if (response.statusCode >= 400)
        throw new ClientError(
          json.error?.type ?? 'UNEXPECTED_ERROR',
          json.error?.message ?? 'An unexpected error occurred',
          response.statusCode,
        );
      return json as Record<string, unknown>;
    }
  }

  table(name: string) {
    return new Table(this, name);
  }
}

class Table {
  constructor(
    private readonly base: Base,
    private readonly name: string,
  ) {}

  private get path() {
    return `/${encodeURIComponent(this.name)}`;
  }

  select(params: Record<string, unknown> = {}) {
    return {
      /** Pages until the list runs out, sending the offset back each time, as `eachPage` does */
      eachPage: async (page: (records: Row[]) => void) => {
        const query = { ...params };
        for (;;) {
          const result = await this.base.runAction('GET', this.path, query, null);
          page(result.records as Row[]);
          if (!result.offset) return;
          query.offset = result.offset;
        }
      },
      /** What the client does with `method: 'post'`, or a query string over 16,000 characters */
      eachPagePosted: async (page: (records: Row[]) => void) => {
        const body: Record<string, unknown> = { ...params };
        const { timeZone, userLocale } = body;
        for (;;) {
          const result = await this.base.runAction(
            'POST',
            `${this.path}/listRecords`,
            { ...(timeZone ? { timeZone } : {}), ...(userLocale ? { userLocale } : {}) },
            body,
          );
          page(result.records as Row[]);
          if (!result.offset) return;
          body.offset = result.offset;
        }
      },
    };
  }

  async find(id: string) {
    return (await this.base.runAction('GET', `${this.path}/${id}`, {}, null)) as unknown as Row;
  }

  /** One record from its fields, sent as `{ fields }` */
  async createOne(fields: Record<string, unknown>) {
    return (await this.base.runAction('POST', `${this.path}/`, {}, { fields })) as unknown as Row;
  }

  async create(records: Array<{ fields: Record<string, unknown> }>, typecast?: boolean) {
    const options = typecast === undefined ? {} : { typecast };
    return (await this.base.runAction('POST', `${this.path}/`, {}, { records, ...options })).records as Row[];
  }

  async update(records: Array<{ id: string; fields: Record<string, unknown> }>) {
    return (await this.base.runAction('PATCH', `${this.path}/`, {}, { records })).records as Row[];
  }

  /** What `replace` sends for a list of records: a PUT to the table's path with a slash */
  async replace(records: Array<{ id: string; fields: Record<string, unknown> }>) {
    return (await this.base.runAction('PUT', `${this.path}/`, {}, { records })).records as Row[];
  }

  async updateOne(id: string, fields: Record<string, unknown>, destructive = false) {
    return (await this.base.runAction(
      destructive ? 'PUT' : 'PATCH',
      `${this.path}/${id}`,
      {},
      { fields },
    )) as unknown as Row;
  }

  async destroy(ids: string[]) {
    return (await this.base.runAction('DELETE', this.path, { records: ids }, null)).records as Array<{
      id: string;
      deleted: boolean;
    }>;
  }

  async destroyOne(id: string) {
    return (await this.base.runAction('DELETE', `${this.path}/${id}`, {}, null)) as {
      id: string;
      deleted: boolean;
    };
  }
}

async function newBase(on: ServerFixture, name: string) {
  const databaseId = newId('database');
  const response = await on.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: on.owner.headers,
    payload: {
      id: databaseId,
      name,
      table: {
        id: newId('table'),
        name: 'Design projects',
        fields: [
          { id: newId('field'), name: 'Name', type: 'text' },
          {
            id: newId('field'),
            name: 'Category',
            type: 'singleSelect',
            options: { choices: [{ id: newId('choice'), name: 'Brand identity', color: 'blue' }] },
          },
          { id: newId('field'), name: 'Complete', type: 'checkbox' },
          { id: newId('field'), name: 'Budget', type: 'currency' },
        ],
        view: { id: newId('view'), name: 'All projects' },
        records: [],
      },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return `app${databaseId.slice(2)}`;
}

it('serves the calls the airtable JavaScript client makes: pages, find, create, update, and destroy', async () => {
  const base = new Base(server, token.token, await newBase(server, 'Client calls'));
  const table = base.table('Design projects');

  const one = await table.createOne({ Name: 'Coffee packaging', Category: 'Brand identity', Budget: 1200 });
  expect(one).toEqual({
    id: expect.stringMatching(/^rec/),
    createdTime: expect.any(String),
    fields: { Name: 'Coffee packaging', Category: 'Brand identity', Budget: 1200 },
  });
  const batch: Row[] = [];
  for (let start = 0; start < 24; start += 8)
    batch.push(
      ...(await table.create(
        Array.from({ length: 8 }, (_, i) => ({
          fields: {
            Name: `Project ${String(start + i).padStart(2, '0')}`,
            Category: 'Web design',
            Complete: i % 2 === 0,
          },
        })),
        true,
      )),
    );
  expect(batch).toHaveLength(24);

  const params = {
    pageSize: 5,
    view: 'All projects',
    fields: ['Name', 'Complete'],
    filterByFormula: "AND({Category} = 'Web design', NOT({Complete}))",
    sort: [{ field: 'Name', direction: 'desc' }],
  };
  const pages: string[][] = [];
  await table
    .select(params)
    .eachPage((records) => pages.push(records.map((record) => String(record.fields.Name))));
  expect(pages.map((page) => page.length)).toEqual([5, 5, 2]);
  const expected = Array.from({ length: 24 }, (_, n) => n)
    .filter((n) => (n % 8) % 2 === 1)
    .map((n) => `Project ${String(n).padStart(2, '0')}`)
    .reverse();
  expect(pages.flat()).toEqual(expected);
  const posted: string[][] = [];
  await table
    .select({ ...params, timeZone: 'America/Chicago', userLocale: 'en-us' })
    .eachPagePosted((records) => posted.push(records.map((record) => String(record.fields.Name))));
  expect(posted).toEqual(pages);

  const found = await table.find(one.id);
  expect(found.fields).toEqual({ Name: 'Coffee packaging', Category: 'Brand identity', Budget: 1200 });
  const updated = await table.update([{ id: one.id, fields: { Complete: true } }]);
  expect(updated[0]!.fields).toMatchObject({ Name: 'Coffee packaging', Complete: true });
  expect((await table.updateOne(one.id, { Budget: 1500 })).fields).toMatchObject({
    Budget: 1500,
    Complete: true,
  });
  expect((await table.updateOne(one.id, { Name: 'Coffee packaging' }, true)).fields).toEqual({
    Name: 'Coffee packaging',
  });
  const replaced = await table.replace([
    { id: batch[0]!.id, fields: { Name: 'Project 00', Budget: 50 } },
    { id: batch[1]!.id, fields: { Complete: true } },
  ]);
  expect(replaced.map((record) => record.fields)).toEqual([
    { Name: 'Project 00', Budget: 50 },
    { Complete: true },
  ]);
  await expect(table.find(`rec${'0'.repeat(14)}`)).rejects.toMatchObject({
    error: 'NOT_FOUND',
    statusCode: 404,
  });
  await expect(table.createOne({ Category: 'Not an option' })).rejects.toMatchObject({
    error: 'INVALID_MULTIPLE_CHOICE_OPTIONS',
    statusCode: 422,
  });

  const destroyed = await table.destroy(batch.slice(0, 10).map((record) => record.id));
  expect(destroyed).toEqual(batch.slice(0, 10).map((record) => ({ id: record.id, deleted: true })));
  expect(await table.destroyOne(one.id)).toEqual({ id: one.id, deleted: true });
  let left = 0;
  await table.select({ pageSize: 100 }).eachPage((records) => (left += records.length));
  expect(left).toBe(14);
});

it('answers 429 past the limit, which the client waits out before trying again', async () => {
  const limited = await startServer(kit, 'airtablejslimit', { airtableApiSecondLimit: 3 });
  try {
    const pat = (await makeToken(limited)).token;
    const baseId = await newBase(limited, 'Limited');
    // The clock stands still, so every request falls in the same second however long it takes,
    // and waiting out Retry-After moves it on by exactly that long.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const waits: number[] = [];
    const base = new Base(limited, pat, baseId, async (seconds) => {
      waits.push(seconds);
      vi.setSystemTime(Date.now() + seconds * 1_000);
    });
    const table = base.table('Design projects');
    const created = await table.create(
      Array.from({ length: 10 }, (_, i) => ({ fields: { Name: `Item ${i}` } })),
    );
    // The create and two pages fill the first second, the third page waits one out, and the last
    // three pages fill the next.
    let seen = 0;
    await table.select({ pageSize: 2 }).eachPage((records) => (seen += records.length));
    expect(seen).toBe(created.length);
    expect(base.retried).toBe(1);
    expect(waits).toEqual([1]);
  } finally {
    vi.useRealTimers();
    await limited.close();
  }
});

it('lets Riosoma’s own Airtable import client read a base through these routes', async () => {
  const baseId = await newBase(server, 'Read by the importer');
  const base = new Base(server, token.token, baseId);
  await base.table('Design projects').create([{ fields: { Name: 'Imported', Budget: 10 } }]);
  const client = new AirtableClient({
    apiUrl: 'http://riosoma.test',
    token: token.token,
    clock: systemClock,
    limiter: () => new RateLimiter(systemClock),
    fetch: async (url, init) => {
      const address = new URL(url);
      const response = await server.app.inject({
        method: 'GET',
        url: `${address.pathname}${address.search}`,
        headers: init.headers,
      });
      return new Response(response.body, {
        status: response.statusCode,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  expect(await client.whoami()).toEqual({ id: server.owner.userId });
  expect((await client.bases()).find((item) => item.id === baseId)).toEqual({
    id: baseId,
    name: 'Read by the importer',
    permissionLevel: 'create',
  });
  const schema = await client.schema(baseId);
  expect(schema.tables[0]).toMatchObject({
    name: 'Design projects',
    fields: [
      { name: 'Name', type: 'singleLineText' },
      { name: 'Category', type: 'singleSelect' },
      { name: 'Complete', type: 'checkbox' },
      { name: 'Budget', type: 'currency', options: { precision: 2, symbol: '$' } },
    ],
    views: [{ name: 'All projects', type: 'grid', visibleFieldIds: expect.any(Array) }],
  });
  const pages = [];
  for await (const page of client.records(baseId, schema.tables[0]!.id)) pages.push(page);
  const budget = schema.tables[0]!.fields[3]!.id;
  expect(pages.flat().map((record) => record.fields[budget])).toEqual([10]);
});
