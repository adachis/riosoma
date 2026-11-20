import { describe, expect, it } from 'vitest';
import type { SyncOutColumn, SyncOutWrite } from '@riosoma/contracts';
import { reconcileColumns } from './columns.js';
import type { ColumnPlan, OutsideColumn, OutsideTable } from './destination.js';

/**
 * The column reconciliation is a pure function the preview and a run share.  It keeps a field's own
 * column, adopts one by name, makes a new one when allowed, skips when not, and clears a field that
 * stopped being sent, and it never claims the key column or one column for two fields.
 */

function plan(fieldId: string, name: string): ColumnPlan {
  return { fieldId, name, kind: 'text', primary: false };
}
const keyPlan: ColumnPlan = { fieldId: null, name: 'Riosoma record ID', kind: 'text', primary: false };

function column(
  id: string,
  name: string,
  options: { writable?: boolean; type?: string } = {},
): OutsideColumn {
  return {
    id,
    name,
    type: options.type ?? 'singleLineText',
    writable: options.writable ?? true,
    primary: false,
  };
}

function table(columns: OutsideColumn[]): OutsideTable {
  return { id: 'tbl1', name: 'Out', url: null, columns, rows: null };
}

// A plan fits a writable text column as typed, a writable non-text column as text, and nothing else.
const fit = (p: ColumnPlan, c: OutsideColumn): SyncOutWrite | null =>
  !c.writable ? null : c.type === 'singleLineText' ? 'typed' : 'text';

function run(input: {
  plans: ColumnPlan[];
  mapping?: SyncOutColumn[];
  columns: OutsideColumn[];
  keyColumnId?: string | null;
  createColumns?: boolean;
}) {
  return reconcileColumns({
    plans: input.plans,
    keyPlan,
    mapping: input.mapping ?? [],
    table: table(input.columns),
    keyColumnId: input.keyColumnId ?? null,
    createColumns: input.createColumns ?? true,
    columnNameLength: 50,
    fit,
  });
}

const stored = (fieldId: string, columnId: string, sent = true): SyncOutColumn => ({
  fieldId,
  fieldName: fieldId,
  columnId,
  columnName: columnId,
  columnType: 'singleLineText',
  write: 'typed',
  sent,
});

describe('reconcileColumns', () => {
  it('keeps a field on the column the last run used', () => {
    const recon = run({
      plans: [plan('fA', 'A')],
      mapping: [stored('fA', 'colA')],
      columns: [column('colA', 'Renamed outside'), column('key1', 'Riosoma record ID')],
      keyColumnId: 'key1',
    });
    expect(recon.columns).toEqual([
      expect.objectContaining({ action: 'match', column: expect.objectContaining({ id: 'colA' }) }),
    ]);
    expect(recon.key).toEqual({ action: 'match', column: expect.objectContaining({ id: 'key1' }) });
  });

  it('adopts a column by name, makes one when adding is on, and skips when it is off', () => {
    const columns = [column('colB', 'B'), column('key1', 'Riosoma record ID')];
    const allowed = run({ plans: [plan('fB', 'B'), plan('fC', 'C')], columns, keyColumnId: 'key1' });
    expect(allowed.columns[0]).toMatchObject({ action: 'match', column: { id: 'colB' } });
    expect(allowed.columns[1]).toMatchObject({ action: 'create', name: 'C' });

    const off = run({ plans: [plan('fC', 'C')], columns, keyColumnId: 'key1', createColumns: false });
    expect(off.columns[0]).toMatchObject({ action: 'skip', reason: 'syncOut.skip.noColumn' });
  });

  it('skips a field whose name matches a column that cannot be written, and never remakes it', () => {
    const recon = run({
      plans: [plan('fD', 'Formula')],
      columns: [
        column('colD', 'Formula', { writable: false, type: 'formula' }),
        column('key1', 'Riosoma record ID'),
      ],
      keyColumnId: 'key1',
    });
    expect(recon.columns[0]).toMatchObject({ action: 'skip', reason: 'syncOut.skip.readOnly' });
  });

  it('clears a field that is no longer sent but keeps its column', () => {
    const recon = run({
      plans: [plan('fA', 'A')],
      mapping: [stored('fA', 'colA'), stored('fE', 'colE')],
      columns: [column('colA', 'A'), column('colE', 'E'), column('key1', 'Riosoma record ID')],
      keyColumnId: 'key1',
    });
    expect(recon.retired).toEqual([
      expect.objectContaining({
        entry: expect.objectContaining({ fieldId: 'fE' }),
        column: expect.objectContaining({ id: 'colE' }),
      }),
    ]);
  });

  it('never claims the key column for a field and leaves other columns alone', () => {
    const recon = run({
      plans: [plan('fKey', 'Riosoma record ID')],
      columns: [column('key1', 'Riosoma record ID'), column('other', 'Untouched')],
      keyColumnId: 'key1',
    });
    // The field named like the key can't take the key column, so with adding on it gets a new one.
    expect(recon.columns[0]).toMatchObject({ action: 'create' });
    expect(recon.columns[0]).not.toMatchObject({ action: 'match', column: { id: 'key1' } });
    expect(recon.untouched).toEqual(['Untouched']);
  });

  it('adopts the key column by name only when it is a writable text column', () => {
    const writable = run({ plans: [], columns: [column('key1', 'riosoma record id')] });
    expect(writable.key).toEqual({ action: 'match', column: expect.objectContaining({ id: 'key1' }) });

    const computed = run({
      plans: [],
      columns: [column('key1', 'Riosoma record ID', { writable: false, type: 'formula' })],
    });
    expect(computed.key).toEqual({ action: 'blocked' });
  });
});
