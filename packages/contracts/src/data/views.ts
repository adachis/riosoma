import { VIEW_TYPES } from './view-types.js';
import { z } from 'zod';
import { ChartSettings, PivotSettings, SummaryKind } from './aggregates.js';
import { ColorConfig } from './colors.js';
import { ChoiceColor, RecordId, FieldId, LIMITS, Name, TableId, ViewId, type FieldMeta } from './fields.js';
import { FilterGroup, Sort } from './filters.js';
import { ThemePick } from '../themes.js';

export { VIEW_TYPES } from './view-types.js';
export const ViewType = z.enum(VIEW_TYPES);
export type ViewType = z.infer<typeof ViewType>;

export const ROW_HEIGHTS = ['short', 'medium', 'tall', 'extraTall'] as const;
export const RowHeight = z.enum(ROW_HEIGHTS);
export type RowHeight = z.infer<typeof RowHeight>;

/** Row heights in CSS pixels. */
export const ROW_HEIGHT_PX: Record<RowHeight, number> = { short: 32, medium: 56, tall: 88, extraTall: 128 };

export const COLUMN_WIDTH = { min: 60, max: 1_000, default: 180, primary: 240 } as const;

/** How a cover image fills its card: cropped to fill, or whole with space around it. */
export const COVER_FITS = ['crop', 'fit'] as const;

/** The stack of records with nothing in a kanban's stack field. */
export const EMPTY_STACK = '';

/**
 * Kanban: records as cards in stacks, one per option of a single select, or one per person of a
 * user field.  Cards show the view's visible fields and follow its filter and sorts.
 */
export const KanbanSettings = z.object({
  stackFieldId: FieldId.nullable().default(null),
  /** Stacks by choice or user ID, `EMPTY_STACK` for records with none; missing stacks follow in the field's order */
  stackOrder: z
    .array(z.string().max(20))
    .max(LIMITS.choicesPerField + 1)
    .default([]),
  hiddenStacks: z
    .array(z.string().max(20))
    .max(LIMITS.choicesPerField + 1)
    .default([]),
  hideEmptyStacks: z.boolean().default(false),
  coverFieldId: FieldId.nullable().default(null),
  coverFit: z.enum(COVER_FITS).default('crop'),
});
export type KanbanSettings = z.infer<typeof KanbanSettings>;

/** Gallery: records as cards in a grid, with the view's visible fields. */
export const GallerySettings = z.object({
  coverFieldId: FieldId.nullable().default(null),
  coverFit: z.enum(COVER_FITS).default('crop'),
  cardSize: z.enum(['small', 'medium', 'large']).default('medium'),
});
export type GallerySettings = z.infer<typeof GallerySettings>;

/** Calendar: records on the days of a date field, spanning to an end date when there is one. */
export const CalendarSettings = z.object({
  startFieldId: FieldId.nullable().default(null),
  endFieldId: FieldId.nullable().default(null),
  range: z.enum(['month', 'week']).default('month'),
});
export type CalendarSettings = z.infer<typeof CalendarSettings>;

/**
 * How much time one column of a timeline or Gantt chart's header covers.  The arrow keys move a
 * bar by one of these units, and a record with no end is drawn one unit long.
 */
export const TIMELINE_ZOOMS = ['day', 'week', 'month', 'quarter', 'year'] as const;
export const TimelineZoom = z.enum(TIMELINE_ZOOMS);
export type TimelineZoom = z.infer<typeof TimelineZoom>;

/**
 * Timeline: records as bars from a start date to an end date, in lanes by a group field or packed
 * into as few rows as fit.
 */
export const TimelineSettings = z.object({
  startFieldId: FieldId.nullable().default(null),
  endFieldId: FieldId.nullable().default(null),
  /** A single select, user, or link field.  Records with no value go in an Empty lane. */
  groupFieldId: FieldId.nullable().default(null),
  /** What each bar says, or the primary field when null */
  labelFieldId: FieldId.nullable().default(null),
  zoom: TimelineZoom.default('week'),
});
export type TimelineSettings = z.infer<typeof TimelineSettings>;

