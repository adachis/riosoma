import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ColorConfig,
  FieldMeta,
  GridConfig,
  LIST_FIELD_COUNT,
  newId,
  type CellValue,
  type DatabaseRole,
  type GridConfigPatch,
  type ListSettings as Settings,
  type RowData,
  type Sort,
} from '@riosoma/contracts';
import { useSchema } from '../../../../data/hooks';
import type { Http } from '../../../../data';
import { openDatabase } from '../../../../data/session';
import { FakeServer } from '../../../../data/testing';
import type { ActionHandle, DatabaseSession } from '../../../../data/types';
import { createViewColors } from '../../colors/paint';
import { useViewConfig } from '../../screen/useViewConfig';
import { VIEW_DEFINITIONS } from '../registry';
import type { ViewComponentProps } from '../types';
import { ListSettings, ListView } from './index';
import { LINE_HEIGHT } from './ListView';
import {
  EMPTY_GROUP,
  destinationAt,
  groupValues,
  listModel,
  parentValues,
  stepDestination,
  within as nestedWithin,
  type ListMode,
  type RecordLine,
} from './model';

const sessions: DatabaseSession[] = [];
afterEach(() => {
  cleanup();
  sessions.splice(0).forEach((session) => session.close());
  vi.restoreAllMocks();
});

const choices = { design: 'cho00000000000001', build: 'cho00000000000002', launch: 'cho00000000000003' };

interface Fields {
  name: string;
  number: string;
  status: string;
  owners: string;
  parent: string;
  /** Two people who can read the database */
  ada: string;
  grace: string;
  /** The ID of the record at a position in the table */
  record(index: number): string;
}

interface Options {
  count?: number;
  http?(next: Http): Http;
  waitForAllPages?: boolean;
  lastPage?: Promise<void>;
  values?(index: number, fields: Fields): Record<string, CellValue>;
  list?: Partial<Settings> | ((fields: Fields) => Partial<Settings>);
  sorts?(fields: Fields): Sort[];
  /** The view's conditional colors */
  colors?(fields: Fields): Record<string, unknown>;
  canEdit?: boolean;
  role?: DatabaseRole;
  /** Extra fields right after the fixture's own, each with one value for every record */
  extraFields?: Array<{ name: string; spec: Record<string, unknown>; value?: CellValue }>;
}

async function mount(options: Options = {}) {
  const server = new FakeServer();
  const fixture = server.createDatabase(0);
  const schema = server.database(fixture.databaseId).schema;
  const base = schema.fields[0]!;
  let position = schema.fields.length;
  const field = (name: string, spec: Record<string, unknown>) =>
    FieldMeta.parse({ ...base, id: newId('field'), name, position: position++, ...spec });
  const extras = (options.extraFields ?? []).map(({ name, spec }) => field(name, spec));
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
  const parent = field('Parent', { type: 'link', options: { linkedTableId: fixture.tableId } });
  const prefix = fixture.tableId.slice(3, 10);
  const ids: Fields = {
    name: fixture.textFieldId,
    number: fixture.numberFieldId,
    status: status.id,
    owners: owners.id,
    parent: parent.id,
    ada: server.userId,
    grace: server.remoteUserId,
    record: (index) => `rec${prefix}${index.toString(36).padStart(7, '0')}`,
  };
  const config = GridConfig.parse({
    list: typeof options.list === 'function' ? options.list(ids) : (options.list ?? {}),
    sorts: options.sorts?.(ids) ?? [],
  });
  server.seed(
    {
      ...schema,
      fields: [...schema.fields, ...extras, status, owners, parent],
      views: [{ ...schema.views[0]!, name: 'Tasks', type: 'list', config }],
      collaborators: [
        { id: server.userId, name: 'Ada', email: 'ada@example.test' },
        { id: server.remoteUserId, name: 'Grace', email: 'grace@example.test' },
      ],
    },
    new Map([
      [
        fixture.tableId,
        {
          count: options.count ?? 3,
          values: (index: number) => ({
            [fixture.textFieldId]: `Task ${index + 1}`,
            [fixture.numberFieldId]: index,
            ...Object.fromEntries(
              extras.map((extra, at) => [extra.id, options.extraFields?.[at]?.value ?? null]),
            ),
            ...options.values?.(index, ids),
          }),
        },
      ],
    ]),
  );
  const deps = server.deps();
  if (options.http) deps.http = options.http(deps.http!);
  if (options.lastPage) {
    const next = deps.http!;
    deps.http = async (path, requestOptions) => {
      if (path.includes('/rows?') && Number(new URLSearchParams(path.split('?')[1]).get('offset')) >= 400)
        await options.lastPage;
      return next(path, requestOptions);
    };
  }
  const session = await openDatabase(fixture.databaseId, deps);
  sessions.push(session);
  const onExpand = vi.fn();
  const onConfig = vi.fn<(patch: GridConfigPatch) => void>();
  if (options.role) vi.spyOn(session, 'role').mockReturnValue(options.role);
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
        timeZone: 'UTC',
        collaborators: current.collaborators,
        linked: session.linked,
      },
      canEdit: options.canEdit ?? true,
      onConfig: (patch) => {
        onConfig(patch);
        change(patch);
      },
      onExpand,
      ...(options.colors
        ? {
            colors: createViewColors({
              config: ColorConfig.parse(options.colors(ids)),
              fields,
              context: { timeZone: 'UTC' },
              ranges: new Map(),
              label: (rule) => rule.name,
            }),
          }
        : {}),
    };
    return (
      <>
        <ListSettings {...props} />
        <ListView {...props} />
      </>
    );
  }
  render(
    <I18nProvider i18n={setupI18n({ locale: 'en-US', messages: { 'en-US': {} } })}>
      <Harness />
    </I18nProvider>,
  );
  const tree = await screen.findByRole('tree', { name: 'Tasks' });
  if (options.waitForAllPages === false || options.lastPage)
    await screen.findByRole('treeitem', { name: /^Task 1(?: |$)/ });
  else await waitFor(() => expect(tree.getAttribute('aria-busy')).toBeNull());
  return { server, fixture, session, run, onExpand, onConfig, ids, tree };
}

