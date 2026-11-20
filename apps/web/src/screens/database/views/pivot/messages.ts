import type { I18n, MessageDescriptor } from '@lingui/core';
import { msg, plural } from '@lingui/core/macro';
import type { Aggregate, DateBucket, FieldMeta, PivotOrder, TileValue } from '@riosoma/contracts';
import type { RecordsCopy } from '../summary/RecordsPanel';
import type { PivotWords } from './layout';

export const AGGREGATE_LABELS: Record<Aggregate, MessageDescriptor> = {
  count: msg({ id: 'views.pivot.fn.count', message: 'Count of records' }),
  countUnique: msg({ id: 'views.pivot.fn.countUnique', message: 'Count of unique values' }),
  sum: msg({ id: 'views.pivot.fn.sum', message: 'Sum' }),
  average: msg({ id: 'views.pivot.fn.average', message: 'Average' }),
  min: msg({ id: 'views.pivot.fn.min', message: 'Smallest' }),
  max: msg({ id: 'views.pivot.fn.max', message: 'Largest' }),
};

export const BUCKET_LABELS: Record<DateBucket, MessageDescriptor> = {
  day: msg({ id: 'views.pivot.bucket.day', message: 'Day' }),
  week: msg({ id: 'views.pivot.bucket.week', message: 'Week' }),
  month: msg({ id: 'views.pivot.bucket.month', message: 'Month' }),
  quarter: msg({ id: 'views.pivot.bucket.quarter', message: 'Quarter' }),
  year: msg({ id: 'views.pivot.bucket.year', message: 'Year' }),
};

export const ORDER_LABELS: Record<PivotOrder, MessageDescriptor> = {
  labelAscending: msg({ id: 'views.pivot.order.labelAscending', message: 'By group, first to last' }),
  labelDescending: msg({ id: 'views.pivot.order.labelDescending', message: 'By group, last to first' }),
  valueAscending: msg({ id: 'views.pivot.order.valueAscending', message: 'By first value, smallest first' }),
  valueDescending: msg({ id: 'views.pivot.order.valueDescending', message: 'By first value, largest first' }),
};

/** A value's column heading: what it computes, and of which field. */
function valueName(i18n: I18n, value: TileValue, field: FieldMeta | undefined): string {
  const name = field?.name ?? '';
  switch (value.fn) {
    case 'count':
      return i18n._(msg({ id: 'views.pivot.value.count', message: 'Records' }));
    case 'countUnique':
      return i18n._(msg({ id: 'views.pivot.value.countUnique', message: `Unique ${name}` }));
    case 'sum':
      return i18n._(msg({ id: 'views.pivot.value.sum', message: `Sum of ${name}` }));
    case 'average':
      return i18n._(msg({ id: 'views.pivot.value.average', message: `Average of ${name}` }));
    case 'min':
      return i18n._(msg({ id: 'views.pivot.value.min', message: `Smallest ${name}` }));
    case 'max':
      return i18n._(msg({ id: 'views.pivot.value.max', message: `Largest ${name}` }));
  }
}

export function pivotWords(i18n: I18n): PivotWords {
  return {
    empty: i18n._(msg({ id: 'views.pivot.empty', message: '(Empty)' })),
    checked: i18n._(msg({ id: 'views.pivot.checked', message: 'Checked' })),
    unchecked: i18n._(msg({ id: 'views.pivot.unchecked', message: 'Unchecked' })),
    total: i18n._(msg({ id: 'views.pivot.total', message: 'Total' })),
    everything: i18n._(msg({ id: 'views.pivot.everything', message: 'Every record' })),
    valueName: (value, field) => valueName(i18n, value, field),
    cell: (row, column) => i18n._(msg({ id: 'views.pivot.cell', message: `${row}, ${column}` })),
  };
}

export function recordsCopy(i18n: I18n): RecordsCopy {
  return {
    count: (total) =>
      i18n._(
        msg({
          id: 'views.pivot.records.count',
          message: plural(total, { one: '# record', other: '# records' }),
        }),
      ),
    close: i18n._(msg({ id: 'views.pivot.records.close', message: 'Close the list' })),
    more: i18n._(msg({ id: 'views.pivot.records.more', message: 'Show more' })),
    untitled: i18n._(msg({ id: 'views.pivot.records.untitled', message: 'Untitled record' })),
    none: i18n._(msg({ id: 'views.pivot.records.none', message: 'No records' })),
    failed: i18n._(msg({ id: 'views.pivot.records.failed', message: 'The records didn’t load.' })),
    retry: i18n._(msg({ id: 'views.pivot.records.retry', message: 'Try again' })),
  };
}
