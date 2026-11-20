import { useState, type ReactNode } from 'react';
import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ColorConfig,
  FieldMeta,
  GridConfig,
  newId,
  type GridConfigPatch,
  type RowData,
  type SessionInfo,
  type ViewMeta,
} from '@riosoma/contracts';
import type { ApiOptions } from '../../../../api';
import type { Http } from '../../../../data/deps';
import { openDatabase } from '../../../../data/session';
import { FakeServer } from '../../../../data/testing';
import type { DatabaseSession } from '../../../../data/types';
import { useSchema } from '../../../../data/hooks';
import { celebrations, type Celebration } from '../../../../features/celebrations/engine';
import { sessionQuery } from '../../../../session';
import type { ViewComponentProps } from '../types';
import { createViewColors } from '../../colors/paint';
import { PHONE_QUERY } from '../../../../shell/useMediaQuery';
import { KanbanSettings, KanbanView } from './index';
import { LONG_PRESS_MS } from './KanbanView';
import { compareCards, orderStacks, rowStack } from './model';

const sessions: DatabaseSession[] = [];
afterEach(() => {
  cleanup();
  for (const session of sessions.splice(0)) session.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const i18n = setupI18n({ locale: 'en', messages: { en: {} } });
const thumbnail =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY1sAAAAASUVORK5CYII=';
const ready = 'cho00000000000001',
  done = 'cho00000000000002',
  unused = 'cho00000000000003';

async function fixture(count = 3, person = false) {
  const server = new FakeServer();
  const fixture = server.createDatabase(count);
  const database = server.database(fixture.databaseId);
  const stackField = FieldMeta.parse({
    ...database.field(fixture.textFieldId),
    id: newId('field'),
    name: person ? 'Owner' : 'Status',
    position: 2,
    type: person ? 'user' : 'singleSelect',
    options: person
      ? { allowMultiple: false }
      : {
          choices: [
            { id: ready, name: 'Ready', color: 'blue' },
            { id: done, name: 'Done', color: 'green' },
            { id: unused, name: 'Later', color: 'gray' },
          ],
        },
  });
  const cover = FieldMeta.parse({
    ...stackField,
    id: newId('field'),
    name: 'Photo',
    position: 3,
    type: 'attachment',
    options: {},
  });
  database.schema.fields.push(stackField, cover);
  database.schema.collaborators = [
    { id: server.userId, name: 'Alex', email: 'alex@example.test' },
    { id: server.remoteUserId, name: 'Sam', email: 'sam@example.test' },
  ];
  const view = database.view(fixture.viewId);
  view.type = 'kanban';
  view.config = GridConfig.parse({
    kanban: { stackFieldId: stackField.id },
    sorts: [{ fieldId: fixture.numberFieldId, direction: 'asc' }],
  });
  for (let index = 0; index < count; index++) {
    const row = database.rows(fixture.tableId).get(fixture.recordId(index))!;
    row.values[stackField.id] =
      index === 2
        ? null
        : person
          ? [index === 0 ? server.userId : server.remoteUserId]
          : index === 1
            ? done
            : ready;
    database.rows(fixture.tableId).set(row);
  }
  const snapshots = new Map<string, string[]>();
  let serial = 0;
  const countsRequests: string[] = [];
  // The shared fake handles commands, undo, and realtime; these routes add its missing stack scope.
  const http: Http = async <T,>(path: string, options: ApiOptions = {}): Promise<T> => {
    const url = new URL(path, 'http://localhost');
    const isCounts = url.pathname.endsWith('/stacks');
    if (!isCounts && !(url.pathname.startsWith('/api/views/') && url.searchParams.has('stack')))
      return server.http<T>(path, options);
    server.requests.push({ path, options });
    await server.beforeRequest?.({ path, options });
    const ordered = database.viewOrder(database.view(fixture.viewId), 'UTC', Date.now());
    const records: RowData[] = [];
    for (let index = 0; index < ordered.total; index++) {
      const row = database.rows(fixture.tableId).get(ordered.idAt(index)!);
      if (row) records.push(row);
    }
    if (isCounts) {
      countsRequests.push(path);
      const counts = new Map<string, number>([
        [ready, 0],
        [done, 0],
        [unused, 0],
        ['', 0],
        [server.userId, 0],
        [server.remoteUserId, 0],
      ]);
      for (const row of records) {
        const stack = rowStack(row, stackField);
        counts.set(stack, (counts.get(stack) ?? 0) + 1);
      }
      return { stacks: [...counts].map(([id, count]) => ({ id, count })) } as T;
    }
    let snapshot = url.searchParams.get('snapshot') ?? '';
    if (!snapshots.has(snapshot) || url.searchParams.has('refresh')) {
      snapshot = `stack${++serial}`;
      snapshots.set(
        snapshot,
        records
          .filter((row) => rowStack(row, stackField) === url.searchParams.get('stack'))
          .map((row) => row.id),
      );
    }
    const ids = snapshots.get(snapshot)!;
    const offset = Number(url.searchParams.get('offset') ?? 0),
      limit = Number(url.searchParams.get('limit') ?? 200);
    if (url.pathname.endsWith('/position')) {
      const index = ids.indexOf(url.searchParams.get('recordId') ?? '');
      return { snapshot, total: ids.length, index: index < 0 ? null : index } as T;
    }
    return {
      snapshot,
      total: ids.length,
      offset,
      rebuilt: false,
      rows: ids.slice(offset, offset + limit).map((id) => database.rows(fixture.tableId).get(id) ?? null),
    } as T;
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (path: string, options?: RequestInit) =>
        new Response(JSON.stringify(await http(path, { signal: options?.signal ?? undefined })), {
          status: 200,
        }),
    ),
  );
  const session = await openDatabase(fixture.databaseId, server.deps({ http }));
  sessions.push(session);
  const schema = session.getSchema();
  const onConfig = vi.fn(),
    onExpand = vi.fn();
  const props: ViewComponentProps = {
    session,
    table: schema.tableById.get(fixture.tableId)!,
    view: schema.viewById.get(fixture.viewId)!,
    fields: schema.fields.get(fixture.tableId)!,
    format: { locale: 'en-US', timeZone: 'America/Los_Angeles', collaborators: schema.collaborators },
    canEdit: true,
    onConfig,
    onExpand,
  };
  return {
    ...fixture,
    server,
    database,
    session,
    props,
    stackField,
    cover,
    onConfig,
    onExpand,
    countsRequests,
  };
}

function mount(
  props: ViewComponentProps,
  settings = false,
  wrapper?: (props: { children: ReactNode }) => ReactNode,
) {
  function Harness() {
    const [view, setView] = useState<ViewMeta>(props.view);
    const onConfig = (patch: GridConfigPatch) => {
      props.onConfig(patch);
      setView((view) => ({ ...view, config: { ...view.config, ...patch } }));
    };
    return (
      <I18nProvider i18n={i18n}>
        {settings ? (
          <KanbanSettings {...props} view={view} onConfig={onConfig} />
        ) : (
          <KanbanView {...props} view={view} onConfig={onConfig} />
        )}
      </I18nProvider>
    );
  }
  return render(<Harness />, wrapper ? { wrapper } : undefined);
}
const stack = (name: string) => screen.getByRole('region', { name });

/** The board as a phone draws it: one stack across the screen at a time. */
function onPhone() {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: query === PHONE_QUERY,
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  );
}

