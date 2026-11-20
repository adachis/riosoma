import { act, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DatabaseRole, FieldMeta } from '@riosoma/contracts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openDatabase } from '../data';
import { FakeServer } from '../data/testing';
import { i18n } from '../i18n';
import type { ViewColors } from '../screens/database/colors/paint';
import { renderShell } from '../screens/database/shell/test-support';
import { GridView } from './GridView';
import { openGrid, seedTable } from './test-support';

/**
 * The document these tests run in lays nothing out, so the grid is given a size to draw into:
 * its scroller reports one, and every observer of sizes hears about it at once.
 */
const layout = {
  width: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')!,
  height: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')!,
};
beforeEach(() => {
  i18n.load('en-US', {});
  i18n.activate('en-US');
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly callback: (entries: readonly ResizeObserverEntry[]) => void) {}
      observe() {
        queueMicrotask(() => this.callback([]));
      }
      unobserve() {}
      disconnect() {}
    },
  );
  const sized = (size: number, original: PropertyDescriptor) => ({
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('rio-grid__scroller') ? size : original.get!.call(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', sized(1400, layout.width));
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', sized(400, layout.height));
});

const dispose: Array<() => void> = [];
afterEach(() => {
  cleanup();
  for (const close of dispose.splice(0)) close();
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', layout.width);
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', layout.height);
  vi.unstubAllGlobals();
});

/** Lets the grid draw whatever it has scheduled, and anything that starts in turn. */
async function settle() {
  for (let frame = 0; frame < 4; frame++)
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
}

const READY = 'cho00000000000001';

/** Every record cell the grid shows, as row:col */
function recordCells(root: ParentNode): string[] {
  return [...root.querySelectorAll('[role="gridcell"][data-rio-row]')]
    .map((cell) => `${cell.getAttribute('data-rio-row')}:${cell.getAttribute('data-rio-col')}`)
    .sort();
}

/** The record cells that changed in these records, as row:col */
function changedCells(records: readonly MutationRecord[]): string[] {
  const found = new Set<string>();
  for (const record of records) {
    const cell =
      record.target instanceof Element
        ? record.target.closest('[role="gridcell"][data-rio-row]')
        : record.target.parentElement?.closest('[role="gridcell"][data-rio-row]');
    if (cell) found.add(`${cell.getAttribute('data-rio-row')}:${cell.getAttribute('data-rio-col')}`);
  }
  return [...found].sort();
}

async function open(role: DatabaseRole = 'owner') {
  const server = new FakeServer();
  const fixture = seedTable(
    server,
    [
      { name: 'Name', type: 'text' },
      { name: 'Notes', type: 'text' },
      {
        name: 'Status',
        type: 'singleSelect',
        options: { choices: [{ id: READY, name: 'Ready', color: 'blue' }] },
      },
    ],
    3,
    (index, [name, notes, status]) => ({
      [name!]: ['Mara', 'Tomas', 'Iris'][index]!,
      [notes!]: `test.note.${index}`,
      [status!]: READY,
    }),
  );
  fixture.database.schema.database.role = role;
  const session = await openDatabase(fixture.databaseId, server.deps());
  const rows = session.openView(fixture.viewId);
  dispose.push(() => {
    rows.close();
    session.close();
  });
  for (let i = 0; i < 80; i++) await Promise.resolve();
  const schema = session.getSchema();
  const view = schema.viewById.get(fixture.viewId)!;
  const format = { locale: 'en-US', timeZone: 'UTC', collaborators: schema.collaborators };
  // The props a parent passes each time it draws: the same values, in new objects where a parent
  // makes new ones, such as the view spread together with its settings and fresh callbacks.
  const props = () => ({
    session,
    rows,
    table: schema.tableById.get(fixture.tableId)!,
    view: { ...view, config: view.config },
    fields: schema.fields.get(fixture.tableId)!,
    format,
    peers: [],
    onConfig: vi.fn(),
    onExpand: vi.fn(),
    onField: vi.fn(),
    onFilter: vi.fn(),
  });
  const shell = renderShell(<GridView {...props()} />);
  await screen.findByRole('gridcell', { name: 'Tomas' });
  await settle();
  const table = shell.container.querySelector<HTMLElement>('.rio-grid__table')!;
  /** Every change to the grid's rows, header, and footer from here on */
  const changes: MutationRecord[] = [];
  const observer = new MutationObserver((records) => changes.push(...records));
  // A cell writes its column index each time it draws, so a drawn row shows up even when its
  // content comes out the same.
  observer.observe(table, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['aria-colindex', 'class'],
  });
  dispose.push(() => observer.disconnect());
  const drawn = () => {
    changes.push(...observer.takeRecords());
    return changes.splice(0);
  };
  /** The owner changes this person's role, and their open tab reloads what they may do. */
  async function becomes(next: DatabaseRole) {
    fixture.database.schema.database.role = next;
    await act(async () => {
      server.dropSubscriptions(fixture.databaseId, 'accessChanged');
      for (let i = 0; i < 80; i++) await Promise.resolve();
    });
  }
  return { shell, props, fixture, format, drawn, becomes };
}

it('leaves every row as it is when the parent draws again with nothing the rows draw from changed', async () => {
  const { shell, props, fixture, drawn } = await open();
  expect(drawn()).toEqual([]);
  // A record opens beside the grid, someone's presence moves, and the parent hands over new
  // callbacks and a new view object with the same settings.
  shell.rerender(<GridView {...props()} recordId={fixture.recordId(1)} />);
  await settle();
  shell.rerender(<GridView {...props()} peers={[]} onSelectRecord={vi.fn()} />);
  await settle();
  expect(drawn()).toEqual([]);
});