function item(name: string | RegExp): HTMLElement {
  return screen.getByRole('treeitem', {
    name:
      typeof name === 'string'
        ? (accessibleName) => accessibleName === name || accessibleName.startsWith(`${name} `)
        : name,
  });
}
function names(): string[] {
  return screen
    .getAllByRole('treeitem')
    .sort((a, b) => parseFloat(a.style.insetBlockStart) - parseFloat(b.style.insetBlockStart))
    .map(
      (line) =>
        line.getAttribute('aria-label') ?? line.querySelector('.rio-list-view__title')?.textContent ?? '',
    );
}
/** The commands of a call to `run`, by kind. */
function kinds(run: ReturnType<typeof vi.spyOn>, call = -1): string[] {
  return (run.mock.calls.at(call)![0] as Array<{ kind: string }>).map((command) => command.kind);
}
/** The place a call to `run` moved a record to in the list's own order. */
function moved(run: ReturnType<typeof vi.spyOn>, call = -1) {
  const commands = run.mock.calls.at(call)![0] as Array<{
    kind: string;
    recordIds?: string[];
    place?: unknown;
  }>;
  const move = commands.find((command) => command.kind === 'record.move');
  return move ? { recordIds: move.recordIds, place: move.place } : null;
}
function sent(run: ReturnType<typeof vi.spyOn>, call = -1) {
  const commands = run.mock.calls.at(call)![0] as Array<{
    kind: string;
    records?: Array<{ id: string; values: Record<string, unknown> }>;
  }>;
  expect(commands[0]!.kind).toBe('record.update');
  return commands[0]!.records![0]!;
}
/** Drags a line's body onto the line at `to`, halfway down it unless `offset` says otherwise. */
function drag(line: HTMLElement, to: number, offset = 0.5) {
  const surface = line;
  const from = parseFloat(line.style.insetBlockStart) + LINE_HEIGHT / 2;
  const y = to * LINE_HEIGHT + LINE_HEIGHT * offset;
  fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 20, clientY: from });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 20, clientY: (from + y) / 2 });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 20, clientY: y });
  fireEvent.pointerUp(window, { pointerId: 1, clientX: 20, clientY: y });
}

describe('list layouts', () => {
  it('starts a new list with no groups, showing three fields on each line', () => {
    const table = { primaryFieldId: 'fld00000000000009' } as never;
    expect(VIEW_DEFINITIONS.list.initialConfig(table, [])).toEqual({});
    expect(GridConfig.parse(VIEW_DEFINITIONS.list.initialConfig(table, [])).list).toEqual({
      groupFieldId: null,
      parentFieldId: null,
      visibleFieldCount: LIST_FIELD_COUNT.default,
    });
  });

  it('shows records in the view’s order with their fields, and opens one on a click or Enter', async () => {
    const { onExpand, ids } = await mount({
      sorts: (f) => [{ fieldId: f.number, direction: 'desc' }],
      values: (index, f) => ({ [f.status]: index === 0 ? choices.build : null }),
      list: { visibleFieldCount: 2 },
    });
    expect(names()).toEqual(['Task 3', 'Task 2', 'Task 1']);
    const first = item('Task 1');
    expect(first.getAttribute('aria-level')).toBe('1');
    expect(first.getAttribute('aria-posinset')).toBe('3');
    expect(first.getAttribute('aria-setsize')).toBe('3');
    // The line's fields describe it: the number, then the status.
    const fields = document.getElementById(first.getAttribute('aria-describedby')!)!;
    expect(fields.textContent?.trim()).toBe('Number: 0 Status: Build');
    await userEvent.click(first);
    expect(onExpand).toHaveBeenLastCalledWith(ids.record(0));
    item('Task 2').focus();
    await userEvent.keyboard('{Enter}');
    expect(onExpand).toHaveBeenLastCalledWith(ids.record(1));
  });

  it('draws only the lines in sight of 10,000 records, and more as it scrolls', async () => {
    const { tree } = await mount({ count: 10_000 });
    const drawn = screen.getAllByRole('treeitem');
    expect(drawn.length).toBeLessThan(40);
    expect(item('Task 1').getAttribute('aria-setsize')).toBe('10000');
    expect(screen.queryByRole('treeitem', { name: /^Task 5001(?: |$)/ })).toBeNull();
    act(() => {
      tree.scrollTop = 5000 * LINE_HEIGHT;
      fireEvent.scroll(tree);
    });
    expect(await screen.findByRole('treeitem', { name: /^Task 5001(?: |$)/ })).toBeTruthy();
    expect(screen.getAllByRole('treeitem').length).toBeLessThan(40);
    expect(screen.queryByRole('treeitem', { name: /^Task 1(?: |$)/ })).toBeNull();
  });

  it('keeps End focused on its record after a pending page arrives', async () => {
    let release!: () => void;
    const lastPage = new Promise<void>((resolve) => {
      release = resolve;
    });
    await mount({ count: 500, lastPage });
    item('Task 1').focus();
    await userEvent.keyboard('{End}');
    await act(async () => {
      release();
    });
    const last = await screen.findByRole('treeitem', { name: /^Task 500(?: |$)/ });
    await waitFor(() => expect(document.activeElement).toBe(last));
  });

  it('restores a virtualized line when the browser drops focus during scrolling', async () => {
    const { ids } = await mount({ count: 500 });
    const focus = HTMLElement.prototype.focus;
    let lost = false;
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options) {
      focus.call(this, options);
      if (!lost && this.dataset.line === ids.record(499)) {
        lost = true;
        this.blur();
      }
    });
    item('Task 1').focus();
    await userEvent.keyboard('{End}');
    await waitFor(() => expect(document.activeElement).toBe(item('Task 500')));
    expect(lost).toBe(true);
  });

  it('groups by a single select in the option order, with counts, and collapses groups', async () => {
    const statuses = [choices.launch, choices.design, null, choices.design, 'cho00000000000099'];
    await mount({
      count: 5,
      values: (index, f) => ({ [f.status]: statuses[index] ?? null }),
      list: (f) => ({ groupFieldId: f.status }),
    });
    expect(names()).toEqual([
      'Design, 2 records',
      'Task 2',
      'Task 4',
      'Launch, 1 record',
      'Task 1',
      'No Status, 2 records',
      'Task 3',
      'Task 5',
    ]);
    const design = item('Design, 2 records');
    expect(design.getAttribute('aria-expanded')).toBe('true');
    expect(design.getAttribute('aria-level')).toBe('1');
    expect(item('Task 4').getAttribute('aria-level')).toBe('2');
    expect(item('Task 4').getAttribute('aria-posinset')).toBe('2');
    await userEvent.click(design);
    expect(design.getAttribute('aria-expanded')).toBe('false');
    expect(names().slice(0, 3)).toEqual(['Design, 2 records', 'Launch, 1 record', 'Task 1']);
    design.focus();
    await userEvent.keyboard('{Enter}');
    expect(names().slice(0, 2)).toEqual(['Design, 2 records', 'Task 2']);
  });

  it('groups by people and puts a record with two people in each one’s group', async () => {
    await mount({
      values: (index, f) => ({ [f.owners]: [[f.grace], [f.ada, f.grace], null][index] ?? null }),
      list: (f) => ({ groupFieldId: f.owners }),
    });
    expect(names()).toEqual([
      'A: Ada, 1 record',
      'Task 2',
      'G: Grace, 2 records',
      'Task 1',
      'Task 2',
      'No Owners, 1 record',
      'Task 3',
    ]);
  });

  it('nests records under their parents as an outline that opens and closes', async () => {
    // 1 holds 2 and 4, 2 holds 3, and 5 and 6 name each other, which the list breaks at 5.
    const parents = [null, 0, 1, 0, 5, 4];
    await mount({
      count: 6,
      values: (index, f) => {
        const parent = parents[index];
        return { [f.parent]: parent === null || parent === undefined ? null : [f.record(parent)] };
      },
      list: (f) => ({ parentFieldId: f.parent }),
    });
    expect(names()).toEqual(['Task 1', 'Task 2', 'Task 3', 'Task 4', 'Task 5', 'Task 6']);
    const levels = ['Task 1', 'Task 2', 'Task 3', 'Task 4', 'Task 5', 'Task 6'].map((name) =>
      item(name).getAttribute('aria-level'),
    );
    expect(levels).toEqual(['1', '2', '3', '2', '1', '2']);
    expect(item('Task 1').getAttribute('aria-expanded')).toBe('true');
    expect(item('Task 3').getAttribute('aria-expanded')).toBeNull();
    expect(item('Task 4').getAttribute('aria-posinset')).toBe('2');
    expect(item('Task 4').getAttribute('aria-setsize')).toBe('2');
    item('Task 2').focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(item('Task 2').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('treeitem', { name: /^Task 3(?: |$)/ })).toBeNull();
    await userEvent.keyboard('{ArrowRight}');
    expect(item('Task 3')).toBeTruthy();
    // The toggle beside a record opens and closes it with a click, without opening the record.
    const toggle = item('Task 1').querySelector('.rio-list-view__toggle')!;
    await userEvent.click(toggle);
    expect(names()).toEqual(['Task 1', 'Task 5', 'Task 6']);
  });
});

