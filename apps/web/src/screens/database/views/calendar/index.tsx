import { shortcutKeys } from '../../../../shortcuts/registry';
import { sourceReadOnly } from '../../synced/override';
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { cellValue, newId, roleAllows, type FieldMeta, type RowData } from '@riosoma/contracts';
import { Button, DatePicker, Menu, MenuItem, MenuTrigger, Modal, Popover } from '@riosoma/ui';
import { Icon } from '@riosoma/icons';
import { Dialog } from 'react-aria-components';
import {
  faEllipsis,
  faArrowUp,
  faArrowDown,
  faArrowRight,
  faPlus,
  faArrowsUpDown,
  faChevronLeft,
  faChevronRight,
} from '@fortawesome/free-solid-svg-icons';
import { formatCell } from '../../../../grid/format';
import type { ViewComponentProps } from '../types';
import { StartFieldPicker } from './CalendarSettings';
import {
  addDays,
  adjacentRange,
  dateOptions,
  dayInZone,
  daysBetween,
  eventDay,
  isCalendarField,
  valueOnDay,
  visibleDays,
  zoneOf,
} from './dates';
import { useCalendarRows } from './rows';
import { dropRefusal } from '../drag/rules';
import { useHeld, useViewDrag, type DragPoint } from '../drag/useViewDrag';
import { parseText } from '../../../../grid/parse';
import { reportError } from '../../../../grid/view/actions';
import './calendar.css';

export { CalendarSettings } from './CalendarSettings';
const VISIBLE_EVENTS = 3;

export function CalendarView(props: ViewComponentProps) {
  const { t } = useLingui();
  const start = props.fields.find(
    (field) => field.id === props.view.config.calendar.startFieldId && isCalendarField(field),
  );
  if (!start)
    return (
      <div className="rio-calendar-view__empty">
        <p>{t({ id: 'calendar.chooseField', message: 'Choose a date field for this calendar' })}</p>
        <StartFieldPicker {...props} />
      </div>
    );
  return <Calendar key={`${props.view.id}:${start.id}`} {...props} start={start} />;
}

