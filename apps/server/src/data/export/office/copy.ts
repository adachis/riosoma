import { formatMessage, type MessageValue } from '../../../reports/messages.js';

/**
 * The words Word documents and decks carry of their own: the lines under a title, the note on a
 * file that stops at its limit, page numbers, and a view's filter put into words.  They're written
 * as the app's other strings are, as messages with explicit IDs that the catalog extraction
 * collects, and several are the app's own messages reused with identical text.
 */

export interface Descriptor {
  id: string;
  message: string;
}

export const OFFICE_COPY = {
  source: /*i18n*/ {
    id: 'export.document.source',
    message: 'From the {view} view of {table}, as of {time}.',
  },
  recordSource: /*i18n*/ {
    id: 'export.document.recordSource',
    message: 'A record in {table}, as of {time}.',
  },
  count: /*i18n*/ {
    id: 'print.count',
    message: '{count, plural, one {# record} other {# records}}',
  },
  filter: /*i18n*/ { id: 'export.document.filter', message: 'Filter: {filter}' },
  noFilter: /*i18n*/ {
    id: 'export.document.noFilter',
    message: 'No filter, so every record you can see in the table is here.',
  },
  capped: /*i18n*/ {
    id: 'export.document.capped',
    message:
      'This file holds the first {shown} of the view’s {total} records.  Download the view as CSV or Excel for every one of them.',
  },
  fieldsLeftOut: /*i18n*/ {
    id: 'export.document.fieldsLeftOut',
    message: 'The table shows the first {shown} of the view’s {total} fields.',
  },
  page: /*i18n*/ { id: 'print.page', message: 'Page {page} of {count}' },
  group: /*i18n*/ { id: 'export.document.group', message: '{group} ({count})' },
  emptyGroup: /*i18n*/ { id: 'kanban.empty', message: 'No {field}' },
  untitled: /*i18n*/ { id: 'record.untitled', message: 'Untitled record' },
  noRecords: /*i18n*/ { id: 'print.empty', message: 'No records' },
  rows: /*i18n*/ { id: 'export.deck.rows', message: 'Records {first} to {last} of {total}' },
  comments: /*i18n*/ { id: 'record.tab.comments', message: 'Comments' },
  noComments: /*i18n*/ { id: 'comments.empty', message: 'No comments yet.' },
  someone: /*i18n*/ { id: 'comments.unknownPerson', message: 'Someone' },
  edited: /*i18n*/ { id: 'comments.edited', message: 'edited' },
  imagesCapped: /*i18n*/ {
    id: 'export.document.imagesCapped',
    message: 'The first {shown} of the record’s {total} images are shown.',
  },
} satisfies Record<string, Descriptor>;

/** PDF copy lives with document copy so the same catalog extraction includes every print label. */
export const REPORT_PDF_COPY = {
  count: /*i18n*/ { id: 'reports.pdf.count', message: '{count, plural, one {# record} other {# records}}' },
  page: /*i18n*/ { id: 'reports.pdf.page', message: 'Page {page} of {count}' },
  total: /*i18n*/ { id: 'reports.pdf.total', message: 'Total' },
  empty: /*i18n*/ { id: 'reports.pdf.empty', message: 'No records' },
  taskComplete: /*i18n*/ { id: 'reports.pdf.taskComplete', message: '[x] {text}' },
  taskIncomplete: /*i18n*/ { id: 'reports.pdf.taskIncomplete', message: '[ ] {text}' },
  capped: /*i18n*/ { id: 'reports.pdf.capped', message: 'Showing {shown} of {total} records.' },
} satisfies Record<string, Descriptor>;

export const FILTER_COPY = {
  and: /*i18n*/ { id: 'export.filter.and', message: '{first} and {second}' },
  or: /*i18n*/ { id: 'export.filter.or', message: '{first} or {second}' },
  nested: /*i18n*/ { id: 'export.filter.nested', message: '({conditions})' },
  condition: /*i18n*/ { id: 'export.filter.condition', message: '{field} {operator} {value}' },
  bare: /*i18n*/ { id: 'export.filter.bare', message: '{field} {operator}' },
  checked: /*i18n*/ { id: 'export.filter.checked', message: 'checked' },
  unchecked: /*i18n*/ { id: 'export.filter.unchecked', message: 'unchecked' },
  hiddenRecord: /*i18n*/ { id: 'permissions.hiddenRecord', message: 'Hidden record' },
  daysAgo: /*i18n*/ {
    id: 'export.filter.daysAgo',
    message: '{days, plural, one {# day ago} other {# days ago}}',
  },
  daysFromNow: /*i18n*/ {
    id: 'export.filter.daysFromNow',
    message: '{days, plural, one {# day from now} other {# days from now}}',
  },
  pastDays: /*i18n*/ {
    id: 'export.filter.pastDays',
    message: '{days, plural, one {the past day} other {the past # days}}',
  },
  nextDays: /*i18n*/ {
    id: 'export.filter.nextDays',
    message: '{days, plural, one {the next day} other {the next # days}}',
  },
  distance: /*i18n*/ { id: 'export.filter.distance', message: '{distance} of {place}' },
  quoted: /*i18n*/ { id: 'export.filter.quoted', message: '“{text}”' },
} satisfies Record<string, Descriptor>;

