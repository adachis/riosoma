import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  newId,
  type JoinedTable,
  type ChangeBody,
  type CommandBatchResult,
  type DatabaseSchema,
  type FieldMeta,
  type JoinSuggestions,
  type RowData,
  type SourceMeta,
} from '@riosoma/contracts';
import { registerConnector, sourceKey, type Connector, type SourceRow } from '@riosoma/connectors';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { claimSyncs, runSync } from '../sources/sync.js';
import { AccessScope } from './access.js';
import { JOIN_LIMITS, nameWords, namesPointAt } from './joins.js';

let kit: TestPostgres;
let server: ServerFixture;
const clientId = newId('client');
const remote = new Map<string, SourceRow[]>();
const columns = [
  { name: 'id', sourceType: 'integer', nullable: false, suggested: { type: 'number', options: {} } },
  { name: 'name', sourceType: 'text', nullable: true, suggested: { type: 'text', options: {} } },
].map((column) => ({ ...column, alternatives: [] }));
const connector: Connector = {
  kind: 'postgres',
  async test() {
    return { ok: true, steps: [] };
  },
  async listObjects() {
    return [];
  },
  async describe() {
    return columns;
  },
  async preview() {
    return { columns, rows: [], rowEstimate: 0 };
  },
  async keyCandidates() {
    return [['id']];
  },
  async *read(_context, select) {
    yield remote.get(select.kind === 'object' ? select.object.name : select.sql) ?? [];
  },
};

beforeAll(async () => {
  registerConnector(connector);
  kit = await startTestPostgres();
  server = await startServer(kit, 'joins');
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});
afterEach(() => {
  vi.restoreAllMocks();
});

type FieldInput = { id: string; name: string; type: string; options?: Record<string, unknown> };
interface TableInput {
  id: string;
  name: string;
  fields: FieldInput[];
  view: { id: string; name: string };
  records: [];
}

function table(name: string, fields: Array<[string, string]>): TableInput {
  return {
    id: newId('table'),
    name,
    fields: fields.map(([field, type]) => ({ id: newId('field'), name: field, type })),
    view: { id: newId('view'), name: 'Grid' },
    records: [],
  };
}
const fieldOf = (target: TableInput, name: string) => target.fields.find((field) => field.name === name)!.id;

async function get<T>(url: string): Promise<T> {
  const response = await server.app.inject({ url, headers: server.owner.headers });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}

async function send(databaseId: string, input: Record<string, unknown>, error?: string) {
  const groupId = newId('action');
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: server.owner.headers,
    payload: { clientId, commands: [{ id: newId('command'), groupId, ...input }] },
  });
  expect(response.statusCode, response.body).toBe(200);
  const result = response.json<CommandBatchResult>().results[0]!;
  if (error) expect(result.error?.messageKey, response.body).toBe(error);
  else expect(result.status, response.body).toBe('applied');
  return groupId;
}

async function createDatabase(first: TableInput, ...rest: TableInput[]): Promise<string> {
  const databaseId = newId('database');
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: { id: databaseId, name: 'Joins', table: first },
  });
  expect(response.statusCode, response.body).toBe(200);
  for (const next of rest) await send(databaseId, { kind: 'table.create', table: next });
  return databaseId;
}

async function insert(
  databaseId: string,
  target: TableInput,
  rows: Array<Record<string, unknown>>,
): Promise<string[]> {
  const ids = rows.map(() => newId('record'));
  for (let start = 0; start < rows.length; start += 1000)
    await send(databaseId, {
      kind: 'record.create',
      tableId: target.id,
      records: rows.slice(start, start + 1000).map((row, index) => ({
        id: ids[start + index],
        values: Object.fromEntries(
          Object.entries(row).map(([name, value]) => [fieldOf(target, name), value]),
        ),
      })),
    });
  return ids;
}

