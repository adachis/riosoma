import { afterEach, expect, it, vi } from 'vitest';
import type { CellRange } from '../../../../../packages/grid-core/src/types';
import { FakeServer } from '../../data/testing';
import { syncedFixture } from '../../data/testing/synced';
import { openGrid, seedTable } from '../test-support';
import { FILL_LIMIT } from './plan';

const range = (top: number, left: number, bottom: number, right: number): CellRange => ({
  start: { row: top, col: left },
  end: { row: bottom, col: right },
});
const dispose: Array<() => void> = [];
afterEach(() => {
  for (const close of dispose.splice(0)) close();
});

async function projects(count = 8) {
  const server = new FakeServer();
  const fixture = seedTable(
    server,
    [
      { name: 'Name', type: 'text' },
      { name: 'Count', type: 'number' },
      { name: 'Due', type: 'date', options: { dateFormat: 'iso' } },
      { name: 'Created', type: 'createdTime' },
      { name: 'Day', type: 'text' },
    ],
    count,
    (index, [name, amount, due, , day]) =>
      index === 0
        ? { [name!]: 'Task 1', [amount!]: 10, [due!]: '2026-01-31', [day!]: 'Mon' }
        : index === 1
          ? { [name!]: 'Task 2', [amount!]: 20, [due!]: '2026-02-28', [day!]: 'Tue' }
          : index < 6
            ? { [name!]: `Filler ${index}` }
            : {},
  );
  const grid = await openGrid(server, fixture);
  dispose.push(grid.close);
  return { server, fixture, grid, ids: fixture.ids };
}

it('fills a dragged block as series, skips computed cells, and undoes in one step', async () => {
  const { grid, ids } = await projects();
  const [name, amount, due, , day] = ids as [string, string, string, string, string];
  grid.controller.host.fill!({
    source: range(0, 0, 1, 4),
    target: range(2, 0, 4, 4),
    direction: 'down',
    copy: false,
  });
  await vi.waitFor(() => expect(grid.value(4, amount)).toBe(50));
  expect([2, 3, 4].map((row) => grid.value(row, name))).toEqual(['Task 3', 'Task 4', 'Task 5']);
  expect([2, 3, 4].map((row) => grid.value(row, amount))).toEqual([30, 40, 50]);
  expect([2, 3, 4].map((row) => grid.value(row, due))).toEqual(['2026-03-31', '2026-04-30', '2026-05-31']);
  expect([2, 3, 4].map((row) => grid.value(row, day))).toEqual(['Wed', 'Thu', 'Fri']);
  const updates = grid.commands().filter((command) => command.kind === 'record.update');
  expect(new Set(updates.map((command) => command.groupId)).size).toBe(1);
  expect(grid.toasts().at(-1)).toMatchObject({
    title: 'Filled 12 cells',
    description: 'Skipped 3 cells that can’t be changed here.',
    tone: 'success',
  });
  await vi.waitFor(() => expect(grid.session.canUndo()).toBe(true));
  await grid.session.undo();
  await vi.waitFor(() => expect(grid.value(4, amount)).toBeNull());
  expect([2, 3, 4].map((row) => grid.value(row, name))).toEqual(['Filler 2', 'Filler 3', 'Filler 4']);
  expect(grid.value(2, due)).toBeNull();
});

it('copies with Alt, and continues upward and across', async () => {
  const { grid, ids } = await projects();
  const [name, amount, , , day] = ids as [string, string, string, string, string];
  grid.controller.host.fill!({
    source: range(0, 1, 1, 1),
    target: range(2, 1, 5, 1),
    direction: 'down',
    copy: true,
  });
  await vi.waitFor(() => expect(grid.value(5, amount)).toBe(20));
  expect([2, 3, 4, 5].map((row) => grid.value(row, amount))).toEqual([10, 20, 10, 20]);
  grid.controller.host.fill!({
    source: range(4, 0, 5, 0),
    target: range(1, 0, 3, 0),
    direction: 'up',
    copy: false,
  });
  await vi.waitFor(() => expect(grid.value(1, name)).toBe('Filler 1'));
  expect([2, 3].map((row) => grid.value(row, name))).toEqual(['Filler 2', 'Filler 3']);
  // Across a row, a value lands in a field of another type the way a paste would read it.
  grid.controller.host.fill!({
    source: range(0, 0, 0, 0),
    target: range(0, 1, 0, 4),
    direction: 'right',
    copy: false,
  });
  await vi.waitFor(() => expect(grid.value(0, day)).toBe('Task 5'));
  expect(grid.value(0, amount)).toBe(10);
  expect(grid.toasts().at(-1)).toMatchObject({
    title: 'Filled 1 cell',
    description: 'Skipped 1 cell that can’t be changed here.  2 values didn’t fit their fields.',
  });
});