describe('list keyboard', () => {
  it('keeps keyboard focus when a paged placeholder becomes a record', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await mount({
      count: 500,
      waitForAllPages: false,
      http: (next) => async (path, options) => {
        const url = new URL(path, 'https://example.test');
        if (url.pathname.endsWith('/rows') && Number(url.searchParams.get('offset')) > 0) await gate;
        return next(path, options);
      },
    });
    try {
      item('Task 1').focus();
      await userEvent.keyboard('{End}');
      const placeholder = screen
        .getAllByRole('treeitem', { name: 'Loading record' })
        .find((node) => node.getAttribute('aria-posinset') === '500');
      expect(placeholder).toBeTruthy();
      expect(document.activeElement).toBe(placeholder);
      act(() => release());
      await waitFor(() => expect(document.activeElement).toBe(item('Task 500')));
    } finally {
      release();
    }
  });

  it('moves like a tree: up and down, home and end, and into groups and back out', async () => {
    await mount({
      values: (index, f) => ({ [f.status]: [choices.design, choices.build, choices.design][index] ?? null }),
      list: (f) => ({ groupFieldId: f.status }),
    });
    const design = item('Design, 2 records');
    expect(design.tabIndex).toBe(0);
    design.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(item('Task 1'));
    expect(item('Task 1').tabIndex).toBe(0);
    expect(design.tabIndex).toBe(-1);
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(item('Task 3'));
    await userEvent.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(design);
    await userEvent.keyboard('{ArrowLeft}');
    expect(design.getAttribute('aria-expanded')).toBe('false');
    await userEvent.keyboard('{End}');
    expect(document.activeElement).toBe(item('Task 2'));
    await userEvent.keyboard('{Home}');
    expect(document.activeElement).toBe(design);
    await userEvent.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(design);
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(item('Build, 1 record'));
  });

  it('swaps left and right when the page reads right to left', async () => {
    await mount({
      values: (index, f) => ({ [f.status]: [choices.design, choices.build, choices.design][index] ?? null }),
      list: (f) => ({ groupFieldId: f.status }),
    });
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
      const style = real(element, pseudo);
      return new Proxy(style, {
        get(target, key) {
          if (key === 'direction') return 'rtl';
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
    const design = item('Design, 2 records');
    design.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(design.getAttribute('aria-expanded')).toBe('false');
    await userEvent.keyboard('{ArrowLeft}');
    expect(design.getAttribute('aria-expanded')).toBe('true');
    await userEvent.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(item('Task 1'));
  });

  it('edits the first field in place with F2, saving with Enter and canceling with Escape', async () => {
    const { run, ids } = await mount();
    const line = item('Task 2');
    line.focus();
    await userEvent.keyboard('{F2}');
    const input = screen.getByRole('textbox', { name: 'Name' });
    expect((input as HTMLInputElement).value).toBe('Task 2');
    expect(document.activeElement).toBe(input);
    await userEvent.clear(input);
    await userEvent.type(input, 'Write the brief{Enter}');
    expect(sent(run)).toEqual({ id: ids.record(1), values: { [ids.name]: 'Write the brief' } });
    expect(await screen.findByRole('treeitem', { name: /^Write the brief(?: |$)/ })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(item('Write the brief')));
    const calls = run.mock.calls.length;
    await userEvent.keyboard('{F2}');
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), ' again{Escape}');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(run.mock.calls.length).toBe(calls);
    expect(document.activeElement).toBe(item('Write the brief'));
  });

  it('saves an edit when the focus leaves, and edits from the pencil without opening the record', async () => {
    const { run, ids, onExpand } = await mount();
    const pencil = item('Task 1').querySelector('.rio-list-view__edit')!;
    await userEvent.click(pencil);
    expect(onExpand).not.toHaveBeenCalled();
    const input = screen.getByRole('textbox', { name: 'Name' });
    await userEvent.clear(input);
    await userEvent.type(input, 'Draft the plan');
    await userEvent.click(screen.getByRole('button', { name: 'New record' }));
    expect(run.mock.calls[0]![0]).toEqual([
      {
        kind: 'record.update',
        tableId: expect.any(String),
        records: [{ id: ids.record(0), values: { [ids.name]: 'Draft the plan' } }],
      },
    ]);
  });
});

