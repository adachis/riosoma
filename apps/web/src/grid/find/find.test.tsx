import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { newId, SEARCH_LIMITS } from '@riosoma/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../data';
import { FakeServer } from '../../data/testing';
import { i18n } from '../../i18n';
import { renderShell } from '../../screens/database/shell/test-support';
import { GridView } from '../GridView';
import { openGrid, seedTable } from '../test-support';

const dispose: Array<() => void> = [];
afterEach(() => {
  cleanup();
  for (const close of dispose.splice(0)) close();
});

const acme = newId('choice');
const other = newId('choice');

/** Every even record is named for Acme, and one note, one status, and one email mention it too. */
function companies(count: number) {
  const server = new FakeServer();
  const fixture = seedTable(
    server,
    [
      { name: 'Name', type: 'text' },
      { name: 'Notes', type: 'longText' },
      {
        name: 'Status',
        type: 'singleSelect',
        options: {
          choices: [
            { id: acme, name: 'Acme partner', color: 'blue' },
            { id: other, name: 'Other', color: 'green' },
          ],
        },
      },
      { name: 'Count', type: 'number' },
      { name: 'Email', type: 'email' },
    ],
    count,
    (index, [name, notes, status, amount, email]) => ({
      [name!]: index % 2 === 0 ? `Acme ${index}` : `Other ${index}`,
      [amount!]: index,
      ...(index === 3 ? { [status!]: acme } : {}),
      ...(index === 5 ? { [notes!]: 'Call acme back' } : {}),
      ...(index === 7 ? { [email!]: 'team@acme.test' } : {}),
    }),
  );
  const [name, notes, status, amount, email] = fixture.ids as [string, string, string, string, string];
  /** A record's value on the server, loaded in the grid or not */
  const stored = (index: number, fieldId: string) =>
    fixture.database.rows(fixture.tableId).get(fixture.recordId(index))?.values[fieldId] ?? null;
  return { server, fixture, stored, fields: { name, notes, status, amount, email } };
}

async function open(server: FakeServer, fixture: Parameters<typeof openGrid>[1]) {
  const grid = await openGrid(server, fixture);
  dispose.push(grid.close);
  return grid;
}

const cell = (grid: Awaited<ReturnType<typeof openGrid>>) => grid.grid.getSelection().active;

describe('find', () => {
  it('searches the whole view on the server and steps through every match, selecting and marking each', async () => {
    const { server, fixture } = companies(450);
    const grid = await open(server, fixture);
    grid.find.open('find');
    grid.find.setQuery('ACME');
    await vi.waitFor(() => expect(grid.find.getState().total).toBe(228));
    expect(grid.find.getState()).toMatchObject({ current: 0, listed: 228, searching: false });
    expect(cell(grid)).toEqual({ row: 0, col: 0 });
    expect(server.searches.at(-1)).toMatchObject({
      query: 'ACME',
      locale: 'en-US',
      tz: 'UTC',
      snapshot: grid.rows.snapshotId!(),
    });
    for (const expected of [
      { row: 2, col: 0 },
      { row: 3, col: 2 },
      { row: 4, col: 0 },
      { row: 5, col: 1 },
      { row: 6, col: 0 },
      { row: 7, col: 4 },
    ]) {
      await grid.find.next();
      expect(cell(grid)).toEqual(expected);
    }
    expect(grid.find.marks()).toContainEqual({ kind: 'match', row: 7, col: 4, current: true });
    expect(grid.find.marks()).toContainEqual({ kind: 'match', row: 3, col: 2, current: false });
    // Back past the first match to the last one, far below the rows loaded so far.
    for (let i = 0; i < 7; i++) await grid.find.previous();
    expect(grid.find.getState().current).toBe(227);
    await vi.waitFor(() => expect(cell(grid)).toEqual({ row: 448, col: 0 }));
    expect(grid.find.marks()).toContainEqual({ kind: 'match', row: 448, col: 0, current: true });
    grid.find.close();
    expect(grid.find.marks()).toEqual([]);
  });

  it('matches numbers as they read and moves nowhere when nothing matches', async () => {
    const { server, fixture } = companies(20);
    const grid = await open(server, fixture);
    grid.find.open('find');
    grid.find.setQuery('19');
    await vi.waitFor(() => expect(grid.find.getState().total).toBe(2));
    expect(cell(grid)).toEqual({ row: 19, col: 0 });
    await grid.find.next();
    expect(cell(grid)).toEqual({ row: 19, col: 3 });
    grid.find.setQuery('nowhere');
    await vi.waitFor(() => expect(grid.find.getState()).toMatchObject({ total: 0, current: -1 }));
    await grid.find.next();
    expect(cell(grid)).toEqual({ row: 19, col: 3 });
  });
});

