import { resolveSelectOptions, type SelectOptionsMemo } from '../data/select-options.js';
import { cellValue, roleAllows, templateFieldIds, type RowData } from '@riosoma/contracts';
import type { Queryable } from '@riosoma/db';
import { actorFor } from '../automations/run.js';
import { AccessScope } from '../data/access.js';
import type { DataSchemas } from '../data/context.js';
import { formatValue, relationContext } from '../data/format.js';
import { loadFields } from '../data/metadata.js';
import { fetchPageByRid } from '../data/physical/records.js';
import { ridsForIds } from '../data/physical/order.js';
import type { StoredField, StoredTable } from '../data/types.js';
import type { Actor } from '../http/policy.js';

export const OWNER_LOST_ACCESS = 'aiFields.owner.lostAccess';
export const OWNER_FIELD_HIDDEN = 'aiFields.owner.fieldHidden';
export const OWNER_RECORDS_LIMITED = 'aiFields.owner.recordsLimited';

export interface OwnerAccess {
  actor: Actor;
  locale: string;
  scope: AccessScope;
  /** The table's fields the person can see, by ID */
  visible: Map<string, StoredField>;
  /** Every field of the table, seen or not, with its relations */
  fields: StoredField[];
}

/**
 * The person an AI field's runs act as, the way automations act as theirs: whoever last saved the
 * field's settings, while they're an active member who can edit records in the database, see and
 * change the field, and see every field its prompt reads.  Otherwise the reason runs stop.  A
 * record rule that limits them on a table the prompt reads through a link hides the field from
 * them, as it does from anyone, so that stops runs too.
 */
export async function ownerAccess(
  db: Queryable,
  schemas: DataSchemas,
  table: StoredTable,
  field: StoredField,
  memo?: SelectOptionsMemo,
): Promise<{ ok: true; owner: OwnerAccess } | { ok: false; messageKey: string }> {
  const ownerId = field.ai?.ownerId;
  const person = ownerId ? await actorFor(db, schemas, ownerId, table.orgId) : null;
  if (!person) return { ok: false, messageKey: OWNER_LOST_ACCESS };
  const { locale, ...actor } = person;
  const scope = new AccessScope(db, schemas, { ...actor, dataUse: 'provider' });
  const role = await scope.databaseRole(table.databaseId);
  if (!role || !roleAllows(role, 'editRecords')) return { ok: false, messageKey: OWNER_LOST_ACCESS };
  await scope.prepare(table.databaseId);
  const fields = await loadFields(db, schemas, [table.id]);
  const shown = scope.visibleFields(table.id, fields);
  const wanted = new Set([field.id, ...templateFieldIds(field.ai!.prompt)]);
  for (const item of shown)
    if (
      wanted.has(item.id) &&
      (item.type === 'singleSelect' || item.type === 'multipleSelect') &&
      item.options.cascade
    )
      wanted.add(item.options.cascade.fieldId);
  const resolved = await resolveSelectOptions(
    db,
    schemas,
    scope,
    shown.filter((item) => wanted.has(item.id)),
    new Set(),
    memo,
  );
  const visible = new Map(shown.map((item) => [item.id, item]));
  for (const item of resolved) visible.set(item.id, item);
  // A field the prompt reads, once hidden from them, hides the AI field too, so it's asked first.
  if (templateFieldIds(field.ai!.prompt).some((id) => !visible.has(id)))
    return { ok: false, messageKey: OWNER_FIELD_HIDDEN };
  const own = visible.get(field.id);
  if (!own && scope.readsLimitedRecords(table.id, field.ai!.prompt, fields))
    return { ok: false, messageKey: OWNER_RECORDS_LIMITED };
  if (!own || !scope.canEditField(table.id, own)) return { ok: false, messageKey: OWNER_LOST_ACCESS };
  return { ok: true, owner: { actor, locale, scope, visible, fields } };
}

/** A record read through the owner's access, or null when they can't see it or it's gone. */
export async function ownerRecord(
  db: Queryable,
  schemas: DataSchemas,
  table: StoredTable,
  owner: OwnerAccess,
  recordId: string,
): Promise<RowData | null> {
  const rid = (await ridsForIds(db, schemas.data, table.id, [recordId])).get(recordId);
  if (rid === undefined) return null;
  const [row] = await fetchPageByRid(
    db,
    schemas.data,
    table.id,
    [...owner.visible.values()],
    [rid],
    owner.scope.recordPredicate(table.id),
    { now: new Date(), timeZone: 'UTC' },
  );
  return row ?? null;
}

const PLACEHOLDER = /\{([^{}]*)\}/g;

/**
 * The prompt with each field in braces replaced by the record's value, worded the way a download
 * words it: options, people, linked records, and files by name, dates in the field's format, and
 * checkboxes as true or false.
 * `empty` is true when every field the prompt reads is empty, so there's nothing to ask about.
 */
export async function fillPrompt(
  db: Queryable,
  schemas: DataSchemas,
  table: StoredTable,
  owner: OwnerAccess,
  field: StoredField,
  row: RowData,
): Promise<{ text: string; empty: boolean }> {
  const ids = templateFieldIds(field.ai!.prompt);
  const sources = ids.flatMap((id) => owner.visible.get(id) ?? []);
  const names = await relationContext({
    db,
    schemas,
    table,
    scope: owner.scope,
    fields: sources,
    rows: [row],
    names: true,
  });
  const context = { locale: owner.locale, timeZone: 'UTC', ...names };
  // A checkbox reads as true or false, since an unchecked box downloads as nothing at all.
  const words = new Map(
    sources.map((source) => [
      source.id,
      source.type === 'checkbox'
        ? String(cellValue(row, source) === true)
        : formatValue(source, cellValue(row, source), context),
    ]),
  );
  const text = field.ai!.prompt.replace(PLACEHOLDER, (whole, id: string) => words.get(id.trim()) ?? whole);
  return { text, empty: ids.length > 0 && [...words.values()].every((value) => value.trim() === '') };
}
