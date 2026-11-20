export interface SortableNode<T = unknown> {
  id: string;
  data: T;
  children?: readonly SortableNode<T>[];
}

export interface SortableLocation {
  parentId: string | null;
  /** Index in the destination after removing the item */
  index: number;
}

export interface SortableEntry<T = unknown> extends SortableLocation {
  node: SortableNode<T>;
  /** The root container has depth one */
  depth: number;
}

export function moveList<T>(items: readonly T[], from: number, to: number): readonly T[] {
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to < 0 ||
    from >= items.length ||
    to >= items.length ||
    from === to
  )
    return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

export function flattenTree<T>(
  nodes: readonly SortableNode<T>[],
  parentId: string | null = null,
  depth = 1,
): SortableEntry<T>[] {
  return nodes.flatMap((node, index) => [
    { node, parentId, index, depth },
    ...flattenTree(node.children ?? [], node.id, depth + 1),
  ]);
}

function groupHeight(node: SortableNode): number {
  return node.children ? 1 + Math.max(0, ...node.children.map(groupHeight)) : 0;
}

/** Prepare shared structure once when a menu checks many destinations. */
export function createTreeMoveValidator<T>(
  nodes: readonly SortableNode<T>[],
  maxDepth: number,
  maxChildren = Infinity,
): (id: string, target: SortableLocation) => boolean {
  const entries = flattenTree(nodes);
  const byId = new Map(entries.map((entry) => [entry.node.id, entry]));
  return (id, target) => {
    if (byId.size !== entries.length) return false;
    const source = byId.get(id);
    const parent = target.parentId === null ? undefined : byId.get(target.parentId);
    if (!source || (target.parentId !== null && !parent?.node.children)) return false;
    if (
      target.parentId === id ||
      flattenTree(source.node.children ?? []).some((entry) => entry.node.id === target.parentId)
    )
      return false;
    const destination = parent?.node.children ?? nodes;
    const length = destination.length - (source.parentId === target.parentId ? 1 : 0);
    return (
      Number.isInteger(target.index) &&
      target.index >= 0 &&
      target.index <= length &&
      length + 1 <= maxChildren &&
      (parent ? parent.depth + 1 : 1) + groupHeight(source.node) <= maxDepth
    );
  };
}

export function canMoveTree<T>(
  nodes: readonly SortableNode<T>[],
  id: string,
  target: SortableLocation,
  maxDepth: number,
  maxChildren = Infinity,
): boolean {
  return createTreeMoveValidator(nodes, maxDepth, maxChildren)(id, target);
}

/** Invalid moves preserve the original tree, so callers can avoid recording an empty change */
export function moveTree<T>(
  nodes: readonly SortableNode<T>[],
  id: string,
  target: SortableLocation,
  maxDepth: number,
  maxChildren = Infinity,
): readonly SortableNode<T>[] {
  if (!canMoveTree(nodes, id, target, maxDepth, maxChildren)) return nodes;
  const source = flattenTree(nodes).find((entry) => entry.node.id === id)!;
  if (source.parentId === target.parentId && source.index === target.index) return nodes;
  function remove(items: readonly SortableNode<T>[]): readonly SortableNode<T>[] {
    return items
      .filter((node) => node.id !== id)
      .map((node) => (node.children ? { ...node, children: remove(node.children) } : node));
  }
  function insert(items: readonly SortableNode<T>[], parentId: string | null): readonly SortableNode<T>[] {
    if (parentId === target.parentId) {
      const next = [...items];
      next.splice(target.index, 0, source.node);
      return next;
    }
    return items.map((node) =>
      node.children ? { ...node, children: insert(node.children, node.id) } : node,
    );
  }
  return insert(remove(nodes), null);
}

export type SortableDirection = 'up' | 'down' | 'left' | 'right' | 'in' | 'out';

export function treeMoveTarget<T>(
  nodes: readonly SortableNode<T>[],
  id: string,
  direction: SortableDirection,
): SortableLocation | null {
  const entries = flattenTree(nodes);
  const source = entries.find((entry) => entry.node.id === id);
  if (!source) return null;
  const siblings =
    source.parentId === null
      ? nodes
      : (entries.find((entry) => entry.node.id === source.parentId)?.node.children ?? []);
  if (direction === 'up' || direction === 'down' || direction === 'left' || direction === 'right') {
    const index = source.index + (direction === 'up' || direction === 'left' ? -1 : 1);
    return index >= 0 && index < siblings.length ? { parentId: source.parentId, index } : null;
  }
  if (direction === 'in') {
    const above = siblings[source.index - 1];
    return above?.children ? { parentId: above.id, index: above.children.length } : null;
  }
  const parent = entries.find((entry) => entry.node.id === source.parentId);
  return parent ? { parentId: parent.parentId, index: parent.index + 1 } : null;
}
