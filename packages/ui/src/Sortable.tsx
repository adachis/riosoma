import { TOUCH_DRAG_ACTIVATION } from '@riosoma/tokens';
import {
  createContext,
  createElement,
  Children,
  cloneElement,
  isValidElement,
  lazy,
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  Suspense,
  type ElementType,
  type HTMLAttributes,
  type ReactNode,
  type ReactElement,
  type RefCallback,
} from 'react';
import { createPortal } from 'react-dom';
import { useLingui } from '@lingui/react/macro';
import {
  DndContext,
  DragOverlay,
  closestCenter,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type KeyboardCoordinateGetter,
  type Over,
} from '@dnd-kit/core';
import { SortableContext, useSortable } from '@dnd-kit/sortable';
import { getEventCoordinates } from '@dnd-kit/utilities';
import { faEllipsis, faGripVertical } from '@fortawesome/free-solid-svg-icons';
import { Icon } from '@riosoma/icons';
import { Button } from './Button';
import { SortableItemMenuContext } from './sortable-item-menu';
import { cx } from './cx';
import {
  createTreeMoveValidator,
  flattenTree,
  moveTree,
  treeMoveTarget,
  type SortableDirection,
  type SortableLocation,
  type SortableNode,
} from './sortable-moves';
import { SortableKeyboardSensor } from './sortable-keyboard';
import { canAutoScroll, SortablePointerSensor, SortableTouchSensor } from './sortable-pointer';
import './Sortable.css';
const SortableActionsMenu = lazy(() => import('./SortableActionsMenu'));
const ButtonTooltip = lazy(() => import('./ButtonTooltip'));

export interface SortableItemData {
  name: string;
  handleLabel?: string;
  disabledReason?: string;
}
type Node = SortableNode<SortableItemData>;
export type SortableOrientation = 'vertical' | 'horizontal' | 'grid';
export type SortableKeyMap = Readonly<Record<string, SortableDirection | null>>;

const pointerOptions = { activationConstraint: { distance: 5 } };
const touchOptions = { activationConstraint: TOUCH_DRAG_ACTIVATION };
const autoScrollOptions = { canScroll: canAutoScroll };
interface Destination {
  parentId: string | null;
  beforeId: string | null;
}

interface Progress {
  activeId: string | null;
  beforeId: string | null;
  endParent: string | null | undefined;
}
function progressStore() {
  let value: Progress = { activeId: null, beforeId: null, endParent: undefined };
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next: Progress) {
      value = next;
      listeners.forEach((listener) => listener());
    },
  };
}

export interface SortableMoves {
  item(id: string): Node | undefined;
  target(id: string, direction: SortableDirection): SortableLocation | null;
  canMove(id: string, target: SortableLocation | SortableDirection): boolean;
  move(id: string, target: SortableLocation | SortableDirection): void;
}
interface SortableState extends SortableMoves {
  nodes: readonly Node[];
  disabledReason?: string;
  instructionId: string;
  orientation: SortableOrientation;
  keyMap: SortableKeyMap;
  progress: ReturnType<typeof progressStore>;
}
const SortableStateContext = createContext<SortableState | null>(null);
function useSortableState() {
  const state = useContext(SortableStateContext);
  if (!state) throw new Error('Sortable items need a sortable container');
  return state;
}
/** Menus and shortcuts share the same drop rules, announcements, and focus restoration */
export function useSortableMoves(): SortableMoves {
  return useSortableState();
}

export interface SortableTreeProps {
  items: readonly Node[];
  maxDepth: number;
  maxChildren?: number;
  onMove: (id: string, target: SortableLocation) => void;
  disabledReason?: string;
  orientation?: SortableOrientation;
  /** Columns define vertical steps even when destination rows are not mounted */
  columns?: number;
  /** Maps KeyboardEvent.code to moves, with null disabling a default key */
  keyMap?: SortableKeyMap;
  canDrop?: (id: string, target: SortableLocation) => boolean;
  dropReason?: (id: string, target: SortableLocation) => string | undefined;
  anchorDisabledItems?: boolean;
  /** External destinations do not participate in the rendered items' keyboard order */
  targets?: readonly Node[];
  renderOverlay?: (node: Node) => ReactNode;
  /** Virtualizers can mount or scroll to a destination before focus is restored */
  onRevealItem?: (id: string) => void | Promise<void>;
  /** Supply localized instructions when overriding the default keys */
  instructions?: string;
  children: ReactNode;
}

