import { LazyBoundary } from '../../../../shell/lazy';
import { lazy, useMemo, useState, type ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import { faChartColumn, faTable } from '@fortawesome/free-solid-svg-icons';
import { AGGREGATE_CAPS, type ChartAggregate, type FieldMeta, type GroupLabel } from '@riosoma/contracts';
import { Button, Spinner } from '@riosoma/ui';
import { serverMessage } from '../../../../messages/useServerMessage';
import { formatAxisValue, formatValue } from '../../dashboards/aggregates';
import { chartOption, type ChartTable } from '../../dashboards/chart-option';
import type { ChartTheme } from '../../dashboards/chart-theme';
import type { ChartPoint } from '../../dashboards/echarts';
import {
  allPresent,
  chartFieldIds,
  chartRequest,
  groupFields,
  groupLabel,
  type GroupWords,
} from '../summary/fields';
import { RecordsPanel, type RecordsTarget } from '../summary/RecordsPanel';
import { useSavedConfig, useSummary } from '../summary/store';
import type { ViewComponentProps } from '../types';
import { groupWords, recordsCopy, valueName } from './messages';
import './chart-view.css';

const ChartCanvas = lazy(() => import('../../dashboards/ChartCanvas'));

export function ChartView(props: ViewComponentProps) {
  return <Chart key={props.view.id} {...props} />;
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="rio-chart-view">
      <div className="rio-chart-view__status">{children}</div>
    </div>
  );
}

function Chart(props: ViewComponentProps) {
  const { t, i18n } = useLingui();
  const { session, view, fields, canEdit } = props;
  const settings = view.config.chart;
  const field = (id: string | null | undefined) => (id ? fields.find((item) => item.id === id) : undefined);
  const present = allPresent(chartFieldIds(view.config), fields);
  const saved = useSavedConfig(session, view);
  const { state, store } = useSummary(session, view, chartRequest(saved, fields));

  if (!settings.groupBy)
    return (
      <Notice>
        <h2 className="rio-chart-view__heading">
          {t({ id: 'views.chart.setup.title', message: 'Choose what to chart' })}
        </h2>
        <p>
          {!canEdit
            ? t({ id: 'views.chart.setup.reader', message: 'This chart isn’t set up yet.' })
            : groupFields(fields).length
              ? t({
                  id: 'views.chart.setup.choose',
                  message:
                    'Pick a field in Group by above, such as a single select or a date, to chart the records by it.',
                })
              : t({
                  id: 'views.chart.setup.noFields',
                  message:
                    'A chart groups records by a field, such as a single select or a date.  Add one to this table to chart it.',
                })}
        </p>
      </Notice>
    );
  if (!present)
    return (
      <Notice>
        <p>
          {canEdit
            ? t({
                id: 'views.chart.fieldMissing.editor',
                message: 'A field this chart uses was deleted, or you can’t see it.  Choose another above.',
              })
            : t({
                id: 'views.chart.fieldMissing',
                message: 'A field this chart uses was deleted, or you can’t see it.',
              })}
        </p>
      </Notice>
    );
  if (state.status === 'error')
    return (
      <Notice>
        <p role="alert">
          {state.messageKey === 'dashboards.tile.unavailable'
            ? t({
                id: 'views.chart.error.unavailable',
                message: 'This chart uses a field that was deleted or that you can’t see.',
              })
            : state.messageKey === 'dashboards.tile.badAggregate'
              ? t({
                  id: 'views.chart.error.badAggregate',
                  message: 'That calculation doesn’t fit its field.',
                })
              : serverMessage(i18n, state.messageKey, state.params)}
        </p>
        <Button size="sm" onPress={() => store.retry()}>
          {t({ id: 'views.chart.retry', message: 'Try again' })}
        </Button>
      </Notice>
    );
  if (state.status !== 'ready' || state.data.kind !== 'chart')
    return (
      <Notice>
        <Spinner size="sm" />
      </Notice>
    );
  return (
    <ChartBody
      {...props}
      data={state.data}
      refreshing={state.refreshing}
      version={state.version}
      groupField={field(settings.groupBy.fieldId)!}
      seriesField={field(settings.seriesBy)}
      valueField={field(settings.value.fieldId)}
    />
  );
}

interface BodyProps extends ViewComponentProps {
  data: ChartAggregate;
  refreshing: boolean;
  version: number;
  groupField: FieldMeta;
  seriesField: FieldMeta | undefined;
  valueField: FieldMeta | undefined;
}

