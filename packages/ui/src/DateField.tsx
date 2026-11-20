import { faXmark } from '@fortawesome/free-solid-svg-icons';
import {
  getLocalTimeZone,
  now,
  parseAbsolute,
  parseDate,
  toCalendarDate,
  toZoned,
  type DateValue,
} from '@internationalized/date';
import { useLingui } from '@lingui/react/macro';
import { Icon } from '@riosoma/icons';
import {
  Button as AriaButton,
  DateField as AriaDateField,
  DateInput,
  DateSegment,
  GroupContext,
  type DateFieldProps as AriaDateFieldProps,
  type DateFieldRenderProps,
} from 'react-aria-components';
import { useCallback, useMemo, useRef } from 'react';
import type { ReactNode, Ref, RefObject } from 'react';
import { cx } from './cx';
import { FieldShell, type FieldErrorMessage, type FieldSize } from './FieldShell';
import { Tooltip, TooltipTrigger } from './Tooltip';
import './DateField.css';

/**
 * How the date components speak to callers: text in, text out, so no caller has to reach for a
 * date library.  Without a time the text is a day, `2026-09-27`.  With one it is an instant in
 * UTC, `2026-09-27T22:05:00.000Z`, which the reader sees and edits in `timeZone`.
 */
export interface DateTextProps {
  /** The value as text; `null` is no value at all. */
  value?: string | null;
  /** The value the component starts from when the caller does not hold it. */
  defaultValue?: string | null;
  /** The new text, or `null` once every segment is empty. */
  onChange?: (value: string | null) => void;
  /** The earliest value a reader may reach. */
  minValue?: string | null;
  /** The latest value a reader may reach. */
  maxValue?: string | null;
  /** Days a reader may not choose, decided from the same text the value uses. */
  isDateUnavailable?: (value: string) => boolean;
  /** Adds hour and minute segments, and makes the value an instant in UTC. */
  includeTime?: boolean;
  /** The IANA zone the value is shown and edited in; the browser's own by default. */
  timeZone?: string;
  /** Overrides the clock the locale would have chosen. */
  hourCycle?: 12 | 24;
}

/** Which shape the text has, and which zone it is read in. */
export interface DateTextFormat {
  includeTime?: boolean;
  timeZone?: string;
}

/** Text from a caller into a value React Aria holds.  Empty or unreadable text is no value. */
export function parseDateText(
  text: string | null | undefined,
  { includeTime, timeZone }: DateTextFormat,
): DateValue | null {
  if (text == null || text === '') return null;
  try {
    return includeTime ? parseAbsolute(text, timeZone ?? getLocalTimeZone()) : parseDate(text);
  } catch {
    // A stored value that is not a date leaves the field empty instead of breaking the page.
    return null;
  }
}

/** A value back into the caller's text. */
export function formatDateText(
  value: DateValue | null,
  { includeTime, timeZone }: DateTextFormat,
): string | null {
  if (value == null) return null;
  if (!includeTime) return toCalendarDate(value).toString();
  // A value typed into an empty field can come back with no zone of its own.  The zone the reader
  // was looking at is the one the instant is read in.
  return toZoned(value, timeZone ?? getLocalTimeZone()).toAbsoluteString();
}

/** The text contract as the props React Aria holds underneath. */
export interface DateTextValues {
  value: DateValue | null | undefined;
  defaultValue: DateValue | null | undefined;
  minValue: DateValue | null | undefined;
  maxValue: DateValue | null | undefined;
  /** Stands in for an empty value, and carries the zone the value is written back in. */
  placeholderValue: DateValue;
  onChange: ((value: DateValue | null) => void) | undefined;
  isDateUnavailable: ((date: DateValue) => boolean) | undefined;
  /** The smallest unit the segments show: a day, or a day and a time. */
  granularity: 'day' | 'minute';
  /** The zone is the caller's choice, so a segment for it would only repeat what is fixed. */
  hideTimeZone: true;
  hourCycle: 12 | 24 | undefined;
}

/**
 * The text contract translated both ways.  Every value is memoized on the text it came from:
 * handing React Aria a new date object on each render would have it rebuild its own state during
 * render, over and over.
 */
export function useDateText(props: DateTextProps): DateTextValues {
  const {
    value,
    defaultValue,
    minValue,
    maxValue,
    onChange,
    isDateUnavailable,
    includeTime = false,
    timeZone,
    hourCycle,
  } = props;
  const zone = useMemo(() => timeZone ?? getLocalTimeZone(), [timeZone]);
  const format = useMemo<DateTextFormat>(() => ({ includeTime, timeZone: zone }), [includeTime, zone]);
  const convert = useCallback(
    (text: string | null | undefined) => (text === undefined ? undefined : parseDateText(text, format)),
    [format],
  );
  const parsedValue = useMemo(() => convert(value), [convert, value]);
  const parsedDefault = useMemo(() => convert(defaultValue), [convert, defaultValue]);
  const parsedMin = useMemo(() => convert(minValue), [convert, minValue]);
  const parsedMax = useMemo(() => convert(maxValue), [convert, maxValue]);
  // Without a value of its own the field falls back to today, and today is the one in the caller's
  // zone rather than the browser's when the two differ.
  const placeholderValue = useMemo(
    () =>
      includeTime
        ? now(zone).set({ hour: 0, minute: 0, second: 0, millisecond: 0 })
        : toCalendarDate(now(zone)),
    [includeTime, zone],
  );
  const handleChange = useMemo(
    () => (onChange == null ? undefined : (next: DateValue | null) => onChange(formatDateText(next, format))),
    [onChange, format],
  );
  const unavailable = useMemo(
    () =>
      isDateUnavailable == null
        ? undefined
        : (date: DateValue) => {
            const text = formatDateText(date, format);
            return text == null ? false : isDateUnavailable(text);
          },
    [isDateUnavailable, format],
  );

  return {
    value: parsedValue,
    defaultValue: parsedDefault,
    minValue: parsedMin,
    maxValue: parsedMax,
    placeholderValue,
    onChange: handleChange,
    isDateUnavailable: unavailable,
    granularity: includeTime ? 'minute' : 'day',
    hideTimeZone: true,
    hourCycle,
  };
}

