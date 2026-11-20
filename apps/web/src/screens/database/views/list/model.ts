import {
  cellValue,
  idsOf,
  isParentField,
  isTimelineGroupField,
  type CellValue,
  type FieldMeta,
  type ListSettings,
  type RowData,
} from '@riosoma/contracts';
import { EMPTY_LANE, laneKeys } from '../timeline/layout';

/** The group of records with nothing in the group field. */
export const EMPTY_GROUP = EMPTY_LANE;

/**
 * How a list lays its records out: nested under their parents, in groups, or in the view's order.
 * A parent field outranks a group field, which the server never lets a view save together.
 */
export type ListMode =
  { kind: 'flat' } | { kind: 'group'; field: FieldMeta } | { kind: 'outline'; field: FieldMeta };

export function listMode(settings: ListSettings, fields: readonly FieldMeta[]): ListMode {
  const parent = fields.find((field) => field.id === settings.parentFieldId && isParentField(field));
  if (parent) return { kind: 'outline', field: parent };
  const group = fields.find((field) => field.id === settings.groupFieldId && isTimelineGroupField(field));
  return group ? { kind: 'group', field: group } : { kind: 'flat' };
}

export interface GroupLine {
  kind: 'group';
  key: string;
  group: string;
  count: number;
  expanded: boolean;
  level: 1;
  /** Place among the groups, from 1, and how many there are */
  position: number;
  size: number;
}

export interface RecordLine {
  kind: 'record';
  /** Unique in the list: a record in several groups has a line in each */
  key: string;
  /** Missing while its page loads, which happens only in a list in the view's order */
  row: RowData | undefined;
  /** Where the record is in the view's order */
  index: number;
  /** In a grouped list, the group this line is in */
  group: string | null;
  /** In an outline, the record this one is nested under, or null at the top */
  parent: string | null;
  level: number;
  /** In an outline, how many records are nested directly under this one */
  children: number;
  expanded: boolean;
  /** Place among its siblings, from 1, and how many siblings there are */
  position: number;
  size: number;
}

export type Line = GroupLine | RecordLine;

export interface ListModel {
  kind: ListMode['kind'];
  lines: Line[];
  /** A grouped list's groups, in order */
  groups: string[];
  /** A grouped list's records in each group, in the view's order, whether the group is open or not */
  members: ReadonlyMap<string, readonly string[]>;
  /**
   * In an outline, each record's parent (null at the top) and children, in the view's order.  A
   * list in the view's order has its loaded records as the children of null.
   */
  parents: ReadonlyMap<string, string | null>;
  children: ReadonlyMap<string | null, readonly string[]>;
}

export function groupLineKey(group: string): string {
  return `group:${group}`;
}

/**
 * The lines a list shows, in order.  Collapsed groups and records (by line key) keep their
 * lines but hide what's inside them.  `sortGroups` puts a grouped list's groups in order.
 */
export function listModel(
  rows: ReadonlyArray<RowData | undefined>,
  mode: ListMode,
  collapsed: ReadonlySet<string>,
  sortGroups: (keys: string[]) => string[],
): ListModel {
  if (mode.kind === 'group') return grouped(rows, mode.field, collapsed, sortGroups);
  if (mode.kind === 'outline') return outline(rows, mode.field, collapsed);
  return {
    kind: 'flat',
    lines: rows.map((row, index) => ({
      kind: 'record',
      key: row?.id ?? `#${index}`,
      row,
      index,
      group: null,
      parent: null,
      level: 1,
      children: 0,
      expanded: false,
      position: index + 1,
      size: rows.length,
    })),
    groups: [],
    members: new Map(),
    parents: new Map(),
    children: new Map([[null, rows.flatMap((row) => (row ? [row.id] : []))]]),
  };
}

