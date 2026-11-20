import { newId } from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { Actor } from '../../http/policy.js';
import type { DataSchemas } from '../context.js';
import { recordChange } from '../commands/transaction.js';
import { relatedDatabaseIds } from '../metadata.js';
import { accessChannel } from '../notify.js';

/** Access changes must survive a missed notice between a schema read and its subscription. */
export async function notifyAccess(
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  databaseId: string,
  includeOwn = true,
): Promise<void> {
  const tables = await query<{ id: string }>(
    db,
    sql`SELECT id FROM ${ident(schemas.app, 'tables')} WHERE database_id = ${databaseId}`,
  );
  const related = await relatedDatabaseIds(
    db,
    schemas,
    tables.rows.map((row) => row.id),
  );
  const recipients = new Set([
    ...related.filter((id) => id !== databaseId),
    ...(includeOwn ? [databaseId] : []),
  ]);
  const ids = { commandId: newId('command'), groupId: newId('action'), clientId: null, system: true };
  for (const id of [...recipients].sort())
    await recordChange(
      { db, schemas, actor, databaseId: id },
      { body: { kind: 'access.changed' }, prev: {} },
      ids,
    );
  await query(db, sql`SELECT pg_notify(${accessChannel(schemas)}, ${databaseId})`);
}
