import type { Readable } from 'node:stream';
import {
  REPORT_SUMMARY_FIELDS,
  REPORT_SUMMARY_RECORDS,
  type ExportFormat,
  type ReportFormat,
} from '@riosoma/contracts';
import type pg from 'pg';
import type { AccessScope } from '../data/access.js';
import type { DataSchemas } from '../data/context.js';
import { csvStream } from '../data/export/csv.js';
import { exportFileName } from '../data/export/filename.js';
import { EXPORT_TYPES } from '../data/export/index.js';
import { officeView } from '../data/export/office/view.js';
import { exportFields, exportPages, snapshotOrder, type ExportSource } from '../data/export/source.js';
import { xlsxStream } from '../data/export/xlsx.js';
import type { FileStorageConfig } from '../data/files/storage.js';
import { formatCellText } from '../data/format.js';
import { loadDatabase, loadFields, loadTable, loadView } from '../data/metadata.js';
import type { Snapshot, SnapshotCache, SnapshotRead } from '../data/snapshots.js';
import type { MailAttachment } from '../mail/index.js';
import { reportLayout, type ReportLayout } from './layout.js';
import { renderReportPdf, type ReportPdfConfig } from './pdf.js';
import { publicTheme } from '../themes/choices.js';
import { compile, ident, sql } from '@riosoma/db';

/**
 * One recipient's report: the view read through that recipient's own access, exactly as a
 * download of it would be.  The summary and the file come from the same snapshot, so the count,
 * the first rows, and the attachment always agree.  The file is built in memory up to the size
 * cap and dropped the moment it passes it.
 */

export interface ReportContent {
  count: number;
  columns: string[];
  rows: string[][];
  attachment: MailAttachment | null;
  tooLarge: boolean;
  layout?: ReportLayout;
  notes?: string[];
}

export interface RenderOptions {
  pool: pg.Pool;
  schemas: DataSchemas;
  snapshots: SnapshotCache;
  scope: AccessScope;
  viewId: string;
  format: ReportFormat;
  locale: string;
  timeZone: string;
  /** The largest attachment, in bytes */
  limit: number;
  /** Where attachment images are read from, for a deck's pictures.  Without it, a deck has none. */
  files?: FileStorageConfig;
  now?: Date;
  reportName?: string;
  pdf?: ReportPdfConfig;
}

/** The view as the scope sees it, or null when the view, its table, or read access is gone. */
export async function reportRead(
  options: Pick<RenderOptions, 'pool' | 'schemas' | 'snapshots' | 'scope' | 'viewId' | 'timeZone'>,
): Promise<SnapshotRead | null> {
  const { pool, schemas, scope, viewId } = options;
  const loaded = await loadView(pool, schemas, viewId);
  if (!loaded || loaded.trashed) return null;
  if (!(await scope.databaseRole(loaded.databaseId))) return null;
  await scope.prepare(loaded.databaseId);
  scope.requireTableUse(loaded.view.tableId, 'export');
  const [table, fields, context] = await Promise.all([
    loadTable(pool, schemas, loaded.view.tableId),
    loadFields(pool, schemas, [loaded.view.tableId]),
    options.snapshots.readContext(options.timeZone),
  ]);
  if (!table || table.trashed) return null;
  return {
    table,
    view: loaded.view,
    fields: scope.visibleFields(table.id, fields),
    predicate: scope.recordPredicate(table.id),
    access: scope.accessKey(table.id),
    context,
  };
}

/** Reads a stream into memory, giving up once it passes `limit` bytes. */
async function collect(stream: Readable, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += bytes.length;
    if (size > limit) {
      stream.destroy();
      return null;
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function summary(source: ExportSource, snapshot: Snapshot): Promise<string[][]> {
  const first: Snapshot = { ...snapshot, rids: snapshot.rids.subarray(0, REPORT_SUMMARY_RECORDS) };
  const rows: string[][] = [];
  for await (const page of exportPages(source, snapshotOrder(source, first)))
    for (const row of page.rows)
      rows.push(source.fields.map((field) => formatCellText(field, row, page.read, page.context)));
  return rows;
}

export async function renderReport(options: RenderOptions): Promise<ReportContent | null> {
  const read = await reportRead(options);
  if (!read) return null;
  const { snapshot } = await options.snapshots.get(read);
  const fields = exportFields(read);
  const source: ExportSource = {
    pool: options.pool,
    schemas: options.schemas,
    scope: options.scope,
    read,
    fields,
    locale: options.locale,
    timeZone: options.timeZone,
  };
  const shown = fields.slice(0, REPORT_SUMMARY_FIELDS);
  const rows = await summary({ ...source, fields: shown }, snapshot);
  const content: ReportContent = {
    count: snapshot.rids.length,
    columns: shown.map((field) => field.name),
    rows,
    attachment: null,
    tooLarge: false,
  };
  if (options.format === 'none') return content;
  if (options.format === 'pdf') {
    const layout = await reportLayout(source, snapshot, options.reportName ?? read.view.name);
    const database = await loadDatabase(options.pool, options.schemas, read.table.databaseId);
    const theme = await publicTheme(
      options.pool,
      compile(sql`${ident(options.schemas.app)}`).text,
      { orgId: options.scope.actor.orgId, sharerId: options.scope.actor.userId },
      undefined,
      { theme: database?.theme },
      { themesDir: options.pdf?.themesDir },
    );
    const result = await renderReportPdf(layout, options.pdf ?? {}, options.limit, theme ?? undefined);
    return {
      ...content,
      layout,
      notes: result.notes,
      tooLarge: !result.bytes,
      attachment: result.bytes
        ? {
            filename: exportFileName(read.table.name, read.view.name, 'pdf'),
            content: result.bytes,
            contentType: 'application/pdf',
          }
        : null,
    };
  }
  const format: ExportFormat = options.format;
  const order = snapshotOrder(source, snapshot);
  let bytes: Buffer | null;
  if (format === 'docx' || format === 'pptx') {
    // A document is built whole, and it's never larger than its record limit allows.
    const built = await officeView(source, order, {
      format,
      layout: 'records',
      images: { db: options.pool, appSchema: options.schemas.app, files: options.files ?? {} },
      now: options.now ?? new Date(),
    });
    bytes = built.length > options.limit ? null : built;
  } else
    bytes = await collect(
      format === 'csv' ? csvStream(source, order) : xlsxStream(source, order),
      options.limit,
    );
  if (!bytes) return { ...content, tooLarge: true };
  return {
    ...content,
    attachment: {
      filename: exportFileName(read.table.name, read.view.name, format),
      content: bytes,
      contentType: EXPORT_TYPES[format],
    },
  };
}
