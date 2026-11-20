import { useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { usePointerDrag } from './usePointerDrag';

export interface LayoutPlace {
  x: number;
  y: number;
  w: number;
  h: number;
}
type Placed = { id: string; place: LayoutPlace };

/** A stacked item lands after its neighbor, or on its leading edge so the neighbor moves below it. */
function stackedPlace(from: LayoutPlace, destination: LayoutPlace, after: boolean): LayoutPlace {
  return {
    ...from,
    x: after ? from.x : Math.min(from.x, destination.x),
    y: destination.y + (after ? destination.h : 0),
  };
}

/** A spatial designer previews only the active item and commits once when the pointer is released. */
export function useLayoutDrag<T extends Placed>({
  items,
  enabled,
  grid,
  columns,
  rowHeight,
  maxRow,
  place,
  nudge,
  resize,
  onCommit,
  onAnnounce,
}: {
  items: readonly T[];
  enabled: boolean;
  grid: RefObject<HTMLDivElement | null>;
  columns: number;
  rowHeight: number;
  maxRow: number;
  place(items: readonly T[], id: string, target: LayoutPlace): readonly T[];
  nudge(items: readonly T[], id: string, x: number, y: number): readonly T[];
  resize(items: readonly T[], id: string, x: number, y: number): readonly T[];
  onCommit(items: readonly T[], immediate: boolean): void;
  onAnnounce(place: LayoutPlace): void;
}) {
  const [preview, setPreview] = useState<T>();
  const pointerDrag = usePointerDrag(enabled);
  const changed = (next: readonly T[]) =>
    next.some((item, index) => JSON.stringify(item.place) !== JSON.stringify(items[index]?.place));
  const singleTrack = (style: CSSStyleDeclaration) => {
    const tracks = style.gridTemplateColumns.trim();
    return Boolean(tracks && tracks !== 'none' && tracks.split(/\s+/).length === 1);
  };
  function moveStacked(item: T, destination: T, after: boolean): readonly T[] {
    const ordered = [...items].sort((a, b) => a.place.y - b.place.y || a.place.x - b.place.x);
    const sourceIndex = ordered.findIndex((candidate) => candidate.id === item.id);
    ordered.splice(sourceIndex, 1);
    const index = ordered.findIndex((candidate) => candidate.id === destination.id);
    ordered.splice(index + (after ? 1 : 0), 0, item);
    let next = place(items, item.id, stackedPlace(item.place, destination.place, after));
    const leading: T[] = [];
    // Disjoint desktop columns can leave another item ahead of its intended phone neighbor.
    for (const entry of ordered) {
      let current = next.find((candidate) => candidate.id === entry.id)!;
      const previous = leading.at(-1);
      if (
        previous &&
        (current.place.y < previous.place.y ||
          (current.place.y === previous.place.y && current.place.x < previous.place.x))
      ) {
        next = place(next, current.id, {
          ...current.place,
          y: Math.max(...leading.map((candidate) => candidate.place.y + candidate.place.h)),
        });
        current = next.find((candidate) => candidate.id === entry.id)!;
      }
      leading.push(current);
    }
    const settledOrder = [...next].sort((a, b) => a.place.y - b.place.y || a.place.x - b.place.x);
    if (
      next.some((entry) => entry.place.y > maxRow) ||
      settledOrder.some((entry, index) => entry.id !== ordered[index]!.id)
    ) {
      // Rebase only the affected suffix, including earlier items when it needs their row space.
      let start = Math.min(
        sourceIndex,
        ordered.findIndex((entry) => entry.id === item.id),
      );
      let top: number;
      for (;;) {
        const suffix = ordered.slice(start);
        const lastOffset = suffix.slice(0, -1).reduce((sum, entry) => sum + entry.place.h, 0);
        top = Math.min(...suffix.map((entry) => entry.place.y), maxRow - lastOffset);
        const prefixEnd = Math.max(
          0,
          ...ordered.slice(0, start).map((entry) => entry.place.y + entry.place.h),
        );
        if (top >= prefixEnd || start === 0) break;
        start--;
      }
      const positions = new Map<string, LayoutPlace>();
      for (const entry of ordered.slice(start)) {
        positions.set(entry.id, { ...entry.place, y: top });
        top += entry.place.h;
      }
      next = items.map((entry) => {
        const position = positions.get(entry.id);
        return position ? { ...entry, place: position } : entry;
      });
    }
    return next;
  }
  function startDrag(event: PointerEvent<HTMLElement>, item: T, mode: 'move' | 'resize') {
    if (!enabled || event.button !== 0 || !grid.current) return;
    const element = grid.current;
    const style = getComputedStyle(element);
    const gap = Number.parseFloat(style.columnGap) || 0;
    const rowGap = Number.parseFloat(style.rowGap) || 0;
    const inner =
      element.clientWidth -
      (Number.parseFloat(style.paddingInlineStart) || 0) -
      (Number.parseFloat(style.paddingInlineEnd) || 0);
    const columnStep = Math.max(1, (inner - gap * (columns - 1)) / columns) + gap;
    const phone = singleTrack(style);
    if (phone && mode === 'resize') return;
    const origin = { x: event.clientX, y: event.clientY };
    let latest: readonly T[] | undefined;
    pointerDrag(event, {
      activateImmediately: mode === 'resize',
      move(next) {
        const dx = Math.round(
          ((next.clientX - origin.x) * (style.direction === 'rtl' ? -1 : 1)) / columnStep,
        );
        const dy = Math.round((next.clientY - origin.y) / (rowHeight + rowGap));
        const target =
          mode === 'move'
            ? { ...item.place, x: item.place.x + (phone ? 0 : dx), y: item.place.y + dy }
            : { ...item.place, w: Math.min(item.place.w + dx, columns - item.place.x), h: item.place.h + dy };
        if (phone && mode === 'move') {
          const articles = [...element.querySelectorAll<HTMLElement>(':scope > article')];
          const neighbor =
            articles.find((article) => next.clientY <= article.getBoundingClientRect().bottom) ??
            articles.at(-1);
          const id = neighbor?.dataset.tile ?? neighbor?.dataset.block;
          const destination = items.find((candidate) => candidate.id === id);
          if (destination && neighbor) {
            const sourceIndex = articles.findIndex(
              (article) => (article.dataset.tile ?? article.dataset.block) === item.id,
            );
            latest =
              destination.id === item.id
                ? items
                : moveStacked(
                    item,
                    destination,
                    next.clientY > neighbor.getBoundingClientRect().bottom ||
                      (next.clientY >= neighbor.getBoundingClientRect().top &&
                        articles.indexOf(neighbor) > sourceIndex),
                  );
            setPreview(latest.find((candidate) => candidate.id === item.id));
            return;
          }
        }
        latest = place(items, item.id, target);
        setPreview(latest.find((candidate) => candidate.id === item.id));
      },
      finish() {
        setPreview(undefined);
        if (latest && changed(latest)) {
          onCommit(latest, true);
          onAnnounce(latest.find((candidate) => candidate.id === item.id)!.place);
        }
      },
      cancel() {
        setPreview(undefined);
      },
    });
  }
  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, item: T) {
    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const direction = arrows[event.key];
    if (!enabled || !direction || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    const style = grid.current && getComputedStyle(grid.current);
    const phone = style && singleTrack(style);
    if (phone && (event.shiftKey || direction[0])) return;
    const rtl = style?.direction === 'rtl';
    let next: readonly T[];
    if (phone) {
      const ordered = [...items].sort((a, b) => a.place.y - b.place.y || a.place.x - b.place.x);
      const index = ordered.findIndex((candidate) => candidate.id === item.id);
      const destination = ordered[index + direction[1]];
      if (!destination) return;
      next = moveStacked(item, destination, direction[1] > 0);
    } else {
      next = (event.shiftKey ? resize : nudge)(items, item.id, direction[0] * (rtl ? -1 : 1), direction[1]);
    }
    if (!changed(next)) return;
    const handle = event.currentTarget;
    onCommit(next, false);
    onAnnounce(next.find((candidate) => candidate.id === item.id)!.place);
    requestAnimationFrame(() => handle.focus({ preventScroll: true }));
  }
  function movement(item: T, nameOf: (item: T) => string) {
    const commit = (next: readonly T[]) => {
      if (!enabled || !changed(next)) return;
      onCommit(next, true);
      onAnnounce(next.find((candidate) => candidate.id === item.id)!.place);
    };
    const step = (direction: -1 | 1) => {
      if (grid.current && singleTrack(getComputedStyle(grid.current))) {
        const ordered = [...items].sort((a, b) => a.place.y - b.place.y || a.place.x - b.place.x);
        const target = ordered[ordered.findIndex((candidate) => candidate.id === item.id) + direction];
        return target ? moveStacked(item, target, direction > 0) : items;
      }
      return nudge(items, item.id, 0, direction);
    };
    return {
      name: nameOf(item),
      up: enabled && changed(step(-1)) ? () => commit(step(-1)) : undefined,
      down: enabled && changed(step(1)) ? () => commit(step(1)) : undefined,
      destinations: enabled
        ? items
            .filter((target) => target.id !== item.id)
            .map((target) => ({
              id: target.id,
              name: nameOf(target),
              move: () =>
                commit(
                  grid.current && singleTrack(getComputedStyle(grid.current))
                    ? moveStacked(item, target, target.place.y > item.place.y)
                    : place(items, item.id, { ...item.place, x: target.place.x, y: target.place.y }),
                ),
            }))
        : [],
    };
  }
  return { preview, startDrag, handleKeyDown, movement };
}
