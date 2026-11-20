import { LazyBoundary } from '../../../shell/lazy';
import { lazy, useId, useLayoutEffect, useMemo, useRef, type MouseEvent } from 'react';
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import {
  cellValue,
  type FieldMeta,
  type TableMeta,
  type Tile,
  type TileSlice,
  type TileValue,
} from '@riosoma/contracts';
import { formatCell, type FormatContext } from '../../../grid/format';
import { navigateOnPlainClick } from '../shell/navigation';
import { formatAxisValue, formatValue } from './aggregates';
import { chartOption, chartTable, type ChartData, type ChartTable } from './chart-option';
import type { ChartTheme } from './chart-theme';
import type { ChartPoint } from './echarts';
import type { ReadyData } from './data';
import { AGGREGATE_LABELS, EMPTY, OTHER } from './messages';

const ChartCanvas = lazy(() => import('./ChartCanvas'));

type NumberTile = Extract<Tile, { kind: 'number' }>;
type ChartTile = Extract<Tile, { kind: 'chart' }>;
type RecordsTile = Extract<Tile, { kind: 'records' }>;
type RecordsData = Extract<ReadyData, { kind: 'records' }>;

function RecordCount({ count }: { count: number }) {
  const { t } = useLingui();
  return (
    <p className="rio-dashboard-count">
      {t({
        id: 'dashboards.tile.records.count',
        message: plural(count, { one: '# record', other: '# records' }),
      })}
    </p>
  );
}

/** A value with nothing to compute from reads as empty rather than as zero. */
function Missing() {
  const { i18n } = useLingui();
  return (
    <>
      <span aria-hidden="true">—</span>
      <span className="rio-dashboard-visually-hidden">{i18n._(EMPTY)}</span>
    </>
  );
}

/**
 * Shrinks a number that is wider than its tile until all of it shows, since a figure cut short reads
 * as another figure.  The stylesheet sets the size the tile's height allows, and this only lowers it.
 */
function useFitText(text: string | null) {
  const element = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    const fit = () => {
      node.style.fontSize = '';
      const room = node.clientWidth;
      const needed = node.scrollWidth;
      if (room <= 0 || needed <= room) return;
      const size = Number.parseFloat(getComputedStyle(node).fontSize);
      if (Number.isFinite(size)) node.style.fontSize = `${Math.floor((size * room) / needed)}px`;
    };
    fit();
    // The tile's own box, whose size the text never changes, so a fit can't set off another.
    const box = node.parentElement;
    const observer = box && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null;
    if (box) observer?.observe(box);
    return () => observer?.disconnect();
  }, [text]);
  return element;
}

export function NumberBody({
  tile,
  value,
  records,
  fields,
  format,
}: {
  tile: NumberTile;
  value: number | null;
  records: number;
  fields: readonly FieldMeta[];
  format: FormatContext;
}) {
  const field = fields.find((item) => item.id === tile.value.fieldId);
  const text = formatValue(value, tile.value, field, format);
  const fitted = useFitText(text);
  return (
    <div className="rio-dashboard-number">
      <p ref={fitted} className="rio-dashboard-number__value">
        {text ?? <Missing />}
      </p>
      <RecordCount count={records} />
    </div>
  );
}

/** The series name when a chart has one series: what it computes, or of which field. */
function valueName(value: TileValue, fields: readonly FieldMeta[], label: string): string {
  if (value.fn === 'count' || value.fn === 'countUnique') return label;
  return fields.find((field) => field.id === value.fieldId)?.name ?? label;
}

export function useChartTable(value: TileValue, data: ChartData, fields: readonly FieldMeta[]): ChartTable {
  const { i18n } = useLingui();
  return useMemo(
    () =>
      chartTable(data, {
        empty: i18n._(EMPTY),
        other: i18n._(OTHER),
        value: valueName(value, fields, i18n._(AGGREGATE_LABELS[value.fn])),
      }),
    [data, i18n, value, fields],
  );
}

