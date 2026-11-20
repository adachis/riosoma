import { useLingui } from '@lingui/react/macro';
import { cellValue, checkCellValue, type CellValue, type FieldMeta } from '@riosoma/contracts';
import { Button, Calendar, TextField } from '@riosoma/ui';
import { useRef, useState } from 'react';
import { formatCell } from '../format';
import { parseText } from '../parse';
import { EditorPopover } from './EditorPopover';
import { applyValue, type EditorProps } from './types';

type DateFieldMeta = Extract<FieldMeta, { type: 'date' }>;

function DateContents(props: EditorProps & { field: DateFieldMeta }) {
  const { context, request, field } = props;
  const { t } = useLingui();
  const { includeTime, timeZone, timeFormat } = field.options;
  const dateField = { ...field, options: { ...field.options, includeTime: false } };
  const zone = timeZone === 'client' ? context.format.timeZone : timeZone;
  const [initial] = useState(() => {
    const parsed =
      request.initialText === null ? null : parseText(field, request.initialText, context.format);
    const value = parsed === null ? cellValue(request.row, field) : parsed.ok === true ? parsed.value : null;
    const valid = (parsed === null || parsed.ok === true) && checkCellValue(field, value).ok;
    if (typeof value !== 'string' || !valid) return { day: null, time: '', value: null, valid };
    if (!includeTime) return { day: value, time: '', value, valid };
    const instant = new Date(value);
    if (!Number.isFinite(instant.getTime())) return { day: null, time: '', value: null, valid: false };
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(instant);
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    const time = new Intl.DateTimeFormat(context.format.locale, {
      timeZone: zone,
      hour: 'numeric',
      minute: '2-digit',
      ...(timeFormat === 'local' ? {} : { hourCycle: timeFormat === '12h' ? 'h12' : 'h23' }),
    }).format(instant);
    return { day: `${get('year')}-${get('month')}-${get('day')}`, time, value, valid };
  });
  const [day, setDay] = useState<string | null>(initial.day);
  const [dateText, setDateText] = useState(() =>
    initial.valid ? formatCell(dateField, initial.day, context.format) : (request.initialText ?? ''),
  );
  const [time, setTime] = useState(initial.time);
  const [validDate, setValidDate] = useState(initial.valid);
  const [calendarVersion, setCalendarVersion] = useState(0);
  const focusedDay = useRef<string | null>(null);
  const ended = useRef(false);
  const parsed = parseText(
    field,
    day === null ? '' : includeTime ? `${day} ${time || '00:00'}` : day,
    context.format,
  );
  const invalid = parsed.ok !== true;

  function commit(value: CellValue) {
    if (ended.current || !applyValue(context, value)) return;
    ended.current = true;
    request.done('down');
  }

  function save(nextDay = day, fromCalendar = false) {
    if (ended.current || (!validDate && !fromCalendar)) return;
    // Leaving an instant unchanged preserves seconds and the chosen side of a repeated DST hour.
    if (initial.valid && nextDay === initial.day && time === initial.time) {
      commit(initial.value);
      return;
    }
    const text = nextDay === null ? '' : includeTime ? `${nextDay} ${time || '00:00'}` : nextDay;
    const result = parseText(field, text, context.format);
    if (result.ok === true) commit(result.value);
  }

  function cancel() {
    if (ended.current) return;
    ended.current = true;
    request.cancel();
  }

  return (
    <EditorPopover {...props} onDismiss={cancel}>
      <div
        className="rio-cell-editor__content"
        onClick={(event) => {
          // Selecting the already selected day does not emit Calendar's onChange.
          if (!includeTime && event.target instanceof Element && event.target.closest('[role="gridcell"]')) {
            save(focusedDay.current ?? day, true);
          }
        }}
        onKeyDownCapture={(event) => {
          if (event.nativeEvent.isComposing) return;
          const target = event.target;
          if (!(target instanceof HTMLElement)) return;
          const calendarDay = target.closest('[role="gridcell"]');
          if (event.key === 'Enter' && (calendarDay || target.matches('input'))) {
            event.preventDefault();
            event.stopPropagation();
            save(calendarDay ? (focusedDay.current ?? day) : day, calendarDay !== null);
          }
        }}
      >
        <TextField
          autoFocus
          aria-label={field.name}
          value={dateText}
          isInvalid={!validDate}
          onChange={(text) => {
            setDateText(text);
            const parsed = parseText(dateField, text, context.format);
            const valid = parsed.ok === true && (parsed.value === null || typeof parsed.value === 'string');
            setValidDate(valid);
            if (parsed.ok === true && (parsed.value === null || typeof parsed.value === 'string')) {
              setDay(parsed.value);
              // Calendar keeps its visible month separately from its value; typed dates reset both.
              focusedDay.current = null;
              setCalendarVersion((version) => version + 1);
            }
          }}
        />
        <Calendar
          key={calendarVersion}
          aria-label={field.name}
          value={day}
          onFocusChange={(date) => {
            focusedDay.current = date.toString();
          }}
          onChange={(next) => {
            setDay(next);
            setDateText(formatCell(dateField, next, context.format));
            setValidDate(true);
            if (!includeTime) save(next, true);
          }}
        />
        {includeTime && (
          <TextField
            label={t({ id: 'grid.editor.time', message: 'Time' })}
            description={zone}
            value={time}
            onChange={setTime}
            isInvalid={invalid}
          />
        )}
        <Button onPress={() => commit(null)}>{t({ id: 'grid.editor.clear', message: 'Clear' })}</Button>
      </div>
    </EditorPopover>
  );
}

export function DateEditor(props: EditorProps) {
  const field = props.context.field;
  return field.type === 'date' ? <DateContents {...props} field={field} /> : null;
}