it('fills down as far as the next column goes after a double click, and selects what it filled', async () => {
  const { grid, ids } = await projects();
  const amount = ids[1]!;
  grid.grid.setSelection({ active: { row: 0, col: 1 }, range: range(0, 1, 0, 1), rows: { kind: 'none' } });
  grid.controller.host.fill!({ source: range(0, 1, 0, 1), target: null, direction: 'down', copy: false });
  await vi.waitFor(() => expect(grid.value(5, amount)).toBe(10));
  expect(grid.value(6, amount)).toBeNull();
  expect(grid.grid.getSelection().range).toEqual(range(0, 1, 5, 1));
  expect(grid.toasts().at(-1)).toMatchObject({ title: 'Filled 5 cells' });
});

it('fills down with Ctrl+D and right with Ctrl+R from the selection', async () => {
  const { grid, ids } = await projects();
  const [name, amount] = ids as [string, string];
  grid.grid.setSelection({ active: { row: 0, col: 0 }, range: range(0, 0, 3, 1), rows: { kind: 'none' } });
  expect(grid.press('d', { ctrlKey: true }).defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(grid.value(3, amount)).toBe(10));
  expect([1, 2, 3].map((row) => grid.value(row, name))).toEqual(['Task 1', 'Task 1', 'Task 1']);
  // Right from a name into a number: nothing fits, and the toast says why.
  grid.grid.setSelection({ active: { row: 4, col: 0 }, range: range(4, 0, 4, 1), rows: { kind: 'none' } });
  grid.press('r', { ctrlKey: true });
  await vi.waitFor(() =>
    expect(grid.toasts().at(-1)).toMatchObject({
      title: 'Nothing was filled',
      description: '1 value didn’t fit its field.',
    }),
  );
  expect(grid.value(4, amount)).toBeNull();
  // One row selected copies the row above it.
  grid.grid.setSelection({ active: { row: 6, col: 0 }, range: range(6, 0, 6, 0), rows: { kind: 'none' } });
  grid.press('d', { ctrlKey: true });
  await vi.waitFor(() => expect(grid.value(6, name)).toBe('Filler 5'));
  expect(grid.commands().filter((command) => command.kind === 'record.update')).toHaveLength(2);
});

it('leaves synced source cells alone, says how many, and keeps local fields filling', async () => {
  const { server, fixture, table } = syncedFixture(4);
  table.source!.allowOverrides = false;
  const grid = await openGrid(server, fixture);
  dispose.push(grid.close);
  grid.controller.host.fill!({
    source: range(0, 0, 1, 1),
    target: range(2, 0, 3, 1),
    direction: 'down',
    copy: false,
  });
  await vi.waitFor(() => expect(grid.value(3, fixture.numberFieldId)).toBe(3));
  expect(grid.value(2, fixture.textFieldId)).toBe('Record 3');
  expect(grid.toasts().at(-1)).toMatchObject({
    title: 'Filled 2 cells',
    description: 'Skipped 2 cells that can’t be changed here.',
  });
});

// Ten thousand cells take a while on a busy machine.
it('stops at the most one fill changes, and says so', { timeout: 120_000 }, async () => {
  const server = new FakeServer();
  const fixture = seedTable(server, [{ name: 'Name', type: 'text' }], FILL_LIMIT + 20, (index, [name]) =>
    index === 0 ? { [name!]: 'Row 1' } : {},
  );
  const grid = await openGrid(server, fixture);
  dispose.push(grid.close);
  grid.controller.host.fill!({
    source: range(0, 0, 0, 0),
    target: range(1, 0, FILL_LIMIT + 10, 0),
    direction: 'down',
    copy: false,
  });
  await vi.waitFor(() => expect(grid.toasts().at(-1)?.title).toBe('Filled 10,000 cells'), {
    timeout: 15_000,
  });
  expect(grid.toasts().at(-1)?.description).toBe('A fill changes up to 10,000 cells, so it stopped there.');
  expect(grid.value(FILL_LIMIT, fixture.ids[0]!)).toBe(`Row ${FILL_LIMIT + 1}`);
  expect(grid.commands().filter((command) => command.kind === 'record.update')).toHaveLength(10);
});
