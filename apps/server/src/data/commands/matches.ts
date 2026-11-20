import type { FieldOptionsOf } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { loadField } from '../metadata.js';
import { dropMatchKey, indexMatchKey, isMatchable, MatchRefresh } from '../physical/matches.js';
import type { StoredField } from '../types.js';
import { requireIngestFieldChange } from './fields.js';
import {
  field,
  visibleField,
  invalid,
  publicField,
  storedField,
  type CommandContext,
  type Mutation,
} from './context.js';

/**
 * Links that follow matching values, at the level of commands: checking a link's `match`, keeping
 * both sides of the link agreed on it, rebuilding junctions when a link or one of its fields comes
 * back, and turning links into ordinary ones when a field they follow goes away.
 */

type Match = NonNullable<FieldOptionsOf<'link'>['match']>;

export function sameMatch(a: Match | undefined, b: Match | undefined): boolean {
  return a?.fieldId === b?.fieldId && a?.linkedFieldId === b?.linkedFieldId;
}

/** The same match seen from the linked table. */
export function mirrored(match: Match | undefined): Match | undefined {
  return match && { fieldId: match.linkedFieldId, linkedFieldId: match.fieldId };
}

/** A match joins two different fields whose values links can follow, one in each linked table. */
export async function validateMatch(
  c: CommandContext,
  tableId: string,
  linkedTableId: string,
  match: Match,
): Promise<void> {
  if (match.fieldId === match.linkedFieldId) invalid('errors.validationFailed');
  const own = await field(c, match.fieldId);
  const other = await visibleField(c, match.linkedFieldId, false, 'read');
  if (own.tableId !== tableId || other.tableId !== linkedTableId) invalid('data.field.unknown');
  if (!isMatchable(own.type) || !isMatchable(other.type) || (own.type === 'json' && other.type === 'json'))
    invalid('errors.validationFailed');
}

