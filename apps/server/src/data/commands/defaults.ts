import {
  defaultIssue,
  fieldDefault,
  keptDefault,
  normalizedDefault,
  withDefaults,
  type FieldSpec,
} from '@riosoma/contracts';
import type { RecordInput } from '../physical/records.js';
import type { StoredField } from '../types.js';
import { invalid, scopeOf, type CommandContext } from './context.js';

/**
 * Gives new records their fields' defaults where nobody gave a value (see `withDefaults`).  The
 * caller leaves out synced and joined tables, whose records come from their sources.  "The person
 * creating the record" is nobody for a public form, and only ever a member of the organization.
 */
export async function fillDefaults(
  c: CommandContext,
  fields: readonly StoredField[],
  input: ReadonlyArray<{ id: string; values: Record<string, unknown> }>,
  rows: RecordInput[],
  options: { form: boolean; timeZone?: string },
): Promise<void> {
  const defaulted = fields.filter((field) => fieldDefault(field) && !field.managed);
  if (!defaulted.length) return;
  let userId = c.publicForm ? null : c.actor.userId || null;
  if (userId && defaulted.some((field) => fieldDefault(field)?.kind === 'creator')) {
    const members = await (await scopeOf(c)).organizationMemberIds();
    if (!members.has(userId)) userId = null;
  }
  const context = { now: new Date(), userId, timeZone: options.timeZone };
  const given = new Map(input.map((record) => [record.id, record.values]));
  for (const row of rows)
    row.values = withDefaults(defaulted, given.get(row.id) ?? {}, row.values, context, options.form);
}

/**
 * A field's default as a save leaves it.  A default the save sets has to fit, or the save is
 * refused.  One it keeps from before, which an option change or a removed choice no longer lets
 * fit, drops what no longer fits or goes away.  Fields of synced tables take no default.
 */
export function savedDefault<T extends FieldSpec & { ai?: unknown }>(
  after: T,
  before: (FieldSpec & { ai?: unknown }) | undefined,
  options: { synced?: boolean } = {},
): T {
  const value = fieldDefault(after);
  if (!value) return after;
  const previous = before ? fieldDefault(before) : undefined;
  const kept = previous !== undefined && JSON.stringify(previous) === JSON.stringify(value);
  if (kept) return options.synced ? keptDefault(after, undefined) : keptDefault(after, value);
  if (options.synced) invalid('data.field.defaultSynced');
  const issue = defaultIssue(after);
  if (issue) invalid(issue);
  return normalizedDefault(after);
}
