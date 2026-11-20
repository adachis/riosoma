import { personLabel } from '../../../../data/people';
import { shortcutKeys } from '../../../../shortcuts/registry';
import {
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { faChevronRight, faPen, faPlus } from '@fortawesome/free-solid-svg-icons';
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import {
  cellValue,
  isComputedType,
  newId,
  roleAllows,
  sameValue,
  visibleFieldIds,
  type CellValue,
  type ChoiceColor,
  type FieldMeta,
  type RowData,
} from '@riosoma/contracts';
import { Icon } from '@riosoma/icons';
import {
  Avatar,
  avatarInitials,
  Button,
  ChoicePill,
  PersonDirectory,
  SortableMovementMenu,
  toast,
} from '@riosoma/ui';
import { editText, formatCell } from '../../../../grid/format';
import { parseText } from '../../../../grid/parse';
import { reportError } from '../../../../grid/view/actions';
import type { CommandInput } from '../../../../data/types';
import { serverMessage } from '../../../../messages/useServerMessage';
import { colorDescription } from '../../colors/dom';
import { lineColor } from '../../colors/paint';
import { Painted } from '../../colors/Painted';
import { followsValues } from '../../joins/matched';
import { sourceReadOnly } from '../../synced/override';
import { CardValue } from '../CardValue';
import { showsText } from '../showsText';
import { MAX_RECORDS, useViewRecords } from '../timeline/records';
import type { ViewComponentProps } from '../types';
import {
  EMPTY_GROUP,
  destinationAt,
  groupLineKey,
  groupStart,
  groupValues,
  listMode,
  listModel,
  neighborGroup,
  neighborParent,
  parentValues,
  stepDestination,
  type Destination,
  type ListModel,
  type RecordLine,
} from './model';
import { dropRefusal } from '../drag/rules';
import { useHeld, useViewDrag, type DragPoint } from '../drag/useViewDrag';
import './list.css';

/** Every line is this tall, in CSS pixels, so a line's place is its number times this. */
export const LINE_HEIGHT = 44;
/** How far each level of an outline steps in. */
const INDENT = 24;
/** Lines drawn past each edge of the view, so a quick scroll never shows a gap. */
const OVERSCAN = 6;
/** The height to lay out for until the list has been measured. */
const FALLBACK_HEIGHT = 600;

interface GroupInfo {
  name: string;
  color?: ChoiceColor;
  person?: boolean;
}

interface Editing {
  key: string;
  text: string;
  error: string | null;
}

interface Drag {
  key: string;
  /** The lines as they were when the drag began, so nothing moves under the pointer */
  model: ListModel;
  /**
   * The line an outline marks as where a drop goes: the record it would nest under, or with the
   * top level as the destination, the line under the pointer
   */
  mark: string | null;
  /** The line a drop goes just before or just after, in the list's own order */
  edge: { key: string; side: 'before' | 'after' } | null;
  destination: Destination | null;
}

export function ListView(props: ViewComponentProps) {
  const { list } = props.view.config;
  // A new layout starts with every group and record open, and the first line active.
  return <List key={`${props.view.id}:${list.groupFieldId ?? ''}:${list.parentFieldId ?? ''}`} {...props} />;
}

function List(props: ViewComponentProps) {
  const { t, i18n } = useLingui();
  const directory = useContext(PersonDirectory);
  const moveLeft = shortcutKeys('views.moveLeft');
  const moveRight = shortcutKeys('views.moveRight');
  const moveUp = shortcutKeys('views.moveUp');
  const moveDown = shortcutKeys('views.moveDown');

  const { session, view, table, fields, format, onExpand, colors } = props;
  const gesture = useViewDrag();
  const records = useHeld(useViewRecords(session, view.id), gesture.holding);
  const mode = useMemo(() => listMode(view.config.list, fields), [view.config.list, fields]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [active, setActive] = useState<{ key: string; index: number } | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [bounds, setBounds] = useState({ height: FALLBACK_HEIGHT, scroll: 0 });
  const [focused, setFocused] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  /** A line to bring into sight after the next render, and whether it takes the focus too */
  const pending = useRef<{ key: string; focus: boolean } | null>(null);
  const suppressClick = gesture.suppressClick;
  const baseId = useId();
  const instructionsId = `${baseId}-instructions`;
  const sortedId = `${baseId}-sorted`;

  const primary = fields.find((field) => field.id === table.primaryFieldId);
  const modeField = mode.kind === 'flat' ? null : mode.field;
  // The group or parent already shows in the list's shape, so its values don't repeat on each line.
  const shownFields = visibleFieldIds(view.config, fields, table.primaryFieldId)
    .filter((id) => id !== table.primaryFieldId && id !== modeField?.id)
    .slice(0, view.config.list.visibleFieldCount)
    .flatMap((id) => fields.find((field) => field.id === id) ?? []);
  // Editing and moving records takes the role that edits records, not the one that changes the view.
  const canEditRecords = !props.readOnly && roleAllows(session.role(), 'editRecords');
  const writable = (field: FieldMeta | null | undefined): field is FieldMeta =>
    !!field &&
    canEditRecords &&
    !isComputedType(field.type) &&
    !sourceReadOnly(field, table) &&
    !followsValues(field);
  const canRename = writable(primary);
  const canMove = writable(modeField);
  // A list keeps its own order while it has no sort, and whoever edits records can arrange it.
  const sorted = view.config.sorts.length > 0;
  const canOrder = canEditRecords && !sorted;
  const canDrag = canMove || canOrder;

  const untitled = t({ id: 'views.list.untitled', message: 'Untitled record' });
  const fieldName = modeField?.name ?? '';
  const emptyName = t({ id: 'views.list.group.empty', message: `No ${fieldName}` });
  const unknownPerson = t({ id: 'views.list.group.unknownPerson', message: 'Unknown person' });
  const groupInfo = (key: string): GroupInfo => {
    if (mode.kind !== 'group' || key === EMPTY_GROUP) return { name: emptyName };
    const field = mode.field;
    if (field.type === 'singleSelect') {
      const choice = field.options.choices.find((item) => item.id === key);
      return { name: choice?.name ?? emptyName, color: choice?.color };
    }
    if (field.type === 'user')
      return { name: personLabel(format.collaborators.get(key), unknownPerson), person: true };
    return { name: format.linked?.get(key) || untitled };
  };
  const title = (row: RowData | undefined) =>
    (row && primary ? formatCell(primary, cellValue(row, primary), format) : '') || untitled;
  const numbers = useMemo(() => new Intl.NumberFormat(format.locale), [format.locale]);

  const model = useMemo(() => {
    const collator = new Intl.Collator(format.locale, { numeric: true, sensitivity: 'base' });
    const rank =
      mode.kind === 'group' && mode.field.type === 'singleSelect'
        ? new Map(mode.field.options.choices.map((choice, index) => [choice.id, index]))
        : null;
    const name = (key: string) =>
      mode.kind === 'group' && mode.field.type === 'user'
        ? (format.collaborators.get(key)?.name ?? '')
        : (format.linked?.get(key) ?? '');
    // Options keep the field's order, people and records go by name, and the empty group comes last.
    const sortGroups = (keys: string[]) =>
      [...keys].sort((a, b) => {
        if (a === EMPTY_GROUP || b === EMPTY_GROUP)
          return a === EMPTY_GROUP ? (b === EMPTY_GROUP ? 0 : 1) : -1;
        if (rank) return (rank.get(a) ?? 0) - (rank.get(b) ?? 0);
        return collator.compare(name(a), name(b)) || (a < b ? -1 : a > b ? 1 : 0);
      });
    return listModel(records.rows, mode, collapsed, sortGroups);
  }, [records.rows, mode, collapsed, format.locale, format.collaborators, format.linked]);

  const shown = drag?.model ?? model;
  const lines = shown.lines;
  const lineIndex = useMemo(() => new Map(lines.map((line, index) => [line.key, index])), [lines]);
  const activeIndex = active
    ? (lineIndex.get(active.key) ?? Math.min(active.index, lines.length - 1))
    : lines.length
      ? 0
      : -1;
  const activeLine = activeIndex >= 0 ? lines[activeIndex] : undefined;

  const first = Math.max(0, Math.floor(bounds.scroll / LINE_HEIGHT) - OVERSCAN);
  const last = Math.min(lines.length, Math.ceil((bounds.scroll + bounds.height) / LINE_HEIGHT) + OVERSCAN);
  const drawn: number[] = [];
  for (let index = first; index < last; index++) drawn.push(index);
  // The line with the focus stays drawn when it scrolls away, so the focus never drops.  Without
  // the focus, the list itself takes Tab and hands it to the first line in sight.
  const activeInSight = activeIndex >= first && activeIndex < last;
  if (activeIndex >= 0 && !activeInSight && focused) drawn.push(activeIndex);
  const activeDrawn = activeIndex >= 0 && (activeInSight || focused);

  // Paging replaces a focused placeholder, so its record must take over the keyboard position.
  useLayoutEffect(() => {
    if (!focused || !active || lineIndex.has(active.key) || !activeLine) return;
    const node = nodes.current.get(activeLine.key);
    if (!node) return;
    node.focus({ preventScroll: true });
    setActive({ key: activeLine.key, index: activeIndex });
  }, [active, activeLine, activeIndex, focused, lineIndex]);

  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const measure = () => setBounds({ height: node.clientHeight || FALLBACK_HEIGHT, scroll: node.scrollTop });
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // A line asked for scrolls into sight first, which draws it, and then takes the focus.
  useLayoutEffect(() => {
    const wanted = pending.current;
    const node = viewport.current;
    if (!wanted || !node) return;
    const index = lineIndex.get(wanted.key);
    if (index === undefined) return;
    const top = index * LINE_HEIGHT;
    const height = node.clientHeight || FALLBACK_HEIGHT;
    const scroll =
      top < node.scrollTop
        ? top
        : top + LINE_HEIGHT > node.scrollTop + height
          ? top + LINE_HEIGHT - height
          : node.scrollTop;
    if (scroll !== node.scrollTop) {
      node.scrollTop = scroll;
      setBounds({ height, scroll: node.scrollTop });
    }
    if (!wanted.focus) {
      pending.current = null;
      return;
    }
    const target = nodes.current.get(wanted.key);
    if (target) {
      target.focus({ preventScroll: true });
      // Virtualized lines can move during the scroll render and lose browser focus.
      const frame = requestAnimationFrame(() => {
        const current = nodes.current.get(wanted.key);
        if (current && document.activeElement === document.body) current.focus({ preventScroll: true });
        if (pending.current === wanted) pending.current = null;
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [lineIndex, active, editing, bounds]);

  function focusLine(index: number) {
    const line = lines[index];
    if (!line) return;
    setActive({ key: line.key, index });
    pending.current = { key: line.key, focus: true };
    // A key at either end changes nothing, so a line already drawn takes the focus now.
    const node = nodes.current.get(line.key);
    if (node && document.activeElement !== node) node.focus({ preventScroll: true });
  }

  function toggle(key: string, open?: boolean) {
    setCollapsed((current) => {
      const isOpen = !current.has(key);
      if ((open ?? !isOpen) === isOpen) return current;
      const next = new Set(current);
      if (isOpen) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function movementTarget(line: RecordLine, direction: -1 | 1): Destination | null {
    if (canOrder) return stepDestination(shown, line, direction, mode.kind === 'group' && canMove);
    if (mode.kind === 'group' && canMove) {
      const group = neighborGroup(shown, line, direction);
      return group === null ? null : { kind: 'group', group };
    }
    return null;
  }

  function move(line: RecordLine, destination: Destination) {
    if (!line.row) return;
    // Read the record again, so a move never undoes a more recent change to it.
    const row = session.cachedRecord(table.id, line.row.id) ?? line.row;
    const reason = dropRefusal(
      props,
      row,
      destination.kind === 'order' || !modeField ? [] : [modeField],
      !!destination.place,
    );
    if (reason) {
      gesture.setStatus(gesture.reasons[reason]);
      return;
    }
    const commands: CommandInput[] = [];
    let key = line.key;
    let message: string;
    if (destination.kind === 'order') {
      if (!canOrder) return;
      const place = destination.place;
      const name = title(session.cachedRecord(table.id, 'before' in place ? place.before : place.after));
      message =
        'before' in place
          ? t({ id: 'views.list.movedBefore', message: `Moved before ${name}` })
          : t({ id: 'views.list.movedAfter', message: `Moved after ${name}` });
    } else {
      if (!canMove || !modeField) return;
      let values: Record<string, CellValue>;
      if (destination.kind === 'group' && line.group !== null) {
        values = groupValues(row, modeField, line.group, destination.group);
        key = `${destination.group}/${row.id}`;
        const group = groupInfo(destination.group).name;
        message = t({ id: 'views.list.moved', message: `Moved to ${group}` });
      } else if (destination.kind === 'parent') {
        values = parentValues(row, modeField, line.parent, destination.parent);
        key = row.id;
        const parent =
          destination.parent === null ? null : title(session.cachedRecord(table.id, destination.parent));
        message =
          parent === null
            ? t({ id: 'views.list.movedOut', message: 'Moved to the top level' })
            : t({ id: 'views.list.nested', message: `Nested under ${parent}` });
      } else return;
      if (!sameValue(values[modeField.id], cellValue(row, modeField)))
        commands.push({ kind: 'record.update', tableId: table.id, records: [{ id: row.id, values }] });
    }
    // Where it lands among its new siblings, in the list's own order.
    const place = destination.place;
    if (place && canOrder)
      commands.push({ kind: 'record.move', tableId: table.id, viewId: view.id, recordIds: [row.id], place });
    if (!commands.length) return;
    try {
      session.run(commands);
    } catch (error) {
      reportError(error);
      return;
    }
    // Whatever it moved into opens, so the record stays in sight with the focus.
    if (destination.kind === 'group') toggle(groupLineKey(destination.group), true);
    else if (destination.kind === 'parent' && destination.parent !== null) toggle(destination.parent, true);
    gesture.setStatus(message);
    setActive({ key, index: activeIndex });
    // The record comes into sight where it lands, and keeps the focus when it had it.
    pending.current = { key, focus: !!viewport.current?.contains(document.activeElement) };
  }

  function startEditing(line: RecordLine) {
    if (!canRename || !line.row || !primary) return;
    setActive({ key: line.key, index: lineIndex.get(line.key) ?? activeIndex });
    setEditing({ key: line.key, text: editText(primary, cellValue(line.row, primary), format), error: null });
  }

  /** Saves typed text in the record's first field, or says why the field can't hold it. */
  function save(line: RecordLine, text: string): string | null {
    if (!primary || !line.row) return null;
    const parsed = parseText(primary, text, format);
    if (parsed.ok !== true)
      return serverMessage(
        i18n,
        parsed.ok === false && parsed.reason === 'notNumber'
          ? 'data.value.notNumber'
          : parsed.ok === false && parsed.reason === 'notDate'
            ? 'data.value.notDate'
            : parsed.ok === false && parsed.reason !== 'computed'
              ? parsed.reason
              : 'data.value.invalid',
      );
    const row = session.cachedRecord(table.id, line.row.id) ?? line.row;
    if (sameValue(parsed.value, cellValue(row, primary))) return null;
    try {
      session.run([
        {
          kind: 'record.update',
          tableId: table.id,
          records: [{ id: row.id, values: { [primary.id]: parsed.value } }],
        },
      ]);
    } catch (error) {
      reportError(error);
    }
    return null;
  }

  /** Ends editing with Enter or Escape, and returns false when what was typed can't be saved. */
  function finishEditing(line: RecordLine, keep: boolean, text: string): boolean {
    if (keep) {
      const problem = save(line, text);
      if (problem) {
        setEditing({ key: line.key, text, error: problem });
        return false;
      }
    }
    setEditing(null);
    pending.current = { key: line.key, focus: true };
    return true;
  }

  /** Ends editing when the focus goes elsewhere, which keeps what was typed when it fits. */
  function leaveEditing(line: RecordLine, text: string) {
    const problem = save(line, text);
    if (problem) toast.show({ title: problem, tone: 'danger' });
    setEditing(null);
  }

  function create() {
    if (table.source || table.joined || !canEditRecords) return;
    const line = activeLine?.kind === 'record' ? activeLine : undefined;
    let values: Record<string, CellValue> = {};
    if (line && mode.kind === 'group' && line.group !== null && canMove)
      values = groupStart(mode.field, line.group);
    if (line && mode.kind === 'outline' && line.parent !== null && canMove)
      values = { [mode.field.id]: [line.parent] };
    const id = newId('record');
    const commands: CommandInput[] = [
      { kind: 'record.create', tableId: table.id, records: [{ id, values }] },
    ];
    // The list's own order keeps it there, where it would otherwise go last.
    if (line?.row && canOrder)
      commands.push({
        kind: 'record.move',
        tableId: table.id,
        viewId: view.id,
        recordIds: [id],
        place: { after: line.row.id },
      });
    try {
      // Placed just after the active record, the way the grid inserts a record below another.
      session.run(commands, line ? { placeAt: { viewId: view.id, index: line.index + 1 } } : undefined);
      onExpand(id);
    } catch (error) {
      reportError(error);
    }
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.ctrlKey || event.metaKey || event.nativeEvent.isComposing || drag) return;
    const key = event.target instanceof HTMLElement ? event.target.dataset.line : undefined;
    const index = key === undefined ? -1 : (lineIndex.get(key) ?? -1);
    const line = lines[index];
    if (!line) return;
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const back = rtl ? 'ArrowRight' : 'ArrowLeft';
    if (event.altKey) {
      if (line.kind !== 'record') return;
      let destination: Destination | null;
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        const step = event.key === 'ArrowUp' ? -1 : 1;
        // Up and down move a record among its siblings, and on into the next group from either end.
        destination = movementTarget(line, step);
      } else if (mode.kind === 'outline' && canMove && (event.key === forward || event.key === back))
        destination = neighborParent(shown, line, event.key === forward ? 'in' : 'out');
      else return;
      event.preventDefault();
      if (destination) move(line, destination);
      return;
    }
    const page = Math.max(1, Math.floor(bounds.height / LINE_HEIGHT) - 1);
    switch (event.key) {
      case 'ArrowDown':
        focusLine(Math.min(lines.length - 1, index + 1));
        break;
      case 'ArrowUp':
        focusLine(Math.max(0, index - 1));
        break;
      case 'PageDown':
        focusLine(Math.min(lines.length - 1, index + page));
        break;
      case 'PageUp':
        focusLine(Math.max(0, index - page));
        break;
      case 'Home':
        focusLine(0);
        break;
      case 'End':
        focusLine(lines.length - 1);
        break;
      case forward:
        if (line.kind === 'group' || line.children > 0) {
          if (!line.expanded) toggle(line.key, true);
          else focusLine(index + 1);
        }
        break;
      case back:
        if ((line.kind === 'group' || line.children > 0) && line.expanded) toggle(line.key, false);
        else if (line.kind === 'record' && line.group !== null)
          focusLine(lineIndex.get(groupLineKey(line.group)) ?? index);
        else if (line.kind === 'record' && line.parent !== null)
          focusLine(lineIndex.get(line.parent) ?? index);
        break;
      case 'Enter':
        if (line.kind === 'group') toggle(line.key);
        else if (line.row) onExpand(line.row.id);
        break;
      case 'F2':
        if (line.kind === 'record') startEditing(line);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  function startDrag(event: ReactPointerEvent, line: RecordLine) {
    const node = viewport.current;
    if (props.readOnly || !canDrag || event.button !== 0 || !line.row || editing || !node) return;
    event.stopPropagation();
    const held = model;
    /** The line under the pointer, and where dropping there would put the record. */
    const locate = (next: DragPoint): Drag => {
      const rect = node.getBoundingClientRect();
      const y = next.clientY - rect.top + node.scrollTop;
      const index = Math.floor(y / LINE_HEIGHT);
      const target = held.lines[index];
      const fraction = (y - index * LINE_HEIGHT) / LINE_HEIGHT;
      const destination = target ? destinationAt(held, line, target, fraction, canOrder) : null;
      // A mark shows the group or record a drop goes into, and an edge the spot between two records
      // it goes to in the list's own order.
      const place = destination?.place;
      const mark =
        destination?.kind !== 'parent'
          ? null
          : place
            ? destination.parent
            : (destination.parent ?? target?.key ?? null);
      const edge: Drag['edge'] =
        place && target ? { key: target.key, side: 'before' in place ? 'before' : 'after' } : null;
      return { key: line.key, model: held, mark, edge, destination };
    };
    const reasonFor = (destination: Destination | null) =>
      destination
        ? dropRefusal(
            props,
            line.row,
            destination.kind === 'order' || !modeField ? [] : [modeField],
            !!destination.place,
          )
        : null;
    gesture.start(event, {
      scroll: node,
      move(point) {
        const next = locate(point);
        setDrag((current) =>
          current?.key === next.key &&
          current.mark === next.mark &&
          current.edge?.key === next.edge?.key &&
          current.edge?.side === next.edge?.side &&
          JSON.stringify(current.destination) === JSON.stringify(next.destination)
            ? current
            : next,
        );
        const reason = reasonFor(next.destination);
        const target = nodes.current.get(next.edge?.key ?? next.mark ?? '') ?? node;
        gesture.mark(
          target,
          reason
            ? gesture.reasons[reason]
            : t({ id: 'views.list.dropHere', message: 'Drop here to move the record.' }),
          !!reason,
        );
      },
      drop(point) {
        const next = locate(point);
        if (next.destination && !reasonFor(next.destination)) move(line, next.destination);
      },
      finish() {
        setDrag(null);
      },
    });
  }

  const instructions = [
    t({
      id: 'views.list.instructions',
      message:
        'Use the arrow keys to move between records, Enter to open one, and F2 to edit its first field.',
    }),
    canOrder && mode.kind === 'group' && canMove
      ? t({
          id: 'views.list.instructions.orderGroup',
          message: `${moveUp} or ${moveDown} moves a record up or down, and on into the group before or after from either end of its group.`,
        })
      : canOrder
        ? t({
            id: 'views.list.instructions.order',
            message: `${moveUp} or ${moveDown} moves a record up or down.`,
          })
        : mode.kind === 'group' && canMove
          ? t({
              id: 'views.list.instructions.group',
              message: `${moveUp} or ${moveDown} moves a record to the group before or after.`,
            })
          : '',
    mode.kind === 'outline'
      ? t({
          id: 'views.list.instructions.outline',
          message: 'The right and left arrows open and close the records nested under a record.',
        })
      : '',
    mode.kind === 'outline' && canMove
      ? t({
          id: 'views.list.instructions.nest',
          message: `${moveRight} nests a record under the one above it, and ${moveLeft} moves it out a level.`,
        })
      : '',
  ]
    .filter(Boolean)
    .join('  ');
  const dropGroup = drag?.destination?.kind === 'group' ? drag.destination.group : null;
  const shortcuts =
    [
      'Enter',
      canRename ? 'F2' : '',
      canOrder || (canMove && mode.kind === 'group') ? 'Alt+ArrowUp Alt+ArrowDown' : '',
      canMove && mode.kind === 'outline' ? 'Alt+ArrowRight Alt+ArrowLeft' : '',
    ]
      .filter(Boolean)
      .join(' ') || undefined;

  function renderLine(index: number) {
    const line = lines[index]!;
    const common = {
      role: 'treeitem',
      'aria-level': line.level,
      'aria-posinset': line.position,
      'aria-setsize': line.size,
      tabIndex: index === activeIndex && !editing ? 0 : -1,
      'data-line': line.key,
      ref: (node: HTMLDivElement | null) => {
        if (node) nodes.current.set(line.key, node);
        else nodes.current.delete(line.key);
      },
      onFocus: (event: FocusEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget) setActive({ key: line.key, index });
      },
      style: { insetBlockStart: index * LINE_HEIGHT, blockSize: LINE_HEIGHT },
    } as const;
    if (line.kind === 'group') {
      const info = groupInfo(line.group);
      const name = info.name;
      const count = line.count;
      // A person group draws its initials beside the name, so the spoken name says them too.
      const spokenName = info.person
        ? `${avatarInitials(directory.get(line.group)?.name ?? name, i18n.locale)}: ${name}`
        : name;
      return (
        <div
          key={line.key}
          {...common}
          aria-expanded={line.expanded}
          aria-label={t({
            id: 'views.list.group.label',
            message: `${spokenName}, ${plural(count, { one: '# record', other: '# records' })}`,
          })}
          className="rio-list-view__line rio-list-view__group"
          data-drop={dropGroup === line.group ? 'group' : undefined}
          onClick={() => {
            if (suppressClick.current) return;
            setActive({ key: line.key, index });
            toggle(line.key);
          }}
        >
          <Icon icon={faChevronRight} className="rio-list-view__chevron" />
          <span className="rio-list-view__group-name">
            {info.color ? (
              <ChoicePill name={name} color={info.color} size="sm" />
            ) : info.person ? (
              <>
                <Avatar personId={line.group} name={name} color="blue" size="sm" aria-hidden="true" />{' '}
                <span className="rio-list-view__text">{name}</span>
              </>
            ) : (
              <span className="rio-list-view__text">{name}</span>
            )}
          </span>{' '}
          <span className="rio-list-view__count" aria-hidden="true">
            {numbers.format(count)}
          </span>
        </div>
      );
    }
    const row = line.row;
    const titleId = `${baseId}-title-${index}`;
    const fieldsId = `${baseId}-fields-${index}`;
    const countId = `${baseId}-count-${index}`;
    const colorId = `${baseId}-color-${index}`;
    const isEditing = editing?.key === line.key;
    // A record rule marks the line's edge, and every rule behind a color on it is named for screen readers.
    const paint = row && colors ? colors.record(row) : null;
    const colored =
      row && colors
        ? colorDescription(
            colors.labels(row, primary ? [primary, ...shownFields] : shownFields),
            i18n.locale || 'en-US',
          )
        : undefined;
    const described = [colored ? colorId : '', row && shownFields.length ? fieldsId : '']
      .filter(Boolean)
      .join(' ');
    // A sparkline replaces its field's text with a chart, whose label the line's description
    // already carries, so the chart stays out of the spoken name.  The name starts with the words
    // the line shows, as one run, so a field that reads as a mark is named after every visible one.
    const named = row ? shownFields.filter((field) => !colors?.cell(row, field)?.sparkline) : [];
    const spoken = row
      ? [
          ...named.filter((field) => showsText(field, cellValue(row, field))),
          ...named.filter((field) => !showsText(field, cellValue(row, field))),
        ]
      : [];
    const nestable = mode.kind === 'outline';
    const drop =
      drag?.mark === line.key
        ? drag.destination?.kind === 'parent' && drag.destination.parent === null
          ? 'top'
          : 'into'
        : dropGroup !== null && line.group === dropGroup
          ? 'group'
          : null;
    return (
      <div
        key={line.key}
        {...common}
        aria-expanded={nestable && line.children > 0 ? line.expanded : undefined}
        aria-busy={!row || undefined}
        aria-labelledby={
          row
            ? [
                titleId,
                nestable && line.children > 0 ? countId : '',
                ...spoken.map((field) => `${fieldsId}-${field.id}`),
              ]
                .filter(Boolean)
                .join(' ')
            : undefined
        }
        aria-label={row ? undefined : t({ id: 'views.list.loadingRecord', message: 'Loading record' })}
        aria-describedby={described || undefined}
        aria-keyshortcuts={row ? shortcuts : undefined}
        className={`rio-list-view__line rio-list-view__record${canDrag && row ? ' rio-sortable-surface' : ''}`}
        onPointerDown={(event) => {
          if (
            !(event.target as Element).closest(
              'button, input, textarea, a, [contenteditable], .rio-list-view__toggle, .rio-list-view__edit',
            )
          )
            startDrag(event, line);
        }}
        data-movable={(canDrag && !!row) || undefined}
        data-dragging={drag?.key === line.key || undefined}
        data-drop={drop ?? undefined}
        onClick={(event) => {
          if ((event.target as Element).closest('button, [role="menu"]')) return;
          if (suppressClick.current || isEditing || !row) return;
          onExpand(row.id);
        }}
      >
        {line.level > (mode.kind === 'group' ? 2 : 1) && (
          <span
            className="rio-list-view__indent"
            style={{ inlineSize: (line.level - (mode.kind === 'group' ? 2 : 1)) * INDENT }}
          />
        )}
        {paint && (
          <span
            className="rio-list-view__color"
            style={{ '--rio-list-view-color': lineColor(paint.color) } as CSSProperties}
            aria-hidden="true"
          />
        )}
        {drag?.edge?.key === line.key && (
          <span className="rio-list-view__drop" data-side={drag.edge.side} aria-hidden="true" />
        )}
        {nestable && (
          <span
            className="rio-list-view__toggle"
            aria-hidden="true"
            onClick={(event) => {
              event.stopPropagation();
              if (line.children > 0) toggle(line.key);
            }}
          >
            {line.children > 0 && <Icon icon={faChevronRight} className="rio-list-view__chevron" />}
          </span>
        )}
        {isEditing && primary ? (
          <InlineEditor
            label={primary.name}
            initial={editing.text}
            error={editing.error}
            onDone={(keep, text) => finishEditing(line, keep, text)}
            onLeave={(text) => leaveEditing(line, text)}
          />
        ) : (
          <span id={titleId} className="rio-list-view__title" title={row ? title(row) : undefined}>
            {row ? <Painted paint={primary ? colors?.cell(row, primary) : null}>{title(row)}</Painted> : ' '}
          </span>
        )}{' '}
        {canRename && row && !isEditing && (
          <span
            className="rio-list-view__edit"
            aria-hidden="true"
            onClick={(event) => {
              event.stopPropagation();
              startEditing(line);
            }}
          >
            <Icon icon={faPen} />
          </span>
        )}
        {nestable && line.children > 0 && (
          <span id={countId} className="rio-list-view__count" aria-hidden="true">
            {numbers.format(line.children)}{' '}
          </span>
        )}
        {row && shownFields.length > 0 && (
          <span id={fieldsId} className="rio-list-view__fields">
            {shownFields.map((field) => {
              const value = cellValue(row, field);
              return (
                <span
                  className="rio-list-view__field"
                  key={field.id}
                  title={formatCell(field, value, format)}
                >
                  <span className="rio-list-view__sr-only">{`${field.name}: `}</span>
                  <span id={`${fieldsId}-${field.id}`}>
                    <CardValue
                      field={field}
                      value={value}
                      format={format}
                      row={row}
                      focusable={false}
                      paint={colors?.cell(row, field)}
                    />
                  </span>{' '}
                </span>
              );
            })}
          </span>
        )}
        {colored && (
          <span id={colorId} className="rio-list-view__sr-only">
            {colored}
          </span>
        )}
        {canDrag && row ? (
          <SortableMovementMenu
            name={title(row)}
            up={
              movementTarget(line, -1)
                ? () => {
                    const target = movementTarget(line, -1);
                    if (target) move(line, target);
                  }
                : undefined
            }
            down={
              movementTarget(line, 1)
                ? () => {
                    const target = movementTarget(line, 1);
                    if (target) move(line, target);
                  }
                : undefined
            }
            destinations={[
              ...(canOrder
                ? shown.lines.flatMap((target) =>
                    target.kind === 'record' &&
                    target.row &&
                    target.key !== line.key &&
                    target.group === line.group &&
                    target.parent === line.parent
                      ? [
                          {
                            id: target.key,
                            name: title(target.row),
                            move: () =>
                              move(line, {
                                kind: 'order',
                                place:
                                  target.position < line.position
                                    ? { before: target.row!.id }
                                    : { after: target.row!.id },
                              }),
                          },
                        ]
                      : [],
                  )
                : []),
              ...(mode.kind === 'group' && canMove
                ? shown.groups
                    .filter((group) => group !== line.group)
                    .map((group) => ({
                      id: `group-${group}`,
                      name: groupInfo(group).name,
                      move: () => move(line, { kind: 'group', group }),
                    }))
                : []),
              ...(mode.kind === 'outline' && canMove && line.parent !== null
                ? [
                    {
                      id: 'root',
                      name: t({ id: 'sortable.menu.root', message: 'Top level' }),
                      move: () => move(line, { kind: 'parent', parent: null }),
                    },
                  ]
                : []),
            ]}
          />
        ) : null}
      </div>
    );
  }

  const limit = numbers.format(MAX_RECORDS);
  return (
    <div className="rio-list-view" data-dragging={drag ? true : undefined}>
      {canEditRecords && (!(table.source || table.joined) || sorted) && (
        <div className="rio-list-view__actions">
          {!(table.source || table.joined) && (
            <Button
              size="sm"
              onPress={create}
              aria-label={t({ id: 'views.list.newRecord', message: 'New record' })}
              icon={faPlus}
            />
          )}
          {sorted && (
            <p id={sortedId} className="rio-list-view__hint">
              {t({
                id: 'views.list.sorted',
                message:
                  'This list follows its sort, so records can’t be dragged into an order of their own.  Remove the sort to arrange them by hand.',
              })}
            </p>
          )}
        </div>
      )}
      <div
        ref={viewport}
        role="tree"
        aria-label={view.name}
        aria-describedby={canEditRecords && sorted ? `${instructionsId} ${sortedId}` : instructionsId}
        aria-busy={records.loading || undefined}
        className="rio-list-view__viewport"
        tabIndex={activeDrawn || !lines.length ? -1 : 0}
        onKeyDown={keyDown}
        onFocus={(event) => {
          setFocused(true);
          if (event.target !== event.currentTarget) return;
          focusLine(Math.min(lines.length - 1, Math.floor(event.currentTarget.scrollTop / LINE_HEIGHT)));
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
        }}
        onScroll={(event) => {
          const node = event.currentTarget;
          setBounds({ height: node.clientHeight || FALLBACK_HEIGHT, scroll: node.scrollTop });
        }}
      >
        <div
          role="presentation"
          className="rio-list-view__canvas"
          style={{ blockSize: lines.length * LINE_HEIGHT }}
        >
          {drawn.map(renderLine)}
        </div>
      </div>
      <p id={instructionsId} hidden>
        {instructions}
      </p>
      {gesture.feedback}
      <div className="rio-list-view__status" role="status">
        {gesture.announcement}
      </div>
      {!records.loading && records.count === 0 && (
        <p className="rio-list-view__empty">
          {t({ id: 'views.list.empty', message: 'No records in this view' })}
        </p>
      )}
      {(records.loading || records.limited) && (
        <p className="rio-list-view__notice">
          {records.limited
            ? t({
                id: 'views.list.limited',
                message: `Showing the first ${limit} records.  Filter the view to see the rest.`,
              })
            : t({ id: 'views.list.loading', message: 'Loading records…' })}
        </p>
      )}
    </div>
  );
}

/**
 * Edits a record's first field on its line.  Enter saves and Escape cancels.  Leaving the field
 * saves too, so a click elsewhere never loses what was typed.
 */
function InlineEditor({
  label,
  initial,
  error,
  onDone,
  onLeave,
}: {
  label: string;
  initial: string;
  error: string | null;
  /** Returns false when the text can't be saved, which keeps the editor open */
  onDone(keep: boolean, text: string): boolean;
  onLeave(text: string): void;
}) {
  const [text, setText] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  const errorId = useId();
  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  return (
    <span className="rio-list-view__editor">
      <input
        ref={input}
        className="rio-list-view__input"
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            finished.current = onDone(true, text);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            finished.current = true;
            onDone(false, text);
          }
        }}
        onBlur={() => {
          if (finished.current) return;
          finished.current = true;
          onLeave(text);
        }}
      />
      {error && (
        <span id={errorId} className="rio-list-view__error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
