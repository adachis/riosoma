import { faChevronDown, faChevronUp } from '@fortawesome/free-solid-svg-icons';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { useLingui } from '@lingui/react/macro';
import {
  cellValue,
  isParentField,
  roleAllows,
  visibleFieldIds,
  type FieldMeta,
  type RowData,
} from '@riosoma/contracts';
import { Button } from '@riosoma/ui';
import { useSchema } from '../../../../data/hooks';
import { reportError, undoAction } from '../../../../grid/view/actions';
import { formatCell } from '../../../../grid/format';
import { dropRefusal } from '../drag/rules';
import { useViewDrag, type DragPoint } from '../drag/useViewDrag';
import { neighborParent, parentValues, within } from '../list/model';
import { MAX_RECORDS, useViewRecords } from '../timeline/records';
import type { ViewComponentProps } from '../types';
import { cardHeight, centerNode, chartLayout, fitChart, visibleChart, type ChartNode } from './layout';
import { useChartLocation } from './location';
import { Card, type CardActions } from './Card';
import './org-chart.css';

export function OrgChartView(props: ViewComponentProps) {
  const { t } = useLingui();
  const field = props.fields.find(
    (field) => field.id === props.view.config.orgChart.parentFieldId && isParentField(field),
  );
  if (!field)
    return (
      <p className="rio-org-chart__notice">
        {t({
          id: 'views.orgChart.setup',
          message: 'Choose a link to this table in Org chart settings to connect records by their parent.',
        })}
      </p>
    );
  return <Chart key={`${props.view.id}:${field.id}`} {...props} parentField={field} />;
}