function grouped(
  rows: ReadonlyArray<RowData | undefined>,
  field: FieldMeta,
  collapsed: ReadonlySet<string>,
  sortGroups: (keys: string[]) => string[],
): ListModel {
  const members = new Map<string, number[]>();
  rows.forEach((row, index) => {
    if (!row) return;
    for (const key of laneKeys(row, field)) {
      const list = members.get(key);
      if (list) list.push(index);
      else members.set(key, [index]);
    }
  });
  const groups = sortGroups([...members.keys()]);
  const lines: Line[] = [];
  groups.forEach((group, position) => {
    const indexes = members.get(group) ?? [];
    const key = groupLineKey(group);
    const expanded = !collapsed.has(key);
    lines.push({
      kind: 'group',
      key,
      group,
      count: indexes.length,
      expanded,
      level: 1,
      position: position + 1,
      size: groups.length,
    });
    if (!expanded) return;
    indexes.forEach((index, place) => {
      const row = rows[index]!;
      lines.push({
        kind: 'record',
        key: `${group}/${row.id}`,
        row,
        index,
        group,
        parent: null,
        level: 2,
        children: 0,
        expanded: false,
        position: place + 1,
        size: indexes.length,
      });
    });
  });
  const ids = new Map(
    groups.map((group) => [group, (members.get(group) ?? []).map((index) => rows[index]!.id)]),
  );
  return { kind: 'group', lines, groups, members: ids, parents: new Map(), children: new Map() };
}

/** A record's parent: the first record in the list its parent field links to, other than itself. */
function parentOf(row: RowData, field: FieldMeta, present: ReadonlyMap<string, number>): string | null {
  for (const id of idsOf(cellValue(row, field))) if (id !== row.id && present.has(id)) return id;
  return null;
}

function outline(
  rows: ReadonlyArray<RowData | undefined>,
  field: FieldMeta,
  collapsed: ReadonlySet<string>,
): ListModel {
  const present = new Map<string, number>();
  rows.forEach((row, index) => {
    if (row) present.set(row.id, index);
  });
  const parents = new Map<string, string | null>();
  const children = new Map<string | null, string[]>([[null, []]]);
  const adopt = (id: string, parent: string | null) => {
    parents.set(id, parent);
    const list = children.get(parent);
    if (list) list.push(id);
    else children.set(parent, [id]);
  };
  for (const row of rows) if (row) adopt(row.id, parentOf(row, field, present));

  // Open a loop at a member of the cycle so attached descendants keep their real parents.
  const reached = new Set<string>();
  const reach = (start: string | null) => {
    const stack = [...(children.get(start) ?? [])];
    while (stack.length) {
      const id = stack.pop()!;
      if (reached.has(id)) continue;
      reached.add(id);
      stack.push(...(children.get(id) ?? []));
    }
  };
  reach(null);
  let broken = false;
  for (const row of rows) {
    if (!row || reached.has(row.id)) continue;
    const chain = new Set<string>();
    let loop = row.id;
    while (!chain.has(loop)) {
      chain.add(loop);
      loop = parents.get(loop)!;
    }
    const parent = parents.get(loop) ?? null;
    const siblings = children.get(parent);
    if (siblings) siblings.splice(siblings.indexOf(loop), 1);
    adopt(loop, null);
    reached.add(loop);
    reach(loop);
    broken = true;
  }
  if (broken) children.get(null)!.sort((a, b) => present.get(a)! - present.get(b)!);

  const lines: Line[] = [];
  const stack: Array<{ id: string; level: number; position: number; size: number }> = [];
  const push = (ids: readonly string[], level: number) => {
    for (let place = ids.length - 1; place >= 0; place--)
      stack.push({ id: ids[place]!, level, position: place + 1, size: ids.length });
  };
  push(children.get(null)!, 1);
  while (stack.length) {
    const item = stack.pop()!;
    const index = present.get(item.id)!;
    const nested = children.get(item.id) ?? [];
    const expanded = nested.length > 0 && !collapsed.has(item.id);
    lines.push({
      kind: 'record',
      key: item.id,
      row: rows[index],
      index,
      group: null,
      parent: parents.get(item.id) ?? null,
      level: item.level,
      children: nested.length,
      expanded,
      position: item.position,
      size: item.size,
    });
    if (expanded) push(nested, item.level + 1);
  }
  return { kind: 'outline', lines, groups: [], members: new Map(), parents, children };
}

