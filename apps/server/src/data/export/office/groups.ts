import { cellValue, EMPTY_STACK, idsOf, isTimelineGroupField, type RowData } from '@riosoma/contracts';
import type { FormatContext } from '../../format.js';
import type { SnapshotRead } from '../../snapshots.js';
import type { StoredField } from '../../types.js';
import { isStackField } from '../../view-settings.js';
import { OFFICE_COPY, say } from './copy.js';

/**
 * The groups a view shows its records in, so a document can give each its own heading: a kanban's
 * stacks, in the board's order and without the stacks it hides, and a list's groups or a
 * timeline's lanes, in the field's order.  A view with no group field, or one whose group field
 * the person can't see, has no groups.
 */

export interface GroupPlan {
  field: StoredField;
  /** A kanban puts each card in one stack, where a list puts a record in each of its values' groups */
  kind: 'stacks' | 'lanes';
  /** Stack IDs the board puts first */
  order: readonly string[];
  hidden: ReadonlySet<string>;
  /** Whether stacks without a card are left out, as the board leaves them out */
  hideEmpty: boolean;
}

export interface Group<T> {
  key: string;
  name: string;
  items: T[];
}

/** The grouping of a view, from its own settings and the fields the person can see. */
export function groupPlan(read: SnapshotRead): GroupPlan | null {
  const { config, type } = read.view;
  const find = (id: string | null) => (id ? read.fields.find((field) => field.id === id) : undefined);
  if (type === 'kanban') {
    const field = find(config.kanban.stackFieldId);
    if (!field || !isStackField(field)) return null;
    return {
      field,
      kind: 'stacks',
      order: config.kanban.stackOrder,
      hidden: new Set(config.kanban.hiddenStacks),
      hideEmpty: config.kanban.hideEmptyStacks,
    };
  }
  // A parent field nests a list rather than grouping it.
  const id =
    type === 'list' && !config.list.parentFieldId
      ? config.list.groupFieldId
      : type === 'timeline'
        ? config.timeline.groupFieldId
        : null;
  const field = find(id);
  if (!field || !isTimelineGroupField(field)) return null;
  return { field, kind: 'lanes', order: [], hidden: new Set(), hideEmpty: true };
}

/** The groups a record is in: one stack on a board, or each of its values in a list. */
function keysOf(plan: GroupPlan, row: RowData): string[] {
  const value = cellValue(row, plan.field);
  if (plan.field.type === 'singleSelect') {
    const known =
      typeof value === 'string' && plan.field.options.choices.some((choice) => choice.id === value);
    return [known ? value : EMPTY_STACK];
  }
  const ids = [...new Set(idsOf(value))];
  if (plan.kind === 'stacks') return [ids[0] ?? EMPTY_STACK];
  return ids.length ? ids : [EMPTY_STACK];
}

function groupName(plan: GroupPlan, key: string, context: FormatContext): string {
  if (key === EMPTY_STACK) return say(OFFICE_COPY.emptyGroup, context.locale, { field: plan.field.name });
  const { field } = plan;
  if (field.type === 'singleSelect')
    return field.options.choices.find((choice) => choice.id === key)?.name ?? '';
  if (field.type === 'user') return context.people.get(key)?.name ?? '';
  return context.linked.get(key) ?? '';
}

/**
 * Items in their groups, each group in view order.  `rowOf` reads an item's record, and `context`
 * names the people and linked records the groups are named after.
 */
export function groupItems<T>(
  plan: GroupPlan,
  items: readonly T[],
  rowOf: (item: T) => RowData,
  context: FormatContext,
): Array<Group<T>> {
  const members = new Map<string, T[]>();
  const add = (key: string, item: T) => {
    const list = members.get(key);
    if (list) list.push(item);
    else members.set(key, [item]);
  };
  const choices =
    plan.field.type === 'singleSelect' ? plan.field.options.choices.map((choice) => choice.id) : null;
  if (plan.kind === 'stacks') {
    // A person who is gone leaves their cards with the ones that have nobody, as the board does.
    const known = new Set(choices ?? [...context.people.keys()]);
    for (const item of items) {
      const key = keysOf(plan, rowOf(item))[0]!;
      add(known.has(key) ? key : EMPTY_STACK, item);
    }
    const base = [...(choices ?? [...context.people.keys()]), EMPTY_STACK];
    const listed = plan.order.filter((key) => base.includes(key));
    const ordered = [...new Set([...listed, ...base])];
    return ordered
      .filter((key) => !plan.hidden.has(key))
      .map((key) => ({ key, name: groupName(plan, key, context), items: members.get(key) ?? [] }))
      .filter((group) => !plan.hideEmpty || group.items.length > 0);
  }
  for (const item of items) for (const key of keysOf(plan, rowOf(item))) add(key, item);
  const rank = choices ? new Map(choices.map((id, index) => [id, index])) : null;
  const collator = new Intl.Collator(context.locale, { numeric: true, sensitivity: 'base' });
  const groups = [...members.keys()].map((key) => ({
    key,
    name: groupName(plan, key, context),
    items: members.get(key)!,
  }));
  // Options keep the field's order, people and records go by name, and the empty group comes last.
  return groups.sort((a, b) => {
    if (a.key === EMPTY_STACK || b.key === EMPTY_STACK) return a.key === EMPTY_STACK ? 1 : -1;
    if (rank) return (rank.get(a.key) ?? 0) - (rank.get(b.key) ?? 0);
    return collator.compare(a.name, b.name) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  });
}
