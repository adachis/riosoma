import { faPlus } from '@fortawesome/free-solid-svg-icons';
import { shortcutKeys } from '../../../../shortcuts/registry';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { newId, roleAllows, visibleFieldIds, type RowData } from '@riosoma/contracts';
import { Button } from '@riosoma/ui';
import { useViewRows } from '../../../../data/hooks';
import { reportError } from '../../../../grid/view/actions';
import { ViewPromptPill } from '../../shell/ViewPromptPill';
import type { ViewComponentProps } from '../types';
import { GalleryCard } from './GalleryCard';
import { COVER_HEIGHTS, GAP, PADDING, galleryLayout, visibleRows } from './layout';
import { dropRefusal, orderCommand } from '../drag/rules';
import { formatCell } from '../../../../grid/format';
import { cellValue } from '@riosoma/contracts';
import { useHeld, useViewDrag, type DragPoint } from '../drag/useViewDrag';
import './gallery.css';

export function GalleryView(props: ViewComponentProps) {
  return <Gallery key={props.view.id} {...props} />;
}

function Gallery(props: ViewComponentProps) {
  'use no memo';
  // ViewRows keeps its identity while subscriptions update its mutable snapshot.

  const { t } = useLingui();
  const moveUp = shortcutKeys('views.moveUp');
  const moveDown = shortcutKeys('views.moveDown');
  const gesture = useViewDrag();
  const { session, view, table, fields } = props;
  const rows = useViewRows(session, view.id);
  const viewport = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef(false);
  const [bounds, setBounds] = useState({ width: 0, height: 0, scroll: 0 });
  const [active, setActive] = useState(0);
  const primary = fields.find((field) => field.id === table.primaryFieldId);
  const visible = visibleFieldIds(view.config, fields, table.primaryFieldId)
    .filter((id) => id !== table.primaryFieldId)
    .flatMap((id) => fields.find((field) => field.id === id) ?? []);
  const { columns, cardHeight, stride } = galleryLayout(
    bounds.width,
    view.config.gallery.cardSize,
    visible.length,
  );
  const loading = !rows || rows.loading();
  const count = useHeld(rows?.rowCount() ?? 0, gesture.holding);
  const total = loading ? Math.max(columns, count) : count;
  const lineCount = Math.ceil(total / columns);
  const contentHeight = Math.max(0, lineCount * stride - GAP) + 2 * PADDING;
  const scroll = Math.min(bounds.scroll, Math.max(0, contentHeight - bounds.height));
  const range = visibleRows(scroll, bounds.height, stride, lineCount);
  const start = range.start * columns;
  const end = Math.min(total, range.end * columns);
  const activeIndex = Math.min(active, Math.max(0, total - 1));
  const activeVisible = activeIndex >= start && activeIndex < end;
  const drawnRows = useHeld(
    new Map(
      Array.from({ length: end - start }, (_, offset) => {
        const index = start + offset;
        return [index, rows?.getRow(index)] as const;
      }),
    ),
    gesture.holding,
  );

  function reorder(row: RowData, target: string, side: 'before' | 'after') {
    const reason = dropRefusal(props, row, [], true);
    if (reason) {
      gesture.setStatus(gesture.reasons[reason]);
      return;
    }
    const command = orderCommand(props, row, target, side);
    if (!command) return;
    try {
      session.run([command]);
      gesture.setStatus(t({ id: 'gallery.orderSaved', message: 'Card order saved.' }));
      setActive(Math.max(0, rows?.indexOf(row.id) ?? 0));
      pendingFocus.current = true;
    } catch (error) {
      reportError(error);
    }
  }

  function startDrag(event: PointerEvent, row: RowData) {
    if (props.readOnly) return;
    if (event.target instanceof Element && event.target.closest('a, button')) return;
    const locate = (point: DragPoint) => {
      const target = document
        .elementFromPoint(point.clientX, point.clientY)
        ?.closest<HTMLElement>('[data-gallery-index]');
      if (!target || !viewport.current?.contains(target) || !target.dataset.record) return null;
      const rect = target.getBoundingClientRect();
      return {
        node: target,
        id: target.dataset.record,
        side:
          point.clientX < rect.left + rect.width / 2 !== (getComputedStyle(target).direction === 'rtl')
            ? ('before' as const)
            : ('after' as const),
      };
    };
    gesture.start(event, {
      scroll: viewport.current,
      move(point) {
        const target = locate(point);
        const reason = dropRefusal(props, row, [], true);
        gesture.mark(
          target?.node ?? null,
          reason
            ? gesture.reasons[reason]
            : t({ id: 'gallery.dropHere', message: 'Drop here to place the card.' }),
          !!reason,
          target?.side,
        );
      },
      drop(point) {
        const target = locate(point);
        if (target) reorder(row, target.id, target.side);
      },
    });
  }

  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const measure = () =>
      setBounds({ width: node.clientWidth, height: node.clientHeight, scroll: node.scrollTop });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (end > start) rows?.ensureRows(start, end);
  });

  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node) return;
    if (node.scrollTop !== scroll) node.scrollTop = scroll;
    if (pendingFocus.current) {
      node
        .querySelector<HTMLElement>(`[data-gallery-index="${activeIndex}"]`)
        ?.focus({ preventScroll: true });
      pendingFocus.current = false;
    }
  }, [activeIndex, start, end, scroll]);

  function move(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.metaKey || event.ctrlKey || event.nativeEvent.isComposing || !total) return;
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    let next = activeIndex;
    switch (event.key) {
      case 'ArrowRight':
        next += rtl ? -1 : 1;
        break;
      case 'ArrowLeft':
        next += rtl ? 1 : -1;
        break;
      case 'ArrowDown':
        next += columns;
        break;
      case 'ArrowUp':
        next -= columns;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = total - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    next = Math.max(0, Math.min(total - 1, next));
    const node = viewport.current;
    if (!node) return;
    const top = PADDING + Math.floor(next / columns) * stride;
    const nextScroll =
      top < node.scrollTop || cardHeight > bounds.height
        ? top
        : top + cardHeight > node.scrollTop + bounds.height
          ? top + cardHeight - bounds.height
          : node.scrollTop;
    node.scrollTop = Math.max(0, nextScroll);
    pendingFocus.current = true;
    setActive(next);
    setBounds((current) => ({ ...current, scroll: node.scrollTop }));
    // A boundary key may leave every state value unchanged.
    node.querySelector<HTMLElement>(`[data-gallery-index="${next}"]`)?.focus({ preventScroll: true });
  }

  function createRecord() {
    if (table.source || table.joined || !roleAllows(session.role(), 'editRecords')) return;
    try {
      const id = newId('record');
      session.run([{ kind: 'record.create', tableId: table.id, records: [{ id, values: {} }] }]);
      props.onExpand(id);
    } catch (error) {
      reportError(error);
    }
  }

  const refresh = useCallback(async () => {
    if (!rows) return;
    const anchor = rows.getRow(start)?.id;
    const focusedId = rows.getRow(activeIndex)?.id;
    const offset = scroll - (PADDING + range.start * stride);
    const result = await rows.refresh(anchor);
    const node = viewport.current;
    if (!node) return;
    if (result.anchorIndex !== null) {
      node.scrollTop = Math.max(0, PADDING + Math.floor(result.anchorIndex / columns) * stride + offset);
      setBounds((current) => ({ ...current, scroll: node.scrollTop }));
    }
    if (focusedId) setActive(Math.max(0, rows.indexOf(focusedId)));
  }, [rows, start, activeIndex, scroll, range.start, stride, columns]);
  const orderChanged = rows?.prompts().orderChanged;
  useEffect(() => {
    if (orderChanged && !view.config.sorts.length && !gesture.holding) void refresh().catch(reportError);
  }, [orderChanged, refresh, gesture.holding, view.config.sorts.length]);

  useLayoutEffect(() => {
    rows?.onSyncRefresh?.(refresh);
    return () => rows?.onSyncRefresh?.(undefined);
  });

  return (
    <div
      className="rio-gallery-view"
      onClickCapture={(event) => {
        if (gesture.suppressClick.current) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      {gesture.feedback}
      <div className="rio-view-drag-announcement" aria-live="polite">
        {gesture.announcement}
      </div>
      {!props.readOnly && (
        <p className="rio-view-drag-status">
          {view.config.sorts.length
            ? gesture.reasons.sorted
            : t({
                id: 'gallery.orderKeys',
                message: `Drag cards to arrange them.  ${moveUp} or ${moveDown} moves the focused card.`,
              })}
        </p>
      )}
      {!props.readOnly && !(table.source || table.joined) && (
        <div className="rio-gallery-view__actions">
          <Button
            onPress={createRecord}
            isDisabled={!roleAllows(session.role(), 'editRecords')}
            aria-label={t({ id: 'gallery.newRecord', message: 'New record' })}
            icon={faPlus}
          />
        </div>
      )}
      <div
        ref={viewport}
        role="grid"
        aria-rowcount={lineCount}
        aria-colcount={columns}
        aria-label={view.name}
        aria-busy={loading || undefined}
        tabIndex={activeVisible ? -1 : 0}
        className="rio-gallery-view__viewport"
        onKeyDown={move}
        onFocus={(event) => {
          if (event.target !== event.currentTarget || !total) return;
          const first =
            visibleRows(event.currentTarget.scrollTop, bounds.height, stride, lineCount).start * columns;
          pendingFocus.current = true;
          setActive(Math.min(first, total - 1));
          event.currentTarget
            .querySelector<HTMLElement>(`[data-gallery-index="${first}"]`)
            ?.focus({ preventScroll: true });
        }}
        onScroll={(event) => {
          const node = event.currentTarget;
          const nextRange = visibleRows(node.scrollTop, bounds.height, stride, lineCount);
          if (
            (activeIndex < nextRange.start * columns || activeIndex >= nextRange.end * columns) &&
            node.contains(document.activeElement)
          )
            node.focus({ preventScroll: true });
          setBounds((current) => ({ ...current, scroll: node.scrollTop }));
        }}
      >
        <div role="presentation" className="rio-gallery-view__canvas" style={{ blockSize: contentHeight }}>
          {Array.from({ length: range.end - range.start }, (_, offset) => {
            const line = range.start + offset;
            return (
              <div
                role="row"
                aria-rowindex={line + 1}
                className="rio-gallery-view__line"
                key={line}
                style={
                  {
                    insetBlockStart: PADDING + line * stride,
                    blockSize: cardHeight,
                    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                    '--rio-gallery-view-cover-height': `${COVER_HEIGHTS[view.config.gallery.cardSize]}px`,
                  } as CSSProperties
                }
              >
                {Array.from({ length: Math.min(columns, total - line * columns) }, (_, column) => {
                  const index = line * columns + column;
                  const row = drawnRows.get(index) ?? rows?.getRow(index);
                  return (
                    <GalleryCard
                      key={index}
                      row={row}
                      primary={primary}
                      fields={visible}
                      settings={view.config.gallery}
                      attachment={props.attachment}
                      format={props.format}
                      colors={props.colors}
                      index={index}
                      count={total}
                      columns={columns}
                      active={index === activeIndex}
                      onFocus={() => setActive(index)}
                      dragDescription={props.readOnly ? undefined : gesture.instructions}
                      onDrag={
                        props.readOnly
                          ? undefined
                          : (event) => {
                              if (row) startDrag(event, row);
                            }
                      }
                      onOrder={
                        props.readOnly
                          ? undefined
                          : (direction) => {
                              const target = rows?.getRow(index + direction);
                              if (row && target) reorder(row, target.id, direction < 0 ? 'before' : 'after');
                            }
                      }
                      destinations={
                        row && !dropRefusal(props, row, [], true)
                          ? Array.from(drawnRows.entries()).flatMap(([position, target]) =>
                              target && target.id !== row.id
                                ? [
                                    {
                                      id: target.id,
                                      name: primary
                                        ? formatCell(primary, cellValue(target, primary), props.format)
                                        : t({
                                            id: 'sortable.menu.position',
                                            message: `Position ${position + 1}`,
                                          }),
                                      move: () =>
                                        reorder(row, target.id, position < index ? 'before' : 'after'),
                                    },
                                  ]
                                : [],
                            )
                          : []
                      }
                      onOpen={() => {
                        if (row) props.onExpand(row.id);
                      }}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      {!loading && count === 0 && (
        <div className="rio-gallery-view__empty" role="status">
          <Trans id="gallery.empty">No records yet</Trans>
        </div>
      )}
      {rows && (
        <ViewPromptPill
          prompts={rows.prompts()}
          onRefresh={() => {
            void refresh().catch(reportError);
          }}
        />
      )}
    </div>
  );
}
