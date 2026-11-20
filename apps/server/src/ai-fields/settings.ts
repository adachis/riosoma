import {
  AppError,
  isAiOutputType,
  resolveTemplate,
  templateFieldIds,
  type AiFieldSettings,
  type AiFieldSettingsInput,
  type FieldType,
} from '@riosoma/contracts';
import { scopeOf, visibleFieldsOf, type CommandContext } from '../data/commands/context.js';
import { loadFields } from '../data/metadata.js';
import { readsBack } from '../data/physical/formulas.js';
import type { StoredField } from '../data/types.js';

/** The least a field needs to say what it reads. */
interface Readable {
  id: string;
  type: FieldType;
  options: unknown;
  ai?: AiFieldSettings | undefined;
}

const FIELD_REFERENCE = /\{(fld[0-9A-Za-z]{14})\}/g;

/**
 * The fields of its own record a field's value follows, by ID: an AI field's prompt, a formula's
 * references, and a lookup's, rollup's, or count's link.  Values that arrive through links, such as
 * a lookup's target changing in the linked table, aren't among them.
 */
function readsFrom(field: Readable): string[] {
  if (field.ai) return templateFieldIds(field.ai.prompt);
  const options = (field.options ?? {}) as Record<string, unknown>;
  if (field.type === 'formula' && typeof options.expression === 'string')
    return [...options.expression.matchAll(FIELD_REFERENCE)].map((match) => match[1]!);
  if (
    (field.type === 'lookup' || field.type === 'rollup' || field.type === 'count') &&
    typeof options.linkFieldId === 'string'
  )
    return [options.linkFieldId];
  return [];
}

/**
 * Every field whose change can change what an AI field's prompt reads: the fields it names, and
 * what the formulas, lookups, rollups, and counts among them read in turn.
 */
export function watchedFields(prompt: string, fields: readonly Readable[]): Set<string> {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const watched = new Set<string>();
  const queue = templateFieldIds(prompt);
  while (queue.length) {
    const id = queue.pop()!;
    if (watched.has(id)) continue;
    watched.add(id);
    const field = byId.get(id);
    // Another AI field's value changes only when its own run writes it, which is a change of its own.
    if (field && !field.ai) queue.push(...readsFrom(field));
  }
  return watched;
}

/**
 * Whether an AI field's prompt reads the field's own value back: through a formula, lookup, rollup,
 * count, link, or another AI field, in its own table or through others.  Its runs would then set
 * each other off forever.  `fields` holds the field's table as loaded, with its relations.
 */
export function promptLoops(fieldId: string, prompt: string, fields: readonly StoredField[]): boolean {
  const reads = templateFieldIds(prompt).flatMap((id) => fields.find((field) => field.id === id) ?? []);
  return Boolean(readsBack(reads, fieldId, fields));
}

/**
 * An AI field's settings as they're stored: the prompt with field IDs in place of names, and the
 * person saving them as the one its runs act as.  The prompt may name only fields of the table
 * that person can see, other than buttons, which hold nothing, and the field itself.
 */
export async function aiSettingsFor(
  c: CommandContext,
  tableId: string,
  fieldId: string,
  type: FieldType,
  input: AiFieldSettingsInput,
): Promise<AiFieldSettings> {
  if (!isAiOutputType(type)) throw new AppError('validation_failed', 'aiFields.outputType');
  const visible = (await visibleFieldsOf(c, tableId)).filter(
    (field) => field.id !== fieldId && field.type !== 'button',
  );
  const resolved = resolveTemplate(input.prompt, visible);
  if ('unknown' in resolved)
    throw new AppError('validation_failed', 'aiFields.prompt.unknownField', {
      params: { name: resolved.unknown },
    });
  const all = await loadFields(c.db, c.schemas, [tableId]);
  if (promptLoops(fieldId, resolved.template, all))
    throw new AppError('validation_failed', 'aiFields.prompt.circular');
  // Its person has to be able to see what it writes, which a record rule limiting them on a table
  // the prompt reads through a link would keep from them.
  if ((await scopeOf(c, tableId)).readsLimitedRecords(tableId, resolved.template, all))
    throw new AppError('validation_failed', 'aiFields.prompt.recordsLimited');
  return {
    prompt: resolved.template,
    tier: input.tier,
    trigger: input.trigger,
    ownerId: c.actor.userId,
  };
}
