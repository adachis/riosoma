import type { Tile, TileData } from '@riosoma/contracts';
import type { ChartTheme } from './chart-theme';

export type ChartTile = Extract<Tile, { kind: 'chart' }>;
export type ChartData = Extract<TileData, { kind: 'chart' }>;

/**
 * The data a chart draws, with every label ready to show: empty keys and the combined "Other"
 * category get the app's own words, since the server sends only data.
 */
export interface ChartTable {
  categories: Array<{ key: string | number | null; label: string }>;
  series: Array<{ label: string; values: Array<number | null> }>;
}

export interface ChartLabels {
  empty: string;
  other: string;
  /** Names the one series when the chart isn't split */
  value: string;
}

export function chartTable(data: ChartData, labels: ChartLabels): ChartTable {
  const last = data.categories.length - 1;
  return {
    categories: data.categories.map((category, index) => ({
      key: category.key,
      label:
        data.truncated && index === last
          ? labels.other
          : category.label || (category.key === null ? labels.empty : String(category.key)),
    })),
    series: data.series.map((series) => ({
      label:
        data.series.length === 1 && series.key === null
          ? labels.value
          : series.label || (series.key === null ? labels.empty : String(series.key)),
      values: series.values,
    })),
  };
}

/** An ECharts option object, kept loose here so this module needn't load ECharts to build one. */
export type ChartOption = Record<string, unknown>;

export interface ChartOptionContext {
  theme: ChartTheme;
  format: (value: number | null) => string;
  /** A value axis's whole-number labels, which need none of the decimal places `format` shows */
  formatAxis?: (value: number) => string;
  /** Turns off animation for people who ask for reduced motion */
  animate: boolean;
}

const axisLine = (theme: ChartTheme) => ({ lineStyle: { color: theme.border } });

/** Builds the chart for a tile: the type it asks for, stacked when it asks, in the theme's colors. */
/** The tile settings that change how a chart draws, as opposed to what it counts */
export type ChartStyle = Pick<ChartTile, 'chart' | 'stacked'>;

export function chartOption(tile: ChartStyle, table: ChartTable, context: ChartOptionContext): ChartOption {
  const { theme, format } = context;
  const round = tile.chart === 'pie' || tile.chart === 'donut';
  const split = table.series.length > 1;
  const common: ChartOption = {
    color: theme.palette,
    animation: context.animate,
    // The tile draws its own accessible description and data table, in the app's own words.
    aria: { enabled: false },
    textStyle: { color: theme.text, fontFamily: theme.font },
    tooltip: {
      trigger: round || tile.chart === 'scatter' ? 'item' : 'axis',
      confine: true,
      // The app's content security policy drops the inline styles ECharts writes into a tooltip's
      // rows, so the stylesheet spaces a row's value from its label through this class.
      className: 'rio-chart-tooltip',
      backgroundColor: theme.surface,
      borderColor: theme.border,
      textStyle: { color: theme.text, fontFamily: theme.font },
      valueFormatter: (value: unknown) => format(typeof value === 'number' ? value : null),
    },
    legend: {
      show: split || round,
      type: 'scroll',
      bottom: 0,
      textStyle: { color: theme.muted, fontFamily: theme.font },
      pageTextStyle: { color: theme.muted },
    },
  };
  if (round) {
    const totals = table.categories.map((category, index) => ({
      name: category.label,
      value: table.series.reduce((sum, series) => sum + (series.values[index] ?? 0), 0),
    }));
    return {
      ...common,
      series: [
        {
          type: 'pie',
          radius: tile.chart === 'donut' ? ['45%', '70%'] : '70%',
          center: ['50%', '45%'],
          data: totals,
          // The legend names the slices.  Labels around a small tile's pie would run off its edges.
          label: { show: false },
          labelLine: { show: false },
          itemStyle: { borderColor: theme.surface, borderWidth: 1 },
        },
      ],
    };
  }
  const labels = table.categories.map((category) => category.label);
  const numericKeys =
    tile.chart === 'scatter' &&
    table.categories.length > 0 &&
    table.categories.every((category) => typeof category.key === 'number');
  const categoryAxis = {
    type: numericKeys ? 'value' : 'category',
    ...(numericKeys ? {} : { data: labels }),
    axisLine: axisLine(theme),
    axisTick: { lineStyle: { color: theme.border } },
    axisLabel: { color: theme.muted, fontFamily: theme.font, hideOverlap: true },
  };
  // Counts and other whole numbers step by whole numbers, so no two ticks round to the same label.
  const whole = table.series.every((series) =>
    series.values.every((value) => value === null || Number.isInteger(value)),
  );
  // An axis that reaches five steps by whole numbers as well, whatever fractions its values hold.
  const wholeSteps =
    whole ||
    table.series.some((series) => series.values.some((value) => value !== null && Math.abs(value) >= 5));
  const valueAxis = {
    type: 'value',
    ...(wholeSteps ? { minInterval: 1 } : {}),
    axisLine: axisLine(theme),
    splitLine: { lineStyle: { color: theme.border, type: 'dashed' } },
    axisLabel: {
      color: theme.muted,
      fontFamily: theme.font,
      // Long numbers along the foot of a narrow bar chart would run into each other.
      hideOverlap: true,
      formatter: (value: number) =>
        wholeSteps && context.formatAxis && Number.isInteger(value)
          ? context.formatAxis(value)
          : format(value),
    },
  };
  const stacked = tile.stacked && split && tile.chart !== 'scatter';
  const horizontal = tile.chart === 'bar';
  return {
    ...common,
    grid: {
      left: 8,
      right: 16,
      top: 16,
      bottom: split ? 36 : 8,
      outerBoundsMode: 'same',
      outerBoundsContain: 'axisLabel',
    },
    xAxis: horizontal ? valueAxis : categoryAxis,
    // Bars read top to bottom in category order.
    yAxis: horizontal ? { ...categoryAxis, inverse: true } : valueAxis,
    series: table.series.map((series) => ({
      name: series.label,
      type:
        tile.chart === 'bar' || tile.chart === 'column'
          ? 'bar'
          : tile.chart === 'scatter'
            ? 'scatter'
            : 'line',
      ...(stacked ? { stack: 'total' } : {}),
      ...(tile.chart === 'area' ? { areaStyle: { opacity: 0.25 } } : {}),
      ...(tile.chart === 'line' || tile.chart === 'area'
        ? { showSymbol: table.categories.length <= 40 }
        : {}),
      ...(tile.chart === 'scatter' ? { symbolSize: 10 } : {}),
      emphasis: { focus: 'series' },
      data: numericKeys
        ? series.values.map((value, index) => [table.categories[index]!.key, value])
        : series.values,
    })),
  };
}