/** Only the destination changes during a drag, keeping controls still until the single commit */
export function SortableTree(props: SortableTreeProps) {
  return <SortableRoot {...props} tree />;
}
function SortableRoot({
  items,
  maxDepth,
  maxChildren,
  onMove,
  disabledReason,
  children,
  orientation = 'vertical',
  columns = 1,
  keyMap: configuredKeys,
  canDrop,
  dropReason,
  anchorDisabledItems = true,
  targets,
  renderOverlay,
  onRevealItem,
  instructions: customInstructions,
  tree,
}: SortableTreeProps & { tree: boolean }) {
  const { t } = useLingui();
  const instructionId = useId();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string>();
  const [announcement, setAnnouncement] = useState({ text: '', serial: 0 });
  const [dropSerial, setDropSerial] = useState(0);
  const completed = useRef<{ id: string; target: SortableLocation; before: readonly Node[] } | null>(null);
  const [progress] = useState(progressStore);
  const pending = useRef<Destination | null>(null);
  const candidate = useRef<Destination | null>(null);
  const announcedPosition = useRef<SortableLocation | null>(null);
  const dragging = useRef<string | null>(null);
  const keyboard = useRef(false);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const nativeSource = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const track = (event: PointerEvent | TouchEvent) => {
      if (!dragging.current || keyboard.current) return;
      const coordinates = getEventCoordinates(event);
      if (coordinates) pointer.current = coordinates;
    };
    // A release can precede the next collision pass, so keep its actual destination.
    window.addEventListener('pointermove', track, true);
    window.addEventListener('pointerup', track, true);
    window.addEventListener('touchmove', track, true);
    window.addEventListener('touchend', track, true);
    return () => {
      window.removeEventListener('pointermove', track, true);
      window.removeEventListener('pointerup', track, true);
      window.removeEventListener('touchmove', track, true);
      window.removeEventListener('touchend', track, true);
    };
  }, []);
  useEffect(() => {
    if (!refusal || activeId) return;
    const clear = () => setRefusal(undefined);
    document.addEventListener('keydown', clear, true);
    document.addEventListener('blur', clear, true);
    return () => {
      document.removeEventListener('keydown', clear, true);
      document.removeEventListener('blur', clear, true);
    };
  }, [refusal, activeId]);
  const movableTree = useMemo(() => (targets?.length ? [...items, ...targets] : items), [items, targets]);
  const entries = useMemo(() => flattenTree(movableTree), [movableTree]);
  const byId = useMemo(() => new Map(entries.map((entry) => [entry.node.id, entry])), [entries]);
  const active = activeId ? byId.get(activeId) : undefined;
  const keyMap = useMemo<SortableKeyMap>(
    () => ({
      ...(orientation === 'horizontal'
        ? { ArrowLeft: 'up', ArrowRight: 'down', ...(tree ? { ArrowUp: 'out', ArrowDown: 'in' } : {}) }
        : orientation === 'grid'
          ? { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }
          : { ArrowUp: 'up', ArrowDown: 'down', ...(tree ? { ArrowLeft: 'out', ArrowRight: 'in' } : {}) }),
      ...configuredKeys,
    }),
    [orientation, tree, configuredKeys],
  );
  const instructions =
    customInstructions ??
    (tree && orientation === 'vertical'
      ? t({
          id: 'sortable.verticalTreeInstructions',
          message:
            'Press Space or Enter to pick up.  Use Up and Down to move.  Right enters the group above and Left leaves a group.  Press Space to drop or Escape to cancel.  Hold Alt with a movement key to move immediately.',
        })
      : tree && orientation === 'horizontal'
        ? t({
            id: 'sortable.horizontalTreeInstructions',
            message:
              'Press Space or Enter to pick up.  Use Left and Right to move.  Down enters the group before it and Up leaves a group.  Press Space to drop or Escape to cancel.  Hold Alt with a movement key to move immediately.',
          })
        : orientation === 'horizontal'
          ? t({
              id: 'sortable.horizontalInstructions',
              message:
                'Press Space or Enter to pick up.  Use Left and Right to move.  Press Space to drop or Escape to cancel.  Alt+Left and Alt+Right move immediately.',
            })
          : orientation === 'grid'
            ? t({
                id: 'sortable.gridInstructions',
                message:
                  'Press Space or Enter to pick up.  Use the arrow keys to move between rows and columns.  Press Space to drop or Escape to cancel.  Hold Alt with an arrow key to move immediately.',
              })
            : t({
                id: 'sortable.listInstructions',
                message:
                  'Press Space or Enter to pick up.  Use Up and Down to move.  Press Space to drop or Escape to cancel.  Alt+Up and Alt+Down move immediately.',
              }));

  const canPlace = useMemo(
    () => createTreeMoveValidator(movableTree, maxDepth, maxChildren),
    [movableTree, maxDepth, maxChildren],
  );
  const valid = useCallback(
    (id: string, location: SortableLocation) => {
      const source = byId.get(id);
      if (
        disabledReason ||
        source?.node.data.disabledReason ||
        dropReason?.(id, location) ||
        !canPlace(id, location) ||
        (canDrop && !canDrop(id, location))
      )
        return false;
      const anchored = anchorDisabledItems ? entries.filter((entry) => entry.node.data.disabledReason) : [];
      if (!anchored.length) return true;
      const moved = new Map(
        flattenTree(moveTree(movableTree, id, location, maxDepth, maxChildren)).map((entry) => [
          entry.node.id,
          entry,
        ]),
      );
      // Locked rows retain their positions while editable rows can move on either side
      return anchored.every((entry) => {
        const after = moved.get(entry.node.id);
        return after?.parentId === entry.parentId && after.index === entry.index;
      });
    },
    [
      movableTree,
      canPlace,
      byId,
      entries,
      disabledReason,
      maxDepth,
      maxChildren,
      canDrop,
      dropReason,
      anchorDisabledItems,
    ],
  );

  const announce = useCallback(
    (kind: 'pick' | 'move' | 'drop' | 'cancel', id: string, location: SortableLocation) => {
      announcedPosition.current = { parentId: location.parentId, index: location.index };
      const name = byId.get(id)?.node.data.name ?? '';
      const position = location.index + 1;
      const group =
        byId.get(location.parentId ?? '')?.node.data.name ??
        t({ id: 'sortable.root', message: 'the top level' });
      const text = tree
        ? kind === 'pick'
          ? t({ id: 'sortable.pick', message: `Picked up ${name}, position ${position} in ${group}.` })
          : kind === 'move'
            ? t({ id: 'sortable.move', message: `${name}, position ${position} in ${group}.` })
            : kind === 'drop'
              ? t({ id: 'sortable.drop', message: `Dropped ${name}, position ${position} in ${group}.` })
              : t({
                  id: 'sortable.cancel',
                  message: `Canceled moving ${name}, position ${position} in ${group}.`,
                })
        : kind === 'pick'
          ? t({ id: 'sortable.listPick', message: `Picked up ${name}, position ${position}.` })
          : kind === 'move'
            ? t({ id: 'sortable.listMove', message: `${name}, position ${position}.` })
            : kind === 'drop'
              ? t({ id: 'sortable.listDrop', message: `Dropped ${name}, position ${position}.` })
              : t({ id: 'sortable.listCancel', message: `Canceled moving ${name}, position ${position}.` });
      setAnnouncement((previous) => ({ text, serial: previous.serial + 1 }));
    },
    [byId, t, tree],
  );

  // A host can prune an emptied container, so announce the position it actually renders
  useLayoutEffect(() => {
    const drop = completed.current;
    if (!drop) return;
    completed.current = null;
    const final = items !== drop.before ? byId.get(drop.id) : undefined;
    announce('drop', drop.id, final ?? drop.target);
  }, [dropSerial, items, byId, announce]);

  function anchor(id: string, target: SortableLocation): Destination {
    const destination = target.parentId === null ? items : (byId.get(target.parentId)?.node.children ?? []);
    return {
      parentId: target.parentId,
      beforeId: destination.filter((node) => node.id !== id)[target.index]?.id ?? null,
    };
  }
  const resolve = useCallback(
    (id: string, target: Destination | null): SortableLocation | null => {
      if (!target || !byId.has(id)) return null;
      const destination = target.parentId === null ? items : byId.get(target.parentId)?.node.children;
      if (!destination) return null;
      const remaining = destination.filter((node) => node.id !== id);
      const index =
        target.beforeId === null
          ? remaining.length
          : remaining.findIndex((node) => node.id === target.beforeId);
      return index < 0 ? null : { parentId: target.parentId, index };
    },
    [items, byId],
  );
  const show = useCallback(
    (id: string | null, target: Destination | null) => {
      const beforeId = target?.beforeId ?? null;
      progress.set({ activeId: id, beforeId, endParent: target && !beforeId ? target.parentId : undefined });
    },
    [progress],
  );
  const proposeDestination = useCallback(
    (target: Destination | null) => {
      const id = dragging.current;
      candidate.current = target;
      const location = id ? resolve(id, target) : null;
      const next = id && location && valid(id, location) ? target : null;
      setRefusal(
        id && location && !next
          ? (disabledReason ??
              byId.get(id)?.node.data.disabledReason ??
              dropReason?.(id, location) ??
              t({
                id: 'sortable.destinationUnavailable',
                message:
                  'This destination is unavailable.  Check the item’s lock, folder depth, and allowed order.',
              }))
          : undefined,
      );
      if (keyboard.current && location && !next) return;
      if (pending.current?.parentId !== next?.parentId || pending.current?.beforeId !== next?.beforeId) {
        pending.current = next;
        show(id, next);
      }
      if (
        id &&
        next &&
        location &&
        (location.parentId !== announcedPosition.current?.parentId ||
          location.index !== announcedPosition.current?.index)
      )
        announce('move', id, location);
    },
    [resolve, valid, disabledReason, byId, dropReason, t, show, announce],
  );
  function propose(location: SortableLocation | null) {
    const id = dragging.current;
    proposeDestination(id && location ? anchor(id, location) : null);
  }
  // Peer edits and completed preflight checks resolve against the same destination anchor.
  useLayoutEffect(() => {
    if (dragging.current && candidate.current) proposeDestination(candidate.current);
  }, [proposeDestination]);
  const targetFor = useCallback(
    (nodes: readonly Node[], id: string, direction: SortableDirection) => {
      let location = treeMoveTarget(nodes, id, direction);
      if (orientation === 'grid' && (direction === 'up' || direction === 'down') && location) {
        location = {
          ...location,
          index: location.index + (Math.max(1, Math.floor(columns)) - 1) * (direction === 'up' ? -1 : 1),
        };
      }
      return location;
    },
    [orientation, columns],
  );
  const coordinates: KeyboardCoordinateGetter = (event, { currentCoordinates, context }) => {
    const direction = keyMap[event.code];
    const id = dragging.current;
    if (!direction || !id) return;
    const destination = resolve(id, pending.current);
    const projected = destination ? moveTree(items, id, destination, maxDepth, maxChildren) : items;
    const location = targetFor(projected, id, direction);
    if (!location) return currentCoordinates;
    propose(location);
    if (!valid(id, location)) return currentCoordinates;
    const siblings = location.parentId === null ? items : (byId.get(location.parentId)?.node.children ?? []);
    const remaining = siblings.filter((node) => node.id !== id);
    const neighbor = remaining[location.index] ?? remaining.at(-1);
    if (neighbor) {
      void onRevealItem?.(neighbor.id);
      context.draggableNodes
        .get(neighbor.id)
        ?.node.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    }
    const rect = neighbor && context.droppableRects.get(neighbor.id);
    return rect ? { x: rect.left, y: rect.top } : currentCoordinates;
  };
  const latestCoordinates = useRef(coordinates);
  useLayoutEffect(() => {
    latestCoordinates.current = coordinates;
  });
  const coordinateGetter = useCallback<KeyboardCoordinateGetter>(
    (...args) => latestCoordinates.current(...args),
    [],
  );
  const keyboardOptions = useMemo(
    () => ({
      coordinateGetter,
      moveKeys: Object.keys(keyMap).filter((key) => keyMap[key]),
      scrollBehavior: 'auto' as const,
    }),
    [coordinateGetter, keyMap],
  );
  const sensors = useSensors(
    useSensor(SortablePointerSensor, pointerOptions),
    useSensor(SortableTouchSensor, touchOptions),
    useSensor(SortableKeyboardSensor, keyboardOptions),
  );
  const collisions: CollisionDetection = (args) => {
    pointer.current = args.pointerCoordinates;
    if (keyboard.current) return [{ id: args.active.id }];
    const point = args.pointerCoordinates;
    if (!point) return [];
    const droppableRects = new Map(args.droppableRects);
    const clipping = new Map<HTMLElement, { left: number; right: number; top: number; bottom: number }>();
    const droppableContainers = args.droppableContainers.filter(({ id, node }) => {
      const rect = droppableRects.get(id);
      if (!rect || !node.current) return false;
      let { left, right, top, bottom } = rect;
      for (let parent = node.current.parentElement; parent; parent = parent.parentElement) {
        let clip = clipping.get(parent);
        if (!clip) {
          const style = getComputedStyle(parent);
          const clipsX = /auto|scroll|overlay|hidden|clip/.test(style.overflowX || style.overflow);
          const clipsY = /auto|scroll|overlay|hidden|clip/.test(style.overflowY || style.overflow);
          const bounds = clipsX || clipsY ? parent.getBoundingClientRect() : null;
          clip = {
            left: clipsX ? bounds!.left + parent.clientLeft : -Infinity,
            right: clipsX ? bounds!.left + parent.clientLeft + parent.clientWidth : Infinity,
            top: clipsY ? bounds!.top + parent.clientTop : -Infinity,
            bottom: clipsY ? bounds!.top + parent.clientTop + parent.clientHeight : Infinity,
          };
          clipping.set(parent, clip);
        }
        // Gap tolerance stays inside clipping boundaries so a phone's screen edge can cancel
        if (point.x < clip.left || point.x > clip.right || point.y < clip.top || point.y > clip.bottom)
          return false;
        left = Math.max(left, clip.left);
        right = Math.min(right, clip.right);
        top = Math.max(top, clip.top);
        bottom = Math.min(bottom, clip.bottom);
      }
      if (left >= right || top >= bottom) return false;
      droppableRects.set(id, { left, right, top, bottom, width: right - left, height: bottom - top });
      return true;
    });
    const visible = { ...args, droppableRects, droppableContainers };
    const inside = pointerWithin(visible);
    if (!inside.length) {
      // Only visible row edges can catch a release in a gap
      return closestCenter({
        ...visible,
        droppableContainers: droppableContainers.filter(({ id, data }) => {
          if (data.current?.external) return false;
          const rect = droppableRects.get(id);
          return (
            rect &&
            Math.hypot(
              Math.max(rect.left - point.x, 0, point.x - rect.right),
              Math.max(rect.top - point.y, 0, point.y - rect.bottom),
            ) <= 24
          );
        }),
      });
    }
    return inside.sort((a, b) => {
      const aRect = droppableRects.get(a.id);
      const bRect = droppableRects.get(b.id);
      return (
        (aRect ? aRect.width * aRect.height : Infinity) - (bRect ? bRect.width * bRect.height : Infinity)
      );
    });
  };
  function pointerTarget(over: Over | null): SortableLocation | null {
    const id = dragging.current;
    if (!id || !over) return null;
    const container = over.data.current?.container as { parentId: string | null } | undefined;
    if (container) {
      const siblings =
        container.parentId === null ? items : (byId.get(container.parentId)?.node.children ?? []);
      return { parentId: container.parentId, index: siblings.filter((node) => node.id !== id).length };
    }
    const hovered = byId.get(String(over.id));
    const source = byId.get(id);
    if (!hovered || !source) return null;
    if (hovered.node.id === id) return { parentId: source.parentId, index: source.index };
    const x = ((pointer.current?.x ?? over.rect.left) - over.rect.left) / over.rect.width;
    const y = ((pointer.current?.y ?? over.rect.top) - over.rect.top) / over.rect.height;
    const fraction =
      orientation === 'horizontal' ? x : orientation === 'grid' ? (y < 0 ? 0 : y > 1 ? 1 : x) : y;
    if (hovered.node.children && fraction > 0.25 && fraction < 0.75) {
      return {
        parentId: hovered.node.id,
        index: hovered.node.children.filter((node) => node.id !== id).length,
      };
    }
    const slot = hovered.index + (fraction >= 0.5 ? 1 : 0);
    return {
      parentId: hovered.parentId,
      index: slot - (source.parentId === hovered.parentId && source.index < slot ? 1 : 0),
    };
  }
  const restoreFocus = useCallback(
    (id: string, previous?: HTMLElement | null) => {
      const focus = () =>
        requestAnimationFrame(() => {
          if (previous?.isConnected) previous.focus({ preventScroll: true });
          else document.getElementById(`${instructionId}-${id}`)?.focus({ preventScroll: true });
        });
      const revealed = onRevealItem?.(id);
      if (revealed) void revealed.then(focus);
      else focus();
    },
    [instructionId, onRevealItem],
  );
  const commit = useCallback(
    (id: string, location: SortableLocation) => {
      if (!valid(id, location)) {
        setRefusal(
          disabledReason ??
            byId.get(id)?.node.data.disabledReason ??
            dropReason?.(id, location) ??
            t({
              id: 'sortable.destinationUnavailable',
              message:
                'This destination is unavailable.  Check the item’s lock, folder depth, and allowed order.',
            }),
        );
        return;
      }
      setRefusal(undefined);
      const previous =
        document.activeElement instanceof HTMLElement &&
        document.activeElement.closest('[data-sortable-id]')?.getAttribute('data-sortable-id') === id
          ? document.activeElement
          : null;
      completed.current = { id, target: location, before: items };
      if (moveTree(movableTree, id, location, maxDepth, maxChildren) !== movableTree) onMove(id, location);
      setDropSerial((serial) => serial + 1);
      restoreFocus(id, previous);
    },
    [
      valid,
      items,
      movableTree,
      maxDepth,
      maxChildren,
      onMove,
      restoreFocus,
      disabledReason,
      byId,
      dropReason,
      t,
    ],
  );
  function finish(canceled: boolean, external = false) {
    const id = dragging.current;
    const original = byId.get(id ?? '');
    if (id && original) {
      const destination = resolve(id, pending.current);
      if (external) announce('drop', id, original);
      else if (!canceled && destination && valid(id, destination)) commit(id, destination);
      else announce('cancel', id, original);
    }
    dragging.current = null;
    nativeSource.current = null;
    pending.current = null;
    candidate.current = null;
    setActiveId(null);
    setRefusal(undefined);
    show(null, null);
  }
  const state = useMemo<SortableState>(
    () => ({
      nodes: movableTree,
      item: (id) => byId.get(id)?.node,
      target: (id, direction) => targetFor(items, id, direction),
      canMove(id, destination) {
        const target = typeof destination === 'string' ? targetFor(items, id, destination) : destination;
        return !!target && valid(id, target);
      },
      move(id, destination) {
        if (dragging.current) return;
        const target = typeof destination === 'string' ? targetFor(items, id, destination) : destination;
        if (target) commit(id, target);
      },
      disabledReason,
      instructionId,
      orientation,
      keyMap,
      progress,
    }),
    [
      movableTree,
      byId,
      targetFor,
      items,
      valid,
      commit,
      disabledReason,
      instructionId,
      orientation,
      keyMap,
      progress,
    ],
  );
  const sortableIds = useMemo(() => entries.map((entry) => entry.node.id), [entries]);
  const [accessibilityContainer, setAccessibilityContainer] = useState<HTMLDivElement | null>(null);
  return (
    <SortableStateContext.Provider value={state}>
      <DndContext
        sensors={sensors}
        collisionDetection={collisions}
        autoScroll={autoScrollOptions}
        accessibility={{
          container: accessibilityContainer ?? undefined,
          restoreFocus: false,
          screenReaderInstructions: { draggable: instructions },
          announcements: {
            onDragStart: () => undefined,
            onDragOver: () => undefined,
            onDragEnd: () => undefined,
            onDragCancel: () => undefined,
          },
        }}
        onDragStart={({ active, activatorEvent }) => {
          const id = String(active.id);
          const source = byId.get(id);
          if (!source) return;
          keyboard.current = activatorEvent.type === 'keydown';
          pointer.current = getEventCoordinates(activatorEvent);
          const target = activatorEvent.target;
          nativeSource.current =
            target instanceof Element
              ? (target.closest<HTMLElement>('[draggable="true"]') ??
                target.closest('[data-sortable-id]')?.querySelector<HTMLElement>('[draggable="true"]') ??
                null)
              : null;
          dragging.current = id;
          pending.current = anchor(id, source);
          candidate.current = pending.current;
          setRefusal(undefined);
          setActiveId(id);
          show(id, pending.current);
          announce('pick', id, source);
        }}
        onDragMove={({ over }) => {
          if (!keyboard.current) propose(pointerTarget(over));
        }}
        onDragOver={({ over }) => {
          if (!keyboard.current) propose(pointerTarget(over));
        }}
        onDragEnd={({ over }) => {
          let external = false;
          const source = nativeSource.current;
          const point = pointer.current;
          // Native destinations still receive their existing data and authorization path.
          if (!keyboard.current && source && point) {
            const destination = document.elementFromPoint(point.x, point.y);
            if (
              destination &&
              !source.contains(destination) &&
              !destination.closest('[data-sortable-id], [data-sortable-parent]')
            ) {
              const dataTransfer = new DataTransfer();
              source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
              if (dataTransfer.types.length) {
                const drop = new DragEvent('drop', {
                  bubbles: true,
                  cancelable: true,
                  dataTransfer,
                  clientX: point.x,
                  clientY: point.y,
                });
                destination.dispatchEvent(drop);
                external = drop.defaultPrevented;
              }
              source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
            }
          }
          finish(!keyboard.current && !over, external);
        }}
        onDragCancel={() => finish(true)}
      >
        <SortableContext items={sortableIds} strategy={() => null}>
          {children}
        </SortableContext>
        {createPortal(
          <DragOverlay dropAnimation={null} className="rio-sortable-overlay">
            {active ? (
              renderOverlay ? (
                renderOverlay(active.node)
              ) : (
                <span>
                  <Icon icon={faGripVertical} /> {active.node.data.name}
                </span>
              )
            ) : null}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
      {/* Instructions remain addressable while the single announcement region below reports moves. */}
      <div hidden ref={setAccessibilityContainer} />
      <p className="rio-sortable-refusal" role="status" aria-live="polite" aria-atomic="true">
        {refusal}
      </p>
      <span
        className="rio-sortable-announcement"
        role={announcement.text ? 'status' : undefined}
        aria-live="assertive"
        aria-atomic="true"
      >
        <span key={announcement.serial}>{announcement.text}</span>
      </span>
    </SortableStateContext.Provider>
  );
}

/** External folder and trash targets share the same destination checks as tree rows. */
export function SortableTarget({
  parentId,
  children,
  className,
  ...events
}: {
  parentId: string | null;
  children: ReactNode;
  className?: string;
} & Pick<HTMLAttributes<HTMLDivElement>, 'onDragOver' | 'onDrop'>) {
  const id = useId();
  const state = useSortableState();
  const { setNodeRef, isOver } = useDroppable({
    id: `target:${id}`,
    data: { container: { parentId }, external: true },
    disabled: Boolean(state.disabledReason),
  });
  return (
    <div
      ref={setNodeRef}
      {...events}
      className={cx('rio-sortable-target', className)}
      data-sortable-parent={parentId ?? '$root'}
      data-drop-target={isOver || undefined}
    >
      {children}
    </div>
  );
}

export function SortableList({
  items,
  onMove,
  ...props
}: Omit<SortableTreeProps, 'items' | 'maxDepth' | 'onMove'> & {
  items: readonly ({ id: string } & SortableItemData)[];
  onMove: (from: number, to: number) => void;
}) {
  const nodes = useMemo(() => items.map(({ id, ...data }) => ({ id, data })), [items]);
  const move = useCallback(
    (id: string, target: SortableLocation) =>
      onMove(
        items.findIndex((item) => item.id === id),
        target.index,
      ),
    [items, onMove],
  );
  return <SortableRoot {...props} tree={false} maxDepth={1} items={nodes} onMove={move} />;
}

export type SortableWrapperProps = HTMLAttributes<HTMLElement> & {
  ref: RefCallback<HTMLElement>;
  'data-sortable-id': string;
  'data-dragging': boolean | undefined;
  'data-drop-before': boolean | undefined;
  'data-orientation': SortableOrientation;
  'data-sortable-controls': boolean | undefined;
  'data-sortable-menu': boolean | undefined;
};
export interface SortableItemProps {
  id: string;
  className?: string;
  as?: ElementType;
  /** Receives the wrapper ref and attributes for composite or semantic items */
  renderWrapper?: (props: SortableWrapperProps, children: ReactNode) => ReactNode;
  keyboardActivator?: 'handle' | 'item';
  altMoveScope?: 'handle' | 'row';
  children: ReactNode | ((handle: ReactNode) => ReactNode);
}
type SortableBinding = Pick<
  ReturnType<typeof useSortable>,
  'attributes' | 'listeners' | 'setActivatorNodeRef'
> & { showGrip: boolean };
const SortableBindingContext = createContext<SortableBinding | null>(null);

export function SortableItem({ children, ...props }: SortableItemProps) {
  return (
    <SortableItemShell {...props}>
      {props.as === 'tr' ? (
        typeof children === 'function' ? (
          children(null)
        ) : (
          children
        )
      ) : (
        <SortableItemContent id={props.id} keyboardActivator={props.keyboardActivator}>
          {children}
        </SortableItemContent>
      )}
    </SortableItemShell>
  );
}

// Drag context updates reach the wrapper and grip without rerendering editable row controls
const SortableItemContent = memo(function SortableItemContent({
  children,
}: Pick<SortableItemProps, 'id' | 'keyboardActivator' | 'children'>) {
  return typeof children === 'function' ? children(null) : children;
});

function SortableItemShell({
  id,
  className,
  children,
  as = 'div',
  renderWrapper,
  keyboardActivator = 'handle',
  altMoveScope = 'handle',
}: Omit<SortableItemProps, 'children'> & { children: ReactNode }) {
  const state = useSortableState();
  const { t } = useLingui();
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [hasControls, setHasControls] = useState(false);
  const [hasMenu, setHasMenu] = useState(false);
  const [actionsNeeded, setActionsNeeded] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(hover: none)').matches,
  );
  useLayoutEffect(() => {
    const node = element;
    if (!node) return;
    const owned = (selector: string) =>
      [...node.querySelectorAll(selector)].some(
        (control) =>
          control.closest('[data-sortable-id]') === node && !control.closest('.rio-sortable-actions'),
      );
    const update = () => {
      setHasControls(
        owned(
          'input:not([type="checkbox"]):not([type="radio"]), textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]',
        ),
      );
      setHasMenu(owned('[aria-haspopup="menu"], [aria-haspopup="true"]'));
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(node, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-haspopup', 'contenteditable'],
    });
    return () => observer.disconnect();
  }, [element]);
  const item = state.item(id);
  const reason = state.disabledReason ?? item?.data.disabledReason;
  const flags = useSyncExternalStore(
    state.progress.subscribe,
    () => {
      const progress = state.progress.get();
      return (progress.activeId === id ? 1 : 0) | (progress.beforeId === id ? 2 : 0);
    },
    () => 0,
  );
  const { attributes, listeners, setNodeRef, setActivatorNodeRef } = useSortable({
    id,
    disabled: !!reason,
    animateLayoutChanges: () => false,
    transition: null,
  });
  const attach = useCallback(
    (node: HTMLElement | null) => {
      setElement(node);
      setNodeRef(node);
      if (keyboardActivator === 'item') setActivatorNodeRef(node);
    },
    [setNodeRef, setActivatorNodeRef, keyboardActivator],
  );
  const name = item?.data.name ?? '';
  const activatorId = `${state.instructionId}-${id}`;
  const reasonId = useId();
  const shortcut = (event: React.KeyboardEvent<HTMLElement>) => {
    const target = event.target;
    if (
      target instanceof Element &&
      !target.closest('.rio-sortable-handle') &&
      target.closest(
        'input, textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]',
      )
    )
      return false;
    const direction = state.keyMap[event.code || event.key];
    if (event.altKey && direction && !reason) {
      event.preventDefault();
      event.stopPropagation();
      state.move(id, direction);
      return true;
    }
    return false;
  };
  const wrapper: SortableWrapperProps = {
    ref: attach,
    className: cx('rio-sortable-item', className),
    'data-sortable-id': id,
    'data-dragging': !!(flags & 1) || undefined,
    'data-drop-before': !!(flags & 2) || undefined,
    'data-orientation': state.orientation,
    'data-sortable-controls': hasControls || undefined,
    'data-sortable-menu': !hasMenu || undefined,
    onPointerEnter() {
      setActionsNeeded(true);
    },
    onFocusCapture() {
      setActionsNeeded(true);
    },
    onPointerDown(event) {
      if ((event.target as Element).closest('[data-sortable-id]') === event.currentTarget)
        listeners?.onPointerDown?.(event);
    },
    onTouchStart(event) {
      if ((event.target as Element).closest('[data-sortable-id]') === event.currentTarget)
        listeners?.onTouchStart?.(event);
    },
    ...(keyboardActivator === 'item'
      ? {
          id: activatorId,
          tabIndex: 0,
          'aria-label': name,
          'aria-disabled': !!reason || undefined,
          'aria-describedby': reason ? reasonId : attributes['aria-describedby'],
          'aria-roledescription': t({ id: 'sortable.role', message: 'Movable item' }),
          title: reason,
        }
      : {}),
    onKeyDown(event) {
      if (event.defaultPrevented || reason) return;
      if ((altMoveScope === 'row' || keyboardActivator === 'item') && shortcut(event)) return;
      if (keyboardActivator === 'item' && event.target === event.currentTarget) listeners?.onKeyDown?.(event);
    },
  };
  const menuLabel = t({ id: 'sortable.menu.label', message: `Arrange ${name}` });
  const destinations = () => {
    const nodes = flattenTree(state.nodes);
    const source = nodes.find((entry) => entry.node.id === id);
    const siblings = source?.parentId ? (state.item(source.parentId)?.children ?? []) : state.nodes;
    return [
      ...siblings.map((_, index) => ({
        id: `$sort-position-${index}`,
        name: t({ id: 'sortable.menu.position', message: `Position ${index + 1}` }),
        location: { parentId: source?.parentId ?? null, index },
      })),
      ...nodes
        .filter((entry) => entry.node.children && entry.node.id !== id)
        .map((entry) => ({
          id: `$sort-folder-${entry.node.id}`,
          name: entry.node.data.name,
          location: {
            parentId: entry.node.id,
            index: entry.node.children!.filter((node) => node.id !== id).length,
          },
        })),
      ...(source?.parentId
        ? [
            {
              id: '$sort-root',
              name: t({ id: 'sortable.menu.root', message: 'Top level' }),
              location: { parentId: null, index: state.nodes.filter((node) => node.id !== id).length },
            },
          ]
        : []),
    ];
  };
  const handle = <SortableHandle id={id} keyboardActivator={keyboardActivator} />;
  const actions =
    actionsNeeded && !hasMenu && !reason ? (
      <span className="rio-sortable-actions">
        <SortableActions label={menuLabel} />
      </span>
    ) : null;
  // Table rows keep their controls inside cells so the browser preserves table layout.
  const cells = as === 'tr' ? Children.toArray(children) : [];
  const contents =
    as === 'tr' ? (
      cells.map((cell, index) => {
        if (!isValidElement(cell)) return cell;
        const element = cell as ReactElement<{ children?: ReactNode }>;
        return cloneElement(
          element,
          {},
          <>
            {index === 0 ? handle : null}
            {element.props.children}
            {index === cells.length - 1 ? actions : null}
          </>,
        );
      })
    ) : (
      <>
        {children}
        {handle}
        {actions}
      </>
    );
  const content = renderWrapper ? renderWrapper(wrapper, contents) : createElement(as, wrapper, contents);
  return (
    <SortableItemMenuContext.Provider
      value={
        reason
          ? null
          : {
              canMove: (target) => state.canMove(id, target),
              move: (target) => state.move(id, target),
              get destinations() {
                return destinations();
              },
              labels: {
                up: t({ id: 'sortable.menu.up', message: 'Move up' }),
                down: t({ id: 'sortable.menu.down', message: 'Move down' }),
                to: t({ id: 'sortable.menu.to', message: 'Move to' }),
              },
            }
      }
    >
      <SortableBindingContext.Provider
        value={{ attributes, listeners, setActivatorNodeRef, showGrip: hasControls }}
      >
        {content}
        {keyboardActivator === 'item' &&
          reason &&
          createPortal(
            <span id={reasonId} className="rio-sortable-description">
              {reason}
            </span>,
            document.body,
          )}
      </SortableBindingContext.Provider>
    </SortableItemMenuContext.Provider>
  );
}

