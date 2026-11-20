import { describe, expect, it } from 'vitest';
import type { Tile } from '@riosoma/contracts';
import { chartOption, chartTable, type ChartData, type ChartTile } from './chart-option';
import { FALLBACK_THEME } from './chart-theme';

const labels = { empty: '(Empty)', other: 'Other', value: 'Count of records' };
function chart(patch: Partial<ChartTile> = {}): ChartTile {
  const base: Extract<Tile, { kind: 'chart' }> = {
    id: 'tileChart01',
    kind: 'chart',
    title: 'By status',
    place: { x: 0, y: 0, w: 6, h: 4 },
    source: { tableId: 'tbl00000000000000', viewId: null, filter: null },
    chart: 'column',
    groupBy: { fieldId: 'fld00000000000001', dateBucket: null },
    value: { fn: 'count', fieldId: null },
    seriesBy: null,
    sort: 'category',
    limit: 20,
    stacked: false,
  };
  return { ...base, ...patch };
}
const single: ChartData = {
  kind: 'chart',
  categories: [
    { key: 'a', label: 'Open' },
    { key: null, label: '' },
    { key: '__other__', label: '' },
  ],
  series: [{ key: null, label: '', values: [3, 1, 4] }],
  truncated: true,
};
const split: ChartData = {
  kind: 'chart',
  categories: [
    { key: 1, label: '1' },
    { key: 2, label: '2' },
  ],
  series: [
    { key: 'x', label: 'Ready', values: [1, 2] },
    { key: null, label: '', values: [3, null] },
  ],
  truncated: false,
};
const context = {
  theme: FALLBACK_THEME,
  format: (value: number | null) => String(value ?? '–'),
  animate: false,
};
type Series = { type: string; stack?: string; areaStyle?: unknown; radius?: unknown; data: unknown[] };
const seriesOf = (option: Record<string, unknown>) => option.series as Series[];

describe('chart data', () => {
  it('names empty categories, the combined rest, and a lone series in the app’s words', () => {
    const table = chartTable(single, labels);
    expect(table.categories.map((category) => category.label)).toEqual(['Open', '(Empty)', 'Other']);
    expect(table.series).toEqual([{ label: 'Count of records', values: [3, 1, 4] }]);
    expect(chartTable(split, labels).series.map((series) => series.label)).toEqual(['Ready', '(Empty)']);
  });
});

describe('chart options', () => {
  it('draws columns and bars along the right axes in the theme’s colors', () => {
    const table = chartTable(single, labels);
    const column = chartOption(chart(), table, context);
    expect(column.color).toEqual(FALLBACK_THEME.palette);
    expect(column.xAxis).toMatchObject({ type: 'category', data: ['Open', '(Empty)', 'Other'] });
    expect(column.yAxis).toMatchObject({ type: 'value' });
    expect(seriesOf(column)[0]).toMatchObject({ type: 'bar', data: [3, 1, 4] });
    expect(column.legend).toMatchObject({ show: false });
    // The stylesheet spaces a tooltip's value from its label through this class.
    expect(column.tooltip).toMatchObject({ className: 'rio-chart-tooltip' });
    const bar = chartOption(chart({ chart: 'bar' }), table, context);
    expect(bar.xAxis).toMatchObject({ type: 'value' });
    expect(bar.yAxis).toMatchObject({ type: 'category', inverse: true });
  });

  it('draws lines, areas, pies, donuts, and scatters', () => {
    const table = chartTable(single, labels);
    expect(seriesOf(chartOption(chart({ chart: 'line' }), table, context))[0]).toMatchObject({
      type: 'line',
    });
    const area = seriesOf(chartOption(chart({ chart: 'area' }), table, context))[0]!;
    expect(area.type).toBe('line');
    expect(area.areaStyle).toBeDefined();
    const pie = seriesOf(chartOption(chart({ chart: 'pie' }), table, context))[0]!;
    expect(pie).toMatchObject({ type: 'pie', radius: '70%' });
    expect(pie.data).toEqual([
      { name: 'Open', value: 3 },
      { name: '(Empty)', value: 1 },
      { name: 'Other', value: 4 },
    ]);
    expect(seriesOf(chartOption(chart({ chart: 'donut' }), table, context))[0]!.radius).toEqual([
      '45%',
      '70%',
    ]);
    const scatter = chartOption(chart({ chart: 'scatter' }), chartTable(split, labels), context);
    expect(scatter.xAxis).toMatchObject({ type: 'value' });
    expect(seriesOf(scatter)[0]).toMatchObject({
      type: 'scatter',
      data: [
        [1, 1],
        [2, 2],
      ],
    });
  });

  it('steps a whole-number axis by whole numbers, so no two ticks share a label', () => {
    expect(chartOption(chart(), chartTable(single, labels), context).yAxis).toMatchObject({ minInterval: 1 });
    const averages: ChartData = { ...single, series: [{ key: null, label: '', values: [2.5, 1, null] }] };
    expect(chartOption(chart(), chartTable(averages, labels), context).yAxis).not.toHaveProperty(
      'minInterval',
    );
  });

  it('labels whole steps of a tall axis without decimal places, and leaves a short one as it is', () => {
    const axis = (values: Array<number | null>) => {
      const data: ChartData = { ...single, series: [{ key: null, label: '', values }] };
      return chartOption(chart(), chartTable(data, labels), {
        ...context,
        format: (value) => (value ?? 0).toFixed(2),
        formatAxis: (value) => value.toFixed(0),
      }).yAxis as { minInterval?: number; axisLabel: { formatter(value: number): string } };
    };
    // Revenue in the millions steps by whole numbers, so its labels carry no cents.
    const revenue = axis([22_750_000.57, 9_999_870.25, null]);
    expect(revenue.minInterval).toBe(1);
    expect(revenue.axisLabel.formatter(5_000_000)).toBe('5000000');
    expect(revenue.axisLabel.formatter(0)).toBe('0');
    // An axis that never reaches five may step by fractions, and every label keeps its places.
    const rates = axis([0.25, 1.5, null]);
    expect(rates).not.toHaveProperty('minInterval');
    expect(rates.axisLabel.formatter(1)).toBe('1.00');
    expect(rates.axisLabel.formatter(0.5)).toBe('0.50');
    // Without an axis format, labels stay as the values are shown.
    const plain = chartOption(chart(), chartTable(single, labels), context).yAxis as {
      axisLabel: { formatter(value: number): string };
    };
    expect(plain.axisLabel.formatter(4)).toBe('4');
  });

  it('drops value labels that would run into each other, along either axis', () => {
    const table = chartTable(single, labels);
    expect(chartOption(chart({ chart: 'bar' }), table, context).xAxis).toMatchObject({
      type: 'value',
      axisLabel: { hideOverlap: true },
    });
    expect(chartOption(chart(), table, context).yAxis).toMatchObject({
      type: 'value',
      axisLabel: { hideOverlap: true },
    });
  });

  it('stacks split series only when the tile asks', () => {
    const table = chartTable(split, labels);
    const plain = chartOption(chart({ seriesBy: 'fld00000000000002' }), table, context);
    expect(seriesOf(plain).every((series) => series.stack === undefined)).toBe(true);
    expect(plain.legend).toMatchObject({ show: true });
    const stacked = chartOption(chart({ seriesBy: 'fld00000000000002', stacked: true }), table, context);
    expect(seriesOf(stacked).map((series) => series.stack)).toEqual(['total', 'total']);
    const lone = chartOption(chart({ stacked: true }), chartTable(single, labels), context);
    expect(seriesOf(lone)[0]!.stack).toBeUndefined();
  });
});
