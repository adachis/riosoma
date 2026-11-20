import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { useLingui } from '@lingui/react/macro';
import { cellValue, idsOf, visibleFieldIds, type RowData } from '@riosoma/contracts';
import { Button, Menu, MenuItem, MenuTrigger } from '@riosoma/ui';
import { faEllipsis, faArrowUp, faArrowDown, faArrowRight } from '@fortawesome/free-solid-svg-icons';
import type { ViewRows } from '../../../../data/types';
import { formatCell } from '../../../../grid/format';
import { CardValue } from '../CardValue';
import { colorDescription, edgeProps } from '../../colors/dom';
import { Painted } from '../../colors/Painted';
import type { ViewComponentProps } from '../types';
import type { Arrival, DragItem } from './KanbanView';
import { useStackRows } from './rows';
import { compareCards, editable, rowStack, type Stack } from './model';
import { dropRefusal } from '../drag/rules';

interface Props extends ViewComponentProps {
  stack: Stack;
  stacks: Stack[];
  moveTargets: Stack[];
  arrivals: ReadonlyMap<string, Arrival>;
  /** A pointer is pressing or carrying a card or a header, so the cards on screen stay put. */
  dragging: boolean;
  register(id: string, rows: ViewRows | null): void;
  move(row: RowData, target: string): void;
  orderCard(row: RowData, stack: string, direction: -1 | 1): void;
  position?: number;
  total?: number;
  startDrag(event: PointerEvent, item: DragItem): void;
}

