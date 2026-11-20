import { useRef } from 'react';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from './test/render';
import { useLayoutDrag } from './useLayoutDrag';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it.each([
  { from: 'a', to: 'b', x: 0, y: 4, input: 'touch' },
  { from: 'b', to: 'a', x: 0, y: 0, input: 'touch' },
  { from: 'a', to: 'b', x: 0, y: 4, input: 'keyboard' },
  { from: 'b', to: 'a', x: 0, y: 0, input: 'keyboard' },
  { from: 'a', to: 'b', x: 0, y: 4, input: 'touch', third: true },
  { from: 'a', to: 'b', x: 0, y: 4, input: 'keyboard', third: true },
])(
  'reorders stacked items from the same desktop row with $input: $from to $to, third: $third',
  ({ from, to, x, y, input, third }) => {
    if (input === 'touch') vi.useFakeTimers();
    const items = [
      { id: 'a', place: { x: 0, y: 0, w: 3, h: 2 } },
      { id: 'b', place: { x: 3, y: 0, w: 6, h: 4 } },
      ...(third ? [{ id: 'c', place: { x: 9, y: 0, w: 3, h: 2 } }] : []),
    ];
    const place = vi.fn((current, id, target) =>
      current.map((item: (typeof items)[number]) => (item.id === id ? { ...item, place: target } : item)),
    );
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
        place,
        nudge: (current) => current,
        resize: (current) => current,
        onCommit: commit,
        onAnnounce: vi.fn(),
      });
      return (
        <div ref={grid} style={{ display: 'grid', gridTemplateColumns: '390px' }}>
          {items.map((item) => (
            <article key={item.id} data-block={item.id}>
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
    for (const [index, item] of items.entries()) {
      const article = screen.getByRole('button', { name: item.id }).closest('article')!;
      vi.spyOn(article, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: index * 200,
        top: index * 200,
        bottom: (index + 1) * 200,
        left: 0,
        right: 390,
        width: 390,
        height: 200,
        toJSON: () => ({}),
      });
    }
    const sourceY = from === 'a' ? 20 : 220;
    const destinationY = to === 'a' ? 20 : 220;
    if (input === 'keyboard') {
      fireEvent.keyDown(screen.getByRole('button', { name: from }), {
        key: from === 'a' ? 'ArrowDown' : 'ArrowUp',
      });
    } else {
      fireEvent.pointerDown(screen.getByRole('button', { name: from }), {
        button: 0,
        pointerId: 7,
        pointerType: 'touch',
        clientX: 10,
        clientY: sourceY,
      });
      expect(commit).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(220);
      });
      fireEvent.pointerMove(window, {
        pointerId: 7,
        pointerType: 'touch',
        clientX: 10,
        clientY: destinationY,
      });
      fireEvent.pointerUp(window, { pointerId: 7, pointerType: 'touch' });
    }
    const target = {
      ...items.find((item) => item.id === from)!.place,
      x,
      y,
    };
    if (third) {
      expect(place).toHaveBeenNthCalledWith(1, items, from, target);
      const saved = commit.mock.calls[0]![0] as typeof items;
      expect(
        [...saved].sort((a, b) => a.place.y - b.place.y || a.place.x - b.place.x).map((item) => item.id),
      ).toEqual(['b', 'a', 'c']);
    } else expect(place).toHaveBeenCalledExactlyOnceWith(items, from, target);
    expect(commit).toHaveBeenCalledOnce();
  },
);

it('keeps horizontal position and size unchanged in a single track at tablet width', () => {
  const item = { id: 'a', place: { x: 3, y: 0, w: 4, h: 2 } };
  const commit = vi.fn();
  const place = vi.fn((items, id, target) => [{ ...items[0], place: target }]);
  const nudge = vi.fn((items) => items);
  const resize = vi.fn((items) => items);
  function Layout() {
    const grid = useRef<HTMLDivElement>(null);
    const drag = useLayoutDrag({
      items: [item],
      enabled: true,
      grid,
      columns: 12,
      rowHeight: 80,
      maxRow: 1_000,
      place,
      nudge,
      resize,
      onCommit: commit,
      onAnnounce: vi.fn(),
    });
    return (
      <div ref={grid} style={{ display: 'grid', gridTemplateColumns: '700px' }}>
        <button
          onPointerDown={(event) => drag.startDrag(event, item, 'move')}
          onKeyDown={(event) => drag.handleKeyDown(event, item)}
        >
          Move
        </button>
        <button onPointerDown={(event) => drag.startDrag(event, item, 'resize')}>Resize</button>
      </div>
    );
  }
  render(<Layout />);
  const handle = screen.getByRole('button', { name: 'Move' });
  fireEvent.keyDown(handle, { key: 'ArrowRight' });
  fireEvent.keyDown(handle, { key: 'ArrowDown', shiftKey: true });
  expect(nudge).not.toHaveBeenCalled();
  expect(resize).not.toHaveBeenCalled();
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Resize' }), {
    button: 0,
    pointerId: 1,
    clientX: 0,
    clientY: 0,
  });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 100, clientY: 100 });
  fireEvent.pointerUp(window, { pointerId: 1 });
  expect(place).not.toHaveBeenCalled();
  fireEvent.pointerDown(handle, { button: 0, pointerId: 2, clientX: 0, clientY: 0 });
  fireEvent.pointerMove(window, { pointerId: 2, clientX: 200, clientY: 160 });
  fireEvent.pointerUp(window, { pointerId: 2 });
  expect(place).toHaveBeenCalledOnce();
  expect(commit).toHaveBeenCalledExactlyOnceWith([{ ...item, place: { ...item.place, y: 2 } }], true);
  expect(place.mock.calls.every((call) => call[2].x === 3 && call[2].w === 4)).toBe(true);
});