function ChartBody(props: BodyProps) {
  const { t, i18n } = useLingui();
  const { view, data, groupField, seriesField, valueField, format } = props;
  const settings = view.config.chart;
  const [asTable, setAsTable] = useState(false);
  const [target, setTarget] = useState<RecordsTarget | null>(null);
  const words: GroupWords = useMemo(() => groupWords(i18n), [i18n]);
  const round = settings.chart === 'pie' || settings.chart === 'donut';
  const split = Boolean(settings.seriesBy);
  const { chart, stacked, value } = settings;
  const table: ChartTable = useMemo(
    () => ({
      categories: data.categories.map((category) => ({
        key: category.key,
        label: groupLabel(groupField, category.key, category.label, words),
      })),
      series: data.series.map((line) => ({
        label: split
          ? groupLabel(seriesField, line.key, line.label, words)
          : valueName(i18n, value, valueField),
        values: line.values,
      })),
    }),
    [data, groupField, seriesField, valueField, words, split, value, i18n],
  );
  const show = useMemo(
    () => (amount: number | null) => formatValue(amount, value, valueField, format) ?? words.empty,
    [value, valueField, format, words],
  );
  const build = useMemo(() => {
    const animate =
      typeof window === 'undefined' || !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const formatAxis = (amount: number) => formatAxisValue(amount, value, valueField, format) ?? show(amount);
    return (theme: ChartTheme) =>
      chartOption({ chart, stacked: stacked && split }, table, { theme, format: show, formatAxis, animate });
  }, [chart, stacked, split, table, show, value, valueField, format]);

  /** The records behind a category, and behind one of its series when the chart is split. */
  function open(index: number, line?: GroupLabel) {
    const category = data.categories[index];
    if (!category) return;
    const name = table.categories[index]!.label;
    const lineName = line ? groupLabel(seriesField, line.key, line.label, words) : '';
    setTarget(
      line
        ? {
            row: [category.key],
            column: line.key,
            title: t({ id: 'views.chart.records.cell', message: `${name}, ${lineName}` }),
          }
        : { row: [category.key], title: name },
    );
  }

  function pick(point: ChartPoint) {
    open(point.dataIndex, split && !round ? data.series[point.seriesIndex] : undefined);
  }

  const capped = data.capped;
  const rows = i18n.number(AGGREGATE_CAPS.rows);
  const columns = i18n.number(AGGREGATE_CAPS.columns);
  const note =
    capped.categories && capped.series
      ? t({
          id: 'views.chart.capped.both',
          message: `Showing the first ${rows} categories and the first ${columns} series.`,
        })
      : capped.categories
        ? t({ id: 'views.chart.capped.categories', message: `Showing the first ${rows} categories.` })
        : capped.series
          ? t({ id: 'views.chart.capped.series', message: `Showing the first ${columns} series.` })
          : null;
  const label = view.name;

  return (
    <div className="rio-chart-view">
      <div className="rio-chart-view__bar">
        {note ? (
          <p className="rio-chart-view__note" role="note">
            {note}
          </p>
        ) : null}
        <Button
          variant="quiet"
          size="sm"
          icon={asTable ? faChartColumn : faTable}
          className="rio-chart-view__toggle"
          onPress={() => setAsTable(!asTable)}
        >
          {asTable
            ? t({ id: 'views.chart.showChart', message: 'Show as chart' })
            : t({ id: 'views.chart.showTable', message: 'Show as table' })}
        </Button>
      </div>
      <div className="rio-chart-view__body">
        <div className="rio-chart-view__main" aria-busy={props.refreshing || undefined}>
          {!data.categories.length ? (
            <div className="rio-chart-view__status">
              <p>{t({ id: 'views.chart.noRecords', message: 'No records to chart.' })}</p>
            </div>
          ) : asTable ? (
            <div
              className="rio-chart-view__table"
              role="region"
              aria-label={t({ id: 'views.chart.tableLabel', message: `${label} as a table` })}
              tabIndex={0}
            >
              <table>
                <caption className="rio-chart-view__hidden">{label}</caption>
                <thead>
                  <tr>
                    <th scope="col">{groupField.name}</th>
                    {table.series.map((line, index) => (
                      <th scope="col" key={index}>
                        {line.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.categories.map((category, row) => (
                    <tr key={row}>
                      <th scope="row">{category.label}</th>
                      {table.series.map((line, column) => (
                        <td key={column}>
                          <button
                            type="button"
                            className="rio-chart-view__cell"
                            onClick={() => open(row, split ? data.series[column] : undefined)}
                          >
                            {show(line.values[row] ?? null)}
                          </button>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <LazyBoundary>
              <ChartCanvas build={build} label={label} onPick={pick} className="rio-chart-view__canvas" />
            </LazyBoundary>
          )}
        </div>
        {target ? (
          <RecordsPanel
            prefix="rio-chart-view"
            session={props.session}
            table={props.table}
            viewId={view.id}
            fields={props.fields}
            shown={valueField ? [valueField] : []}
            format={format}
            target={target}
            version={props.version}
            copy={recordsCopy(i18n)}
            onOpen={props.onExpand}
            onClose={() => setTarget(null)}
          />
        ) : null}
      </div>
    </div>
  );
}
