import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  IMPORT_RECORDS_PAGE,
  ImportRecordsRequest,
  SPREADSHEET_LIMITS,
  TableId,
  type ImportRecordsPage,
  type SpreadsheetLine,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { requireActor } from '../../auth/sessions.js';
import { parse } from '../../http/validate.js';
import { AccessScope } from '../access.js';
import { dataStore } from '../context.js';
import { loadFields, loadTable } from '../metadata.js';
import { formulaRead } from '../physical/records.js';
import { readSpreadsheet, type SpreadsheetEvent } from './spreadsheet.js';
import { documentImportRoutes } from './document-routes.js';
import { checkFileSafety, requireSafeFile } from '../files/safety.js';
import { fileName } from '../files/detect.js';

const sessionRoute = { config: { policy: { kind: 'session' as const } } };
const notFound = () => new AppError('not_found', 'errors.notFound');
const tooLarge = () =>
  new AppError('payload_too_large', 'import.spreadsheet.tooLarge', {
    params: { megabytes: SPREADSHEET_LIMITS.uploadBytes / 1024 / 1024 },
  });

/** Workbooks read at once.  Each holds its upload in memory while it's read. */
const READING_AT_ONCE = 2;
/** The answer goes out in pieces about this size, not a piece per row. */
const CHUNK = 64 * 1024;

/**
 * Importing: reading a spreadsheet the browser uploads, and reading a table's records so the
 * browser can match a file against them.
 */
export async function importRoutes(app: FastifyInstance): Promise<void> {
  await app.register(documentImportRoutes);
  await app.register(spreadsheetRoutes);
  await app.register(recordRoutes);
}

/** The whole upload, refused as soon as it passes the limit. */
async function upload(request: FastifyRequest): Promise<Buffer> {
  if (Number(request.headers['content-length'] ?? 0) > SPREADSHEET_LIMITS.uploadBytes) throw tooLarge();
  const payload = request.body instanceof Readable ? request.body : Readable.from([]);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    // Keeping the request open on early exit lets the server answer with a useful 413.
    for await (const value of payload.iterator({ destroyOnReturn: false })) {
      const bytes = value as Buffer;
      size += bytes.length;
      if (size > SPREADSHEET_LIMITS.uploadBytes) throw tooLarge();
      chunks.push(bytes);
    }
  } finally {
    payload.resume();
  }
  return Buffer.concat(chunks, size);
}

function line(event: SpreadsheetEvent): string {
  const value: SpreadsheetLine | unknown[] =
    event.kind === 'sheet'
      ? { sheet: event.name, position: event.position }
      : event.kind === 'end'
        ? { rows: event.rows, total: event.total }
        : [event.number, ...event.cells];
  return `${JSON.stringify(value)}\n`;
}

/**
 * The answer after its first line: the rest of the workbook, then the end.  The status has gone
 * by the time a later failure shows up, so it arrives as an error line instead.
 */
async function* answer(
  first: SpreadsheetEvent,
  rest: AsyncGenerator<SpreadsheetEvent>,
  done: () => void,
): AsyncGenerator<string> {
  let buffered = line(first);
  try {
    for await (const event of rest) {
      buffered += line(event);
      if (buffered.length >= CHUNK) {
        yield buffered;
        buffered = '';
      }
    }
    yield `${buffered}${JSON.stringify({ done: true } satisfies SpreadsheetLine)}\n`;
  } catch (error) {
    const failure =
      error instanceof AppError ? error : new AppError('validation_failed', 'import.spreadsheet.unreadable');
    yield `${buffered}${JSON.stringify(failure.toBody())}\n`;
  } finally {
    done();
  }
}

async function spreadsheetRoutes(app: FastifyInstance): Promise<void> {
  // The upload is the workbook's own bytes.  Parser changes stay inside this plugin.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_request, payload, done) => {
    done(null, payload);
  });
  let reading = 0;

  app.post('/api/imports/spreadsheet', sessionRoute, async (request, reply) => {
    const actor = requireActor(request);
    if (reading >= READING_AT_ONCE) throw new AppError('rate_limited', 'import.spreadsheet.busy');
    reading++;
    let released = false;
    const release = () => {
      if (!released) reading--;
      released = true;
    };
    // An answer nobody reads to the end still gives its place back when the connection closes.
    reply.raw.once('close', release);
    try {
      const bytes = await upload(request);
      const { pool, schemas } = dataStore(app.ctx);
      requireSafeFile(
        await checkFileSafety(
          { db: pool, schema: schemas.app, orgId: actor.orgId, config: app.ctx.config },
          {
            bytes,
            statedType: request.headers['content-type'],
            ...(request.headers['x-file-name'] ? { name: fileName(request.headers['x-file-name']) } : {}),
          },
        ),
        {
          tooLarge: {
            key: 'import.spreadsheet.tooLarge',
            params: { megabytes: SPREADSHEET_LIMITS.uploadBytes / 1024 / 1024 },
          },
        },
      );
      const events = readSpreadsheet(bytes, {
        signal: AbortSignal.timeout(SPREADSHEET_LIMITS.seconds * 1000),
      });
      // Anything wrong with the file itself shows up before the first sheet, as a proper error.
      const first = await events.next();
      if (first.done) throw new AppError('validation_failed', 'import.spreadsheet.notSpreadsheet');
      reply.header('content-type', 'application/x-ndjson; charset=utf-8');
      reply.header('cache-control', 'no-store');
      return reply.send(Readable.from(answer(first.value, events, release)));
    } catch (error) {
      release();
      throw error;
    }
  });
}

async function recordRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/tables/:tableId/import/records',
    sessionRoute,
    async (request): Promise<ImportRecordsPage> => {
      const { tableId } = parse(z.object({ tableId: TableId }), request.params);
      const input = parse(ImportRecordsRequest, request.body);
      const { pool, schemas } = dataStore(app.ctx);
      const scope = new AccessScope(pool, schemas, requireActor(request));
      const table = await loadTable(pool, schemas, tableId);
      if (!table || table.trashed) throw notFound();
      await scope.require(table.databaseId, 'editRecords');
      const visible = scope.visibleFields(tableId, await loadFields(pool, schemas, [tableId]));
      const fields = input.fieldIds.map((id) => visible.find((field) => field.id === id));
      if (fields.some((field) => !field)) throw notFound();
      const read = formulaRead(fields.filter((field) => field !== undefined));
      const which = input.recordIds
        ? sql`__id = ANY(${input.recordIds}::text[])`
        : sql`__rid > ${input.after ?? '0'}::bigint`;
      const result = await query<Parameters<typeof read.decode>[0]>(
        pool,
        sql`SELECT ${read.select} FROM ${ident(schemas.data, tableId)}
        WHERE ${which} AND __deleted_at IS NULL AND NOT __source_gone AND (${scope.recordPredicate(tableId)})
        ORDER BY __rid LIMIT ${IMPORT_RECORDS_PAGE}`,
      );
      const records = result.rows.map((row) => {
        const decoded = read.decode(row);
        return { id: decoded.id, values: decoded.values };
      });
      const last = result.rows.at(-1);
      return {
        records,
        next:
          !input.recordIds && last && result.rows.length === IMPORT_RECORDS_PAGE ? String(last.__rid) : null,
      };
    },
  );
}
