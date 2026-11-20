import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FieldMeta,
  GANTT_LABEL_WIDTH,
  GridConfig,
  newId,
  type CellValue,
  type GanttSettings as Settings,
  type GridConfigPatch,
} from '@riosoma/contracts';
import { useSchema } from '../../../../data/hooks';
import { openDatabase } from '../../../../data/session';
import { FakeServer } from '../../../../data/testing';
import type { DatabaseSession } from '../../../../data/types';
import { useViewConfig } from '../../screen/useViewConfig';
import { VIEW_DEFINITIONS } from '../registry';
import type { ViewComponentProps } from '../types';
import { GanttSettings, GanttView } from './index';
import { isLate, progressOf } from './layout';

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
    for (let index = 0; index < 200; index++) await Promise.resolve();
  });
}

interface Fields {
  name: string;
  number: string;
  start: string;
  end: string;
  depends: string;
  percent: string;
  done: string;
  record(index: number): string;
}

interface Options {
  count?: number;
  values?(index: number, fields: Fields): Record<string, CellValue>;
  gantt?(fields: Fields): Partial<Settings>;
  sortDescending?: boolean;
  canEdit?: boolean;
  noDates?: boolean;
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
  const depends = field('Depends on', { type: 'link', options: { linkedTableId: fixture.tableId } });
  const percent = field('Progress', { type: 'percent', options: {} });
  const done = field('Done', { type: 'number', options: {} });
  const records: string[] = [];
  const ids: Fields = {
    name: fixture.textFieldId,
    number: fixture.numberFieldId,
    start: start.id,
    end: end.id,
    depends: depends.id,
    percent: percent.id,
    done: done.id,
    record: (index) => records[index]!,
  };
  const config = GridConfig.parse({
    hiddenFieldIds: [fixture.numberFieldId, start.id, end.id, depends.id, percent.id, done.id],
    sorts: options.sortDescending ? [{ fieldId: fixture.numberFieldId, direction: 'desc' }] : [],
    gantt: {
      startFieldId: options.noDates ? null : start.id,
      endFieldId: options.noDates ? null : end.id,
      dependencyFieldId: depends.id,
      zoom: 'day',
      ...options.gantt?.(ids),
    },
  });
  const count = options.count ?? 1;
  // Values are read lazily, once the record IDs below are known.
  const database = server.seed(
    {
      ...schema,
      fields: [...schema.fields, ...(options.noDates ? [] : [start, end]), depends, percent, done],
      views: [{ ...schema.views[0]!, name: 'Schedule', type: 'gantt', config }],
    },
    new Map([
      [
        fixture.tableId,
        {
          count,
          values: (index: number) => ({
            [fixture.textFieldId]: `Task ${index + 1}`,
            [fixture.numberFieldId]: index,
            ...options.values?.(index, ids),
          }),
        },
      ],
    ]),
  );
  for (let index = 0; index < count; index++) records.push(database.rows(fixture.tableId).id(index));
  const session = await openDatabase(fixture.databaseId, server.deps());
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
      onConfig: (patch) => {
        onConfig(patch);
        change(patch);
      },
      onExpand,
    };
    return (
      <>
        <GanttSettings {...props} />
        <GanttView {...props} />
      </>
    );
  }
  render(
    <I18nProvider i18n={setupI18n({ locale: 'en-US', messages: { 'en-US': {} } })}>
      <Harness />
    </I18nProvider>,
  );
  await settle();
  return { server, fixture, session, run, onExpand, onConfig, ids };
}

function bar(name: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(`^${name}[ ,]`) });
}
function labels(): string[] {
  return [...document.querySelectorAll('.rio-gantt__label')].map((label) => label.textContent ?? '');
}
function arrows() {
  return [...document.querySelectorAll<SVGPathElement>('.rio-gantt__arrow')].map((path) => ({
    from: path.dataset.from,
    to: path.dataset.to,
    late: path.dataset.late === 'true',
  }));
}
function range(from: string, to: string): string {
  const format = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
  return format.formatRange(new Date(`${from}T12:00:00Z`), new Date(`${to}T12:00:00Z`));
}
function sentValues(run: ReturnType<typeof vi.spyOn>) {
  const commands = run.mock.calls.at(-1)![0] as Array<{ kind: string; records?: Array<{ values: unknown }> }>;
  expect(commands[0]!.kind).toBe('record.update');
  return commands[0]!.records![0]!.values;
}

