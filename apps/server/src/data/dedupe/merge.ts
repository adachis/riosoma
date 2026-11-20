import {
  AppError,
  combinableField,
  mergeableField,
  mergedValues,
  sameValue,
  type CellValues,
  type ChangeBody,
  type Command,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { matchedBefore } from '../../automations/triggers.js';
import { invalid, scopeOf, table, type CommandContext, type Mutation } from '../commands/context.js';
import { chain } from '../commands/matches.js';
import { checkedRows } from '../commands/records.js';
import { recordComment, type CommentRow } from '../comments.js';
import { attachFiles } from '../files/cells.js';
import { writeGuard } from '../permissions/enforce.js';
import { loadFields } from '../metadata.js';
import { captureLinkPositions, linkVisibilityChanges, type LinkPositions } from '../physical/links.js';
import { fetchRowsById, trashRecords, updateRecords } from '../physical/records.js';

/**
 * Merging duplicates.  One command puts the merged records in the trash, writes the kept record's
 * chosen values, and moves the merged records' comments to it, recorded as the ordinary changes
 * those are.  Undo reverses each of them, so a merge comes back exactly: the merged records return
 * with their own values and links, which the trash never touched, the kept record gets its values
 * back, and the comments go home.
 *
 * Links follow from the kept record's values.  Combining a link field gives the kept record every
 * link the merged records had, so the records that pointed at a merged record point at the kept one
 * instead, in the place the merged record held in their lists.
 */

type MergeCommand = Extract<Command, { kind: 'record.merge' }>;
type CommentsMoved = Extract<ChangeBody, { kind: 'comment.moved' }>;

interface CommentMove {
  id: string;
  from: string;
  to: string;
}

/**
 * Moves comments between records of a table, each only while it's still on the record it's leaving,
 * and points the mention notifications about them at their new record.  Null when none moved.
 */
async function moveComments(
  c: CommandContext,
  tableId: string,
  moves: readonly CommentMove[],
): Promise<CommentsMoved | null> {
  if (!moves.length) return null;
  const comments = ident(c.schemas.app, 'comments');
  const result = await query<CommentRow & { previous: string }>(
    c.db,
    sql`WITH moving AS (
      SELECT c.id, c.record_id AS previous, m.target FROM ${comments} c
      JOIN unnest(${moves.map((move) => move.id)}::text[], ${moves.map((move) => move.from)}::text[],
        ${moves.map((move) => move.to)}::text[]) AS m(id, source, target)
        ON m.id = c.id AND c.record_id = m.source
      WHERE c.org_id = ${c.actor.orgId} AND c.database_id = ${c.databaseId} AND c.table_id = ${tableId}
      ORDER BY c.id FOR UPDATE OF c
    )
    UPDATE ${comments} c SET record_id = moving.target FROM moving WHERE c.id = moving.id
    RETURNING c.*, moving.previous`,
  );
  if (!result.rows.length) return null;
  const rows = [...result.rows].sort(
    (a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id),
  );
  await query(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, 'notifications')} n
    SET target = jsonb_set(n.target, '{recordId}', to_jsonb(m.record))
    FROM unnest(${rows.map((row) => row.id)}::text[], ${rows.map((row) => row.record_id)}::text[]) AS m(id, record)
    WHERE n.org_id = ${c.actor.orgId} AND n.kind = 'mention' AND n.subject_id = m.id`,
  );
  return {
    kind: 'comment.moved',
    tableId,
    comments: rows.map(recordComment),
    from: Object.fromEntries(rows.map((row) => [row.id, row.previous])),
  };
}

/**
 * Undoing (or redoing) a move puts each comment back where it was.  A comment that has moved on
 * since, with a later merge, stays where that merge put it.
 */
export async function reverseCommentMoves(
  c: CommandContext,
  body: CommentsMoved,
): Promise<Mutation & { skipped: number }> {
  await table(c, body.tableId);
  const scope = await scopeOf(c, body.tableId);
  const moves = body.comments.flatMap((comment) => {
    const to = body.from[comment.id];
    return to ? [{ id: comment.id, from: comment.recordId, to }] : [];
  });
  // A merge leaves records in the trash, where their current record rules still protect comments.
  const records = await query<{ __id: string }>(
    c.db,
    sql`SELECT __id FROM ${ident(c.schemas.data, body.tableId)}
    WHERE __id = ANY(${[...new Set(moves.flatMap((move) => [move.from, move.to]))]}::text[])
      AND NOT __source_gone AND (${scope.recordPredicate(body.tableId)})
    ORDER BY __rid FOR UPDATE`,
  );
  const visible = new Set(records.rows.map((row) => row.__id));
  const moved = await moveComments(
    c,
    body.tableId,
    moves.filter((move) => visible.has(move.from) && visible.has(move.to)),
  );
  return {
    body: moved ?? { kind: 'comment.moved', tableId: body.tableId, comments: [], from: {} },
    prev: {},
    skipped: body.comments.length - (moved?.comments.length ?? 0),
  };
}

async function* matchMutations(changes: AsyncIterable<ChangeBody> | undefined): AsyncGenerator<Mutation> {
  if (changes) for await (const body of changes) yield { body, prev: {} };
}

export async function applyMerge(c: CommandContext, command: MergeCommand): Promise<Mutation> {
  const { db, schemas, actor } = c;
  const { tableId, recordId: keptId, mergeIds } = command;
  const parent = await table(c, tableId);
  // A synced table's records come from its source, which would bring the merged ones back.
  if (parent.source || parent.joined) throw new AppError('forbidden', 'dedupe.merge.synced');
  const ids = [keptId, ...mergeIds];
  if (new Set(ids).size !== ids.length) invalid('dedupe.merge.sameRecord');
  const scope = await scopeOf(c, tableId);
  const all = await loadFields(db, schemas, [tableId]);
  const guard = writeGuard(db, schemas, scope, tableId, all);
  // Values are read as the person sees them, and only fields they may change are merged.
  const visible = scope.visibleFields(tableId, all).filter((field) => mergeableField(field));
  const writable = visible.filter((field) => scope.canEditField(tableId, field));
  const byField = new Map(writable.map((field) => [field.id, field]));
  await guard.requireEditable([{ id: keptId, values: command.choices }]);
  for (const [fieldId, choice] of Object.entries(command.choices)) {
    const field = byField.get(fieldId);
    if (!field) invalid('data.field.unknown');
    if (choice === 'combine' && !combinableField(field)) invalid('dedupe.merge.notCombinable');
    if (choice !== 'combine' && !ids.includes(choice)) invalid('dedupe.merge.choice');
  }

  // Every record of the set has to be here and visible to the person, locked in a fixed order.
  await guard.requireVisible(ids);
  const locked = await query<{ __id: string; __rid: string }>(
    db,
    sql`SELECT __id, __rid FROM ${ident(schemas.data, tableId)}
    WHERE __id = ANY(${ids}::text[]) AND __deleted_at IS NULL AND NOT __source_gone
    ORDER BY __rid FOR UPDATE`,
  );
  if (locked.rows.length !== ids.length) invalid('data.record.missing');
  const rids = new Map(locked.rows.map((row) => [row.__id, row.__rid]));
  const read = new Map(
    (await fetchRowsById(db, schemas.data, tableId, writable, ids)).map((row) => [row.id, row]),
  );
  const records = ids.map((id) => read.get(id)!);
  const kept = records[0]!;
  const chosen = mergedValues(writable, records, command.choices);
  let values: CellValues = {};
  for (const field of writable) {
    const value = chosen[field.id] ?? null;
    if (sameValue(value, kept.values[field.id] ?? null)) continue;
    values[field.id] = value;
  }
  await guard.requireEditable([{ id: keptId, values }]);
  // The kept record keeps its links to records the person can't see.
  values = (
    await guard.keepHiddenLinks(
      await checkedRows(c, guard.visible, [{ id: keptId, values }], { restoreSignatures: true }),
      true,
    )
  )[0]!.values;

  // The kept record takes each merged record's place in the lists of the records it linked with.
  const links = writable.filter((field) => field.type === 'link' && Object.hasOwn(values, field.id));
  // Row numbers count within each table, so only links within this one can point at the set.
  const within = new Set(links.filter((field) => field.relation?.linkedTableId === tableId).map((f) => f.id));
  const set = new Set(ids.map((id) => rids.get(id)!));
  const places = new Map<string, LinkPositions>();
  const held = await captureLinkPositions(
    db,
    schemas.data,
    links,
    mergeIds.map((id) => ({ id, values: Object.fromEntries(links.map((field) => [field.id, null])) })),
  );
  for (const place of held) {
    if (within.has(place.fieldId) && set.has(place.targetRid)) continue;
    const key = `${place.fieldId}:${place.targetRid}`;
    const earlier = places.get(key);
    if (!earlier || place.position < earlier.position)
      places.set(key, { ...place, sourceRid: rids.get(keptId)! });
  }
  await guard.requireUnlocked([keptId, ...mergeIds]);
  await guard.requireValid([{ id: keptId, values }], true);
  const changed = Object.keys(values).length > 0;
  if (changed) await attachFiles(c, tableId, all, [{ id: keptId, values }]);

  // The merged records leave first, so a link that holds one record at a time can move to the kept one.
  await guard.requireUnlocked(mergeIds, { links: true });
  const trashed = await trashRecords(db, schemas.data, tableId, mergeIds, actor.userId);
  const hidden = await linkVisibilityChanges(db, schemas, tableId, all, trashed);
  let update: Mutation | undefined;
  if (changed) {
    const matched = await matchedBefore(c, tableId, [keptId]);
    const { updated, linkChanges, linkPositions, matchChanges } = await guard.write(() =>
      updateRecords(
        db,
        schemas.data,
        tableId,
        all,
        [{ id: keptId, values }],
        actor.userId,
        [...places.values()],
        undefined,
        guard.unseen,
      ),
    );
    if (updated.length)
      update = {
        body: {
          kind: 'record.updated',
          tableId,
          records: updated.map(({ prev: _prev, prevOverrides: _overrides, ...row }) => row),
        },
        prev: {
          records: updated.map(({ id, prev }) => ({ id, values: prev })),
          ...(linkPositions?.length ? { linkPositions } : {}),
        },
        additional: chain(
          linkChanges?.map((body) => ({ body, prev: {} })),
          matchMutations(matchChanges),
        ),
        ...(matched ? { triggers: { matchedBefore: matched } } : {}),
      };
  }

  await guard.requireWithinRules([keptId]);
  const comments = await query<{ id: string; record_id: string }>(
    db,
    sql`SELECT id, record_id FROM ${ident(schemas.app, 'comments')}
    WHERE org_id = ${actor.orgId} AND database_id = ${c.databaseId} AND table_id = ${tableId}
      AND record_id = ANY(${mergeIds}::text[]) AND deleted_at IS NULL
    ORDER BY created_at, id`,
  );
  const moved = await moveComments(
    c,
    tableId,
    comments.rows.map((row) => ({ id: row.id, from: row.record_id, to: keptId })),
  );
  await query(
    db,
    sql`INSERT INTO ${ident(schemas.audit, 'events')} (org_id, actor_id, action, metadata)
    VALUES (${actor.orgId}, ${actor.userId}, 'data.records.merged', ${JSON.stringify({
      databaseId: c.databaseId,
      tableId,
      recordId: keptId,
      mergedIds: trashed,
      count: trashed.length,
      comments: moved?.comments.length ?? 0,
      ...(actor.automation ? { automationId: actor.automation.id, runId: actor.automation.runId } : {}),
    })}::jsonb)`,
  );
  return {
    body: { kind: 'record.trashed', tableId, recordIds: trashed },
    prev: {},
    additional: chain(
      hidden.map((body) => ({ body, prev: {} })),
      update ? [update] : [],
      moved ? [{ body: moved, prev: {} }] : [],
    ),
  };
}