function SortableActions({ label, tabIndex }: { label: string; tabIndex?: number }) {
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState<'first' | 'last'>('first');
  const anchor = useRef<HTMLElement | null>(null);
  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => anchor.current?.focus());
  };
  return (
    <>
      <Button
        excludeFromTabOrder={tabIndex === -1}
        variant="quiet"
        size="sm"
        icon={faEllipsis}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onPress={(event) => {
          anchor.current = event.target as HTMLElement;
          setFocus('first');
          setOpen(!open);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            anchor.current = event.currentTarget;
            setFocus(event.key === 'ArrowUp' ? 'last' : 'first');
            setOpen(true);
          }
        }}
      />
      {open ? (
        <Suspense fallback={null}>
          <SortableActionsMenu anchor={anchor} label={label} close={close} focus={focus} />
        </Suspense>
      ) : null}
    </>
  );
}

/** Virtualized record surfaces keep their existing gestures and use the shared movement menu. */
interface MovementProps {
  name: string;
  up?: () => void;
  down?: () => void;
  destinations: ReadonlyArray<{ id: string; name: string; move(): void }>;
}
export function SortableMovementProvider({
  up,
  down,
  destinations,
  children,
}: MovementProps & { children: ReactNode }) {
  const { t } = useLingui();
  return (
    <SortableItemMenuContext.Provider
      value={{
        canMove: (target) =>
          typeof target === 'string'
            ? !!(target === 'up' ? up : target === 'down' ? down : undefined)
            : !!destinations[target.index],
        move: (target) => {
          if (typeof target === 'string') (target === 'up' ? up : target === 'down' ? down : undefined)?.();
          else destinations[target.index]?.move();
        },
        destinations: destinations.map((destination, index) => ({
          ...destination,
          location: { parentId: null, index },
        })),
        labels: {
          up: t({ id: 'sortable.menu.up', message: 'Move up' }),
          down: t({ id: 'sortable.menu.down', message: 'Move down' }),
          to: t({ id: 'sortable.menu.to', message: 'Move to' }),
        },
      }}
    >
      {children}
    </SortableItemMenuContext.Provider>
  );
}
export function SortableMovementMenu({ tabIndex, ...props }: MovementProps & { tabIndex?: number }) {
  const { t } = useLingui();
  const name = props.name;
  return (
    <SortableMovementProvider {...props}>
      <span className="rio-sortable-actions">
        <SortableActions
          tabIndex={tabIndex}
          label={t({ id: 'sortable.menu.label', message: `Arrange ${name}` })}
        />
      </span>
    </SortableMovementProvider>
  );
}