/** A field's state, as far as clearing it needs to know. */
interface ClearableState {
  setValue(value: DateValue | null): void;
}

export interface DateSegmentsProps {
  /** Where the segments live, for a caller that has to put focus back into them. */
  inputRef?: Ref<HTMLDivElement>;
  className?: string;
}

/**
 * The row of editable segments, shared by DateField and DatePicker so that both read and behave
 * the same.  React Aria names each segment for the locale in use and orders the parts the way that
 * locale writes a date.
 */
export function DateSegments({ inputRef, className }: DateSegmentsProps) {
  return (
    // The field frame already consumes the group's ID and keyboard handlers. The picker creates
    // its own segment group, while a standalone field must not attach those props twice.
    <GroupContext.Provider value={null}>
      <DateInput ref={inputRef} className={cx('rio-date-field__input', className)}>
        {(segment) => <DateSegment segment={segment} className="rio-date-field__segment" />}
      </DateInput>
    </GroupContext.Provider>
  );
}

export interface ClearDateButtonProps {
  /** The state of the field or picker the button empties. */
  state: ClearableState;
  segmentsRef: RefObject<HTMLDivElement | null>;
  isDisabled?: boolean;
}

/**
 * Empties every segment and moves focus back into the segments. The disabled button keeps its
 * space so the field never shifts; `slot={null}` keeps the props a surrounding picker
 * hands to its own buttons — the ones that open a calendar — off it.
 */
export function ClearDateButton({ state, segmentsRef, isDisabled }: ClearDateButtonProps) {
  const { t } = useLingui();
  const label = t({ id: 'ui.date.clear', message: 'Clear' });
  return (
    <TooltipTrigger>
      <AriaButton
        slot={null}
        className="rio-field__action rio-date-field__clear"
        isDisabled={isDisabled}
        aria-label={label}
        onPress={() => {
          state.setValue(null);
          segmentsRef.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
        }}
      >
        <Icon icon={faXmark} size="0.85em" />
      </AriaButton>
      <Tooltip>{label}</Tooltip>
    </TooltipTrigger>
  );
}

export interface DateFieldProps
  extends
    DateTextProps,
    Omit<
      AriaDateFieldProps<DateValue>,
      | 'className'
      | 'style'
      | 'children'
      | 'value'
      | 'defaultValue'
      | 'onChange'
      | 'minValue'
      | 'maxValue'
      | 'placeholderValue'
      | 'isDateUnavailable'
      | 'granularity'
      | 'hideTimeZone'
      | 'hourCycle'
    > {
  /** Visible label.  Callers pass text that is already translated. */
  label?: ReactNode;
  /** Help text under the control. */
  description?: ReactNode;
  /** Error text, shown only while the field is invalid. */
  errorMessage?: FieldErrorMessage;
  size?: FieldSize;
  className?: string;
}

/**
 * A date typed straight into its parts: a segment for the month, the day, and the year, and for the
 * hour and minute when `includeTime` is set.  The order of the parts, their names, and the month
 * names all follow the active locale, so the field reads the way the reader writes a date.
 *
 * ```tsx
 * <DateField label="Departure date" value={departure} onChange={setDeparture} />
 * <DateField label="Departs" includeTime timeZone="America/Los_Angeles" value={at} onChange={setAt} />
 * ```
 */
export function DateField({
  label,
  description,
  errorMessage,
  size = 'md',
  className,
  value,
  defaultValue,
  onChange,
  minValue,
  maxValue,
  isDateUnavailable,
  includeTime = false,
  timeZone,
  hourCycle,
  ...rest
}: DateFieldProps) {
  const dates = useDateText({
    value,
    defaultValue,
    onChange,
    minValue,
    maxValue,
    isDateUnavailable,
    includeTime,
    timeZone,
    hourCycle,
  });
  const segmentsRef = useRef<HTMLDivElement>(null);
  return (
    <AriaDateField
      {...rest}
      {...dates}
      className={cx('rio-field', 'rio-date-field', className)}
      data-size={size}
    >
      {({ state, isDisabled, isReadOnly }: DateFieldRenderProps) => (
        <FieldShell
          label={label}
          description={description}
          errorMessage={errorMessage}
          isRequired={rest.isRequired}
          actions={
            <ClearDateButton
              state={state}
              segmentsRef={segmentsRef}
              isDisabled={state.value == null || isDisabled || isReadOnly}
            />
          }
        >
          <DateSegments inputRef={segmentsRef} />
        </FieldShell>
      )}
    </AriaDateField>
  );
}
