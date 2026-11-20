import { describe, expect, it } from 'vitest';
import { AppConfig } from '../app-config.js';
import { FieldMeta } from './fields.js';
import {
  GridConfig,
  GridConfigPatch,
  LIST_FIELD_COUNT,
  ListSettings,
  MapSettings,
  OrgChartSettings,
  VIEW_TYPES,
  ViewType,
  isParentField,
} from './views.js';

const tableId = 'tbl00000000000001';
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

describe('list and map view types', () => {
  it('are view types', () => {
    expect(VIEW_TYPES).toContain('list');
    expect(VIEW_TYPES).toContain('map');
    expect(ViewType.parse('map')).toBe('map');
  });

  it('give every view both settings with defaults, so switching types loses nothing', () => {
    const config = GridConfig.parse({});
    expect(config.list).toEqual({
      groupFieldId: null,
      parentFieldId: null,
      visibleFieldCount: LIST_FIELD_COUNT.default,
    });
    expect(config.map).toEqual({ locationFieldId: null, colorFieldId: null });
    const kept = GridConfig.parse({ map: { locationFieldId: fieldId } });
    expect(kept.map).toEqual({ locationFieldId: fieldId, colorFieldId: null });
    expect(kept.list.visibleFieldCount).toBe(LIST_FIELD_COUNT.default);
  });

  it('keep a list row to the primary field and at most four more', () => {
    for (let count = LIST_FIELD_COUNT.min; count <= LIST_FIELD_COUNT.max; count++)
      expect(ListSettings.parse({ visibleFieldCount: count }).visibleFieldCount).toBe(count);
    expect(LIST_FIELD_COUNT.max).toBe(4);
    expect(ListSettings.safeParse({ visibleFieldCount: 5 }).success).toBe(false);
    expect(ListSettings.safeParse({ visibleFieldCount: -1 }).success).toBe(false);
    expect(ListSettings.safeParse({ visibleFieldCount: 1.5 }).success).toBe(false);
  });

  it('reject malformed field IDs, and keep no camera with a map', () => {
    expect(ListSettings.safeParse({ groupFieldId: 'fld1' }).success).toBe(false);
    expect(ListSettings.safeParse({ parentFieldId: 'rec00000000000001' }).success).toBe(false);
    expect(MapSettings.safeParse({ locationFieldId: 'not a field' }).success).toBe(false);
    expect(MapSettings.parse({ colorFieldId: fieldId, zoom: 4, center: [0, 0] })).toEqual({
      locationFieldId: null,
      colorFieldId: fieldId,
    });
  });

  it('fill a patched type’s missing settings with defaults, since a patch replaces each key whole', () => {
    const patch = GridConfigPatch.parse({ list: { parentFieldId: fieldId } });
    expect(patch.list).toEqual({
      groupFieldId: null,
      parentFieldId: fieldId,
      visibleFieldCount: LIST_FIELD_COUNT.default,
    });
    expect(GridConfigPatch.parse({ map: {} }).map).toEqual({ locationFieldId: null, colorFieldId: null });
  });

  it('nest a list only under links to the same table', () => {
    expect(isParentField(field('link', { linkedTableId: tableId }))).toBe(true);
    expect(isParentField(field('link', { linkedTableId: 'tbl00000000000002' }))).toBe(false);
    expect(isParentField(field('singleSelect'))).toBe(false);
  });
});

describe('the web app’s run-time settings', () => {
  it('carry a map style address, or none when maps are off', () => {
    expect(AppConfig.parse({ map: { styleUrl: 'https://tiles.example.test/style.json' } })).toEqual({
      map: { styleUrl: 'https://tiles.example.test/style.json' },
    });
    expect(AppConfig.parse({ map: { styleUrl: null } }).map.styleUrl).toBeNull();
    expect(AppConfig.safeParse({}).success).toBe(false);
  });
});

it('keeps org chart settings through view type changes and validates parent IDs', () => {
  expect(ViewType.parse('orgChart')).toBe('orgChart');
  expect(GridConfig.parse({}).orgChart).toEqual({ parentFieldId: null });
  const config = GridConfig.parse({ orgChart: { parentFieldId: fieldId } });
  expect(GridConfig.parse({ ...config, map: {} }).orgChart.parentFieldId).toBe(fieldId);
  expect(OrgChartSettings.safeParse({ parentFieldId: 'invalid' }).success).toBe(false);
});