describe('moving records', () => {
  it('moves a record to another group with Alt and the arrow keys, keeping its focus', async () => {
    const { run, ids } = await mount({
      values: (index, f) => ({ [f.status]: [choices.design, choices.build, choices.launch][index] ?? null }),
      list: (f) => ({ groupFieldId: f.status }),
    });
    item('Task 1').focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(sent(run)).toEqual({ id: ids.record(0), values: { [ids.status]: choices.build } });
    await waitFor(() =>
      expect(names()).toEqual(['Build, 2 records', 'Task 1', 'Task 2', 'Launch, 1 record', 'Task 3']),
    );
    await waitFor(() => expect(document.activeElement).toBe(item('Task 1')));
    expect(screen.getByRole('status').textContent).toBe('Moved to Build');
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    // Design is gone now that it's empty, so there's no group above Build.
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('drags a record into another group, leaving its other people alone', async () => {
    const { run, ids } = await mount({
      values: (index, f) => ({ [f.owners]: [[f.ada, f.grace], [f.grace], null][index] ?? null }),
      list: (f) => ({ groupFieldId: f.owners }),
    });
    expect(names()).toEqual([
      'A: Ada, 1 record',
      'Task 1',
      'G: Grace, 2 records',
      'Task 1',
      'Task 2',
      'No Owners, 1 record',
      'Task 3',
    ]);
    // Task 2 moves from Grace to Ada, dropped on Ada's header.
    drag(screen.getAllByRole('treeitem', { name: /^Task 2(?: |$)/ })[0]!, 0);
    expect(sent(run)).toEqual({ id: ids.record(1), values: { [ids.owners]: [ids.ada] } });
    // Task 1 moves out of Ada's group into the empty one, and stays with Grace.
    await waitFor(() => expect(names()[0]).toBe('A: Ada, 2 records'));
    drag(screen.getAllByRole('treeitem', { name: /^Task 1(?: |$)/ })[0]!, 6);
    expect(sent(run)).toEqual({ id: ids.record(0), values: { [ids.owners]: [ids.grace] } });
  });

  it('ignores a drop in the same group of a sorted list, and a click after a drag doesn’t open the record', async () => {
    const { run, onExpand } = await mount({
      values: (_, f) => ({ [f.status]: choices.design }),
      list: (f) => ({ groupFieldId: f.status }),
      sorts: (f) => [{ fieldId: f.number, direction: 'asc' }],
    });
    const line = item('Task 1');
    drag(line, 3);
    fireEvent.click(line);
    expect(run).not.toHaveBeenCalled();
    expect(onExpand).not.toHaveBeenCalled();
  });

  it('nests under the record above with Alt and right, and moves out a level with Alt and left', async () => {
    const { run, ids } = await mount({ list: (f) => ({ parentFieldId: f.parent }) });
    item('Task 2').focus();
    await userEvent.keyboard('{Alt>}{ArrowRight}{/Alt}');
    expect(sent(run)).toEqual({ id: ids.record(1), values: { [ids.parent]: [ids.record(0)] } });
    await waitFor(() => expect(item('Task 2').getAttribute('aria-level')).toBe('2'));
    expect(screen.getByRole('status').textContent).toBe('Nested under Task 1');
    await waitFor(() => expect(document.activeElement).toBe(item('Task 2')));
    await userEvent.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(sent(run)).toEqual({ id: ids.record(1), values: { [ids.parent]: null } });
    await waitFor(() => expect(item('Task 2').getAttribute('aria-level')).toBe('1'));
    expect(screen.getByRole('status').textContent).toBe('Moved to the top level');
  });

  it('nests by dropping on a record’s middle, and moves beside one by dropping on its edge', async () => {
    const { run, ids } = await mount({
      count: 4,
      values: (index, f) => ({ [f.parent]: index === 3 ? [f.record(2)] : null }),
      list: (f) => ({ parentFieldId: f.parent }),
    });
    expect(names()).toEqual(['Task 1', 'Task 2', 'Task 3', 'Task 4']);
    drag(item('Task 1'), 1);
    expect(sent(run)).toEqual({ id: ids.record(0), values: { [ids.parent]: [ids.record(1)] } });
    await waitFor(() => expect(item('Task 1').getAttribute('aria-level')).toBe('2'));
    expect(names()).toEqual(['Task 2', 'Task 1', 'Task 3', 'Task 4']);
    // Dropped near Task 4's top edge, Task 2 joins it under Task 3, bringing Task 1 along.
    drag(item('Task 2'), 3, 0.1);
    expect(sent(run)).toEqual({ id: ids.record(1), values: { [ids.parent]: [ids.record(2)] } });
    await waitFor(() => expect(names()).toEqual(['Task 3', 'Task 2', 'Task 1', 'Task 4']));
    expect(item('Task 1').getAttribute('aria-level')).toBe('3');
    // A record can't go under anything nested under it, so that drop does nothing.
    const calls = run.mock.calls.length;
    drag(item('Task 3'), names().indexOf('Task 4'));
    expect(run.mock.calls.length).toBe(calls);
  });

  it('lets readers look, but not edit or move', async () => {
    const { run, onExpand } = await mount({
      canEdit: false,
      role: 'reader',
      values: (_, f) => ({ [f.status]: choices.design }),
      list: (f) => ({ groupFieldId: f.status }),
    });
    const line = item('Task 1');
    expect(line.hasAttribute('data-movable')).toBe(false);
    expect(line.querySelector('.rio-list-view__edit')).toBeNull();
    line.focus();
    await userEvent.keyboard('{F2}');
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(run).not.toHaveBeenCalled();
    // Nothing a reader could press to change the list is offered at all.
    expect(screen.queryByRole('button', { name: 'New record' })).toBeNull();
    await userEvent.keyboard('{Enter}');
    expect(onExpand).toHaveBeenCalled();
  });

  it('lets editors edit and move records, but not change the list’s settings', async () => {
    const { run, ids } = await mount({
      canEdit: false,
      role: 'editor',
      values: (_, f) => ({ [f.status]: choices.design }),
      list: (f) => ({ groupFieldId: f.status, parentFieldId: null }),
    });
    const line = item('Task 1');
    expect(line.hasAttribute('data-movable')).toBe(true);
    line.focus();
    await userEvent.keyboard('{F2}');
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), ' notes{Enter}');
    expect(sent(run)).toEqual({ id: ids.record(0), values: { [ids.name]: 'Task 1 notes' } });
    await userEvent.click(screen.getByRole('button', { name: 'List settings' }));
    expect(screen.getByRole('button', { name: /Group by/ }).hasAttribute('disabled')).toBe(true);
  });

  it('adds a new record just after the active one, in its group', async () => {
    const { run, ids, onExpand } = await mount({
      values: (index, f) => ({ [f.status]: [choices.design, choices.build, choices.design][index] ?? null }),
      list: (f) => ({ groupFieldId: f.status }),
    });
    item('Task 1').focus();
    await userEvent.click(screen.getByRole('button', { name: 'New record' }));
    const [commands, options] = run.mock.calls[0]!;
    const created = commands[0] as { kind: string; records: RowData[] };
    expect(created.kind).toBe('record.create');
    expect(created.records[0]!.values).toEqual({ [ids.status]: choices.design });
    expect(options).toEqual({ placeAt: { viewId: expect.any(String), index: 1 } });
    // The list's own order keeps it there once the order is read again.
    expect(moved(run)).toEqual({ recordIds: [created.records[0]!.id], place: { after: ids.record(0) } });
    expect(onExpand).toHaveBeenCalledWith(created.records[0]!.id);
    await waitFor(() =>
      expect(names().slice(0, 4)).toEqual(['Design, 3 records', 'Task 1', 'Untitled record', 'Task 3']),
    );
  });
});