export function CardStack(props: Props) {
  const { session, view, stack, register } = props;
  const { rows, revision, read } = useStackRows(session, view.id, stack.id);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const [seek, setSeek] = useState<number | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [held, setHeld] = useState<{
    dragging: boolean;
    total: number;
    cards: Array<{ index: number; row: RowData | undefined }>;
  }>({ dragging: false, total: 0, cards: [] });
  const fields = visibleFieldIds(view.config, props.fields, props.table.primaryFieldId).flatMap(
    (id) => props.fields.find((field) => field.id === id) ?? [],
  );
  const cover = props.fields.find(
    (field) => field.id === view.config.kanban.coverFieldId && field.type === 'attachment',
  );
  // Every visible field gets a fixed line pair; unknown covers reserve their final space.
  const height = 76 + Math.max(0, fields.length - 1) * 48 + (cover ? 140 : 0);
  useEffect(() => {
    register(stack.id, rows);
    return () => register(stack.id, null);
  }, [rows, stack.id, register]);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => setViewport({ top: element.scrollTop, height: element.clientHeight || 600 });
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const arrivals = [...props.arrivals.values()]
    .filter((arrival) => arrival.stack === stack.id && read.index(arrival.row.id) < 0)
    .sort((a, b) => compareCards(a.row, b.row, props));
  const count = read.count;
  const inserted: Array<{ row: RowData; index: number }> = [];
  for (const arrival of arrivals) {
    let low = 0,
      high = count;
    const place = !view.config.sorts.length ? arrival.place : undefined;
    const anchor = place ? read.index(place.id) : -1;
    if (anchor >= 0) low = high = anchor + (place?.side === 'after' ? 1 : 0);
    while (low < high) {
      const mid = Math.floor((low + high) / 2),
        row = read.row(mid);
      if (!row || compareCards(arrival.row, row, props) < 0) high = mid;
      else low = mid + 1;
    }
    inserted.push({ row: arrival.row, index: low + inserted.length });
  }
  const total = props.dragging && held.dragging ? held.total : count + inserted.length;
  const focusArrival = inserted.find((arrival) => props.arrivals.get(arrival.row.id)?.focus);
  const focusIndex = focusArrival?.index;
  useLayoutEffect(() => {
    if (focusIndex === undefined || !scroller.current) return;
    scroller.current.scrollTop = focusIndex * height;
    scroller.current.dispatchEvent(new Event('scroll'));
  }, [focusIndex, height]);
  useLayoutEffect(() => {
    if (seek === null) return;
    const target = scroller.current?.querySelector<HTMLButtonElement>(
      `[data-position="${seek}"] .rio-kanban-card__open`,
    );
    target?.focus();
  }, [seek, revision]);
  const start = Math.max(0, Math.min(Math.floor(viewport.top / height) - 2, total - 1));
  const end = Math.min(total, Math.ceil((viewport.top + viewport.height) / height) + 2);
  useEffect(() => {
    rows?.ensureRows(Math.max(0, start - inserted.length), Math.max(end, 20));
  }, [rows, start, end, inserted.length, revision]);
  useLayoutEffect(() => {
    rows?.onSyncRefresh?.(async () => {
      const node = scroller.current;
      if (!node || !rows) return;
      const top = node.scrollTop;
      const index = Math.floor(top / height);
      const anchor = rows.getRow(index)?.id;
      const result = await rows.refresh(anchor);
      if (scroller.current !== node || result.anchorIndex === null) return;
      node.scrollTop = result.anchorIndex * height + (top % height);
      setViewport({ top: node.scrollTop, height: node.clientHeight || 600 });
    });
    return () => rows?.onSyncRefresh?.(undefined);
  });
  const displayRow = (index: number) => {
    const local = inserted.find((arrival) => arrival.index === index);
    if (local) return local.row;
    const row = read.row(index - inserted.filter((arrival) => arrival.index < index).length);
    if (!row) return;
    const arrival = props.arrivals.get(row.id);
    const field = props.fields.find((field) => field.id === view.config.kanban.stackFieldId);
    if ((arrival && arrival.stack !== stack.id) || (field && rowStack(row, field) !== stack.id)) return;
    return arrival?.row ?? row;
  };
  const cards = Array.from({ length: Math.max(0, end - start) }, (_, offset) => ({
    index: start + offset,
    row: displayRow(start + offset),
  }));
  const focusedIndex = focused ? read.index(focused) : -1;
  if (focusedIndex >= 0 && !cards.some(({ row }) => row?.id === focused)) {
    const index = focusedIndex + inserted.filter((arrival) => arrival.index <= focusedIndex).length;
    const row = displayRow(index);
    if (row && !cards.some((card) => card.index === index)) cards.push({ index, row });
  }
  // Realtime page notifications must not replace a card while a pointer gesture is in progress.
  if (props.dragging !== held.dragging) setHeld({ dragging: props.dragging, cards, total });
  const displayed =
    props.dragging && held.dragging
      ? cards.map((card) => held.cards.find((previous) => previous.index === card.index) ?? card)
      : cards;

  return (
    <div
      ref={scroller}
      className="rio-kanban-stack__scroll"
      role="list"
      aria-label={stack.name}
      tabIndex={0}
      onKeyDown={(event) => {
        if (
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
        )
          return;
        if (!(event.target instanceof Element) || event.target.closest('[data-kanban-menu]')) return;
        const current = Number(event.target.closest<HTMLElement>('[data-position]')?.dataset.position ?? -1);
        const next = Math.max(
          0,
          Math.min(
            total - 1,
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? total - 1
                : current + (event.key === 'ArrowDown' ? 1 : -1),
          ),
        );
        if (!total) return;
        event.preventDefault();
        setSeek(next);
        rows?.ensureRows(Math.max(0, next - inserted.length), next + 1);
        event.currentTarget.scrollTop = next * height;
        setViewport({ top: next * height, height: event.currentTarget.clientHeight || 600 });
      }}
      onScroll={(event) =>
        setViewport({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight || 600 })
      }
      onFocusCapture={(event) => {
        setFocused(
          (event.target as HTMLElement).closest<HTMLElement>('[data-record]')?.dataset.record ?? null,
        );
        setSeek(null);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocused(null);
          setSeek(null);
        }
      }}
    >
      <div className="rio-kanban-stack__space" style={{ blockSize: total * height }}>
        {displayed.map(({ row, index }) => (
          <div
            key={row?.id ?? index}
            className="rio-kanban-stack__slot"
            data-position={index}
            role="listitem"
            aria-posinset={index + 1}
            aria-setsize={total}
            style={{ insetBlockStart: index * height, blockSize: height }}
          >
            {row ? (
              <Card
                {...props}
                row={row}
                fields={fields}
                coverFieldId={cover?.id}
                position={index}
                total={total}
              />
            ) : (
              <div className="rio-kanban-card rio-kanban-card--loading" aria-hidden="true" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Card(props: Props & { row: RowData; fields: ViewComponentProps['fields']; coverFieldId?: string }) {
  const { t, i18n } = useLingui();
  const { row } = props;
  const open = useRef<HTMLButtonElement>(null);
  const arrival = props.arrivals.get(row.id);
  useLayoutEffect(() => {
    if (arrival?.focus) open.current?.focus();
  }, [arrival]);
  const primary = props.fields.find((field) => field.id === props.table.primaryFieldId);
  const name =
    (primary ? formatCell(primary, cellValue(row, primary), props.format) : '') ||
    t({ id: 'record.untitled', message: 'Untitled record' });
  const menu = t({ id: 'kanban.card.menu', message: `More for ${name}` });
  const canEdit = editable(props);
  const files = props.coverFieldId ? idsOf(row.values[props.coverFieldId] ?? null) : [];
  const image = files
    .map((id) => props.attachment?.(id))
    .find((file) => !file || file.type.startsWith('image/'));
  const index = props.stacks.findIndex((stack) => stack.id === props.stack.id);
  const buttons = props.fields.filter(
    (field) => field.id !== props.table.primaryFieldId && field.type === 'button',
  );
  // A record rule draws the card's edge, and the rules behind every color are named for screen readers.
  const edge = edgeProps(props.colors?.record(row) ?? null);
  const colored = colorDescription(props.colors?.labels(row, props.fields) ?? [], i18n.locale || 'en-US');
  return (
    <article
      className={edge.className ? `rio-kanban-card ${edge.className}` : 'rio-kanban-card'}
      style={edge.style}
      data-record={row.id}
      data-draggable={canEdit || undefined}
      onPointerDown={(event) => props.startDrag(event, { kind: 'card', row })}
      onKeyDown={(event) => {
        if (!canEdit || !event.altKey) return;
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          event.stopPropagation();
          props.orderCard(row, props.stack.id, event.key === 'ArrowUp' ? -1 : 1);
          return;
        }
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        const target = props.stacks[index + (event.key === 'ArrowLeft' ? -1 : 1)];
        if (target) props.move(row, target.id);
      }}
    >
      <button
        ref={open}
        className="rio-kanban-card__open"
        aria-keyshortcuts={canEdit ? 'Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown' : undefined}
        type="button"
        aria-description={colored}
        onClick={() => props.onExpand(row.id)}
      >
        {props.coverFieldId && (
          <span className="rio-kanban-card__cover" data-fit={props.view.config.kanban.coverFit}>
            {image?.thumbnails.small && <img src={image.thumbnails.small} alt="" draggable={false} />}
          </span>
        )}
        <strong className="rio-kanban-card__title">
          <Painted paint={primary ? props.colors?.cell(row, primary) : null}>{name}</Painted>
        </strong>
        {props.fields
          .filter((field) => field.id !== props.table.primaryFieldId && field.type !== 'button')
          .map((field) => (
            <span className="rio-kanban-card__field" key={field.id}>
              <span className="rio-kanban-card__label">{field.name}</span>
              <span className="rio-kanban-card__value">
                <CardValue
                  field={field}
                  value={cellValue(row, field)}
                  format={props.format}
                  paint={props.colors?.cell(row, field)}
                />
              </span>
            </span>
          ))}
      </button>
      {buttons.length > 0 && (
        // Links can't sit inside the card's button, so buttons take the card's last rows instead.
        <div className="rio-kanban-card__actions" data-kanban-menu>
          {buttons.map((field) => (
            <span className="rio-kanban-card__field" key={field.id}>
              <span className="rio-kanban-card__label">{field.name}</span>
              <span className="rio-kanban-card__value">
                <CardValue field={field} value={null} format={props.format} row={row} />
              </span>
            </span>
          ))}
        </div>
      )}
      <div className="rio-kanban-card__menu" data-kanban-menu>
        <MenuTrigger>
          <Button variant="quiet" size="sm" icon={faEllipsis} aria-label={menu} isDisabled={!canEdit} />
          <Menu aria-label={menu}>
            <MenuItem
              icon={faArrowUp}
              isDisabled={!!dropRefusal(props, row, [], true) || !props.position}
              onAction={() => props.orderCard(row, props.stack.id, -1)}
            >
              {t({ id: 'sortable.menu.up', message: 'Move up' })}
            </MenuItem>
            <MenuItem
              icon={faArrowDown}
              isDisabled={!!dropRefusal(props, row, [], true) || props.position === (props.total ?? 1) - 1}
              onAction={() => props.orderCard(row, props.stack.id, 1)}
            >
              {t({ id: 'sortable.menu.down', message: 'Move down' })}
            </MenuItem>
            {props.moveTargets
              .filter((stack) => stack.id !== props.stack.id)
              .map(({ id, name: stack }) => (
                <MenuItem
                  key={id}
                  id={id || 'empty'}
                  icon={faArrowRight}
                  onAction={() => props.move(row, id)}
                >
                  {t({ id: 'kanban.card.moveTo', message: `Move to ${stack}` })}
                </MenuItem>
              ))}
          </Menu>
        </MenuTrigger>
      </div>
    </article>
  );
}
