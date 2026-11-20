import {
  isComputedType,
  isEmptyValue,
  type CellValue,
  type FieldMeta,
  type FilterCondition,
  type FilterGroup,
  type GridConfigPatch,
  type Sort,
  type ViewType,
} from '@riosoma/contracts';
import type { AirtableView } from './api.js';
import type { Note } from './fields.js';

/**
 * Views as they come across.  Airtable's API says only a view's name, its type, and, for grid
 * views, which fields it shows in what order.  So grids keep their fields exactly, cards show the
 * first few fields, and a kanban, calendar, gallery, or timeline uses the first field that suits
 * it.  Filters and sorts are worked out from the records each view shows, in the order it shows
 * them, when a single condition or sort explains them.  Grouping and colors aren't shared at all.
 */

export interface RecordSnapshot {
  /** Records here in the order they were added, which is how Riosoma breaks ties */
  order: readonly string[];
  /** Each record's values here, by field ID */
  values: ReadonlyMap<string, Readonly<Record<string, CellValue>>>;
}

export interface ViewInput {
  source: AirtableView;
  /** The table's fields here, in their order, after formulas and the rest are in */
  fields: readonly FieldMeta[];
  primaryFieldId: string;
  /** A field's ID here, by its Airtable ID */
  fieldId(airtableId: string): string | undefined;
  /** Fields here that Airtable doesn't have, such as the other side of a one-way link */
  extra: ReadonlySet<string>;
  records?: RecordSnapshot;
  /** The records the view shows, in its order, when they were read */
  shown?: readonly string[];
  /** Why the view's records weren't read, when they weren't */
  unread?: Note;
}

export interface ViewResult {
  type: ViewType | null;
  config: GridConfigPatch;
  notes: Note[];
}

const TYPES: Readonly<Record<string, ViewType>> = {
  grid: 'grid',
  kanban: 'kanban',
  gallery: 'gallery',
  calendar: 'calendar',
  form: 'form',
  timeline: 'timeline',
  gantt: 'gantt',
  list: 'list',
};

const CARD_FIELDS = 3;

const isCalendar = (field: FieldMeta) =>
  field.type === 'date' ||
  field.type === 'createdTime' ||
  field.type === 'lastModifiedTime' ||
  (field.type === 'formula' &&
    (field.options.resultType === 'date' || field.options.resultType === 'datetime'));

export function buildView(input: ViewInput): ViewResult {
  const type = TYPES[input.source.type] ?? null;
  const notes: Note[] = [];
  if (!type) {
    notes.push({
      status: 'omitted',
      key: 'import.airtable.report.viewUnsupported',
      params: { type: input.source.type.slice(0, 64) },
    });
    return { type: null, config: {}, notes };
  }
  const ids = input.fields.map((field) => field.id);
  const extra = ids.filter((id) => input.extra.has(id));
  const config: GridConfigPatch = {};
  if (type === 'grid' && input.source.visibleFieldIds) {
    const visible = input.source.visibleFieldIds
      .map((id) => input.fieldId(id))
      .filter((id): id is string => id !== undefined && ids.includes(id));
    const shown = new Set([input.primaryFieldId, ...visible]);
    config.fieldOrder = [...new Set([...visible, ...ids])];
    config.hiddenFieldIds = ids.filter((id) => !shown.has(id));
  } else if (type === 'kanban' || type === 'gallery') {
    const cards = ids
      .filter((id) => id !== input.primaryFieldId && !input.extra.has(id))
      .slice(0, CARD_FIELDS);
    config.hiddenFieldIds = ids.filter((id) => id !== input.primaryFieldId && !cards.includes(id));
    notes.push({ status: 'changed', key: 'import.airtable.report.viewFields' });
  } else if (extra.length) config.hiddenFieldIds = extra;

  const first = (accepts: (field: FieldMeta) => boolean) =>
    input.fields.find((field) => !input.extra.has(field.id) && accepts(field));
  if (type === 'kanban') {
    const stack = first(
      (field) => field.type === 'singleSelect' || (field.type === 'user' && !field.options.allowMultiple),
    );
    config.kanban = {
      stackFieldId: stack?.id ?? null,
      stackOrder: [],
      hiddenStacks: [],
      hideEmptyStacks: false,
      coverFieldId: null,
      coverFit: 'crop',
    };
    notes.push(
      stack
        ? { status: 'changed', key: 'import.airtable.report.viewStack', params: { field: stack.name } }
        : { status: 'changed', key: 'import.airtable.report.viewNoStack' },
    );
  }
  if (type === 'gallery') {
    const cover = first((field) => field.type === 'attachment');
    config.gallery = { coverFieldId: cover?.id ?? null, coverFit: 'crop', cardSize: 'medium' };
    if (cover)
      notes.push({
        status: 'changed',
        key: 'import.airtable.report.viewCover',
        params: { field: cover.name },
      });
  }
  if (type === 'calendar' || type === 'timeline' || type === 'gantt') {
    const dates = input.fields.filter((field) => !input.extra.has(field.id) && isCalendar(field));
    const start = dates[0]?.id ?? null;
    const end = type === 'calendar' ? null : (dates[1]?.id ?? null);
    if (type === 'calendar') config.calendar = { startFieldId: start, endFieldId: end, range: 'month' };
    else if (type === 'timeline')
      config.timeline = {
        startFieldId: start,
        endFieldId: end,
        groupFieldId: null,
        labelFieldId: null,
        zoom: 'week',
      };
    else
      config.gantt = {
        startFieldId: start,
        endFieldId: end,
        dependencyFieldId: null,
        progressFieldId: null,
        labelFieldId: null,
        labelWidth: 240,
        zoom: 'week',
      };
    notes.push(
      dates[0]
        ? { status: 'changed', key: 'import.airtable.report.viewDates', params: { field: dates[0].name } }
        : { status: 'changed', key: 'import.airtable.report.viewNoDates' },
    );
  }
  if (type === 'form') {
    config.form = {
      title: input.source.name,
      description: '',
      questions: input.fields
        .filter((field) => !input.extra.has(field.id) && !isComputedType(field.type))
        .map((field) => ({ fieldId: field.id, required: false, label: '', help: '' })),
      submitLabel: '',
      thankYou: '',
      allowAnother: true,
      allowEdits: false,
      editLinkDays: 30,
      editConfirmationEmail: false,
    };
    notes.push({ status: 'changed', key: 'import.airtable.report.viewQuestions' });
    return { type, config, notes };
  }

  if (input.unread) notes.push(input.unread);
  else if (input.records && input.shown) {
    const filter = inferFilter(input.records, input.shown, input.fields);
    if (filter === null) notes.push({ status: 'omitted', key: 'import.airtable.report.viewFilterUnknown' });
    else if (filter !== 'none') {
      config.filter = filter;
      notes.push({ status: 'changed', key: 'import.airtable.report.viewFilter' });
    }
    const sorts = inferSorts(input.records, input.shown, input.fields);
    if (sorts === null) notes.push({ status: 'omitted', key: 'import.airtable.report.viewSortUnknown' });
    else if (sorts !== 'none') {
      config.sorts = sorts;
      notes.push({ status: 'changed', key: 'import.airtable.report.viewSort' });
    }
  }
  return { type, config, notes };
}