it('still draws every row again when something the rows draw from changes', async () => {
  const { shell, props, format, drawn } = await open();
  shell.rerender(<GridView {...props()} format={{ ...format, locale: 'en-GB' }} />);
  await settle();
  const cells = recordCells(shell.container);
  expect(cells).toHaveLength(9);
  expect(changedCells(drawn())).toEqual(cells);
});

/** The colors a rule gives the Notes cells */
const notesColors = (notesId: string): ViewColors => ({
  record: () => null,
  cell: (_, field) =>
    field.id === notesId
      ? { fill: 'var(--rio-aa-choice-blue-soft)', color: 'blue', bar: null, labels: ['test.rule'] }
      : null,
  labels: () => [],
});

it.each([
  { change: 'a field type change', ends: true },
  { change: 'a choice rename', ends: false },
  { change: 'new colors', ends: false },
  { change: 'a new row height', ends: false },
  { change: 'an editor becoming a commenter', ends: true },
  { change: 'a creator becoming a commenter', ends: true },
])(
  'draws every row again after $change, with the parent’s format unchanged, and ends an edit only when its column or permission changes',
  async ({ change, ends }) => {
    const { shell, props, fixture, drawn, becomes } = await open(
      change === 'a creator becoming a commenter' ? 'creator' : 'editor',
    );
    const [, notesId, statusId] = fixture.ids;
    const input = shell.container.querySelector<HTMLTextAreaElement>('.rio-grid-view__engine textarea')!;
    await userEvent.click(screen.getByRole('gridcell', { name: 'test.note.1' }));
    input.focus();
    await userEvent.keyboard('H');
    expect(input.hasAttribute('data-editing')).toBe(true);
    await settle();
    drawn();
    const base = props();
    const renamesOrRetypes = change === 'a field type change' || change === 'a choice rename';
    const fields = !renamesOrRetypes
      ? base.fields
      : base.fields.map((field): FieldMeta => {
          if (change === 'a field type change' && field.id === notesId)
            return { ...field, type: 'number', options: { precision: 0 } } as FieldMeta;
          if (change === 'a choice rename' && field.id === statusId && field.type === 'singleSelect')
            return {
              ...field,
              options: { ...field.options, choices: [{ id: READY, name: 'test.prepared', color: 'blue' }] },
            };
          return field;
        });
    // Someone who can change the table is offered a summary in each footer cell.
    const hints = () => shell.container.querySelectorAll('.rio-grid-summary__hint').length;
    if (change === 'a creator becoming a commenter') expect(hints()).toBe(2);
    if (change.endsWith('becoming a commenter')) await becomes('commenter');
    else
      shell.rerender(
        <GridView
          {...base}
          fields={fields}
          view={
            change === 'a new row height'
              ? { ...base.view, config: { ...base.view.config, rowHeight: 'medium' } }
              : base.view
          }
          {...(change === 'new colors' ? { colors: notesColors(notesId!) } : {})}
        />,
      );
    await settle();
    expect(changedCells(drawn())).toEqual(recordCells(shell.container));
    expect(input.hasAttribute('data-editing')).toBe(!ends);
    if (!ends) expect(input.value).toBe('H');
    // What each change draws, which an old renderer wouldn't
    const notes = [
      ...shell.container.querySelectorAll<HTMLElement>('[role="gridcell"][data-rio-row][data-rio-col="1"]'),
    ];
    if (change === 'a field type change')
      expect(notes.map((cell) => cell.style.textAlign)).toEqual(['end', 'end', 'end']);
    if (change === 'a choice rename')
      expect(screen.getAllByRole('gridcell', { name: 'test.prepared' })).toHaveLength(3);
    if (change === 'new colors')
      expect(notes.every((cell) => cell.getAttribute('aria-description')?.includes('test.rule'))).toBe(true);
    if (change === 'a new row height')
      expect(
        notes.map((cell) => cell.querySelector('[data-row-height]')?.getAttribute('data-row-height')),
      ).toEqual(['medium', 'medium', 'medium']);
    if (change.endsWith('becoming a commenter'))
      expect(screen.getByRole('grid').getAttribute('aria-readonly')).toBe('true');
    if (change === 'a creator becoming a commenter') expect(hints()).toBe(0);
  },
);

it('redraws a changed record in a grid opened the way the grid view opens one', async () => {
  const server = new FakeServer();
  const fixture = seedTable(server, [{ name: 'Name', type: 'text' }], 3, (index, [name]) => ({
    [name!]: `test.name.${index}`,
  }));
  const app = await openGrid(server, fixture);
  dispose.push(app.close);
  await settle();
  const cell = () => document.querySelector('[role="gridcell"][data-rio-row="1"][data-rio-col="0"]');
  expect(cell()?.textContent).toBe('test.name.1');
  await act(async () => {
    app.session.run([
      {
        kind: 'record.update',
        tableId: fixture.tableId,
        records: [{ id: fixture.recordId(1), values: { [fixture.ids[0]!]: 'test.renamed' } }],
      },
    ]);
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
  expect(app.value(1, fixture.ids[0]!)).toBe('test.renamed');
  await settle();
  expect(cell()?.textContent).toBe('test.renamed');
});
