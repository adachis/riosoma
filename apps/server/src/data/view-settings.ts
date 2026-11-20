import {
  AppError,
  checkCellValue,
  FORM_CONDITION_TYPES,
  isComputedType,
  isDependencyField,
  isParentField,
  isProgressField,
  isTimelineGroupField,
  type GridConfig,
} from '@riosoma/contracts';
import type { StoredField } from './types.js';
import { validateColorSettings } from './color-settings.js';

export function badViewSetting(setting: string): never {
  throw new AppError('validation_failed', 'data.view.badSetting', { params: { setting } });
}

export function isStackField(field: StoredField): boolean {
  return field.type === 'singleSelect' || (field.type === 'user' && !field.options.allowMultiple);
}

export function isCalendarField(field: StoredField): boolean {
  return (
    field.type === 'date' ||
    field.type === 'createdTime' ||
    field.type === 'lastModifiedTime' ||
    (field.type === 'formula' && ['date', 'datetime'].includes(field.options.resultType))
  );
}

/** The error for a date formula only JavaScript can compute, where a view needs the database's dates. */
export function formulaDates(setting: string): never {
  throw new AppError('validation_failed', 'data.view.formulaDates', { params: { setting } });
}

/**
 * Refuses a date formula that only JavaScript can compute as the dates of a calendar, timeline, or
 * Gantt view, since the database picks their records by date.  Only the view's own kind of
 * setting is checked, and only when it changes, so a formula that changed after the view chose it
 * never blocks the view's other settings.
 */
function databaseDates(
  config: GridConfig,
  previous: GridConfig | undefined,
  fields: ReadonlyMap<string, StoredField>,
  type: string | undefined,
): void {
  for (const view of ['calendar', 'timeline', 'gantt'] as const) {
    if (type !== view) continue;
    for (const end of ['startFieldId', 'endFieldId'] as const) {
      const id = config[view][end];
      if (id === null || id === previous?.[view][end]) continue;
      const field = fields.get(id);
      if (field?.type === 'formula' && !field.options.sortable) formulaDates(`${view}.${end}`);
    }
  }
}