it('orders choices and empty, excludes hidden stacks, shows counts, and reloads them after edits', async () => {
  const f = await fixture();
  f.props.view.config.kanban.stackOrder = [done, ''];
  f.props.view.config.kanban.hiddenStacks = [unused];
  mount(f.props);
  await screen.findByRole('button', { name: /^Record 1(?: |$)/ });
  expect(screen.getAllByRole('region').map((region) => region.getAttribute('aria-label'))).toEqual([
    'Done',
    'No Status',
    'Ready',
  ]);
  await waitFor(() => expect(within(stack('Ready')).getByText('1 record')).toBeTruthy());
  expect(f.countsRequests[0]).toContain('tz=America%2FLos_Angeles');
  await act(async () => {
    await f.session.run([
      {
        kind: 'record.update',
        tableId: f.tableId,
        records: [{ id: f.recordId(2), values: { [f.stackField.id]: ready } }],
      },
    ]).done;
  });
  await waitFor(() => expect(within(stack('Ready')).getByText('2 records')).toBeTruthy());
});

it('creates people stacks with avatars and an empty stack, and hides zero counts', async () => {
  const f = await fixture(3, true);
  mount(f.props);
  await screen.findByRole('button', { name: /^Record 1(?: |$)/ });
  expect(screen.getAllByRole('region').map((region) => region.getAttribute('aria-label'))).toEqual([
    'Alex',
    'Sam',
    'No Owner',
  ]);
  expect(within(stack('Alex')).getByRole('img', { name: 'A: Alex' })).toBeTruthy();
  cleanup();
  f.props.view.config.kanban.hideEmptyStacks = true;
  const row = f.database.rows(f.tableId).get(f.recordId(2))!;
  row.values[f.stackField.id] = [f.server.userId];
  f.database.rows(f.tableId).set(row);
  mount(f.props);
  await waitFor(() => expect(screen.queryByRole('region', { name: 'No Owner' })).toBeNull());
});

it('shows visible fields in saved order, reserves covers, uses the first image, and opens with Enter', async () => {
  const f = await fixture();
  const imageId = newId('attachment');
  const pdfId = newId('attachment');
  const row = f.database.rows(f.tableId).get(f.recordId(0))!;
  row.values[f.cover.id] = [pdfId, imageId];
  f.database.rows(f.tableId).set(row);
  f.props.view.config.kanban.coverFieldId = f.cover.id;
  f.props.view.config.kanban.coverFit = 'fit';
  f.props.view.config.hiddenFieldIds = [f.cover.id];
  f.props.view.config.fieldOrder = [f.stackField.id, f.numberFieldId];
  f.props.attachment = (id) => ({
    id,
    name: 'Photo',
    type: id === imageId ? 'image/png' : 'application/pdf',
    size: 10,
    width: 10,
    height: 10,
    createdAt: '',
    url: '/file',
    thumbnails: { small: id === imageId ? thumbnail : null, large: null },
  });
  mount(f.props);
  const card = await screen.findByRole('button', { name: /^Record 1(?: |$)/ });
  expect(card.querySelector('img')?.getAttribute('src')).toBe(thumbnail);
  expect(card.querySelector('[data-fit]')?.getAttribute('data-fit')).toBe('fit');
  expect([...card.querySelectorAll('.rio-kanban-card__label')].map((field) => field.textContent)).toEqual([
    'Status',
    'Number',
  ]);
  card.focus();
  await userEvent.keyboard('{Enter}');
  expect(f.onExpand).toHaveBeenCalledWith(f.recordId(0));
});

it('virtualizes cards and requests later pages as a stack scrolls', async () => {
  const f = await fixture(650);
  mount(f.props);
  await screen.findByRole('button', { name: /^Record 1(?: |$)/ });
  expect(screen.queryByRole('button', { name: /^Record 500(?: |$)/ })).toBeNull();
  const list = within(stack('Ready')).getByRole('list');
  fireEvent.scroll(list, { target: { scrollTop: 300 * 220 } });
  await waitFor(() =>
    expect(
      f.server.requests.some(
        (request) =>
          request.path.includes('stack=' + ready) &&
          Number(new URL(request.path, 'http://localhost').searchParams.get('offset')) >= 200,
      ),
    ).toBe(true),
  );
  await waitFor(() => expect(list.querySelectorAll('[data-record]').length).toBeGreaterThan(0));
  expect(list.querySelectorAll('[data-record]').length).toBeLessThan(20);
});