function Chart(props: ViewComponentProps & { parentField: FieldMeta }) {
  const { t } = useLingui();
  const { session, view, table, fields, format, parentField, onExpand } = props;
  useSchema(session);
  const records = useViewRecords(session, view.id);
  const [panning, setPanning] = useState(false);
  const gesture = useViewDrag();
  const [location, change, restored] = useChartLocation(view.id, panning || gesture.holding);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [printing, setPrinting] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const positioned = useRef(restored);
  const latestMove = useRef<(id: string, parent: string | null) => void>(() => {});
  const viewport = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, SVGGElement>());
  const pendingFocus = useRef<string | null>(null);
  const stopPan = useRef<(() => void) | null>(null);
  const actions = useRef<CardActions>(null!);
  const instructions = useId();
  const primary = fields.find((field) => field.id === table.primaryFieldId);
  const shown = useMemo(
    () =>
      visibleFieldIds(view.config, fields, table.primaryFieldId)
        .filter((id) => id !== table.primaryFieldId)
        .flatMap((id) => fields.find((field) => field.id === id) ?? []),
    [view.config, fields, table.primaryFieldId],
  );
  const height = cardHeight(shown.length);
  const full = useMemo(
    () => chartLayout(records.rows, parentField, new Set(), height),
    [records.rows, parentField, height],
  );
  const collapsed = useMemo(
    () =>
      location.allCollapsed
        ? new Set(
            full.nodes
              .filter((node) => node.children && !location.collapsed.includes(node.key))
              .map((node) => node.key),
          )
        : new Set(location.collapsed),
    [location.allCollapsed, location.collapsed, full],
  );
  function collapsePatch(next: ReadonlySet<string>, branches = full.nodes) {
    const exceptions = branches
      .filter((node) => node.children && !next.has(node.key))
      .map((node) => node.key);
    return exceptions.length < next.size
      ? { allCollapsed: true, collapsed: exceptions }
      : { allCollapsed: false, collapsed: [...next] };
  }
  const layout = useMemo(
    () => chartLayout(records.rows, parentField, printing ? new Set() : collapsed, height),
    [records.rows, parentField, printing, collapsed, height],
  );
  const active = layout.byId.get(location.active ?? '') ?? layout.nodes[0];
  const camera = printing ? fitChart(layout, size) : location;
  const drawn = visibleChart(layout, camera, size, active?.key);
  const title = (row: RowData) =>
    (primary ? formatCell(primary, cellValue(row, primary), format) : '') ||
    t({ id: 'views.orgChart.untitled', message: 'Untitled record' });
  const incomplete = records.loading || records.limited;
  const incompleteReason = t({
    id: 'views.orgChart.incomplete',
    message: 'Load all records before changing a parent.',
  });
  /** Nothing here can change: a public page, or a role that can't edit records. */
  const reading = props.readOnly === true || !roleAllows(session.role(), 'editRecords');
  const refusalFor = (row?: RowData) => {
    const refusal = dropRefusal(props, row, [parentField]);
    return refusal ? gesture.reasons[refusal] : incomplete ? incompleteReason : undefined;
  };
  /**
   * What a card says when selected: only a refusal for its own record, such as a lock.  One that
   * stops every move, such as a locked parent field or records still loading, is said once a move
   * begins, so a screen reader doesn't hear it again on every card.
   */
  const cardRefusal = (row?: RowData) =>
    !reading && dropRefusal(props, row, [parentField]) === 'record' ? gesture.reasons.record : undefined;
  const canMove = !printing && !refusalFor();
  function refused(row?: RowData) {
    const reason = refusalFor(row);
    if (reason) gesture.setStatus(reason);
    return printing || !!reason;
  }
  const announce = useRef<(message: string) => void>(() => {});
  announce.current = gesture.setStatus;
  useEffect(
    () =>
      session.subscribeEvents((event) => {
        // A loop through a record this view filters out is one only the server can see.
        if (event.kind === 'rejected' && event.messageKey === 'data.link.cycle')
          announce.current(t({ id: 'views.orgChart.invalidDrop', message: 'Choose a different branch.' }));
      }),
    [session, t],
  );
  useEffect(() => () => stopPan.current?.(), []);
  function startPan(pointer: number, origin: DragPoint, point = origin, refusal?: string) {
    stopPan.current?.();
    setPanning(true);
    gesture.suppressClick.current = false;
    const originX = location.x;
    const originY = location.y;
    let said = false;
    const update = (point: DragPoint) => {
      if (Math.hypot(point.clientX - origin.clientX, point.clientY - origin.clientY) > 7) {
        gesture.suppressClick.current = true;
        // A click or a tap that never moves only selects, so it hears no refusal.
        if (refusal && !said) {
          said = true;
          gesture.setStatus(refusal);
        }
      }
      change({ x: originX + point.clientX - origin.clientX, y: originY + point.clientY - origin.clientY });
    };
    const move = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== pointer) return;
      event.preventDefault();
      update(event);
    };
    const finish = (event?: globalThis.PointerEvent) => {
      if (event && event.pointerId !== pointer) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', blur);
      setPanning(false);
      stopPan.current = null;
      setTimeout(() => {
        gesture.suppressClick.current = false;
      }, 0);
    };
    const blur = () => finish();
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', blur);
    stopPan.current = finish;
    update(point);
  }
  const wheelAction = useRef<(event: WheelEvent) => void>(() => {});
  useLayoutEffect(() => {
    wheelAction.current = (event) => {
      if (printing || panning || gesture.holding) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1;
      if (event.ctrlKey || event.metaKey) {
        const rect = viewport.current!.getBoundingClientRect();
        zoom(Math.exp(-event.deltaY * unit * 0.002), event.clientX - rect.left, event.clientY - rect.top);
      } else change({ x: location.x - event.deltaX * unit, y: location.y - event.deltaY * unit });
    };
  });
  useEffect(() => {
    const element = viewport.current;
    const wheel = (event: WheelEvent) => wheelAction.current(event);
    element?.addEventListener('wheel', wheel, { passive: false });
    return () => element?.removeEventListener('wheel', wheel);
  }, []);

  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const measure = () => setSize({ width: node.clientWidth || 800, height: node.clientHeight || 600 });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (pendingFocus.current) {
      nodes.current.get(pendingFocus.current)?.focus();
      pendingFocus.current = null;
    }
  });
  useEffect(() => {
    const before = () => setPrinting(true);
    const after = () => setPrinting(false);
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => {
      window.removeEventListener('beforeprint', before);
      window.removeEventListener('afterprint', after);
    };
  }, []);

  useEffect(() => {
    if (positioned.current || records.loading || !layout.nodes[0]) return;
    positioned.current = true;
    change({ active: layout.nodes[0].key, ...centerNode(layout.nodes[0], height, size, 1) });
  });

  function select(node: ChartNode, center = true) {
    pendingFocus.current = node.key;
    change({
      active: node.key,
      ...(center ? centerNode(node, height, size, Math.max(0.5, location.zoom)) : {}),
    });
  }
  function toggle(node: ChartNode) {
    const next = new Set(collapsed);
    if (next.has(node.key)) next.delete(node.key);
    else next.add(node.key);
    const updated = chartLayout(records.rows, parentField, next, height);
    const selected = updated.byId.get(node.key)!;
    change({
      ...collapsePatch(next),
      active: node.key,
      ...centerNode(selected, height, size, location.zoom),
    });
  }
  function zoom(factor: number, x = size.width / 2, y = size.height / 2) {
    const next = Math.max(0.00001, Math.min(2, location.zoom * factor));
    change({
      zoom: next,
      x: x - ((x - location.x) * next) / location.zoom,
      y: y - ((y - location.y) * next) / location.zoom,
    });
  }
  function find(focus = true) {
    const needle = location.search.trim().toLocaleLowerCase(format.locale);
    if (!needle) return;
    const matches = full.nodes.filter(
      (node) =>
        node.row &&
        [primary, ...shown].some(
          (field) =>
            field &&
            formatCell(field, cellValue(node.row!, field), format)
              .toLocaleLowerCase(format.locale)
              .includes(needle),
        ),
    );
    const index = matches.findIndex((node) => node.key === location.active);
    const match = matches[(index + 1) % matches.length];
    if (!match) {
      gesture.setStatus(t({ id: 'views.orgChart.noMatch', message: 'No matching records' }));
      return;
    }
    const next = new Set(collapsed);
    let ancestor = full.tree.parents.get(match.key);
    while (ancestor) {
      next.delete(ancestor);
      ancestor = full.tree.parents.get(ancestor);
    }
    const updated = chartLayout(records.rows, parentField, next, height);
    if (focus) pendingFocus.current = match.key;
    change({
      ...collapsePatch(next),
      active: match.key,
      ...centerNode(updated.byId.get(match.key)!, height, size, 1),
    });
    const name = title(match.row!);
    gesture.setStatus(t({ id: 'views.orgChart.found', message: `Found ${name}` }));
  }
  function move(node: ChartNode, parent: string | null) {
    const row = node.row && (session.cachedRecord(table.id, node.row.id) ?? node.row);
    if (!row || refused(row)) return;
    if (parent && within(full.tree, parent, node.key)) {
      gesture.setStatus(t({ id: 'views.orgChart.invalidDrop', message: 'Choose a different branch.' }));
      return;
    }
    const values = parentValues(row, parentField, node.parent, parent);
    if (
      parent === node.parent ||
      JSON.stringify(values[parentField.id]) === JSON.stringify(cellValue(row, parentField))
    )
      return;
    try {
      session.run([
        {
          kind: 'record.update',
          tableId: table.id,
          records: [{ id: row.id, values }],
        },
      ]);
      const next = new Set(collapsed);
      if (parent) next.delete(parent);
      const updatedRows = records.rows.map((record) =>
        record?.id === row.id ? { ...row, values: { ...row.values, ...values } } : record,
      );
      const updated = chartLayout(updatedRows, parentField, next, height);
      const selected = updated.byId.get(row.id);
      pendingFocus.current = row.id;
      change({
        ...collapsePatch(next, chartLayout(updatedRows, parentField, new Set(), height).nodes),
        active: row.id,
        ...(selected ? centerNode(selected, height, size, location.zoom) : {}),
      });
      gesture.setStatus(
        t({ id: 'views.orgChart.moved', message: 'Parent changed.  Use Undo to restore it.' }),
      );
    } catch (error) {
      reportError(error);
    }
  }
  useLayoutEffect(() => {
    latestMove.current = (id, parent) => {
      const current = full.byId.get(id);
      if (current && (parent === null || full.byId.has(parent))) move(current, parent);
    };
  });
  function drag(event: PointerEvent, node: ChartNode) {
    if (event.button !== 0 || printing) return;
    event.stopPropagation();
    // A view nothing can change has no move to refuse, so the pointer pans and a click selects.
    const reason = reading ? undefined : refusalFor(node.row);
    if (reading || reason) {
      startPan(event.pointerId, event, undefined, reason);
      return;
    }
    const targetAt = (point: DragPoint) => {
      const target = document.elementFromPoint(point.clientX, point.clientY)?.closest('[data-org-record]');
      const id = target?.getAttribute('data-org-record');
      return id ? full.byId.get(id) : undefined;
    };
    const allowed = (target: ChartNode | undefined) =>
      target && target.key !== node.parent && !within(full.tree, target.key, node.key);
    gesture.start(event, {
      pan(origin, point) {
        startPan(event.pointerId, origin, point);
      },
      move(point) {
        const target = targetAt(point);
        setDropTarget(allowed(target) ? target!.key : null);
        gesture.mark(
          viewport.current,
          allowed(target)
            ? t({ id: 'views.orgChart.drop', message: 'Drop to change the parent.' })
            : t({ id: 'views.orgChart.invalidDrop', message: 'Choose a different branch.' }),
          !allowed(target),
        );
      },
      finish() {
        setDropTarget(null);
      },
      drop(point) {
        const target = targetAt(point);
        if (allowed(target)) latestMove.current(node.key, target!.key);
      },
    });
  }
  function keyDown(event: KeyboardEvent) {
    if (!active || (event.target !== event.currentTarget && !(event.target instanceof SVGElement))) return;
    const key = event.key.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && !event.altKey && (key === 'z' || key === 'y')) {
      event.preventDefault();
      event.stopPropagation();
      if (!refused(active.row)) void undoAction(session, key === 'y' || event.shiftKey);
      return;
    }
    const index = layout.nodes.indexOf(active);
    if (event.altKey && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
      event.preventDefault();
      event.stopPropagation();
      if (refused(active.row)) return;
      const destination = neighborParent(full.tree, active, event.key === 'ArrowRight' ? 'in' : 'out');
      if (destination?.kind === 'parent') move(active, destination.parent);
      else
        gesture.setStatus(
          t({
            id: 'views.orgChart.noSibling',
            message: 'There is no previous sibling or parent to move under.',
          }),
        );
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      onExpand(active.key);
      return;
    }
    if (event.key === ' ' && active.children) {
      event.preventDefault();
      toggle(active);
      return;
    }
    let next: ChartNode | undefined;
    if (event.key === 'ArrowDown') next = layout.nodes[Math.min(layout.nodes.length - 1, index + 1)];
    else if (event.key === 'ArrowUp') next = layout.nodes[Math.max(0, index - 1)];
    else if (event.key === 'Home') next = layout.nodes[0];
    else if (event.key === 'End') next = layout.nodes[layout.nodes.length - 1];
    else if (event.key === 'ArrowRight') {
      if (active.children && !active.expanded) toggle(active);
      else next = layout.byId.get(layout.tree.children.get(active.key)?.[0] ?? '');
    } else if (event.key === 'ArrowLeft') {
      if (active.expanded) toggle(active);
      else next = layout.byId.get(active.parent ?? '');
    } else return;
    event.preventDefault();
    event.stopPropagation();
    if (next) select(next);
  }

  useLayoutEffect(() => {
    actions.current = {
      focus(node) {
        if (location.active !== node.key) change({ active: node.key });
      },
      select(node) {
        if (!gesture.suppressClick.current) select(node, false);
      },
      open(node) {
        if (!gesture.suppressClick.current) onExpand(node.key);
      },
      toggle,
      drag,
    };
  });

  return (
    <div className="rio-org-chart">
      <div className="rio-org-chart__tools">
        <input
          type="search"
          maxLength={200}
          aria-label={t({ id: 'views.orgChart.search', message: 'Find a record' })}
          value={location.search}
          onChange={(event) => change({ search: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.stopPropagation();
              find(false);
            } else if (event.key === 'ArrowDown' && active) {
              event.preventDefault();
              event.stopPropagation();
              select(active);
            }
          }}
        />
        <Button size="sm" onPress={() => find()}>
          {t({ id: 'views.orgChart.find', message: 'Find next' })}
        </Button>
        <Button size="sm" onPress={() => zoom(1.25)}>
          {t({ id: 'views.orgChart.zoomIn', message: 'Zoom in' })}
        </Button>
        <Button size="sm" onPress={() => zoom(0.8)}>
          {t({ id: 'views.orgChart.zoomOut', message: 'Zoom out' })}
        </Button>
        <Button size="sm" onPress={() => change(fitChart(layout, size))}>
          {t({ id: 'views.orgChart.fit', message: 'Fit chart' })}
        </Button>
        <Button
          size="sm"
          onPress={() => change({ allCollapsed: false, collapsed: [], ...fitChart(full, size) })}
          aria-label={t({ id: 'views.orgChart.expandAll', message: 'Expand all' })}
          icon={faChevronDown}
        />
        <Button
          size="sm"
          onPress={() => {
            const closed = full.nodes.filter((node) => node.children).map((node) => node.key);
            const updated = chartLayout(records.rows, parentField, new Set(closed), height);
            change({
              allCollapsed: true,
              collapsed: [],
              active: updated.nodes[0]?.key ?? null,
              ...fitChart(updated, size),
            });
          }}
          aria-label={t({ id: 'views.orgChart.collapseAll', message: 'Collapse all' })}
          icon={faChevronUp}
        />
        {active && (
          <>
            <Button size="sm" onPress={() => onExpand(active.key)}>
              {t({ id: 'views.orgChart.open', message: 'Open record' })}
            </Button>
            {active.children > 0 && (
              <Button
                size="sm"
                onPress={() => toggle(active)}
                aria-label={
                  active.expanded
                    ? t({ id: 'views.orgChart.collapse', message: 'Collapse branch' })
                    : t({ id: 'views.orgChart.expand', message: 'Expand branch' })
                }
                icon={faChevronUp}
              />
            )}
            {canMove && active.parent && !dropRefusal(props, active.row, [parentField]) && (
              <Button size="sm" onPress={() => move(active, null)}>
                {t({ id: 'views.orgChart.root', message: 'Move to top level' })}
              </Button>
            )}
          </>
        )}
      </div>
      <div ref={viewport} className="rio-org-chart__viewport">
        <svg
          role="tree"
          aria-label={view.name}
          aria-describedby={instructions}
          aria-busy={records.loading || undefined}
          width="100%"
          height="100%"
          onKeyDown={keyDown}
          onPointerDown={(event) => {
            if (event.button === 0 && !printing) startPan(event.pointerId, event);
          }}
        >
          <g role="presentation" transform={`translate(${camera.x} ${camera.y}) scale(${camera.zoom})`}>
            <g aria-hidden="true" className="rio-org-chart__edges">
              {drawn.edges.map((edge) => (
                <path key={edge.key} d={edge.path} />
              ))}
            </g>
            {drawn.nodes.map((node) => (
              <Card
                key={node.key}
                node={node}
                primary={primary}
                shown={shown}
                format={format}
                height={height}
                overview={camera.zoom < 0.35}
                selected={node.key === active?.key}
                drop={dropTarget === node.key}
                refusal={cardRefusal(node.row)}
                elements={nodes.current}
                actions={actions}
              />
            ))}
          </g>
        </svg>
      </div>
      <p id={instructions} className="rio-org-chart__sr">
        {t({
          id: 'views.orgChart.instructions',
          message:
            'Use Up and Down to move through records.  Right expands a branch or moves to its first child.  Left collapses a branch or moves to its parent.  Enter opens the record.  Alt+Right moves it under the previous sibling, and Alt+Left moves it out one level.  Drag to pan, or use the zoom and fit controls.  Scroll to pan, and hold Control or Command while scrolling to zoom.',
        })}
      </p>
      <div role="status" className="rio-org-chart__sr">
        {gesture.announcement}
      </div>
      {gesture.feedback}
      {(!records.count || records.loading || records.limited) && (
        <p className="rio-org-chart__notice">
          {records.limited
            ? t({
                id: 'views.orgChart.limited',
                message: `Showing the first ${MAX_RECORDS} records.  Filter the view to see the rest.`,
              })
            : records.loading
              ? t({ id: 'views.orgChart.loading', message: 'Loading records…' })
              : t({ id: 'views.orgChart.empty', message: 'No records in this view' })}
        </p>
      )}
    </div>
  );
}
