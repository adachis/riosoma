import type { MessageDescriptor } from '@lingui/core';
import {
  GANTT_LABEL_WIDTH,
  ChartSettings,
  PivotSettings,
  isComputedType,
  isDependencyField,
  type FieldMeta,
  type GridConfigPatch,
  type TableMeta,
  type ViewType,
} from '@riosoma/contracts';
import type { IconDefinition } from '@riosoma/icons';
import type { ComponentType, LazyExoticComponent } from 'react';
import { lazyFeature } from '../../../shell/lazy';
import { firstGroup } from './summary/fields';
import { timelineDates } from './timeline/defaults';
import { VIEW_KINDS } from './kinds';
import type { ViewComponentProps } from './types';

type Lazy = LazyExoticComponent<ComponentType<ViewComponentProps>> & { preload(): void };

export interface ViewDefinition {
  type: ViewType;
  icon: IconDefinition;
  name: MessageDescriptor;
  /** The view itself.  The grid has none here: the screen draws it directly. */
  View?: Lazy;
  /** Controls for the view's own settings, shown after the filter, sort, and hide-fields controls */
  Settings?: Lazy;
  /** Whether the shared filter, sort, and hide-fields controls apply */
  usesToolbar: boolean;
  /** Whether the view draws conditional colors, so the toolbar offers them */
  usesColors?: boolean;
  /**
   * Whether its settings bar holds ways to read the view, not only settings, so a page shared by
   * link shows the bar, where nothing can be changed
   */
  readingTools?: boolean;
  /** Configuration for a brand-new view of this type */
  initialConfig(table: TableMeta, fields: readonly FieldMeta[]): GridConfigPatch;
}

/** Cards show the primary field and the next three; the rest start hidden. */
function cardFields(table: TableMeta, fields: readonly FieldMeta[]): GridConfigPatch {
  const others = fields.filter((field) => field.id !== table.primaryFieldId);
  return { hiddenFieldIds: others.slice(3).map((field) => field.id) };
}

