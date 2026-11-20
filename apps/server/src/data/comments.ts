import { AppError, MENTION_PATTERN, type RecordComment } from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import { loadFields } from './metadata.js';
import type { Actor } from '../http/policy.js';
import { AccessScope } from './access.js';
import type { DataSchemas } from './context.js';

export interface CommentRow {
  id: string;
  table_id: string;
  record_id: string;
  field_id: string | null;
  author_id: string | null;
  body: string;
  mentions: string[];
  created_at: Date;
  edited_at: Date | null;
}

export function recordComment(row: CommentRow): RecordComment {
  return {
    id: row.id,
    tableId: row.table_id,
    recordId: row.record_id,
    ...(row.field_id ? { fieldId: row.field_id } : {}),
    authorId: row.author_id,
    body: row.body,
    mentions: row.mentions,
    createdAt: row.created_at.toISOString(),
    editedAt: row.edited_at?.toISOString() ?? null,
  };
}

export async function requireRecord(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  tableId: string,
  recordId: string,
  live = false,
): Promise<void> {
  const result = await query(
    db,
    sql`SELECT __id FROM ${ident(schemas.data, tableId)} WHERE __id = ${recordId}
      AND (${scope.recordPredicate(tableId)}) AND ${live ? sql`__deleted_at IS NULL` : sql`TRUE`}`,
  );
  if (!result.rowCount) throw new AppError('not_found', 'errors.notFound');
}

export async function commentMentions(
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  databaseId: string,
  body: string,
): Promise<string[]> {
  const ids = [...new Set([...body.matchAll(MENTION_PATTERN)].map((match) => match[2]!))];
  if (!ids.length) return [];
  const people = await query<{ user_id: string; kind: Actor['kind'] }>(
    db,
    sql`SELECT m.user_id, m.kind FROM ${ident(schemas.app, 'memberships')} m
      JOIN ${ident(schemas.app, 'users')} u ON u.id = m.user_id
      WHERE m.org_id = ${actor.orgId} AND m.user_id = ANY(${ids}::text[]) AND u.deactivated_at IS NULL`,
  );
  const allowed = new Set<string>();
  for (const person of people.rows) {
    const scope = new AccessScope(db, schemas, {
      userId: person.user_id,
      orgId: actor.orgId,
      kind: person.kind,
      sessionId: '',
      csrfToken: '',
      adminRoles: [],
    });
    if (await scope.databaseRole(databaseId)) allowed.add(person.user_id);
  }
  return ids.filter((id) => allowed.has(id));
}

/** A trashed or restricted field keeps its conversation private until it is visible again. */
export async function commentFields(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  tableId: string,
): Promise<Set<string>> {
  await scope.ensureTable(tableId);
  return new Set(
    scope.visibleFields(tableId, await loadFields(db, schemas, [tableId])).map((field) => field.id),
  );
}
