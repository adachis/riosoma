import { sparklineFields } from '../sparklines.js';
import type pg from 'pg';
import { AppError, visibleFieldIds, type ExportQuery, type RowData } from '@riosoma/contracts';
import type { AccessScope } from '../access.js';
import type { DataSchemas } from '../context.js';
import { relationContext, withButtonSources, type FormatContext } from '../format.js';
import { fetchPageByRid } from '../physical/records.js';
import type { Snapshot, SnapshotRead } from '../snapshots.js';
import type { StoredField } from '../types.js';

/**
 * Reading a view for a download.  The snapshot holds the order the view shows, already filtered
 * and already limited to the records the caller may see, so a file and the grid on screen always
 * hold the same rows.  Only one page of records is in memory at a time, which is what lets a
 * million-record view download at all.
 */

/** Records per page.  Big enough to keep query counts low, small enough to stay flat in memory. */
export const EXPORT_PAGE = 1_000;

export interface ExportSource {
  pool: pg.Pool;
  schemas: DataSchemas;
  scope: AccessScope;
  read: SnapshotRead;
  /** The view's visible fields, in the view's order, after the caller's field mask. */
  fields: readonly StoredField[];
  locale: string;
  timeZone: string;
}

export interface ExportPage {
  rows: readonly RowData[];
  context: FormatContext;
  /** Every field the rows hold, including the ones buttons fill their links from */
  read: ReadonlyMap<string, StoredField>;
}

/** The fields a file holds: the view's visible ones, in the view's order. */
export function exportFields(read: SnapshotRead): StoredField[] {
  const byId = new Map(read.fields.map((field) => [field.id, field]));
  return visibleFieldIds(read.view.config, read.fields, read.table.primaryFieldId).flatMap((id) => {
    const field = byId.get(id);
    return field ? [field] : [];
  });
}

/**
 * Checks the language and time zone before anything is written.  Once a download has started its
 * status and headers are gone, so a locale the runtime doesn't know has to be refused first.
 */
export function checkFormat(query: Pick<ExportQuery, 'format' | 'locale' | 'timeZone'>): void {
  try {
    new Intl.NumberFormat(query.locale);
    new Intl.DateTimeFormat(query.locale, { timeZone: query.timeZone });
  } catch {
    throw new AppError('validation_failed', 'api.format.invalid');
  }
}

/**
 * A view's records in order, a page at a time: a snapshot's row numbers for a table's own records,
 * or the keys a live table's source listed.
 */
export interface ExportOrder {
  pinnedCount?: number;
  total: number;
  page(offset: number, limit: number, fields: readonly StoredField[]): Promise<Array<RowData | null>>;
}

export function snapshotOrder(
  source: Pick<ExportSource, 'pool' | 'schemas' | 'read'>,
  snapshot: Snapshot,
): ExportOrder {
  const { pool, schemas, read } = source;
  return {
    total: snapshot.rids.length,
    pinnedCount: snapshot.pinnedCount,
    page: (offset, limit, fields) =>
      fetchPageByRid(
        pool,
        schemas.data,
        read.table.id,
        fields,
        Array.from(snapshot.rids.subarray(offset, offset + limit)),
        read.predicate,
        read.context,
      ),
  };
}

/** The view's records in view order, one page at a time, each with the names its cells need. */
export async function* exportPages(
  source: ExportSource,
  order: ExportOrder,
): AsyncGenerator<ExportPage, void, undefined> {
  const { pool, schemas, read } = source;
  // A button's link can use fields the view hides but the reader can see.
  source.scope.requireTableUse(read.table.id, 'export');
  const fields = await sparklineFields(
    pool,
    schemas,
    source.scope,
    withButtonSources(source.fields, read.fields),
    read.view.config.sparklines,
  );
  const byId = new Map(fields.map((field) => [field.id, field]));
  for (let offset = 0; offset < order.total; offset += EXPORT_PAGE) {
    // A record that disappeared or fell outside the caller's rules between the snapshot and here
    // reads as null; it is left out rather than exported as a blank row.
    const rows = (await order.page(offset, EXPORT_PAGE, fields)).filter(
      (row): row is RowData => row !== null,
    );
    if (!rows.length) continue;
    const relations = await relationContext({
      db: pool,
      schemas,
      table: read.table,
      scope: source.scope,
      fields,
      rows,
      names: true,
    });
    yield {
      rows,
      context: { locale: source.locale, timeZone: source.timeZone, ...relations },
      read: byId,
    };
  }
}
