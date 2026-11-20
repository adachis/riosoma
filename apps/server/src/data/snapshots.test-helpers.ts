import type { z } from 'zod';
import { FieldMeta, GridConfig, newId, type FieldSpec, type GridConfigPatch } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import type { ServerFixture } from '../test/fixture.js';
import { loadTable, loadView } from './metadata.js';
import { createRecordTable } from './physical/ddl.js';
import { insertRecords } from './physical/records.js';
import type { SnapshotRead } from './snapshots.js';

export async function readFixture(
  server: ServerFixture,
  specs: readonly z.input<typeof FieldSpec>[] = [{ type: 'number' }],
  config: GridConfigPatch = {},
): Promise<SnapshotRead> {
  const orgId = server.owner.info.org.id;
  const databaseId = newId('database');
  const tableId = newId('table');
  const viewId = newId('view');
  const at = new Date().toISOString();
  const fields = specs.map((spec, position) => {
    const id = newId('field');
    return {
      ...FieldMeta.parse({
        ...spec,
        id,
        tableId,
        name: `Field ${position}`,
        description: '',
        position,
        createdAt: at,
        updatedAt: at,
      }),
      columnName: id,
    };
  });
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'databases')}
    (id, org_id, name) VALUES (${databaseId}, ${orgId}, 'Records')`,
  );
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
    (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${orgId}, 'database', ${databaseId}, 'user', ${server.owner.userId}, 'owner')`,
  );
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'tables')}
    (id, org_id, database_id, name, primary_field_id, position)
    VALUES (${tableId}, ${orgId}, ${databaseId}, 'Records', ${fields[0]!.id}, 0)`,
  );
  for (const field of fields) {
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'fields')}
      (id, org_id, table_id, name, type, options, column_name, position)
      VALUES (${field.id}, ${orgId}, ${tableId}, ${field.name}, ${field.type},
        ${JSON.stringify(field.options)}::jsonb, ${field.columnName}, ${field.position})`,
    );
  }
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'views')}
    (id, org_id, table_id, name, type, config, position)
    VALUES (${viewId}, ${orgId}, ${tableId}, 'Grid', 'grid', ${JSON.stringify(GridConfig.parse(config))}::jsonb, 0)`,
  );
  await createRecordTable(server.pool, server.schemas.data, tableId, fields);
  const table = (await loadTable(server.pool, server.schemas, tableId))!;
  const { view } = (await loadView(server.pool, server.schemas, viewId))!;
  return {
    table,
    view,
    fields,
    predicate: sql`TRUE`,
    access: 'all',
    context: { timeZone: 'UTC', now: new Date(), natural: true },
  };
}

export async function numbers(server: ServerFixture, read: SnapshotRead, values: readonly number[]) {
  return insertRecords(
    server.pool,
    server.schemas.data,
    read.table.id,
    read.fields,
    values.map((value) => ({ id: newId('record'), values: { [read.fields[0]!.id]: value } })),
    server.owner.userId,
  );
}

export async function bumpVersion(server: ServerFixture, read: SnapshotRead): Promise<void> {
  const result = await query<{ data_version: string }>(
    server.pool,
    sql`
    UPDATE ${ident(server.schemas.app, 'tables')} SET data_version = data_version + 1
    WHERE id = ${read.table.id} RETURNING data_version`,
  );
  read.table = { ...read.table, dataVersion: Number(result.rows[0]!.data_version) };
}

export async function saveView(server: ServerFixture, read: SnapshotRead): Promise<void> {
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'views')}
    SET config = ${JSON.stringify(read.view.config)}::jsonb WHERE id = ${read.view.id}`,
  );
}
