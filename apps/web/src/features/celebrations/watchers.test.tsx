import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type {
  Command,
  FieldMeta,
  Preferences,
  RowData,
  SessionInfo,
  TableMeta,
  ViewMeta,
} from '@riosoma/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSession, SchemaState, ViewRows, ViewRowsChange } from '../../data/types';
import { celebrations, type Celebration } from './engine';
import { playSound } from './sounds';
import { sessionQuery } from '../../session';
import { useGridCelebrations, useSessionCelebrations } from './watchers';

vi.mock('./sounds', async (original) => ({ ...(await original<object>()), playSound: vi.fn(() => true) }));

const fields = [
  { id: 'field-name', type: 'text', position: 0, options: {} },
  { id: 'field-done', type: 'checkbox', position: 1, options: {} },
] as unknown as FieldMeta[];
const table = { id: 'table-one', primaryFieldId: 'field-name' } as TableMeta;

function view(filtered = false): ViewMeta {
  return viewWith(
    filtered ? { conjunction: 'and', conditions: [{ fieldId: 'field-done', operator: 'isEmpty' }] } : null,
  );
}

function viewWith(filter: unknown, sorts: unknown[] = []): ViewMeta {
  return {
    id: 'view-one',
    tableId: 'table-one',
    config: { filter, sorts, fieldOrder: [], hiddenFieldIds: [], columnWidths: {} },
  } as unknown as ViewMeta;
}

/** A fake session that remembers who listens for the person's commands. */
function fakeSession() {
  const commandListeners = new Set<(commands: readonly Command[]) => void>();
  const schema = {
    fieldById: new Map(fields.map((field) => [field.id, field])),
    access: { limitedTables: new Set<string>() },
  } as unknown as SchemaState;
  const session = {
    getSchema: () => schema,
    subscribe: () => () => undefined,
    subscribeCommands: (listener: (commands: readonly Command[]) => void) => {
      commandListeners.add(listener);
      return () => commandListeners.delete(listener);
    },
  } as unknown as DatabaseSession;
  return {
    session,
    schema,
    run(commands: Command[]) {
      for (const listener of commandListeners) listener(commands);
    },
  };
}

/**
 * Rows whose count and values the test sets, telling the grid's listeners when they change, and
 * the view settings they were read under.
 */
