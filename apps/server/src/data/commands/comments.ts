import { AppError, type Command } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { AccessScope } from '../access.js';
import {
  commentFields,
  commentMentions,
  recordComment,
  requireRecord,
  type CommentRow,
} from '../comments.js';
import { missing, table, type CommandContext, type Mutation } from './context.js';

type CommentCommand = Extract<Command, { kind: `comment.${string}` }>;

export async function applyComments(c: CommandContext, command: CommentCommand): Promise<Mutation> {
  const { db, schemas, actor, databaseId } = c;
  // The bus's scope, which knows the records of a live table its source confirmed.
  const scope = c.scope ?? new AccessScope(db, schemas, actor);
  const role = await scope.require(databaseId, 'comment');
  if (command.kind === 'comment.create') {
    await table(c, command.tableId);
    await requireRecord(db, schemas, scope, command.tableId, command.recordId, true);
    if (
      command.comment.fieldId &&
      !(await commentFields(db, schemas, scope, command.tableId)).has(command.comment.fieldId)
    )
      return missing();
    const mentions = await commentMentions(db, schemas, actor, databaseId, command.comment.body);
    const result = await query<CommentRow>(
      db,
      sql`INSERT INTO ${ident(schemas.app, 'comments')}
        (id, org_id, database_id, table_id, record_id, field_id, author_id, body, mentions)
        VALUES (${command.comment.id}, ${actor.orgId}, ${databaseId}, ${command.tableId},
          ${command.recordId}, ${command.comment.fieldId ?? null}, ${actor.userId}, ${command.comment.body}, ${mentions}::text[]) RETURNING *`,
    );
    return { body: { kind: 'comment.created', comment: recordComment(result.rows[0]!) }, prev: {} };
  }
  const result = await query<CommentRow>(
    db,
    sql`SELECT * FROM ${ident(schemas.app, 'comments')} WHERE id = ${command.commentId}
      AND org_id = ${actor.orgId} AND database_id = ${databaseId} AND deleted_at IS NULL FOR UPDATE`,
  );
  const comment = result.rows[0];
  if (!comment) return missing();
  await table(c, comment.table_id);
  await requireRecord(db, schemas, scope, comment.table_id, comment.record_id);
  if (comment.field_id && !(await commentFields(db, schemas, scope, comment.table_id)).has(comment.field_id))
    return missing();
  if (comment.author_id !== actor.userId && !(command.kind === 'comment.delete' && role === 'owner'))
    throw new AppError('forbidden', 'data.access.denied');
  if (command.kind === 'comment.delete') {
    await query(
      db,
      sql`UPDATE ${ident(schemas.app, 'comments')} SET deleted_at = statement_timestamp()
      WHERE id = ${comment.id}`,
    );
    return {
      body: {
        kind: 'comment.deleted',
        tableId: comment.table_id,
        recordId: comment.record_id,
        commentId: comment.id,
      },
      prev: {},
    };
  }
  const mentions = await commentMentions(db, schemas, actor, databaseId, command.body);
  const updated = await query<CommentRow>(
    db,
    sql`UPDATE ${ident(schemas.app, 'comments')}
    SET body = ${command.body}, mentions = ${mentions}::text[], edited_at = statement_timestamp()
    WHERE id = ${comment.id} RETURNING *`,
  );
  return { body: { kind: 'comment.updated', comment: recordComment(updated.rows[0]!) }, prev: {} };
}