function SortableHandle({
  id,
  keyboardActivator = 'handle',
}: Pick<SortableItemProps, 'id' | 'keyboardActivator'>) {
  const state = useSortableState();
  const { t } = useLingui();
  const [reasonOpen, setReasonOpen] = useState(false);
  const reasonAnchor = useRef<HTMLElement | null>(null);
  const item = state.item(id);
  const reason = state.disabledReason ?? item?.data.disabledReason;
  const { attributes, listeners, setActivatorNodeRef, showGrip } = useContext(SortableBindingContext)!;
  const name = item?.data.name ?? '';
  const label = item?.data.handleLabel ?? t({ id: 'sortable.handle', message: `Move ${name}` });
  const activatorId = `${state.instructionId}-${id}`;
  const shortcut = (event: React.KeyboardEvent<HTMLElement>) => {
    const direction = state.keyMap[event.code || event.key];
    if (event.altKey && direction && !reason) {
      event.preventDefault();
      event.stopPropagation();
      state.move(id, direction);
      return true;
    }
    return false;
  };
  const button = (
    <button
      {...attributes}
      {...listeners}
      ref={keyboardActivator === 'handle' ? setActivatorNodeRef : undefined}
      id={keyboardActivator === 'handle' ? activatorId : undefined}
      type="button"
      className="rio-sortable-handle"
      disabled={!!reason}
      aria-hidden={keyboardActivator === 'item' || (!!state.disabledReason && !showGrip) || undefined}
      aria-label={label}
      title={reason ?? label}
      aria-roledescription={t({ id: 'sortable.role', message: 'Movable item' })}
      tabIndex={keyboardActivator === 'item' ? -1 : attributes.tabIndex}
      aria-describedby={keyboardActivator === 'handle' ? attributes['aria-describedby'] : undefined}
      aria-keyshortcuts={
        keyboardActivator === 'handle'
          ? [
              'Space',
              'Enter',
              'Escape',
              ...Object.keys(state.keyMap)
                .filter((key) => state.keyMap[key])
                .flatMap((key) => [key, `Alt+${key}`]),
            ].join(' ')
          : undefined
      }
      onKeyDown={(event) => {
        if (!shortcut(event) && keyboardActivator === 'handle') listeners?.onKeyDown?.(event);
      }}
    >
      {showGrip ? <Icon icon={faGripVertical} /> : null}
    </button>
  );
  const handle = reason ? (
    <>
      <span
        ref={reasonAnchor}
        className="rio-sortable-grip"
        role="group"
        tabIndex={keyboardActivator === 'handle' ? 0 : -1}
        aria-label={reason}
        aria-hidden={keyboardActivator === 'item' || undefined}
        onFocus={() => setReasonOpen(true)}
        onBlur={() => setReasonOpen(false)}
        onPointerEnter={() => setReasonOpen(true)}
        onPointerLeave={() => setReasonOpen(false)}
      >
        {button}
      </span>
      {reasonOpen ? (
        <Suspense fallback={null}>
          <ButtonTooltip anchor={reasonAnchor} label={reason} close={() => setReasonOpen(false)} />
        </Suspense>
      ) : null}
    </>
  ) : (
    button
  );
  return handle;
}

/** The last slot remains reachable even in an empty nested container */
export function SortableDropZone({ parentId = null }: { parentId?: string | null }) {
  const state = useSortableState();
  const { t } = useLingui();
  const flags = useSyncExternalStore(
    state.progress.subscribe,
    () => {
      const progress = state.progress.get();
      return (progress.activeId ? 1 : 0) | (progress.endParent === parentId ? 2 : 0);
    },
    () => 0,
  );
  const { setNodeRef } = useDroppable({
    id: `container:${parentId ?? '$root'}`,
    data: { container: { parentId } },
    disabled: !!state.disabledReason,
  });
  return (
    <div
      ref={setNodeRef}
      className="rio-sortable-end"
      data-sortable-container={parentId ?? '$root'}
      data-orientation={state.orientation}
      data-active={!!(flags & 1) || undefined}
      data-drop-before={!!(flags & 2) || undefined}
      aria-hidden="true"
    >
      {t({ id: 'sortable.destination', message: 'Move here' })}
    </div>
  );
}
