import { useRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TilePlace } from '@riosoma/contracts';
import { useLayoutDrag } from '@riosoma/ui';
import { nudgeTile, overlaps, placeTile, readingOrder, resizeTile, type Place } from './layout';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type Item = { id: string; place: Place };

function layout(items: Item[]) {
  const commit = vi.fn();
  function Layout() {
    const grid = useRef<HTMLDivElement>(null);
    const drag = useLayoutDrag({
      items,
      enabled: true,
      grid,
      columns: 12,
      rowHeight: 80,
      maxRow: 1_000,
      place: placeTile,
      nudge: nudgeTile,
      resize: resizeTile,
      onCommit: commit,
      onAnnounce: vi.fn(),
    });
    return (
      <div ref={grid} style={{ display: 'grid', gridTemplateColumns: '390px' }}>
        {readingOrder(items).map((item) => (
          <article key={item.id} data-tile={item.id}>
            <button
              onPointerDown={(event) => drag.startDrag(event, item, 'move')}
              onKeyDown={(event) => drag.handleKeyDown(event, item)}
            >
              {item.id}
            </button>
          </article>
        ))}
      </div>
    );
  }
  render(<Layout />);
  const edges = [
    [0, 156],
    [168, 356],
    [368, 524],
  ];
  for (const [index, item] of readingOrder(items).entries()) {
    const [top, bottom] = edges[index] ?? [index * 200, index * 200 + 188];
    vi.spyOn(
      screen.getByRole('button', { name: item.id }).closest('article')!,
      'getBoundingClientRect',
    ).mockReturnValue({
      top: top!,
      bottom: bottom!,
      left: 0,
      right: 390,
      x: 0,
      y: top!,
      width: 390,
      height: bottom! - top!,
      toJSON: () => ({}),
    });
  }
  return commit;
}

async function drop(id: string, y: number) {
  const handle = screen.getByRole('button', { name: id });
  const origin = handle.closest('article')!.getBoundingClientRect().top + 20;
  const pointer = { button: 0, pointerId: 7, pointerType: 'touch', clientX: 10, clientY: origin };
  fireEvent.pointerDown(handle, pointer);
  await new Promise((resolve) => setTimeout(resolve, 250));
  fireEvent.pointerMove(window, { ...pointer, clientY: y });
  fireEvent.pointerUp(window, { ...pointer, clientY: y });
}

function validOrder(saved: Item[], expected: string[]) {
  expect(saved.every((item) => TilePlace.safeParse(item.place).success)).toBe(true);
  expect(readingOrder(saved).map((item) => item.id)).toEqual(expected);
  expect(
    saved.every((item, index) => saved.slice(index + 1).every((other) => !overlaps(item.place, other.place))),
  ).toBe(true);
}

it.each(['keyboard', 'touch'])(
  'rebases a phone reorder near the last permitted row with %s',
  async (input) => {
    const items = [
      { id: 'a', place: { x: 5, y: 991, w: 1, h: 2 } },
      { id: 'b', place: { x: 5, y: 995, w: 3, h: 6 } },
      { id: 'c', place: { x: 9, y: 995, w: 3, h: 6 } },
    ];
    const commit = layout(items);
    if (input === 'keyboard')
      fireEvent.keyDown(screen.getByRole('button', { name: 'a' }), { key: 'ArrowDown' });
    else await drop('a', 262);
    expect(commit).toHaveBeenCalledOnce();
    const saved = commit.mock.calls[0]![0] as Item[];
    validOrder(saved, ['b', 'a', 'c']);
    expect(saved.map((item) => [item.place.w, item.place.h])).toEqual(
      items.map((item) => [item.place.w, item.place.h]),
    );
  },
);

it('preserves phone order when disjoint columns are clamped at the last row', () => {
  const commit = layout([
    { id: 'a', place: { x: 0, y: 998, w: 2, h: 1 } },
    { id: 'b', place: { x: 4, y: 1000, w: 2, h: 1 } },
    { id: 'c', place: { x: 8, y: 1000, w: 2, h: 1 } },
  ]);
  fireEvent.keyDown(screen.getByRole('button', { name: 'a' }), { key: 'ArrowDown' });
  validOrder(commit.mock.calls[0]![0] as Item[], ['b', 'a', 'c']);
});

it.each([0, 990])('rebases only the suffix that needs space after a prefix at row %s', (y) => {
  const prefix = { id: 'prefix', place: { x: 0, y, w: 12, h: 6 } };
  const commit = layout([
    prefix,
    { id: 'a', place: { x: 5, y: 996, w: 1, h: 2 } },
    { id: 'b', place: { x: 5, y: 999, w: 3, h: 6 } },
    { id: 'c', place: { x: 9, y: 999, w: 3, h: 6 } },
  ]);
  fireEvent.keyDown(screen.getByRole('button', { name: 'a' }), { key: 'ArrowDown' });
  const saved = commit.mock.calls[0]![0] as Item[];
  validOrder(saved, ['prefix', 'b', 'a', 'c']);
  if (y === 0) expect(saved[0]).toBe(prefix);
  else expect(saved[0]!.place.y).toBeLessThan(y);
});

it.each([
  { from: 'a', y: 362, expected: ['b', 'a', 'c'] },
  { from: 'c', y: 162, expected: ['a', 'c', 'b'] },
  { from: 'c', y: -20, expected: ['c', 'a', 'b'] },
  { from: 'a', y: 550, expected: ['b', 'c', 'a'] },
])('inserts $from at a phone gap or list edge at $y', async ({ from, y, expected }) => {
  const commit = layout(
    ['a', 'b', 'c'].map((id, index) => ({
      id,
      place: { x: index * 4, y: 0, w: 4, h: 2 },
    })),
  );
  await drop(from, y);
  expect(commit).toHaveBeenCalledOnce();
  validOrder(commit.mock.calls[0]![0] as Item[], expected);
});

it.each([
  { from: 'a', y: -20 },
  { from: 'c', y: 550 },
])('leaves $from unchanged when it is already at the dropped list edge', ({ from, y }) => {
  const commit = layout(
    ['a', 'b', 'c'].map((id, index) => ({
      id,
      place: { x: index * 4, y: 0, w: 4, h: 2 },
    })),
  );
  drop(from, y);
  expect(commit).not.toHaveBeenCalled();
});
