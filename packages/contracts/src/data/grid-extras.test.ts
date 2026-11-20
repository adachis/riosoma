import { expect, it } from 'vitest';
import { newId } from '../ids.js';
import { GridConfig, GridConfigPatch, visibleFieldIds } from './views.js';

it('limits pins to twenty unique records and accepts only palette header colors', () => {
  const ids = Array.from({ length: 21 }, () => newId('record'));
  expect(GridConfig.safeParse({ pinnedRecordIds: ids }).success).toBe(false);
  expect(GridConfig.safeParse({ pinnedRecordIds: [ids[0], ids[0]] }).success).toBe(false);
  expect(GridConfig.parse({ pinnedRecordIds: ids.slice(0, 20) }).pinnedRecordIds).toHaveLength(20);
  expect(GridConfigPatch.parse({ headerColors: {} }).headerColors).toEqual({});
  expect(GridConfig.safeParse({ headerColors: { [newId('field')]: '#ffffff' } }).success).toBe(false);
});

it('keeps groups contiguous, collapses to a visible member, and preserves the primary field', () => {
  const fields = Array.from({ length: 4 }, (_, position) => ({ id: newId('field'), position }));
  const [primary, first, middle, last] = fields.map((field) => field.id) as [string, string, string, string];
  const config = GridConfig.parse({
    columnGroups: [{ id: 'details', name: 'Details', fieldIds: [first, last] }],
  });
  expect(visibleFieldIds(config, fields, primary)).toEqual([primary, first, last, middle]);
  config.columnGroups[0]!.collapsed = true;
  expect(visibleFieldIds(config, fields, primary)).toEqual([primary, first, last, middle]);
  config.hiddenFieldIds = [first];
  expect(visibleFieldIds(config, fields, primary)).toEqual([primary, middle, last]);
  expect(
    GridConfig.safeParse({
      columnGroups: [
        { id: 'one', name: 'One', fieldIds: [first] },
        { id: 'two', name: 'Two', fieldIds: [first] },
      ],
    }).success,
  ).toBe(false);
});