async function suggest(
  databaseId: string,
  body: Record<string, unknown> = {},
  headers = server.owner.headers,
) {
  return server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/join-suggestions`,
    headers,
    payload: body,
  });
}

async function suggestions(databaseId: string, body: Record<string, unknown> = {}) {
  const response = await suggest(databaseId, body);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<JoinSuggestions>();
}

const pair = (from: TableInput, fromField: string, to: TableInput, toField: string) => ({
  fromTableId: from.id,
  fromFieldId: fieldOf(from, fromField),
  toTableId: to.id,
  toFieldId: fieldOf(to, toField),
});
const read = (tableId: string, id: string) => get<RowData>(`/api/tables/${tableId}/records/${id}`);

it('prefers a named relationship over coincidental numeric overlap', async () => {
  const customers = table('Customers', [['id', 'text']]);
  const orders = table('Orders', [
    ['customer_id', 'number'],
    ['id', 'number'],
  ]);
  const lines = table('Order lines', [
    ['prefix_order_ref', 'text'],
    ['id', 'number'],
  ]);
  const databaseId = await createDatabase(customers, orders, lines);
  const keys = Array.from({ length: 8 }, (_, index) => 1001 + index);
  await insert(
    databaseId,
    customers,
    keys.map((key) => ({ id: String(key) })),
  );
  await insert(
    databaseId,
    orders,
    keys.map((key) => ({ customer_id: key, id: key + 100_000 })),
  );
  await insert(
    databaseId,
    lines,
    keys.map((key) => ({ id: key, prefix_order_ref: ` ${key + 100_000} ` })),
  );
  const result = await suggestions(databaseId);
  expect(result.suggestions).toContainEqual(
    expect.objectContaining(pair(orders, 'customer_id', customers, 'id')),
  );
  expect(result.suggestions).not.toContainEqual(
    expect.objectContaining(pair(orders, 'customer_id', lines, 'id')),
  );
  expect(result.suggestions).not.toContainEqual(expect.objectContaining(pair(customers, 'id', lines, 'id')));
  const focused = await suggestions(databaseId, { tableIds: [lines.id] });
  expect(focused.suggestions).not.toContainEqual(
    expect.objectContaining(pair(orders, 'customer_id', lines, 'id')),
  );
  expect(focused.suggestions).toContainEqual(
    expect.objectContaining(pair(lines, 'prefix_order_ref', orders, 'id')),
  );
});

it('recognizes differently named source keys without treating them as outside references', async () => {
  const customers = table('Customers', [
    ['Name', 'text'],
    ['cust_no', 'number'],
  ]);
  const orders = table('Orders', [['customer_id', 'text']]);
  const lines = table('Order lines', [['id', 'number']]);
  const databaseId = await createDatabase(orders, lines);
  const address = new URL(kit.url);
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/sources',
    headers: server.owner.headers,
    payload: {
      name: 'Customer snapshot',
      connection: {
        kind: 'postgres',
        host: address.hostname,
        database: address.pathname.slice(1),
        user: address.username,
      },
      secrets: { password: newId('action') },
      access: 'creators',
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  const keys = Array.from({ length: 8 }, (_, index) => 1001 + index);
  remote.set(
    customers.id,
    keys.map((id) => ({ key: sourceKey([id]), values: { id, name: `Customer ${id}` } })),
  );
  await send(databaseId, {
    kind: 'table.create',
    table: {
      ...customers,
      source: {
        sourceId: created.json<SourceMeta>().id,
        select: { kind: 'object', object: { schema: null, name: customers.id } },
        keyColumns: ['id'],
        everyMinutes: null,
      },
      fields: customers.fields.map((field) => ({
        ...field,
        source: { column: field.name === 'Name' ? 'name' : 'id', sourceType: '' },
      })),
    },
  });
  for (const job of await claimSyncs(server.ctx, 100)) await runSync(server.ctx, job);
  await insert(
    databaseId,
    orders,
    keys.map((key) => ({ customer_id: String(key) })),
  );
  await insert(
    databaseId,
    lines,
    keys.map((key) => ({ id: key })),
  );
  const result = await suggestions(databaseId);
  expect(result.suggestions).toContainEqual(
    expect.objectContaining({ ...pair(orders, 'customer_id', customers, 'cust_no'), namesMatch: true }),
  );
  expect(result.suggestions).not.toContainEqual(
    expect.objectContaining(pair(customers, 'cust_no', lines, 'id')),
  );
  const focused = await suggestions(databaseId, { tableIds: [lines.id] });
  expect(focused.suggestions).not.toContainEqual(
    expect.objectContaining(pair(orders, 'customer_id', lines, 'id')),
  );
});

it('profiles related keys when a wide table fills the discovery field budget', async () => {
  const customers = table('Customers', [
    ['Name', 'text'],
    ['customer_id', 'text'],
  ]);
  const wide = table('Wide', [
    ['Name', 'text'],
    ...Array.from({ length: 297 }, (_, index) => [`Metric ${index}`, 'text'] as [string, string]),
    ['customer_id', 'number'],
    ['Last metric', 'text'],
  ]);
  const databaseId = await createDatabase(wide, customers);
  const keys = Array.from({ length: 64 }, (_, index) => 1001 + index);
  await insert(
    databaseId,
    wide,
    keys.map((key) =>
      Object.fromEntries(
        wide.fields.map((field, index) => [
          field.name,
          field.name === 'customer_id' ? key : `value-${index}-${key}`,
        ]),
      ),
    ),
  );
  await insert(
    databaseId,
    customers,
    keys.map((key) => ({ Name: `Customer ${key}`, customer_id: String(key) })),
  );
  const result = await suggestions(databaseId);
  expect(result.profiledFields).toBe(JOIN_LIMITS.maxFields);
  expect(result.suggestions).toContainEqual(
    expect.objectContaining({ ...pair(wide, 'customer_id', customers, 'customer_id'), coverage: 1 }),
  );
});

/** Customers, orders that name them by number as text, invoices that name them by email, and vendors. */
async function storefront() {
  const customers = table('Customers', [
    ['Name', 'text'],
    ['id', 'number'],
    ['email', 'email'],
  ]);
  const orders = table('Orders', [
    ['Title', 'text'],
    ['customer_id', 'text'],
    ['quantity', 'number'],
    ['vendor_id', 'number'],
  ]);
  const invoices = table('Invoices', [
    ['Number', 'text'],
    ['billing_email', 'email'],
  ]);
  const vendors = table('Vendors', [
    ['Name', 'text'],
    ['id', 'number'],
  ]);
  const databaseId = await createDatabase(customers, orders, invoices, vendors);
  const people = ['ada', 'grace', 'linus', 'barbara', 'edsger'];
  await insert(
    databaseId,
    customers,
    people.map((name, index) => ({ Name: name, id: index + 1, email: `${name}@example.test` })),
  );
  await insert(
    databaseId,
    orders,
    Array.from({ length: 12 }, (_, index) => ({
      Title: `Order ${index + 1}`,
      customer_id: String((index % 5) + 1),
      quantity: (index % 3) + 1,
      vendor_id: [1, 2, 50, 60, 70, 80][index % 6],
    })),
  );
  await insert(
    databaseId,
    invoices,
    [...people, 'ada', 'nobody'].map((name, index) => ({
      Number: `INV-${index + 1}`,
      billing_email: `${name}@example.test`,
    })),
  );
  await insert(
    databaseId,
    vendors,
    Array.from({ length: 10 }, (_, index) => ({ Name: `Vendor ${index + 1}`, id: index + 1 })),
  );
  return { databaseId, customers, orders, invoices, vendors };
}

describe('join suggestions', () => {
  it('finds planted keys, numbers against text included, ranked strongest first with example values', async () => {
    const f = await storefront();
    const result = await suggestions(f.databaseId);
    expect(result.profiledFields).toBe(11);
    expect(result.ms).toBeGreaterThanOrEqual(0);
    expect(result.suggestions).toEqual([
      {
        ...pair(f.orders, 'customer_id', f.customers, 'id'),
        confidence: 1,
        coverage: 1,
        uniqueness: 1,
        namesMatch: true,
        examples: [
          { value: '1', records: 3 },
          { value: '2', records: 3 },
          { value: '3', records: 2 },
        ],
      },
      {
        ...pair(f.invoices, 'billing_email', f.customers, 'email'),
        confidence: 0.717,
        coverage: 0.833,
        uniqueness: 1,
        namesMatch: false,
        examples: [
          { value: 'ada@example.test', records: 2 },
          { value: 'barbara@example.test', records: 1 },
          { value: 'edsger@example.test', records: 1 },
        ],
      },
    ]);
  });

  it('suggests nothing for chance overlaps of small numbers, weak coverage, or ID fields alone', async () => {
    const f = await storefront();
    const found = (await suggestions(f.databaseId)).suggestions.map((s) => `${s.fromFieldId}>${s.toFieldId}`);
    // Quantities 1 to 3 all appear among customer and vendor IDs, but by chance.
    expect(found.some((key) => key.startsWith(fieldOf(f.orders, 'quantity')))).toBe(false);
    // Only a third of vendor IDs on orders exist.
    expect(found.some((key) => key.startsWith(fieldOf(f.orders, 'vendor_id')))).toBe(false);
    // Every customer ID is also a vendor ID, which says nothing about customers.
    expect(found.some((key) => key.startsWith(fieldOf(f.customers, 'id')))).toBe(false);
  });

  it('ties two-letter codes to the table that holds every one, and never a few codes or a partial match', async () => {
    const codes = [
      ...['US', 'CA', 'MX', 'BR', 'AR', 'GB', 'IE', 'FR', 'DE', 'ES', 'IT'],
      ...['NL', 'SE', 'PL', 'AU', 'NZ', 'JP', 'KR', 'IN', 'SG', 'ZA', 'AE'],
    ];
    const territories = table('TERRITORY_REF', [
      ['TERRITORY_NAME', 'text'],
      ['TERRITORY_CODE', 'text'],
    ]);
    const sales = table('WEEKLY_POS_SALES', [
      ['UPC_CODE', 'text'],
      ['TERR', 'text'],
      ['SIZE', 'text'],
      ['STATE', 'text'],
      ['BIN', 'text'],
    ]);
    const bins = table('Bins', [
      ['Name', 'text'],
      ['slot', 'text'],
    ]);
    const databaseId = await createDatabase(territories, sales, bins);
    await insert(
      databaseId,
      territories,
      codes.map((code) => ({ TERRITORY_NAME: `Territory ${code}`, TERRITORY_CODE: code })),
    );
    const slots = ['A', 'B', 'C'].flatMap((aisle) => [1, 2, 3, 4, 5, 6].map((shelf) => `${aisle}${shelf}`));
    await insert(
      databaseId,
      bins,
      slots.map((slot) => ({ Name: `Bin ${slot}`, slot })),
    );
    await insert(
      databaseId,
      sales,
      Array.from({ length: 48 }, (_, index) => ({
        UPC_CODE: String(840214500010 + index),
        // Fourteen territories, every one of them in the reference table.
        TERR: codes[index % 14],
        // Six codes that are all there too, which is too few to mean anything.
        SIZE: codes[index % 6],
        // Twelve codes, one of which the reference table has never heard of.
        STATE: [...codes.slice(0, 11), 'TX'][index % 12],
        // Twelve made-up codes with a digit, all of them among the bins.
        BIN: slots[index % 12],
      })),
    );
    const result = await suggestions(databaseId);
    expect(result.suggestions).toEqual([
      {
        ...pair(sales, 'TERR', territories, 'TERRITORY_CODE'),
        confidence: 0.8,
        coverage: 1,
        uniqueness: 1,
        namesMatch: false,
        examples: [
          { value: 'AR', records: 4 },
          { value: 'BR', records: 4 },
          { value: 'CA', records: 4 },
        ],
      },
    ]);
  });

  it('skips pairs already joined by a link field, and limits results to the tables asked about', async () => {
    const f = await storefront();
    await send(f.databaseId, {
      kind: 'field.create',
      tableId: f.invoices.id,
      field: {
        id: newId('field'),
        name: 'Customer',
        type: 'link',
        options: { linkedTableId: f.customers.id },
      },
    });
    const linked = await suggestions(f.databaseId);
    expect(linked.suggestions.map((s) => s.fromTableId)).toEqual([f.orders.id]);
    expect((await suggestions(f.databaseId, { tableIds: [f.vendors.id] })).suggestions).toEqual([]);
    expect((await suggestions(f.databaseId, { tableIds: [f.customers.id] })).suggestions).toHaveLength(1);
    const missing = await suggest(f.databaseId, { tableIds: [newId('table')] });
    expect(missing.statusCode).toBe(404);
  });

  it('leaves out fields hidden from the person and refuses people who can’t change fields', async () => {
    const f = await storefront();
    const hidden = fieldOf(f.customers, 'id');
    const visible = AccessScope.prototype.visibleFields;
    vi.spyOn(AccessScope.prototype, 'visibleFields').mockImplementation(function <F extends { id: string }>(
      this: AccessScope,
      tableId: string,
      fields: readonly F[],
    ) {
      return visible.call(this, tableId, fields).filter((field) => field.id !== hidden);
    });
    const result = await suggestions(f.databaseId);
    expect(result.profiledFields).toBe(10);
    expect(result.suggestions.map((s) => s.toFieldId)).toEqual([fieldOf(f.customers, 'email')]);
    vi.restoreAllMocks();
    const stranger = await server.addMember();
    expect((await suggest(f.databaseId, {}, stranger.headers)).statusCode).toBe(404);
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'grants')} (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
      VALUES (${server.owner.info.org.id}, 'database', ${f.databaseId}, 'user', ${stranger.userId}, 'editor')`,
    );
    const editor = await suggest(f.databaseId, {}, stranger.headers);
    expect(editor.statusCode).toBe(403);
  });

  it('reads names the way people write them', () => {
    expect(nameWords('CustomerId')).toEqual(['customer', 'id']);
    expect(nameWords('customer_ids')).toEqual(['customer', 'id']);
    expect(nameWords('Categories')).toEqual(['category']);
    const customers = { name: 'Customers', primaryFieldId: 'fldPrimary' };
    const id = { name: 'id', id: 'fldId', type: 'number' };
    expect(namesPointAt({ name: 'CustomerId' }, id, customers)).toBe(true);
    expect(
      namesPointAt({ name: 'customer_id' }, { name: 'customer_id', id: 'fldOther', type: 'text' }, customers),
    ).toBe(true);
    expect(
      namesPointAt({ name: 'Customer' }, { name: 'Name', id: 'fldPrimary', type: 'text' }, customers),
    ).toBe(true);
    expect(namesPointAt({ name: 'owner_id' }, id, customers)).toBe(false);
    expect(namesPointAt({ name: 'id' }, id, customers)).toBe(false);
    expect(
      namesPointAt({ name: 'customer_id' }, { name: 'email', id: 'fldEmail', type: 'email' }, customers),
    ).toBe(false);
  });
});