type Candidate = {
  condition: Omit<FilterCondition, 'id'>;
  matches: (value: CellValue | undefined) => boolean;
};

const TEXTUAL = new Set(['text', 'longText', 'email', 'url', 'phone']);

function listOf(value: CellValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Conditions that could explain a view, simplest first. */
function candidates(field: FieldMeta, shown: readonly (CellValue | undefined)[]): Candidate[] {
  const found: Candidate[] = [];
  const fieldId = field.id;
  if (field.type === 'checkbox') {
    found.push(
      { condition: { fieldId, operator: 'is', value: true }, matches: (value) => value === true },
      { condition: { fieldId, operator: 'is', value: false }, matches: (value) => value !== true },
    );
    return found;
  }
  if (field.type === 'singleSelect') {
    const chosen = [...new Set(shown.filter((value): value is string => typeof value === 'string'))];
    for (const choice of chosen)
      found.push({
        condition: { fieldId, operator: 'is', value: choice },
        matches: (value) => value === choice,
      });
    if (chosen.length > 1)
      found.push({
        condition: { fieldId, operator: 'isAnyOf', value: chosen },
        matches: (value) => typeof value === 'string' && chosen.includes(value),
      });
  }
  if (field.type === 'multipleSelect' || field.type === 'user') {
    for (const item of new Set(shown.flatMap(listOf)))
      found.push({
        condition: { fieldId, operator: 'hasAnyOf', value: [item] },
        matches: (value) => listOf(value).includes(item),
      });
  }
  if (TEXTUAL.has(field.type)) {
    const texts = new Set(shown.map((value) => (typeof value === 'string' ? value.toLowerCase() : null)));
    const [only] = [...texts];
    if (texts.size === 1 && typeof only === 'string')
      found.push({
        condition: { fieldId, operator: 'is', value: shown.find((value) => typeof value === 'string') },
        matches: (value) => typeof value === 'string' && value.toLowerCase() === only,
      });
  }
  found.push(
    { condition: { fieldId, operator: 'isNotEmpty' }, matches: (value) => !isEmptyValue(value ?? null) },
    { condition: { fieldId, operator: 'isEmpty' }, matches: (value) => isEmptyValue(value ?? null) },
  );
  return found;
}

/** Fields whose values a view's filter can be worked out from: the ones the import wrote. */
function readable(field: FieldMeta): boolean {
  return !isComputedType(field.type) && field.type !== 'attachment' && field.type !== 'signature';
}

/**
 * A single condition that picks exactly the records the view shows, `none` when it shows every
 * record, or null when no single condition does.
 */
export function inferFilter(
  records: RecordSnapshot,
  shown: readonly string[],
  fields: readonly FieldMeta[],
): FilterGroup | 'none' | null {
  const inView = new Set(shown);
  if (records.order.every((id) => inView.has(id))) return 'none';
  for (const field of fields.filter(readable)) {
    const valueOf = (id: string) => records.values.get(id)?.[field.id];
    for (const candidate of candidates(field, shown.map(valueOf)))
      if (records.order.every((id) => candidate.matches(valueOf(id)) === inView.has(id)))
        return { conjunction: 'and', conditions: [{ id: 'imported', ...candidate.condition }] };
  }
  return null;
}

type Key = number | string;

const COLLATORS = [
  new Intl.Collator('en', { sensitivity: 'base', numeric: true }),
  new Intl.Collator('en', { sensitivity: 'base' }),
];

function keysOf(field: FieldMeta): ((value: CellValue | undefined) => Key | null) | null {
  switch (field.type) {
    case 'number':
    case 'currency':
    case 'percent':
    case 'duration':
    case 'rating':
    case 'autoNumber':
      return (value) => (typeof value === 'number' ? value : null);
    case 'text':
    case 'longText':
    case 'email':
    case 'url':
    case 'phone':
    case 'date':
      return (value) => (typeof value === 'string' && value !== '' ? value : null);
    case 'checkbox':
      return (value) => (value === true ? 1 : 0);
    case 'singleSelect': {
      const positions = new Map(field.options.choices.map((choice, index) => [choice.id, index]));
      return (value) => (typeof value === 'string' ? (positions.get(value) ?? null) : null);
    }
    default:
      return null;
  }
}

interface Level {
  sort: Sort;
  has(id: string): boolean;
  compare(a: string, b: string): number;
}

function ordered(ids: readonly string[], compare: (a: string, b: string) => number): boolean {
  for (let index = 1; index < ids.length; index++)
    if (compare(ids[index - 1]!, ids[index]!) > 0) return false;
  return true;
}

const plain = (x: Key, y: Key) =>
  typeof x === 'number' && typeof y === 'number'
    ? x - y
    : String(x) < String(y)
      ? -1
      : String(x) > String(y)
        ? 1
        : 0;

/**
 * Sorts that put the records in the order the view shows them: one field, or one and then
 * another for its ties, with ties after that in the order records were added, as Riosoma breaks
 * them.  Empty values have to sit together at one end.  Airtable may show them first, and Riosoma
 * shows them last.
 */
export function inferSorts(
  records: RecordSnapshot,
  shown: readonly string[],
  fields: readonly FieldMeta[],
): Sort[] | 'none' | null {
  const added = new Map(records.order.map((id, index) => [id, index]));
  const byAdding = (a: string, b: string) => (added.get(a) ?? 0) - (added.get(b) ?? 0);
  if (ordered(shown, byAdding)) return 'none';
  const levels: Level[] = [];
  for (const field of fields) {
    const key = keysOf(field);
    if (!key) continue;
    const keys = new Map(shown.map((id) => [id, key(records.values.get(id)?.[field.id])]));
    const comparisons = TEXTUAL.has(field.type)
      ? COLLATORS.map((collator) => (x: Key, y: Key) => collator.compare(String(x), String(y)))
      : [plain];
    for (const direction of ['asc', 'desc'] as const)
      for (const comparison of comparisons) {
        const sign = direction === 'asc' ? 1 : -1;
        levels.push({
          sort: { fieldId: field.id, direction },
          has: (id) => (keys.get(id) ?? null) !== null,
          compare: (a, b) => {
            const x = keys.get(a) ?? null;
            const y = keys.get(b) ?? null;
            return x === null || y === null ? 0 : sign * comparison(x, y);
          },
        });
      }
  }
  // Levels that could lead: they order the records the view shows, ties aside.
  const leading = levels.flatMap((first) => {
    const kept = shown.filter((id) => first.has(id));
    const empties = shown.length - kept.length;
    const together =
      empties === 0 ||
      shown.slice(0, empties).every((id) => !first.has(id)) ||
      shown.slice(kept.length).every((id) => !first.has(id));
    const telling = kept.some((id, index) => index > 0 && first.compare(kept[index - 1]!, id) < 0);
    return together && telling && ordered(kept, first.compare) ? [{ first, kept }] : [];
  });
  // One field is a simpler answer than two, so every single field is tried first.
  for (const { first, kept } of leading)
    if (ordered(kept, (a, b) => first.compare(a, b) || byAdding(a, b))) return [first.sort];
  for (const { first, kept } of leading)
    for (const second of levels) {
      if (second.sort.fieldId === first.sort.fieldId) continue;
      if (ordered(kept, (a, b) => first.compare(a, b) || second.compare(a, b) || byAdding(a, b)))
        return [first.sort, second.sort];
    }
  return null;
}
