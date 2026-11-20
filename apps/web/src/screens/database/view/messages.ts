import { msg } from '@lingui/core/macro';
import type { DateRange, DateTarget, FieldMeta, Operator, RowHeight } from '@riosoma/contracts';
import type { MessageDescriptor } from '@lingui/core';
import { resultField } from '../../../data/formulas';

export const operatorLabels = {
  is: msg({ id: 'view.filter.op.is', message: 'is' }),
  isNot: msg({ id: 'view.filter.op.isNot', message: 'is not' }),
  contains: msg({ id: 'view.filter.op.contains', message: 'contains' }),
  doesNotContain: msg({ id: 'view.filter.op.doesNotContain', message: 'does not contain' }),
  eq: msg({ id: 'view.filter.op.eq', message: '=' }),
  neq: msg({ id: 'view.filter.op.neq', message: '≠' }),
  lt: msg({ id: 'view.filter.op.lt', message: '<' }),
  lte: msg({ id: 'view.filter.op.lte', message: '≤' }),
  gt: msg({ id: 'view.filter.op.gt', message: '>' }),
  gte: msg({ id: 'view.filter.op.gte', message: '≥' }),
  isBefore: msg({ id: 'view.filter.op.isBefore', message: 'is before' }),
  isAfter: msg({ id: 'view.filter.op.isAfter', message: 'is after' }),
  isOnOrBefore: msg({ id: 'view.filter.op.isOnOrBefore', message: 'is on or before' }),
  isOnOrAfter: msg({ id: 'view.filter.op.isOnOrAfter', message: 'is on or after' }),
  isWithin: msg({ id: 'view.filter.op.isWithin', message: 'is within' }),
  overlaps: msg({ id: 'fields.dateRange.op.overlaps', message: 'overlaps' }),
  containsDate: msg({ id: 'fields.dateRange.op.containsDate', message: 'includes the day' }),
  isAnyOf: msg({ id: 'view.filter.op.isAnyOf', message: 'is any of' }),
  isNoneOf: msg({ id: 'view.filter.op.isNoneOf', message: 'is none of' }),
  hasAnyOf: msg({ id: 'view.filter.op.hasAnyOf', message: 'has any of' }),
  hasAllOf: msg({ id: 'view.filter.op.hasAllOf', message: 'has all of' }),
  hasNoneOf: msg({ id: 'view.filter.op.hasNoneOf', message: 'has none of' }),
  isExactly: msg({ id: 'view.filter.op.isExactly', message: 'is exactly' }),
  isEmpty: msg({ id: 'view.filter.op.isEmpty', message: 'is empty' }),
  isNotEmpty: msg({ id: 'view.filter.op.isNotEmpty', message: 'is not empty' }),
} satisfies Record<Operator, MessageDescriptor>;

/** A date range compares the day it starts, and says so. */
export const rangeOperatorLabels: Partial<Record<Operator, MessageDescriptor>> = {
  is: msg({ id: 'fields.dateRange.op.is', message: 'starts on' }),
  isNot: msg({ id: 'fields.dateRange.op.isNot', message: 'doesn’t start on' }),
  isBefore: msg({ id: 'fields.dateRange.op.isBefore', message: 'starts before' }),
  isAfter: msg({ id: 'fields.dateRange.op.isAfter', message: 'starts after' }),
  isOnOrBefore: msg({ id: 'fields.dateRange.op.isOnOrBefore', message: 'starts on or before' }),
  isOnOrAfter: msg({ id: 'fields.dateRange.op.isOnOrAfter', message: 'starts on or after' }),
  isWithin: msg({ id: 'fields.dateRange.op.isWithin', message: 'is all within' }),
};

/** The label of a condition's operator on a field, which a date range words its own way. */
export function operatorLabel(field: { type: string } | undefined, operator: Operator): MessageDescriptor {
  return (
    (field?.type === 'dateRange' ? rangeOperatorLabels[operator] : undefined) ?? operatorLabels[operator]
  );
}

