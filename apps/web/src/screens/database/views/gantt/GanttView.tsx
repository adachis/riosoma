import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useLingui } from '@lingui/react/macro';
import { GANTT_LABEL_WIDTH, isDependencyField, isProgressField, type FieldMeta } from '@riosoma/contracts';
import type { ViewComponentProps } from '../types';
import { useZoom } from '../timeline/channel';
import { DateSetup } from '../timeline/controls';
import { MIN_BAR_PX, type Bar } from '../timeline/layout';
import { dateField, dateFields, labelField, recordLabel } from '../timeline/model';
import { useViewRecords } from '../timeline/records';
import { LINE_HEIGHT, TimeChart, type ChartWindow } from '../timeline/TimeChart';
import { dependencyArrows, ganttLayout, isLate, progressOf, type Arrow } from './layout';
import './gantt.css';

/** Room for an arrow to leave one bar and turn toward the next, in CSS pixels. */
const ARROW_GAP = 10;
/** How far the arrow keys widen or narrow the label column. */
const RESIZE_STEP = 16;

function clampWidth(width: number): number {
  return Math.round(Math.min(GANTT_LABEL_WIDTH.max, Math.max(GANTT_LABEL_WIDTH.min, width)));
}

export function GanttView(props: ViewComponentProps) {
  const start = dateField(props.fields, props.view.config.gantt.startFieldId);
  if (!start) return <DateSetup kind="gantt" view={props} />;
  return <Gantt key={`${props.view.id}:${start.id}`} {...props} start={start} />;
}

function Gantt(props: ViewComponentProps & { start: FieldMeta }) {
  const { t } = useLingui();
  const { session, view, fields, table, format, canEdit, onConfig, onExpand } = props;
  const settings = view.config.gantt;
  const [zoom] = useZoom(view.id, settings.zoom, canEdit);
  const records = useViewRecords(session, view.id);
  const end = dateField(fields, settings.endFieldId);
  const dates = useMemo(() => dateFields(props.start, end, format), [props.start, end, format]);
  const dependency = fields.find(
    (field) => field.id === settings.dependencyFieldId && isDependencyField(field),
  );
  const progressField = fields.find(
    (field) => field.id === settings.progressFieldId && isProgressField(field),
  );
  const label = labelField(fields, settings.labelFieldId, table.primaryFieldId);
  const layout = useMemo(() => ganttLayout(records.rows, dates, zoom), [records.rows, dates, zoom]);
  const arrows = useMemo(() => dependencyArrows(layout, dependency), [layout, dependency]);
  const late = useMemo(
    () =>
      new Set(arrows.filter((arrow) => isLate(arrow.from.span, arrow.to.span)).map((arrow) => arrow.to.key)),
    [arrows],
  );
  const [width, setWidth] = useState<number | null>(null);
  const labelWidth = width ?? settings.labelWidth;
  const resizeCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => resizeCleanup.current?.(), []);
  const untitled = t({ id: 'views.gantt.untitled', message: 'Untitled record' });
  const percent = useMemo(
    () => new Intl.NumberFormat(format.locale, { style: 'percent', maximumFractionDigits: 0 }),
    [format.locale],
  );

  /** Saves the label column's width with the view, or keeps it for this person alone. */
  function commitWidth(next: number) {
    const value = clampWidth(next);
    if (canEdit) {
      onConfig({ gantt: { ...settings, labelWidth: value } });
      setWidth(null);
    } else setWidth(value);
  }

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    resizeCleanup.current?.();
    const x = event.clientX;
    const from = labelWidth;
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const pointerId = event.pointerId;
    let latest = from;
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      resizeCleanup.current = null;
    };
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      latest = clampWidth(from + (next.clientX - x) * (rtl ? -1 : 1));
      setWidth(latest);
    };
    const up = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      cleanup();
      if (latest !== from) commitWidth(latest);
      else if (canEdit) setWidth(null);
    };
    const cancel = () => {
      cleanup();
      setWidth(canEdit ? null : from);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    resizeCleanup.current = cleanup;
  }

  function resizeKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const steps: Record<string, number> = {
      ArrowRight: rtl ? -RESIZE_STEP : RESIZE_STEP,
      ArrowLeft: rtl ? RESIZE_STEP : -RESIZE_STEP,
    };
    let next: number | undefined;
    if (event.key === 'Home') next = GANTT_LABEL_WIDTH.min;
    else if (event.key === 'End') next = GANTT_LABEL_WIDTH.max;
    else if (steps[event.key] !== undefined) next = labelWidth + steps[event.key]!;
    if (next === undefined) return;
    event.preventDefault();
    commitWidth(next);
  }

  const describe = (bar: Bar, labelText: string, when: string, fields: string) => {
    // The bar shows its label and field values together, so the name starts with those words.
    const text = fields ? `${labelText} ${fields}` : labelText;
    const progress = progressOf(bar.row, progressField);
    const done = progress === null ? '' : percent.format(progress / 100);
    const base =
      progress === null
        ? t({ id: 'views.gantt.bar', message: `${text}, ${when}` })
        : t({ id: 'views.gantt.bar.progress', message: `${text}, ${when}, ${done} done` });
    return late.has(bar.key)
      ? t({ id: 'views.gantt.bar.late', message: `${base}, starts before a dependency ends` })
      : base;
  };

  const side = {
    width: labelWidth,
    corner: (
      <div className="rio-gantt__corner">
        <span className="rio-gantt__corner-name">{label?.name}</span>
        <div
          role="separator"
          className="rio-gantt__resize"
          aria-orientation="vertical"
          aria-label={t({ id: 'views.gantt.resize', message: 'Label column width' })}
          aria-valuemin={GANTT_LABEL_WIDTH.min}
          aria-valuemax={GANTT_LABEL_WIDTH.max}
          aria-valuenow={labelWidth}
          tabIndex={0}
          onPointerDown={startResize}
          onKeyDown={resizeKey}
        />
      </div>
    ),
    render: (fromLine: number, toLine: number) => {
      const labels = [];
      for (let index = fromLine; index < toLine; index++) {
        const row = records.rows[index];
        labels.push(
          <div
            key={row?.id ?? `loading-${index}`}
            className="rio-gantt__label"
            style={{ insetBlockStart: index * LINE_HEIGHT }}
          >
            {row ? (
              <button
                type="button"
                className="rio-gantt__open"
                tabIndex={-1}
                onClick={() => onExpand(row.id)}
              >
                {recordLabel(row, label, format) || untitled}
              </button>
            ) : (
              <span className="rio-gantt__placeholder" aria-hidden="true" />
            )}
          </div>,
        );
      }
      return labels;
    },
  };

  return (
    <TimeChart
      className="rio-gantt"
      view={props}
      dates={dates}
      dependency={dependency}
      label={label}
      zoom={zoom}
      layout={layout}
      lineCount={records.rows.length}
      side={side}
      describe={describe}
      decorate={(bar) => {
        const progress = progressOf(bar.row, progressField);
        return progress === null ? null : (
          <span className="rio-gantt__progress" aria-hidden="true" style={{ inlineSize: `${progress}%` }} />
        );
      }}
      state={(bar) => ({
        'data-progress': progressField ? true : undefined,
        'data-late': late.has(bar.key) || undefined,
      })}
      overlay={(area) => <Arrows arrows={arrows} area={area} />}
      empty={
        !records.loading && records.count === 0
          ? t({ id: 'views.gantt.empty', message: 'No records in this view' })
          : null
      }
      loading={records.loading}
      limited={records.limited}
    />
  );
}

