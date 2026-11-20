import { shortcutKeys } from '../../../../shortcuts/registry';
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { useLingui } from '@lingui/react/macro';
import { cellValue, visibleFieldIds, type FieldMeta, type TimelineZoom } from '@riosoma/contracts';
import { reportError } from '../../../../grid/view/actions';
import { formatCell } from '../../../../grid/format';
import { buttonLabel } from '../../../../fields/buttons';
import { CardValue } from '../CardValue';
import { showsText } from '../showsText';
import { dayInZone, firstWeekday } from '../calendar/dates';
import type { ViewComponentProps } from '../types';
import { useDependencyRequests, useTodayRequests } from './channel';
import { barsBetween, MIN_BAR_PX, type Bar } from './layout';
import {
  changedSpan,
  editing,
  keyedSpan,
  recordLabel,
  recordSpan,
  spanValues,
  type Change,
  type DateFields,
  type Span,
} from './model';
import { MAX_RECORDS } from './records';
import { cells, dayDate, dayNumber, makeAxis, parentZoom, type Axis } from './scale';
import { dropRefusal } from '../drag/rules';
import { useHeld, useViewDrag } from '../drag/useViewDrag';
import { useDependencies } from '../gantt/dependencies';
import './timeline.css';

/** Heights in CSS pixels: one line of bars, a bar on it, and the two rows of the time header. */
export const LINE_HEIGHT = 40;
export const BAR_HEIGHT = 28;
export const HEADER_HEIGHT = 48;

/** Drawn beyond each edge of the view, so scrolling shows bars that are already there. */
const OVERSCAN_PX = 480;
const OVERSCAN_LINES = 5;
/** Resize edges appear on bars at least this wide, leaving room to grab the middle */
const EDGE_MIN_PX = 24;
const HOVER_DELAY_MS = 500;
/** What an unmeasured view (a test, a hidden tab) lays out for */
const FALLBACK_WIDTH = 1200;
const FALLBACK_HEIGHT = 800;

export interface ChartLayout {
  /** Each line's bars, earliest first */
  lines: ReadonlyArray<readonly Bar[]>;
  /** Every bar in keyboard order */
  order: readonly Bar[];
  byKey: ReadonlyMap<string, Bar>;
  first: number | null;
  last: number | null;
}

/** The part of the chart in view, with some to spare, for drawing only what shows. */
export interface ChartWindow {
  axis: Axis;
  fromLine: number;
  toLine: number;
  fromDay: number;
  toDay: number;
  /** Where a bar is drawn right now, following a drag in progress */
  spanOf(bar: Bar): Span;
}

export interface ChartSide {
  width: number;
  corner: ReactNode;
  render(fromLine: number, toLine: number): ReactNode;
}

export interface TimeChartProps {
  view: ViewComponentProps;
  dates: DateFields;
  dependency?: FieldMeta;
  label: FieldMeta | undefined;
  zoom: TimelineZoom;
  layout: ChartLayout;
  lineCount: number;
  side: ChartSide | null;
  /** What a screen reader hears for a bar, given its label, dates, and the field values it shows */
  describe(bar: Bar, label: string, dates: string, fields: string): string;
  /** Extra parts drawn inside a bar, such as progress */
  decorate?(bar: Bar): ReactNode;
  /** Data attributes for a bar's own states */
  state?(bar: Bar): Record<string, true | undefined>;
  /** Drawn over the bars, such as dependency arrows */
  overlay?(window: ChartWindow): ReactNode;
  /** Said over an empty chart, such as when no record has a start date */
  empty?: string | null;
  /** Another class for the chart, for styles of its own */
  className?: string;
  loading: boolean;
  limited: boolean;
}

interface Drag {
  key: string;
  change: Change;
  delta: number;
}

function isRtl(element: Element): boolean {
  return getComputedStyle(element).direction === 'rtl';
}

/** Sets how far a scroller is scrolled from its inline start, in either writing direction. */
function scrollInline(node: HTMLElement, offset: number): void {
  const value = Math.max(0, offset);
  node.scrollLeft = isRtl(node) ? -value : value;
}

function todayIn(zone: string): number {
  return dayNumber(dayInZone(new Date().toISOString(), zone));
}

