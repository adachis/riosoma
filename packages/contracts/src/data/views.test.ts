import { describe, expect, it } from 'vitest';
import { FieldMeta } from './fields.js';
import {
  GANTT_LABEL_WIDTH,
  GanttSettings,
  GridConfig,
  GridConfigPatch,
  TIMELINE_ZOOMS,
  TimelineSettings,
  VIEW_TYPES,
  ViewType,
  isDependencyField,
  isProgressField,
  isTimelineGroupField,
} from './views.js';

const tableId = 'tbl00000000000001';
const otherTableId = 'tbl00000000000002';
const fieldId = 'fld00000000000001';

function field(type: string, options: Record<string, unknown> = {}) {
  return FieldMeta.parse({
    id: fieldId,
    tableId,
    name: 'Field',
    description: '',
    position: 0,
    createdAt: '2026-09-27T00:00:00.000Z',
    updatedAt: '2026-09-27T00:00:00.000Z',
    type,
    options,
  });
}

describe('timeline and Gantt view types', () => {
  it('are view types', () => {
    expect(VIEW_TYPES).toContain('timeline');
    expect(VIEW_TYPES).toContain('gantt');
    expect(ViewType.parse('gantt')).toBe('gantt');
  });

  it('give every view both settings with defaults, so switching types loses nothing', () => {
    const config = GridConfig.parse({});
    expect(config.timeline).toEqual({
      startFieldId: null,
      endFieldId: null,
      groupFieldId: null,
      labelFieldId: null,
      zoom: 'week',
    });
    expect(config.gantt).toEqual({
      startFieldId: null,
      endFieldId: null,
      dependencyFieldId: null,
      progressFieldId: null,
      labelFieldId: null,
      labelWidth: GANTT_LABEL_WIDTH.default,
      zoom: 'week',
    });
    const kept = GridConfig.parse({ timeline: { startFieldId: fieldId, zoom: 'quarter' } });
    expect(kept.timeline).toMatchObject({ startFieldId: fieldId, endFieldId: null, zoom: 'quarter' });
    expect(kept.gantt.zoom).toBe('week');
  });

  it('accept every zoom and reject others', () => {
    for (const zoom of TIMELINE_ZOOMS) {
      expect(TimelineSettings.parse({ zoom }).zoom).toBe(zoom);
      expect(GanttSettings.parse({ zoom }).zoom).toBe(zoom);
    }
    expect(TimelineSettings.safeParse({ zoom: 'hour' }).success).toBe(false);
    expect(GanttSettings.safeParse({ zoom: 'decade' }).success).toBe(false);
  });

  it('reject malformed field IDs and label widths outside the column limits', () => {
    expect(TimelineSettings.safeParse({ startFieldId: 'not a field' }).success).toBe(false);
    expect(TimelineSettings.safeParse({ groupFieldId: 'fld1' }).success).toBe(false);
    expect(GanttSettings.safeParse({ dependencyFieldId: 'rec00000000000001' }).success).toBe(false);
    expect(GanttSettings.safeParse({ labelWidth: GANTT_LABEL_WIDTH.min - 1 }).success).toBe(false);
    expect(GanttSettings.safeParse({ labelWidth: GANTT_LABEL_WIDTH.max + 1 }).success).toBe(false);
    expect(GanttSettings.safeParse({ labelWidth: 200.5 }).success).toBe(false);
    expect(GanttSettings.parse({ labelWidth: GANTT_LABEL_WIDTH.max }).labelWidth).toBe(GANTT_LABEL_WIDTH.max);
  });

  it('fill a patched type’s missing settings with defaults, since a patch replaces each key whole', () => {
    const patch = GridConfigPatch.parse({ gantt: { progressFieldId: fieldId } });
    expect(patch.gantt).toMatchObject({ progressFieldId: fieldId, startFieldId: null, zoom: 'week' });
    expect(GridConfigPatch.safeParse({ timeline: { zoom: 'fortnight' } }).success).toBe(false);
  });
});

describe('timeline and Gantt fields', () => {
  it('group lanes by single selects, people, and links', () => {
    expect(isTimelineGroupField(field('singleSelect'))).toBe(true);
    expect(isTimelineGroupField(field('user', { allowMultiple: true }))).toBe(true);
    expect(isTimelineGroupField(field('link', { linkedTableId: otherTableId }))).toBe(true);
    expect(isTimelineGroupField(field('multipleSelect'))).toBe(false);
    expect(isTimelineGroupField(field('text'))).toBe(false);
  });

  it('read dependencies only from links to the same table', () => {
    expect(isDependencyField(field('link', { linkedTableId: tableId }))).toBe(true);
    expect(isDependencyField(field('link', { linkedTableId: otherTableId }))).toBe(false);
    expect(isDependencyField(field('singleSelect'))).toBe(false);
  });

  it('read progress from percents and numbers', () => {
    expect(isProgressField(field('percent'))).toBe(true);
    expect(isProgressField(field('number'))).toBe(true);
    expect(isProgressField(field('currency'))).toBe(false);
    expect(isProgressField(field('rating'))).toBe(false);
  });
});

describe('grid groups', () => {
  it('keeps grouping optional for old configurations and caps new configurations at three levels', () => {
    expect(GridConfig.parse({}).groups).toEqual([]);
    const groups = [{ fieldId, direction: 'asc', dateGranularity: 'week' }];
    expect(GridConfigPatch.parse({ groups }).groups).toEqual(groups);
    expect(GridConfig.safeParse({ groups: Array(4).fill(groups[0]) }).success).toBe(false);
    expect(GridConfig.safeParse({ groups: [{ ...groups[0], dateGranularity: 'hour' }] }).success).toBe(false);
  });
});
