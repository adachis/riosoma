import {
  checkCondition,
  isComputedType,
  LIMITS,
  type FieldMeta,
  type FilterCondition,
  type FilterGroup,
  type GridConfigPatch,
  type Sort,
  type ViewType,
} from '@riosoma/contracts';
import type { Note } from '../core/report.js';
import type { SourceCondition, SourceFilter, SourceView } from './model.js';

/**
 * Views as they come across from tools that share their settings.  Each keeps the fields it shows
 * in its order, its filter and sorts, and the fields it stacks, colors, dates, or maps by, as far
 * as there's a field here like the one it used.  Conditions that have no match here are left out,
 * each with a line in the report, and so is anything the tool has that views here don't.
 */

export interface ViewInput {
  source: SourceView;
  /** The table's fields here, in their order, after formulas and the rest are in */
  fields: readonly FieldMeta[];
  primaryFieldId: string;
  /** A field's ID here, by the tool's ID */
  fieldId(sourceId: string): string | undefined;
  /** Linked records' IDs here, by the tool's IDs, for a link field (by the tool's ID) */
  records(sourceField: string, ids: readonly string[]): string[];
  /** Fields here the tool doesn't have, such as the other side of a one-way link */
  extra: ReadonlySet<string>;
}

export interface ViewResult {
  type: ViewType | null;
  config: GridConfigPatch;
  notes: Note[];
}

const note = (status: Note['status'], key: string, params?: Note['params']): Note => ({
  status,
  key,
  ...(params ? { params } : {}),
});

const isDate = (field: FieldMeta) =>
  field.type === 'date' ||
  field.type === 'createdTime' ||
  field.type === 'lastModifiedTime' ||
  (field.type === 'formula' &&
    (field.options.resultType === 'date' || field.options.resultType === 'datetime'));

const GROUPS: Partial<Record<ViewType, (field: FieldMeta) => boolean>> = {
  kanban: (field) => field.type === 'singleSelect' || (field.type === 'user' && !field.options.allowMultiple),
  timeline: (field) => field.type === 'singleSelect' || field.type === 'user' || field.type === 'link',
  list: (field) => field.type === 'singleSelect' || field.type === 'user' || field.type === 'link',
  map: (field) => field.type === 'singleSelect',
};

/** A condition here for one of the tool's, or null when it has no match here. */
function condition(input: ViewInput, source: SourceCondition, index: number): FilterCondition | null {
  const fieldId = input.fieldId(source.field);
  const field = input.fields.find((item) => item.id === fieldId);
  if (!field) return null;
  const { value } = source;
  let converted: unknown;
  switch (value.kind) {
    case 'none':
      converted = undefined;
      break;
    case 'text':
      converted = value.text;
      break;
    case 'number':
      converted = value.number;
      break;
    case 'boolean':
      converted = value.value;
      break;
    case 'choices': {
      if (field.type !== 'singleSelect' && field.type !== 'multipleSelect') return null;
      const ids = value.names.map(
        (name) => field.options.choices.find((choice) => choice.name === name.trim())?.id,
      );
      if (!ids.length || ids.some((id) => id === undefined)) return null;
      converted =
        field.type === 'singleSelect' && (source.operator === 'is' || source.operator === 'isNot')
          ? ids[0]
          : ids;
      break;
    }
    case 'records': {
      const ids = input.records(source.field, value.ids);
      if (!ids.length || ids.length !== value.ids.length) return null;
      converted = ids;
      break;
    }
    case 'date':
      converted = value.target;
      break;
    case 'range':
      converted = value.range;
      break;
  }
  const made: FilterCondition = {
    id: `imported${index}`,
    fieldId: field.id,
    operator: source.operator,
    ...(converted === undefined ? {} : { value: converted }),
  };
  const checked = checkCondition(field, made);
  return checked.valid && checked.usable ? made : null;
}