/** Dependency arrows in view: from the end of each dependency to the start of its dependent. */
function Arrows({ arrows, area }: { arrows: readonly Arrow[]; area: ChartWindow }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const { axis, fromLine, toLine, fromDay, toDay, spanOf } = area;
  const left = axis.x(Math.max(fromDay, axis.start));
  const right = axis.x(Math.min(toDay + 1, axis.end));
  const top = fromLine * LINE_HEIGHT;
  const bottom = toLine * LINE_HEIGHT;
  if (right <= left || bottom <= top) return null;
  const paths = [];
  for (const arrow of arrows) {
    const high = Math.min(arrow.from.line, arrow.to.line);
    const low = Math.max(arrow.from.line, arrow.to.line);
    if (low < fromLine || high >= toLine) continue;
    const from = spanOf(arrow.from);
    const to = spanOf(arrow.to);
    const x1 = axis.x(from.start) + Math.max(MIN_BAR_PX, (from.end - from.start + 1) * axis.px);
    const x2 = axis.x(to.start);
    if (Math.max(x1, x2) + ARROW_GAP < left || Math.min(x1, x2) - ARROW_GAP > right) continue;
    const y1 = arrow.from.line * LINE_HEIGHT + LINE_HEIGHT / 2;
    const y2 = arrow.to.line * LINE_HEIGHT + LINE_HEIGHT / 2;
    // Room to turn straight down to the dependent, or a detour between the rows when it starts too soon.
    const d =
      x2 - x1 >= ARROW_GAP * 2
        ? `M${x1} ${y1}H${x1 + ARROW_GAP}V${y2}H${x2}`
        : `M${x1} ${y1}H${x1 + ARROW_GAP}V${y1 + (y2 > y1 ? 1 : -1) * (LINE_HEIGHT / 2)}H${x2 - ARROW_GAP}V${y2}H${x2}`;
    const late = isLate(from, to);
    paths.push(
      <path
        key={arrow.key}
        className="rio-gantt__arrow"
        data-late={late || undefined}
        data-from={arrow.from.key}
        data-to={arrow.to.key}
        d={d}
        markerEnd={`url(#${id}-${late ? 'late' : 'arrow'})`}
      />,
    );
  }
  return (
    <svg
      className="rio-gantt__arrows"
      aria-hidden="true"
      focusable="false"
      style={{
        insetInlineStart: left,
        insetBlockStart: top,
        inlineSize: right - left,
        blockSize: bottom - top,
      }}
      viewBox={`${left} ${top} ${right - left} ${bottom - top}`}
    >
      <defs>
        {(['arrow', 'late'] as const).map((kind) => (
          <marker
            key={kind}
            id={`${id}-${kind}`}
            viewBox="0 0 8 8"
            refX="8"
            refY="4"
            markerWidth="8"
            markerHeight="8"
            markerUnits="userSpaceOnUse"
            orient="auto"
          >
            <path
              className="rio-gantt__arrowhead"
              data-late={kind === 'late' || undefined}
              d="M0 0L8 4L0 8z"
            />
          </marker>
        ))}
      </defs>
      {paths}
    </svg>
  );
}
