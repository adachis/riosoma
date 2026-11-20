import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { sameValue, type DateRangeValue, type FieldOptionsOf } from '@riosoma/contracts';
import { DatePicker } from '@riosoma/ui';
import type { FormatContext } from '../grid/format';
import './fields.css';

export interface DateRangeInputProps {
  options: FieldOptionsOf<'dateRange'>;
  value: DateRangeValue | null;
  format: FormatContext;
  /** The element naming the whole range */
  labelId?: string;
  label?: string;
  autoFocus?: boolean;
  readOnly?: boolean;
  onChange: (value: DateRangeValue | null) => void;
}

/**
 * One field, two date pickers.  Choosing either end on its own makes a one-day range, so what's
 * on screen is always what's saved.  An end before the start waits, with a message, until fixed.
 */
export function DateRangeInput({
  options,
  value,
  format,
  labelId,
  label,
  autoFocus,
  readOnly,
  onChange,
}: DateRangeInputProps) {
  const { t } = useLingui();
  const [source, setSource] = useState(value);
  const [start, setStart] = useState(value?.start ?? null);
  const [end, setEnd] = useState(value?.end ?? null);
  if (!sameValue(source, value)) {
    setSource(value);
    setStart(value?.start ?? null);
    setEnd(value?.end ?? null);
  }
  const zone = options.timeZone === 'client' ? format.timeZone : options.timeZone;
  const hourCycle = options.timeFormat === '12h' ? 12 : options.timeFormat === '24h' ? 24 : undefined;
  // Days and UTC instants in the shapes a date picker gives both sort as text.
  const backwards = start !== null && end !== null && end < start;

  function change(nextStart: string | null, nextEnd: string | null) {
    const first = nextStart ?? nextEnd;
    const last = nextEnd ?? nextStart;
    setStart(first);
    setEnd(last);
    if (first === null || last === null) {
      if (value !== null) onChange(null);
      return;
    }
    if (last < first) return;
    const next = { start: first, end: last };
    if (!sameValue(value, next)) onChange(next);
  }

  const errorId = labelId ? `${labelId}-range-error` : undefined;
  return (
    <div
      className="rio-date-range-input"
      role="group"
      aria-labelledby={labelId}
      aria-label={labelId ? undefined : label}
      aria-describedby={backwards ? errorId : undefined}
    >
      <div className="rio-date-range-input__ends">
        <DatePicker
          label={t({ id: 'fields.dateRange.start', message: 'Start' })}
          value={start}
          includeTime={options.includeTime}
          timeZone={zone}
          hourCycle={hourCycle}
          autoFocus={autoFocus}
          isReadOnly={readOnly}
          isInvalid={backwards}
          onChange={(next) => change(next, next === null ? null : end)}
        />
        <DatePicker
          label={t({ id: 'fields.dateRange.end', message: 'End' })}
          value={end}
          includeTime={options.includeTime}
          timeZone={zone}
          hourCycle={hourCycle}
          isReadOnly={readOnly}
          isInvalid={backwards}
          onChange={(next) => change(next === null ? null : start, next)}
        />
      </div>
      <div id={errorId} className="rio-field-input__error" aria-live="polite">
        {backwards ? t({ id: 'fields.dateRange.order', message: 'The end comes before the start.' }) : ''}
      </div>
    </div>
  );
}
