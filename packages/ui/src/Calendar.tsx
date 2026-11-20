import { faChevronLeft, faChevronRight } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import { Icon } from '@riosoma/icons';
import {
  Button as AriaButton,
  Calendar as AriaCalendar,
  CalendarCell,
  CalendarGrid,
  CalendarGridBody,
  CalendarGridHeader,
  CalendarHeading,
  CalendarHeaderCell,
  type CalendarProps as AriaCalendarProps,
} from 'react-aria-components';
import type { DateValue } from '@internationalized/date';
import { cx } from './cx';
import { useDateText } from './DateField';
import { Tooltip, TooltipTrigger } from './Tooltip';
import './Calendar.css';

export interface CalendarProps extends Omit<
  AriaCalendarProps<DateValue>,
  | 'className'
  | 'style'
  | 'children'
  | 'value'
  | 'defaultValue'
  | 'onChange'
  | 'minValue'
  | 'maxValue'
  | 'isDateUnavailable'
  | 'selectionMode'
> {
  /** The chosen day, as `YYYY-MM-DD`; `null` is no day at all. */
  value?: string | null;
  defaultValue?: string | null;
  /** The chosen day as `YYYY-MM-DD`. */
  onChange?: (value: string | null) => void;
  /** The earliest month and day a reader may reach. */
  minValue?: string | null;
  /** The latest month and day a reader may reach. */
  maxValue?: string | null;
  /** Days a reader may not choose, as `YYYY-MM-DD`. */
  isDateUnavailable?: (value: string) => boolean;
  className?: string;
}

/**
 * A month of days with the month's name above it and a way to the months on either side.  Today
 * carries a dot, the chosen day carries the accent, and a day nobody may choose is struck through
 * rather than hidden, so the shape of the month stays the same.
 *
 * One day at a time: a range needs two anchors and its own contract.  Name the calendar with
 * `aria-label` when it stands on its own; inside a picker React Aria names it for the field.
 *
 * ```tsx
 * <Calendar aria-label="Departure date" value={day} onChange={setDay} />
 * ```
 */
export function Calendar({
  value,
  defaultValue,
  onChange,
  minValue,
  maxValue,
  isDateUnavailable,
  className,
  ...rest
}: CalendarProps) {
  const { t } = useLingui();
  const dates = useDateText({ value, defaultValue, onChange, minValue, maxValue, isDateUnavailable });
  return (
    <AriaCalendar
      {...rest}
      value={dates.value}
      defaultValue={dates.defaultValue}
      minValue={dates.minValue}
      maxValue={dates.maxValue}
      onChange={dates.onChange}
      isDateUnavailable={dates.isDateUnavailable}
      className={cx('rio-calendar', className)}
    >
      <header className="rio-calendar__header">
        <TooltipTrigger>
          <AriaButton
            slot="previous"
            className="rio-calendar__nav"
            aria-label={t({ id: 'ui.date.previousMonth', message: 'Previous month' })}
          >
            <Icon icon={faChevronLeft} size="0.8em" />
          </AriaButton>
          <Tooltip>{t({ id: 'ui.date.previousMonth', message: 'Previous month' })}</Tooltip>
        </TooltipTrigger>
        <CalendarHeading className="rio-calendar__title" />
        <TooltipTrigger>
          <AriaButton
            slot="next"
            className="rio-calendar__nav"
            aria-label={t({ id: 'ui.date.nextMonth', message: 'Next month' })}
          >
            <Icon icon={faChevronRight} size="0.8em" />
          </AriaButton>
          <Tooltip>{t({ id: 'ui.date.nextMonth', message: 'Next month' })}</Tooltip>
        </TooltipTrigger>
      </header>
      <CalendarGrid className="rio-calendar__grid">
        <CalendarGridHeader>
          {(day) => <CalendarHeaderCell className="rio-calendar__weekday">{day}</CalendarHeaderCell>}
        </CalendarGridHeader>
        <CalendarGridBody>
          {(date) => <CalendarCell date={date} className="rio-calendar__day" />}
        </CalendarGridBody>
      </CalendarGrid>
    </AriaCalendar>
  );
}
