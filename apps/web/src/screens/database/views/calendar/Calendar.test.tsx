import { useState } from 'react';
import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldMeta, GridConfig, newId, type CellValue } from '@riosoma/contracts';
import { toast } from '@riosoma/ui';
import { openDatabase } from '../../../../data/session';
import { FakeServer } from '../../../../data/testing';
import type { DatabaseSession } from '../../../../data/types';
import type { ViewComponentProps } from '../types';
import { CalendarSettings, CalendarView } from './index';
import { addDays, eventDay, firstWeekday, valueOnDay, visibleDays } from './dates';

const sessions: DatabaseSession[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-27T18:00:00Z'));
});
afterEach(() => {
  cleanup();
  sessions.splice(0).forEach((session) => session.close());
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function settle() {
  await act(async () => {
    for (let index = 0; index < 100; index++) await Promise.resolve();
  });
}
const format = { locale: 'en-US', timeZone: 'America/Los_Angeles', collaborators: new Map() };

async function mount(
  options: {
    locale?: string;
    range?: 'month' | 'week';
    timed?: boolean;
    zone?: string;
    count?: number;
    start?: string;
    end?: string;
    sameEnd?: boolean;
    empty?: boolean;
    canEdit?: boolean;
    readOnly?: boolean;
    type?: 'date' | 'createdTime' | 'lastModifiedTime' | 'formula';
    /** For a formula start: whether the database computes it */
    sortable?: boolean;
  } = {},
) {
  const server = new FakeServer();
  const fixture = server.createDatabase(0);
  const schema = server.database(fixture.databaseId).schema;
  const start = FieldMeta.parse({
    ...schema.fields[0],
    id: newId('field'),
    name: 'Scheduled',
    type: options.type ?? 'date',
    options:
      options.type === 'formula'
        ? { resultType: 'date', expression: 'TODAY()', sortable: options.sortable ?? true }
        : { includeTime: options.timed ?? false, timeZone: options.zone ?? 'America/Los_Angeles' },
  });
  const end = FieldMeta.parse({
    ...start,
    id: newId('field'),
    name: 'Ends',
    type: 'date',
    options: { includeTime: options.timed ?? false, timeZone: options.zone ?? 'America/Los_Angeles' },
  });
  const view = {
    ...schema.views[0]!,
    type: 'calendar' as const,
    config: GridConfig.parse({
      calendar: {
        startFieldId: options.empty ? null : start.id,
        endFieldId: options.sameEnd ? start.id : options.end ? end.id : null,
        range: options.range ?? 'month',
      },
    }),
  };
  server.seed(
    { ...schema, fields: [...schema.fields, start, end], views: [view] },
    new Map([
      [
        fixture.tableId,
        {
          count: options.count ?? 1,
          values: (index: number): Record<string, CellValue> => ({
            [fixture.textFieldId]: `Event ${index + 1}`,
            [start.id]: options.start ?? '2026-09-27',
            ...(options.end ? { [end.id]: options.end } : {}),
          }),
        },
      ],
    ]),
  );
  const session = await openDatabase(fixture.databaseId, server.deps());
  // A viewer can neither change the view nor edit records.
  if (options.canEdit === false) vi.spyOn(session, 'role').mockReturnValue('reader');
  sessions.push(session);
  const onExpand = vi.fn();
  const onConfig = vi.fn();
  const run = vi.spyOn(session, 'run');
  const open = vi.spyOn(session, 'openView');
  function Harness() {
    const [config, setConfig] = useState(view.config);
    const props: ViewComponentProps = {
      session,
      table: schema.tables[0]!,
      fields: [...schema.fields, start, end],
      view: { ...view, config },
      format: { ...format, locale: options.locale ?? 'en-US' },
      canEdit: options.canEdit ?? true,
      readOnly: options.readOnly,
      onExpand,
      onConfig: (patch) => {
        onConfig(patch);
        setConfig((current) => ({ ...current, ...patch }));
      },
    };
    return (
      <>
        <CalendarSettings {...props} />
        <CalendarView {...props} />
      </>
    );
  }
  render(
    <I18nProvider
      i18n={setupI18n({ locale: options.locale ?? 'en-US', messages: { [options.locale ?? 'en-US']: {} } })}
    >
      <Harness />
    </I18nProvider>,
  );
  await settle();
  return { server, fixture, session, run, open, start, end, onExpand, onConfig };
}
function day(date: string) {
  return screen.getAllByRole('gridcell').find((node) => node.querySelector('time')?.dateTime === date)!;
}
function drag(source: Element, target: Element) {
  const hit = vi.spyOn(document, 'elementFromPoint').mockReturnValue(target);
  fireEvent.pointerDown(source, {
    button: 0,
    buttons: 1,
    pointerId: 1,
    pointerType: 'mouse',
    clientX: 20,
    clientY: 20,
  });
  fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, clientX: 80, clientY: 32 });
  fireEvent.pointerUp(window, { pointerId: 1, clientX: 80, clientY: 32 });
  hit.mockRestore();
}