describe('Gantt setup', () => {
  it('starts a new chart with the first dates, a dependency link, and a percent field', () => {
    const table = { primaryFieldId: 'fld00000000000009' } as never;
    const make = (id: string, type: string, options: Record<string, unknown> = {}) =>
      ({ id, tableId: 'tbl00000000000001', type, options }) as unknown as FieldMeta;
    const config = VIEW_DEFINITIONS.gantt.initialConfig(table, [
      make('fld00000000000009', 'text'),
      make('fld00000000000001', 'date'),
      make('fld00000000000002', 'link', { linkedTableId: 'tbl00000000000002' }),
      make('fld00000000000003', 'link', { linkedTableId: 'tbl00000000000001' }),
      make('fld00000000000004', 'number'),
      make('fld00000000000005', 'percent'),
      make('fld00000000000006', 'date'),
    ]);
    expect(config.gantt).toEqual({
      startFieldId: 'fld00000000000001',
      endFieldId: 'fld00000000000006',
      dependencyFieldId: 'fld00000000000003',
      progressFieldId: 'fld00000000000005',
      labelFieldId: null,
      labelWidth: GANTT_LABEL_WIDTH.default,
      zoom: 'week',
    });
  });

  it('explains that it needs date fields and adds a start and an end', async () => {
    const { run, session, fixture } = await mount({ noDates: true });
    expect(screen.getByRole('heading', { name: 'This Gantt chart needs date fields' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add start and end date fields' }));
    await settle();
    expect(run.mock.calls[0]![0].map((command) => command.kind)).toEqual([
      'field.create',
      'field.create',
      'view.update',
    ]);
    const fields = session.getSchema().fields.get(fixture.tableId)!;
    const gantt = session.getSchema().viewById.get(fixture.viewId)!.config.gantt;
    expect(fields.find((field) => field.id === gantt.startFieldId)?.name).toBe('Start date');
    expect(fields.find((field) => field.id === gantt.endFieldId)?.name).toBe('End date');
    expect(screen.getByRole('group', { name: 'Schedule' })).toBeTruthy();
  });

  it('offers only links to this table as dependencies, and percents and numbers as progress', async () => {
    const { onConfig, ids } = await mount({ values: (_, f) => ({ [f.start]: '2026-09-28' }) });
    await userEvent.click(screen.getByRole('button', { name: 'Gantt settings' }));
    await userEvent.click(screen.getByRole('button', { name: /Progress/ }));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'None',
      'Number',
      'Progress',
      'Done',
    ]);
    await userEvent.click(screen.getByRole('option', { name: 'Done' }));
    await settle();
    expect(onConfig).toHaveBeenLastCalledWith({
      gantt: expect.objectContaining({ progressFieldId: ids.done, dependencyFieldId: ids.depends }),
    });
    await userEvent.click(screen.getByRole('button', { name: /Depends on/ }));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['None', 'Depends on']);
  });
});

describe('Gantt rows', () => {
  it('shows one row per record in the view’s order, with its label in the side column', async () => {
    await mount({
      count: 4,
      sortDescending: true,
      values: (index, f) => (index === 1 ? {} : { [f.start]: `2026-09-2${index}`, [f.end]: '2026-09-29' }),
    });
    expect(labels()).toEqual(['Task 4', 'Task 3', 'Task 2', 'Task 1']);
    const line = (name: string) => (parseFloat(bar(name).style.insetBlockStart) - 6) / 40;
    expect(line('Task 4')).toBe(0);
    expect(line('Task 3')).toBe(1);
    expect(line('Task 1')).toBe(3);
    expect(screen.queryByRole('button', { name: /^Task 2,/ })).toBeNull();
    // Down skips the row with no dates.
    bar('Task 3').focus();
    fireEvent.keyDown(bar('Task 3'), { key: 'ArrowDown' });
    await settle();
    expect(document.activeElement).toBe(bar('Task 1'));
  });

  it('opens a record from its label or its bar', async () => {
    const { onExpand, fixture } = await mount({ values: (_, f) => ({ [f.start]: '2026-09-28' }) });
    fireEvent.click(screen.getByRole('button', { name: 'Task 1' }));
    fireEvent.click(bar('Task 1'));
    expect(onExpand.mock.calls).toEqual([[fixture.recordId(0)], [fixture.recordId(0)]]);
  });

  it('fills the done part of each bar from a percent or a number field', async () => {
    const values = [0.25, 1.5, null];
    await mount({
      count: 3,
      gantt: (f) => ({ progressFieldId: f.percent }),
      values: (index, f) => ({
        [f.start]: '2026-09-21',
        [f.end]: '2026-09-24',
        [f.percent]: values[index] ?? null,
      }),
    });
    const fill = (name: string) =>
      bar(name).querySelector<HTMLElement>('.rio-gantt__progress')?.style.inlineSize;
    expect(fill('Task 1')).toBe('25%');
    expect(fill('Task 2')).toBe('100%');
    expect(fill('Task 3')).toBeUndefined();
    expect(bar('Task 1').getAttribute('aria-label')).toBe(
      `Task 1, ${range('2026-09-21', '2026-09-24')}, 25% done`,
    );
    expect(bar('Task 3').dataset.progress).toBe('true');
    const number = { type: 'number', options: {} } as unknown as FieldMeta;
    const row = (value: CellValue) => ({ id: 'rec', values: { fld: value } }) as never;
    expect(progressOf(row(40), { ...number, id: 'fld' } as FieldMeta)).toBe(40);
    expect(progressOf(row(-5), { ...number, id: 'fld' } as FieldMeta)).toBe(0);
    expect(progressOf(row('40'), { ...number, id: 'fld' } as FieldMeta)).toBeNull();
  });
});