it('moves with Alt+Right immediately, sends the choice value, retains the card while saving, and supports undo', async () => {
  const f = await fixture();
  mount(f.props);
  const card = await screen.findByRole('button', { name: /^Record 1(?: |$)/ });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.server.beforeRequest = (request) => (request.path.endsWith('/commands') ? pending : Promise.resolve());
  card.focus();
  fireEvent.keyDown(card, { key: 'ArrowRight', altKey: true });
  expect(within(stack('Done')).getByRole('button', { name: /^Record 1(?: |$)/ })).toBe(
    document.activeElement,
  );
  expect(within(stack('Ready')).queryByRole('button', { name: /^Record 1(?: |$)/ })).toBeNull();
  expect(screen.getByRole('status').textContent).toBe('Moved to Done');
  expect(f.session.cachedRecord(f.tableId, f.recordId(0))?.values[f.stackField.id]).toBe(done);
  await act(async () => {
    release();
  });
  await waitFor(() => expect(f.session.saveState().pending).toBe(0));
  expect(within(stack('Done')).getByRole('button', { name: /^Record 1(?: |$)/ })).toBeTruthy();
  await act(async () => {
    await f.session.undo();
  });
  await waitFor(() =>
    expect(within(stack('Ready')).getByRole('button', { name: /^Record 1(?: |$)/ })).toBeTruthy(),
  );
});

it('rolls back a rejected move', async () => {
  const f = await fixture();
  mount(f.props);
  const card = await screen.findByRole('button', { name: /^Record 1(?: |$)/ });
  f.server.rejectNext('data.value.rejected');
  fireEvent.keyDown(card, { key: 'ArrowRight', altKey: true });
  await waitFor(() =>
    expect(within(stack('Ready')).getByRole('button', { name: /^Record 1(?: |$)/ })).toBeTruthy(),
  );
  expect(within(stack('Done')).queryByRole('button', { name: /^Record 1(?: |$)/ })).toBeNull();
});

it('moves people via the card menu and clears a stack with null', async () => {
  const f = await fixture(3, true);
  mount(f.props);
  await screen.findByRole('button', { name: /^Record 1(?: |$)/ });
  await userEvent.click(screen.getByRole('button', { name: 'More for Record 1' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: /^Move to Sam(?: |$)/ }));
  await waitFor(() =>
    expect(f.session.cachedRecord(f.tableId, f.recordId(0))?.values[f.stackField.id]).toEqual([
      f.server.remoteUserId,
    ]),
  );
  // The card re-renders in Sam's stack, so act on that copy, not one still leaving the old stack.
  await userEvent.click(await within(stack('Sam')).findByRole('button', { name: 'More for Record 1' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: /^Move to No Owner(?: |$)/ }));
  await waitFor(() =>
    expect(f.session.cachedRecord(f.tableId, f.recordId(0))?.values[f.stackField.id]).toBeNull(),
  );
});

it('keeps a card’s menu open while its stack reads its cards again', async () => {
  const f = await fixture(3, true);
  mount(f.props);
  await userEvent.click(await screen.findByRole('button', { name: 'More for Record 1' }));
  await screen.findByRole('menuitem', { name: /^Move to Sam(?: |$)/ });
  // Another card joins Alex's stack on the server.  A stack has no live deltas, so it reads its
  // cards again after any change to the table, and only then shows the newcomer.
  const row = f.database.rows(f.tableId).get(f.recordId(2))!;
  row.values[f.stackField.id] = [f.server.userId];
  f.database.rows(f.tableId).set(row);
  const rows = f.session.openView(f.viewId, { stack: f.server.userId });
  await act(async () => {
    await rows.refresh();
  });
  rows.close();
  expect(within(stack('Alex')).getByRole('button', { name: /^Record 3(?: |$)/ })).toBeTruthy();
  await userEvent.click(screen.getByRole('menuitem', { name: /^Move to Sam(?: |$)/ }));
  await waitFor(() =>
    expect(f.session.cachedRecord(f.tableId, f.recordId(0))?.values[f.stackField.id]).toEqual([
      f.server.remoteUserId,
    ]),
  );
});

