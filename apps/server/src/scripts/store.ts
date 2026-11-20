import type { ScriptMeta } from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { DataSchemas } from '../data/context.js';

/**
 * Reads scripts into the shapes the rest of the server uses.  Trashed ones are left out unless
 * asked for.  Writes live with the commands.
 */

const iso = (value: Date | string) => (value instanceof Date ? value : new Date(value)).toISOString();

interface ScriptRow {
  id: string;
  org_id: string;
  database_id: string;
  name: string;
  description: string;
  source: string;
  position: number;
  created_at: Date;
  updated_at: Date;
  trashed_at: Date | null;
}

/** A script as the server stores it. */
export interface StoredScript extends ScriptMeta {
  orgId: string;
  trashed: boolean;
}

function toScript(row: ScriptRow): StoredScript {
  return {
    id: row.id,
    orgId: row.org_id,
    databaseId: row.database_id,
    name: row.name,
    description: row.description,
    source: row.source,
    position: Number(row.position),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    trashed: row.trashed_at !== null,
  };
}

export function scriptMeta(value: StoredScript): ScriptMeta {
  const { orgId: _org, trashed: _trashed, ...meta } = value;
  return meta;
}

/**
 * A script as someone who can't change the schema sees it: its name and description, without the
 * code, which can hold addresses and keys the way a webhook step's settings can.
 */
export function readerScript(meta: ScriptMeta): ScriptMeta {
  return { ...meta, source: '' };
}

/** A database's scripts in position order. */
export async function loadScripts(
  db: Queryable,
  schemas: DataSchemas,
  databaseId: string,
  options: { includeTrashed?: boolean } = {},
): Promise<StoredScript[]> {
  const result = await query<ScriptRow>(
    db,
    sql`SELECT * FROM ${ident(schemas.app, 'scripts')}
         WHERE database_id = ${databaseId} AND (${options.includeTrashed ?? false} OR trashed_at IS NULL)
         ORDER BY position, id`,
  );
  return result.rows.map(toScript);
}

/** One script, with whether it's trashed, or null when it doesn't exist. */
export async function loadScript(
  db: Queryable,
  schemas: DataSchemas,
  scriptId: string,
): Promise<StoredScript | null> {
  const result = await query<ScriptRow>(
    db,
    sql`SELECT * FROM ${ident(schemas.app, 'scripts')} WHERE id = ${scriptId}`,
  );
  return result.rows[0] ? toScript(result.rows[0]) : null;
}