export function ChartBody({
  tile,
  data,
  fields,
  format,
  label,
  asTable,
  onPick,
}: {
  tile: ChartTile;
  data: ChartData;
  fields: readonly FieldMeta[];
  format: FormatContext;
  /** The tile's title, which names the chart and its table */
  label: string;
  asTable: boolean;
  /**
   * Opens the records behind a bar, slice, or point.  The table offers the same from the keyboard:
   * each number is a button named by its category, its series, and its value.
   */
  onPick?(slice: TileSlice): void;
}) {
  const { t, i18n } = useLingui();
  const hintId = useId();
  // Moving or resizing the tile makes a new tile object, which mustn't redraw the chart.
  const { chart, stacked, value } = tile;
  const table = useChartTable(value, data, fields);
  const valueField = fields.find((field) => field.id === value.fieldId);
  const groupField = fields.find((field) => field.id === tile.groupBy.fieldId);
  const show = useMemo(
    () => (amount: number | null) => formatValue(amount, value, valueField, format) ?? i18n._(EMPTY),
    [value, valueField, format, i18n],
  );
  const build = useMemo(() => {
    const animate =
      typeof window === 'undefined' || !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const formatAxis = (amount: number) => formatAxisValue(amount, value, valueField, format) ?? show(amount);
    return (theme: ChartTheme) =>
      chartOption({ chart, stacked }, table, { theme, format: show, formatAxis, animate });
  }, [chart, stacked, table, show, value, valueField, format]);
  const divided = Boolean(tile.seriesBy);
  const sliceAt = (row: number, column: number | null): TileSlice | null => {
    const category = data.categories[row];
    if (!category) return null;
    const series = column === null ? undefined : data.series[column];
    return { category: category.key, ...(series ? { series: series.key } : {}) };
  };
  // A pie or donut draws one series, so its slice is a whole category.
  const pick = (point: ChartPoint) => {
    const round = chart === 'pie' || chart === 'donut';
    const slice = sliceAt(point.dataIndex, divided && !round ? point.seriesIndex : null);
    if (slice) onPick?.(slice);
  };
  if (asTable)
    return (
      <div className="rio-dashboard-table" role="region" aria-label={label} tabIndex={0}>
        <table>
          <caption className="rio-dashboard-visually-hidden">{label}</caption>
          <thead>
            <tr>
              <th scope="col">{groupField?.name ?? ''}</th>
              {table.series.map((series, index) => (
                <th scope="col" key={index}>
                  {series.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.categories.map((category, row) => (
              <tr key={row}>
                <th scope="row">{category.label}</th>
                {table.series.map((series, column) => {
                  const value = show(series.values[row] ?? null);
                  if (!onPick) return <td key={column}>{value}</td>;
                  const name =
                    table.series.length > 1 ? `${category.label}, ${series.label}` : category.label;
                  return (
                    <td key={column}>
                      <button
                        type="button"
                        className="rio-dashboard-table__cell"
                        aria-haspopup="dialog"
                        aria-label={t({ id: 'dashboards.tile.cellRecords', message: `${name}, ${value}` })}
                        onClick={() => {
                          const slice = sliceAt(row, divided ? column : null);
                          if (slice) onPick(slice);
                        }}
                      >
                        {value}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  return (
    <div className="rio-dashboard-chart">
      <LazyBoundary>
        <ChartCanvas
          build={build}
          label={label}
          onPick={onPick ? pick : undefined}
          describedBy={onPick ? hintId : undefined}
        />
      </LazyBoundary>
      {onPick ? (
        <p id={hintId} className="rio-dashboard-visually-hidden">
          {t({
            id: 'dashboards.tile.chartHint',
            message:
              'To reach each value from the keyboard, show the chart as a table.  Each value there opens the records behind it.',
          })}
        </p>
      ) : null}
    </div>
  );
}

export function RecordsBody({
  tile,
  data,
  table,
  fields,
  format,
  hrefFor,
  onOpen,
}: {
  tile: RecordsTile;
  data: RecordsData;
  table: TableMeta;
  fields: readonly FieldMeta[];
  format: FormatContext;
  hrefFor(recordId: string): string;
  onOpen(recordId: string): void;
}) {
  const { t } = useLingui();
  const primary = fields.find((field) => field.id === table.primaryFieldId);
  const shown = tile.fieldIds.flatMap((id) => fields.filter((field) => field.id === id));
  return (
    <div className="rio-dashboard-records">
      <ul className="rio-dashboard-records__list">
        {data.rows.map((row) => {
          const name =
            (primary ? formatCell(primary, cellValue(row, primary), format) : '') ||
            t({ id: 'record.untitled', message: 'Untitled record' });
          return (
            <li key={row.id} className="rio-dashboard-records__item">
              <a
                className="rio-dashboard-records__name"
                href={hrefFor(row.id)}
                onClick={(event: MouseEvent<HTMLAnchorElement>) =>
                  navigateOnPlainClick(event, () => onOpen(row.id))
                }
              >
                {name}
              </a>
              {shown.length ? (
                <dl className="rio-dashboard-records__fields">
                  {shown.map((field) => (
                    <div key={field.id}>
                      <dt>{field.name}</dt>
                      <dd>{formatCell(field, cellValue(row, field), format)}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </li>
          );
        })}
      </ul>
      <RecordCount count={data.total} />
    </div>
  );
}