/** Whether `id` is `ancestor` or nested somewhere under it. */
export function within(model: ListModel, id: string | null, ancestor: string): boolean {
  for (let current = id, steps = 0; current !== null && steps <= model.parents.size; steps++) {
    if (current === ancestor) return true;
    current = model.parents.get(current) ?? null;
  }
  return false;
}

/** Where a record goes in the list's own order: just before or just after another record. */
export type Place = { before: string } | { after: string };

/**
 * Where a dragged or moved record goes: into another group, under another parent, or to another
 * place among its siblings.  A group or parent move names a place too when the list keeps its own
 * order, so the record lands where it was dropped.
 */
export type Destination =
  | { kind: 'group'; group: string; place?: Place }
  | { kind: 'parent'; parent: string | null; place?: Place }
  | { kind: 'order'; place: Place };

/** The records a record is ordered among: its group's, its parent's children, or the whole list. */
export function siblingsOf(model: ListModel, line: RecordLine): readonly string[] {
  if (line.group !== null) return model.members.get(line.group) ?? [];
  return model.children.get(line.parent) ?? [];
}

/** A place beside a sibling, or null when the record is already there. */
function beside(
  siblings: readonly string[],
  id: string,
  target: string,
  side: 'before' | 'after',
): Place | null {
  if (target === id) return null;
  const from = siblings.indexOf(id);
  const to = siblings.indexOf(target);
  if (from !== -1 && to !== -1 && to - from === (side === 'before' ? 1 : -1)) return null;
  return side === 'before' ? { before: target } : { after: target };
}

/**
 * Where dropping a record on a line puts it.  On a grouped list, into that line's group.  On an
 * outline, under the line's record when dropped on its middle, or beside it when dropped near an
 * edge.  When the list keeps its own order (`ordered`), a drop on a record's upper or lower half
 * also puts the record just before or just after it.  Null when the drop would change nothing,
 * or would nest a record under itself.
 */
export function destinationAt(
  model: ListModel,
  dragged: RecordLine,
  target: Line,
  /** How far down the target line the pointer is, from 0 to 1 */
  fraction: number,
  ordered = false,
): Destination | null {
  if (!dragged.row) return null;
  const id = dragged.row.id;
  const other = target.kind === 'record' && target.row && target.row.id !== id ? target.row.id : null;
  if (model.kind === 'group') {
    const group = target.group;
    if (group === null) return null;
    const side = fraction < 0.5 ? 'before' : 'after';
    if (group !== dragged.group) {
      const place = ordered && other ? (side === 'before' ? { before: other } : { after: other }) : undefined;
      return { kind: 'group', group, ...(place ? { place } : {}) };
    }
    const place = ordered && other ? beside(siblingsOf(model, dragged), id, other, side) : null;
    return place ? { kind: 'order', place } : null;
  }
  if (target.kind !== 'record' || !target.row) return null;
  if (model.kind === 'flat') {
    const place =
      ordered && other
        ? beside(siblingsOf(model, dragged), id, other, fraction < 0.5 ? 'before' : 'after')
        : null;
    return place ? { kind: 'order', place } : null;
  }
  const inside = fraction >= 0.25 && fraction <= 0.75;
  const parent = inside ? target.row.id : target.parent;
  if (parent !== null && within(model, parent, id)) return null;
  const side = fraction < 0.25 ? 'before' : 'after';
  if (parent === dragged.parent) {
    if (inside || !ordered || !other) return null;
    const place = beside(siblingsOf(model, dragged), id, other, side);
    return place ? { kind: 'order', place } : null;
  }
  const place =
    !inside && ordered && other ? (side === 'before' ? { before: other } : { after: other }) : undefined;
  return { kind: 'parent', parent, ...(place ? { place } : {}) };
}