describe('Gantt dependencies', () => {
  it('draws an arrow from each dependency, in the attention color when it ends after its dependent starts', async () => {
    const { ids } = await mount({
      count: 5,
      values: (index, f) =>
        [
          { [f.start]: '2026-09-21', [f.end]: '2026-09-23' },
          { [f.start]: '2026-09-24', [f.end]: '2026-09-25', [f.depends]: [f.record(0)] },
          { [f.start]: '2026-09-23', [f.end]: '2026-09-26', [f.depends]: [f.record(0), f.record(1)] },
          { [f.start]: '2026-09-28', [f.depends]: [f.record(3), f.record(4)] },
          { [f.end]: '2026-09-28' },
        ][index]!,
    });
    const [a, b, c] = [ids.record(0), ids.record(1), ids.record(2)];
    expect(arrows()).toEqual([
      { from: a, to: b, late: false },
      { from: a, to: c, late: true },
      { from: b, to: c, late: true },
    ]);
    expect(bar('Task 3').getAttribute('aria-label')).toBe(
      `Task 3, ${range('2026-09-23', '2026-09-26')}, starts before a dependency ends`,
    );
    expect(bar('Task 3').dataset.late).toBe('true');
    expect(bar('Task 2').dataset.late).toBeUndefined();
    const marker = (path: SVGPathElement) => path.getAttribute('marker-end');
    const paths = [...document.querySelectorAll<SVGPathElement>('.rio-gantt__arrow')];
    expect(marker(paths[1]!)).toMatch(/-late\)$/);
    expect(marker(paths[0]!)).toMatch(/-arrow\)$/);
  });

  it('counts a dependency as late from the day it ends, including records with no end', () => {
    expect(isLate({ start: 1, end: 5, open: false }, { start: 5, end: 9, open: false })).toBe(true);
    expect(isLate({ start: 1, end: 5, open: false }, { start: 6, end: 9, open: false })).toBe(false);
    // A record with no end takes just its start day, however long the zoom draws it.
    expect(isLate({ start: 1, end: 30, open: true }, { start: 2, end: 2, open: true })).toBe(false);
    expect(isLate({ start: 2, end: 30, open: true }, { start: 2, end: 2, open: true })).toBe(true);
  });

  it('opens dependency actions from the toolbar, where a touch screen can reach them', async () => {
    const { run, ids } = await mount({
      count: 3,
      values: (index, f) => ({ [f.start]: `2026-09-2${index + 1}`, [f.end]: `2026-09-2${index + 2}` }),
    });
    const dialog = () => screen.getByRole('dialog', { name: 'Dependencies' });
    const prerequisite = () => within(dialog()).getByLabelText('Prerequisite record') as HTMLSelectElement;
    // Nothing is focused yet, so the dialog starts on the first record in the view's order, and
    // both of its ends can be chosen there, since a touch screen can't focus a bar without
    // opening its record.
    await userEvent.click(screen.getByRole('button', { name: 'Dependencies' }));
    expect(prerequisite().value).toBe(ids.record(0));
    expect((within(dialog()).getByLabelText('Dependent record') as HTMLSelectElement).value).toBe(
      ids.record(1),
    );
    fireEvent.change(prerequisite(), { target: { value: ids.record(2) } });
    fireEvent.change(within(dialog()).getByLabelText('Dependent record'), {
      target: { value: ids.record(1) },
    });
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Add dependency' }));
    expect(sentValues(run)).toEqual({ [ids.depends]: [ids.record(2)] });
    await settle();
    expect(arrows()).toEqual([{ from: ids.record(2), to: ids.record(1), late: true }]);
    // A bar reached last is the one the toolbar item opens.
    bar('Task 2').focus();
    await userEvent.click(screen.getByRole('button', { name: 'Dependencies' }));
    expect(prerequisite().value).toBe(ids.record(1));
  });

  it('follows a drag with the arrows, then writes both dates as the timeline does', async () => {
    const { run, ids } = await mount({
      count: 2,
      values: (index, f) =>
        index === 0
          ? { [f.start]: '2026-09-21', [f.end]: '2026-09-23' }
          : { [f.start]: '2026-09-23', [f.end]: '2026-09-24', [f.depends]: [f.record(0)] },
    });
    expect(arrows()[0]!.late).toBe(true);
    fireEvent.pointerDown(bar('Task 2'), { button: 0, pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 140 });
    expect(arrows()[0]!.late).toBe(false);
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 140 });
    expect(sentValues(run)).toEqual({ [ids.start]: '2026-09-24', [ids.end]: '2026-09-25' });
    await settle();
    expect(bar('Task 2').dataset.late).toBeUndefined();
    expect(bar('Task 2').getAttribute('aria-label')).toBe(`Task 2, ${range('2026-09-24', '2026-09-25')}`);
  });
});