async function saveOptions(
  c: CommandContext,
  before: StoredField,
  options: StoredField['options'],
): Promise<void> {
  requireIngestFieldChange(c, before, { ...before, options } as StoredField);
  await query(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, 'fields')} SET options = ${JSON.stringify(options)}::jsonb,
    updated_at = statement_timestamp() WHERE id = ${before.id}`,
  );
}

async function updated(c: CommandContext, id: string): Promise<Mutation['body']> {
  const after = await loadField(c.db, c.schemas, id);
  return { kind: 'field.updated', field: publicField(after!), removedChoiceIds: [] };
}

/** Gives the other side of a link the same match, seen from its own table.  Returns that change. */
export async function mirrorMatch(c: CommandContext, link: StoredField): Promise<Mutation[]> {
  if (link.type !== 'link' || !link.options.inverseFieldId) return [];
  const inverse = await loadField(c.db, c.schemas, link.options.inverseFieldId);
  if (!inverse || inverse.type !== 'link' || inverse.options.inverseFieldId !== link.id) return [];
  const match = mirrored(link.options.match);
  if (sameMatch(inverse.options.match, match)) return [];
  await field(c, inverse.id, false, 'editSchema');
  const { match: _previous, ...rest } = inverse.options;
  await saveOptions(c, inverse, match ? { ...rest, match } : rest);
  return [{ body: await updated(c, inverse.id), prev: { field: storedField(inverse), dependent: true } }];
}

async function* linkChanges(refresh: MatchRefresh): AsyncGenerator<Mutation> {
  for await (const body of refresh.changes()) yield { body, prev: {} };
}

/**
 * Rebuilds the junctions of links that follow values, one per pair, and returns the changed lists.
 * Links whose fields are gone or can't be followed are left as they are.
 */
export async function rebuildMatches(
  c: CommandContext,
  links: readonly StoredField[],
): Promise<AsyncIterable<Mutation>> {
  const refresh = new MatchRefresh(c.db, c.schemas.data, c.actor.userId);
  const seen = new Set<string>();
  for (const link of links) {
    const relation = link.relation;
    const match = relation?.match;
    if (!relation || !match || seen.has(relation.linkId)) continue;
    if (
      !isMatchable(match.field.type) ||
      !isMatchable(match.linked.type) ||
      (match.field.type === 'json' && match.linked.type === 'json')
    )
      continue;
    seen.add(relation.linkId);
    await indexMatchKey(c.db, c.schemas, match.field);
    await indexMatchKey(c.db, c.schemas, match.linked);
    await refresh.refresh(link, null);
  }
  return linkChanges(refresh);
}

/** Live link fields whose links follow the field's values, from either side. */
async function linksMatchedOn(c: CommandContext, fieldId: string): Promise<string[]> {
  const result = await query<{ id: string }>(
    c.db,
    sql`SELECT id FROM ${ident(c.schemas.app, 'fields')} WHERE type = 'link' AND trashed_at IS NULL
    AND (options -> 'match' ->> 'fieldId' = ${fieldId} OR options -> 'match' ->> 'linkedFieldId' = ${fieldId})
    ORDER BY id`,
  );
  return result.rows.map((row) => row.id);
}

async function loadLinks(c: CommandContext, ids: readonly string[]): Promise<StoredField[]> {
  const links: StoredField[] = [];
  for (const id of ids) {
    const link = await loadField(c.db, c.schemas, id);
    if (link && !link.trashed) links.push(link);
  }
  return links;
}

/** Takes the match off a link and its other side, keeping the links they have now. */
async function unmatchLink(c: CommandContext, link: StoredField): Promise<Mutation[]> {
  const mutations: Mutation[] = [];
  const fields: string[] = [];
  for (const id of [link.id, link.type === 'link' ? link.options.inverseFieldId : null]) {
    const before = id ? await loadField(c.db, c.schemas, id) : null;
    if (!before || before.type !== 'link' || !before.options.match) continue;
    const { match, ...options } = before.options;
    fields.push(match.fieldId, match.linkedFieldId);
    await saveOptions(c, before, options);
    mutations.push({
      body: await updated(c, before.id),
      prev: { field: storedField(before), dependent: true },
    });
  }
  await dropUnusedMatchKeys(c, fields);
  return mutations;
}

/**
 * Rebuilds the links that can follow their values.  With `settle`, a link whose fields are gone
 * or no longer hold values it can follow becomes an ordinary link.  A link whose other table is
 * in the trash waits for that table to come back.
 */
export async function settleMatches(
  c: CommandContext,
  links: readonly StoredField[],
  settle: boolean,
): Promise<AsyncIterable<Mutation>> {
  const unmatched: Mutation[] = [];
  const valid: StoredField[] = [];
  for (const link of links) {
    if (link.type !== 'link' || !link.options.match || !link.relation) continue;
    const match = link.relation.match;
    if (
      match &&
      isMatchable(match.field.type) &&
      isMatchable(match.linked.type) &&
      !(match.field.type === 'json' && match.linked.type === 'json')
    )
      valid.push(link);
    else if (settle) unmatched.push(...(await unmatchLink(c, link)));
  }
  return chain(unmatched, await rebuildMatches(c, valid));
}

/** Rebuilds the links that follow a field's values, or the link itself when the field is one. */
export async function rematch(
  c: CommandContext,
  fieldId: string,
  settle: boolean,
): Promise<AsyncIterable<Mutation>> {
  const self = await loadField(c.db, c.schemas, fieldId);
  const ids = self?.type === 'link' && self.options.match ? [fieldId] : await linksMatchedOn(c, fieldId);
  return settleMatches(c, await loadLinks(c, ids), settle);
}

/** Rebuilds every link that follows values from a table, as when the table comes back. */
export async function rematchTable(c: CommandContext, tableId: string): Promise<AsyncIterable<Mutation>> {
  const result = await query<{ id: string }>(
    c.db,
    sql`SELECT id FROM ${ident(c.schemas.app, 'fields')} WHERE table_id = ${tableId} AND type = 'link'
    AND trashed_at IS NULL AND options ? 'match' ORDER BY id`,
  );
  return settleMatches(
    c,
    await loadLinks(
      c,
      result.rows.map((row) => row.id),
    ),
    true,
  );
}

/** Drops the matching indexes of fields no live link follows anymore. */
export async function dropUnusedMatchKeys(c: CommandContext, fieldIds: readonly string[]): Promise<void> {
  for (const id of new Set(fieldIds)) {
    if ((await linksMatchedOn(c, id)).length) continue;
    const value = await loadField(c.db, c.schemas, id);
    if (value) await dropMatchKey(c.db, c.schemas, value);
  }
}

/**
 * Turns the links that follow a field's values back into ordinary, editable links, keeping the
 * links they have now.  Used when the field is trashed or stops holding values links can follow.
 * The changes aren't dependent, so undoing the trash or conversion brings the match back.
 */
export async function unmatch(c: CommandContext, fieldId: string): Promise<Mutation[]> {
  const mutations: Mutation[] = [];
  const fields = new Set([fieldId]);
  for (const id of await linksMatchedOn(c, fieldId)) {
    const before = await loadField(c.db, c.schemas, id);
    if (!before || before.type !== 'link' || !before.options.match) continue;
    const { match, ...options } = before.options;
    fields.add(match.fieldId).add(match.linkedFieldId);
    await saveOptions(c, before, options);
    mutations.push({ body: await updated(c, id), prev: { field: storedField(before) } });
  }
  if (mutations.length) await dropUnusedMatchKeys(c, [...fields]);
  return mutations;
}

/** Everything from several sources of changes, in order. */
export async function* chain(
  ...sources: Array<Iterable<Mutation> | AsyncIterable<Mutation> | undefined>
): AsyncGenerator<Mutation> {
  for (const source of sources) if (source) yield* source;
}
