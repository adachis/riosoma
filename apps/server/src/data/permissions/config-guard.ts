import { AppError, type GridConfig } from '@riosoma/contracts';
import { mentionsAny, redactConfig } from './redact.js';

/**
 * Settings changed by someone who can't see some fields.  They were sent those settings with the
 * hidden fields' values taken out (`redactConfig`), so what they send back is checked before it's
 * saved: a part they didn't change keeps what's stored, and a change to a part that uses a field
 * they can't see, or that starts using one, is refused with `data.access.fieldHidden`.
 */

export const fieldHidden = () => new AppError('forbidden', 'data.access.fieldHidden');

/** JSON with object keys in order, so equal settings compare equal however they were written. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
}

/** A whole setting as it may be saved: what's stored when unchanged, the new one when allowed. */
export function guardConfig<T>(hidden: ReadonlySet<string>, before: T | null | undefined, next: T): T {
  if (!hidden.size) return next;
  const stored = before ?? null;
  if (stored !== null && canonical(next) === canonical(redactConfig(stored, hidden))) return stored;
  if (mentionsAny(stored, hidden) || mentionsAny(next, hidden)) throw fieldHidden();
  return next;
}

/**
 * A view's settings patch as it may be applied.  The lists every view keeps of all its fields
 * (order, hidden fields, widths, and summaries) keep their entries for fields the person can't see,
 * so arranging the columns they see never disturbs the rest.  Every other part follows
 * `guardConfig`.
 */
export function guardViewPatch(
  hidden: ReadonlySet<string>,
  before: GridConfig | null,
  patch: Partial<GridConfig>,
): Partial<GridConfig> {
  if (!hidden.size) return patch;
  const out: Partial<GridConfig> = {};
  for (const [key, value] of Object.entries(patch) as Array<[keyof GridConfig, unknown]>) {
    switch (key) {
      case 'sparklines': {
        const settings = value as GridConfig['sparklines'];
        const stored = before?.sparklines ?? [];
        const byField = new Map(stored.map((setting) => [setting.fieldId, setting]));
        for (const setting of settings) guardConfig(hidden, byField.get(setting.fieldId), setting);
        const withheld = (setting: GridConfig['sparklines'][number]) =>
          hidden.has(setting.fieldId) || Boolean(setting.order && hidden.has(setting.order.fieldId));
        const merged = settings.filter((setting) => !withheld(setting));
        stored.forEach((setting, index) => {
          if (withheld(setting)) merged.splice(Math.min(index, merged.length), 0, setting);
        });
        out.sparklines = merged;
        break;
      }
      case 'iconSets': {
        const sets = value as GridConfig['iconSets'];
        const stored = before?.iconSets ?? [];
        const byField = new Map(stored.map((set) => [set.fieldId, set]));
        for (const set of sets) guardConfig(hidden, byField.get(set.fieldId), set);
        const merged = sets.filter((set) => !hidden.has(set.fieldId));
        // A reader receives only visible sets, so an edit keeps the hidden sets in their saved places.
        stored.forEach((set, index) => {
          if (hidden.has(set.fieldId)) merged.splice(Math.min(index, merged.length), 0, set);
        });
        out.iconSets = merged;
        break;
      }
      case 'columnGroups': {
        const groups = value as GridConfig['columnGroups'];
        const stored = before?.columnGroups ?? [];
        // The group each hidden field sits in, so one that stays there is kept where it was and one
        // placed anywhere else is a change to a field the person can't see.  An undo or a redo
        // replays the settings as they were stored, hidden fields and all, and has to be allowed.
        const groupedIn = new Map<string, string>();
        for (const group of stored)
          for (const id of group.fieldIds) if (hidden.has(id)) groupedIn.set(id, group.id);
        for (const group of groups)
          for (const id of group.fieldIds)
            if (hidden.has(id) && groupedIn.get(id) !== group.id) throw fieldHidden();
        const merged = groups.map((group) => ({
          ...group,
          fieldIds: group.fieldIds.filter((id) => !hidden.has(id)),
        }));
        // Hidden members go back at the place they were stored in, the way field order keeps them.
        for (const group of stored) {
          const into = merged.find((item) => item.id === group.id);
          if (!into) continue;
          group.fieldIds.forEach((id, index) => {
            if (hidden.has(id)) into.fieldIds.splice(Math.min(index, into.fieldIds.length), 0, id);
          });
        }
        out.columnGroups = merged;
        for (const group of stored) {
          const fieldIds = group.fieldIds.filter((id) => hidden.has(id));
          if (fieldIds.length && !merged.some((item) => item.id === group.id))
            out.columnGroups.push({ ...group, fieldIds });
        }
        break;
      }
      case 'fieldOrder': {
        const order = (value as string[]).filter((id) => !hidden.has(id));
        for (const [index, id] of (before?.fieldOrder ?? []).entries())
          if (hidden.has(id)) order.splice(Math.min(index, order.length), 0, id);
        out.fieldOrder = order;
        break;
      }
      case 'hiddenFieldIds':
        out.hiddenFieldIds = [
          ...(value as string[]).filter((id) => !hidden.has(id)),
          ...(before?.hiddenFieldIds ?? []).filter((id) => hidden.has(id)),
        ];
        break;
      case 'headerColors':
      case 'columnWidths':
      case 'summaries': {
        const given = Object.entries(value as Record<string, unknown>).filter(([id]) => !hidden.has(id));
        const kept = Object.entries(before?.[key] ?? {}).filter(([id]) => hidden.has(id));
        (out as Record<string, unknown>)[key] = Object.fromEntries([...given, ...kept]);
        break;
      }
      default:
        (out as Record<string, unknown>)[key] = guardConfig(hidden, before ? before[key] : null, value);
    }
  }
  return out;
}
