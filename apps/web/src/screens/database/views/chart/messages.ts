import type { I18n, MessageDescriptor } from '@lingui/core';
import { msg, plural } from '@lingui/core/macro';
import type { Aggregate, ChartSort, ChartType, DateBucket, FieldMeta, TileValue } from '@riosoma/contracts';
import type { RecordsCopy } from '../summary/RecordsPanel';
import type { GroupWords } from '../summary/fields';

export const KIND_LABELS: Record<ChartType, MessageDescriptor> = {
  bar: msg({ id: 'views.chart.kind.bar', message: 'Bar' }),
  column: msg({ id: 'views.chart.kind.column', message: 'Column' }),
  line: msg({ id: 'views.chart.kind.line', message: 'Line' }),
  area: msg({ id: 'views.chart.kind.area', message: 'Area' }),
  pie: msg({ id: 'views.chart.kind.pie', message: 'Pie' }),
  donut: msg({ id: 'views.chart.kind.donut', message: 'Donut' }),
  scatter: msg({ id: 'views.chart.kind.scatter', message: 'Scatter' }),
};

export const AGGREGATE_LABELS: Record<Aggregate, MessageDescriptor> = {
  count: msg({ id: 'views.chart.fn.count', message: 'Count of records' }),
  countUnique: msg({ id: 'views.chart.fn.countUnique', message: 'Count of unique values' }),
  sum: msg({ id: 'views.chart.fn.sum', message: 'Sum' }),
  average: msg({ id: 'views.chart.fn.average', message: 'Average' }),
  min: msg({ id: 'views.chart.fn.min', message: 'Smallest' }),
  max: msg({ id: 'views.chart.fn.max', message: 'Largest' }),
};

export const BUCKET_LABELS: Record<DateBucket, MessageDescriptor> = {
  day: msg({ id: 'views.chart.bucket.day', message: 'Day' }),
  week: msg({ id: 'views.chart.bucket.week', message: 'Week' }),
  month: msg({ id: 'views.chart.bucket.month', message: 'Month' }),
  quarter: msg({ id: 'views.chart.bucket.quarter', message: 'Quarter' }),
  year: msg({ id: 'views.chart.bucket.year', message: 'Year' }),
};

export const SORT_LABELS: Record<ChartSort, MessageDescriptor> = {
  category: msg({ id: 'views.chart.sort.category', message: 'In the field’s order' }),
  valueDescending: msg({ id: 'views.chart.sort.valueDescending', message: 'Largest first' }),
  valueAscending: msg({ id: 'views.chart.sort.valueAscending', message: 'Smallest first' }),
};

const EMPTY = msg({ id: 'views.chart.empty', message: '(Empty)' });
const CHECKED = msg({ id: 'views.chart.checked', message: 'Checked' });
const UNCHECKED = msg({ id: 'views.chart.unchecked', message: 'Unchecked' });

export function groupWords(i18n: I18n): GroupWords {
  return { empty: i18n._(EMPTY), checked: i18n._(CHECKED), unchecked: i18n._(UNCHECKED) };
}

/** What the one series computes, when the chart isn't split. */
export function valueName(i18n: I18n, value: TileValue, field: FieldMeta | undefined): string {
  const name = field?.name ?? '';
  switch (value.fn) {
    case 'count':
      return i18n._(msg({ id: 'views.chart.value.count', message: 'Count of records' }));
    case 'countUnique':
      return i18n._(msg({ id: 'views.chart.value.countUnique', message: `Unique values of ${name}` }));
    case 'sum':
      return i18n._(msg({ id: 'views.chart.value.sum', message: `Sum of ${name}` }));
    case 'average':
      return i18n._(msg({ id: 'views.chart.value.average', message: `Average of ${name}` }));
    case 'min':
      return i18n._(msg({ id: 'views.chart.value.min', message: `Smallest ${name}` }));
    case 'max':
      return i18n._(msg({ id: 'views.chart.value.max', message: `Largest ${name}` }));
  }
}

export function recordsCopy(i18n: I18n): RecordsCopy {
  return {
    count: (total) =>
      i18n._(
        msg({
          id: 'views.chart.records.count',
          message: plural(total, { one: '# record', other: '# records' }),
        }),
      ),
    close: i18n._(msg({ id: 'views.chart.records.close', message: 'Close the list' })),
    more: i18n._(msg({ id: 'views.chart.records.more', message: 'Show more' })),
    untitled: i18n._(msg({ id: 'views.chart.records.untitled', message: 'Untitled record' })),
    none: i18n._(msg({ id: 'views.chart.records.none', message: 'No records' })),
    failed: i18n._(msg({ id: 'views.chart.records.failed', message: 'The records didn’t load.' })),
    retry: i18n._(msg({ id: 'views.chart.records.retry', message: 'Try again' })),
  };
}
