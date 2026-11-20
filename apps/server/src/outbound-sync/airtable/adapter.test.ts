import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RateLimiter } from '../../data/imports/core/clock.js';
import { systemResolve } from '../../automations/outbound.js';
import { startFakeAirtable, type FakeAirtable } from '../../test/fake-airtable.js';
import { createOutboundHttp } from '../http.js';
import type {
  ColumnPlan,
  DestinationAdapter,
  DestinationContext,
  MappedColumn,
  OutboundCell,
  OutsideColumn,
  OutsideTable,
  RowWrite,
} from '../destination.js';
import { createAirtableDestination } from './adapter.js';

/**
 * The Airtable adapter against the extended fake: typed column creation, upserts in tens with a
 * per-row result after a value is refused, removal, key paging, adoption of a table a run already
 * made, and each row of the problem table.
 */

const BASE_ID = `app${'a'.repeat(14)}`;
const adapter = createAirtableDestination({});
let fake: FakeAirtable;
let token: string;
const immediate = { now: () => 0, sleep: async () => {} };

const destination = {
  kind: 'airtable' as const,
  baseId: BASE_ID,
  baseName: 'Base',
  table: { id: null as string | null, name: 'Made', created: true, url: null },
};

function ctx(): DestinationContext {
  return {
    http: createOutboundHttp({
      adapter: adapter as unknown as DestinationAdapter,
      where: destination,
      credential: { token },
      address: fake.url,
      limiter: new RateLimiter(immediate, 100),
      clock: immediate,
      resolve: systemResolve,
      allowPrivate: () => true,
      signal: new AbortController().signal,
    }),
    signal: new AbortController().signal,
  };
}

const plan = (fieldId: string, name: string, kind: ColumnPlan['kind'], primary = false): ColumnPlan => ({
  fieldId,
  name,
  kind,
  primary,
});
const keyPlan: ColumnPlan = { fieldId: null, name: 'Riosoma record ID', kind: 'text', primary: false };

beforeAll(async () => {
  token = `pat${randomUUID().replace(/-/g, '')}`;
  fake = await startFakeAirtable({
    token,
    bases: [{ id: BASE_ID, name: 'Base', permissionLevel: 'create', tables: [] }],
  });
});

beforeEach(() => {
  fake.bases[0]!.tables.length = 0;
  fake.requests.length = 0;
  fake.reset();
});

afterAll(async () => {
  await fake?.close();
});

function mapped(table: OutsideTable): { key: OutsideColumn; columns: MappedColumn[] } {
  const by = (name: string) => table.columns.find((c) => c.name === name)!;
  return {
    key: by('Riosoma record ID'),
    columns: [
      { plan: plan('fName', 'Name', 'text', true), column: by('Name'), write: 'typed' },
      { plan: plan('fAmount', 'Amount', 'number'), column: by('Amount'), write: 'typed' },
    ],
  };
}

function cells(name: string, amount: number): OutboundCell[] {
  return [{ text: name }, { text: String(amount), number: amount }];
}