function fakeRows(values: boolean[], readUnder: ViewMeta = view()) {
  const listeners = new Set<(change: ViewRowsChange) => void>();
  let current = values;
  let settings = readUnder.config;
  const rows = {
    loading: () => false,
    rowCount: () => current.length,
    getRow: (index: number) =>
      ({ id: `record-${index}`, values: { 'field-done': current[index] } }) as unknown as RowData,
    settings: () => settings,
    subscribe: (listener: (change: ViewRowsChange) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as ViewRows;
  return {
    rows,
    /**
     * Changes the rows, and waits for what the grid decides once the change has landed.  `along`
     * runs in the same moment, as the person's own command does just after its rows change.
     */
    async set(next: boolean[], readAgainUnder?: ViewMeta, along?: () => void) {
      current = next;
      if (readAgainUnder) settings = readAgainUnder.config;
      await act(async () => {
        for (const listener of listeners) listener({ count: true });
        along?.();
      });
    },
  };
}

const check = (on = true): Command =>
  ({
    id: 'command-one',
    groupId: 'action-one',
    kind: 'record.update',
    tableId: 'table-one',
    records: [{ id: 'record-0', values: { 'field-done': on } }],
  }) as Command;

/** Renders a hook as the app would, with the signed-in person in the query cache. */
function signedInAs(preferences: Preferences = {}) {
  const client = new QueryClient();
  client.setQueryData(sessionQuery.queryKey, { user: { id: 'user-one' }, preferences } as SessionInfo);
  return {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}

let shown: Celebration[] = [];
let stop: () => void = () => undefined;

beforeEach(() => {
  shown = [];
  stop = celebrations.subscribe((celebration) => shown.push(celebration));
  vi.mocked(playSound).mockClear();
});

afterEach(() => {
  stop();
  cleanup();
  localStorage.clear();
});

describe('the person’s own changes', () => {
  it('tick when they check a box, and only then', () => {
    const { session, run } = fakeSession();
    renderHook(() => useSessionCelebrations(session), signedInAs());
    run([check(false)]);
    expect(playSound).not.toHaveBeenCalled();
    run([check(true)]);
    expect(playSound).toHaveBeenCalledWith('tick', {});
  });

  it('use up a first table once a database opens, without celebrating it', () => {
    const { session, run } = fakeSession();
    const person = { userId: 'user-one', level: 'on' as const, key: 'you' };
    celebrations.observe('firstTable', { ...person, reached: false });
    renderHook(() => useSessionCelebrations(session), signedInAs());
    run([{ kind: 'table.create' } as Command]);
    expect(celebrations.observe('firstTable', { ...person, reached: true })).toBe('done');
    expect(shown).toEqual([]);
  });
});

describe('a grid’s milestones', () => {
  it('celebrate a table reaching 100 records once, and then 1,000', async () => {
    const { session } = fakeSession();
    const { rows, set } = fakeRows(Array(99).fill(false));
    const container = { current: document.createElement('div') };
    renderHook(
      () => useGridCelebrations({ session, rows, table, view: view(), fields, container }),
      signedInAs(),
    );
    await set(Array(100).fill(false));
    expect(shown.map((celebration) => [celebration.name, celebration.key, celebration.cause])).toEqual([
      ['records100', 'table-one', 'others'],
    ]);
    await set(Array(90).fill(false));
    await set(Array(120).fill(false));
    expect(shown).toHaveLength(1);
    await set(Array(1000).fill(false));
    expect(shown.map((celebration) => celebration.name)).toEqual(['records100', 'records1000']);
  });

  it('stay quiet for a table that already had 100 records when the grid first opened', async () => {
    const { session } = fakeSession();
    const { rows, set } = fakeRows(Array(150).fill(false));
    const container = { current: document.createElement('div') };
    renderHook(
      () => useGridCelebrations({ session, rows, table, view: view(), fields, container }),
      signedInAs(),
    );
    await set(Array(151).fill(false));
    expect(shown).toEqual([]);
  });

  it('don’t count records in a view with a filter', async () => {
    const { session } = fakeSession();
    const { rows, set } = fakeRows(Array(99).fill(false));
    const container = { current: document.createElement('div') };
    renderHook(
      () => useGridCelebrations({ session, rows, table, view: view(true), fields, container }),
      signedInAs(),
    );
    await set(Array(100).fill(false));
    expect(shown).toEqual([]);
  });

  it('celebrate a checklist the person finishes, from the field’s header', async () => {
    const { session, run } = fakeSession();
    const { rows, set } = fakeRows([...Array(11).fill(true), false]);
    const container = { current: document.createElement('div') };
    const header = document.createElement('div');
    header.dataset.rioColumn = '1';
    container.current.append(header);
    renderHook(
      () => useGridCelebrations({ session, rows, table, view: view(), fields, container }),
      signedInAs(),
    );
    await set(Array(12).fill(true), undefined, () => run([check(true)]));
    expect(shown.map((celebration) => [celebration.name, celebration.cause, celebration.anchor])).toEqual([
      ['checklistComplete', 'you', header],
    ]);
  });

  it('don’t celebrate a checklist that was already done, or a second finish within the hour', async () => {
    const { session } = fakeSession();
    const { rows, set } = fakeRows(Array(12).fill(true));
    const container = { current: document.createElement('div') };
    renderHook(
      () => useGridCelebrations({ session, rows, table, view: view(), fields, container }),
      signedInAs(),
    );
    await set(Array(13).fill(true));
    await act(async () => undefined);
    expect(shown).toEqual([]);
    await set([...Array(12).fill(true), false]);
    await set(Array(13).fill(true));
    await act(async () => undefined);
    expect(shown.map((celebration) => [celebration.name, celebration.cause])).toEqual([
      ['checklistComplete', 'others'],
    ]);
    await set([...Array(12).fill(true), false]);
    await set(Array(13).fill(true));
    await act(async () => undefined);
    expect(shown).toHaveLength(1);
  });
  it('count the records reaching 100 as the person’s own when their commands just added them', async () => {
    const { session, run } = fakeSession();
    const { rows, set } = fakeRows(Array(99).fill(false));
    const container = { current: document.createElement('div') };
    renderHook(
      () => useGridCelebrations({ session, rows, table, view: view(), fields, container }),
      signedInAs(),
    );
    const add = {
      id: 'command-two',
      groupId: 'action-two',
      kind: 'record.create',
      tableId: 'table-one',
      records: [{ id: 'record-99', values: {} }],
    } as Command;
    await set(Array(100).fill(false), undefined, () => run([add]));
    expect(shown.map((celebration) => [celebration.name, celebration.cause])).toEqual([
      ['records100', 'you'],
    ]);
  });

  it('don’t count the rows a cleared filter left behind until they’re read again', async () => {
    const { session } = fakeSession();
    const filtered = view(true);
    const { rows, set } = fakeRows(Array(30).fill(false), filtered);
    const container = { current: document.createElement('div') };
    const { rerender } = renderHook(
      ({ current }: { current: ViewMeta }) =>
        useGridCelebrations({ session, rows, table, view: current, fields, container }),
      { initialProps: { current: filtered }, ...signedInAs() },
    );
    // The filter is gone at once, but the rows still hold its 30 until they're read again.
    rerender({ current: view() });
    await set(Array(150).fill(false), view());
    await set(Array(151).fill(false));
    expect(shown).toEqual([]);
  });

  it('still celebrate 100 records for a table under it when a cleared filter’s rows arrive', async () => {
    const { session } = fakeSession();
    const filtered = view(true);
    const { rows, set } = fakeRows(Array(30).fill(false), filtered);
    const container = { current: document.createElement('div') };
    const { rerender } = renderHook(
      ({ current }: { current: ViewMeta }) =>
        useGridCelebrations({ session, rows, table, view: current, fields, container }),
      { initialProps: { current: filtered }, ...signedInAs() },
    );
    rerender({ current: view() });
    await set(Array(99).fill(false), view());
    await set(Array(100).fill(false));
    expect(shown.map((celebration) => celebration.name)).toEqual(['records100']);
  });

  it('start a checklist over when the filter changes, so narrowing to checked records stays quiet', async () => {
    const { session } = fakeSession();
    const named = viewWith({
      conjunction: 'and',
      conditions: [{ fieldId: 'field-name', operator: 'isNotEmpty' }],
    });
    const checked = viewWith({
      conjunction: 'and',
      conditions: [{ fieldId: 'field-done', operator: 'isNotEmpty' }],
    });
    const { rows, set } = fakeRows([...Array(11).fill(true), false], named);
    const container = { current: document.createElement('div') };
    const { rerender } = renderHook(
      ({ current }: { current: ViewMeta }) =>
        useGridCelebrations({ session, rows, table, view: current, fields, container }),
      { initialProps: { current: named }, ...signedInAs() },
    );
    rerender({ current: checked });
    await set(Array(12).fill(true), checked);
    await act(async () => undefined);
    expect(shown).toEqual([]);
  });

  it('start a checklist over when the sort changes', async () => {
    const { session } = fakeSession();
    const plain = viewWith(null);
    const sorted = viewWith(null, [{ fieldId: 'field-name', direction: 'desc' }]);
    const { rows, set } = fakeRows([...Array(11).fill(true), false], plain);
    const container = { current: document.createElement('div') };
    const { rerender } = renderHook(
      ({ current }: { current: ViewMeta }) =>
        useGridCelebrations({ session, rows, table, view: current, fields, container }),
      { initialProps: { current: plain }, ...signedInAs() },
    );
    rerender({ current: sorted });
    // Read again in the new order, the one open record is first, and someone checks it.
    await set([false, ...Array(11).fill(true)], sorted);
    await set(Array(12).fill(true));
    await act(async () => undefined);
    expect(shown.map((celebration) => celebration.name)).toEqual(['checklistComplete']);
  });

  it('don’t celebrate a checklist that finished because its open record left', async () => {
    const { session } = fakeSession();
    const { rows, set } = fakeRows([...Array(11).fill(true), false]);
    const container = { current: document.createElement('div') };
    renderHook(
      () => useGridCelebrations({ session, rows, table, view: view(), fields, container }),
      signedInAs(),
    );
    await set(Array(11).fill(true));
    await act(async () => undefined);
    expect(shown).toEqual([]);
  });
});