describe('Gantt label column', () => {
  it('resizes by keyboard and pointer, saving the width with the view', async () => {
    const { onConfig } = await mount({ values: (_, f) => ({ [f.start]: '2026-09-28' }) });
    const handle = screen.getByRole('separator', { name: 'Label column width' });
    expect(handle.getAttribute('aria-valuenow')).toBe('240');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    await settle();
    expect(onConfig).toHaveBeenLastCalledWith({ gantt: expect.objectContaining({ labelWidth: 256 }) });
    expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('256');
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 300 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 1000 });
    expect(document.querySelector<HTMLElement>('.rio-timeline-chart__side')!.style.inlineSize).toBe('600px');
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 1000 });
    await settle();
    expect(onConfig).toHaveBeenLastCalledWith({ gantt: expect.objectContaining({ labelWidth: 600 }) });
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'Home' });
    await settle();
    expect(onConfig).toHaveBeenLastCalledWith({ gantt: expect.objectContaining({ labelWidth: 120 }) });
  });

  it('resizes for this person alone when they can’t change the view', async () => {
    const { onConfig } = await mount({ canEdit: false, values: (_, f) => ({ [f.start]: '2026-09-28' }) });
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' });
    await settle();
    expect(onConfig).not.toHaveBeenCalled();
    expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('224');
    expect(document.querySelector<HTMLElement>('.rio-timeline-chart__side')!.style.inlineSize).toBe('224px');
  });

  it('lists records with their dates, progress, and dependencies', async () => {
    await mount({
      count: 2,
      gantt: (f) => ({ progressFieldId: f.percent }),
      values: (index, f) =>
        index === 0
          ? { [f.start]: '2026-09-21', [f.end]: '2026-09-23', [f.percent]: 0.5 }
          : { [f.start]: '2026-09-24', [f.depends]: [f.record(0)] },
    });
    await userEvent.click(screen.getByRole('button', { name: 'List records and dates' }));
    const dialog = screen.getByRole('dialog', { name: 'Records and dates' });
    const day = (date: string) =>
      new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(
        new Date(`${date}T12:00:00Z`),
      );
    expect(
      within(dialog)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toEqual([
      'RecordStartsEndsProgressDepends on',
      `Task 1${day('2026-09-21')}${day('2026-09-23')}50%`,
      `Task 2${day('2026-09-24')}NoneTask 1`,
    ]);
  });
});

describe('Gantt performance', () => {
  it('draws only the rows and bars in view for 10,000 records', async () => {
    await mount({
      count: 10_000,
      values: (index, f) => ({
        [f.start]: `2026-09-${String(1 + (index % 28)).padStart(2, '0')}`,
        [f.end]: '2026-09-29',
        [f.depends]: index ? [f.record(index - 1)] : [],
      }),
    });
    for (let round = 0; round < 20 && screen.queryByText('Loading records…'); round++) await settle();
    expect(screen.queryByText('Loading records…')).toBeNull();
    expect(labels().length).toBeLessThan(60);
    expect(document.querySelectorAll('.rio-timeline-bar').length).toBeLessThan(60);
    expect(arrows().length).toBeLessThan(60);
    const scroller = document.querySelector<HTMLElement>('.rio-timeline-chart__scroller')!;
    scroller.scrollTop = 9_990 * 40;
    fireEvent.scroll(scroller);
    await settle();
    expect(labels()).toContain('Task 10000');
    expect(labels().length).toBeLessThan(60);
  });
});

it('opens dependency actions with the physical Option D key on an Apple keyboard', async () => {
  await mount({ values: (_index, fields) => ({ [fields.start]: '2026-09-27', [fields.end]: '2026-09-28' }) });
  fireEvent.keyDown(bar('Task 1'), { key: '∂', code: 'KeyD', altKey: true });
  expect(screen.getByRole('dialog', { name: 'Dependencies' })).toBeTruthy();
});