export const dateLabels = {
  today: msg({ id: 'view.filter.date.today', message: 'today' }),
  tomorrow: msg({ id: 'view.filter.date.tomorrow', message: 'tomorrow' }),
  yesterday: msg({ id: 'view.filter.date.yesterday', message: 'yesterday' }),
  oneWeekAgo: msg({ id: 'view.filter.date.oneWeekAgo', message: 'one week ago' }),
  oneWeekFromNow: msg({ id: 'view.filter.date.oneWeekFromNow', message: 'one week from now' }),
  oneMonthAgo: msg({ id: 'view.filter.date.oneMonthAgo', message: 'one month ago' }),
  oneMonthFromNow: msg({ id: 'view.filter.date.oneMonthFromNow', message: 'one month from now' }),
  daysAgo: msg({ id: 'view.filter.date.daysAgo', message: 'number of days ago' }),
  daysFromNow: msg({ id: 'view.filter.date.daysFromNow', message: 'number of days from now' }),
  exactDate: msg({ id: 'view.filter.date.exactDate', message: 'exact date' }),
} satisfies Record<DateTarget['mode'], MessageDescriptor>;

export const rangeLabels = {
  pastWeek: msg({ id: 'view.filter.range.pastWeek', message: 'the past week' }),
  pastMonth: msg({ id: 'view.filter.range.pastMonth', message: 'the past month' }),
  pastYear: msg({ id: 'view.filter.range.pastYear', message: 'the past year' }),
  nextWeek: msg({ id: 'view.filter.range.nextWeek', message: 'the next week' }),
  nextMonth: msg({ id: 'view.filter.range.nextMonth', message: 'the next month' }),
  nextYear: msg({ id: 'view.filter.range.nextYear', message: 'the next year' }),
  pastDays: msg({ id: 'view.filter.range.pastDays', message: 'the past number of days' }),
  nextDays: msg({ id: 'view.filter.range.nextDays', message: 'the next number of days' }),
} satisfies Record<DateRange['mode'], MessageDescriptor>;

export const heightLabels = {
  short: msg({ id: 'view.rowHeight.short', message: 'Short' }),
  medium: msg({ id: 'view.rowHeight.medium', message: 'Medium' }),
  tall: msg({ id: 'view.rowHeight.tall', message: 'Tall' }),
  extraTall: msg({ id: 'view.rowHeight.extraTall', message: 'Extra tall' }),
} satisfies Record<RowHeight, MessageDescriptor>;

export const directionLabels = {
  text: [
    msg({ id: 'view.sort.text.asc', message: 'A → Z' }),
    msg({ id: 'view.sort.text.desc', message: 'Z → A' }),
  ],
  number: [
    msg({ id: 'view.sort.number.asc', message: '1 → 9' }),
    msg({ id: 'view.sort.number.desc', message: '9 → 1' }),
  ],
  date: [
    msg({ id: 'view.sort.date.asc', message: 'Oldest first' }),
    msg({ id: 'view.sort.date.desc', message: 'Newest first' }),
  ],
  checkbox: [
    msg({ id: 'view.sort.checkbox.asc', message: 'Unchecked first' }),
    msg({ id: 'view.sort.checkbox.desc', message: 'Checked first' }),
  ],
  select: [
    msg({ id: 'view.sort.select.asc', message: 'First → last' }),
    msg({ id: 'view.sort.select.desc', message: 'Last → first' }),
  ],
} as const;

/**
 * The wording a field's sort directions take.  Numbers read "1 → 9", dates oldest or newest first,
 * checkboxes unchecked or checked first, selects in their option order, and everything else as
 * text.  Formulas, lookups, and rollups follow the type of value they produce.
 */
export function directionFamily(field: FieldMeta | undefined): keyof typeof directionLabels {
  switch (field ? resultField(field).type : undefined) {
    case 'number':
    case 'currency':
    case 'percent':
    case 'duration':
    case 'rating':
    case 'autoNumber':
    case 'count':
      return 'number';
    case 'date':
    case 'createdTime':
    case 'lastModifiedTime':
    case 'dateRange':
    case 'signature':
      return 'date';
    case 'checkbox':
      return 'checkbox';
    case 'singleSelect':
    case 'multipleSelect':
      return 'select';
    default:
      return 'text';
  }
}