describe('the list’s own order', () => {
  it('drags a record just before or after another, marking the spot on the way', async () => {
    const { run, ids } = await mount({ count: 4 });
    expect(names()).toEqual(['Task 1', 'Task 2', 'Task 3', 'Task 4']);
    const surface = item('Task 1');
    const y = 2 * LINE_HEIGHT + LINE_HEIGHT * 0.8;
    fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 20, clientY: LINE_HEIGHT / 2 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 20, clientY: y });
    expect(item('Task 3').querySelector('.rio-list-view__drop')?.getAttribute('data-side')).toBe('after');
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 20, clientY: y });
    expect(kinds(run)).toEqual(['record.move']);
    expect(moved(run)).toEqual({ recordIds: [ids.record(0)], place: { after: ids.record(2) } });
    await waitFor(() => expect(names()).toEqual(['Task 2', 'Task 3', 'Task 1', 'Task 4']));
    expect(screen.getByRole('status').textContent).toBe('Moved after Task 3');
    // Dropped on the upper half of a record, it goes just before it.
    drag(item('Task 4'), 0, 0.2);
    expect(moved(run)).toEqual({ recordIds: [ids.record(3)], place: { before: ids.record(1) } });
    await waitFor(() => expect(names()).toEqual(['Task 4', 'Task 2', 'Task 3', 'Task 1']));
    // Dropping a record where it already is changes nothing.
    const calls = run.mock.calls.length;
    drag(item('Task 2'), 2, 0.2);
    expect(run.mock.calls.length).toBe(calls);
  });

  it('moves the focused record up and down with Alt and the arrow keys', async () => {
    const { run, ids } = await mount();
    item('Task 2').focus();
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(moved(run)).toEqual({ recordIds: [ids.record(1)], place: { before: ids.record(0) } });
    await waitFor(() => expect(names()).toEqual(['Task 2', 'Task 1', 'Task 3']));
    await waitFor(() => expect(document.activeElement).toBe(item('Task 2')));
    expect(screen.getByRole('status').textContent).toBe('Moved before Task 1');
    // At the top there's nowhere further up to go.
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(run).toHaveBeenCalledTimes(1);
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    await waitFor(() => expect(names()).toEqual(['Task 1', 'Task 2', 'Task 3']));
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(moved(run)).toEqual({ recordIds: [ids.record(1)], place: { after: ids.record(2) } });
    await waitFor(() => expect(names()).toEqual(['Task 1', 'Task 3', 'Task 2']));
    expect(item('Task 2').getAttribute('aria-keyshortcuts')).toContain('Alt+ArrowUp Alt+ArrowDown');
  });

  it('moves through the menu with the same saved commands and announcements', async () => {
    const { run, ids } = await mount();
    await userEvent.click(within(item('Task 2')).getByRole('button', { name: 'Arrange Task 2' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Move up' }));
    expect(moved(run)).toEqual({ recordIds: [ids.record(1)], place: { before: ids.record(0) } });
    await waitFor(() => expect(names()).toEqual(['Task 2', 'Task 1', 'Task 3']));
    expect(screen.getByRole('status').textContent).toBe('Moved before Task 1');
    await userEvent.click(within(item('Task 2')).getByRole('button', { name: 'Arrange Task 2' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Move to' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Task 3' }));
    expect(moved(run)).toEqual({ recordIds: [ids.record(1)], place: { after: ids.record(2) } });
    await waitFor(() => expect(names()).toEqual(['Task 1', 'Task 3', 'Task 2']));
  });

  it('moves a record within its group, and on into the next group from its end', async () => {
    const { run, ids } = await mount({
      values: (index, f) => ({ [f.status]: [choices.design, choices.design, choices.build][index] ?? null }),
      list: (f) => ({ groupFieldId: f.status }),
    });
    expect(names()).toEqual(['Design, 2 records', 'Task 1', 'Task 2', 'Build, 1 record', 'Task 3']);
    item('Task 1').focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(kinds(run)).toEqual(['record.move']);
    expect(moved(run)).toEqual({ recordIds: [ids.record(0)], place: { after: ids.record(1) } });
    await waitFor(() => expect(names().slice(0, 3)).toEqual(['Design, 2 records', 'Task 2', 'Task 1']));
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(kinds(run)).toEqual(['record.update', 'record.move']);
    expect(sent(run)).toEqual({ id: ids.record(0), values: { [ids.status]: choices.build } });
    expect(moved(run)).toEqual({ recordIds: [ids.record(0)], place: { before: ids.record(2) } });
    await waitFor(() =>
      expect(names()).toEqual(['Design, 1 record', 'Task 2', 'Build, 2 records', 'Task 1', 'Task 3']),
    );
    expect(screen.getByRole('status').textContent).toBe('Moved to Build');
  });

  it('drags a record to another place in its group, and beside a record in another group', async () => {
    const { run, ids } = await mount({
      count: 4,
      values: (index, f) => ({
        [f.status]: [choices.design, choices.design, choices.build, choices.build][index] ?? null,
      }),
      list: (f) => ({ groupFieldId: f.status }),
    });
    expect(names()).toEqual([
      'Design, 2 records',
      'Task 1',
      'Task 2',
      'Build, 2 records',
      'Task 3',
      'Task 4',
    ]);
    drag(item('Task 1'), 2, 0.8);
    expect(kinds(run)).toEqual(['record.move']);
    expect(moved(run)).toEqual({ recordIds: [ids.record(0)], place: { after: ids.record(1) } });
    await waitFor(() => expect(names().slice(0, 3)).toEqual(['Design, 2 records', 'Task 2', 'Task 1']));
    // Dropped on the upper half of Task 4, Task 2 changes group and lands just before it.
    drag(item('Task 2'), 5, 0.2);
    expect(kinds(run)).toEqual(['record.update', 'record.move']);
    expect(moved(run)).toEqual({ recordIds: [ids.record(1)], place: { before: ids.record(3) } });
    await waitFor(() =>
      expect(names()).toEqual([
        'Design, 1 record',
        'Task 1',
        'Build, 3 records',
        'Task 3',
        'Task 2',
        'Task 4',
      ]),
    );
  });

  it('follows its sort instead, and says why records can’t be dragged into an order', async () => {
    const { run } = await mount({ sorts: (f) => [{ fieldId: f.number, direction: 'desc' }] });
    expect(names()).toEqual(['Task 3', 'Task 2', 'Task 1']);
    const hint = screen.getByText(/This list follows its sort/);
    expect(screen.getByRole('tree').getAttribute('aria-describedby')).toContain(hint.id);
    expect(item('Task 1').hasAttribute('data-movable')).toBe(false);
    item('Task 1').focus();
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(run).not.toHaveBeenCalled();
  });

  it('reads the list’s order again when a move is undone', async () => {
    const { run, session } = await mount();
    item('Task 3').focus();
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    await waitFor(() => expect(names()).toEqual(['Task 1', 'Task 3', 'Task 2']));
    await (run.mock.results.at(-1)!.value as ActionHandle).done;
    await act(async () => {
      await session.undo();
    });
    await waitFor(() => expect(names()).toEqual(['Task 1', 'Task 2', 'Task 3']), { timeout: 4_000 });
  });
});

describe('list colors', () => {
  it('marks a record’s line and paints its values from the view’s color rules', async () => {
    await mount({
      colors: (f) => ({
        colorRules: [
          {
            id: 'late',
            name: 'Late',
            target: 'record',
            condition: { id: 'c1', fieldId: f.number, operator: 'gt', value: 1 },
            color: 'red',
          },
          {
            id: 'first',
            name: 'First',
            target: 'cell',
            condition: { id: 'c2', fieldId: f.name, operator: 'is', value: 'Task 1' },
            color: 'green',
          },
        ],
      }),
    });
    const described = (line: HTMLElement) =>
      (line.getAttribute('aria-describedby') ?? '')
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent ?? '');
    const late = item('Task 3');
    const edge = late.querySelector<HTMLElement>('.rio-list-view__color')!;
    expect(edge.style.getPropertyValue('--rio-list-view-color')).toBe('var(--rio-aa-choice-red)');
    expect(described(late)[0]).toBe('Late');
    expect(item('Task 2').querySelector('.rio-list-view__color')).toBeNull();
    // A cell rule paints the value it colors, and screen readers hear its name too.
    const first = item('Task 1');
    expect(first.querySelector('.rio-list-view__title .rio-color-value.rio-color-fill')).not.toBeNull();
    expect(described(first)[0]).toBe('First');
  });
});

