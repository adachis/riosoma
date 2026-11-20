import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { FilterGroup, isGroup, LIMITS, type FilterCondition } from '@riosoma/contracts';
import { flattenTree } from '@riosoma/ui';
import { duplicateFilter, filterTree, identifyFilter, moveFilter } from './filterTree';

const condition = (id: string): FilterCondition => ({
  id,
  fieldId: 'fld00000000000000',
  operator: 'isNotEmpty',
});
const group = (id: string, conditions: FilterGroup['conditions']): FilterGroup => ({
  id,
  conjunction: 'and',
  conditions,
});
const conditionIds = (value: FilterGroup) =>
  flattenTree(filterTree(value))
    .filter(({ node }) => !isGroup(node.data))
    .map(({ node }) => node.id)
    .sort();

function generated(depth: number): fc.Arbitrary<FilterGroup> {
  return fc.record({
    id: fc.uuid().map((id) => id.replaceAll('-', '')),
    conjunction: fc.constantFrom('and' as const, 'or' as const),
    conditions: fc.array(
      depth < LIMITS.filterDepth
        ? fc.oneof(
            fc.uuid().map((id) => condition(id.replaceAll('-', ''))),
            generated(depth + 1),
          )
        : fc.uuid().map((id) => condition(id.replaceAll('-', ''))),
      { minLength: 1, maxLength: 3 },
    ),
  });
}

describe('saved filter moves', () => {
  it('repairs repeated legacy IDs deterministically and keeps every condition movable', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('same', 'group:same', 'legacy.0', 'legacy.0.1'), {
          minLength: 2,
          maxLength: 12,
        }),
        (ids) => {
          const original = group(
            'same',
            ids.map((id, index) => group(id, [{ ...condition(id), value: index }])),
          );
          const identified = identifyFilter(original);
          expect(identifyFilter(structuredClone(original))).toEqual(identified);
          expect(identifyFilter(identified)).toEqual(identified);
          const entries = flattenTree(filterTree(identified));
          expect(new Set(entries.map(({ node }) => node.id)).size).toBe(entries.length);
          for (const { node } of entries.filter(({ node }) => !node.children)) {
            const moved = moveFilter(identified, node.id, {
              parentId: null,
              index: identified.conditions.length,
            });
            expect(moved).not.toBe(identified);
            expect(moved.conditions.at(-1)).toEqual(node.data);
            expect(
              flattenTree(filterTree(moved))
                .filter(({ node }) => !node.children)
                .map(({ node }) => !isGroup(node.data) && node.data.value)
                .sort(),
            ).toEqual(ids.map((_, index) => index).sort());
            expect(FilterGroup.safeParse(moved).success).toBe(true);
          }
        },
      ),
    );
  });

  it('prunes ancestors emptied by a move but preserves groups that were already empty', () => {
    const empty = group('empty', []);
    const original = group('root', [group('outer', [group('inner', [condition('a')])]), empty]);
    const moved = moveFilter(original, 'a', { parentId: null, index: 2 });
    expect(moved.conditions).toEqual([empty, condition('a')]);
  });

  it('keeps group identities through content edits, server copies, moves, and duplication', () => {
    const original = group('root', [group('nested', [condition('a')]), condition('b')]);
    const id = filterTree(original)[0]!.id;
    const edited = structuredClone(original);
    (edited.conditions[0] as FilterGroup).conditions.push(condition('c'));
    expect(filterTree(edited)[0]!.id).toBe(id);
    const moved = moveFilter(original, 'b', { parentId: id, index: 1 });
    expect(filterTree(moved)[0]!.id).toBe(id);
    expect(FilterGroup.parse(moved)).toEqual(moved);
    const copy = duplicateFilter(moved);
    expect(copy.id).not.toBe(moved.id);
    expect((copy.conditions[0] as FilterGroup).id).not.toBe('nested');
  });

  it('gives peers the same initial IDs for legacy groups without reusing an existing ID', () => {
    const legacy: FilterGroup = {
      conjunction: 'and',
      conditions: [{ conjunction: 'or', conditions: [condition('a')] }],
    };
    const local = identifyFilter(legacy);
    const peer = identifyFilter(structuredClone(legacy));
    expect(filterTree(local)[0]!.id).toBe(filterTree(peer)[0]!.id);
    const old = local.conditions[0] as FilterGroup;
    const inserted = identifyFilter(
      { ...legacy, conditions: [{ conjunction: 'and', conditions: [condition('b')] }, old] },
      local,
    );
    const ids = flattenTree(filterTree(inserted)).map(({ node }) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(filterTree(inserted)[1]!.id).toBe(filterTree(local)[0]!.id);
  });

  it('preserves valid saved shapes, condition IDs, stable group IDs, and nonempty groups through random moves', () => {
    fc.assert(
      fc.property(
        generated(1),
        fc.array(fc.tuple(fc.nat(), fc.nat(), fc.integer({ min: -1, max: 5 })), {
          minLength: 1,
          maxLength: 30,
        }),
        (original, moves) => {
          let current = original;
          const ids = conditionIds(original);
          for (const [source, parent, index] of moves) {
            const entries = flattenTree(filterTree(current));
            const parents = [null, ...entries.filter(({ node }) => node.children).map(({ node }) => node.id)];
            current = moveFilter(current, entries[source % entries.length]!.node.id, {
              parentId: parents[parent % parents.length]!,
              index,
            });
            expect(FilterGroup.safeParse(current).success).toBe(true);
            expect(conditionIds(current)).toEqual(ids);
            for (const { node, depth } of flattenTree(filterTree(current))) {
              if (isGroup(node.data)) {
                expect(node.data.conditions.length).toBeGreaterThan(0);
                expect(node.id).toBe(`group:${node.data.id}`);
              }
              expect(depth + (node.children ? 1 : 0)).toBeLessThanOrEqual(LIMITS.filterDepth);
              expect(flattenTree(node.children ?? []).some((entry) => entry.node.id === node.id)).toBe(false);
            }
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});
