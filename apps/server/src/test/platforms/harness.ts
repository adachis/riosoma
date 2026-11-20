import {
  DatabaseSchema,
  PlatformBases,
  PlatformImport,
  type FieldMeta,
  type ImportPlatform,
  type PlatformReport,
  type RowsPage,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import type { ServerFixture } from '../fixture.js';

/**
 * Importing from NocoDB, Baserow, Grist, Teable, and SeaTable through the server's own routes, for
 * the tests of each reader, against the real tool or a recording of it.
 */

export interface Imported {
  job: PlatformImport;
  schema: DatabaseSchema;
  field(table: string, name: string): FieldMeta;
  fields(table: string): FieldMeta[];
  rows(table: string, view?: string): Promise<RowsPage>;
  /** A record's values by field name, found by its primary field's value */
  record(table: string, name: string): Promise<Record<string, unknown>>;
  view(table: string, name: string): DatabaseSchema['views'][number];
  item(table: string | null, name: string | null, key: string): PlatformReport['items'][number];
}

export async function call<T>(
  server: ServerFixture,
  method: 'GET' | 'POST',
  url: string,
  payload?: Record<string, unknown>,
  status = 200,
): Promise<T> {
  const response = await server.app.inject({
    method,
    url,
    headers: server.owner.headers,
    ...(payload === undefined ? {} : { payload }),
  });
  if (response.statusCode !== status)
    throw new Error(`${method} ${url} answered ${response.statusCode}, not ${status}: ${response.body}`);
  return response.json<T>();
}

export async function listBases(
  server: ServerFixture,
  platform: ImportPlatform,
  body: Record<string, unknown>,
) {
  return PlatformBases.parse(await call(server, 'POST', `/api/imports/${platform}/bases`, body)).bases;
}

export async function startImport(
  server: ServerFixture,
  platform: ImportPlatform,
  body: Record<string, unknown>,
): Promise<PlatformImport> {
  return PlatformImport.parse(await call(server, 'POST', `/api/imports/${platform}`, body));
}

export async function finished(server: ServerFixture, platform: ImportPlatform, id: string) {
  await server.ctx.platformImports!.settled(id);
  return PlatformImport.parse(await call(server, 'GET', `/api/imports/${platform}/${id}`));
}

/** Imports a base and answers what came across. */
export async function importBase(
  server: ServerFixture,
  platform: ImportPlatform,
  body: Record<string, unknown>,
): Promise<Imported> {
  const started = await startImport(server, platform, body);
  const job = await finished(server, platform, started.id);
  if (job.state !== 'finished')
    throw new Error(`The import ended ${job.state}: ${JSON.stringify(job.error)}`);
  const schema = DatabaseSchema.parse(await call(server, 'GET', `/api/databases/${job.databaseId}/schema`));
  const tableOf = (name: string) => {
    const found = schema.tables.find((table) => table.name === name);
    if (!found) throw new Error(`No table ${name} in ${schema.tables.map((table) => table.name).join(', ')}`);
    return found;
  };
  const fields = (table: string) => schema.fields.filter((field) => field.tableId === tableOf(table).id);
  const field = (table: string, name: string) => {
    const found = fields(table).find((item) => item.name === name);
    if (!found)
      throw new Error(
        `No field ${table}.${name} in ${fields(table)
          .map((item) => item.name)
          .join(', ')}`,
      );
    return found;
  };
  const view = (table: string, name: string) => {
    const found = schema.views.find((item) => item.tableId === tableOf(table).id && item.name === name);
    if (!found) throw new Error(`No view ${table}.${name}`);
    return found;
  };
  const rows = (table: string, name?: string) => {
    const chosen = name
      ? view(table, name)
      : schema.views.find((item) => item.tableId === tableOf(table).id && item.type === 'grid')!;
    return call<RowsPage>(server, 'GET', `/api/views/${chosen.id}/rows?limit=500`);
  };
  return {
    job,
    schema,
    field,
    fields,
    view,
    rows,
    async record(table, name) {
      const primary = fields(table)[0]!;
      const page = await rows(table);
      const found = page.rows.find((row) => row?.values[primary.id] === name);
      if (!found) throw new Error(`No record ${name} in ${table}`);
      return Object.fromEntries(fields(table).map((item) => [item.name, found.values[item.id]]));
    },
    item(table, name, key) {
      const found = job.report!.items.find(
        (entry) => entry.table === table && entry.name === name && entry.messageKey === key,
      );
      if (!found)
        throw new Error(
          `No report line for ${table}.${name} ${key}: ${JSON.stringify(
            job.report!.items.filter((entry) => entry.table === table && entry.name === name),
          )}`,
        );
      return found;
    },
  };
}

/** Every table in every schema that holds some text, to show a token was never kept. */
export async function tablesHolding(server: ServerFixture, text: string): Promise<string[]> {
  const tables = await server.pool.query<{ schema: string; name: string }>(
    `SELECT table_schema AS schema, table_name AS name FROM information_schema.tables
     WHERE table_schema = ANY($1) AND table_type = 'BASE TABLE'`,
    [[server.schemas.app, server.schemas.data, server.schemas.audit]],
  );
  if (tables.rows.length < 20) throw new Error('The schemas to search were not found');
  const holding: string[] = [];
  for (const table of tables.rows) {
    const found = await query<{ count: number }>(
      server.pool,
      sql`SELECT count(*)::int AS count FROM ${ident(table.schema, table.name)} AS t WHERE t::text LIKE ${`%${text}%`}`,
    );
    if (found.rows[0]!.count) holding.push(`${table.schema}.${table.name}`);
  }
  return holding;
}

export async function sealedToken(server: ServerFixture, id: string): Promise<string | null> {
  const result = await server.pool.query<{ sealed_token: string | null }>(
    `SELECT sealed_token FROM "${server.schemas.app}".platform_imports WHERE id = $1`,
    [id],
  );
  return result.rows[0]?.sealed_token ?? null;
}

/** A one-pixel PNG, for attachments */
export const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4DwQACfsD/Z8ZQbYAAAAASUVORK5CYII=',
  'base64',
);