describe('calendar ranges and accessibility', () => {
  it('marks an invalid timed resize before release and never changes the record', async () => {
    const { run } = await mount({ timed: true, start: '2026-09-27T17:00:00Z', end: '2026-09-27T18:00:00Z' });
    const target = day('2026-09-26');
    const hit = vi.spyOn(document, 'elementFromPoint').mockReturnValue(target);
    try {
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Resize end of Event 1' }), {
        button: 0,
        pointerId: 1,
        clientX: 80,
        clientY: 80,
      });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 80, clientY: 32 });
      expect(target.dataset.rioDrop).toBe('refused');
      expect(target.dataset.rioDropReason).toBe('The end must be on or after the start.');
      expect(run).not.toHaveBeenCalled();
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 80, clientY: 32 });
      expect(run).not.toHaveBeenCalled();
      expect(screen.getByRole('status').textContent).toBe('The end must be on or after the start.');
    } finally {
      hit.mockRestore();
    }
  });

  it.each([
    ['en-US', 'month', '2026-08-30', '2026-10-10', 42],
    ['en-GB', 'month', '2026-08-31', '2026-10-11', 42],
    ['en-US', 'week', '2026-09-27', '2026-10-03', 7],
    ['en-GB', 'week', '2026-09-21', '2026-09-27', 7],
  ] as const)('%s %s opens the visible range', async (locale, range, from, to, count) => {
    const { open, fixture, server } = await mount({ locale, range });
    expect(screen.getAllByRole('gridcell')).toHaveLength(count);
    expect(screen.getAllByRole('row')).toHaveLength(7);
    expect(open).toHaveBeenCalledWith(fixture.viewId, { from, to });
    expect(
      server.requests.some(
        (request) => request.path.includes(`from=${from}`) && request.path.includes(`to=${to}`),
      ),
    ).toBe(true);
    expect(day(from)).toBe(screen.getAllByRole('gridcell')[0]);
  });
  it('reopens ranges on navigation and Today, and closes released rows', async () => {
    const { session, open } = await mount();
    const rows = open.mock.results[0]!.value as ReturnType<DatabaseSession['openView']>;
    const close = vi.spyOn(rows, 'close');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await settle();
    expect(open).toHaveBeenLastCalledWith(expect.any(String), { from: '2026-09-27', to: '2026-11-07' });
    expect(close).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await settle();
    expect(screen.getByRole('heading').textContent).toBe('September 2026');
    await userEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await userEvent.click(screen.getByRole('button', { name: 'Today' }));
    await settle();
    expect(screen.getByRole('heading').textContent).toBe('September 2026');
    expect(session.canUndo()).toBe(false);
  });
  it('navigates days by arrows and opens the day list with Enter', async () => {
    await mount();
    day('2026-09-26').focus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(day('2026-09-27'));
    expect(day('2026-09-27').getAttribute('aria-description')).toBe('Sunday, September 27, 2026, 1 record');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(day('2026-09-20'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(screen.getByRole('dialog', { name: 'Sunday, September 27, 2026, 1 record' })).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('calendar records', () => {
  it('treats the same start and end field as a point event without a resize action', async () => {
    const { run, start } = await mount({ timed: true, sameEnd: true, start: '2026-09-27T17:00:00Z' });
    expect(screen.queryByRole('button', { name: 'Resize end of Event 1' })).toBeNull();
    const chip = document.querySelector('.rio-calendar-view__chip')!;
    fireEvent.keyDown(chip, { key: 'ArrowDown', altKey: true, shiftKey: true });
    expect(run).not.toHaveBeenCalled();
    fireEvent.keyDown(chip, { key: 'ArrowDown', altKey: true });
    expect(run.mock.calls[0]?.[0][0]).toMatchObject({
      records: [{ values: { [start.id]: '2026-09-27T17:30:00.000Z' } }],
    });
  });

  it('draws inclusive spans, opens records, and lists overflow', async () => {
    const { onExpand } = await mount({ count: 5, start: '2026-09-26', end: '2026-09-28' });
    for (const date of ['2026-09-26', '2026-09-27', '2026-09-28']) {
      expect(within(day(date)).getByRole('button', { name: 'Event 1' })).toBeTruthy();
      expect(within(day(date)).getByRole('button', { name: '+2 more' })).toBeTruthy();
    }
    expect(within(day('2026-09-29')).queryByRole('button', { name: 'Event 1' })).toBeNull();
    await userEvent.click(within(day('2026-09-27')).getByRole('button', { name: '+2 more' }));
    const list = screen.getByRole('dialog');
    expect(within(list).getByRole('button', { name: 'Event 5' })).toBeTruthy();
    within(list).getByRole('button', { name: 'Event 5' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(onExpand).toHaveBeenCalledTimes(1);
  });
  it('moves date-only spans immediately, sends one command, and supports undo', async () => {
    const { run, start, end, session } = await mount({ start: '2026-09-26', end: '2026-09-28' });
    drag(within(day('2026-09-26')).getByRole('button', { name: 'Event 1' }), day('2026-09-29'));
    expect(run).toHaveBeenLastCalledWith([
      {
        kind: 'record.update',
        tableId: expect.any(String),
        records: [{ id: expect.any(String), values: { [start.id]: '2026-09-29', [end.id]: '2026-10-01' } }],
      },
    ]);
    expect(within(day('2026-09-29')).getByRole('button', { name: 'Event 1' })).toBeTruthy();
    expect(within(day('2026-09-26')).queryByRole('button', { name: 'Event 1' })).toBeNull();
    await settle();
    await act(async () => {
      await session.undo();
    });
    await settle();
    expect(within(day('2026-09-26')).getByRole('button', { name: 'Event 1' })).toBeTruthy();
  });
  it('uses the field zone for timed chips and preserves start and end clocks', async () => {
    const { run, start, end } = await mount({
      timed: true,
      start: '2026-09-28T01:30:15.123Z',
      end: '2026-09-29T03:45:00.000Z',
    });
    const chip = within(day('2026-09-27')).getByRole('button', { name: /6:30 PM Event 1/ });
    drag(chip, day('2026-09-29'));
    expect(run.mock.calls[0]![0][0]).toMatchObject({
      records: [{ values: { [start.id]: '2026-09-30T01:30:15.123Z', [end.id]: '2026-10-01T03:45:00.000Z' } }],
    });
  });
  it.each([false, true])('moves through the keyboard menu and date picker (time: %s)', async (timed) => {
    const { run, start } = await mount({ timed, start: timed ? '2026-09-28T01:30:15.123Z' : '2026-09-27' });
    const user = userEvent.setup();
    screen.getByRole('button', { name: 'Actions for Event 1' }).focus();
    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('menuitem', { name: 'Move to…' }));
    const dialog = screen.getByRole('dialog', { name: 'Move to…' });
    const segment = within(dialog).getByRole('spinbutton', { name: /day/i });
    segment.focus();
    await user.keyboard('{ArrowUp}');
    await user.click(within(dialog).getByRole('button', { name: 'Move to…' }));
    expect(run.mock.calls[0]![0][0]).toMatchObject({
      kind: 'record.update',
      records: [{ values: { [start.id]: timed ? '2026-09-29T01:30:15.123Z' : '2026-09-28' } }],
    });
  });
  it.each([false, true])('creates a record and opens it (time: %s)', async (timed) => {
    const { run, start, onExpand } = await mount({ timed, count: 0 });
    await userEvent.click(
      within(day('2026-09-28')).getByRole('button', { name: 'Add a record on Monday, September 28, 2026' }),
    );
    const command = run.mock.calls[0]![0][0];
    expect(command).toMatchObject({
      kind: 'record.create',
      records: [{ values: { [start.id]: timed ? '2026-09-28T16:00:00.000Z' : '2026-09-28' } }],
    });
    if (command?.kind === 'record.create') expect(onExpand).toHaveBeenCalledWith(command.records[0]!.id);
  });
  it('rolls back rejected moves through the session', async () => {
    const { server } = await mount();
    server.rejectNext();
    drag(screen.getByRole('button', { name: 'Event 1' }), day('2026-09-29'));
    expect(within(day('2026-09-29')).getByRole('button', { name: 'Event 1' })).toBeTruthy();
    await settle();
    expect(within(day('2026-09-27')).getByRole('button', { name: 'Event 1' })).toBeTruthy();
    expect(within(day('2026-09-29')).queryByRole('button', { name: 'Event 1' })).toBeNull();
  });
  it('includes spans that start before the visible range', async () => {
    await mount({ start: '2026-08-29', end: '2026-09-01' });
    expect(within(day('2026-08-30')).getByRole('button', { name: 'Event 1' })).toBeTruthy();
    expect(within(day('2026-09-01')).getByRole('button', { name: 'Event 1' })).toBeTruthy();
    expect(within(day('2026-09-02')).queryByRole('button', { name: 'Event 1' })).toBeNull();
  });
  it('adds on Enter in an empty day and uses daily arrows in week mode', async () => {
    const { run, start } = await mount({ count: 0, range: 'week' });
    day('2026-09-27').focus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(day('2026-09-28'));
    expect(document.activeElement?.getAttribute('aria-description')).toBe(
      'Monday, September 28, 2026, no records',
    );
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(run.mock.calls[0]![0][0]).toMatchObject({
      kind: 'record.create',
      records: [{ values: { [start.id]: '2026-09-28' } }],
    });
  });
  it('loads records beyond the first page', async () => {
    await mount({ count: 205 });
    expect(day('2026-09-27').getAttribute('aria-description')).toContain('205 records');
    await userEvent.click(screen.getByRole('button', { name: '+202 more' }));
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Event 205' })).toBeTruthy();
  });
});

describe('calendar settings and dates', () => {
  it('offers the empty-state picker and persists settings without discarding other choices', async () => {
    const { start, end, onConfig } = await mount({ empty: true });
    expect(screen.queryByRole('grid')).toBeNull();
    fireEvent.change(screen.getAllByRole('combobox', { name: 'Start date' })[0]!, {
      target: { value: start.id },
    });
    await settle();
    expect(screen.getByRole('grid')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Calendar settings' }));
    await settle();
    fireEvent.change(screen.getByRole('combobox', { name: 'End date' }), { target: { value: end.id } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Calendar range' }), { target: { value: 'week' } });
    await settle();
    expect(onConfig).toHaveBeenLastCalledWith({
      calendar: { startFieldId: start.id, endFieldId: end.id, range: 'week' },
    });
    expect(screen.getAllByRole('gridcell')).toHaveLength(7);
    fireEvent.change(screen.getByRole('combobox', { name: 'End date' }), { target: { value: '' } });
    expect(onConfig).toHaveBeenLastCalledWith({
      calendar: { startFieldId: start.id, endFieldId: null, range: 'week' },
    });
  });
  it.each(['createdTime', 'lastModifiedTime', 'formula'] as const)(
    'accepts %s as a read-only start',
    async (type) => {
      await mount({ type });
      expect(screen.getByRole('grid')).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Add a record/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /Actions for/ })).toBeNull();
    },
  );
  it('leaves out a date formula the database can’t compute, and says why', async () => {
    await mount({ type: 'formula', sortable: false });
    // The view's start can't place records, so the calendar asks for another.
    expect(screen.queryByRole('grid')).toBeNull();
    const picker = screen.getAllByRole('combobox', { name: 'Start date' })[0]!;
    expect(within(picker).queryByRole('option', { name: 'Scheduled' })).toBeNull();
    expect(
      screen.getByText(
        // The text's two spaces between sentences read as one here.
        'Scheduled isn’t offered. It’s a date formula that can’t be sorted or filtered, so it can’t place records here.',
      ),
    ).toBeTruthy();
  });
  it('disables mutation controls for viewers', async () => {
    await mount({ canEdit: false });
    expect(screen.queryByRole('button', { name: /Add a record/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Event 1' }).getAttribute('draggable')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Calendar settings' }));
    await settle();
    expect(screen.getByRole('combobox', { name: 'Start date' }).hasAttribute('disabled')).toBe(true);
  });
  it('keeps wall clocks across DST and honors client zones and date-only values', async () => {
    const { start } = await mount({ timed: true, zone: 'client' });
    expect(valueOnDay('2026-03-08', start, format, '2026-03-07T17:30:12.345Z')).toBe(
      '2026-03-08T16:30:12.345Z',
    );
    expect(valueOnDay('2026-11-01', start, format, '2026-10-31T16:30:12.345Z')).toBe(
      '2026-11-01T17:30:12.345Z',
    );
    expect(eventDay('2026-09-28T01:00:00Z', start, format)).toBe('2026-09-27');
    expect(eventDay('2026-09-28', start, format)).toBe('2026-09-28');
    expect(eventDay('broken', start, format)).toBeNull();
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(firstWeekday('en-US')).toBe(0);
    expect(firstWeekday('en-GB')).toBe(1);
    expect(visibleDays('2026-09-27', 'week', 'en-GB')[0]).toBe('2026-09-21');
  });
});

describe('calendar pointer regressions', () => {
  it('scrolls the week itself near its own edges while a drag is over a day’s time targets', async () => {
    await mount({ range: 'week', timed: true, start: '2026-09-27T17:00:00Z' });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-27T18:00:00Z'));
    const box = (top: number, bottom: number) => ({ left: 0, top, right: 400, bottom }) as DOMRect;
    const calendar = document.querySelector<HTMLElement>('.rio-calendar-view')!;
    const chip = document.querySelector<HTMLElement>('.rio-calendar-view__chip')!;
    fireEvent.pointerDown(chip, { button: 0, pointerId: 1, clientX: 200, clientY: 300 });
    fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 200, clientY: 570 });
    const times = within(day('2026-09-27')).getByRole('group', { name: 'Time drop targets' });
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(times.querySelector('[data-calendar-minute]')!);
    // The pointer is inside the calendar's bottom edge band and in the middle of the day's time
    // targets, which is where a phone leaves most of a dragged week.
    vi.spyOn(calendar, 'getBoundingClientRect').mockReturnValue(box(0, 600));
    vi.spyOn(times, 'getBoundingClientRect').mockReturnValue(box(100, 620));
    act(() => vi.advanceTimersByTime(32));
    expect(calendar.scrollTop).toBeGreaterThan(0);
    expect(times.scrollTop).toBe(0);
    // Away from the calendar's edges, the day's own half hours scroll instead.
    calendar.scrollTop = 0;
    fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 200, clientY: 120 });
    act(() => vi.advanceTimersByTime(32));
    expect(times.scrollTop).toBeLessThan(0);
    expect(calendar.scrollTop).toBe(0);
    fireEvent.keyDown(window, { key: 'Escape' });
  });

  it('keeps the end clock on the month day under the pointer', async () => {
    const { run, end } = await mount({
      timed: true,
      start: '2026-09-27T17:00:00Z',
      end: '2026-09-27T18:00:00Z',
    });
    drag(screen.getByRole('button', { name: 'Resize end of Event 1' }), day('2026-09-29'));
    expect(run.mock.calls[0]?.[0][0]).toMatchObject({
      records: [{ values: { [end.id]: '2026-09-29T18:00:00.000Z' } }],
    });
  });
  it('moves a span by the offset of the day that was grabbed', async () => {
    const { run, start, end } = await mount({ start: '2026-09-26', end: '2026-09-28' });
    drag(within(day('2026-09-28')).getByRole('button', { name: 'Event 1' }), day('2026-09-29'));
    expect(run.mock.calls[0]?.[0][0]).toMatchObject({
      records: [{ values: { [start.id]: '2026-09-27', [end.id]: '2026-09-29' } }],
    });
  });
  it.each(['2026-09-27', '2026-10-10'])('keeps keyboard focus after moving from %s', async (start) => {
    await mount({ start });
    const chip = screen.getByRole('button', { name: 'Event 1' });
    chip.focus();
    fireEvent.keyDown(chip, { key: 'ArrowRight', altKey: true });
    await settle();
    expect(document.activeElement).toBe(
      within(day(addDays(start, 1))).getByRole('button', { name: 'Event 1' }),
    );
  });
  it('shows the entire timed day only while a gesture is active', async () => {
    await mount({ range: 'week', timed: true, start: '2026-09-27T17:00:00Z' });
    expect(document.querySelector('[data-calendar-minute]')).toBeNull();
    const chip = document.querySelector('.rio-calendar-view__chip')!;
    fireEvent.pointerDown(chip, { button: 0, pointerId: 1, clientX: 20 });
    fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 40 });
    expect(
      within(day('2026-09-27'))
        .getByRole('group', { name: 'Time drop targets' })
        .querySelectorAll('[data-calendar-minute]'),
    ).toHaveLength(48);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.querySelector('[data-calendar-minute]')).toBeNull();
  });
  it('loads destination records while paging during a drag', async () => {
    const { session, fixture, start } = await mount();
    act(() => {
      session.run([
        {
          kind: 'record.create',
          tableId: fixture.tableId,
          records: [
            {
              id: newId('record'),
              values: { [start.id]: '2026-10-20', [fixture.textFieldId]: 'Destination' },
            },
          ],
        },
      ]);
    });
    await settle();
    const hit = vi
      .spyOn(document, 'elementFromPoint')
      .mockReturnValue(screen.getByRole('button', { name: 'Next' }));
    vi.useFakeTimers();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Event 1' }), {
      button: 0,
      pointerId: 1,
      clientX: 20,
    });
    fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 40 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(710);
    });
    await settle();
    expect(within(day('2026-10-20')).getByRole('button', { name: 'Destination' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    hit.mockRestore();
  });
  it('leaves public event gestures and mutation controls out', async () => {
    const { run } = await mount({
      readOnly: true,
      timed: true,
      start: '2026-09-27T17:00:00Z',
      end: '2026-09-27T18:00:00Z',
    });
    drag(document.querySelector('.rio-calendar-view__chip')!, day('2026-09-28'));
    expect(screen.getByRole('status').textContent).toBe('');
    expect(screen.queryByRole('button', { name: 'Resize end of Event 1' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Actions for Event 1' })).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});

describe('calendar focus and paging recovery', () => {
  it('releases fallback focus when the destination chip is hidden', async () => {
    const { session, fixture, start } = await mount({ count: 4 });
    act(() => {
      session.run([
        {
          kind: 'record.update',
          tableId: fixture.tableId,
          records: [{ id: fixture.recordId(3), values: { [start.id]: '2026-09-26' } }],
        },
      ]);
    });
    await settle();
    const chip = screen.getByRole('button', { name: 'Event 4' });
    chip.focus();
    fireEvent.keyDown(chip, { key: 'ArrowRight', altKey: true });
    await settle();
    const more = within(day('2026-09-27')).getByRole('button', { name: '+1 more' });
    expect(document.activeElement).toBe(more);
    act(() => day('2026-09-28').focus());
    expect(document.activeElement).toBe(day('2026-09-28'));
    fireEvent.keyDown(day('2026-09-28'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(day('2026-09-29'));
  });

  it('lets focus leave the destination after the server rejects a move', async () => {
    const { server } = await mount();
    server.rejectNext();
    const chip = screen.getByRole('button', { name: 'Event 1' });
    chip.focus();
    fireEvent.keyDown(chip, { key: 'ArrowRight', altKey: true });
    await settle();
    act(() => day('2026-09-29').focus());
    expect(document.activeElement).toBe(day('2026-09-29'));
    fireEvent.keyDown(day('2026-09-29'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(day('2026-09-30'));
  });

  it('does not request destination focus when the command throws', async () => {
    const { run } = await mount();
    const reported = vi.spyOn(toast, 'show').mockReturnValue('toast');
    run.mockImplementationOnce(() => {
      throw new Error('Move failed');
    });
    const chip = screen.getByRole('button', { name: 'Event 1' });
    chip.focus();
    fireEvent.keyDown(chip, { key: 'ArrowRight', altKey: true });
    act(() => day('2026-09-29').focus());
    expect(document.activeElement).toBe(day('2026-09-29'));
    // The person is told the move failed.  A message that cannot be read would throw inside the
    // handler that was only reporting a failure, and the key press would fail twice over.
    expect(reported).toHaveBeenCalledTimes(1);
    expect(reported.mock.calls[0]![0]).toMatchObject({ tone: 'danger' });
  });

  it('keeps paging while the pointer stays over Next and stops on Escape', async () => {
    await mount();
    const root = document.querySelector('.rio-calendar-view')!;
    for (const key of ['scrollTop', 'scrollLeft'])
      Object.defineProperty(root, key, { get: () => 0, set: () => undefined });
    const hit = vi
      .spyOn(document, 'elementFromPoint')
      .mockReturnValue(screen.getByRole('button', { name: 'Next' }));
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Event 1' }), {
      button: 0,
      pointerId: 1,
      clientX: 20,
    });
    fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 40 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(710);
    });
    expect(screen.getByRole('heading', { name: 'October 2026' })).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(710);
    });
    expect(screen.getByRole('heading', { name: 'November 2026' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(screen.getByRole('heading', { name: 'November 2026' })).toBeTruthy();
    hit.mockRestore();
  });
});

it('includes the visible day and event title in the day name', async () => {
  await mount();
  expect(screen.getByRole('gridcell', { name: /27.*Event 1/ })).toBe(day('2026-09-27'));
});