/** Widths of a Gantt chart's label column, in CSS pixels. */
export const GANTT_LABEL_WIDTH = { min: 120, max: 600, default: 240 } as const;

/**
 * Gantt: one row per record in the view's order, with bars as on a timeline, progress filled in,
 * and arrows from each record's dependencies to it.
 */
export const GanttSettings = z.object({
  startFieldId: FieldId.nullable().default(null),
  endFieldId: FieldId.nullable().default(null),
  /** A link to this same table naming the records each record depends on */
  dependencyFieldId: FieldId.nullable().default(null),
  /** A percent field, or a number field holding 0 to 100 */
  progressFieldId: FieldId.nullable().default(null),
  /** What the label column and each bar say, or the primary field when null */
  labelFieldId: FieldId.nullable().default(null),
  labelWidth: z
    .number()
    .int()
    .min(GANTT_LABEL_WIDTH.min)
    .max(GANTT_LABEL_WIDTH.max)
    .default(GANTT_LABEL_WIDTH.default),
  zoom: TimelineZoom.default('week'),
});
export type GanttSettings = z.infer<typeof GanttSettings>;

/** Fields a timeline can put in lanes: one lane per option, person, or linked record. */
export function isTimelineGroupField(field: FieldMeta): boolean {
  return field.type === 'singleSelect' || field.type === 'user' || field.type === 'link';
}

/** A link to the field's own table, which a Gantt chart reads as "depends on". */
export function isDependencyField(field: FieldMeta): boolean {
  return field.type === 'link' && field.options.linkedTableId === field.tableId;
}

/** Fields that fill a Gantt bar: percents, and numbers from 0 to 100. */
export function isProgressField(field: FieldMeta): boolean {
  return field.type === 'percent' || field.type === 'number';
}

/** How many of the view's visible fields a list row shows after the primary field. */
export const LIST_FIELD_COUNT = { min: 0, max: 4, default: 3 } as const;

/**
 * List: records as compact rows, in groups by a single select, user, or link field (as a
 * timeline's lanes are), or nested under their parent records as an outline.
 */
export const ListSettings = z.object({
  /** Records with no value share a group of their own, and a record with several is in each one's */
  groupFieldId: FieldId.nullable().default(null),
  /** A link to this same table naming each record's parent, which nests the list instead of grouping it */
  parentFieldId: FieldId.nullable().default(null),
  visibleFieldCount: z
    .number()
    .int()
    .min(LIST_FIELD_COUNT.min)
    .max(LIST_FIELD_COUNT.max)
    .default(LIST_FIELD_COUNT.default),
});
export type ListSettings = z.infer<typeof ListSettings>;

/** Org chart: cards connected by the first visible parent in a link to this table. */
export const OrgChartSettings = z.object({
  parentFieldId: FieldId.nullable().default(null),
});
export type OrgChartSettings = z.infer<typeof OrgChartSettings>;

/**
 * Map: records with a place as pins, clustered when zoomed out.  Everyone moves the map for
 * themselves, so where it was last looking isn't saved with the view.
 */
export const MapSettings = z.object({
  locationFieldId: FieldId.nullable().default(null),
  /** A single select field whose options color the pins */
  colorFieldId: FieldId.nullable().default(null),
});
export type MapSettings = z.infer<typeof MapSettings>;

/** A link to the field's own table, which a list reads as each record's parent. */
export function isParentField(field: FieldMeta): boolean {
  return isDependencyField(field);
}

export const FORM_CONDITION_TYPES = ['text', 'number', 'checkbox', 'singleSelect', 'multipleSelect'] as const;

export const FormShowIf = z.object({
  fieldId: FieldId,
  /** Exact scalar match, or membership in a multiple select answer.  Empty answers never match. */
  equals: z.union([z.string().max(LIMITS.descriptionLength), z.number(), z.boolean()]),
});
export type FormShowIf = z.infer<typeof FormShowIf>;

