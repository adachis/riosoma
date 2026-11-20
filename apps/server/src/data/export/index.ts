import type { Readable } from 'node:stream';
import type { FastifyReply } from 'fastify';
import type pg from 'pg';
import type { ExportFormat, ExportQuery } from '@riosoma/contracts';
import type { AccessScope } from '../access.js';
import type { DataSchemas } from '../context.js';
import { disposition } from '../files/detect.js';
import type { FileStorageConfig } from '../files/storage.js';
import type { SnapshotCache, SnapshotRead } from '../snapshots.js';
import { CSV_TYPE, csvStream } from './csv.js';
import { exportFileName } from './filename.js';
import { DOCX_TYPE, PPTX_TYPE } from './office/load.js';
import { officeLimit, officeStream } from './office/view.js';
import { checkFormat, exportFields, snapshotOrder, type ExportOrder, type ExportSource } from './source.js';
import { XLSX_TYPE, xlsxStream } from './xlsx.js';

/**
 * `GET /api/views/:viewId/export`: a view as a file.  The caller has been shown to have read
 * access to the view's database before this runs, and everything below keeps the masks every other
 * read keeps: the view's filter and order, its visible fields, and the caller's record rules.
 */
export interface ExportOptions {
  pool: pg.Pool;
  schemas: DataSchemas;
  scope: AccessScope;
  /** The view's snapshot cache, shared with the grid, so a download reuses the order already built. */
  snapshots: SnapshotCache;
  read: SnapshotRead;
  query: ExportQuery;
  /** Where attachment images are read from, for a deck's pictures */
  files: FileStorageConfig;
  /** Set for a table that reads its source live: the source's order, in place of a snapshot */
  live?: () => Promise<ExportOrder>;
  /** Records the download once it's sure to go ahead, with how many records the file holds */
  audit?: (records: number) => Promise<void>;
}

export const EXPORT_TYPES: Record<ExportFormat, string> = {
  csv: CSV_TYPE,
  xlsx: XLSX_TYPE,
  docx: DOCX_TYPE,
  pptx: PPTX_TYPE,
};

export async function exportView(reply: FastifyReply, options: ExportOptions): Promise<FastifyReply> {
  const { pool, schemas, scope, snapshots, query } = options;
  const read =
    query.format === 'csv' || query.format === 'xlsx'
      ? {
          ...options.read,
          view: { ...options.read.view, config: { ...options.read.view.config, groups: [] } },
        }
      : options.read;
  await scope.requireUse(read.table.databaseId, 'export', { tableId: read.table.id });
  checkFormat(query);
  const source: ExportSource = {
    pool,
    schemas,
    scope,
    read,
    fields: exportFields(read),
    locale: query.locale,
    timeZone: query.timeZone,
  };
  // The order is settled before a byte goes out, so a view that can't be read answers with an
  // error rather than an empty file that has already claimed to be a spreadsheet.
  const order = options.live
    ? await options.live()
    : snapshotOrder(source, (await snapshots.get(read)).snapshot);
  const office = query.format === 'docx' || query.format === 'pptx' ? query.format : null;
  await options.audit?.(
    office ? Math.min(order.total, officeLimit(office, query.layout, source.fields.length)) : order.total,
  );
  const type = EXPORT_TYPES[query.format];
  reply.header('content-type', type);
  reply.header(
    'content-disposition',
    disposition(type, exportFileName(read.table.name, read.view.name, query.format)),
  );
  // A downloaded file is opened by something that guesses from the bytes, so say what it is.
  reply.header('x-content-type-options', 'nosniff');
  let body: Readable;
  if (office)
    body = officeStream(source, order, {
      format: office,
      title: query.title,
      layout: query.layout,
      accent: query.accent,
      images: { db: pool, appSchema: schemas.app, files: options.files },
      now: new Date(),
    });
  else body = query.format === 'csv' ? csvStream(source, order) : xlsxStream(source, order);
  return reply.send(body);
}
