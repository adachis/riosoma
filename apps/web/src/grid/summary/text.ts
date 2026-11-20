import type { MessageDescriptor } from '@lingui/core';
import { msg, plural } from '@lingui/core/macro';
import { summaryKindsFor, type FieldMeta, type SummaryKind, type SummaryResult } from '@riosoma/contracts';
import { resultField } from '../../data/formulas';
import type { Translate } from '../cells/describe';
import { formatCell, type FormatContext } from '../format';

/** What each summary is called in a column's menu and in its footer. */
export const SUMMARY_LABELS: Record<SummaryKind, MessageDescriptor> = {
  none: msg({ id: 'grid.summary.kind.none', message: 'None' }),
  count: msg({ id: 'grid.summary.kind.count', message: 'Count' }),
  filled: msg({ id: 'grid.summary.kind.filled', message: 'Filled' }),
  empty: msg({ id: 'grid.summary.kind.empty', message: 'Empty' }),
  percentFilled: msg({ id: 'grid.summary.kind.percentFilled', message: 'Percent filled' }),
  unique: msg({ id: 'grid.summary.kind.unique', message: 'Unique' }),
  sum: msg({ id: 'grid.summary.kind.sum', message: 'Sum' }),
  average: msg({ id: 'grid.summary.kind.average', message: 'Average' }),
  median: msg({ id: 'grid.summary.kind.median', message: 'Median' }),
  min: msg({ id: 'grid.summary.kind.min', message: 'Minimum' }),
  max: msg({ id: 'grid.summary.kind.max', message: 'Maximum' }),
  range: msg({ id: 'grid.summary.kind.range', message: 'Range' }),
  earliest: msg({ id: 'grid.summary.kind.earliest', message: 'Earliest' }),
  latest: msg({ id: 'grid.summary.kind.latest', message: 'Latest' }),
  checked: msg({ id: 'grid.summary.kind.checked', message: 'Checked' }),
  unchecked: msg({ id: 'grid.summary.kind.unchecked', message: 'Unchecked' }),
};

/**
 * What a screen reader reads for a column's summary, such as "Sum 1,234 (Amount)".  The footer
 * shows the kind and the value beside each other, so the name starts with those same words and
 * keeps the field's name after them.
 */
const SPOKEN: Record<Exclude<SummaryKind, 'none'>, MessageDescriptor> = {
  count: msg({ id: 'grid.summary.spoken.count', message: 'Count {value} ({field})' }),
  filled: msg({ id: 'grid.summary.spoken.filled', message: 'Filled {value} ({field})' }),
  empty: msg({ id: 'grid.summary.spoken.empty', message: 'Empty {value} ({field})' }),
  percentFilled: msg({
    id: 'grid.summary.spoken.percentFilled',
    message: 'Percent filled {value} ({field})',
  }),
  unique: msg({ id: 'grid.summary.spoken.unique', message: 'Unique {value} ({field})' }),
  sum: msg({ id: 'grid.summary.spoken.sum', message: 'Sum {value} ({field})' }),
  average: msg({ id: 'grid.summary.spoken.average', message: 'Average {value} ({field})' }),
  median: msg({ id: 'grid.summary.spoken.median', message: 'Median {value} ({field})' }),
  min: msg({ id: 'grid.summary.spoken.min', message: 'Minimum {value} ({field})' }),
  max: msg({ id: 'grid.summary.spoken.max', message: 'Maximum {value} ({field})' }),
  range: msg({ id: 'grid.summary.spoken.range', message: 'Range {value} ({field})' }),
  earliest: msg({ id: 'grid.summary.spoken.earliest', message: 'Earliest {value} ({field})' }),
  latest: msg({ id: 'grid.summary.spoken.latest', message: 'Latest {value} ({field})' }),
  checked: msg({ id: 'grid.summary.spoken.checked', message: 'Checked {value} ({field})' }),
  unchecked: msg({ id: 'grid.summary.spoken.unchecked', message: 'Unchecked {value} ({field})' }),
};

const numberFormats = new Map<string, Intl.NumberFormat>();

function numberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = numberFormats.get(key);
  if (!format) {
    if (numberFormats.size > 64) numberFormats.clear();
    format = new Intl.NumberFormat(locale, options);
    numberFormats.set(key, format);
  }
  return format;
}

/** Whole numbers the field shows as it stores them, which an average or median can split. */
const PLAIN_NUMBERS: ReadonlySet<FieldMeta['type']> = new Set(['rating', 'autoNumber', 'count']);

/** The summary a column's footer shows, or `none` when it has none that fits its field. */
export function summaryKindOf(
  field: FieldMeta,
  summaries: Readonly<Record<string, SummaryKind>>,
): SummaryKind {
  const kind = summaries[field.id] ?? 'none';
  // A summary the field outgrew, after a change of type, shows nothing until another is chosen.
  return summaryKindsFor(field).includes(kind) ? kind : 'none';
}

/**
 * A summary's value, formatted the way the field formats its own: currency as currency, dates in
 * the field's layout.  Counts are whole numbers in the reader's language, and a range of dates is
 * a number of days.  An empty text means there was nothing to summarize.
 */
export function summaryValueText(field: FieldMeta, result: SummaryResult, ctx: FormatContext): string {
  if (result.currencies)
    return Object.entries(result.currencies)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([code, amount]) =>
          `${code} ${numberFormat(ctx.locale, { maximumFractionDigits: 8 }).format(amount)}`,
      )
      .join(', ');
  const { kind, value } = result;
  if (value === null) return '';
  switch (kind) {
    case 'count':
    case 'filled':
    case 'empty':
    case 'unique':
    case 'checked':
    case 'unchecked':
      return typeof value === 'number' ? numberFormat(ctx.locale, {}).format(value) : '';
    case 'percentFilled':
      return typeof value === 'number'
        ? numberFormat(ctx.locale, { style: 'percent', maximumFractionDigits: 1 }).format(value)
        : '';
    case 'earliest':
    case 'latest':
      return typeof value === 'string' ? formatCell(field, value, ctx) : '';
    default:
      break;
  }
  if (typeof value !== 'number') return '';
  if (kind === 'range' && summaryKindsFor(field).includes('earliest'))
    return numberFormat(ctx.locale, {
      style: 'unit',
      unit: 'day',
      unitDisplay: 'long',
      maximumFractionDigits: 1,
    }).format(value);
  // A formula or rollup formats its numbers as its result type does.
  const shown = resultField(field);
  const openPrecision = shown.type === 'number' && shown.options.precision === null;
  if ((kind === 'average' || kind === 'median') && (PLAIN_NUMBERS.has(shown.type) || openPrecision))
    return numberFormat(ctx.locale, { maximumFractionDigits: 2 }).format(value);
  return formatCell(field, value, ctx);
}

/** "12 records", which the primary field's footer shows. */
export function recordsText(count: number, t: Translate): string {
  return t(
    msg({
      id: 'grid.summary.records',
      message: plural(count, { one: '# record', other: '# records' }),
    }),
  );
}

/** What a screen reader reads for a summary, or for its absence while it loads or can't be read. */
export function spokenSummary(
  field: FieldMeta,
  kind: SummaryKind,
  value: string | null,
  state: 'ready' | 'loading' | 'error',
  t: Translate,
): string {
  const name = field.name;
  if (kind === 'none')
    return t({
      ...msg({ id: 'grid.summary.spoken.none', message: '{action}: {field}, no summary' }),
      values: { action: t(msg({ id: 'grid.summary.choose', message: 'Summarize' })), field: name },
    });
  const kindLabel = t(SUMMARY_LABELS[kind]);
  if (state === 'loading')
    return t({
      ...msg({ id: 'grid.summary.spoken.loading', message: '{kind}: summary of {field} is loading' }),
      values: { kind: kindLabel, field: name },
    });
  if (state === 'error')
    return t({
      ...msg({ id: 'grid.summary.spoken.unavailable', message: '{kind}: summary of {field} is unavailable' }),
      values: { kind: kindLabel, field: name },
    });
  return t({
    ...SPOKEN[kind],
    values: {
      field: name,
      value: value || t(msg({ id: 'grid.summary.spoken.nothing', message: 'no values' })),
    },
  });
}
