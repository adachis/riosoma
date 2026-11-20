import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  canMoveTree,
  flattenTree,
  moveList,
  moveTree,
  treeMoveTarget,
  type SortableNode,
} from './sortable-moves';

const leaf = (id: string): SortableNode<string> => ({ id, data: id });
const group = (id: string, children: SortableNode<string>[] = []): SortableNode<string> => ({
  id,
  data: id,
  children,
});
const tree = [leaf('a'), group('b', [leaf('c'), group('d', [leaf('e')])]), leaf('f')];
const ids = (nodes: readonly SortableNode[]) =>
  flattenTree(nodes)
    .map(({ node }) => node.id)
    .sort();

function invariant(before: readonly SortableNode[], after: readonly SortableNode[]) {
  expect(ids(after)).toEqual(ids(before));
  const entries = flattenTree(after);
  expect(entries.every((entry) => entry.depth + (entry.node.children ? 1 : 0) <= 3)).toBe(true);
  expect(
    entries.every(
      (entry) => !flattenTree(entry.node.children ?? []).some(({ node }) => node.id === entry.node.id),
    ),
  ).toBe(true);
}

describe('sortable moves', () => {
  it('moves list items without changing their identities or the original list', () => {
    const original = [leaf('a'), leaf('b'), leaf('c')];
    expect(moveList(original, 0, 2)).toEqual([original[1], original[2], original[0]]);
    expect(original.map((node) => node.id)).toEqual(['a', 'b', 'c']);
    for (const [from, to] of [
      [-1, 0],
      [0, 3],
      [0.5, 1],
      [1, 1],
      [NaN, 0],
    ])
      expect(moveList(original, from!, to!)).toBe(original);
  });

  it('moves into an empty group, out of a nested group, and moves complete subtrees', () => {
    const empty = [...tree, group('empty')];
    const moved = moveTree(empty, 'a', { parentId: 'empty', index: 0 }, 3);
    expect(moved.at(-1)?.children).toEqual([tree[0]]);
    const out = moveTree(tree, 'e', { parentId: null, index: 1 }, 3);
    expect(out[1]?.id).toBe('e');
    const whole = moveTree(tree, 'b', { parentId: null, index: 2 }, 3);
    expect(whole[2]).toBe(tree[1]);
    invariant(tree, out);
    invariant(tree, whole);
  });

  it('rejects cycles, excess depth, missing parents, noncontainers, and invalid positions', () => {
    for (const target of [
      { parentId: 'b', index: 0 },
      { parentId: 'd', index: 0 },
      { parentId: 'missing', index: 0 },
      { parentId: 'a', index: 0 },
      { parentId: null, index: 9 },
      { parentId: null, index: -1 },
    ]) {
      expect(canMoveTree(tree, 'b', target, 3)).toBe(false);
      expect(moveTree(tree, 'b', target, 3)).toBe(tree);
    }
    expect(moveTree(tree, 'd', { parentId: 'b', index: 1 }, 2)).toBe(tree);
    expect(moveTree(tree, 'missing', { parentId: null, index: 0 }, 3)).toBe(tree);
    const duplicateIds = [leaf('a'), leaf('a')];
    expect(moveTree(duplicateIds, 'a', { parentId: null, index: 1 }, 3)).toBe(duplicateIds);
  });

  it('uses the same destinations for menu and keyboard moves', () => {
    expect(treeMoveTarget(tree, 'f', 'in')).toEqual({ parentId: 'b', index: 2 });
    expect(treeMoveTarget(tree, 'd', 'out')).toEqual({ parentId: null, index: 2 });
    expect(treeMoveTarget(tree, 'a', 'up')).toBeNull();
    expect(treeMoveTarget(tree, 'b', 'in')).toBeNull();
  });

  it('respects container capacity when moving across groups and permits reordering within it', () => {
    const full = [group('full', [leaf('a'), leaf('b')]), leaf('c')];
    expect(moveTree(full, 'c', { parentId: 'full', index: 2 }, 3, 2)).toBe(full);
    expect(moveTree(full, 'a', { parentId: null, index: 2 }, 3, 2)).toBe(full);
    expect(
      moveTree(full, 'a', { parentId: 'full', index: 1 }, 3, 2)[0]?.children?.map(({ id }) => id),
    ).toEqual(['b', 'a']);
  });

  it('preserves every item and the depth bound over generated trees and repeated moves', () => {
    const shape = (depth: number): fc.Arbitrary<SortableNode<string>[]> =>
      fc.array(
        depth < 3
          ? fc.oneof(
              fc.constant(leaf('')),
              shape(depth + 1).map((children) => group('', children)),
            )
          : fc.constant(leaf('')),
        { minLength: 1, maxLength: 5 },
      );
    fc.assert(
      fc.property(
        shape(1),
        fc.array(fc.tuple(fc.nat(), fc.nat(), fc.integer({ min: -1, max: 6 })), {
          minLength: 30,
          maxLength: 30,
        }),
        (generated, moves) => {
          let serial = 0;
          function identify(nodes: SortableNode<string>[]): SortableNode<string>[] {
            return nodes.map((node) => ({
              ...node,
              id: String(serial++),
              ...(node.children ? { children: identify([...node.children]) } : {}),
            }));
          }
          const original = identify(generated);
          let current: readonly SortableNode<string>[] = original;
          for (const [sourceIndex, parentIndex, index] of moves) {
            const entries = flattenTree(current);
            const source = entries[sourceIndex % entries.length]!;
            const parents = [null, ...entries.filter(({ node }) => node.children).map(({ node }) => node.id)];
            const target = { parentId: parents[parentIndex % parents.length]!, index };
            current = moveTree(current, source.node.id, target, 3);
            invariant(original, current);
            const list = entries.map(({ node }) => node.id);
            expect([...moveList(list, sourceIndex % list.length, parentIndex % list.length)].sort()).toEqual(
              [...list].sort(),
            );
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});
