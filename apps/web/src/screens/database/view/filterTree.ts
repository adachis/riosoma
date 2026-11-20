import { isGroup, LIMITS, type FilterCondition, type FilterGroup } from '@riosoma/contracts';
import { moveTree, type SortableLocation, type SortableNode } from '@riosoma/ui';

type FilterEntry = FilterCondition | FilterGroup;
const newGroupId = () => crypto.randomUUID().replaceAll('-', '');

/** Legacy peers agree on IDs before the first save, while edits retain existing identities */
export function identifyFilter(group: FilterGroup, previous?: FilterGroup): FilterGroup {
  const used = new Set<string>();
  function reserve(current: FilterGroup) {
    if (current.id) used.add(current.id);
    current.conditions.forEach((entry) => {
      if (isGroup(entry)) reserve(entry);
    });
  }
  reserve(group);
  const seen = new Set<string>(group.id ? [group.id] : []);
  function identify(current: FilterGroup, old: FilterGroup | undefined, path: string): FilterGroup {
    return {
      ...current,
      conditions: current.conditions.map((entry, index) => {
        if (!isGroup(entry)) return entry;
        const prior = old?.conditions[index];
        const previousGroup = prior && isGroup(prior) ? prior : undefined;
        const branch = `${path}.${index}`;
        let id = entry.id;
        if (!id || seen.has(id)) {
          const candidate = previousGroup?.id;
          const base = candidate && !used.has(candidate) ? candidate : `legacy${branch}`;
          id = base;
          let suffix = 0;
          while (used.has(id)) id = `${base}.${++suffix}`;
          used.add(id);
        }
        seen.add(id);
        return identify({ ...entry, id }, previousGroup, branch);
      }),
    };
  }
  const identified = identify(group, previous, '');
  const conditionIds = new Set<string>();
  const reserved = new Set<string>();
  function reserveConditions(current: FilterGroup) {
    current.conditions.forEach((entry) => {
      if (isGroup(entry)) {
        // Group prefixes share the drag layer's namespace with condition IDs
        conditionIds.add(`group:${entry.id}`);
        reserveConditions(entry);
      } else reserved.add(entry.id);
    });
  }
  reserveConditions(identified);
  function identifyConditions(current: FilterGroup, old: FilterGroup | undefined, path: string): FilterGroup {
    return {
      ...current,
      conditions: current.conditions.map((entry, index) => {
        const branch = `${path}.${index}`;
        const prior = old?.conditions[index];
        if (isGroup(entry))
          return identifyConditions(entry, prior && isGroup(prior) ? prior : undefined, branch);
        let id = entry.id;
        if (conditionIds.has(id)) {
          const candidate = prior && !isGroup(prior) ? prior.id : undefined;
          const base =
            candidate && !reserved.has(candidate) && !conditionIds.has(candidate)
              ? candidate
              : `legacyCondition${branch}`;
          id = base;
          let suffix = 0;
          while (reserved.has(id) || conditionIds.has(id)) id = `${base}.${++suffix}`;
          reserved.add(id);
        }
        conditionIds.add(id);
        return id === entry.id ? entry : { ...entry, id };
      }),
    };
  }
  return identifyConditions(identified, previous, '');
}

export function filterTree(group: FilterGroup, path = ''): SortableNode<FilterEntry>[] {
  return group.conditions.map((entry, index) => {
    if (!isGroup(entry)) return { id: entry.id, data: entry };
    const branch = `${path}.${index}`;
    return { id: `group:${entry.id ?? branch}`, data: entry, children: filterTree(entry, branch) };
  });
}

export function moveFilter(group: FilterGroup, id: string, target: SortableLocation): FilterGroup {
  const nodes = filterTree(group);
  const moved = moveTree(nodes, id, target, LIMITS.filterDepth, LIMITS.filterConditions);
  if (nodes === moved) return group;
  function conditions(items: readonly SortableNode<FilterEntry>[]): FilterEntry[] {
    return items.flatMap<FilterEntry>((node) => {
      if (!isGroup(node.data)) return [node.data];
      const next = { ...node.data, conditions: conditions(node.children ?? []) };
      // Only prune groups emptied by this move, preserving preexisting empty groups
      return node.data.conditions.length && !next.conditions.length ? [] : [next];
    });
  }
  return { ...group, conditions: conditions(moved) };
}

export function duplicateFilter(group: FilterGroup): FilterGroup {
  return {
    ...group,
    id: newGroupId(),
    conditions: group.conditions.map((entry) =>
      isGroup(entry) ? duplicateFilter(entry) : { ...entry, id: crypto.randomUUID().replaceAll('-', '') },
    ),
  };
}