it('refreshes 27,549 joined rows once when several output names change', async () => {
  const columns: Array<[string, string]> = [
    ['Key', 'text'],
    ['Week ending', 'date'],
    ['Sales', 'number'],
    ['Orders', 'number'],
  ];
  const left = table('Weekly sales', columns);
  const right = table('Weekly totals', columns);
  const databaseId = await createDatabase(left, right);
  for (const input of [left, right])
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.data, input.id)}
      (__id, ${ident(input.fields[0]!.id)}, ${ident(input.fields[1]!.id)}, ${ident(input.fields[2]!.id)}, ${ident(input.fields[3]!.id)})
      SELECT 'rec' || lpad(g::text, 14, '0'), 'K' || g, DATE '2026-01-01', g, g FROM generate_series(1, 27549) g`,
    );
  const output = table('Combined sales', columns);
  const joined: JoinedTable = {
    baseTableId: left.id,
    steps: [
      {
        tableId: right.id,
        leftTableId: left.id,
        leftFieldId: left.fields[0]!.id,
        rightFieldId: right.fields[0]!.id,
        kind: 'full',
      },
    ],
    fields: output.fields.map((field, index) => ({
      tableId: left.id,
      fieldId: left.fields[index]!.id,
      outputFieldId: field.id,
      sources: [left, right].map((input) => ({ tableId: input.id, fieldId: input.fields[index]!.id })),
    })),
  };
  await send(databaseId, { kind: 'table.create', table: { ...output, joined } });
  const count = async () =>
    Number(
      (
        await query<{ count: string }>(
          server.pool,
          sql`SELECT count(*) FROM ${ident(server.schemas.app, 'sync_runs')} WHERE table_id = ${output.id}`,
        )
      ).rows[0]!.count,
    );
  const before = await count();
  await send(databaseId, {
    kind: 'table.update',
    tableId: output.id,
    joined,
    joinedFields: output.fields.map((field) => ({ ...field, name: `Combined ${field.name}` })),
  });
  expect((await count()) - before).toBe(1);
  const rows = await query<{ count: string }>(
    server.pool,
    sql`SELECT count(*) FROM ${ident(server.schemas.data, output.id)} WHERE __deleted_at IS NULL AND NOT __source_gone`,
  );
  expect(Number(rows.rows[0]!.count)).toBe(27549);
});

describe('join suggestions on a million records', () => {
  it('samples, scans each large table once, counts examples exactly, and answers partially when out of time', async () => {
    const accounts = table('Accounts', [
      ['Name', 'text'],
      ['code', 'text'],
      ['region_id', 'number'],
    ]);
    const regions = table('Regions', [
      ['Name', 'text'],
      ['id', 'number'],
    ]);
    const tickets = table('Tickets', [
      ['Subject', 'text'],
      ['account_code', 'text'],
    ]);
    const databaseId = await createDatabase(accounts, regions, tickets);
    await insert(
      databaseId,
      regions,
      Array.from({ length: 20 }, (_, index) => ({ Name: `Region ${index + 1}`, id: index + 1 })),
    );
    await insert(
      databaseId,
      tickets,
      Array.from({ length: 40 }, (_, index) => ({
        Subject: `Ticket ${index + 1}`,
        account_code: `A${String(index * 997 + 1).padStart(7, '0')}`,
      })),
    );
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.data, accounts.id)}
      (__id, ${ident(fieldOf(accounts, 'Name'))}, ${ident(fieldOf(accounts, 'code'))}, ${ident(fieldOf(accounts, 'region_id'))})
      SELECT 'rec' || lpad(g::text, 14, '0'), 'Account ' || g, 'A' || lpad(g::text, 7, '0'), (g % 20) + 1
      FROM generate_series(1, 1000000) AS g`,
    );
    // Whatever the machine, an answer arrives within the budget plus one query's allowance.
    const timed = await suggestions(databaseId);
    expect(timed.ms).toBeLessThan(JOIN_LIMITS.budgetMs + JOIN_LIMITS.statementMs);
    const limits = { ...JOIN_LIMITS };
    try {
      // Generous limits here, so a slow machine still finishes the comparison being checked.
      Object.assign(JOIN_LIMITS, { budgetMs: 60_000, statementMs: 30_000 });
      const result = await suggestions(databaseId);
      expect(result.profiledFields).toBe(7);
      const byPair = new Map(result.suggestions.map((s) => [`${s.fromFieldId}>${s.toFieldId}`, s]));
      const codes = byPair.get(`${fieldOf(tickets, 'account_code')}>${fieldOf(accounts, 'code')}`);
      expect(codes).toMatchObject({ coverage: 1, uniqueness: 1, namesMatch: true });
      const regionsFound = byPair.get(`${fieldOf(accounts, 'region_id')}>${fieldOf(regions, 'id')}`);
      expect(regionsFound).toMatchObject({ coverage: 1, uniqueness: 1, namesMatch: true });
      // Examples from the sampled table carry exact counts.
      expect(regionsFound!.examples).toHaveLength(3);
      for (const example of regionsFound!.examples) expect(example.records).toBe(50_000);
      Object.assign(JOIN_LIMITS, limits);

      JOIN_LIMITS.maxFields = 3;
      expect((await suggestions(databaseId)).profiledFields).toBe(3);
      JOIN_LIMITS.maxFields = limits.maxFields;
      JOIN_LIMITS.statementMs = 1;
      const hurried = await suggestions(databaseId);
      expect(hurried.suggestions.some((s) => s.toFieldId === fieldOf(accounts, 'code'))).toBe(false);
      JOIN_LIMITS.budgetMs = 0;
      expect(await suggestions(databaseId)).toMatchObject({ suggestions: [], profiledFields: 0 });
    } finally {
      Object.assign(JOIN_LIMITS, limits);
    }
  }, 120_000);
});