it('drops cards and headers only at pointer release; Escape cancels', async () => {
  const f = await fixture();
  mount(f.props);
  const card = await screen.findByRole('button', { name: /^Record 1(?: |$)/ });
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(stack('Done'));
  fireEvent.pointerDown(card, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 400, clientY: 10 });
  expect(within(stack('Ready')).getByRole('button', { name: /^Record 1(?: |$)/ })).toBeTruthy();
  fireEvent.pointerUp(window, { pointerId: 1, clientX: 400, clientY: 10 });
  expect(within(stack('Done')).getByRole('button', { name: /^Record 1(?: |$)/ })).toBeTruthy();
  const header = within(stack('Ready')).getByRole('heading');
  fireEvent.pointerDown(header, { button: 0, pointerId: 2, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(window, { pointerId: 2, clientX: 400, clientY: 10 });
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(f.onConfig).not.toHaveBeenCalled();
  fireEvent.pointerDown(header, { button: 0, pointerId: 3, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(window, { pointerId: 3, clientX: 400, clientY: 10 });
  fireEvent.pointerUp(window, { pointerId: 3, clientX: 400, clientY: 10 });
  expect(f.onConfig).toHaveBeenLastCalledWith({
    kanban: expect.objectContaining({ stackOrder: [done, ready, unused, ''] }),
  });
});

it('hides, shows, and reorders stacks through keyboard menus', async () => {
  const f = await fixture();
  mount(f.props);
  await screen.findByRole('button', { name: /^Record 1(?: |$)/ });
  const menu = within(stack('Ready')).getByRole('button', { name: 'More for Ready' });
  menu.focus();
  await userEvent.keyboard('{Enter}');
  await screen.findByRole('menuitem', { name: /^Hide stack(?: |$)/ });
  // The DOM emulator leaves focus on the panel; move it into the menu as a browser does.
  screen.getByRole('menu', { name: 'More for Ready' }).focus();
  await userEvent.keyboard('{ArrowDown}{ArrowUp}');
  expect(screen.getByRole('menuitem', { name: /^Hide stack(?: |$)/ }).getAttribute('data-focused')).toBe(
    'true',
  );
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Ready' })).toBeNull());
  expect(f.onConfig).toHaveBeenLastCalledWith({ kanban: expect.objectContaining({ hiddenStacks: [ready] }) });
  await userEvent.click(screen.getByRole('button', { name: '1 hidden stack' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: /^Show Ready(?: |$)/ }));
  expect(stack('Ready')).toBeTruthy();
  await userEvent.click(within(stack('Ready')).getByRole('button', { name: 'More for Ready' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: /^Move right(?: |$)/ }));
  expect(f.onConfig).toHaveBeenLastCalledWith({
    kanban: expect.objectContaining({ stackOrder: [done, ready, unused, ''] }),
  });
});

it.each([false, true])('creates a new card with the stack value (people: %s)', async (person) => {
  const f = await fixture(3, person);
  mount(f.props);
  await screen.findByRole('button', { name: /^Record 1(?: |$)/ });
  await userEvent.click(within(stack(person ? 'Sam' : 'Done')).getByRole('button', { name: 'New card' }));
  const id = f.onExpand.mock.calls[0]?.[0] as string;
  expect(id).toBeTruthy();
  expect(f.session.cachedRecord(f.tableId, id)?.values[f.stackField.id]).toEqual(
    person ? [f.server.remoteUserId] : done,
  );
  await userEvent.click(
    within(stack(person ? 'No Owner' : 'No Status')).getByRole('button', { name: 'New card' }),
  );
  expect(
    f.session.cachedRecord(f.tableId, f.onExpand.mock.calls[1]?.[0] as string)?.values[f.stackField.id],
  ).toBeNull();
});

it('shows the empty state with a labeled picker and saves card settings', async () => {
  const f = await fixture();
  f.props.view.config.kanban.stackFieldId = null;
  mount(f.props);
  expect(screen.getByRole('heading', { name: 'Choose a field to stack cards by' })).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: /Stacked by/ }));
  await userEvent.click(screen.getByRole('option', { name: /^Status(?: |$)/ }));
  expect(f.onConfig).toHaveBeenLastCalledWith({
    kanban: expect.objectContaining({ stackFieldId: f.stackField.id, stackOrder: [], hiddenStacks: [] }),
  });
  cleanup();
  mount(f.props, true);
  await userEvent.click(screen.getByRole('button', { name: 'Cards' }));
  await userEvent.click(screen.getByRole('button', { name: /Cover image/ }));
  await userEvent.click(screen.getByRole('option', { name: /^Photo(?: |$)/ }));
  expect(f.onConfig).toHaveBeenLastCalledWith({
    kanban: expect.objectContaining({ coverFieldId: f.cover.id }),
  });
  await userEvent.click(screen.getByRole('button', { name: /Fit/ }));
  await userEvent.click(screen.getByRole('option', { name: /^Show whole image(?: |$)/ }));
  expect(f.onConfig).toHaveBeenLastCalledWith({ kanban: expect.objectContaining({ coverFit: 'fit' }) });
  await userEvent.click(screen.getByRole('checkbox', { name: 'Hide empty stacks' }));
  expect(f.onConfig).toHaveBeenLastCalledWith({ kanban: expect.objectContaining({ hideEmptyStacks: true }) });
});

it('disables editing, dragging, and settings for readers', async () => {
  const f = await fixture();
  f.props.canEdit = false;
  vi.spyOn(f.session, 'role').mockReturnValue('reader');
  mount(f.props);
  const card = await screen.findByRole('button', { name: /^Record 1(?: |$)/ });
  expect(screen.queryByRole('button', { name: 'New card' })).toBeNull();
  expect(screen.getByRole('button', { name: 'More for Record 1' }).hasAttribute('disabled')).toBe(true);
  fireEvent.keyDown(card, { key: 'ArrowRight', altKey: true });
  expect(within(stack('Ready')).getByRole('button', { name: /^Record 1(?: |$)/ })).toBeTruthy();
  expect(card.closest('[data-draggable]')).toBeNull();
  cleanup();
  mount(f.props, true);
  expect(screen.getByRole('button', { name: /Stacked by/ }).hasAttribute('disabled')).toBe(true);
  await userEvent.click(screen.getByRole('button', { name: 'Cards' }));
  expect(screen.getByRole('checkbox', { name: 'Hide empty stacks' }).hasAttribute('disabled')).toBe(true);
  expect(f.onConfig).not.toHaveBeenCalled();
});

it('lets editors move and add cards, but not arrange stacks or change the view', async () => {
  const f = await fixture();
  // Editors edit records but not the view: moving a card edits its record.
  f.props.canEdit = false;
  vi.spyOn(f.session, 'role').mockReturnValue('editor');
  mount(f.props);
  const card = await screen.findByRole('button', { name: /^Record 1(?: |$)/ });
  expect(screen.getAllByRole('button', { name: 'New card' }).length).toBeGreaterThan(0);
  expect(screen.getByRole('button', { name: 'More for Record 1' }).hasAttribute('disabled')).toBe(false);
  expect(card.closest('[data-draggable]')).not.toBeNull();
  expect(stack('Ready').querySelector('.rio-kanban-stack__header')?.hasAttribute('data-draggable')).toBe(
    false,
  );
  cleanup();
  mount(f.props, true);
  expect(screen.getByRole('button', { name: /Stacked by/ }).hasAttribute('disabled')).toBe(true);
  expect(f.onConfig).not.toHaveBeenCalled();
});