/**
 * Where moving a record up or down one step puts it in the list's own order: past its sibling
 * that way.  In a grouped list, a record at either end of its group goes on into the next group
 * that way, at its near end, when `crossGroups` allows changing its group.
 */
export function stepDestination(
  model: ListModel,
  line: RecordLine,
  step: 1 | -1,
  crossGroups: boolean,
): Destination | null {
  if (!line.row) return null;
  const id = line.row.id;
  const siblings = siblingsOf(model, line);
  const neighbor = siblings[siblings.indexOf(id) + step];
  if (neighbor !== undefined)
    return { kind: 'order', place: step < 0 ? { before: neighbor } : { after: neighbor } };
  if (!crossGroups) return null;
  const group = neighborGroup(model, line, step);
  if (group === null) return null;
  const members = (model.members.get(group) ?? []).filter((member) => member !== id);
  const near = step < 0 ? members.at(-1) : members[0];
  return {
    kind: 'group',
    group,
    ...(near === undefined ? {} : { place: step < 0 ? { after: near } : { before: near } }),
  };
}

/** The group before or after a line's group, for Alt and the arrow keys. */
export function neighborGroup(model: ListModel, line: RecordLine, step: 1 | -1): string | null {
  if (line.group === null) return null;
  return model.groups[model.groups.indexOf(line.group) + step] ?? null;
}

/**
 * The parent a keyboard move gives a record: its previous sibling, one level in, or its parent's
 * parent, one level out.  Null when there's nowhere to go.
 */
export function neighborParent(
  model: ListModel,
  line: RecordLine,
  direction: 'in' | 'out',
): Destination | null {
  if (!line.row) return null;
  if (direction === 'out') {
    if (line.parent === null) return null;
    return { kind: 'parent', parent: model.parents.get(line.parent) ?? null };
  }
  const siblings = model.children.get(line.parent) ?? [];
  const previous = siblings[siblings.indexOf(line.row.id) - 1];
  return previous === undefined ? null : { kind: 'parent', parent: previous };
}

function holdsOne(field: FieldMeta): boolean {
  return (
    (field.type === 'user' && !field.options.allowMultiple) ||
    (field.type === 'link' && field.options.prefersSingle)
  );
}

/**
 * The values that move a record's line from one group to another.  A person or linked record
 * the record keeps in other groups stays, so a record in two groups moves only out of this one.
 */
export function groupValues(
  row: RowData,
  field: FieldMeta,
  from: string,
  to: string,
): Record<string, CellValue> {
  if (field.type === 'singleSelect') return { [field.id]: to === EMPTY_GROUP ? null : to };
  const kept = holdsOne(field) ? [] : idsOf(cellValue(row, field)).filter((id) => id !== from && id !== to);
  const next = to === EMPTY_GROUP ? kept : [...kept, to];
  return { [field.id]: next.length ? next : null };
}

/** The values a new record takes to start out in a group, or none for the Empty group. */
export function groupStart(field: FieldMeta, group: string): Record<string, CellValue> {
  if (group === EMPTY_GROUP) return {};
  return { [field.id]: field.type === 'singleSelect' ? group : [group] };
}

/**
 * The values that nest a record under a new parent, or bring it to the top with null.  The new
 * parent goes first, since a record nests under the first parent it names.
 */
export function parentValues(
  row: RowData,
  field: FieldMeta,
  from: string | null,
  to: string | null,
): Record<string, CellValue> {
  const kept = holdsOne(field) ? [] : idsOf(cellValue(row, field)).filter((id) => id !== from && id !== to);
  const next = to === null ? kept : [to, ...kept];
  return { [field.id]: next.length ? next : null };
}
