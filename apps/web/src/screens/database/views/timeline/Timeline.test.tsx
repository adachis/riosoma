import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FieldMeta,
  GridConfig,
  newId,
  type CellValue,
  type GridConfigPatch,
  type TimelineSettings as Settings,
} from '@riosoma/contracts';
import { useSchema } from '../../../../data/hooks';
import { openDatabase } from '../../../../data/session';
import { FakeServer } from '../../../../data/testing';
import type { DatabaseSession } from '../../../../data/types';
import { useViewConfig } from '../../screen/useViewConfig';
import { VIEW_DEFINITIONS } from '../registry';
import type { ViewComponentProps } from '../types';
import { TimelineSettings, TimelineView } from './index';
import { pack } from './layout';
import { addUnits, cells, dayNumber, dayString, makeAxis, unitStart } from './scale';

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

/** Runs `body` with every element laid out right to left. */
function rightToLeft(body: () => void) {
  const real = window.getComputedStyle.bind(window);
  const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const style = real(element, pseudo);
    return new Proxy(style, {
      get(target, key) {
        if (key === 'direction') return 'rtl';
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
  try {
    body();
  } finally {
    spy.mockRestore();
  }
}

async function settle() {
  await act(async () => {
    for (let index = 0; index < 200; index++) await Promise.resolve();
  });
}

const LINE = 40;
const BAR_TOP = 6;
const choices = {
  design: 'cho00000000000001',
  build: 'cho00000000000002',
  launch: 'cho00000000000003',
};

interface Fields {
  /** Two people who can read the database */
  ada: string;
  grace: string;
  name: string;
  start: string;
  end: string;
  status: string;
  owners: string;
  created: string;
}

interface Options {
  count?: number;
  values?(index: number, fields: Fields): Record<string, CellValue>;
  timeline?: Partial<Settings> | ((fields: Fields) => Partial<Settings>);
  canEdit?: boolean;
  readOnly?: boolean;
  /** Defaults to a reader when the view can't be changed, and the owner otherwise */
  role?: 'reader' | 'editor';
  /** Leaves the table without date fields */
  noDates?: boolean;
  hidden?(fields: Fields): string[];
}

async function mount(options: Options = {}) {
  const server = new FakeServer();
  const fixture = server.createDatabase(0);
  const schema = server.database(fixture.databaseId).schema;
  const base = schema.fields[0]!;
  let position = schema.fields.length;
  const field = (name: string, spec: Record<string, unknown>) =>
    FieldMeta.parse({ ...base, id: newId('field'), name, position: position++, ...spec });
  const start = field('Starts', { type: 'date', options: {} });
  const end = field('Ends', { type: 'date', options: {} });
  const status = field('Status', {
    type: 'singleSelect',
    options: {
      choices: [
        { id: choices.design, name: 'Design', color: 'blue' },
        { id: choices.build, name: 'Build', color: 'green' },
        { id: choices.launch, name: 'Launch', color: 'orange' },
      ],
    },
  });
  const owners = field('Owners', { type: 'user', options: { allowMultiple: true } });
  const created = field('Created', { type: 'createdTime', options: {} });
  const ids: Fields = {
    ada: server.userId,
    grace: server.remoteUserId,
    name: fixture.textFieldId,
    start: start.id,
    end: end.id,
    status: status.id,
    owners: owners.id,
    created: created.id,
  };
  const extra = options.noDates ? [status] : [start, end, status, owners, created];
  const config = GridConfig.parse({
    hiddenFieldIds: options.hidden?.(ids) ?? [fixture.numberFieldId, status.id, owners.id, created.id],
    timeline: {
      startFieldId: options.noDates ? null : start.id,
      endFieldId: options.noDates ? null : end.id,
      zoom: 'day',
      ...(typeof options.timeline === 'function' ? options.timeline(ids) : options.timeline),
    },
  });
  server.seed(
    {
      ...schema,
      fields: [...schema.fields, ...extra],
      views: [{ ...schema.views[0]!, name: 'Plan', type: 'timeline', config }],
      collaborators: [
        { id: server.userId, name: 'Ada', email: 'ada@example.test' },
        { id: server.remoteUserId, name: 'Grace', email: 'grace@example.test' },
      ],
    },
    new Map([
      [
        fixture.tableId,
        {
          count: options.count ?? 1,
          values: (index: number) => ({
            [fixture.textFieldId]: `Task ${index + 1}`,
            [fixture.numberFieldId]: index,
            ...options.values?.(index, ids),
          }),
        },
      ],
    ]),
  );
  const session = await openDatabase(fixture.databaseId, server.deps());
  const role = options.role ?? (options.canEdit === false ? 'reader' : undefined);
  if (role) vi.spyOn(session, 'role').mockReturnValue(role);
  sessions.push(session);
  const onExpand = vi.fn();
  const onConfig = vi.fn<(patch: GridConfigPatch) => void>();
  const run = vi.spyOn(session, 'run');
  function Harness() {
    const current = useSchema(session)!;
    const view = current.viewById.get(fixture.viewId)!;
    const fields = current.fields.get(fixture.tableId)!;
    const { config, change } = useViewConfig(session, view, fields);
    const props: ViewComponentProps = {
      session,
      table: current.tableById.get(fixture.tableId)!,
      view: { ...view, config },
      fields,
      format: {
        locale: 'en-US',
        timeZone: 'America/Los_Angeles',
        collaborators: current.collaborators,
        linked: session.linked,
      },
      canEdit: options.canEdit ?? true,
      readOnly: options.readOnly,
      onConfig: (patch) => {
        onConfig(patch);
        change(patch);
      },
      onExpand,
    };
    return (
      <>
        <TimelineSettings {...props} />
        <TimelineView {...props} />
      </>
    );
  }
  render(
    <I18nProvider i18n={setupI18n({ locale: 'en-US', messages: { 'en-US': {} } })}>
      <Harness />
    </I18nProvider>,
  );
  await settle();
  return { server, fixture, session, run, onExpand, onConfig, ids, start, end };
}

function bar(name: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(`^${name}[ ,]`) });
}
function bars(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.rio-timeline-bar')];
}
function line(element: HTMLElement): number {
  return (parseFloat(element.style.insetBlockStart) - BAR_TOP) / LINE;
}
function range(from: string, to: string): string {
  const format = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
  return format.formatRange(new Date(`${from}T12:00:00Z`), new Date(`${to}T12:00:00Z`));
}
function day(date: string): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(
    new Date(`${date}T12:00:00Z`),
  );
}
function dragBy(target: Element, pixels: number, pointerId = 1) {
  fireEvent.pointerDown(target, { button: 0, pointerId, clientX: 200, clientY: 10 });
  fireEvent.pointerMove(window, { pointerId, clientX: 200 + pixels / 2, clientY: 10 });
  fireEvent.pointerMove(window, { pointerId, clientX: 200 + pixels, clientY: 10 });
  fireEvent.pointerUp(window, { pointerId, clientX: 200 + pixels, clientY: 10 });
}
function sentValues(run: ReturnType<typeof vi.spyOn>, call = -1) {
  const commands = run.mock.calls.at(call)![0] as Array<{
    kind: string;
    records?: Array<{ values: unknown }>;
  }>;
  expect(commands[0]!.kind).toBe('record.update');
  return commands[0]!.records![0]!.values;
}