describe('the Airtable adapter', () => {
  it('makes a table with each plan’s fitting type and the key column', async () => {
    const table = await adapter.createTable(
      ctx(),
      destination,
      [plan('fName', 'Name', 'text', true), plan('fAmount', 'Amount', 'number'), keyPlan],
      { syncId: 'osy00000000000a', since: null, taken: [] },
    );
    expect(table.columns.map((c) => [c.name, c.type])).toEqual([
      ['Name', 'singleLineText'],
      ['Amount', 'number'],
      ['Riosoma record ID', 'singleLineText'],
    ]);
  });

  it('upserts rows, reports created then updated, and removes them', async () => {
    const table = await adapter.createTable(
      ctx(),
      destination,
      [plan('fName', 'Name', 'text', true), plan('fAmount', 'Amount', 'number'), keyPlan],
      {
        syncId: 'osy00000000000b',
        since: null,
        taken: [],
      },
    );
    const dest = { ...destination, table: { ...destination.table, id: table.id } };
    const { key, columns } = mapped(table);
    const rows: RowWrite[] = [
      { recordId: 'rec00000000000001', cells: cells('Alpha', 1) },
      { recordId: 'rec00000000000002', cells: cells('Beta', 2) },
    ];
    const made = await adapter.apply(ctx(), dest, table, key, columns, { op: 'create', rows });
    expect(made.every((r) => r.outcome === 'created')).toBe(true);
    const externalId = (made[0] as { externalId: string }).externalId;

    const updated = await adapter.apply(ctx(), dest, table, key, columns, {
      op: 'update',
      rows: [{ recordId: 'rec00000000000001', cells: cells('Alpha2', 9), externalId }],
    });
    expect(updated[0]).toMatchObject({ outcome: 'updated', externalId });

    const removed = await adapter.apply(ctx(), dest, table, key, columns, {
      op: 'remove',
      rows: [{ recordId: 'rec00000000000001', externalId }],
    });
    expect(removed[0]).toMatchObject({ outcome: 'removed' });
  });

  it('sends a refused batch one row at a time and reports each row’s own result', async () => {
    const table = await adapter.createTable(
      ctx(),
      destination,
      [plan('fName', 'Name', 'text', true), plan('fAmount', 'Amount', 'number'), keyPlan],
      {
        syncId: 'osy00000000000c',
        since: null,
        taken: [],
      },
    );
    const dest = { ...destination, table: { ...destination.table, id: table.id } };
    const { key, columns } = mapped(table);
    // Any write naming "Bad" is refused as a value error.
    fake.failWrite(
      (request) => JSON.stringify((request.body as { records: unknown[] }).records).includes('Bad'),
      9,
      'INVALID_VALUE_FOR_COLUMN',
    );
    const results = await adapter.apply(ctx(), dest, table, key, columns, {
      op: 'create',
      rows: [
        { recordId: 'rec00000000000011', cells: cells('Good', 1) },
        { recordId: 'rec00000000000012', cells: cells('Bad', 2) },
      ],
    });
    expect(results.find((r) => r.recordId === 'rec00000000000011')).toMatchObject({ outcome: 'created' });
    expect(results.find((r) => r.recordId === 'rec00000000000012')).toMatchObject({ outcome: 'failed' });
  });

  it('pages the key column, reading only record IDs', async () => {
    const table = await adapter.createTable(
      ctx(),
      destination,
      [plan('fName', 'Name', 'text', true), keyPlan],
      {
        syncId: 'osy00000000000d',
        since: null,
        taken: [],
      },
    );
    const dest = { ...destination, table: { ...destination.table, id: table.id } };
    const key = table.columns.find((c) => c.name === 'Riosoma record ID')!;
    const columns: MappedColumn[] = [
      { plan: plan('fName', 'Name', 'text', true), column: table.columns[0]!, write: 'typed' },
    ];
    await adapter.apply(ctx(), dest, table, key, columns, {
      op: 'create',
      rows: [
        { recordId: 'rec00000000000021', cells: [{ text: 'A' }] },
        { recordId: 'rec00000000000022', cells: [{ text: 'B' }] },
      ],
    });
    const keys: Array<{ externalId: string; key: string }> = [];
    for await (const page of adapter.keys(ctx(), dest, table, key)) keys.push(...page);
    expect(keys.map((k) => k.key).sort()).toEqual(['rec00000000000021', 'rec00000000000022']);
  });

  it('adopts a table an earlier run of the same sync already made', async () => {
    const first = await adapter.createTable(
      ctx(),
      destination,
      [plan('fName', 'Name', 'text', true), keyPlan],
      {
        syncId: 'osy0000000000adopt',
        since: null,
        taken: [],
      },
    );
    const again = await adapter.createTable(
      ctx(),
      destination,
      [plan('fName', 'Name', 'text', true), keyPlan],
      {
        syncId: 'osy0000000000adopt',
        since: null,
        taken: [],
      },
    );
    expect(again.id).toBe(first.id);
    expect(fake.bases[0]!.tables).toHaveLength(1);
  });

  it('reads each row of the problem table from a status and body', () => {
    const read = { method: 'GET' as const, path: '/v0/app/tbl' };
    const write = { method: 'PATCH' as const, path: '/v0/app/tbl' };
    const bases = { method: 'GET' as const, path: '/v0/meta/bases' };
    expect(adapter.problem(401, {}, write)).toMatchObject({
      messageKey: 'syncOut.airtable.token',
      scope: 'sync',
    });
    expect(adapter.problem(403, {}, bases)).toMatchObject({
      messageKey: 'syncOut.airtable.token',
      scope: 'sync',
    });
    expect(adapter.problem(403, {}, write)).toMatchObject({
      messageKey: 'syncOut.airtable.scopes',
      scope: 'sync',
    });
    expect(adapter.problem(404, {}, read)).toMatchObject({
      messageKey: 'syncOut.airtable.gone',
      scope: 'sync',
    });
    expect(adapter.problem(422, { error: { type: 'DUPLICATE_TABLE_NAME' } }, write)).toMatchObject({
      messageKey: 'syncOut.airtable.nameTaken',
      scope: 'sync',
    });
    expect(adapter.problem(422, { error: { type: 'INVALID_RECORDS' } }, write)).toMatchObject({
      messageKey: 'syncOut.destination.duplicateKey',
      scope: 'run',
    });
    expect(adapter.problem(422, { error: { type: 'INVALID_VALUE_FOR_COLUMN' } }, write)).toMatchObject({
      messageKey: 'syncOut.airtable.valueUnknown',
      scope: 'row',
    });
    expect(
      adapter.problem(429, { error: { type: 'PUBLIC_API_BILLING_LIMIT_EXCEEDED' } }, write),
    ).toMatchObject({ messageKey: 'syncOut.airtable.full', scope: 'sync' });
    expect(adapter.problem(500, {}, write)).toMatchObject({
      messageKey: 'syncOut.destination.unreadable',
      scope: 'run',
    });
  });
});
