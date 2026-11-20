import { faCalendarDays } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import { Icon } from '@riosoma/icons';
import {
  Button as AriaButton,
  DatePicker as AriaDatePicker,
  Dialog as AriaDialog,
  type DatePickerProps as AriaDatePickerProps,
  type DatePickerRenderProps,
} from 'react-aria-components';
import { useRef } from 'react';
import type { ReactNode } from 'react';
import type { DateValue } from '@internationalized/date';
import { Calendar } from './Calendar';
import { cx } from './cx';
import { ClearDateButton, DateSegments, useDateText, type DateTextProps } from './DateField';
import { FieldShell, type FieldErrorMessage, type FieldSize } from './FieldShell';
import { Popover } from './Popover';
import { Tooltip, TooltipTrigger } from './Tooltip';
import './DatePicker.css';

export interface DatePickerProps
  extends
    DateTextProps,
    Omit<
      AriaDatePickerProps<DateValue>,
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
 * A date field with a calendar beside it: the segments take a date the reader knows, and the
 * popover takes one they have to look up.  Both write the same text back, so a caller never has to
 * say which of the two a value came from.
 *
 * With `includeTime` the popover closes on the day and keeps the clock the field already showed,
 * or midnight when it had nothing; the reader then types the hour and minute in the segments.
 *
 * ```tsx
 * <DatePicker label="Starts" value={starts} onChange={setStarts} />
 * ```
 */
export function DatePicker({
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
}: DatePickerProps) {
  const { t } = useLingui();
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
    <AriaDatePicker
      {...rest}
      {...dates}
      className={cx('rio-field', 'rio-date-picker', className)}
      data-size={size}
    >
      {({ state, isDisabled, isReadOnly }: DatePickerRenderProps) => (
        <>
          <FieldShell
            label={label}
            description={description}
            errorMessage={errorMessage}
            isRequired={rest.isRequired}
            actions={
              <>
                <ClearDateButton
                  state={state}
                  segmentsRef={segmentsRef}
                  isDisabled={state.value == null || isDisabled || isReadOnly}
                />
                {/* React Aria wires this button to the popover: it opens the calendar, says whether
                    it is open, and takes focus back when the calendar closes. */}
                <TooltipTrigger>
                  <AriaButton
                    className="rio-field__action rio-date-picker__open"
                    aria-label={t({ id: 'ui.date.open', message: 'Choose a date' })}
                  >
                    <Icon icon={faCalendarDays} size="0.95em" />
                  </AriaButton>
                  <Tooltip>{t({ id: 'ui.date.open', message: 'Choose a date' })}</Tooltip>
                </TooltipTrigger>
              </>
            }
          >
            <DateSegments inputRef={segmentsRef} />
          </FieldShell>
          <Popover className="rio-date-picker__popover">
            <AriaDialog className="rio-date-picker__dialog">
              {/* The picker hands the calendar its value, bounds, and unavailable days through
                  context, so the one inside it is the same component a page uses on its own. */}
              <Calendar />
            </AriaDialog>
          </Popover>
        </>
      )}
    </AriaDatePicker>
  );
}
