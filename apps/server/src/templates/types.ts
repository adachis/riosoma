import type {
  Aggregate,
  ChartSort,
  ChartType,
  ChoiceColor,
  DateBucket,
  DateRange,
  DateTarget,
  FieldSpec,
  GridConfig,
  Operator,
  RollupFunction,
  SummaryKind,
  TemplateCategory,
  TilePlace,
  TimelineZoom,
  ViewType,
} from '@riosoma/contracts';
import type { z } from 'zod';

/**
 * Starter templates name everything by key: tables, fields, records, and views, with choices by
 * name.  `instantiate` turns the keys into IDs as it creates each part through the command bus.
 */

type PlainSpec = Exclude<
  z.input<typeof FieldSpec>,
  { type: 'link' | 'lookup' | 'rollup' | 'count' | 'singleSelect' | 'multipleSelect' | 'attachment' }
>;
type RelationSpec =
  | {
      type: 'link';
      options: { linkedTableKey: string; inverseFieldKey: string; prefersSingle?: boolean };
      inverse?: boolean;
    }
  | {
      type: 'lookup' | 'rollup';
      options: { linkFieldKey: string; targetFieldKey: string; fn?: RollupFunction };
    }
  | { type: 'count'; options: { linkFieldKey: string } }
  | {
      type: 'singleSelect' | 'multipleSelect';
      options: { choices: Array<{ name: string; color: ChoiceColor }> };
    };
/** A button's link names other fields of its table in braces, like `{Website}`. */
export type TemplateField = { key: string; name: string; description?: string } & (PlainSpec | RelationSpec);

/** A day counted from the day the database is created, with an optional time of day in UTC. */
export interface RelativeDay {
  days: number;
  time?: string;
}
export type SampleValue =
  | string
  | number
  | boolean
  | null
  | string[]
  | RelativeDay
  | { start: RelativeDay; end: RelativeDay }
  | { lat: number; lng: number; label: string | null };
export interface TemplateRecord {
  key: string;
  values: Record<string, SampleValue>;
}

/** A filter condition by field key.  Select fields take choice names, which become choice IDs. */
export interface TemplateCondition {
  field: string;
  operator: Operator;
  value?: string | number | boolean | string[] | DateTarget | DateRange;
}
export interface TemplateFilter {
  conjunction: 'and' | 'or';
  conditions: TemplateCondition[];
}
export interface TemplateGroup {
  field: string;
  dateBucket?: DateBucket;
}
/** How many records, or a function of one field's values */
export interface TemplateValue {
  fn: Aggregate;
  field?: string;
}
export interface TemplateChart {
  type?: ChartType;
  groupBy: TemplateGroup;
  value?: TemplateValue;
  seriesField?: string;
  sort?: ChartSort;
  stacked?: boolean;
}
export interface TemplatePivot {
  rows: TemplateGroup[];
  column?: TemplateGroup;
  values?: TemplateValue[];
}

export interface TemplateView {
  key: string;
  name: string;
  type: ViewType;
  fieldOrder?: string[];
  hiddenFields?: string[];
  filter?: TemplateFilter;
  sorts?: Array<{ field: string; direction: 'asc' | 'desc' }>;
  /** What a grid's summary row shows under each field */
  summaries?: Record<string, SummaryKind>;
  /** Kanban stacks */
  stackField?: string;
  /** Calendar, timeline, and Gantt dates */
  startField?: string;
  endField?: string;
  /** Timeline lanes, or list groups */
  groupField?: string;
  /** A list's outline, by a link to the same table */
  parentField?: string;
  /** Gantt arrows, by a link to the same table, and bar progress */
  dependencyField?: string;
  progressField?: string;
  zoom?: TimelineZoom;
  /** Map pins, and the single select that colors them */
  locationField?: string;
  colorField?: string;
  chart?: TemplateChart;
  pivot?: TemplatePivot;
  /** A form's questions, asked with the field's name unless a label is given */
  questions?: Array<{ field: string; required?: boolean; label?: string; help?: string }>;
  form?: Pick<Partial<GridConfig['form']>, 'title' | 'description' | 'submitLabel' | 'thankYou'>;
}
export interface TemplateTable {
  key: string;
  name: string;
  fields: TemplateField[];
  views: TemplateView[];
  records: TemplateRecord[];
}

interface TileBase {
  key: string;
  title: string;
  place: TilePlace;
}
interface SourceTile extends TileBase {
  table: string;
  /** Narrows the tile to a view's records */
  view?: string;
}
export type TemplateTile =
  | (SourceTile & { kind: 'number'; value: TemplateValue })
  | (SourceTile & { kind: 'chart'; chart: TemplateChart; limit?: number })
  | (SourceTile & { kind: 'records'; fields: string[]; limit?: number })
  | (TileBase & { kind: 'text'; text: string });
export interface TemplateDashboard {
  key: string;
  name: string;
  tiles: TemplateTile[];
}

export type TemplateTrigger =
  | { kind: 'recordCreated'; table: string }
  | { kind: 'recordUpdated'; table: string; fields?: string[] }
  | { kind: 'recordMatches'; table: string; view?: string; filter?: TemplateFilter }
  | { kind: 'formSubmitted'; table: string; view: string };
/** Changes the trigger's record.  Values may hold `{{now}}` and `{{trigger.record.<field key>}}`. */
export interface TemplateStep {
  key: string;
  name?: string;
  kind: 'updateRecord';
  values: Record<string, string>;
}
export interface TemplateAutomation {
  key: string;
  name: string;
  trigger: TemplateTrigger;
  conditions?: TemplateFilter;
  steps: TemplateStep[];
}

export interface StarterTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: ChoiceColor;
  category: TemplateCategory;
  tables: TemplateTable[];
  dashboards?: TemplateDashboard[];
  /** Created turned off, so nothing runs until someone turns one on */
  automations?: TemplateAutomation[];
}

export const choices = (...names: string[]): { choices: Array<{ name: string; color: ChoiceColor }> } => ({
  choices: names.map((name, index) => ({
    name,
    color: (['gray', 'blue', 'green', 'orange', 'purple'] as const)[index % 5]!,
  })),
});
/** Choices whose colors carry meaning, such as red for the most urgent. */
export const colored = (
  ...pairs: Array<[string, ChoiceColor]>
): { choices: Array<{ name: string; color: ChoiceColor }> } => ({
  choices: pairs.map(([name, color]) => ({ name, color })),
});
export const grid = { key: 'grid', name: 'All records', type: 'grid' } as const;

/** The item for sample record `index`, going around the list as often as needed. */
export function cycle<T>(list: readonly T[], index: number): T {
  return list[index % list.length]!;
}