describe('timeline settings', () => {
  it('starts a new timeline with the first two date fields, or with none', () => {
    const table = { primaryFieldId: 'fld00000000000009' } as never;
    const date = (id: string, type = 'date') => ({ id, type, options: {} }) as unknown as FieldMeta;
    const text = { id: 'fld00000000000009', type: 'text', options: {} } as unknown as FieldMeta;
    const first = VIEW_DEFINITIONS.timeline.initialConfig(table, [
      text,
      date('fld00000000000001', 'createdTime'),
      date('fld00000000000002'),
      date('fld00000000000003'),
    ]);
    expect(first.timeline).toEqual({
      startFieldId: 'fld00000000000002',
      endFieldId: 'fld00000000000003',
      groupFieldId: null,
      labelFieldId: null,
      zoom: 'week',
    });
    const computed = VIEW_DEFINITIONS.timeline.initialConfig(table, [
      text,
      date('fld00000000000001', 'createdTime'),
    ]);
    expect(computed.timeline).toMatchObject({ startFieldId: 'fld00000000000001', endFieldId: null });
    expect(VIEW_DEFINITIONS.timeline.initialConfig(table, [text]).timeline).toMatchObject({
      startFieldId: null,
      endFieldId: null,
    });
  });

  it('prefers date fields named like a start and an end, in each of the app’s languages', () => {
    const table = { primaryFieldId: 'fld00000000000009' } as never;
    const date = (id: number, name: string) =>
      ({ id: `fld0000000000000${id}`, name, type: 'date', options: {} }) as unknown as FieldMeta;
    const dates = (...fields: FieldMeta[]) => {
      const { startFieldId, endFieldId } = VIEW_DEFINITIONS.timeline.initialConfig(table, fields).timeline!;
      return [startFieldId, endFieldId].map((id) => fields.find((field) => field.id === id)?.name ?? null);
    };
    expect(dates(date(1, 'Signed'), date(2, 'Due date'), date(3, 'Start date'))).toEqual([
      'Start date',
      'Due date',
    ]);
    expect(dates(date(1, 'Deadline'), date(2, 'Kick off'))).toEqual(['Kick off', 'Deadline']);
    expect(dates(date(1, 'Ends'), date(2, 'Begins'), date(3, 'Reviewed'))).toEqual(['Begins', 'Ends']);
    expect(dates(date(1, 'Fecha de fin'), date(2, 'Fecha de inicio'))).toEqual([
      'Fecha de inicio',
      'Fecha de fin',
    ]);
    expect(dates(date(1, 'Date de fin'), date(2, 'Début'))).toEqual(['Début', 'Date de fin']);
    expect(dates(date(1, 'Enddatum'), date(2, 'Startdatum'))).toEqual(['Startdatum', 'Enddatum']);
    expect(dates(date(1, 'Data di fine'), date(2, 'Data di inizio'))).toEqual([
      'Data di inizio',
      'Data di fine',
    ]);
    expect(dates(date(1, 'Término'), date(2, 'Início'))).toEqual(['Início', 'Término']);
    expect(dates(date(1, 'Einddatum'), date(2, 'Begindatum'))).toEqual(['Begindatum', 'Einddatum']);
    expect(dates(date(1, '終了日'), date(2, '開始日'))).toEqual(['開始日', '終了日']);
    expect(dates(date(1, '마감일'), date(2, '시작일'))).toEqual(['시작일', '마감일']);
    expect(dates(date(1, '截止日期'), date(2, '开始日期'))).toEqual(['开始日期', '截止日期']);
    // Words that only contain a start or an end don't count.
    expect(dates(date(1, 'Weekend'), date(2, 'Restarted'))).toEqual(['Weekend', 'Restarted']);
    // With only an end, the start is the first other date, and an end alone still starts the bars.
    expect(dates(date(1, 'Due'), date(2, 'Opened'))).toEqual(['Opened', 'Due']);
    expect(dates(date(1, 'Due'))).toEqual(['Due', null]);
  });

  it('explains that it needs a date field and adds one', async () => {
    const { run, session, fixture } = await mount({ noDates: true, count: 2 });
    expect(screen.getByRole('heading', { name: 'This timeline needs a date field' })).toBeTruthy();
    expect(screen.queryByRole('group')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Add a date field' }));
    await settle();
    const commands = run.mock.calls[0]![0];
    expect(commands.map((command) => command.kind)).toEqual(['field.create', 'view.update']);
    const created = session
      .getSchema()
      .fields.get(fixture.tableId)!
      .find((field) => field.name === 'Date')!;
    expect(created.type).toBe('date');
    expect(session.getSchema().viewById.get(fixture.viewId)!.config.timeline.startFieldId).toBe(created.id);
    expect(screen.getByRole('group', { name: 'Plan' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'No date, 2 records' })).toBeTruthy();
  });

  it('offers the table’s date fields when the chosen one is missing or not a date', async () => {
    const { onConfig, start, ids } = await mount({
      timeline: { startFieldId: 'fld00000000000099' },
      values: (_, f) => ({ [f.start]: '2026-09-28' }),
    });
    expect(screen.getByRole('heading', { name: 'This timeline needs a date field' })).toBeTruthy();
    await userEvent.click(screen.getAllByRole('button', { name: /Start date/ })[0]!);
    await userEvent.click(screen.getByRole('option', { name: 'Starts' }));
    await settle();
    expect(onConfig).toHaveBeenLastCalledWith({
      timeline: expect.objectContaining({ startFieldId: start.id }),
    });
    expect(bar('Task 1')).toBeTruthy();
    cleanup();
    await mount({ timeline: { startFieldId: ids.status } });
    expect(screen.getByRole('heading', { name: 'This timeline needs a date field' })).toBeTruthy();
  });

  it('saves the lanes, label, and end fields, and disables them for people who can’t change the view', async () => {
    const { onConfig, ids } = await mount({ values: (_, f) => ({ [f.start]: '2026-09-28' }) });
    await userEvent.click(screen.getByRole('button', { name: 'Timeline settings' }));
    await userEvent.click(screen.getByRole('button', { name: /Lanes by/ }));
    await userEvent.click(screen.getByRole('option', { name: 'Status' }));
    await settle();
    expect(onConfig).toHaveBeenLastCalledWith({
      timeline: {
        startFieldId: ids.start,
        endFieldId: ids.end,
        groupFieldId: ids.status,
        labelFieldId: null,
        zoom: 'day',
      },
    });
    await userEvent.click(screen.getByRole('button', { name: /End date/ }));
    await userEvent.click(screen.getByRole('option', { name: 'None' }));
    await settle();
    expect(onConfig).toHaveBeenLastCalledWith({ timeline: expect.objectContaining({ endFieldId: null }) });
    cleanup();
    await mount({ canEdit: false, values: (_, f) => ({ [f.start]: '2026-09-28' }) });
    await userEvent.click(screen.getByRole('button', { name: 'Timeline settings' }));
    expect(screen.getByRole('button', { name: /Lanes by/ }).hasAttribute('disabled')).toBe(true);
  });
});

describe('timeline lanes and packing', () => {
  it('keeps an empty chart scrollable by keyboard', async () => {
    await mount({ count: 0 });
    const scroller = document.querySelector<HTMLElement>('.rio-timeline-chart__scroller')!;
    expect(scroller.tabIndex).toBe(0);
    scroller.focus();
    expect(document.activeElement).toBe(scroller);
  });

  it('packs spans onto the first free line, using as few lines as the busiest day needs', () => {
    expect(pack([])).toEqual([]);
    expect(
      pack([
        { start: 1, end: 5 },
        { start: 3, end: 7 },
        { start: 6, end: 8 },
        { start: 6, end: 6 },
        { start: 9, end: 9 },
      ]),
    ).toEqual([0, 1, 0, 2, 0]);
    // A thousand records on one day each need their own line.
    const same = pack(Array.from({ length: 1000 }, () => ({ start: 0, end: 0 })));
    expect(new Set(same).size).toBe(1000);
  });

  it('draws overlapping records on separate lines and the rest on as few as fit', async () => {
    const spans: Array<[string, string]> = [
      ['2026-09-21', '2026-09-25'],
      ['2026-09-23', '2026-09-27'],
      ['2026-09-26', '2026-09-28'],
    ];
    await mount({
      count: 3,
      values: (index, f) => ({ [f.start]: spans[index]![0], [f.end]: spans[index]![1] }),
    });
    expect(line(bar('Task 1'))).toBe(0);
    expect(line(bar('Task 2'))).toBe(1);
    expect(line(bar('Task 3'))).toBe(0);
    expect(bar('Task 1').getAttribute('aria-label')).toBe(
      `Task 1 ${day('2026-09-21')} ${day('2026-09-25')}, ${range('2026-09-21', '2026-09-25')}`,
    );
    expect(parseFloat(bar('Task 1').style.inlineSize)).toBe(5 * 40);
    expect(screen.queryByRole('button', { name: /No date/ })).toBeNull();
  });

  it('puts bars in lanes by a single select, in option order, with Empty last', async () => {
    const statuses = [choices.launch, null, choices.design, choices.design];
    await mount({
      count: 4,
      timeline: (f) => ({ groupFieldId: f.status }),
      values: (index, f) => ({ [f.start]: '2026-09-28', [f.status]: statuses[index] ?? null }),
    });
    const lanes = [...document.querySelectorAll('.rio-timeline__lane')].map((lane) => lane.textContent);
    expect(lanes).toEqual(['Design2', 'Launch1', 'Empty1']);
    expect(line(bar('Task 3'))).toBe(0);
    expect(line(bar('Task 4'))).toBe(1);
    expect(line(bar('Task 1'))).toBe(2);
    expect(line(bar('Task 2'))).toBe(3);
    expect(bar('Task 1').getAttribute('aria-label')).toBe(
      `Task 1 ${day('2026-09-28')}, ${day('2026-09-28')}, Launch`,
    );
    expect(bar('Task 2').getAttribute('aria-label')).toBe(
      `Task 2 ${day('2026-09-28')}, ${day('2026-09-28')}, Empty`,
    );
  });

  it('shows a record in the lane of each of its people', async () => {
    await mount({
      count: 2,
      timeline: (f) => ({ groupFieldId: f.owners }),
      values: (index, f) => ({ [f.start]: '2026-09-28', [f.owners]: index === 0 ? null : [] }),
    });
    expect([...document.querySelectorAll('.rio-timeline__lane')].map((lane) => lane.textContent)).toEqual([
      'Empty2',
    ]);
    cleanup();
    const second = await mount({
      count: 2,
      timeline: (f) => ({ groupFieldId: f.owners }),
      values: (index, f) => ({ [f.start]: '2026-09-28', [f.owners]: index === 0 ? [f.ada, f.grace] : [] }),
    });
    const names = [...document.querySelectorAll('.rio-timeline__lane-text')].map((lane) => lane.textContent);
    expect(names).toEqual(['Ada', 'Grace', 'Empty']);
    const both = screen.getAllByRole('button', { name: /^Task 1[ ,]/ });
    expect(both.map((element) => element.getAttribute('aria-label'))).toEqual([
      `Task 1 ${day('2026-09-28')}, ${day('2026-09-28')}, Ada`,
      `Task 1 ${day('2026-09-28')}, ${day('2026-09-28')}, Grace`,
    ]);
    expect(second.run).not.toHaveBeenCalled();
  });

  it('draws a record with no end one unit of the zoom long', async () => {
    await mount({ count: 1, values: (_, f) => ({ [f.start]: '2026-09-28' }) });
    expect(bar('Task 1').dataset.open).toBe('true');
    expect(bar('Task 1').getAttribute('aria-label')).toBe(
      `Task 1 ${day('2026-09-28')}, ${day('2026-09-28')}`,
    );
    expect(parseFloat(bar('Task 1').style.inlineSize)).toBe(40);
    await userEvent.click(screen.getByRole('button', { name: /Zoom/ }));
    await userEvent.click(screen.getByRole('option', { name: 'Week' }));
    await settle();
    expect(parseFloat(bar('Task 1').style.inlineSize)).toBe(7 * 14);
    await userEvent.click(screen.getByRole('button', { name: /Zoom/ }));
    await userEvent.click(screen.getByRole('option', { name: 'Month' }));
    await settle();
    // September 28 to October 27.
    expect(parseFloat(bar('Task 1').style.inlineSize)).toBe(30 * 4);
  });
});

describe('timeline editing', () => {
  it('drags a bar to move both dates as one change, and undoes it', async () => {
    const { run, session, ids, fixture } = await mount({
      values: (_, f) => ({ [f.start]: '2026-09-21', [f.end]: '2026-09-23' }),
    });
    dragBy(bar('Task 1'), 2 * 40 + 5);
    expect(sentValues(run)).toEqual({ [ids.start]: '2026-09-23', [ids.end]: '2026-09-25' });
    await settle();
    expect(bar('Task 1').getAttribute('aria-label')).toBe(
      `Task 1 ${day('2026-09-23')} ${day('2026-09-25')}, ${range('2026-09-23', '2026-09-25')}`,
    );
    expect(screen.getByRole('status').textContent).toBe(`Moved to ${range('2026-09-23', '2026-09-25')}`);
    await act(async () => {
      await session.undo();
    });
    await settle();
    expect(session.cachedRecord(fixture.tableId, fixture.recordId(0))!.values).toMatchObject({
      [ids.start]: '2026-09-21',
      [ids.end]: '2026-09-23',
    });
    expect(bar('Task 1').getAttribute('aria-label')).toBe(
      `Task 1 ${day('2026-09-21')} ${day('2026-09-23')}, ${range('2026-09-21', '2026-09-23')}`,
    );
  });

  it('drags either end to resize, and gives a bar with no end an end', async () => {
    const { run, ids } = await mount({
      count: 2,
      values: (index, f) =>
        index === 0 ? { [f.start]: '2026-09-21', [f.end]: '2026-09-23' } : { [f.start]: '2026-09-25' },
    });
    const edge = (name: string, which: 'start' | 'end') =>
      bar(name).querySelector<HTMLElement>(`[data-edge="${which}"]`)!;
    dragBy(edge('Task 1', 'end'), 3 * 40);
    expect(sentValues(run)).toEqual({ [ids.end]: '2026-09-26' });
    await settle();
    dragBy(edge('Task 1', 'start'), -40, 2);
    expect(sentValues(run)).toEqual({ [ids.start]: '2026-09-20' });
    await settle();
    // An edge never passes the other one: the shortest bar is one day.
    dragBy(edge('Task 1', 'start'), 20 * 40, 3);
    expect(sentValues(run)).toEqual({ [ids.start]: '2026-09-26' });
    await settle();
    dragBy(edge('Task 2', 'start'), -2 * 40, 4);
    expect(sentValues(run)).toEqual({ [ids.start]: '2026-09-23', [ids.end]: '2026-09-25' });
  });

  it('cancels a drag with Escape, and a drag never opens the record', async () => {
    const { run, onExpand } = await mount({
      values: (_, f) => ({ [f.start]: '2026-09-21', [f.end]: '2026-09-23' }),
    });
    const target = bar('Task 1');
    fireEvent.pointerDown(target, { button: 0, pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 180 });
    expect(target.dataset.dragging).toBe('true');
    expect(parseFloat(target.style.insetInlineStart)).toBeGreaterThan(0);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(bar('Task 1').dataset.dragging).toBeUndefined();
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 180 });
    fireEvent.click(bar('Task 1'));
    expect(run).not.toHaveBeenCalled();
    expect(onExpand).not.toHaveBeenCalled();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    dragBy(bar('Task 1'), 40);
    fireEvent.click(bar('Task 1'));
    expect(onExpand).not.toHaveBeenCalled();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.click(bar('Task 1'));
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it('moves and resizes by one unit of the zoom with the arrow keys, and goes between bars', async () => {
    const { run, ids } = await mount({
      count: 2,
      timeline: { zoom: 'week' },
      values: (index, f) =>
        index === 0 ? { [f.start]: '2026-09-21', [f.end]: '2026-09-23' } : { [f.start]: '2026-10-05' },
    });
    const first = bar('Task 1');
    expect(first.getAttribute('aria-keyshortcuts')).toContain('Shift+ArrowRight');
    expect(first.tabIndex).toBe(0);
    expect(bar('Task 2').tabIndex).toBe(-1);
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(sentValues(run)).toEqual({ [ids.start]: '2026-09-28', [ids.end]: '2026-09-30' });
    await settle();
    expect(document.activeElement).toBe(bar('Task 1'));
    fireEvent.keyDown(bar('Task 1'), { key: 'ArrowRight', shiftKey: true });
    expect(sentValues(run)).toEqual({ [ids.end]: '2026-10-07' });
    await settle();
    fireEvent.keyDown(bar('Task 1'), { key: 'ArrowLeft', shiftKey: true });
    fireEvent.keyDown(bar('Task 1'), { key: 'ArrowLeft', shiftKey: true });
    await settle();
    // The end stops at the start rather than passing it.
    expect(sentValues(run)).toEqual({ [ids.end]: '2026-09-28' });
    fireEvent.keyDown(bar('Task 1'), { key: 'ArrowLeft' });
    expect(sentValues(run)).toEqual({ [ids.start]: '2026-09-21', [ids.end]: '2026-09-21' });
    fireEvent.keyDown(bar('Task 1'), { key: 'ArrowDown' });
    await settle();
    expect(document.activeElement).toBe(bar('Task 2'));
    expect(bar('Task 2').tabIndex).toBe(0);
    fireEvent.keyDown(bar('Task 2'), { key: 'Home' });
    await settle();
    expect(document.activeElement).toBe(bar('Task 1'));
    run.mockClear();
    fireEvent.keyDown(bar('Task 1'), { key: 'ArrowRight', altKey: true });
    expect(run).not.toHaveBeenCalled();
  });

  it('mirrors the arrow keys in right-to-left layouts', async () => {
    const { run, ids } = await mount({
      values: (_, f) => ({ [f.start]: '2026-09-21', [f.end]: '2026-09-23' }),
    });
    rightToLeft(() => fireEvent.keyDown(bar('Task 1'), { key: 'ArrowLeft' }));
    expect(sentValues(run)).toEqual({ [ids.start]: '2026-09-22', [ids.end]: '2026-09-24' });
    await settle();
    // Dragging toward the left is later, too.
    rightToLeft(() => dragBy(bar('Task 1'), -40));
    expect(sentValues(run)).toEqual({ [ids.start]: '2026-09-23', [ids.end]: '2026-09-25' });
  });

  it('leaves bars in place for people who can’t change the view, who zoom for themselves', async () => {
    const { run, onConfig } = await mount({
      canEdit: false,
      values: (_, f) => ({ [f.start]: '2026-09-21', [f.end]: '2026-09-23' }),
    });
    const target = bar('Task 1');
    expect(target.dataset.movable).toBeUndefined();
    expect(target.querySelector('[data-edge]')).toBeNull();
    fireEvent.keyDown(target, { key: 'ArrowRight' });
    dragBy(target, 80);
    expect(run).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /Zoom/ }));
    await userEvent.click(screen.getByRole('option', { name: 'Week' }));
    await settle();
    expect(onConfig).not.toHaveBeenCalled();
    expect(parseFloat(bar('Task 1').style.inlineSize)).toBe(3 * 14);
  });

  it('lets editors move bars, since that edits records, while the view stays as it is', async () => {
    const { run, onConfig } = await mount({
      canEdit: false,
      role: 'editor',
      values: (_, f) => ({ [f.start]: '2026-09-21', [f.end]: '2026-09-23' }),
    });
    const target = bar('Task 1');
    expect(target.dataset.movable).toBe('true');
    fireEvent.keyDown(target, { key: 'ArrowRight' });
    expect(run).toHaveBeenCalled();
    expect(onConfig).not.toHaveBeenCalled();
  });

  it('keeps computed start dates read-only', async () => {
    const { run } = await mount({ timeline: (f) => ({ startFieldId: f.created, endFieldId: null }) });
    expect(bar('Task 1').dataset.movable).toBeUndefined();
    fireEvent.keyDown(bar('Task 1'), { key: 'ArrowRight' });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('timeline settings bar', () => {
  it('counts records without a start date and lists them to open', async () => {
    const { onExpand, fixture } = await mount({
      count: 4,
      values: (index, f) => (index % 2 ? { [f.start]: '2026-09-28' } : { [f.end]: '2026-09-28' }),
    });
    expect(bars()).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'No date, 2 records' }));
    const list = screen.getByRole('dialog', { name: '2 records have no start date' });
    expect(
      within(list)
        .getAllByRole('button')
        .map((item) => item.textContent),
    ).toEqual(['Task 1', 'Task 3']);
    await userEvent.click(within(list).getByRole('button', { name: 'Task 3' }));
    expect(onExpand).toHaveBeenCalledWith(fixture.recordId(2));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('changes the zoom from the settings bar, saving it and redrawing the header', async () => {
    const { onConfig, ids } = await mount({ values: (_, f) => ({ [f.start]: '2026-09-28' }) });
    const header = () =>
      [...document.querySelectorAll('.rio-timeline-chart__cell[data-row="bottom"]')].map(
        (cell) => cell.textContent,
      );
    expect(header()).toContain('27');
    expect(document.querySelector('.rio-timeline-chart__cell[data-today]')!.textContent).toBe('27');
    await userEvent.click(screen.getByRole('button', { name: /Zoom/ }));
    await userEvent.click(screen.getByRole('option', { name: 'Quarter' }));
    await settle();
    expect(onConfig).toHaveBeenLastCalledWith({
      timeline: {
        startFieldId: ids.start,
        endFieldId: ids.end,
        groupFieldId: null,
        labelFieldId: null,
        zoom: 'quarter',
      },
    });
    expect(header()).toEqual(expect.arrayContaining(['Q3', 'Q4']));
    expect(document.querySelector('.rio-timeline-chart__cell[data-today]')!.textContent).toBe('Q3');
    await userEvent.click(screen.getByRole('button', { name: /Zoom/ }));
    await userEvent.click(screen.getByRole('option', { name: 'Year' }));
    await settle();
    expect(header()).toContain('2026');
  });

  it('opens on today, keeps the middle day in place across zooms once scrolled, and goes back to today', async () => {
    await mount({ values: (_, f) => ({ [f.start]: '2026-09-28' }) });
    const scroller = document.querySelector<HTMLElement>('.rio-timeline-chart__scroller')!;
    // The line for today runs down the middle of its day.
    const todayStart = (half: number) =>
      parseFloat(
        document.querySelector<HTMLElement>('.rio-timeline-chart__track .rio-timeline-chart__today')!.style
          .insetInlineStart,
      ) - half;
    expect(scroller.scrollLeft).toBeCloseTo(todayStart(20) - 1200 / 3, 0);
    scroller.scrollLeft += 200;
    fireEvent.scroll(scroller);
    const middle = (scroller.scrollLeft + 600 - todayStart(20)) / 40;
    await userEvent.click(screen.getByRole('button', { name: /Zoom/ }));
    await userEvent.click(screen.getByRole('option', { name: 'Week' }));
    await settle();
    expect((scroller.scrollLeft + 600 - todayStart(7)) / 14).toBeCloseTo(middle, 1);
    await userEvent.click(screen.getByRole('button', { name: 'Today' }));
    await settle();
    expect(scroller.scrollLeft).toBeCloseTo(todayStart(7) - 1200 / 3, 0);
  });

  it('lists every record with its dates in a table', async () => {
    const { onExpand, fixture } = await mount({
      count: 3,
      timeline: (f) => ({ groupFieldId: f.status }),
      values: (index, f) =>
        index === 2
          ? {}
          : { [f.start]: '2026-09-21', [f.end]: index ? '2026-09-25' : null, [f.status]: choices.build },
    });
    await userEvent.click(screen.getByRole('button', { name: 'List records and dates' }));
    const dialog = screen.getByRole('dialog', { name: 'Records and dates' });
    const rows = within(dialog)
      .getAllByRole('row')
      .map((row) => row.textContent);
    expect(rows).toEqual([
      'RecordStartsEndsStatus',
      `Task 1${day('2026-09-21')}NoneBuild`,
      `Task 2${day('2026-09-21')}${day('2026-09-25')}Build`,
      'Task 3NoneNone',
    ]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Task 2' }));
    expect(onExpand).toHaveBeenCalledWith(fixture.recordId(1));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows visible fields on each bar and in its tooltip', async () => {
    await mount({
      hidden: (f) => [f.owners, f.created, f.end],
      values: (_, f) => ({ [f.start]: '2026-09-21', [f.status]: choices.launch }),
    });
    const target = bar('Task 1');
    expect(target.textContent).toBe('Task 1 0 Sep 21, 2026 Launch');
    expect(target.getAttribute('aria-label')).toBe(`Task 1 0 Sep 21, 2026 Launch, ${day('2026-09-21')}`);
    fireEvent.focus(target);
    const tooltip = screen.getByRole('tooltip');
    expect(target.getAttribute('aria-describedby')).toBe(tooltip.id);
    expect(tooltip.textContent).toBe(
      `Task 1${day('2026-09-21')}Number0Starts${day('2026-09-21')}StatusLaunch`,
    );
    fireEvent.blur(target);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('timeline performance', () => {
  it('draws only the bars in view for 10,000 records, and more as it scrolls', async () => {
    await mount({
      count: 10_000,
      values: (index, f) => ({
        [f.start]: dayString(dayNumber('2026-01-01') + (index % 365)),
        [f.end]: dayString(dayNumber('2026-01-01') + (index % 365) + 3),
      }),
    });
    for (let round = 0; round < 20 && screen.queryByText('Loading records…'); round++) await settle();
    expect(screen.queryByText('Loading records…')).toBeNull();
    const drawn = bars().length;
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(500);
    const lines =
      parseFloat(document.querySelector<HTMLElement>('.rio-timeline-chart__body')!.style.blockSize) / LINE;
    // Every record starts on one of 365 days and runs four, so about 110 overlap on any day.
    expect(lines).toBeGreaterThan(100);
    expect(lines).toBeLessThan(200);
    const scroller = document.querySelector<HTMLElement>('.rio-timeline-chart__scroller')!;
    scroller.scrollTop = (lines - 10) * LINE;
    fireEvent.scroll(scroller);
    await settle();
    const deepest = Math.max(...bars().map(line));
    expect(deepest).toBeGreaterThan(lines - 12);
    expect(bars().length).toBeLessThan(500);
  });
});

describe('timeline updates', () => {
  it('shows records others add once their changes settle', async () => {
    const { server, fixture, ids } = await mount({ values: (_, f) => ({ [f.start]: '2026-09-28' }) });
    expect(bars()).toHaveLength(1);
    server.remote(fixture.databaseId, [
      {
        kind: 'record.create',
        tableId: fixture.tableId,
        records: [{ id: newId('record'), values: { [ids.name]: 'From Grace', [ids.start]: '2026-09-29' } }],
      },
    ]);
    await settle();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    });
    await settle();
    expect(bar('From Grace').getAttribute('aria-label')).toBe(
      `From Grace ${day('2026-09-29')}, ${day('2026-09-29')}`,
    );
  });
});

describe('timeline scale', () => {
  it('adds units of each zoom, keeping month ends', () => {
    const jan31 = dayNumber('2026-01-31');
    expect(dayString(addUnits(jan31, 'day', 1))).toBe('2026-02-01');
    expect(dayString(addUnits(jan31, 'week', -1))).toBe('2026-01-24');
    expect(dayString(addUnits(jan31, 'month', 1))).toBe('2026-02-28');
    expect(dayString(addUnits(dayNumber('2028-01-31'), 'month', 1))).toBe('2028-02-29');
    expect(dayString(addUnits(jan31, 'quarter', 1))).toBe('2026-04-30');
    expect(dayString(addUnits(dayNumber('2028-02-29'), 'year', 1))).toBe('2029-02-28');
    expect(dayString(addUnits(jan31, 'month', -2))).toBe('2025-11-30');
  });

  it('starts units on the locale’s first weekday and on month, quarter, and year boundaries', () => {
    const day = dayNumber('2026-09-27');
    expect(dayString(unitStart(day, 'week', 0))).toBe('2026-09-27');
    expect(dayString(unitStart(day, 'week', 1))).toBe('2026-09-21');
    expect(dayString(unitStart(day, 'month', 0))).toBe('2026-09-01');
    expect(dayString(unitStart(day, 'quarter', 0))).toBe('2026-07-01');
    expect(dayString(unitStart(day, 'year', 0))).toBe('2026-01-01');
    expect(cells(day, day + 40, 'month', 0).map((cell) => dayString(cell.start))).toEqual([
      '2026-09-01',
      '2026-10-01',
      '2026-11-01',
    ]);
  });

  it('covers the records and today with room on both sides, and narrows around today past layout limits', () => {
    const today = dayNumber('2026-09-27');
    const axis = makeAxis(today + 100, today + 110, today, 'day', 0, 1200);
    expect(axis.start).toBeLessThan(today);
    expect(axis.end).toBeGreaterThan(today + 110);
    expect(axis.x(axis.start)).toBe(0);
    const wide = makeAxis(today - 400_000, today + 400_000, today, 'day', 0, 1200);
    expect(wide.width).toBeLessThanOrEqual(4_000_000);
    expect(wide.start).toBeLessThan(today);
    expect(wide.end).toBeGreaterThan(today);
    const narrow = makeAxis(today, today, today, 'year', 0, 5000);
    expect(narrow.width).toBeGreaterThanOrEqual(5000);
  });
});

it('leaves public bars without gestures or resize controls', async () => {
  await mount({
    readOnly: true,
    values: (_index, fields) => ({ [fields.start]: '2026-09-27', [fields.end]: '2026-09-28' }),
  });
  const node = document.querySelector('.rio-timeline-bar')!;
  fireEvent.pointerDown(node, { button: 0, pointerId: 1, clientX: 20 });
  fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 100 });
  expect(document.querySelector('[data-rio-drop]')).toBeNull();
  expect(node.querySelector('[data-edge]')).toBeNull();
});

it('announces a keyboard move after canceling a bar drag', async () => {
  await mount({ values: (_index, fields) => ({ [fields.start]: '2026-09-27', [fields.end]: '2026-09-28' }) });
  const node = bar('Task 1');
  fireEvent.pointerDown(node, { button: 0, pointerId: 1, clientX: 20 });
  fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 100 });
  fireEvent.keyDown(node, { key: 'Escape' });
  fireEvent.pointerUp(window, { pointerId: 1 });
  expect(screen.getByRole('status').textContent).toBe('Move canceled.');
  fireEvent.keyDown(node, { key: 'ArrowRight' });
  expect(screen.getByRole('status').textContent).toContain('Moved to');
});