describe('list settings', () => {
  it('saves the group, the parent, and the fields shown, and grouping and nesting take turns', async () => {
    const { onConfig, ids } = await mount();
    await userEvent.click(screen.getByRole('button', { name: 'List settings' }));
    await userEvent.click(screen.getByRole('button', { name: /Group by/ }));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'None',
      'Status',
      'Owners',
      'Parent',
    ]);
    await userEvent.click(screen.getByRole('option', { name: 'Status' }));
    expect(onConfig).toHaveBeenLastCalledWith({
      list: { groupFieldId: ids.status, parentFieldId: null, visibleFieldCount: LIST_FIELD_COUNT.default },
    });
    expect(await screen.findByRole('treeitem', { name: 'No Status, 3 records' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Nest by/ }));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['None', 'Parent']);
    await userEvent.click(screen.getByRole('option', { name: 'Parent' }));
    expect(onConfig).toHaveBeenLastCalledWith({
      list: { groupFieldId: null, parentFieldId: ids.parent, visibleFieldCount: LIST_FIELD_COUNT.default },
    });
    await userEvent.click(screen.getByRole('button', { name: /Fields on each line/ }));
    await userEvent.click(screen.getByRole('option', { name: 'None' }));
    expect(onConfig).toHaveBeenLastCalledWith({
      list: { groupFieldId: null, parentFieldId: ids.parent, visibleFieldCount: 0 },
    });
    expect(item('Task 1').getAttribute('aria-describedby')).toBeNull();
  });

  it('disables the settings for people who can’t change the view', async () => {
    await mount({ canEdit: false });
    await userEvent.click(screen.getByRole('button', { name: 'List settings' }));
    const panel = screen.getByRole('dialog', { name: 'List settings' });
    for (const button of within(panel).getAllByRole('button'))
      expect(button.hasAttribute('disabled')).toBe(true);
  });
});