describe('replace', () => {
  it('replaces the current match and moves on, stepping past fields it can’t change', async () => {
    const { server, fixture, fields } = companies(12);
    const grid = await open(server, fixture);
    grid.find.open('replace');
    grid.find.setQuery('acme');
    grid.find.setReplacement('Zenith');
    await vi.waitFor(() => expect(grid.find.getState().total).toBe(9));
    expect(grid.find.getState().elsewhere).toBe(1);
    await grid.find.replace();
    expect(grid.value(0, fields.name)).toBe('Zenith 0');
    expect(grid.find.getState()).toMatchObject({ total: 8, current: 0 });
    expect(cell(grid)).toEqual({ row: 2, col: 0 });
    await grid.find.next();
    expect(cell(grid)).toEqual({ row: 3, col: 2 });
    await grid.find.replace();
    expect(grid.value(3, fields.status)).toBe(acme);
    expect(cell(grid)).toEqual({ row: 4, col: 0 });
  });

  it('replaces every match people may edit as one undoable step, and says what it left', async () => {
    const { server, fixture, fields, stored } = companies(450);
    const grid = await open(server, fixture);
    grid.find.open('replace');
    grid.find.setQuery('acme');
    grid.find.setReplacement('Zenith Labs');
    await vi.waitFor(() => expect(grid.find.getState().total).toBe(228));
    await grid.find.replaceAll();
    expect(grid.find.getState().notice).toEqual({ kind: 'replaced', cells: 226, capped: false, unfit: 1 });
    expect(stored(0, fields.name)).toBe('Zenith Labs 0');
    expect(stored(448, fields.name)).toBe('Zenith Labs 448');
    expect(stored(5, fields.notes)).toBe('Call Zenith Labs back');
    // An email with a space in it isn't an email, so that cell keeps its text.
    expect(stored(7, fields.email)).toBe('team@acme.test');
    expect(stored(3, fields.status)).toBe(acme);
    const updates = grid.commands().filter((command) => command.kind === 'record.update');
    expect(new Set(updates.map((command) => command.groupId)).size).toBe(1);
    expect(grid.toasts().at(-1)).toMatchObject({ title: 'Replaced 226 cells', tone: 'success' });
    expect(grid.find.getState()).toMatchObject({ total: 2, elsewhere: 1 });
    await grid.session.undo();
    await vi.waitFor(() => expect(stored(448, fields.name)).toBe('Acme 448'));
    expect(stored(0, fields.name)).toBe('Acme 0');
    expect(stored(5, fields.notes)).toBe('Call acme back');
  });

  it('stops Replace all at its cap and says so', async () => {
    const server = new FakeServer();
    const count = SEARCH_LIMITS.replaceCells + 5;
    const fixture = seedTable(server, [{ name: 'Name', type: 'text' }], count, (index, [name]) => ({
      [name!]: `Row ${index}`,
    }));
    const grid = await open(server, fixture);
    grid.find.open('replace');
    grid.find.setQuery('row');
    grid.find.setReplacement('Line');
    await vi.waitFor(() => expect(grid.find.getState().total).toBe(count));
    await grid.find.replaceAll();
    expect(grid.find.getState().notice).toEqual({
      kind: 'replaced',
      cells: SEARCH_LIMITS.replaceCells,
      capped: true,
      unfit: 0,
    });
    const updates = grid.commands().filter((command) => command.kind === 'record.update');
    expect(updates).toHaveLength(SEARCH_LIMITS.replaceCells / 1_000);
    expect(new Set(updates.map((command) => command.groupId)).size).toBe(1);
    expect(grid.find.getState().total).toBe(5);
  }, 30_000);

  it('offers only find to people who can’t edit records', async () => {
    const { server, fixture } = companies(4);
    server.database(fixture.databaseId).schema.database.role = 'reader';
    const grid = await open(server, fixture);
    grid.find.open('replace');
    expect(grid.find.getState()).toMatchObject({ open: true, mode: 'find' });
    grid.find.setMode('replace');
    expect(grid.find.getState().mode).toBe('find');
  });
});

describe('the find bar', () => {
  it('opens with Ctrl+F while the grid has the focus, steps with Enter, and closes with Escape', async () => {
    const { server, fixture } = companies(30);
    i18n.load('en-US', {});
    i18n.activate('en-US');
    const session = await openDatabase(fixture.databaseId, server.deps());
    const rows = session.openView(fixture.viewId);
    dispose.push(() => {
      rows.close();
      session.close();
    });
    for (let i = 0; i < 80; i++) await Promise.resolve();
    const schema = session.getSchema();
    const { container } = renderShell(
      <GridView
        session={session}
        rows={rows}
        table={schema.tableById.get(fixture.tableId)!}
        view={schema.viewById.get(fixture.viewId)!}
        fields={schema.fields.get(fixture.tableId)!}
        format={{ locale: 'en-US', timeZone: 'UTC', collaborators: schema.collaborators }}
        peers={[]}
        onConfig={vi.fn()}
        onExpand={vi.fn()}
        onField={vi.fn()}
        onFilter={vi.fn()}
      />,
    );
    const input = container.querySelector<HTMLTextAreaElement>('.rio-grid-view__engine textarea')!;
    input.focus();
    const find = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(find);
    expect(find.defaultPrevented).toBe(true);
    const search = await screen.findByRole('search', { name: 'Find in this view' });
    const box = screen.getByRole('textbox', { name: 'Find' });
    await waitFor(() => expect(document.activeElement).toBe(box));
    expect(screen.queryByRole('textbox', { name: 'Replace with' })).toBeNull();
    await userEvent.type(box, 'acme');
    expect(await screen.findByText('1 of 18')).toBeDefined();
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByText('2 of 18')).toBeDefined();
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}{Shift>}{Enter}{/Shift}');
    expect(await screen.findByText('18 of 18')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Replace' }));
    expect(screen.getByRole('textbox', { name: 'Replace with' })).toBeDefined();
    expect(await screen.findByText('1 match is in a field Replace doesn’t change.')).toBeDefined();
    await userEvent.click(box);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(search.isConnected).toBe(false));
    expect(document.activeElement).toBe(input);
    const replace = new KeyboardEvent('keydown', {
      key: 'h',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(replace);
    expect(await screen.findByRole('textbox', { name: 'Replace with' })).toBeDefined();
  });
});