describe('ordering', () => {
  it('keeps missing stacks in field order and ignores unknown or duplicate saved IDs', () => {
    expect(
      orderStacks(
        [
          { id: 'a', name: 'A' },
          { id: 'b', name: 'B' },
          { id: '', name: 'Empty' },
        ],
        ['b', 'missing', 'b'],
      ).map((stack) => stack.id),
    ).toEqual(['b', 'a', '']);
  });
  it('sorts local arrivals numerically with empty values last in both directions', async () => {
    const f = await fixture();
    const a = f.database.rows(f.tableId).get(f.recordId(0))!,
      b = f.database.rows(f.tableId).get(f.recordId(1))!;
    a.values[f.numberFieldId] = 20;
    b.values[f.numberFieldId] = 3;
    expect(compareCards(a, b, f.props)).toBeGreaterThan(0);
    f.props.view.config.sorts[0]!.direction = 'desc';
    expect(compareCards(a, b, f.props)).toBeLessThan(0);
    a.values[f.numberFieldId] = null;
    expect(compareCards(a, b, f.props)).toBeGreaterThan(0);
  });
});

it('reaches unloaded cards with End and returns with Home', async () => {
  const f = await fixture(650);
  mount(f.props);
  const first = await screen.findByRole('button', { name: /^Record 1(?: |$)/ });
  first.focus();
  await userEvent.keyboard('{End}');
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Record 650(?: |$)/ })),
  );
  await userEvent.keyboard('{Home}');
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Record 1(?: |$)/ })),
  );
  const other = screen.getByRole('button', { name: /^Record 2(?: |$)/ });
  other.focus();
  await act(async () => {
    await f.session.run([
      {
        kind: 'record.update',
        tableId: f.tableId,
        records: [{ id: f.recordId(0), values: { [f.textFieldId]: 'Revised' } }],
      },
    ]).done;
  });
  await screen.findByRole('button', { name: /^Revised(?: |$)/ });
  expect(document.activeElement).toBe(other);
});

it('can choose a zero-count destination while empty stacks are hidden', async () => {
  const f = await fixture();
  f.props.view.config.kanban.hideEmptyStacks = true;
  mount(f.props);
  await screen.findByRole('button', { name: /^Record 1(?: |$)/ });
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Later' })).toBeNull());
  await userEvent.click(screen.getByRole('button', { name: 'More for Record 1' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: /^Move to Later(?: |$)/ }));
  expect(within(stack('Later')).getByRole('button', { name: /^Record 1(?: |$)/ })).toBeTruthy();
  await waitFor(() => expect(f.session.saveState().pending).toBe(0));
  await waitFor(() => expect(within(stack('Later')).getByText('1 record')).toBeTruthy());
});

it('reserves a neutral cover when attachment metadata is unknown', async () => {
  const f = await fixture();
  f.props.view.config.kanban.coverFieldId = f.cover.id;
  const row = f.database.rows(f.tableId).get(f.recordId(0))!;
  row.values[f.cover.id] = [newId('attachment')];
  f.database.rows(f.tableId).set(row);
  mount(f.props);
  const card = await screen.findByRole('button', { name: /^Record 1(?: |$)/ });
  expect(card.querySelector('.rio-kanban-card__cover')).toBeTruthy();
  expect(card.querySelector('img')).toBeNull();
});

it('applies the shared filter and sort to scoped rows', async () => {
  const f = await fixture(5);
  f.props.view.config.filter = {
    conjunction: 'and',
    conditions: [{ id: 'only-four', fieldId: f.textFieldId, operator: 'is', value: 'Record 4' }],
  };
  f.database.view(f.viewId).config.filter = f.props.view.config.filter;
  mount(f.props);
  await screen.findByRole('button', { name: /^Record 4(?: |$)/ });
  expect(screen.queryByRole('button', { name: /^Record 1(?: |$)/ })).toBeNull();
  await waitFor(() => expect(within(stack('Ready')).getByText('1 record')).toBeTruthy());
});

it('does not fetch stack counts after a pending move finishes on an unmounted board', async () => {
  const f = await fixture();
  const rendered = mount(f.props);
  const card = await screen.findByRole('button', { name: /^Record 1(?: |$)/ });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.server.beforeRequest = (request) => (request.path.endsWith('/commands') ? pending : Promise.resolve());
  fireEvent.keyDown(card, { key: 'ArrowRight', altKey: true });
  rendered.unmount();
  const requests = f.countsRequests.length;
  await act(async () => {
    release();
  });
  await waitFor(() => expect(f.session.saveState().pending).toBe(0));
  expect(f.countsRequests).toHaveLength(requests);
});

it('edges cards for record rules, colors values for cell rules, and names both', async () => {
  const f = await fixture();
  const colors = createViewColors({
    config: ColorConfig.parse({
      colorRules: [
        {
          id: 'finished',
          name: 'Finished',
          target: 'record',
          condition: { id: 'c1', fieldId: f.stackField.id, operator: 'is', value: done },
          color: 'green',
        },
        {
          id: 'positive',
          name: 'Positive',
          target: 'cell',
          condition: { id: 'c2', fieldId: f.numberFieldId, operator: 'gt', value: 0 },
          color: 'blue',
        },
      ],
    }),
    fields: f.props.fields,
    context: { timeZone: 'UTC' },
    ranges: new Map(),
    label: (rule) => rule.name,
  });
  mount({ ...f.props, colors });
  const finished = await screen.findByRole('button', { name: /^Record 2(?: |$)/ });
  const card = finished.closest<HTMLElement>('.rio-kanban-card')!;
  expect(card.classList.contains('rio-color-edge')).toBe(true);
  expect(card.style.getPropertyValue('--rio-color-edge')).toBe('var(--rio-aa-choice-green)');
  expect(finished.getAttribute('aria-description')).toBe('Finished, Positive');
  expect(card.querySelector('.rio-color-fill')?.textContent).toBe('1');
  const plain = await screen.findByRole('button', { name: /^Record 1(?: |$)/ });
  expect(plain.closest('.rio-kanban-card')!.classList.contains('rio-color-edge')).toBe(false);
  expect(plain.hasAttribute('aria-description')).toBe(false);
});

