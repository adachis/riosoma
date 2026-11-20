import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { Aggregate, ChartType, Tile } from '@riosoma/contracts';

export type TileKind = Tile['kind'];
export type DateBucket = 'day' | 'week' | 'month' | 'quarter' | 'year';
export type ChartSort = Extract<Tile, { kind: 'chart' }>['sort'];

export const KIND_LABELS: Record<TileKind, MessageDescriptor> = {
  number: msg({ id: 'dashboards.tile.number', message: 'Number' }),
  chart: msg({ id: 'dashboards.tile.chart', message: 'Chart' }),
  pivot: msg({ id: 'dashboards.tile.pivot', message: 'Pivot' }),
  records: msg({ id: 'dashboards.tile.records', message: 'Records' }),
  text: msg({ id: 'dashboards.tile.text', message: 'Note' }),
};

export const AGGREGATE_LABELS: Record<Aggregate, MessageDescriptor> = {
  count: msg({ id: 'dashboards.fn.count', message: 'Count of records' }),
  countUnique: msg({ id: 'dashboards.fn.countUnique', message: 'Count of unique values' }),
  sum: msg({ id: 'dashboards.fn.sum', message: 'Sum' }),
  average: msg({ id: 'dashboards.fn.average', message: 'Average' }),
  min: msg({ id: 'dashboards.fn.min', message: 'Smallest' }),
  max: msg({ id: 'dashboards.fn.max', message: 'Largest' }),
};

export const CHART_LABELS: Record<ChartType, MessageDescriptor> = {
  bar: msg({ id: 'dashboards.chart.bar', message: 'Bar' }),
  column: msg({ id: 'dashboards.chart.column', message: 'Column' }),
  line: msg({ id: 'dashboards.chart.line', message: 'Line' }),
  area: msg({ id: 'dashboards.chart.area', message: 'Area' }),
  pie: msg({ id: 'dashboards.chart.pie', message: 'Pie' }),
  donut: msg({ id: 'dashboards.chart.donut', message: 'Donut' }),
  scatter: msg({ id: 'dashboards.chart.scatter', message: 'Scatter' }),
};

export const SORT_LABELS: Record<ChartSort, MessageDescriptor> = {
  category: msg({ id: 'dashboards.sort.category', message: 'By category' }),
  valueDescending: msg({ id: 'dashboards.sort.valueDescending', message: 'Largest first' }),
  valueAscending: msg({ id: 'dashboards.sort.valueAscending', message: 'Smallest first' }),
};

export const BUCKET_LABELS: Record<DateBucket, MessageDescriptor> = {
  day: msg({ id: 'dashboards.bucket.day', message: 'Day' }),
  week: msg({ id: 'dashboards.bucket.week', message: 'Week' }),
  month: msg({ id: 'dashboards.bucket.month', message: 'Month' }),
  quarter: msg({ id: 'dashboards.bucket.quarter', message: 'Quarter' }),
  year: msg({ id: 'dashboards.bucket.year', message: 'Year' }),
};

export const OTHER = msg({ id: 'dashboards.tile.other', message: 'Other' });
export const EMPTY = msg({ id: 'dashboards.tile.empty', message: '(Empty)' });