function Calendar(props: ViewComponentProps & { start: FieldMeta }) {
  const { t } = useLingui();
  const moveLeft = shortcutKeys('views.moveLeft');
  const moveRight = shortcutKeys('views.moveRight');
  const moveUp = shortcutKeys('views.moveUp');
  const moveDown = shortcutKeys('views.moveDown');
  const endUp = shortcutKeys('views.endUp');
  const endDown = shortcutKeys('views.endDown');
  const { session, table, view, fields, format, onExpand, start } = props;
  const gesture = useViewDrag();
  const root = useRef<HTMLDivElement>(null);
  const range = view.config.calendar.range;
  const today = () => dayInZone(new Date().toISOString(), zoneOf(start, format));
  const [localAnchor, setLocalAnchor] = useState(today);
  const anchor = props.calendarDay ?? localAnchor;
  function changeAnchor(day: string) {
    if (props.onCalendarDay) props.onCalendarDay(day);
    else setLocalAnchor(day);
  }
  const [focused, setFocused] = useState(today);
  const [listedDay, setListedDay] = useState<string | null>(null);
  const [moving, setMoving] = useState<RowData | null>(null);
  const [destination, setDestination] = useState<string | null>(null);
  const dayNodes = useRef(new Map<string, HTMLDivElement>());
  const popoverAnchor = useRef<HTMLDivElement | null>(null);
  const days = visibleDays(anchor, range, format.locale);
  const rangeKey = `${days[0]}:${days.at(-1)}`;
  const rangeRows = useCalendarRows(session, view.id, days[0]!, days[days.length - 1]!);
  const rows = useHeld(rangeRows.records, gesture.holding, rangeKey);
  const pendingFocus = useRef<{ id: string; day: string } | null>(null);
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending || rangeRows.loading) return;
    const dayNode = dayNodes.current.get(pending.day);
    if (!dayNode) return;
    const chip = dayNode.querySelector<HTMLElement>(`[data-calendar-record="${pending.id}"]`);
    const more = dayNode.querySelector<HTMLElement>('.rio-calendar-view__overflow button');
    pendingFocus.current = null;
    (chip ?? more ?? dayNode).focus();
  });
  const end = fields.find(
    (field) =>
      field.id === view.config.calendar.endFieldId && field.id !== start.id && isCalendarField(field),
  );
  const primary = fields.find((field) => field.id === table.primaryFieldId);
  // Moving a record to another day edits the record, so it takes the role that edits records.
  const writable =
    !props.readOnly &&
    roleAllows(session.role(), 'editRecords') &&
    start.type === 'date' &&
    !sourceReadOnly(start, table);
  const movable = writable && (!end || (end.type === 'date' && !sourceReadOnly(end, table)));
  const fullDate = (day: string) =>
    new Intl.DateTimeFormat(format.locale, {
      dateStyle: 'full',
      timeZone: 'UTC',
    }).format(new Date(`${day}T12:00:00Z`));
  const events = new Map(days.map((day) => [day, [] as RowData[]]));
  for (const row of rows) {
    const from = eventDay(cellValue(row, start), start, format);
    if (!from) continue;
    const to = end ? eventDay(cellValue(row, end), end, format) : from;
    for (const day of days)
      if (day >= from && day <= (to && to >= from ? to : from)) events.get(day)!.push(row);
  }
  const label = (day: string) => {
    const date = fullDate(day);
    const count = events.get(day)?.length ?? 0;
    return t({
      id: 'calendar.dayLabel',
      message: `${date}, ${plural(count, { 0: 'no records', one: '# record', other: '# records' })}`,
    });
  };
  const moveLabel = t({ id: 'calendar.moveTo', message: 'Move to…' });

  function move(row: RowData, day: string, minutes?: number) {
    const reason = dropRefusal(props, row, [start, ...(end ? [end] : [])]);
    if (reason) {
      gesture.setStatus(gesture.reasons[reason]);
      return;
    }
    if (!movable) return;
    // Read again so a menu left open cannot overwrite a more recent date edit.
    row = session.cachedRecord(table.id, row.id) ?? row;
    const previous = cellValue(row, start);
    const from = eventDay(previous, start, format);
    if (!from || (from === day && minutes === undefined)) return;
    const values: Record<string, string> = {
      [start.id]:
        minutes === undefined ? valueOnDay(day, start, format, previous) : atTime(day, minutes, start),
    };
    if (end && end.id !== start.id) {
      const previousEnd = cellValue(row, end);
      const endDay = eventDay(previousEnd, end, format);
      if (endDay)
        values[end.id] = valueOnDay(addDays(endDay, daysBetween(from, day)), end, format, previousEnd);
    }
    if (minutes !== undefined && end && dateOptions(end)?.includeTime && typeof previous === 'string') {
      const previousEnd = cellValue(row, end);
      if (typeof previousEnd === 'string' && Number.isFinite(Date.parse(previousEnd)))
        values[end.id] = new Date(
          Date.parse(previousEnd) + Date.parse(values[start.id]!) - Date.parse(previous),
        ).toISOString();
    }
    commit(row, values);
  }

  function atTime(day: string, minutes: number, field: FieldMeta): string {
    const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    const parsed = parseText(field, `${day}T${time}`, format);
    if (parsed.ok !== true || typeof parsed.value !== 'string') throw new Error('Invalid calendar time');
    return parsed.value;
  }

  function commit(row: RowData, values: Record<string, string>) {
    const reason = dropRefusal(
      props,
      row,
      fields.filter((field) => field.id in values),
    );
    if (reason) {
      gesture.setStatus(gesture.reasons[reason]);
      return;
    }
    try {
      const focusedChip = document.activeElement?.closest<HTMLElement>('[data-calendar-record]');
      session.run([{ kind: 'record.update', tableId: table.id, records: [{ id: row.id, values }] }]);
      if (focusedChip?.dataset.calendarRecord === row.id) {
        const day = eventDay(values[start.id] ?? cellValue(row, start), start, format);
        if (day) {
          pendingFocus.current = { id: row.id, day };
          setFocused(day);
          if (!days.includes(day)) changeAnchor(day);
        }
      }
      gesture.setStatus(t({ id: 'calendar.datesSaved', message: 'Event dates saved.' }));
    } catch (error) {
      reportError(error);
    }
  }

  function adjustedValues(row: RowData, change: 'move' | 'start' | 'end', minutes: number, exact?: string) {
    row = session.cachedRecord(table.id, row.id) ?? row;
    const changed = change === 'end' ? end : start;
    if (!changed) return;
    const previous = cellValue(row, changed);
    if (typeof previous !== 'string' || !Number.isFinite(Date.parse(previous))) return;
    const next = exact ?? new Date(Date.parse(previous) + minutes * 60_000).toISOString();
    const values: Record<string, string> = { [changed.id]: next };
    if (change === 'move' && end && end.id !== start.id) {
      const last = cellValue(row, end);
      if (typeof last === 'string' && Number.isFinite(Date.parse(last)))
        values[end.id] = new Date(Date.parse(last) + Date.parse(next) - Date.parse(previous)).toISOString();
    }
    return values;
  }

  function resizeRefusal(row: RowData, values: Record<string, string>): string | null {
    row = session.cachedRecord(table.id, row.id) ?? row;
    const from = values[start.id] ?? cellValue(row, start);
    const to = end ? (values[end.id] ?? cellValue(row, end)) : null;
    return typeof from === 'string' && typeof to === 'string' && Date.parse(to) < Date.parse(from)
      ? t({ id: 'calendar.endBeforeStart', message: 'The end must be on or after the start.' })
      : null;
  }

  function adjust(row: RowData, change: 'move' | 'start' | 'end', minutes: number, exact?: string) {
    const values = adjustedValues(row, change, minutes, exact);
    if (!values) return;
    const reason = resizeRefusal(row, values);
    if (reason) {
      gesture.setStatus(reason);
      return;
    }
    commit(row, values);
  }

  function startDrag(
    event: PointerEvent,
    row: RowData,
    grabbedDay: string,
    change: 'move' | 'start' | 'end' = 'move',
  ) {
    if (props.readOnly) return;
    let pageAnchor = anchor;
    let pageDirection = '';
    let pageTimer: ReturnType<typeof setTimeout> | undefined;
    const turnPage = () => {
      if (!pageDirection) return;
      pageAnchor = adjacentRange(pageAnchor, range, Number(pageDirection));
      changeAnchor(pageAnchor);
      pageTimer = setTimeout(turnPage, 700);
    };
    const changedFields =
      change === 'move' ? [start, ...(end ? [end] : [])] : change === 'start' ? [start] : end ? [end] : [];
    const locate = (point: DragPoint) => {
      const node = document.elementFromPoint(point.clientX, point.clientY);
      const target = node?.closest<HTMLElement>('[data-calendar-day]');
      const slot = node?.closest<HTMLElement>('[data-calendar-minute]');
      return target && root.current?.contains(target)
        ? {
            node: slot ?? target,
            day: target.dataset.calendarDay!,
            minutes: slot ? Number(slot.dataset.calendarMinute) : undefined,
          }
        : null;
    };
    const resizeValues = (target: NonNullable<ReturnType<typeof locate>>) => {
      const field = change === 'start' ? start : end;
      if (!field) return;
      return adjustedValues(
        row,
        change,
        0,
        target.minutes === undefined
          ? valueOnDay(
              target.day,
              field,
              format,
              cellValue(session.cachedRecord(table.id, row.id) ?? row, field),
            )
          : atTime(target.day, target.minutes, field),
      );
    };
    gesture.start(event, {
      // The calendar first, from the outside in: a week of stacked days is taller than a phone, so
      // near its own top and bottom edges a drag has to reach the days off screen and the Previous
      // and Next buttons, even where a day's time targets cover them.  Between those edges the
      // targets scroll through the day's half hours instead.
      scroll: (point) => [
        root.current,
        document
          .elementFromPoint(point.clientX, point.clientY)
          ?.closest<HTMLElement>('.rio-calendar-view__times'),
      ],
      move(point) {
        const node = document.elementFromPoint(point.clientX, point.clientY);
        const page = node?.closest<HTMLElement>('[data-calendar-page]')?.dataset.calendarPage ?? '';
        if (page !== pageDirection) {
          clearTimeout(pageTimer);
          pageDirection = page;
          if (page) pageTimer = setTimeout(turnPage, 700);
        }
        const target = locate(point);
        const reason = dropRefusal(props, row, changedFields);
        const values = target && change !== 'move' ? resizeValues(target) : undefined;
        const refusal = reason ? gesture.reasons[reason] : values ? resizeRefusal(row, values) : null;
        const date = target ? fullDate(target.day) : '';
        gesture.mark(
          target?.node ?? null,
          refusal
            ? refusal
            : target
              ? t({ id: 'calendar.dropDate', message: `Release on ${date}` })
              : t({
                  id: 'calendar.dragAcross',
                  message: 'Hold over Previous or Next to change the calendar range.',
                }),
          !!refusal,
        );
      },
      drop(point) {
        const target = locate(point);
        if (!target || dropRefusal(props, row, changedFields)) return;
        if (change === 'move') {
          const current = session.cachedRecord(table.id, row.id) ?? row;
          const from = eventDay(cellValue(current, start), start, format);
          if (from) move(row, addDays(from, daysBetween(grabbedDay, target.day)), target.minutes);
        } else {
          const values = resizeValues(target);
          if (!values) return;
          const reason = resizeRefusal(row, values);
          if (reason) gesture.setStatus(reason);
          else commit(row, values);
        }
      },
      finish() {
        clearTimeout(pageTimer);
      },
    });
  }

  function add(day: string) {
    if (!writable || table.source || table.joined) return;
    const id = newId('record');
    session.run([
      {
        kind: 'record.create',
        tableId: table.id,
        records: [
          {
            id,
            values: {
              [start.id]: valueOnDay(day, start, format),
            },
          },
        ],
      },
    ]);
    onExpand(id);
  }

  function list(day: string) {
    popoverAnchor.current = dayNodes.current.get(day) ?? null;
    setListedDay(day);
  }

  function navigate(event: KeyboardEvent<HTMLDivElement>, day: string) {
    if (event.target !== event.currentTarget) return;
    const index = days.indexOf(day);
    const stride = range === 'month' ? 7 : 1;
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const offsets: Record<string, number> = {
      ArrowRight: rtl ? -1 : 1,
      ArrowLeft: rtl ? 1 : -1,
      ArrowDown: stride,
      ArrowUp: -stride,
    };
    const offset = offsets[event.key];
    if (offset !== undefined) {
      event.preventDefault();
      const next = days[Math.max(0, Math.min(days.length - 1, index + offset))]!;
      setFocused(next);
      dayNodes.current.get(next)?.focus();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (events.get(day)?.length) list(day);
      else add(day);
    }
  }

  function chip(row: RowData, grabbedDay: string) {
    const title =
      (primary && formatCell(primary, cellValue(row, primary), format)) ||
      t({ id: 'calendar.untitled', message: 'Untitled record' });
    const value = cellValue(row, start);
    const options = dateOptions(start);
    const time =
      options?.includeTime &&
      typeof value === 'string' &&
      value.includes('T') &&
      Number.isFinite(Date.parse(value))
        ? new Intl.DateTimeFormat(format.locale, {
            timeStyle: 'short',
            timeZone: zoneOf(start, format),
            ...(options.timeFormat === '12h'
              ? ({ hourCycle: 'h12' } as const)
              : options.timeFormat === '24h'
                ? ({ hourCycle: 'h23' } as const)
                : {}),
          }).format(new Date(value))
        : '';
    return (
      <div className="rio-calendar-view__event" key={row.id}>
        <button
          type="button"
          className="rio-calendar-view__chip"
          title={title}
          draggable={false}
          data-calendar-record={row.id}
          onPointerDown={(event) => startDrag(event, row, grabbedDay)}
          aria-keyshortcuts={
            props.readOnly
              ? undefined
              : 'Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown Alt+Shift+ArrowUp Alt+Shift+ArrowDown'
          }
          aria-description={
            props.readOnly
              ? undefined
              : t({
                  id: 'calendar.dragKeys',
                  message: `${moveLeft} or ${moveRight} moves by a day.  ${moveUp} or ${moveDown} moves by 30 minutes.  ${endUp} or ${endDown} changes the end time.  Escape cancels a drag.`,
                })
          }
          onKeyDown={(event) => {
            if (props.readOnly || !event.altKey) return;
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault();
              const from = eventDay(cellValue(row, start), start, format);
              if (from) move(row, addDays(from, event.key === 'ArrowLeft' ? -1 : 1));
            } else if (
              dateOptions(start)?.includeTime &&
              (event.key === 'ArrowUp' || event.key === 'ArrowDown')
            ) {
              event.preventDefault();
              adjust(row, event.shiftKey ? 'end' : 'move', event.key === 'ArrowUp' ? -30 : 30);
            }
          }}
          onClick={() => {
            if (!gesture.suppressClick.current) onExpand(row.id);
          }}
        >
          {time && <time dateTime={typeof value === 'string' ? value : undefined}>{time} </time>}
          {title}
        </button>
        {!props.readOnly && dateOptions(start)?.includeTime && end && dateOptions(end)?.includeTime && (
          <button
            type="button"
            className="rio-calendar-view__resize"
            aria-label={t({ id: 'calendar.resizeEnd', message: `Resize end of ${title}` })}
            title={t({ id: 'calendar.resizeEnd', message: `Resize end of ${title}` })}
            onPointerDown={(event) => startDrag(event, row, grabbedDay, 'end')}
            onClick={(event) => event.preventDefault()}
            onKeyDown={(event) => {
              if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                event.preventDefault();
                adjust(row, 'end', event.key === 'ArrowUp' ? -30 : 30);
              }
            }}
          >
            <Icon icon={faArrowsUpDown} />
          </button>
        )}
        {movable && (
          <MenuTrigger>
            <Button
              size="sm"
              variant="quiet"
              aria-label={t({ id: 'calendar.actions', message: `Actions for ${title}` })}
              icon={faEllipsis}
            />
            <Menu aria-label={title}>
              <MenuItem
                icon={faArrowUp}
                onAction={() => {
                  if (dateOptions(start)?.includeTime) adjust(row, 'move', -30);
                  else {
                    const day = eventDay(cellValue(row, start), start, format);
                    if (day) move(row, addDays(day, -1));
                  }
                }}
              >
                {t({ id: 'sortable.menu.up', message: 'Move up' })}
              </MenuItem>
              <MenuItem
                icon={faArrowDown}
                onAction={() => {
                  if (dateOptions(start)?.includeTime) adjust(row, 'move', 30);
                  else {
                    const day = eventDay(cellValue(row, start), start, format);
                    if (day) move(row, addDays(day, 1));
                  }
                }}
              >
                {t({ id: 'sortable.menu.down', message: 'Move down' })}
              </MenuItem>
              <MenuItem
                icon={faArrowRight}
                onAction={() => {
                  setDestination(eventDay(cellValue(row, start), start, format));
                  setMoving(row);
                }}
              >
                {moveLabel}
              </MenuItem>
            </Menu>
          </MenuTrigger>
        )}
      </div>
    );
  }

  const heading =
    range === 'month'
      ? new Intl.DateTimeFormat(format.locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
          new Date(`${anchor}T12:00:00Z`),
        )
      : new Intl.DateTimeFormat(format.locale, { dateStyle: 'medium', timeZone: 'UTC' }).formatRange(
          new Date(`${days[0]}T12:00:00Z`),
          new Date(`${days[6]}T12:00:00Z`),
        );
  const tabDay = days.includes(focused) ? focused : days[0];
  function dayCell(day: string) {
    const records = events.get(day)!;
    const count = Math.max(0, records.length - VISIBLE_EVENTS);
    const date = fullDate(day);
    return (
      <div
        key={day}
        data-calendar-day={day}
        role="gridcell"
        aria-description={label(day)}
        tabIndex={day === tabDay ? 0 : -1}
        ref={(node) => {
          if (node) dayNodes.current.set(day, node);
          else dayNodes.current.delete(day);
        }}
        className="rio-calendar-view__day"
        data-outside={day.slice(0, 7) !== anchor.slice(0, 7) || undefined}
        aria-current={day === today() ? 'date' : undefined}
        onFocus={() => setFocused(day)}
        onKeyDown={(event) => navigate(event, day)}
      >
        <div className="rio-calendar-view__day-heading">
          <time dateTime={day} title={date}>
            {range === 'week' ? (
              date
            ) : (
              <>
                <span className="rio-calendar-view__day-number">{Number(day.slice(-2))}</span>
                <span className="rio-calendar-view__day-date">{date}</span>
              </>
            )}
          </time>
          {writable && !(table.source || table.joined) && (
            <Button
              icon={faPlus}
              className="rio-calendar-view__add"
              size="sm"
              variant="quiet"
              aria-label={t({ id: 'calendar.add', message: `Add a record on ${date}` })}
              onPress={() => add(day)}
            />
          )}
        </div>
        <div className="rio-calendar-view__events">
          {records.slice(0, VISIBLE_EVENTS).map((row) => chip(row, day))}
        </div>
        {gesture.active && range === 'week' && dateOptions(start)?.includeTime && (
          <div
            className="rio-calendar-view__times"
            tabIndex={0}
            role="group"
            aria-label={t({ id: 'calendar.timeTargets', message: 'Time drop targets' })}
          >
            {Array.from({ length: 48 }, (_, index) => {
              const minutes = index * 30;
              const time = new Intl.DateTimeFormat(format.locale, {
                hour: 'numeric',
                minute: '2-digit',
                timeZone: 'UTC',
              }).format(new Date(Date.UTC(2000, 0, 1, Math.floor(minutes / 60), minutes % 60)));
              return (
                <div key={minutes} data-calendar-minute={minutes}>
                  {time}
                </div>
              );
            })}
          </div>
        )}
        <div className="rio-calendar-view__overflow">
          {count > 0 && (
            <Button variant="quiet" size="sm" onPress={() => list(day)}>
              {t({ id: 'calendar.more', message: `+${count} more` })}
            </Button>
          )}
        </div>
      </div>
    );
  }
  return (
    <div
      className="rio-calendar-view"
      ref={root}
      onClickCapture={(event) => {
        if (gesture.suppressClick.current) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      {gesture.feedback}
      <div className="rio-view-drag-announcement" role="status">
        {gesture.announcement}
      </div>
      <div className="rio-calendar-view__navigation">
        <Button onPress={() => changeAnchor(today())}>{t({ id: 'calendar.today', message: 'Today' })}</Button>
        <Button
          data-calendar-page="-1"
          icon={faChevronLeft}
          aria-label={t({ id: 'calendar.previous', message: 'Previous' })}
          onPress={() => changeAnchor(adjacentRange(anchor, range, -1))}
        />
        <h2 aria-live="polite">{heading}</h2>
        <Button
          data-calendar-page="1"
          icon={faChevronRight}
          aria-label={t({ id: 'calendar.next', message: 'Next' })}
          onPress={() => changeAnchor(adjacentRange(anchor, range, 1))}
        />
      </div>
      <div
        role="grid"
        aria-label={heading}
        className="rio-calendar-view__grid"
        data-range={range}
        data-timed={dateOptions(start)?.includeTime || undefined}
      >
        {range === 'month' && (
          <div role="row" className="rio-calendar-view__weekdays">
            {days.slice(0, 7).map((day) => (
              <div role="columnheader" key={day}>
                {new Intl.DateTimeFormat(format.locale, { weekday: 'short', timeZone: 'UTC' }).format(
                  new Date(`${day}T12:00:00Z`),
                )}
              </div>
            ))}
          </div>
        )}
        {Array.from({ length: range === 'month' ? 6 : 7 }, (_, index) => (
          <div role="row" className="rio-calendar-view__row" key={index}>
            {days
              .slice(index * (range === 'month' ? 7 : 1), (index + 1) * (range === 'month' ? 7 : 1))
              .map(dayCell)}
          </div>
        ))}
      </div>
      <Popover
        isOpen={listedDay !== null}
        onOpenChange={(open) => {
          if (!open) setListedDay(null);
        }}
        triggerRef={popoverAnchor}
        placement="bottom start"
      >
        <Dialog aria-label={listedDay ? label(listedDay) : undefined} className="rio-calendar-view__list">
          {listedDay && (events.get(listedDay) ?? []).map((row) => chip(row, listedDay))}
        </Dialog>
      </Popover>
      <Modal
        isOpen={moving !== null}
        onOpenChange={(open) => {
          if (!open) setMoving(null);
        }}
        isDismissable
        size="sm"
      >
        <Dialog aria-label={moveLabel} className="rio-calendar-view__move">
          <DatePicker label={moveLabel} value={destination} onChange={setDestination} />
          <Button
            isDisabled={!destination}
            onPress={() => {
              if (moving && destination) move(moving, destination);
              setMoving(null);
            }}
          >
            {moveLabel}
          </Button>
          <Button variant="quiet" onPress={() => setMoving(null)}>
            {t({ id: 'calendar.cancel', message: 'Cancel' })}
          </Button>
        </Dialog>
      </Modal>
    </div>
  );
}
