import { randomBytes } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { newId, TableMeta, type Change } from '@riosoma/contracts';
import type { Queryable } from '@riosoma/db';
import type { AccessScope } from '../access.js';
import { changeFor } from '../../realtime/redact.js';
import { limitTable } from './redact.js';

function failedTable(messageKey = 'sources.sync.keyDuplicate') {
  const key = randomBytes(24).toString('hex');
  const at = new Date().toISOString();
  const table = TableMeta.parse({
    id: newId('table'),
    databaseId: newId('database'),
    name: 'Copied records',
    description: '',
    primaryFieldId: newId('field'),
    position: 0,
    createdAt: at,
    updatedAt: at,
    source: {
      sourceId: newId('source'),
      sourceName: 'Outside records',
      sourceKind: 'postgres',
      select: { kind: 'object', object: { schema: 'public', name: 'records' } },
      keyColumns: ['key'],
      status: {
        state: 'failed',
        lastSyncAt: at,
        lastSuccessAt: at,
        nextSyncAt: null,
        error: {
          messageKey,
          params: messageKey === 'sources.sync.columnMissing' ? { column: key } : { key },
          detail: `Source diagnostic ${key}`,
        },
        stats: null,
        held: null,
      },
    },
  });
  return { table, key };
}

it.each([
  [true, new Set<string>()],
  [false, new Set([newId('field')])],
])('withholds duplicate-key values for restricted source readers, limited records %s', (limited, hidden) => {
  const { table, key } = failedTable();
  const shown = limitTable(table, limited, hidden);
  expect(shown.source!.status.error).toEqual({ messageKey: 'sources.sync.keyDuplicate' });
  expect(table.source!.status.error?.params).toEqual({ key });
  expect(table.source!.status.error?.detail).toContain(key);
});

it('withholds missing-column names when fields are hidden', () => {
  const { table, key } = failedTable('sources.sync.columnMissing');
  expect(limitTable(table, false, new Set([newId('field')])).source!.status.error).toEqual({
    messageKey: 'sources.sync.columnMissing',
  });
  expect(table.source!.status.error?.params).toEqual({ column: key });
});

it.each(['sources.sync.read', 'sources.sync.failed'])(
  'withholds source read diagnostics that can contain restricted row values for %s',
  (messageKey) => {
    const { table } = failedTable(messageKey);
    expect(limitTable(table, true).source!.status.error).toEqual({ messageKey });
    expect(limitTable(table, false, new Set([newId('field')])).source!.status.error).toEqual({ messageKey });
    expect(limitTable(table, false).source!.status.error?.detail).toBe(table.source!.status.error?.detail);
  },
);

it('keeps source diagnostics for an unrestricted reader', () => {
  const { table } = failedTable();
  expect(limitTable(table, false)).toBe(table);
});

it('withholds copy row counts from limited readers without changing the stored status', () => {
  const { table } = failedTable();
  table.source!.status.progress = { rowsRead: 50_000 };
  expect(limitTable(table, true).source!.status.progress).toBeUndefined();
  expect(table.source!.status.progress).toEqual({ rowsRead: 50_000 });
  expect(limitTable(table, false).source!.status.progress).toEqual({ rowsRead: 50_000 });
});

it('keeps source diagnostics when hidden fields belong to another table', () => {
  const { table } = failedTable();
  expect(limitTable(table, false, new Set([newId('field')]), new Set())).toBe(table);
});

it('redacts sync broadcasts when field access is limited without a record rule', async () => {
  const { table } = failedTable();
  const scope = {
    hiddenFieldIds: () => new Set([newId('field')]),
    limitsRecords: () => false,
  } as unknown as AccessScope;
  const stats = { added: 0, changed: 0, removed: 0, unchanged: 0, overridesCleared: 0, ms: 1 };
  const change: Change = {
    kind: 'table.synced',
    table,
    stats,
    seq: 1,
    databaseId: table.databaseId,
    commandId: newId('command'),
    groupId: newId('action'),
    actorId: null,
    clientId: null,
    at: table.updatedAt,
  };
  const query = vi.fn();
  const shown = await changeFor(
    { query } as unknown as Queryable,
    { app: 'metadata', data: 'records', audit: 'audit' },
    scope,
    table.databaseId,
    change,
  );
  expect(shown?.kind).toBe('table.synced');
  if (shown?.kind !== 'table.synced') throw new Error('Expected a sync broadcast');
  expect(shown.table.source!.status.error).toEqual({ messageKey: 'sources.sync.keyDuplicate' });
  expect(shown.stats).toEqual(stats);
  expect(query).not.toHaveBeenCalled();
});

it('checks table access and redacts row counts on progress broadcasts', async () => {
  const { table } = failedTable();
  table.source!.status.progress = { rowsRead: 50_000 };
  const ensureTable = vi.fn(async () => undefined);
  const scope = {
    hiddenFieldIds: () => new Set(),
    limitsRecords: () => true,
    ensureTable,
  } as unknown as AccessScope;
  const change: Change = {
    kind: 'table.updated',
    table,
    syncProgress: true,
    seq: 1,
    databaseId: table.databaseId,
    commandId: newId('command'),
    groupId: newId('action'),
    actorId: null,
    clientId: null,
    at: table.updatedAt,
  };
  const shown = await changeFor(
    { query: vi.fn() } as unknown as Queryable,
    { app: 'metadata', data: 'records', audit: 'audit' },
    scope,
    table.databaseId,
    change,
  );
  expect(ensureTable).toHaveBeenCalledWith(table.id);
  expect(shown).toMatchObject({ kind: 'table.updated', syncProgress: true });
  if (shown?.kind !== 'table.updated') throw new Error('Expected copy progress');
  expect(shown.table.source!.status.progress).toBeUndefined();
  expect(table.source!.status.progress).toEqual({ rowsRead: 50_000 });
});