/** Only visible earlier answers can reveal a question, including when a dependency is unavailable. */
export function visibleFormQuestions<T extends { fieldId: string; showIf?: FormShowIf | null }>(
  questions: readonly T[],
  values: Readonly<Record<string, unknown>>,
): T[] {
  const visible = new Set<string>();
  return questions.filter((question) => {
    const condition = question.showIf;
    if (condition) {
      const value = values[condition.fieldId];
      if (
        condition.equals === '' ||
        !visible.has(condition.fieldId) ||
        value == null ||
        (typeof value === 'string' && value.trim() === '') ||
        !(Array.isArray(value) ? value.includes(condition.equals) : value === condition.equals)
      )
        return false;
    }
    visible.add(question.fieldId);
    return true;
  });
}

export const FormQuestion = z.object({
  fieldId: FieldId,
  showIf: FormShowIf.nullable().optional(),
  required: z.boolean().default(false),
  /** Asked instead of the field's name; empty asks with the name */
  label: z.string().max(LIMITS.nameLength).default(''),
  help: z.string().max(LIMITS.descriptionLength).default(''),
});
export type FormQuestion = z.infer<typeof FormQuestion>;

/** Form: a page for adding records, one question per field it asks about. */
export const FormSettings = z.object({
  title: z.string().max(LIMITS.nameLength).default(''),
  description: z.string().max(LIMITS.descriptionLength).default(''),
  questions: z.array(FormQuestion).max(LIMITS.fieldsPerTable).default([]),
  /** Empty uses the standard label */
  submitLabel: z.string().max(60).default(''),
  /** Shown after submitting; empty uses the standard message */
  thankYou: z.string().max(LIMITS.descriptionLength).default(''),
  /** Offers a fresh form after submitting */
  allowAnother: z.boolean().default(true),
  allowEdits: z.boolean().default(false),
  /** Edit links always expire, even when the form stays shared. */
  editLinkDays: z.number().int().min(1).max(365).default(30),
  editConfirmationEmail: z.boolean().default(false),
  /** The theme its public page shows in, over the database's own.  Absent or null uses the database's. */
  theme: ThemePick.nullable().optional(),
});
export type FormSettings = z.infer<typeof FormSettings>;

/**
 * How a view shows its table.  Every part is shared by everyone who opens the view, and every
 * change is saved as it happens.  The filter, sorts, field order, and hidden fields apply to every
 * type of view; each other type keeps its own settings, so switching types loses nothing.
 */
export const GridGroup = Sort.extend({
  dateGranularity: z.enum(['day', 'week', 'month', 'year']).optional(),
});
export type GridGroup = z.infer<typeof GridGroup>;

export const COLUMN_GROUP_LIMIT = 50;
export const PINNED_RECORD_LIMIT = 20;
export const ColumnGroup = z.object({
  id: z.string().min(1).max(32),
  name: Name,
  fieldIds: z.array(FieldId).min(1).max(LIMITS.fieldsPerTable),
  collapsed: z.boolean().default(false),
  color: ChoiceColor.optional(),
});
export type ColumnGroup = z.infer<typeof ColumnGroup>;