/** How each operator reads, with the app's own words where it has them. */
export const OPERATOR_COPY = {
  is: /*i18n*/ { id: 'view.filter.op.is', message: 'is' },
  isNot: /*i18n*/ { id: 'view.filter.op.isNot', message: 'is not' },
  contains: /*i18n*/ { id: 'view.filter.op.contains', message: 'contains' },
  doesNotContain: /*i18n*/ { id: 'view.filter.op.doesNotContain', message: 'does not contain' },
  eq: /*i18n*/ { id: 'export.filter.op.eq', message: 'is' },
  neq: /*i18n*/ { id: 'export.filter.op.neq', message: 'is not' },
  lt: /*i18n*/ { id: 'export.filter.op.lt', message: 'is less than' },
  lte: /*i18n*/ { id: 'export.filter.op.lte', message: 'is at most' },
  gt: /*i18n*/ { id: 'export.filter.op.gt', message: 'is more than' },
  gte: /*i18n*/ { id: 'export.filter.op.gte', message: 'is at least' },
  isBefore: /*i18n*/ { id: 'view.filter.op.isBefore', message: 'is before' },
  isAfter: /*i18n*/ { id: 'view.filter.op.isAfter', message: 'is after' },
  isOnOrBefore: /*i18n*/ { id: 'view.filter.op.isOnOrBefore', message: 'is on or before' },
  isOnOrAfter: /*i18n*/ { id: 'view.filter.op.isOnOrAfter', message: 'is on or after' },
  isWithin: /*i18n*/ { id: 'view.filter.op.isWithin', message: 'is within' },
  overlaps: /*i18n*/ { id: 'fields.dateRange.op.overlaps', message: 'overlaps' },
  containsDate: /*i18n*/ { id: 'fields.dateRange.op.containsDate', message: 'includes the day' },
  isAnyOf: /*i18n*/ { id: 'view.filter.op.isAnyOf', message: 'is any of' },
  isNoneOf: /*i18n*/ { id: 'view.filter.op.isNoneOf', message: 'is none of' },
  hasAnyOf: /*i18n*/ { id: 'view.filter.op.hasAnyOf', message: 'has any of' },
  hasAllOf: /*i18n*/ { id: 'view.filter.op.hasAllOf', message: 'has all of' },
  hasNoneOf: /*i18n*/ { id: 'view.filter.op.hasNoneOf', message: 'has none of' },
  isExactly: /*i18n*/ { id: 'view.filter.op.isExactly', message: 'is exactly' },
  isEmpty: /*i18n*/ { id: 'view.filter.op.isEmpty', message: 'is empty' },
  isNotEmpty: /*i18n*/ { id: 'view.filter.op.isNotEmpty', message: 'is not empty' },
} satisfies Record<string, Descriptor>;

/** A date range compares the day it starts, and says so, as the filter editor does. */
export const RANGE_OPERATOR_COPY = {
  is: /*i18n*/ { id: 'fields.dateRange.op.is', message: 'starts on' },
  isNot: /*i18n*/ { id: 'fields.dateRange.op.isNot', message: 'doesn’t start on' },
  isBefore: /*i18n*/ { id: 'fields.dateRange.op.isBefore', message: 'starts before' },
  isAfter: /*i18n*/ { id: 'fields.dateRange.op.isAfter', message: 'starts after' },
  isOnOrBefore: /*i18n*/ { id: 'fields.dateRange.op.isOnOrBefore', message: 'starts on or before' },
  isOnOrAfter: /*i18n*/ { id: 'fields.dateRange.op.isOnOrAfter', message: 'starts on or after' },
  isWithin: /*i18n*/ { id: 'fields.dateRange.op.isWithin', message: 'is all within' },
} satisfies Record<string, Descriptor>;

export const DATE_COPY = {
  today: /*i18n*/ { id: 'view.filter.date.today', message: 'today' },
  tomorrow: /*i18n*/ { id: 'view.filter.date.tomorrow', message: 'tomorrow' },
  yesterday: /*i18n*/ { id: 'view.filter.date.yesterday', message: 'yesterday' },
  oneWeekAgo: /*i18n*/ { id: 'view.filter.date.oneWeekAgo', message: 'one week ago' },
  oneWeekFromNow: /*i18n*/ { id: 'view.filter.date.oneWeekFromNow', message: 'one week from now' },
  oneMonthAgo: /*i18n*/ { id: 'view.filter.date.oneMonthAgo', message: 'one month ago' },
  oneMonthFromNow: /*i18n*/ { id: 'view.filter.date.oneMonthFromNow', message: 'one month from now' },
  pastWeek: /*i18n*/ { id: 'view.filter.range.pastWeek', message: 'the past week' },
  pastMonth: /*i18n*/ { id: 'view.filter.range.pastMonth', message: 'the past month' },
  pastYear: /*i18n*/ { id: 'view.filter.range.pastYear', message: 'the past year' },
  nextWeek: /*i18n*/ { id: 'view.filter.range.nextWeek', message: 'the next week' },
  nextMonth: /*i18n*/ { id: 'view.filter.range.nextMonth', message: 'the next month' },
  nextYear: /*i18n*/ { id: 'view.filter.range.nextYear', message: 'the next year' },
} satisfies Record<string, Descriptor>;

/** A message in plain text, with its values filled in the reader's way. */
export function say(
  descriptor: Descriptor,
  locale: string,
  values: Readonly<Record<string, MessageValue>> = {},
): string {
  return formatMessage(descriptor.message, values, { locale, html: false });
}
