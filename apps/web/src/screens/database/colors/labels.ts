import type { I18n } from '@lingui/core';
import { msg, plural } from '@lingui/core/macro';
import {
  FieldOptions,
  type ChoiceColor,
  type ColorRule,
  type DateRange,
  type DateTarget,
  type FieldMeta,
  type FilterCondition,
  type LocationDistance,
} from '@riosoma/contracts';
import { resultField } from '../../../data/formulas';
import { formatCell, type FormatContext } from '../../../grid/format';
import { dateLabels, operatorLabels, rangeLabels } from '../view/messages';

/** Each palette color's name, for menus and for the marks screen readers hear. */
export const colorNames = {
  gray: msg({ id: 'views.color.name.gray', message: 'Gray' }),
  red: msg({ id: 'views.color.name.red', message: 'Red' }),
  orange: msg({ id: 'views.color.name.orange', message: 'Orange' }),
  yellow: msg({ id: 'views.color.name.yellow', message: 'Yellow' }),
  green: msg({ id: 'views.color.name.green', message: 'Green' }),
  teal: msg({ id: 'views.color.name.teal', message: 'Teal' }),
  blue: msg({ id: 'views.color.name.blue', message: 'Blue' }),
  purple: msg({ id: 'views.color.name.purple', message: 'Purple' }),
  pink: msg({ id: 'views.color.name.pink', message: 'Pink' }),
  brown: msg({ id: 'views.color.name.brown', message: 'Brown' }),
} satisfies Record<ChoiceColor, ReturnType<typeof msg>>;

function list(items: readonly string[], locale: string): string {
  try {
    return new Intl.ListFormat(locale, { type: 'unit', style: 'short' }).format(items);
  } catch {
    return items.join(', ');
  }
}

function dayText(target: DateTarget, field: FieldMeta, format: FormatContext, i18n: I18n): string {
  if (target.mode === 'exactDate')
    return formatCell({ ...field, type: 'date', options: FieldOptions.date.parse({}) }, target.date, format);
  if (target.mode !== 'daysAgo' && target.mode !== 'daysFromNow') return i18n._(dateLabels[target.mode]);
  const days = target.days;
  return target.mode === 'daysAgo'
    ? i18n._(
        msg({
          id: 'views.color.value.daysAgo',
          message: plural(days, { one: '# day ago', other: '# days ago' }),
        }),
      )
    : i18n._(
        msg({
          id: 'views.color.value.daysFromNow',
          message: plural(days, { one: '# day from now', other: '# days from now' }),
        }),
      );
}

function rangeText(range: DateRange, i18n: I18n): string {
  if (range.mode !== 'pastDays' && range.mode !== 'nextDays') return i18n._(rangeLabels[range.mode]);
  const days = range.days;
  return range.mode === 'pastDays'
    ? i18n._(
        msg({
          id: 'views.color.value.pastDays',
          message: plural(days, { one: 'the past day', other: 'the past # days' }),
        }),
      )
    : i18n._(
        msg({
          id: 'views.color.value.nextDays',
          message: plural(days, { one: 'the next day', other: 'the next # days' }),
        }),
      );
}

/** A condition's value in words: names for choices and people, and days for dates. */
function valueText(condition: FilterCondition, field: FieldMeta, format: FormatContext, i18n: I18n): string {
  const value = condition.value;
  if (value === undefined || value === null || value === '') return '';
  const shown = resultField(field);
  if (shown.type === 'checkbox')
    return value === true
      ? i18n._(msg({ id: 'views.color.value.checked', message: 'checked' }))
      : i18n._(msg({ id: 'views.color.value.unchecked', message: 'not checked' }));
  if (
    shown.type === 'date' ||
    shown.type === 'createdTime' ||
    shown.type === 'lastModifiedTime' ||
    shown.type === 'dateRange'
  )
    return condition.operator === 'isWithin' || condition.operator === 'overlaps'
      ? rangeText(value as DateRange, i18n)
      : dayText(value as DateTarget, field, format, i18n);
  if (shown.type === 'location') {
    const { lat, lng, km } = value as LocationDistance;
    const distance = new Intl.NumberFormat(format.locale, { maximumFractionDigits: 1 }).format(km);
    const place = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    return i18n._(msg({ id: 'views.color.value.distance', message: `${distance} km of ${place}` }));
  }
  const ids = typeof value === 'string' ? [value] : Array.isArray(value) ? value.map(String) : [];
  if (shown.type === 'singleSelect' || shown.type === 'multipleSelect')
    return list(
      ids.map((id) => shown.options.choices.find((choice) => choice.id === id)?.name ?? id),
      format.locale,
    );
  if (shown.type === 'createdBy' || shown.type === 'lastModifiedBy' || shown.type === 'user')
    return list(
      ids.map((id) => format.collaborators.get(id)?.name ?? id),
      format.locale,
    );
  if (shown.type === 'link' && Array.isArray(value))
    return list(
      ids.map((id) => format.linked?.get(id) ?? id),
      format.locale,
    );
  if (typeof value === 'number') return formatCell(shown, value, format) || String(value);
  const text = String(value);
  return i18n._(msg({ id: 'views.color.value.text', message: `“${text}”` }));
}

/** A condition in words, such as "Status is Done" or "Due is before today". */
export function conditionWords(
  condition: FilterCondition,
  field: FieldMeta | undefined,
  format: FormatContext,
  i18n: I18n,
): string {
  const operator = i18n._(operatorLabels[condition.operator]);
  const name = field?.name ?? i18n._(msg({ id: 'views.color.missingField', message: 'A deleted field' }));
  const value = field ? valueText(condition, field, format, i18n) : '';
  return value
    ? i18n._(msg({ id: 'views.color.condition', message: `${name} ${operator} ${value}` }))
    : i18n._(msg({ id: 'views.color.conditionOnly', message: `${name} ${operator}` }));
}

/** What screen readers hear for a rule: its own name, or its condition in words. */
export function ruleName(
  rule: ColorRule,
  field: FieldMeta | undefined,
  format: FormatContext,
  i18n: I18n,
): string {
  return rule.name.trim() || conditionWords(rule.condition, field, format, i18n);
}