describe('on a phone', () => {
  it('shows one stack at a time, turned with the arrows or a swipe, and says which', async () => {
    onPhone();
    const f = await fixture();
    mount(f.props);
    await screen.findByRole('button', { name: /^Record 1(?: |$)/ });
    const pager = screen.getByRole('group', { name: 'Stacks' });
    expect(pager.textContent).toContain('Stack 1 of 4');
    expect(within(pager).getByRole('button', { name: 'Previous stack' }).hasAttribute('disabled')).toBe(true);
    // Hidden stacks are offered beside the arrows, and only once there are some.
    expect(screen.queryByRole('button', { name: /hidden stack/ })).toBeNull();
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    await userEvent.click(within(pager).getByRole('button', { name: 'Next stack' }));
    expect(scroll.mock.contexts).toEqual([stack('Done')]);
    // A swipe scrolls the row of stacks a screen over, and the stack it settles on is current.
    const board = document.querySelector<HTMLElement>('.rio-kanban__board')!;
    Object.defineProperty(board, 'clientWidth', { configurable: true, value: 375 });
    board.scrollLeft = 375;
    fireEvent.scroll(board);
    await waitFor(() => expect(pager.textContent).toContain('Stack 2 of 4'));
    expect(screen.getByRole('status').textContent).toMatch(/^Showing Done/);
    expect(within(pager).getByRole('button', { name: 'Previous stack' }).hasAttribute('disabled')).toBe(
      false,
    );
  });

  it('picks a card up by touch only after a long press, and drops it on a stack named above', async () => {
    onPhone();
    const f = await fixture();
    mount(f.props);
    const card = await screen.findByRole('button', { name: /^Record 1(?: |$)/ });
    const touch = { button: 0, pointerType: 'touch', clientX: 10, clientY: 10 };
    // A finger that moves at once is scrolling or swiping, so it picks nothing up.
    fireEvent.pointerDown(card, { ...touch, pointerId: 1 });
    fireEvent.pointerMove(window, { ...touch, pointerId: 1, clientX: 60 });
    await new Promise((resolve) => setTimeout(resolve, LONG_PRESS_MS + 50));
    expect(document.querySelector('.rio-kanban__drop')).toBeNull();
    // A finger held still picks the card up, and every stack waits above to be dropped on.
    fireEvent.pointerDown(card, { ...touch, pointerId: 2 });
    await waitFor(() => expect(document.querySelector('.rio-kanban__drop')).not.toBeNull(), {
      timeout: LONG_PRESS_MS * 4,
    });
    const strip = document.querySelector<HTMLElement>('.rio-kanban__drop')!;
    // It's for pointers alone, so screen readers skip it.
    expect(strip.getAttribute('aria-hidden')).toBe('true');
    const targets = [...strip.querySelectorAll<HTMLElement>('[data-stack]')];
    expect(targets.map((target) => target.textContent)).toEqual(['Ready', 'Done', 'Later', 'No Status']);
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(targets[1]!);
    fireEvent.pointerMove(window, { ...touch, pointerId: 2, clientX: 100, clientY: 5 });
    await waitFor(() => expect(targets[1]!.hasAttribute('data-drop-target')).toBe(true));
    fireEvent.pointerUp(window, { ...touch, pointerId: 2, clientX: 100, clientY: 5 });
    await waitFor(() => expect(document.querySelector('.rio-kanban__drop')).toBeNull());
    expect(within(stack('Done')).getByRole('button', { name: /^Record 1(?: |$)/ })).toBeTruthy();
  });
});