describe('list model', () => {
  const field = (id: string, type: string, options: Record<string, unknown> = {}) =>
    ({ id, type, options, tableId: 'tbl00000000000001' }) as unknown as FieldMeta;
  const parent = field('fldparent0000001', 'link', { linkedTableId: 'tbl00000000000001' });
  const row = (id: string, values: Record<string, CellValue> = {}): RowData => ({
    id,
    values,
    createdAt: '',
    createdBy: null,
    updatedAt: '',
    updatedBy: null,
  });
  const outline: ListMode = { kind: 'outline', field: parent };

  it('breaks a loop of parents at its first record in the view’s order, and ignores parents outside it', () => {
    const rows = [
      row('recaaaaaaaaaaaaa', { [parent.id]: ['recbbbbbbbbbbbbb'] }),
      row('recbbbbbbbbbbbbb', { [parent.id]: ['recaaaaaaaaaaaaa'] }),
      row('reccccccccccccc0', { [parent.id]: ['recnotintheview0', 'recbbbbbbbbbbbbb'] }),
      row('recdddddddddddd0', { [parent.id]: ['recdddddddddddd0'] }),
    ];
    const model = listModel(rows, outline, new Set(), (keys) => keys);
    expect(model.lines.map((line) => [line.key, line.level])).toEqual([
      ['recaaaaaaaaaaaaa', 1],
      ['recbbbbbbbbbbbbb', 2],
      ['reccccccccccccc0', 3],
      ['recdddddddddddd0', 1],
    ]);
    expect(nestedWithin(model, 'reccccccccccccc0', 'recaaaaaaaaaaaaa')).toBe(true);
    expect(nestedWithin(model, 'recaaaaaaaaaaaaa', 'reccccccccccccc0')).toBe(false);
    const lines = model.lines as RecordLine[];
    // Nesting a record under one nested under it would make a loop, so it goes nowhere.
    expect(destinationAt(model, lines[0]!, lines[2]!, 0.5)).toBeNull();
    expect(destinationAt(model, lines[2]!, lines[3]!, 0.5)).toEqual({
      kind: 'parent',
      parent: 'recdddddddddddd0',
    });
    expect(destinationAt(model, lines[2]!, lines[3]!, 0.1)).toEqual({ kind: 'parent', parent: null });
    expect(destinationAt(model, lines[2]!, lines[1]!, 0.9)).toEqual({
      kind: 'parent',
      parent: 'recaaaaaaaaaaaaa',
    });
  });

  it('steps a record past its sibling, and into the next group from either end', () => {
    const select = field('fldselect0000001', 'singleSelect', {
      choices: [
        { id: 'cho1', name: 'One', color: 'blue' },
        { id: 'cho2', name: 'Two', color: 'green' },
      ],
    });
    const rows = [
      row('recaaaaaaaaaaaaa', { [select.id]: 'cho1' }),
      row('recbbbbbbbbbbbbb', { [select.id]: 'cho1' }),
      row('reccccccccccccc0', { [select.id]: 'cho2' }),
    ];
    const model = listModel(rows, { kind: 'group', field: select }, new Set(), (keys) => keys);
    const line = (key: string) => model.lines.find((each) => each.key === key) as RecordLine;
    const a = line('cho1/recaaaaaaaaaaaaa');
    const b = line('cho1/recbbbbbbbbbbbbb');
    const c = line('cho2/reccccccccccccc0');
    expect(stepDestination(model, a, 1, true)).toEqual({
      kind: 'order',
      place: { after: 'recbbbbbbbbbbbbb' },
    });
    expect(stepDestination(model, b, 1, true)).toEqual({
      kind: 'group',
      group: 'cho2',
      place: { before: 'reccccccccccccc0' },
    });
    expect(stepDestination(model, b, 1, false)).toBeNull();
    expect(stepDestination(model, c, -1, true)).toEqual({
      kind: 'group',
      group: 'cho1',
      place: { after: 'recbbbbbbbbbbbbb' },
    });
    expect(stepDestination(model, c, 1, true)).toBeNull();
    // Dropped on a record in its own group, a record goes beside it only while the list keeps its order.
    expect(destinationAt(model, a, b, 0.9, true)).toEqual({
      kind: 'order',
      place: { after: 'recbbbbbbbbbbbbb' },
    });
    expect(destinationAt(model, a, b, 0.9, false)).toBeNull();
    expect(destinationAt(model, b, a, 0.9, true)).toBeNull();
    expect(destinationAt(model, a, c, 0.1, true)).toEqual({
      kind: 'group',
      group: 'cho2',
      place: { before: 'reccccccccccccc0' },
    });
    expect(destinationAt(model, a, c, 0.1, false)).toEqual({ kind: 'group', group: 'cho2' });
  });

  it('writes moves into the values each field type holds', () => {
    const single = field('fldsingle0000001', 'user', { allowMultiple: false });
    const people = field('fldpeople0000001', 'user', { allowMultiple: true });
    const select = field('fldselect0000001', 'singleSelect', { choices: [] });
    const linked = field('fldlinked0000001', 'link', {
      linkedTableId: 'tbl00000000000002',
      prefersSingle: false,
    });
    const one = row('recaaaaaaaaaaaaa', {
      [people.id]: ['usr1', 'usr2'],
      [single.id]: ['usr1'],
      [linked.id]: ['recx', 'recy'],
      [parent.id]: ['recp', 'recq'],
    });
    expect(groupValues(one, select, 'cho1', 'cho2')).toEqual({ [select.id]: 'cho2' });
    expect(groupValues(one, select, 'cho1', EMPTY_GROUP)).toEqual({ [select.id]: null });
    expect(groupValues(one, people, 'usr1', 'usr3')).toEqual({ [people.id]: ['usr2', 'usr3'] });
    expect(groupValues(one, people, 'usr2', 'usr1')).toEqual({ [people.id]: ['usr1'] });
    expect(groupValues(one, people, 'usr1', EMPTY_GROUP)).toEqual({ [people.id]: ['usr2'] });
    expect(groupValues(one, single, 'usr1', 'usr2')).toEqual({ [single.id]: ['usr2'] });
    expect(groupValues(one, single, 'usr1', EMPTY_GROUP)).toEqual({ [single.id]: null });
    expect(groupValues(one, linked, EMPTY_GROUP, 'recz')).toEqual({ [linked.id]: ['recx', 'recy', 'recz'] });
    expect(parentValues(one, parent, 'recp', 'recr')).toEqual({ [parent.id]: ['recr', 'recq'] });
    expect(parentValues(one, parent, 'recp', null)).toEqual({ [parent.id]: ['recq'] });
    expect(parentValues(row('recbbbbbbbbbbbbb'), parent, null, 'recp')).toEqual({ [parent.id]: ['recp'] });
  });
});