export const VIEW_DEFINITIONS: Record<ViewType, ViewDefinition> = {
  grid: {
    type: 'grid',
    ...VIEW_KINDS.grid,
    usesToolbar: true,
    usesColors: true,
    initialConfig: () => ({}),
  },
  kanban: {
    type: 'kanban',
    ...VIEW_KINDS.kanban,
    View: lazyFeature(() => import('./kanban').then((module) => ({ default: module.KanbanView }))),
    Settings: lazyFeature(() => import('./kanban').then((module) => ({ default: module.KanbanSettings }))),
    usesToolbar: true,
    usesColors: true,
    initialConfig: (table, fields) => {
      const stack = fields.find(
        (field) => field.type === 'singleSelect' || (field.type === 'user' && !field.options.allowMultiple),
      );
      return {
        ...cardFields(table, fields),
        kanban: {
          stackFieldId: stack?.id ?? null,
          stackOrder: [],
          hiddenStacks: [],
          hideEmptyStacks: false,
          coverFieldId: fields.find((field) => field.type === 'attachment')?.id ?? null,
          coverFit: 'crop',
        },
      };
    },
  },
  gallery: {
    type: 'gallery',
    ...VIEW_KINDS.gallery,
    View: lazyFeature(() => import('./gallery').then((module) => ({ default: module.GalleryView }))),
    Settings: lazyFeature(() => import('./gallery').then((module) => ({ default: module.GallerySettings }))),
    usesToolbar: true,
    usesColors: true,
    initialConfig: (table, fields) => ({
      ...cardFields(table, fields),
      gallery: {
        coverFieldId: fields.find((field) => field.type === 'attachment')?.id ?? null,
        coverFit: 'crop',
        cardSize: 'medium',
      },
    }),
  },
  calendar: {
    type: 'calendar',
    ...VIEW_KINDS.calendar,
    View: lazyFeature(() => import('./calendar').then((module) => ({ default: module.CalendarView }))),
    Settings: lazyFeature(() =>
      import('./calendar').then((module) => ({ default: module.CalendarSettings })),
    ),
    usesToolbar: true,
    initialConfig: (_table, fields) => ({
      calendar: {
        startFieldId:
          fields.find((field) => field.type === 'date')?.id ??
          fields.find((field) => field.type === 'createdTime')?.id ??
          null,
        endFieldId: null,
        range: 'month',
      },
    }),
  },
  timeline: {
    type: 'timeline',
    readingTools: true,
    ...VIEW_KINDS.timeline,
    View: lazyFeature(() => import('./timeline').then((module) => ({ default: module.TimelineView }))),
    Settings: lazyFeature(() =>
      import('./timeline').then((module) => ({ default: module.TimelineSettings })),
    ),
    usesToolbar: true,
    initialConfig: (table, fields) => ({
      ...cardFields(table, fields),
      timeline: { ...timelineDates(fields), groupFieldId: null, labelFieldId: null, zoom: 'week' },
    }),
  },
  gantt: {
    type: 'gantt',
    readingTools: true,
    ...VIEW_KINDS.gantt,
    View: lazyFeature(() => import('./gantt').then((module) => ({ default: module.GanttView }))),
    Settings: lazyFeature(() => import('./gantt').then((module) => ({ default: module.GanttSettings }))),
    usesToolbar: true,
    initialConfig: (table, fields) => ({
      ...cardFields(table, fields),
      gantt: {
        ...timelineDates(fields),
        dependencyFieldId: fields.find(isDependencyField)?.id ?? null,
        progressFieldId: fields.find((field) => field.type === 'percent')?.id ?? null,
        labelFieldId: null,
        labelWidth: GANTT_LABEL_WIDTH.default,
        zoom: 'week',
      },
    }),
  },
  form: {
    type: 'form',
    ...VIEW_KINDS.form,
    View: lazyFeature(() => import('./form').then((module) => ({ default: module.FormView }))),
    Settings: lazyFeature(() => import('./form').then((module) => ({ default: module.FormSettings }))),
    usesToolbar: false,
    initialConfig: (table, fields) => ({
      form: {
        title: table.name,
        description: '',
        questions: fields
          .filter((field) => !isComputedType(field.type) && field.type !== 'autoNumber')
          .map((field) => ({ fieldId: field.id, required: false, label: '', help: '' })),
        submitLabel: '',
        thankYou: '',
        allowAnother: true,
        allowEdits: false,
        editLinkDays: 30,
        editConfirmationEmail: false,
      },
    }),
  },
  chart: {
    type: 'chart',
    ...VIEW_KINDS.chart,
    View: lazyFeature(() => import('./chart').then((module) => ({ default: module.ChartView }))),
    Settings: lazyFeature(() => import('./chart').then((module) => ({ default: module.ChartSettings }))),
    // Its settings bar has its own filter.  Sorting and hiding fields change nothing in a chart.
    usesToolbar: false,
    initialConfig: (_table, fields) => ({ chart: ChartSettings.parse({ groupBy: firstGroup(fields) }) }),
  },
  pivot: {
    type: 'pivot',
    ...VIEW_KINDS.pivot,
    View: lazyFeature(() => import('./pivot').then((module) => ({ default: module.PivotView }))),
    Settings: lazyFeature(() => import('./pivot').then((module) => ({ default: module.PivotSettings }))),
    usesToolbar: false,
    initialConfig: (_table, fields) => {
      const group = firstGroup(fields);
      return { pivot: PivotSettings.parse({ rows: group ? [group] : [] }) };
    },
  },
  orgChart: {
    type: 'orgChart',
    ...VIEW_KINDS.orgChart,
    View: lazyFeature(() =>
      import('./org-chart/OrgChartView').then((module) => ({ default: module.OrgChartView })),
    ),
    Settings: lazyFeature(() =>
      import('./org-chart/OrgChartSettings').then((module) => ({ default: module.OrgChartSettings })),
    ),
    usesToolbar: true,
    initialConfig: (table, fields) => ({
      ...cardFields(table, fields),
      orgChart: { parentFieldId: fields.find(isDependencyField)?.id ?? null },
    }),
  },
  list: {
    type: 'list',
    ...VIEW_KINDS.list,
    View: lazyFeature(() => import('./list').then((module) => ({ default: module.ListView }))),
    Settings: lazyFeature(() => import('./list').then((module) => ({ default: module.ListSettings }))),
    usesToolbar: true,
    usesColors: true,
    initialConfig: () => ({}),
  },
  map: {
    type: 'map',
    ...VIEW_KINDS.map,
    View: lazyFeature(() => import('./map').then((module) => ({ default: module.MapView }))),
    Settings: lazyFeature(() => import('./map').then((module) => ({ default: module.MapSettings }))),
    usesToolbar: true,
    usesColors: true,
    // Its settings bar holds ways to read the map, so a page shared by link shows it too.
    readingTools: true,
    // A new map puts its pins at the table's first location field.
    initialConfig: (_table, fields) => ({
      map: {
        locationFieldId: fields.find((field) => field.type === 'location')?.id ?? null,
        colorFieldId: null,
      },
    }),
  },
};