export const GridConfig = z.object({
  pinnedRecordIds: z
    .array(RecordId)
    .max(PINNED_RECORD_LIMIT)
    .refine((ids) => new Set(ids).size === ids.length)
    .default([]),
  columnGroups: z
    .array(ColumnGroup)
    .max(COLUMN_GROUP_LIMIT)
    .refine(
      (groups) =>
        new Set(groups.map((group) => group.id)).size === groups.length &&
        new Set(groups.flatMap((group) => group.fieldIds)).size ===
          groups.flatMap((group) => group.fieldIds).length,
    )
    .default([]),
  headerColors: z.record(FieldId, ChoiceColor).default({}),
  groups: z.array(GridGroup).max(3).default([]),
  locked: z.boolean().default(false),
  filter: FilterGroup.nullable().default(null),
  sorts: z.array(Sort).max(LIMITS.sortsPerView).default([]),
  /** Display order.  Fields missing from the list follow in the table's own order. */
  fieldOrder: z.array(FieldId).max(LIMITS.fieldsPerTable).default([]),
  hiddenFieldIds: z.array(FieldId).max(LIMITS.fieldsPerTable).default([]),
  columnWidths: z.record(FieldId, z.number().int().min(COLUMN_WIDTH.min).max(COLUMN_WIDTH.max)).default({}),
  /** What each column's footer in the summary row shows.  Fields left out show none. */
  summaries: z.record(FieldId, SummaryKind).default({}),
  /** Columns that stay put when scrolling sideways, counting the primary field */
  frozenFieldCount: z.number().int().min(1).max(10).default(1),
  rowHeight: RowHeight.default('short'),
  /** Conditional colors: rules for cells and records, color scales, and data bars */
  ...ColorConfig.shape,
  kanban: KanbanSettings.prefault({}),
  gallery: GallerySettings.prefault({}),
  calendar: CalendarSettings.prefault({}),
  form: FormSettings.prefault({}),
  timeline: TimelineSettings.prefault({}),
  gantt: GanttSettings.prefault({}),
  chart: ChartSettings.prefault({}),
  pivot: PivotSettings.prefault({}),
  list: ListSettings.prefault({}),
  map: MapSettings.prefault({}),
  orgChart: OrgChartSettings.prefault({}),
});
export type GridConfig = z.infer<typeof GridConfig>;
/** Every view type's configuration; the grid's name is kept for the code that came first. */
export const ViewConfig = GridConfig;
export type ViewConfig = GridConfig;

/** A partial change to a grid's configuration.  Each key given replaces that key entirely. */
export const GridConfigPatch = GridConfig.partial();
export type GridConfigPatch = z.infer<typeof GridConfigPatch>;

export const ViewMeta = z.object({
  id: ViewId,
  tableId: TableId,
  name: Name,
  type: ViewType,
  config: GridConfig,
  position: z.number(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ViewMeta = z.infer<typeof ViewMeta>;

/**
 * The fields a grid shows, in order: the view's saved order first, then any fields it doesn't
 * list yet in the table's order, without hidden ones.  The primary field always comes first and
 * can't be hidden.
 */
export function visibleFieldIds(
  config: GridConfig,
  fields: ReadonlyArray<{ id: string; position: number }>,
  primaryFieldId: string,
): string[] {
  const known = new Set(fields.map((f) => f.id));
  const listed = config.fieldOrder.filter((id) => known.has(id));
  const listedSet = new Set(listed);
  const rest = [...fields]
    .filter((f) => !listedSet.has(f.id))
    .sort((a, b) => a.position - b.position)
    .map((f) => f.id);
  const hidden = new Set(config.hiddenFieldIds);
  const ordered = [...listed, ...rest].filter((id) => id !== primaryFieldId && !hidden.has(id));
  const grouped: string[] = [];
  const used = new Set<string>();
  for (const id of ordered) {
    if (used.has(id)) continue;
    const group = config.columnGroups?.find((item) => item.fieldIds.includes(id));
    const members = group ? ordered.filter((item) => group.fieldIds.includes(item)) : [id];
    members.forEach((item) => used.add(item));
    grouped.push(...members);
  }
  return known.has(primaryFieldId) ? [primaryFieldId, ...grouped] : grouped;
}

/** Grid arrangement writes omit every setting that the caller did not change. */
export const GridArrangementPatch = z.object({
  sparklines: GridConfig.shape.sparklines.removeDefault().optional(),
  iconSets: GridConfig.shape.iconSets.removeDefault().optional(),
  pinnedRecordIds: GridConfig.shape.pinnedRecordIds.removeDefault().optional(),
  columnGroups: GridConfig.shape.columnGroups.removeDefault().optional(),
  headerColors: GridConfig.shape.headerColors.removeDefault().optional(),
  fieldOrder: GridConfig.shape.fieldOrder.removeDefault().optional(),
  frozenFieldCount: GridConfig.shape.frozenFieldCount.removeDefault().optional(),
});
export type GridArrangementPatch = z.infer<typeof GridArrangementPatch>;