/**
 * The time chart that timelines and Gantt charts share: a sticky time header, a column of labels
 * that stays put while the chart scrolls sideways, a line for today, and bars that move and resize
 * by pointer or keyboard.  Only the bars, lines, and header cells in view are drawn.
 */
export function TimeChart(latest: TimeChartProps) {
  const { t } = useLingui();
  const moveLeft = shortcutKeys('views.moveLeft');
  const moveRight = shortcutKeys('views.moveRight');
  const endLeft = shortcutKeys('views.endLeft');
  const endRight = shortcutKeys('views.endRight');
  const dependencyKeys = shortcutKeys('views.dependencies');
  const gesture = useViewDrag();
  const props = useHeld(latest, gesture.holding);
  const { session, table, view, fields, format, onExpand } = props.view;
  const layout = props.layout;
  const { zoom, dates } = props;
  const edit = editing(props.view, dates);
  const sideWidth = props.side?.width ?? 0;
  const weekStart = useMemo(() => firstWeekday(format.locale), [format.locale]);
  const [today, setToday] = useState(() => todayIn(dates.startZone));
  const [viewport, setViewport] = useState({
    offset: 0,
    top: 0,
    width: FALLBACK_WIDTH,
    height: FALLBACK_HEIGHT,
  });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const barNodes = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<string | null>(null);
  const reveal = useRef<string | null>(null);
  const suppressClick = gesture.suppressClick;
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Where the chart last scrolled itself to, and whether it's keeping today in view */
  const placed = useRef<{ start: number; px: number; offset: number; today: boolean } | null>(null);
  const tooltipId = useId();
  const instructionsId = useId();
  const dependencies = useDependencies(props.view, props.dependency, layout.order, gesture);
  useEffect(
    () => () => {
      clearTimeout(hoverTimer.current);
    },
    [],
  );

  const axis = useMemo(
    () =>
      makeAxis(
        layout.first ?? today,
        layout.last ?? today,
        today,
        zoom,
        weekStart,
        viewport.width - sideWidth,
      ),
    [layout.first, layout.last, today, zoom, weekStart, viewport.width, sideWidth],
  );

  const measure = useCallback(() => {
    const node = scroller.current;
    if (!node) return;
    const next = {
      offset: Math.abs(node.scrollLeft),
      top: node.scrollTop,
      width: node.clientWidth || FALLBACK_WIDTH,
      height: node.clientHeight || FALLBACK_HEIGHT,
    };
    setViewport((previous) =>
      previous.offset === next.offset &&
      previous.top === next.top &&
      previous.width === next.width &&
      previous.height === next.height
        ? previous
        : next,
    );
  }, []);

  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(node);
    return () => observer.disconnect();
  }, [measure]);

  const place = useCallback((node: HTMLElement, offset: number, followToday: boolean, at: Axis) => {
    scrollInline(node, offset);
    placed.current = { start: at.start, px: at.px, offset: Math.abs(node.scrollLeft), today: followToday };
  }, []);

  // Opens with today a third of the way in, and keeps it there while records load and widen the
  // axis.  Once the person scrolls sideways, a new zoom or axis keeps the day in the middle instead.
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const before = placed.current;
    if (before && before.start === axis.start && before.px === axis.px) return;
    const visible = Math.max(0, (node.clientWidth || FALLBACK_WIDTH) - sideWidth);
    if (!before || before.today) place(node, axis.x(today) - visible / 3, true, axis);
    else {
      const middle = before.start + (Math.abs(node.scrollLeft) + visible / 2) / before.px;
      place(node, axis.x(middle) - visible / 2, false, axis);
    }
    measure();
  }, [axis, today, sideWidth, measure, place]);

  const goToday = useCallback(() => {
    const day = todayIn(dates.startZone);
    setToday(day);
    const node = scroller.current;
    if (!node) return;
    const visible = Math.max(0, (node.clientWidth || FALLBACK_WIDTH) - sideWidth);
    place(node, axis.x(day) - visible / 3, true, axis);
    measure();
  }, [dates.startZone, axis, sideWidth, measure, place]);
  useTodayRequests(view.id, goToday);

  // The settings bar's dependency item opens the dialog for the bar reached last, or the first one.
  // It's the way in on a touch screen, which has no key to press, and where a short bar hides the
  // diamond and a tap on a bar opens its record instead of focusing it.
  const openDependencies = useCallback(() => {
    const bar = (current !== null ? layout.byKey.get(current) : undefined) ?? layout.order[0];
    if (bar) dependencies.open(bar);
  }, [current, layout, dependencies]);
  useDependencyRequests(view.id, openDependencies);

  function scrolled() {
    const node = scroller.current;
    const before = placed.current;
    if (node && before && Math.abs(Math.abs(node.scrollLeft) - before.offset) > 1) before.today = false;
    measure();
  }

  // Keyboard navigation focuses a bar once it's drawn, and a keyboard move keeps its bar in view.
  useLayoutEffect(() => {
    const focus = pendingFocus.current;
    if (focus) {
      const node = barNodes.current.get(focus);
      if (node) {
        pendingFocus.current = null;
        node.focus();
      }
    }
    const shown = reveal.current;
    if (shown) {
      reveal.current = null;
      barNodes.current.get(shown)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
  });

  const dateFormat = useMemo(
    () => new Intl.DateTimeFormat(format.locale, { dateStyle: 'medium', timeZone: 'UTC' }),
    [format.locale],
  );
  const describeDates = (span: Span) =>
    span.open || span.start === span.end
      ? dateFormat.format(dayDate(span.start))
      : dateFormat.formatRange(dayDate(span.start), dayDate(span.end));
  const untitled = t({ id: 'views.timeline.untitled', message: 'Untitled record' });
  const labelOf = (bar: Bar) => recordLabel(bar.row, props.label, format) || untitled;
  /**
   * The field values a bar shows, as its name says them: the visible words first, as one run in
   * display order, then the words of values that show only a mark, before the dates.
   */
  const fieldsOf = (bar: Bar) => {
    const visible: string[] = [];
    const marks: string[] = [];
    for (const field of shownFields) {
      const value = cellValue(bar.row, field);
      const text = field.type === 'button' ? buttonLabel(field) : formatCell(field, value, format);
      if (text === '') continue;
      (showsText(field, value) ? visible : marks).push(text);
    }
    return [...visible, ...marks].join(' ');
  };
  const spanOf = (bar: Bar): Span =>
    drag?.key === bar.key ? changedSpan(bar.span, drag.change, drag.delta) : bar.span;
  const shownFields = visibleFieldIds(view.config, fields, table.primaryFieldId).flatMap((id) => {
    const field = fields.find((candidate) => candidate.id === id);
    return field && field.id !== props.label?.id ? [field] : [];
  });

  /** Writes a bar's new dates from the freshest copy of its record, as one undoable change. */
  function apply(bar: Bar, change: Change, next: (span: Span) => Span): void {
    const row = session.cachedRecord(table.id, bar.row.id) ?? bar.row;
    const reason = refusal(bar, change);
    if (reason) {
      gesture.setStatus(gesture.reasons[reason]);
      return;
    }
    const before = recordSpan(row, dates, zoom);
    if (!before) return;
    const after = next(before);
    if (after.start === before.start && after.end === before.end) return;
    try {
      const values = spanValues(row, dates, before, after, change, format, edit.end);
      if (!Object.keys(values).length) return;
      session.run([{ kind: 'record.update', tableId: table.id, records: [{ id: row.id, values }] }]);
    } catch (error) {
      reportError(error);
      return;
    }
    const text = describeDates(after);
    const first = dateFormat.format(dayDate(after.start));
    const last = dateFormat.format(dayDate(after.end));
    gesture.setStatus(
      change === 'move'
        ? t({ id: 'views.timeline.moved', message: `Moved to ${text}` })
        : change === 'start'
          ? t({ id: 'views.timeline.startChanged', message: `Now starts ${first}` })
          : t({ id: 'views.timeline.endChanged', message: `Now ends ${last}` }),
    );
  }

  function allowed(change: Change): boolean {
    return change === 'move' ? edit.move : change === 'start' ? edit.start : edit.end;
  }

  function refusal(bar: Bar, change: Change) {
    const fields =
      change === 'end'
        ? dates.end
          ? [dates.end]
          : []
        : change === 'start' && !bar.span.open
          ? [dates.start]
          : [dates.start, ...(dates.end ? [dates.end] : [])];
    return dropRefusal(props.view, bar.row, fields);
  }

  function startDrag(event: ReactPointerEvent<HTMLButtonElement>, bar: Bar) {
    if (props.view.readOnly) return;
    if (event.target instanceof Element && event.target.closest('[data-dependency]')) {
      dependencies.start(event, bar, {
        top: HEADER_HEIGHT,
        [isRtl(event.currentTarget) ? 'right' : 'left']: sideWidth,
      });
      return;
    }
    const edge = event.target instanceof Element ? event.target.closest('[data-edge]') : null;
    const change: Change = edge?.getAttribute('data-edge') === 'start' ? 'start' : edge ? 'end' : 'move';
    const node = event.currentTarget;
    const x = event.clientX;
    const offset = Math.abs(scroller.current?.scrollLeft ?? 0);
    const rtl = isRtl(node);
    const deltaAt = (point: { clientX: number }) =>
      Math.round(
        ((point.clientX - x) * (rtl ? -1 : 1) + Math.abs(scroller.current?.scrollLeft ?? 0) - offset) /
          axis.px,
      );
    gesture.start(event, {
      scroll: scroller.current,
      scrollInsets: { top: HEADER_HEIGHT, [rtl ? 'right' : 'left']: sideWidth },
      move(point) {
        const reason = refusal(bar, change);
        clearTimeout(hoverTimer.current);
        setHovered(null);
        if (!reason && allowed(change)) {
          const delta = deltaAt(point);
          setDrag((current) =>
            current?.key === bar.key && current.change === change && current.delta === delta
              ? current
              : { key: bar.key, change, delta },
          );
        }
        const when = describeDates(changedSpan(bar.span, change, deltaAt(point)));
        gesture.mark(
          node,
          reason
            ? gesture.reasons[reason]
            : t({ id: 'views.timeline.dropDates', message: `Release to save ${when}` }),
          !!reason,
        );
      },
      drop(point) {
        if (allowed(change)) apply(bar, change, (span) => changedSpan(span, change, deltaAt(point)));
      },
      finish() {
        setDrag(null);
      },
    });
  }

  const position = useMemo(() => new Map(layout.order.map((bar, index) => [bar.key, index])), [layout.order]);

  function keyDown(event: ReactKeyboardEvent<HTMLButtonElement>, bar: Bar) {
    if (!props.view.readOnly && event.altKey && event.code === 'KeyD' && props.dependency) {
      event.preventDefault();
      dependencies.open(bar);
      return;
    }
    if (event.ctrlKey || event.metaKey) return;
    const { key } = event;
    if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'Home' || key === 'End') {
      const at = position.get(bar.key) ?? 0;
      const target =
        key === 'Home'
          ? layout.order[0]
          : key === 'End'
            ? layout.order[layout.order.length - 1]
            : layout.order[at + (key === 'ArrowDown' ? 1 : -1)];
      event.preventDefault();
      if (!target || target.key === bar.key) return;
      setCurrent(target.key);
      pendingFocus.current = target.key;
      return;
    }
    if (key !== 'ArrowLeft' && key !== 'ArrowRight') return;
    const change = event.altKey ? 'start' : event.shiftKey ? 'end' : 'move';
    if (!allowed(change)) return;
    event.preventDefault();
    const direction = (key === 'ArrowRight') !== isRtl(event.currentTarget) ? 1 : -1;
    reveal.current = bar.key;
    apply(bar, change, (span) => keyedSpan(span, change, zoom, direction));
  }

  function hover(key: string | null) {
    clearTimeout(hoverTimer.current);
    if (key === null) setHovered(null);
    else if (!drag) hoverTimer.current = setTimeout(() => setHovered(key), HOVER_DELAY_MS);
  }

  // What's in view, with some to spare on every side.
  const visibleWidth = Math.max(0, viewport.width - sideWidth);
  const spare = Math.ceil(OVERSCAN_PX / axis.px);
  const fromDay = axis.start + Math.floor(viewport.offset / axis.px) - spare;
  const toDay = axis.start + Math.ceil((viewport.offset + visibleWidth) / axis.px) + spare;
  const fromLine = Math.max(0, Math.floor(viewport.top / LINE_HEIGHT) - OVERSCAN_LINES);
  const toLine = Math.min(
    props.lineCount,
    Math.ceil((viewport.top + viewport.height - HEADER_HEIGHT) / LINE_HEIGHT) + OVERSCAN_LINES,
  );
  const least = Math.ceil(MIN_BAR_PX / axis.px);
  const shown: Bar[] = [];
  for (let line = fromLine; line < toLine; line++)
    shown.push(...barsBetween(layout.lines[line] ?? [], fromDay, toDay, least));
  // One bar is always in the tab order: the last one focused, or the first in view.
  const tabbable =
    (current !== null && layout.byKey.has(current) ? current : null) ??
    shown[0]?.key ??
    layout.order[0]?.key ??
    null;
  // The tab stop and a dragged bar stay drawn wherever the view scrolls.
  const drawn = new Set(shown.map((bar) => bar.key));
  for (const key of [tabbable, drag?.key]) {
    const bar = key ? layout.byKey.get(key) : undefined;
    if (bar && !drawn.has(bar.key)) {
      shown.push(bar);
      drawn.add(bar.key);
    }
  }
  const area: ChartWindow = { axis, fromLine, toLine, fromDay, toDay, spanOf };

  const parent = parentZoom(zoom);
  const unitCells = cells(Math.max(fromDay, axis.start), Math.min(toDay, axis.end - 1), zoom, weekStart);
  const parentCells = parent
    ? cells(Math.max(fromDay, axis.start), Math.min(toDay, axis.end - 1), parent, weekStart)
    : [];
  const formats = useMemo(
    () => ({
      day: new Intl.DateTimeFormat(format.locale, { day: 'numeric', timeZone: 'UTC' }),
      week: new Intl.DateTimeFormat(format.locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }),
      month: new Intl.DateTimeFormat(format.locale, { month: 'short', timeZone: 'UTC' }),
      monthYear: new Intl.DateTimeFormat(format.locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }),
      year: new Intl.DateTimeFormat(format.locale, { year: 'numeric', timeZone: 'UTC' }),
    }),
    [format.locale],
  );
  const unitLabel = (start: number) => {
    const date = dayDate(start);
    if (zoom === 'day') return formats.day.format(date);
    if (zoom === 'week') return formats.week.format(date);
    if (zoom === 'month') return formats.month.format(date);
    if (zoom === 'quarter') {
      const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
      return t({ id: 'views.timeline.quarter', message: `Q${quarter}` });
    }
    return formats.year.format(date);
  };
  const parentLabel = (start: number) =>
    parent === 'month' ? formats.monthYear.format(dayDate(start)) : formats.year.format(dayDate(start));

  const units: Record<TimelineZoom, string> = {
    day: t({ id: 'views.timeline.unit.day', message: 'day' }),
    week: t({ id: 'views.timeline.unit.week', message: 'week' }),
    month: t({ id: 'views.timeline.unit.month', message: 'month' }),
    quarter: t({ id: 'views.timeline.unit.quarter', message: 'quarter' }),
    year: t({ id: 'views.timeline.unit.year', message: 'year' }),
  };
  const unit = units[zoom];
  const instructions =
    edit.move && edit.end
      ? t({
          id: 'views.timeline.keys.all',
          message: `Up and Down go between records.  Left and Right move a record by one ${unit}, and ${endLeft} or ${endRight} changes when it ends.  Enter opens it.`,
        })
      : edit.move
        ? t({
            id: 'views.timeline.keys.move',
            message: `Up and Down go between records.  Left and Right move a record by one ${unit}.  Enter opens it.`,
          })
        : edit.end
          ? t({
              id: 'views.timeline.keys.end',
              message: `Up and Down go between records.  ${endLeft} or ${endRight} changes when a record ends, by one ${unit}.  Enter opens it.`,
            })
          : t({
              id: 'views.timeline.keys.read',
              message: 'Up and Down go between records.  Enter opens one.',
            });
  const shortcuts = [
    'ArrowUp ArrowDown Home End',
    edit.move ? 'ArrowLeft ArrowRight' : '',
    edit.end ? 'Shift+ArrowLeft Shift+ArrowRight' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const limit = new Intl.NumberFormat(format.locale).format(MAX_RECORDS);
  const hint = hovered ?? focused;
  const hintBar = hint && !drag ? layout.byKey.get(hint) : undefined;
  const canvasWidth = sideWidth + axis.width;
  const bodyHeight = props.lineCount * LINE_HEIGHT;
  const todayX = today >= axis.start && today < axis.end ? axis.x(today) + axis.px / 2 : null;

  function tooltip(bar: Bar) {
    const span = spanOf(bar);
    const top = bar.line * LINE_HEIGHT;
    // Below the bar when there's room in view, above it otherwise.
    const below = top + LINE_HEIGHT + 160 < viewport.top + viewport.height - HEADER_HEIGHT;
    const start = Math.min(
      Math.max(axis.x(span.start), viewport.offset),
      Math.max(viewport.offset, viewport.offset + visibleWidth - 320),
    );
    return (
      <div
        id={tooltipId}
        role="tooltip"
        className="rio-timeline-chart__tooltip"
        style={{
          insetInlineStart: start,
          ...(below
            ? { insetBlockStart: top + (LINE_HEIGHT + BAR_HEIGHT) / 2 + 4 }
            : { insetBlockEnd: bodyHeight - top - (LINE_HEIGHT - BAR_HEIGHT) / 2 + 4 }),
        }}
      >
        <strong>{labelOf(bar)}</strong>
        <span>{describeDates(span)}</span>
        {shownFields.map((field) => (
          <span className="rio-timeline-chart__tooltip-field" key={field.id}>
            <span className="rio-timeline-chart__tooltip-name">{field.name}</span>
            <span>
              <CardValue field={field} value={cellValue(bar.row, field)} format={format} />
            </span>
          </span>
        ))}
      </div>
    );
  }

  function renderBar(bar: Bar) {
    const span = spanOf(bar);
    const width = Math.max(MIN_BAR_PX, (span.end - span.start + 1) * axis.px);
    const label = labelOf(bar);
    const edges = width >= EDGE_MIN_PX;
    return (
      <button
        key={bar.key}
        ref={(node) => {
          if (node) barNodes.current.set(bar.key, node);
          else barNodes.current.delete(bar.key);
        }}
        type="button"
        className="rio-timeline-bar"
        data-bar-key={bar.key}
        data-open={span.open || undefined}
        data-dragging={drag?.key === bar.key || undefined}
        data-movable={edit.move || undefined}
        {...props.state?.(bar)}
        tabIndex={bar.key === tabbable ? 0 : -1}
        aria-label={props.describe(bar, label, describeDates(span), fieldsOf(bar))}
        aria-keyshortcuts={shortcuts}
        aria-describedby={hintBar?.key === bar.key ? tooltipId : instructionsId}
        style={{
          insetInlineStart: axis.x(span.start),
          insetBlockStart: bar.line * LINE_HEIGHT + (LINE_HEIGHT - BAR_HEIGHT) / 2,
          inlineSize: width,
        }}
        onPointerDown={(event) => startDrag(event, bar)}
        onClick={() => {
          if (!suppressClick.current) onExpand(bar.row.id);
        }}
        onKeyDown={(event) => keyDown(event, bar)}
        onFocus={() => {
          setCurrent(bar.key);
          setFocused(bar.key);
        }}
        onBlur={() => setFocused(null)}
        onPointerEnter={() => hover(bar.key)}
        onPointerLeave={() => hover(null)}
      >
        {props.dependency && !props.view.readOnly && (
          <span
            className="rio-timeline-bar__dependency"
            data-dependency
            data-coarse-hidden={width < 106 || undefined}
            aria-hidden="true"
          >
            ◇
          </span>
        )}
        {props.decorate?.(bar)}
        <span className="rio-timeline-bar__content">
          <span className="rio-timeline-bar__label">{label}</span>
          {shownFields.map((field) => (
            <Fragment key={field.id}>
              {' '}
              <span className="rio-timeline-bar__field">
                <CardValue field={field} value={cellValue(bar.row, field)} format={format} />
              </span>
            </Fragment>
          ))}
        </span>
        {edges && edit.start && (
          <span className="rio-timeline-bar__edge" data-edge="start" aria-hidden="true" />
        )}
        {edges && edit.end && <span className="rio-timeline-bar__edge" data-edge="end" aria-hidden="true" />}
      </button>
    );
  }

  return (
    <div
      className={props.className ? `rio-timeline-chart ${props.className}` : 'rio-timeline-chart'}
      data-dragging={drag ? true : undefined}
    >
      <div
        ref={scroller}
        className="rio-timeline-chart__scroller"
        tabIndex={shown.length ? undefined : 0}
        style={{ scrollPaddingInlineStart: sideWidth, scrollPaddingBlockStart: HEADER_HEIGHT }}
        onScroll={scrolled}
        onClickCapture={(event) => {
          if (suppressClick.current) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        <div
          className="rio-timeline-chart__canvas"
          style={{ inlineSize: canvasWidth, blockSize: HEADER_HEIGHT + bodyHeight }}
        >
          <div className="rio-timeline-chart__header">
            {props.side && (
              <div className="rio-timeline-chart__corner" style={{ inlineSize: sideWidth }}>
                {props.side.corner}
              </div>
            )}
            <div className="rio-timeline-chart__scale" aria-hidden="true" style={{ inlineSize: axis.width }}>
              {parentCells.map((cell) => (
                <div
                  key={`parent-${cell.start}`}
                  className="rio-timeline-chart__cell"
                  data-row="top"
                  style={{
                    insetInlineStart: axis.x(Math.max(cell.start, axis.start)),
                    inlineSize: (Math.min(cell.end, axis.end) - Math.max(cell.start, axis.start)) * axis.px,
                  }}
                >
                  <span className="rio-timeline-chart__cell-label" style={{ insetInlineStart: sideWidth }}>
                    {parentLabel(cell.start)}
                  </span>
                </div>
              ))}
              {unitCells.map((cell) => (
                <div
                  key={`unit-${cell.start}`}
                  className="rio-timeline-chart__cell"
                  data-row="bottom"
                  data-today={(today >= cell.start && today < cell.end) || undefined}
                  style={{
                    insetInlineStart: axis.x(cell.start),
                    inlineSize: (cell.end - cell.start) * axis.px,
                  }}
                >
                  {unitLabel(cell.start)}
                </div>
              ))}
              {todayX !== null && (
                <div className="rio-timeline-chart__today" style={{ insetInlineStart: todayX }} />
              )}
            </div>
          </div>
          <div className="rio-timeline-chart__body" style={{ blockSize: bodyHeight }}>
            {props.side && (
              <div className="rio-timeline-chart__side" style={{ inlineSize: sideWidth }}>
                {props.side.render(fromLine, toLine)}
              </div>
            )}
            <div
              className="rio-timeline-chart__track"
              role="group"
              aria-label={view.name}
              aria-describedby={instructionsId}
              aria-busy={props.loading || undefined}
              style={{ inlineSize: axis.width }}
            >
              {unitCells.map((cell) => (
                <div
                  key={cell.start}
                  className="rio-timeline-chart__gridline"
                  aria-hidden="true"
                  style={{ insetInlineStart: axis.x(cell.start) }}
                />
              ))}
              {todayX !== null && (
                <div
                  className="rio-timeline-chart__today"
                  aria-hidden="true"
                  style={{ insetInlineStart: todayX }}
                />
              )}
              {props.overlay?.(area)}
              {shown.map(renderBar)}
              {hintBar && tooltip(hintBar)}
            </div>
          </div>
        </div>
      </div>
      {props.empty && <p className="rio-timeline-chart__empty">{props.empty}</p>}
      <p id={instructionsId} className="rio-view-drag-status">
        {instructions}{' '}
        {!props.view.readOnly &&
          t({
            id: 'views.timeline.keys.start',
            message: `${moveLeft} or ${moveRight} changes the start.  On a touch screen, press briefly before dragging.  Escape cancels a drag.`,
          })}
        {props.dependency &&
          !props.view.readOnly &&
          t({
            id: 'views.gantt.dependencyKeys',
            message: `Drag the diamond to another bar to add or remove a dependency.  ${dependencyKeys} opens dependency actions.`,
          })}
      </p>
      {gesture.feedback}
      {dependencies.dialog}
      <div className="rio-timeline-chart__status" role="status">
        {gesture.announcement}
      </div>
      {(props.loading || props.limited) && (
        <div className="rio-timeline-chart__notice">
          {props.limited
            ? t({
                id: 'views.timeline.limited',
                message: `Showing the first ${limit} records.  Filter the view to see the rest.`,
              })
            : t({ id: 'views.timeline.loading', message: 'Loading records…' })}
        </div>
      )}
    </div>
  );
}