it('announces a keyboard move after canceling a row drag', async () => {
  await mount({ count: 3 });
  const node = item('Task 1');
  fireEvent.pointerDown(node, {
    button: 0,
    pointerId: 1,
    clientX: 20,
    clientY: 20,
  });
  fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 100, clientY: 60 });
  fireEvent.keyDown(node, { key: 'Escape' });
  fireEvent.pointerUp(window, { pointerId: 1 });
  expect(screen.getByRole('status').textContent).toBe('Move canceled.');
  fireEvent.keyDown(node, { key: 'ArrowDown', altKey: true });
  expect(screen.getByRole('status').textContent).toContain('Moved');
});

it('includes visible record values in the row name', async () => {
  await mount({ count: 1 });
  const row = screen.getByRole('treeitem', { name: /^Task 1 0/ });
  expect(row.querySelector('.rio-list-view__fields')?.textContent).toContain('0');
  const visible = row.cloneNode(true) as HTMLElement;
  visible.querySelectorAll('.rio-list-view__sr-only, [aria-hidden="true"]').forEach((node) => node.remove());
  expect(visible.textContent?.replace(/\s+/g, ' ').trim()).toBe('Task 1 0');
});

/** The row's name as its aria-labelledby reads it, one referenced part at a time. */
function spokenName(row: HTMLElement): string {
  return (row.getAttribute('aria-labelledby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
    .filter(Boolean)
    .join(' ');
}

it('names a checked checkbox after the visible words in a row', async () => {
  await mount({
    count: 1,
    list: { visibleFieldCount: 4 },
    extraFields: [
      { name: 'Note', spec: { type: 'text', options: {} }, value: 'Alpha' },
      { name: 'Done', spec: { type: 'checkbox', options: {} }, value: true },
      { name: 'Tag', spec: { type: 'text', options: {} }, value: 'Beta' },
    ],
  });
  const row = screen.getByRole('treeitem', { name: /^Task 1/ });
  expect(spokenName(row)).toBe('Task 1 0 Alpha Beta checked');
  const labelledby = (row.getAttribute('aria-labelledby') ?? '').split(/\s+/);
  const checkAt = labelledby.findIndex((id) =>
    document.getElementById(id)?.querySelector('.rio-card-value--check[data-checked="true"]'),
  );
  expect(checkAt).toBe(labelledby.length - 1);
});

it('an unchecked checkbox adds no word to a row name', async () => {
  await mount({
    count: 1,
    list: { visibleFieldCount: 4 },
    extraFields: [
      { name: 'Note', spec: { type: 'text', options: {} }, value: 'Alpha' },
      { name: 'Done', spec: { type: 'checkbox', options: {} }, value: false },
      { name: 'Tag', spec: { type: 'text', options: {} }, value: 'Beta' },
    ],
  });
  const row = screen.getByRole('treeitem', { name: /^Task 1/ });
  expect(spokenName(row)).toBe('Task 1 0 Alpha Beta');
});
