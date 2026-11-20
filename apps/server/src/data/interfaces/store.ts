import { InterfacePages, type InterfaceMeta } from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { DataSchemas } from '../context.js';

/**
 * Reads interfaces into the shapes the rest of the server uses.  Trashed ones are left out unless
 * asked for.  Writes live with the commands.
 */

const iso = (value: Date | string) => (value instanceof Date ? value : new Date(value)).toISOString();

interface InterfaceRow {
  id: string;
  org_id: string;
  database_id: string;
  name: string;
  position: number;
  pages: unknown;
  created_at: Date;
  updated_at: Date;
  trashed_at: Date | null;
}

/** An interface as the server stores it. */
export interface StoredInterface extends InterfaceMeta {
  orgId: string;
  trashed: boolean;
}

function toInterface(row: InterfaceRow): StoredInterface {
  return {
    id: row.id,
    orgId: row.org_id,
    databaseId: row.database_id,
    name: row.name,
    position: Number(row.position),
    // Parsing fills defaults added since the interface was saved.
    pages: InterfacePages.parse(row.pages ?? []),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    trashed: row.trashed_at !== null,
  };
}

export function interfaceMeta(value: StoredInterface): InterfaceMeta {
  const { orgId: _org, trashed: _trashed, ...meta } = value;
  return meta;
}

/** A database's interfaces in position order. */
export async function loadInterfaces(
  db: Queryable,
  schemas: DataSchemas,
  databaseId: string,
  options: { includeTrashed?: boolean } = {},
): Promise<StoredInterface[]> {
  const result = await query<InterfaceRow>(
    db,
    sql`SELECT * FROM ${ident(schemas.app, 'interfaces')}
         WHERE database_id = ${databaseId} AND (${options.includeTrashed ?? false} OR trashed_at IS NULL)
         ORDER BY position, id`,
  );
  return result.rows.map(toInterface);
}

/** One interface, with whether it's trashed, or null when it doesn't exist. */
export async function loadInterface(
  db: Queryable,
  schemas: DataSchemas,
  interfaceId: string,
): Promise<StoredInterface | null> {
  const result = await query<InterfaceRow>(
    db,
    sql`SELECT * FROM ${ident(schemas.app, 'interfaces')} WHERE id = ${interfaceId}`,
  );
  return result.rows[0] ? toInterface(result.rows[0]) : null;
}