/** The tool's filter as one here, and how many of its conditions had no match. */
function filterOf(input: ViewInput, source: SourceFilter): { group: FilterGroup | null; dropped: number } {
  let dropped = 0;
  let index = 0;
  const walk = (group: SourceFilter, depth: number): FilterGroup | null => {
    const conditions: FilterGroup['conditions'] = [];
    for (const item of group.conditions) {
      if ('conjunction' in item) {
        const nested = depth < LIMITS.filterDepth ? walk(item, depth + 1) : null;
        if (nested) conditions.push(nested);
        else dropped++;
        continue;
      }
      const made = index < LIMITS.filterConditions ? condition(input, item, index++) : null;
      if (made) conditions.push(made);
      else dropped++;
    }
    return conditions.length ? { conjunction: group.conjunction, conditions } : null;
  };
  const group = walk(source, 1);
  // A filter that's one group of conditions is that group.
  const only = group?.conditions.length === 1 ? group.conditions[0] : undefined;
  return { group: only && 'conjunction' in only ? only : group, dropped };
}

export function buildView(input: ViewInput): ViewResult {
  const { source } = input;
  const notes: Note[] = [...source.notes];
  const type = source.kind;
  if (!type) {
    notes.push(note('omitted', 'import.platform.report.viewUnsupported', { type: source.type.slice(0, 64) }));
    return { type: null, config: {}, notes };
  }
  const ids = input.fields.map((field) => field.id);
  const byId = new Map(input.fields.map((field) => [field.id, field]));
  const find = (sourceId: string | null | undefined) => {
    const id = sourceId ? input.fieldId(sourceId) : undefined;
    return id ? byId.get(id) : undefined;
  };
  const config: GridConfigPatch = {};

  if (source.shown) {
    const visible = [
      ...new Set(source.shown.map((id) => input.fieldId(id)).filter((id): id is string => id !== undefined)),
    ].filter((id) => ids.includes(id));
    const shown = new Set([input.primaryFieldId, ...visible]);
    config.fieldOrder = [...new Set([input.primaryFieldId, ...visible, ...ids])];
    config.hiddenFieldIds = ids.filter((id) => !shown.has(id));
  } else {
    const extra = ids.filter((id) => input.extra.has(id));
    if (extra.length) config.hiddenFieldIds = extra;
  }

  // What it stacks, groups, or colors by.  A kanban needs one, so it takes the first field that
  // suits when the tool's didn't come across.  Elsewhere grouping is optional.
  const suits = GROUPS[type];
  let group: string | null = null;
  if (suits) {
    const wanted = find(source.group);
    const chosen = wanted && suits(wanted) ? wanted : undefined;
    if (chosen) group = chosen.id;
    else if (type === 'kanban') {
      const first = input.fields.find((field) => !input.extra.has(field.id) && suits(field));
      group = first?.id ?? null;
      notes.push(
        first
          ? note('changed', 'import.platform.report.viewGroup', { field: first.name })
          : note('changed', 'import.platform.report.viewNoGroup'),
      );
    } else if (source.group) notes.push(note('omitted', 'import.platform.report.viewGroupDropped'));
  } else if (source.group) notes.push(note('omitted', 'import.platform.report.viewGroupDropped'));
  if (type === 'kanban')
    config.kanban = {
      stackFieldId: group,
      stackOrder: [],
      hiddenStacks: [],
      hideEmptyStacks: false,
      coverFieldId: null,
      coverFit: 'crop',
    };
  if (type === 'list') config.list = { groupFieldId: group, parentFieldId: null, visibleFieldCount: 3 };

  if (type === 'kanban' || type === 'gallery') {
    const cover = find(source.cover);
    const coverId = cover?.type === 'attachment' ? cover.id : null;
    if (source.cover && !coverId) notes.push(note('changed', 'import.platform.report.viewNoCover'));
    if (type === 'kanban' && config.kanban) config.kanban = { ...config.kanban, coverFieldId: coverId };
    else config.gallery = { coverFieldId: coverId, coverFit: 'crop', cardSize: 'medium' };
  }

  if (type === 'calendar' || type === 'timeline' || type === 'gantt') {
    const start = find(source.start);
    const end = find(source.end);
    const dates = input.fields.filter((field) => !input.extra.has(field.id) && isDate(field));
    const startId = start && isDate(start) ? start.id : (dates[0]?.id ?? null);
    const endId = end && isDate(end) ? end.id : null;
    if ((source.start && startId !== start?.id) || (source.end && endId !== end?.id))
      notes.push(
        startId
          ? note('changed', 'import.platform.report.viewDates', {
              field: byId.get(startId)?.name ?? '',
            })
          : note('changed', 'import.platform.report.viewNoDates'),
      );
    else if (!source.start && !startId) notes.push(note('changed', 'import.platform.report.viewNoDates'));
    if (type === 'calendar') config.calendar = { startFieldId: startId, endFieldId: endId, range: 'month' };
    else if (type === 'timeline')
      config.timeline = {
        startFieldId: startId,
        endFieldId: endId,
        groupFieldId: group,
        labelFieldId: null,
        zoom: 'week',
      };
    else
      config.gantt = {
        startFieldId: startId,
        endFieldId: endId,
        dependencyFieldId: null,
        progressFieldId: null,
        labelFieldId: null,
        labelWidth: 240,
        zoom: 'week',
      };
  }

  if (type === 'map') {
    const place = find(source.start);
    const location =
      place?.type === 'location' ? place : input.fields.find((field) => field.type === 'location');
    if (!location) notes.push(note('changed', 'import.platform.report.viewNoPlace'));
    config.map = { locationFieldId: location?.id ?? null, colorFieldId: group };
  }

  if (type === 'form') {
    const asked = source.questions
      ? source.questions.flatMap((question) => {
          const field = find(question.field);
          return field && !isComputedType(field.type) && !input.extra.has(field.id)
            ? [
                {
                  fieldId: field.id,
                  required: question.required,
                  label: question.label.slice(0, LIMITS.nameLength),
                  help: question.help.slice(0, LIMITS.descriptionLength),
                },
              ]
            : [];
        })
      : input.fields
          .filter((field) => !input.extra.has(field.id) && !isComputedType(field.type))
          .map((field) => ({ fieldId: field.id, required: false, label: '', help: '' }));
    config.form = {
      title: (source.form?.title || source.name).slice(0, LIMITS.nameLength),
      description: (source.form?.description ?? '').slice(0, LIMITS.descriptionLength),
      questions: [...new Map(asked.map((question) => [question.fieldId, question])).values()],
      submitLabel: (source.form?.submitLabel ?? '').slice(0, 60),
      thankYou: (source.form?.thankYou ?? '').slice(0, LIMITS.descriptionLength),
      allowAnother: true,
      allowEdits: false,
      editLinkDays: 30,
      editConfirmationEmail: false,
    };
    return { type, config, notes };
  }

  if (source.filter || source.unmatched) {
    const found = source.filter ? filterOf(input, source.filter) : { group: null, dropped: 0 };
    const group = found.group;
    const dropped = found.dropped + (source.unmatched ?? 0);
    if (group) config.filter = group;
    if (dropped)
      notes.push(
        group
          ? note('changed', 'import.platform.report.viewFilterPartial', { count: dropped })
          : note('omitted', 'import.platform.report.viewFilterDropped'),
      );
  }
  if (source.sorts?.length) {
    const sorts: Sort[] = [];
    let dropped = 0;
    for (const sort of source.sorts) {
      const field = find(sort.field);
      if (field && sorts.length < LIMITS.sortsPerView && !sorts.some((item) => item.fieldId === field.id))
        sorts.push({ fieldId: field.id, direction: sort.direction });
      else dropped++;
    }
    if (sorts.length) config.sorts = sorts;
    if (dropped) notes.push(note('changed', 'import.platform.report.viewSortPartial', { count: dropped }));
  }
  return { type, config, notes };
}