export function validateViewSettings(
  config: GridConfig,
  fields: readonly StoredField[],
  knownIds: ReadonlySet<string>,
  view?: { type: string; previous?: GridConfig },
): void {
  const active = new Map(fields.map((field) => [field.id, field]));
  const check = (id: string | null, setting: string, accepts: (field: StoredField) => boolean) => {
    if (id === null) return;
    if (!knownIds.has(id)) badViewSetting(setting);
    const field = active.get(id);
    // Soft-deleted fields retain their settings so restoring them restores the view.
    if (field && !accepts(field)) badViewSetting(setting);
  };
  check(config.kanban.stackFieldId, 'kanban.stackFieldId', isStackField);
  check(config.kanban.coverFieldId, 'kanban.coverFieldId', (field) => field.type === 'attachment');
  check(config.gallery.coverFieldId, 'gallery.coverFieldId', (field) => field.type === 'attachment');
  check(config.calendar.startFieldId, 'calendar.startFieldId', isCalendarField);
  check(config.calendar.endFieldId, 'calendar.endFieldId', isCalendarField);
  const anyField = () => true;
  check(config.timeline.startFieldId, 'timeline.startFieldId', isCalendarField);
  check(config.timeline.endFieldId, 'timeline.endFieldId', isCalendarField);
  check(config.timeline.groupFieldId, 'timeline.groupFieldId', isTimelineGroupField);
  check(config.timeline.labelFieldId, 'timeline.labelFieldId', anyField);
  check(config.gantt.startFieldId, 'gantt.startFieldId', isCalendarField);
  check(config.gantt.endFieldId, 'gantt.endFieldId', isCalendarField);
  check(config.gantt.dependencyFieldId, 'gantt.dependencyFieldId', isDependencyField);
  check(config.gantt.progressFieldId, 'gantt.progressFieldId', isProgressField);
  check(config.gantt.labelFieldId, 'gantt.labelFieldId', anyField);
  databaseDates(config, view?.previous, active, view?.type);
  validateColorSettings(config, active, knownIds, view?.previous);
  const groups = new Set<string>();
  for (const group of config.groups) {
    if (groups.has(group.fieldId)) badViewSetting('groups');
    groups.add(group.fieldId);
    check(group.fieldId, 'groups', (field) => field.type !== 'button');
    const field = active.get(group.fieldId);
    if (
      group.dateGranularity &&
      field &&
      !isCalendarField(field) &&
      !(
        (field.type === 'lookup' || field.type === 'rollup') &&
        ['date', 'datetime'].includes(field.options.resultType)
      )
    )
      badViewSetting('groups.dateGranularity');
  }
  const questions = new Set<string>();
  const previousQuestions = new Map(
    view?.previous?.form.questions.map((question) => [question.fieldId, question.showIf]),
  );
  for (const question of config.form.questions) {
    if (questions.has(question.fieldId)) badViewSetting('form.questions');
    if (question.showIf) {
      const { fieldId, equals } = question.showIf;
      if (!questions.has(fieldId)) badViewSetting('form.questions.showIf');
      const parent = active.get(fieldId);
      const previous = previousQuestions.get(question.fieldId);
      // A removed choice leaves its existing condition dormant until that choice is restored.
      if (parent && (previous?.fieldId !== fieldId || previous.equals !== equals)) {
        if (!(FORM_CONDITION_TYPES as readonly string[]).includes(parent.type))
          badViewSetting('form.questions.showIf');
        const checked = checkCellValue(
          parent,
          parent.type === 'multipleSelect' ? (equals === '' ? [] : [equals]) : equals,
        );
        if (!checked.ok) badViewSetting('form.questions.showIf');
      }
    }
    questions.add(question.fieldId);
    check(question.fieldId, 'form.questions', (field) => !isComputedType(field.type));
  }
  for (const question of config.form.questions) {
    const field = fields.find((field) => field.id === question.fieldId);
    if (field?.type !== 'singleSelect' && field?.type !== 'multipleSelect') continue;
    if (field.options.cascade && !questions.has(field.options.cascade.fieldId))
      throw new AppError('validation_failed', 'data.select.formParent');
  }
  // Charts and pivots check which fields they name here.  Whether a value fits its field shows in
  // the view's own answer, the way a dashboard tile's does.
  const any = () => true;
  const { chart, pivot } = config;
  check(chart.groupBy?.fieldId ?? null, 'chart.groupBy', isGroupField);
  check(chart.seriesBy, 'chart.seriesBy', isGroupField);
  check(chart.value.fieldId, 'chart.value', any);
  const rows = pivot.rows.map((group) => group.fieldId);
  if (new Set(rows).size !== rows.length) badViewSetting('pivot.rows');
  for (const id of rows) check(id, 'pivot.rows', isGroupField);
  if (pivot.column && rows.includes(pivot.column.fieldId)) badViewSetting('pivot.column');
  check(pivot.column?.fieldId ?? null, 'pivot.column', isGroupField);
  for (const value of pivot.values) check(value.fieldId, 'pivot.values', any);
  // A list groups the way a timeline makes lanes, or nests under parents, never both at once.
  check(config.list.groupFieldId, 'list.groupFieldId', isTimelineGroupField);
  check(config.list.parentFieldId, 'list.parentFieldId', isParentField);
  if (config.list.groupFieldId !== null && config.list.parentFieldId !== null)
    badViewSetting('list.parentFieldId');
  if (config.orgChart.parentFieldId !== view?.previous?.orgChart.parentFieldId)
    check(config.orgChart.parentFieldId, 'orgChart.parentFieldId', isParentField);
  check(config.map.locationFieldId, 'map.locationFieldId', (field) => field.type === 'location');
  check(config.map.colorFieldId, 'map.colorFieldId', (field) => field.type === 'singleSelect');
}

/** Fields whose values sort records into groups: every kind but files. */
export function isGroupField(field: StoredField): boolean {
  return field.type !== 'attachment';
}