/** Orders that follow customers by number, with helpers to read both sides of the link. */
async function matched() {
  const customers = table('Customers', [
    ['Name', 'text'],
    ['id', 'number'],
    ['Active', 'checkbox'],
  ]);
  const orders = table('Orders', [
    ['Title', 'text'],
    ['customer_id', 'text'],
  ]);
  const databaseId = await createDatabase(customers, orders);
  const [ada, grace, linus] = await insert(databaseId, customers, [
    { Name: 'Ada', id: 1 },
    { Name: 'Grace', id: 2 },
    { Name: 'Linus', id: 3 },
  ]);
  const [first, second, third, loose] = await insert(databaseId, orders, [
    { Title: 'First', customer_id: '1' },
    { Title: 'Second', customer_id: ' 1 ' },
    { Title: 'Third', customer_id: '2' },
    { Title: 'Loose', customer_id: '9' },
  ]);
  const linkId = newId('field');
  const group = await send(databaseId, {
    kind: 'field.create',
    tableId: orders.id,
    field: {
      id: linkId,
      name: 'Customer',
      type: 'link',
      options: {
        linkedTableId: customers.id,
        match: { fieldId: fieldOf(orders, 'customer_id'), linkedFieldId: fieldOf(customers, 'id') },
      },
    },
  });
  const schema = await get<DatabaseSchema>(`/api/databases/${databaseId}/schema`);
  const link = schema.fields.find((field) => field.id === linkId) as Extract<FieldMeta, { type: 'link' }>;
  const inverseId = link.options.inverseFieldId!;
  const links = async (id: string) => (await read(orders.id, id)).values[linkId];
  const orderIds = async (id: string) => (await read(customers.id, id)).values[inverseId];
  /** Junction rows as order and customer record IDs, trashed records included. */
  const edges = async () => {
    const row = await query<{ id: string }>(
      server.pool,
      sql`SELECT id FROM ${ident(server.schemas.app, 'links')} WHERE left_field_id = ${linkId}`,
    );
    const result = await query<{ edge: string }>(
      server.pool,
      sql`SELECT o.__id || '>' || c.__id AS edge FROM ${ident(server.schemas.data, `lnk_${row.rows[0]!.id}`)} e
      JOIN ${ident(server.schemas.data, orders.id)} o ON o.__rid = e.left_rid
      JOIN ${ident(server.schemas.data, customers.id)} c ON c.__rid = e.right_rid ORDER BY 1`,
    );
    return result.rows.map((row) => row.edge);
  };
  const edit = (target: TableInput, id: string, values: Record<string, unknown>, error?: string) =>
    send(
      databaseId,
      {
        kind: 'record.update',
        tableId: target.id,
        records: [
          {
            id,
            values: Object.fromEntries(
              Object.entries(values).map(([name, value]) => [
                target.fields.find((field) => field.name === name)?.id ?? name,
                value,
              ]),
            ),
          },
        ],
      },
      error,
    );
  const linkChanges = async (groupId: string) =>
    (
      await query<{ body: ChangeBody; actor_id: string | null }>(
        server.pool,
        sql`SELECT body, actor_id FROM ${ident(server.schemas.app, 'changes')}
        WHERE database_id = ${databaseId} AND group_id = ${groupId} AND kind = 'record.linksChanged' ORDER BY seq`,
      )
    ).rows;
  const undo = async (groupId: string, direction = 'undo') => {
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${databaseId}/${direction}`,
      headers: server.owner.headers,
      payload: { commandId: newId('command'), clientId, groupId },
    });
    expect(response.statusCode, response.body).toBe(200);
  };
  return {
    databaseId,
    customers,
    orders,
    linkId,
    inverseId,
    group,
    link,
    ids: {
      ada: ada!,
      grace: grace!,
      linus: linus!,
      first: first!,
      second: second!,
      third: third!,
      loose: loose!,
    },
    links,
    orderIds,
    edges,
    edit,
    linkChanges,
    undo,
    schema: () => get<DatabaseSchema>(`/api/databases/${databaseId}/schema`),
  };
}

describe('links that follow matching values', () => {
  it('follows relationship ID arrays and updates both directions through commands', async () => {
    const nodes = table('Nodes', [
      ['Name', 'text'],
      ['id', 'text'],
    ]);
    const owners = table('Owners', [
      ['Name', 'text'],
      ['targets', 'json'],
    ]);
    const databaseId = await createDatabase(nodes, owners);
    const [a, b] = await insert(databaseId, nodes, [
      { Name: 'A', id: 'node-a' },
      { Name: 'B', id: 'node-b' },
    ]);
    const [owner, empty] = await insert(databaseId, owners, [
      { Name: 'Owner', targets: JSON.stringify(['node-a', 'node-b']) },
      { Name: 'Empty', targets: '{}' },
    ]);
    const linkId = newId('field');
    await send(databaseId, {
      kind: 'field.create',
      tableId: owners.id,
      field: {
        id: linkId,
        name: 'Related nodes',
        type: 'link',
        options: {
          linkedTableId: nodes.id,
          match: { fieldId: fieldOf(owners, 'targets'), linkedFieldId: fieldOf(nodes, 'id') },
        },
      },
    });
    expect((await read(owners.id, owner!)).values[linkId]).toEqual([a, b]);
    expect((await read(owners.id, empty!)).values[linkId]).toEqual([]);
    const schema = await get<DatabaseSchema>(`/api/databases/${databaseId}/schema`);
    const link = schema.fields.find((field) => field.id === linkId) as Extract<FieldMeta, { type: 'link' }>;
    expect((await read(nodes.id, a!)).values[link.options.inverseFieldId!]).toEqual([owner]);
    await send(databaseId, {
      kind: 'record.update',
      tableId: owners.id,
      records: [{ id: owner, values: { [fieldOf(owners, 'targets')]: JSON.stringify(['node-b']) } }],
    });
    expect((await read(owners.id, owner!)).values[linkId]).toEqual([b]);
    expect((await read(nodes.id, a!)).values[link.options.inverseFieldId!]).toEqual([]);
    await send(databaseId, {
      kind: 'record.update',
      tableId: nodes.id,
      records: [{ id: b, values: { [fieldOf(nodes, 'id')]: 'node-c' } }],
    });
    expect((await read(owners.id, owner!)).values[linkId]).toEqual([]);
  });

  it('fills the junction when created, mirrors the match, and broadcasts the lists', async () => {
    const f = await matched();
    const { ada, grace, first, second, third, loose } = f.ids;
    expect(f.link.options.match).toEqual({
      fieldId: fieldOf(f.orders, 'customer_id'),
      linkedFieldId: fieldOf(f.customers, 'id'),
    });
    const inverse = (await f.schema()).fields.find((field) => field.id === f.inverseId)!;
    expect(inverse.type === 'link' && inverse.options.match).toEqual({
      fieldId: fieldOf(f.customers, 'id'),
      linkedFieldId: fieldOf(f.orders, 'customer_id'),
    });
    expect(await f.edges()).toEqual([`${first}>${ada}`, `${second}>${ada}`, `${third}>${grace}`].sort());
    expect(await f.links(first)).toEqual([ada]);
    expect(await f.links(loose)).toEqual([]);
    expect(await f.orderIds(ada)).toEqual([first, second]);
    const changes = await f.linkChanges(f.group);
    expect(changes.map(({ body }) => body.kind === 'record.linksChanged' && body.fieldId)).toEqual([
      f.linkId,
      f.inverseId,
    ]);
    expect(changes[1]!.body).toMatchObject({
      tableId: f.customers.id,
      records: [
        { id: ada, ids: [first, second] },
        { id: grace, ids: [third] },
      ],
    });
  });

  it('keeps the junction exact through value edits on both sides, new records, and undo', async () => {
    const f = await matched();
    const { ada, grace, linus, first, second, third, loose } = f.ids;
    const moved = await f.edit(f.orders, first, { customer_id: '3' });
    expect(await f.links(first)).toEqual([linus]);
    expect(await f.orderIds(ada)).toEqual([second]);
    const changes = await f.linkChanges(moved);
    expect(changes.map(({ body }) => body.kind === 'record.linksChanged' && body.fieldId)).toEqual([
      f.linkId,
      f.inverseId,
    ]);
    expect(changes[1]!.body).toMatchObject({
      records: [
        { id: ada, ids: [second] },
        { id: linus, ids: [first] },
      ],
    });
    expect(changes.every(({ actor_id }) => actor_id === server.owner.userId)).toBe(true);
    await f.edit(f.customers, grace, { id: 9 });
    expect(await f.links(third)).toEqual([]);
    expect(await f.links(loose)).toEqual([grace]);
    expect(await f.orderIds(grace)).toEqual([loose]);
    await f.undo(moved);
    expect(await f.links(first)).toEqual([ada]);
    const [newOrder] = await insert(f.databaseId, f.orders, [{ Title: 'New', customer_id: '9' }]);
    expect(await f.links(newOrder!)).toEqual([grace]);
    const [twin] = await insert(f.databaseId, f.customers, [{ Name: 'Twin', id: 9 }]);
    expect(await f.links(loose)).toEqual([grace, twin]);
    expect(await f.edges()).toEqual(
      [
        `${first}>${ada}`,
        `${second}>${ada}`,
        `${loose}>${grace}`,
        `${loose}>${twin}`,
        `${newOrder}>${grace}`,
        `${newOrder}>${twin}`,
      ].sort(),
    );
    // Values of any length can be followed, not only ones short enough for an ordinary index.
    await f.edit(f.orders, loose, { customer_id: `9${' '.repeat(10)}${'x'.repeat(5000)}` });
    expect(await f.links(loose)).toEqual([]);
  });

  it('follows trashed and restored records, including values that changed meanwhile', async () => {
    const f = await matched();
    const { ada, grace, first, second, third } = f.ids;
    const trashed = await send(f.databaseId, {
      kind: 'record.trash',
      tableId: f.customers.id,
      recordIds: [ada],
    });
    expect(await f.links(first)).toEqual([]);
    const changes = await f.linkChanges(trashed);
    expect(changes.map(({ body }) => body.kind === 'record.linksChanged' && body.fieldId)).toEqual([
      f.linkId,
    ]);
    await f.edit(f.orders, third, { customer_id: '1' });
    expect(await f.links(third)).toEqual([]);
    await send(f.databaseId, { kind: 'record.restore', tableId: f.customers.id, recordIds: [ada] });
    expect(await f.links(third)).toEqual([ada]);
    expect(await f.orderIds(ada)).toEqual([first, second, third]);
    expect(await f.orderIds(grace)).toEqual([]);
    await send(f.databaseId, { kind: 'record.trash', tableId: f.orders.id, recordIds: [second] });
    expect(await f.orderIds(ada)).toEqual([first, third]);
    await send(f.databaseId, { kind: 'record.restore', tableId: f.orders.id, recordIds: [second] });
    expect(await f.orderIds(ada)).toEqual([first, second, third]);
    // Values that change while the linked table is in the trash are caught up when it comes back.
    await send(f.databaseId, { kind: 'table.trash', tableId: f.customers.id });
    await f.edit(f.orders, first, { customer_id: '2' });
    const restored = await send(f.databaseId, { kind: 'table.restore', tableId: f.customers.id });
    expect(await f.links(first)).toEqual([grace]);
    expect(await f.orderIds(grace)).toEqual([first]);
    expect((await f.linkChanges(restored)).length).toBeGreaterThan(0);
  });

  it('refuses hand edits on either side, including pastes and new records', async () => {
    const f = await matched();
    const { ada, grace, first, second } = f.ids;
    await f.edit(f.orders, first, { [f.linkId]: [grace] }, 'data.link.matched');
    await f.edit(f.customers, grace, { [f.inverseId]: [first] }, 'data.link.matched');
    await send(
      f.databaseId,
      {
        kind: 'record.update',
        tableId: f.orders.id,
        records: [
          { id: first, values: { [fieldOf(f.orders, 'Title')]: 'Pasted' } },
          { id: second, values: { [f.linkId]: [] } },
        ],
      },
      'data.link.matched',
    );
    await send(
      f.databaseId,
      {
        kind: 'record.create',
        tableId: f.orders.id,
        records: [{ id: newId('record'), values: { [f.linkId]: [ada] } }],
      },
      'data.link.matched',
    );
    expect((await read(f.orders.id, first)).values[fieldOf(f.orders, 'Title')]).toBe('First');
    expect(await f.links(first)).toEqual([ada]);
    // A form leaves out a question on the link, even a required one, and links by the answers.
    const formId = newId('view');
    await send(f.databaseId, {
      kind: 'view.create',
      view: {
        id: formId,
        name: 'Order form',
        tableId: f.orders.id,
        type: 'form',
        config: {
          form: {
            questions: [{ fieldId: fieldOf(f.orders, 'customer_id') }, { fieldId: f.linkId, required: true }],
          },
        },
      },
    });
    const answered = newId('record');
    await send(f.databaseId, {
      kind: 'record.create',
      tableId: f.orders.id,
      formViewId: formId,
      records: [{ id: answered, values: { [fieldOf(f.orders, 'customer_id')]: '1' } }],
    });
    expect(await f.links(answered)).toEqual([ada]);
  });

  it('turns into an ordinary link when a matched field is trashed, and matches again when that is undone', async () => {
    const f = await matched();
    const { ada, grace, first } = f.ids;
    const trash = await send(f.databaseId, { kind: 'field.trash', fieldId: fieldOf(f.customers, 'id') });
    const fields = (await f.schema()).fields;
    for (const id of [f.linkId, f.inverseId]) {
      const value = fields.find((field) => field.id === id)!;
      expect(value.type === 'link' && value.options.match).toBeUndefined();
    }
    expect(await f.links(first)).toEqual([ada]);
    await f.edit(f.orders, first, { [f.linkId]: [grace] });
    expect(await f.links(first)).toEqual([grace]);
    await f.undo(trash);
    const restored = (await f.schema()).fields.find((field) => field.id === f.linkId)!;
    expect(restored.type === 'link' && restored.options.match).toBeTruthy();
    expect(await f.links(first)).toEqual([ada]);
    await f.edit(f.orders, first, { [f.linkId]: [grace] }, 'data.link.matched');
  });

  it('rebuilds after conversions, becomes ordinary when a field stops holding keys, and can be turned off', async () => {
    const f = await matched();
    const { ada, grace, first, third } = f.ids;
    const convert = (fieldId: string, type: string) =>
      send(f.databaseId, { kind: 'field.convert', fieldId, to: { type }, dateOrder: 'mdy', timeZone: 'UTC' });
    await convert(fieldOf(f.customers, 'id'), 'text');
    expect(await f.links(first)).toEqual([ada]);
    await f.edit(f.customers, grace, { id: '1' });
    expect(await f.orderIds(grace)).toEqual([first, f.ids.second]);
    await convert(fieldOf(f.orders, 'customer_id'), 'checkbox');
    const link = (await f.schema()).fields.find((field) => field.id === f.linkId)!;
    expect(link.type === 'link' && link.options.match).toBeUndefined();
    expect(await f.links(first)).toEqual([ada, grace]);
    // Matching again by another pair of fields replaces the links it had.
    await send(f.databaseId, {
      kind: 'field.update',
      fieldId: f.linkId,
      options: {
        linkedTableId: f.customers.id,
        match: { fieldId: fieldOf(f.orders, 'Title'), linkedFieldId: fieldOf(f.customers, 'Name') },
      },
    });
    expect(await f.links(first)).toEqual([]);
    await f.edit(f.orders, third, { Title: 'Ada' });
    expect(await f.links(third)).toEqual([ada]);
    await send(f.databaseId, {
      kind: 'field.update',
      fieldId: f.inverseId,
      options: { linkedTableId: f.orders.id },
    });
    const off = (await f.schema()).fields.filter((field) => [f.linkId, f.inverseId].includes(field.id));
    expect(off.every((field) => field.type === 'link' && !field.options.match)).toBe(true);
    expect(await f.links(third)).toEqual([ada]);
    await f.edit(f.orders, third, { [f.linkId]: [] });
  });

  it('refuses matches between fields that can’t hold keys, the same field, or another table', async () => {
    const f = await matched();
    const create = (match: Record<string, string>, error: string) =>
      send(
        f.databaseId,
        {
          kind: 'field.create',
          tableId: f.orders.id,
          field: {
            id: newId('field'),
            name: newId('field'),
            type: 'link',
            options: { linkedTableId: f.customers.id, match },
          },
        },
        error,
      );
    await create(
      { fieldId: fieldOf(f.orders, 'customer_id'), linkedFieldId: fieldOf(f.customers, 'Active') },
      'errors.validationFailed',
    );
    await create(
      { fieldId: fieldOf(f.customers, 'id'), linkedFieldId: fieldOf(f.customers, 'Name') },
      'data.field.unknown',
    );
    await create({ fieldId: newId('field'), linkedFieldId: fieldOf(f.customers, 'id') }, 'errors.notFound');
    await send(
      f.databaseId,
      {
        kind: 'field.create',
        tableId: f.orders.id,
        field: {
          id: newId('field'),
          name: 'Self',
          type: 'link',
          options: {
            linkedTableId: f.orders.id,
            match: { fieldId: fieldOf(f.orders, 'Title'), linkedFieldId: fieldOf(f.orders, 'Title') },
          },
        },
      },
      'errors.validationFailed',
    );
  });

  it('pairs and follows values for a link made inside its table, and refuses a match it cannot follow', async () => {
    const customers = table('Customers', [
      ['Name', 'text'],
      ['id', 'number'],
    ]);
    const databaseId = await createDatabase(customers);
    const [ada] = await insert(databaseId, customers, [{ Name: 'Ada', id: 1 }]);
    const withLink = (name: string, match: { fieldId: string; linkedFieldId: string } | null) => {
      const made = table(name, [
        ['Title', 'text'],
        ['customer_id', 'text'],
      ]);
      const linkId = newId('field');
      made.fields.push({
        id: linkId,
        name: 'Customer',
        type: 'link',
        options: {
          linkedTableId: customers.id,
          match: match ?? { fieldId: fieldOf(made, 'customer_id'), linkedFieldId: fieldOf(customers, 'id') },
        },
      });
      return { made, linkId };
    };
    const { made: orders, linkId } = withLink('Orders', null);
    await send(databaseId, { kind: 'table.create', table: orders });
    const schema = await get<DatabaseSchema>(`/api/databases/${databaseId}/schema`);
    const link = schema.fields.find((field) => field.id === linkId) as Extract<FieldMeta, { type: 'link' }>;
    const inverse = schema.fields.find((field) => field.id === link.options.inverseFieldId);
    expect(inverse).toMatchObject({
      tableId: customers.id,
      type: 'link',
      options: {
        inverseFieldId: linkId,
        match: { fieldId: fieldOf(customers, 'id'), linkedFieldId: fieldOf(orders, 'customer_id') },
      },
    });
    const [first] = await insert(databaseId, orders, [{ Title: 'First', customer_id: '1' }]);
    expect((await read(orders.id, first!)).values[linkId]).toEqual([ada]);
    expect((await read(customers.id, ada!)).values[inverse!.id]).toEqual([first]);
    const { made: wrong } = withLink('Wrong', {
      fieldId: fieldOf(customers, 'Name'),
      linkedFieldId: fieldOf(customers, 'id'),
    });
    await send(databaseId, { kind: 'table.create', table: wrong }, 'data.field.unknown');
    expect((await get<DatabaseSchema>(`/api/databases/${databaseId}/schema`)).tables).toHaveLength(2);
  });
});

describe('links that follow values from a synced table', () => {
  it('keeps the junction exact when a sync adds, changes, and removes records, and broadcasts it', async () => {
    const orders = table('Orders', [
      ['Title', 'text'],
      ['customer_id', 'text'],
    ]);
    const databaseId = await createDatabase(orders);
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/sources',
      headers: server.owner.headers,
      payload: {
        name: 'Warehouse',
        connection: { kind: 'postgres', host: 'example.test', database: 'data', user: 'reader' },
        secrets: { password: 'unused' },
        access: 'creators',
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const source = created.json<SourceMeta>();
    const customersId = newId('table');
    const keyField = newId('field');
    const nameField = newId('field');
    await send(databaseId, {
      kind: 'table.create',
      table: {
        id: customersId,
        name: 'Customers',
        source: {
          sourceId: source.id,
          select: { kind: 'object', object: { schema: null, name: customersId } },
          keyColumns: ['id'],
          everyMinutes: null,
        },
        fields: [
          { id: nameField, name: 'Name', type: 'text', source: { column: 'name', sourceType: '' } },
          { id: keyField, name: 'Key', type: 'number', source: { column: 'id', sourceType: '' } },
        ],
        view: { id: newId('view'), name: 'Grid' },
        records: [],
      },
    });
    const sync = async (rows: Array<[number, string]>) => {
      remote.set(
        customersId,
        rows.map(([id, name]) => ({ key: sourceKey([id]), values: { id, name } })),
      );
      await send(databaseId, { kind: 'table.sync', tableId: customersId, confirmRemovals: false });
      for (const job of await claimSyncs(server.ctx, 100)) await runSync(server.ctx, job);
    };
    await sync([
      [1, 'Ada'],
      [2, 'Grace'],
    ]);
    const [first, second, third] = await insert(databaseId, orders, [
      { Title: 'First', customer_id: '1' },
      { Title: 'Second', customer_id: '2' },
      { Title: 'Third', customer_id: '3' },
    ]);
    const linkId = newId('field');
    await send(databaseId, {
      kind: 'field.create',
      tableId: orders.id,
      field: {
        id: linkId,
        name: 'Customer',
        type: 'link',
        options: {
          linkedTableId: customersId,
          match: { fieldId: fieldOf(orders, 'customer_id'), linkedFieldId: keyField },
        },
      },
    });
    const customerOf = async (id: string) => {
      const ids = (await read(orders.id, id)).values[linkId] as string[];
      return Promise.all(ids.map(async (record) => (await read(customersId, record)).values[nameField]));
    };
    expect(await customerOf(first!)).toEqual(['Ada']);
    expect(await customerOf(second!)).toEqual(['Grace']);
    expect(await customerOf(third!)).toEqual([]);
    const before = await query<{ seq: string }>(
      server.pool,
      sql`SELECT coalesce(max(seq), 0) AS seq FROM ${ident(server.schemas.app, 'changes')} WHERE database_id = ${databaseId}`,
    );
    await sync([
      [2, 'Grace'],
      [3, 'Linus'],
    ]);
    expect(await customerOf(first!)).toEqual([]);
    expect(await customerOf(third!)).toEqual(['Linus']);
    const broadcast = await query<{ body: ChangeBody; actor_id: string | null }>(
      server.pool,
      sql`SELECT body, actor_id FROM ${ident(server.schemas.app, 'changes')}
      WHERE database_id = ${databaseId} AND seq > ${before.rows[0]!.seq}::bigint AND kind = 'record.linksChanged'`,
    );
    const lists = broadcast.rows.flatMap(({ body }) =>
      body.kind === 'record.linksChanged' && body.fieldId === linkId
        ? body.records.map((record) => record.id)
        : [],
    );
    expect(lists.sort()).toEqual([first!, third!].sort());
    expect(broadcast.rows.every(({ actor_id }) => actor_id === null)).toBe(true);
    await sync([
      [1, 'Ada'],
      [2, 'Grace'],
      [3, 'Linus'],
    ]);
    expect(await customerOf(first!)).toEqual(['Ada']);
    await send(
      databaseId,
      { kind: 'record.update', tableId: orders.id, records: [{ id: first!, values: { [linkId]: [] } }] },
      'data.link.matched',
    );
  });
});
