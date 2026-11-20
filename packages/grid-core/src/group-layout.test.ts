import { expect, it } from 'vitest';
import { GroupLayout } from './group-layout.js';

const groups = [
  { key: 'a', level: 1, start: 0, count: 100000 },
  { key: 'a1', level: 2, start: 0, count: 50000 },
  { key: 'a2', level: 2, start: 50000, count: 50000 },
  { key: 'b', level: 1, start: 100000, count: 1 },
];
it('maps large groups without allocating a coordinate for each record', () => {
  const layout = new GroupLayout(groups, 100001, new Set());
  expect(layout.count).toBe(100005);
  expect(layout.segments).toHaveLength(3);
  expect(layout.recordAt(2)).toBe(0);
  expect(layout.rowAt(99999)).toBe(100002);
  expect(layout.sticky(75000).map((line) => line.group.key)).toEqual(['a', 'a2']);
  expect(layout.recordRanges(100002, 100005)).toEqual([
    { start: 99999, end: 100000 },
    { start: 100000, end: 100001 },
  ]);
});
it('hides descendants and maps later records after a collapsed parent', () => {
  const layout = new GroupLayout(groups, 100001, new Set(['a']));
  expect(layout.count).toBe(3);
  expect(layout.rowAt(50)).toBeNull();
  expect(layout.recordAt(2)).toBe(100000);
  expect(layout.lines.map((line) => line.group.key)).toEqual(['a', 'b']);
  expect(layout.recordRanges(0, 3)).toEqual([{ start: 100000, end: 100001 }]);
});