describe('celebrations', () => {
  let shown: Celebration[] = [];
  let stop: () => void = () => undefined;
  beforeEach(() => {
    shown = [];
    stop = celebrations.subscribe((celebration) => shown.push(celebration));
  });
  afterEach(() => {
    stop();
    localStorage.clear();
  });

  /** A signed-in person, since celebrations belong to someone. */
  function signedIn() {
    const client = new QueryClient();
    client.setQueryData(sessionQuery.queryKey, { user: { id: 'user-one' }, preferences: {} } as SessionInfo);
    return ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  }

  /** Puts each record in a stack, by position, before the board opens. */
  function place(f: Awaited<ReturnType<typeof fixture>>, stacks: Array<string | string[] | null>) {
    stacks.forEach((value, index) => {
      const row = f.database.rows(f.tableId).get(f.recordId(index))!;
      row.values[f.stackField.id] = value;
      f.database.rows(f.tableId).set(row);
    });
  }

  function moveRecord(
    f: Awaited<ReturnType<typeof fixture>>,
    index: number,
    value: string | string[] | null,
  ) {
    return act(async () => {
      await f.session.run([
        {
          kind: 'record.update',
          tableId: f.tableId,
          records: [{ id: f.recordId(index), values: { [f.stackField.id]: value } }],
        },
      ]).done;
    });
  }

  const names = () => shown.map((celebration) => [celebration.name, celebration.cause]);

  it('celebrates once when the last card reaches the field’s last choice, and not on a second finish', async () => {
    const f = await fixture(6);
    place(f, [done, unused, unused, unused, unused, unused]);
    mount(f.props, false, signedIn());
    const card = await screen.findByRole('button', { name: /^Record 1(?: |$)/ });
    await waitFor(() => expect(within(stack('Later')).getByText('5 records')).toBeTruthy());
    card.focus();
    fireEvent.keyDown(card, { key: 'ArrowRight', altKey: true });
    await waitFor(() => expect(names()).toEqual([['kanbanDone', 'you']]));
    expect(shown[0]!.key).toBe(f.viewId);
    await waitFor(() => expect(within(stack('Later')).getByText('6 records')).toBeTruthy());
    await moveRecord(f, 0, done);
    await waitFor(() => expect(within(stack('Later')).getByText('5 records')).toBeTruthy());
    await moveRecord(f, 0, unused);
    await waitFor(() => expect(within(stack('Later')).getByText('6 records')).toBeTruthy());
    expect(shown).toHaveLength(1);
  });

  it('doesn’t take the last stack left showing as done when empty stacks hide', async () => {
    const f = await fixture(6);
    place(f, [done, ready, ready, ready, ready, ready]);
    f.props.view.config.kanban.hideEmptyStacks = true;
    mount(f.props, false, signedIn());
    await screen.findByRole('button', { name: /^Record 1(?: |$)/ });
    await waitFor(() => expect(within(stack('Ready')).getByText('5 records')).toBeTruthy());
    await moveRecord(f, 0, ready);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Done' })).toBeNull());
    await waitFor(() => expect(within(stack('Ready')).getByText('6 records')).toBeTruthy());
    expect(shown).toEqual([]);
  });

  it('keeps the field’s last choice as done whether stacks are hidden or not', async () => {
    const f = await fixture(6);
    place(f, [ready, done, done, done, done, done]);
    f.props.view.config.kanban.hiddenStacks = [unused];
    mount(f.props, false, signedIn());
    await screen.findByRole('button', { name: /^Record 1(?: |$)/ });
    await waitFor(() => expect(within(stack('Done')).getByText('5 records')).toBeTruthy());
    // Every card in Done, the last stack showing, isn't a finished board while Later comes after it.
    await moveRecord(f, 0, done);
    await waitFor(() => expect(within(stack('Done')).getByText('6 records')).toBeTruthy());
    expect(shown).toEqual([]);
    // Every card in Later is, even with Later hidden.
    for (let index = 0; index < 5; index++) await moveRecord(f, index, unused);
    await waitFor(() => expect(within(stack('Done')).getByText('1 record')).toBeTruthy());
    await moveRecord(f, 5, unused);
    await waitFor(() => expect(names()).toEqual([['kanbanDone', 'others']]));
  });

  it('doesn’t celebrate a board narrowed by a filter', async () => {
    const f = await fixture(6);
    place(f, [done, unused, unused, unused, unused, unused]);
    f.props.view.config.filter = {
      conjunction: 'and',
      conditions: [{ id: 'every-one', fieldId: f.numberFieldId, operator: 'gte', value: 0 }],
    };
    f.database.view(f.viewId).config.filter = f.props.view.config.filter;
    mount(f.props, false, signedIn());
    const card = await screen.findByRole('button', { name: /^Record 1(?: |$)/ });
    await waitFor(() => expect(within(stack('Later')).getByText('5 records')).toBeTruthy());
    card.focus();
    fireEvent.keyDown(card, { key: 'ArrowRight', altKey: true });
    await waitFor(() => expect(within(stack('Later')).getByText('6 records')).toBeTruthy());
    expect(shown).toEqual([]);
  });

  it('waits for counts read without the filter before judging a board whose filter was just cleared', async () => {
    const f = await fixture(8);
    place(f, Array(8).fill(unused));
    const filter = {
      conjunction: 'and' as const,
      conditions: [{ id: 'first-three', fieldId: f.numberFieldId, operator: 'lt' as const, value: 3 }],
    };
    f.props.view.config.filter = filter;
    f.database.view(f.viewId).config.filter = filter;
    // The board follows the view as the session has it, so clearing the filter reaches it at once.
    function Live() {
      const schema = useSchema(f.session);
      const view = schema?.viewById.get(f.viewId) ?? f.props.view;
      return (
        <I18nProvider i18n={i18n}>
          <KanbanView {...f.props} view={view} />
        </I18nProvider>
      );
    }
    render(<Live />, { wrapper: signedIn() });
    await waitFor(() => expect(within(stack('Later')).getByText('3 records')).toBeTruthy());
    // The server takes the change, but the view's change reaches this tab late.
    f.server.pauseChanges();
    await act(async () => {
      await f.session.run([{ kind: 'view.update', viewId: f.viewId, config: { filter: null } }]).done;
    });
    await waitFor(() => expect(within(stack('Later')).getByText('8 records')).toBeTruthy());
    const asked = f.countsRequests.length;
    await act(async () => {
      f.server.resumeChanges();
    });
    await waitFor(() => expect(f.countsRequests.length).toBeGreaterThan(asked));
    await waitFor(() => expect(within(stack('Later')).getByText('8 records')).toBeTruthy());
    expect(shown).toEqual([]);
    // Once the counts are the table's, finishing it again celebrates.
    await moveRecord(f, 0, ready);
    await waitFor(() => expect(within(stack('Later')).getByText('7 records')).toBeTruthy());
    await moveRecord(f, 0, unused);
    await waitFor(() => expect(names()).toEqual([['kanbanDone', 'others']]));
  });

  it('never celebrates a board stacked by person, which has no done stack', async () => {
    const f = await fixture(6, true);
    const alex = [f.server.userId];
    const sam = [f.server.remoteUserId];
    place(f, [alex, sam, sam, sam, sam, sam]);
    mount(f.props, false, signedIn());
    await screen.findByRole('button', { name: /^Record 1(?: |$)/ });
    await waitFor(() => expect(within(stack('Sam')).getByText('5 records')).toBeTruthy());
    await moveRecord(f, 0, sam);
    await waitFor(() => expect(within(stack('Sam')).getByText('6 records')).toBeTruthy());
    expect(shown).toEqual([]);
  });
});

describe('kanban drop regressions', () => {
  const begin = (node: Element) => {
    fireEvent.pointerDown(node, { button: 0, pointerId: 9, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(window, { pointerId: 9, buttons: 1, clientX: 100, clientY: 40 });
  };
  it.each(['locked', 'live'] as const)(
    'changes columns over cards without ordering a %s view',
    async (restriction) => {
      const f = await fixture();
      f.props.view.config.sorts = [];
      if (restriction === 'locked') f.props.view.config.locked = true;
      else
        f.props.table.source = { freshness: 'live', status: {}, allowOverrides: true } as NonNullable<
          typeof f.props.table.source
        >;
      const run = vi.spyOn(f.session, 'run');
      mount(f.props);
      const card = await screen.findByRole('button', { name: /^Record 1(?: |$)/ });
      const target = await screen.findByRole('button', { name: /^Record 2(?: |$)/ });
      vi.spyOn(document, 'elementFromPoint').mockReturnValue(target);
      begin(card);
      expect(stack('Done').dataset.rioDrop).toBe('ready');
      expect(target.closest('[data-record]')?.getAttribute('data-rio-drop')).toBeNull();
      fireEvent.pointerUp(window, { pointerId: 9, clientX: 100, clientY: 40 });
      expect(run).toHaveBeenCalledWith([
        {
          kind: 'record.update',
          tableId: f.tableId,
          records: [{ id: f.recordId(0), values: { [f.stackField.id]: done } }],
        },
      ]);
    },
  );
  it('marks the entire target column when moving a header over a card', async () => {
    const f = await fixture();
    mount(f.props);
    const target = await screen.findByRole('button', { name: /^Record 2(?: |$)/ });
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(target);
    begin(within(stack('Ready')).getByRole('heading'));
    expect(stack('Done').dataset.rioDrop).toBe('ready');
    expect(stack('Done').dataset.rioDropReason).toBe('Place after Done');
    expect(target.closest('[data-record]')?.getAttribute('data-rio-drop')).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
  });
  it('keeps the optimistic order within a column until the server replies', async () => {
    const f = await fixture(5);
    f.props.view.config.sorts = [];
    mount(f.props);
    const card = await screen.findByRole('button', { name: /^Record 1(?: |$)/ });
    await screen.findByRole('button', { name: /^Record 4(?: |$)/ });

    fireEvent.keyDown(card, { key: 'ArrowDown', altKey: true });
    const names = within(stack('Ready'))
      .getAllByRole('button')
      .filter((node) => node.classList.contains('rio-kanban-card__open'))
      .map((node) => node.querySelector('.rio-kanban-card__title')?.textContent);
    expect(names.slice(0, 2)).toEqual(['Record 4', 'Record 1']);
  });
  it('places an arrival beside the target immediately', async () => {
    const f = await fixture(5);
    f.props.view.config.sorts = [];
    mount(f.props);
    const card = await screen.findByRole('button', { name: /^Record 2(?: |$)/ });
    const target = await screen.findByRole('button', { name: /^Record 1(?: |$)/ });
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(target);
    vi.spyOn(target.closest<HTMLElement>('[data-record]')!, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      height: 100,
    } as DOMRect);
    begin(card);
    fireEvent.pointerUp(window, { pointerId: 9, clientX: 100, clientY: 40 });
    const names = within(stack('Ready'))
      .getAllByRole('button')
      .filter((node) => node.classList.contains('rio-kanban-card__open'))
      .map((node) => node.querySelector('.rio-kanban-card__title')?.textContent);
    expect(names.slice(0, 2)).toEqual(['Record 2', 'Record 1']);
  });
  it('leaves public cards free of gestures', async () => {
    const f = await fixture();
    mount({ ...f.props, readOnly: true });
    const card = await screen.findByRole('button', { name: /^Record 1(?: |$)/ });
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(stack('Done'));
    begin(card);
    expect(screen.getByRole('status').textContent).toBe('');
    expect(document.querySelector('[data-rio-drop]')).toBeNull();
    expect(document.querySelector('.rio-view-drag-status')).toBeNull();
  });
});

it('announces a keyboard move after canceling a card drag', async () => {
  const f = await fixture();
  mount(f.props);
  const card = await screen.findByRole('button', { name: /^Record 1(?: |$)/ });
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(stack('Done'));
  fireEvent.pointerDown(card, { button: 0, pointerId: 1, clientX: 10 });
  fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 100 });
  fireEvent.keyDown(card, { key: 'Escape' });
  fireEvent.pointerUp(window, { pointerId: 1 });
  expect(screen.getByRole('status').textContent).toBe('Move canceled.');
  fireEvent.keyDown(card, { key: 'ArrowRight', altKey: true });
  expect(screen.getByRole('status').textContent).toBe('Moved to Done');
});

it('places a column arrival after its last loaded card in the same undo step', async () => {
  const f = await fixture(5);
  f.props.view.config.sorts = [];
  f.database.view(f.viewId).config.sorts = [];
  const run = vi.spyOn(f.session, 'run');
  mount(f.props);
  const card = await screen.findByRole('button', { name: /^Record 2(?: |$)/ });
  await screen.findByRole('button', { name: /^Record 5(?: |$)/ });
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(stack('Ready'));
  fireEvent.pointerDown(card, { button: 0, pointerId: 9, clientX: 20, clientY: 20 });
  fireEvent.pointerMove(window, { pointerId: 9, buttons: 1, clientX: 100, clientY: 40 });
  fireEvent.pointerUp(window, { pointerId: 9, clientX: 100, clientY: 40 });
  expect(run).toHaveBeenCalledWith([
    expect.objectContaining({ kind: 'record.update' }),
    expect.objectContaining({
      kind: 'record.move',
      viewId: f.viewId,
      recordIds: [f.recordId(1)],
      place: { after: f.recordId(4) },
    }),
  ]);
  const names = () =>
    within(stack('Ready'))
      .getAllByRole('button')
      .filter((node) => node.classList.contains('rio-kanban-card__open'))
      .map((node) => node.querySelector('.rio-kanban-card__title')?.textContent);
  expect(names()).toEqual(['Record 1', 'Record 4', 'Record 5', 'Record 2']);
  await waitFor(() => expect(f.session.saveState().pending).toBe(0));
  await waitFor(() => expect(names()).toEqual(['Record 1', 'Record 4', 'Record 5', 'Record 2']));
});

it('includes visible field labels and values in the card button name', async () => {
  const { props } = await fixture(1);
  mount(props);
  const card = await screen.findByRole('button', { name: /^Record 1 Number 0/ });
  expect(card.textContent).toContain('Number');
});
