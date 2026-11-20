import { afterEach, expect, it, vi } from 'vitest';
import { createDrag, type DragHooks } from './drag.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).forEach((run) => run());
  document.body.replaceChildren();
  vi.useRealTimers();
});
function fixture(direction: 'ltr' | 'rtl' = 'ltr') {
  const root = document.createElement('div');
  root.innerHTML = '<div data-rio-row="1"><button data-rio-drag-row></button></div>';
  root.dir = direction;
  document.body.append(root);
  root.setPointerCapture = vi.fn();
  root.hasPointerCapture = () => false;
  const hooks: DragHooks = {
    instructions: () => 'test.moveInstructions',
    count: () => 1000000,
    hit: () => 8,
    reason: () => null,
    move: vi.fn(),
    preview: vi.fn(),
    announce: vi.fn(),
  };
  const drag = createDrag(root, hooks);
  cleanup.push(drag.destroy);
  const handle = root.querySelector('button')!;
  const key = (key: string) =>
    (root.contains(document.activeElement) ? document.activeElement! : handle).dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
  const pointer = (type: string, x: number, pointerType = 'mouse') => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { pointerId: 1, button: 0, clientX: x, clientY: 0, pointerType });
    handle.dispatchEvent(event);
  };
  return { hooks, key, pointer, root, handle };
}
it('retains keyboard control when scrolling removes the original row handle', () => {
  const { hooks, key, root, handle } = fixture();
  handle.focus();
  key(' ');
  expect(root.contains(document.activeElement)).toBe(true);
  expect(document.activeElement).not.toBe(handle);
  const holder = document.activeElement!;
  expect(holder.getAttribute('role')).toBe('application');
  expect(holder.getAttribute('aria-label')).toBe('test.moveInstructions');
  handle.remove();
  holder.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  holder.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(hooks.move).toHaveBeenCalledExactlyOnceWith('row', 1, 2);
});
it('previews keyboard moves without moving rows and commits one drop', () => {
  const { hooks, key } = fixture();
  key(' ');
  key('ArrowDown');
  key('ArrowDown');
  expect(hooks.move).not.toHaveBeenCalled();
  key('Enter');
  expect(hooks.move).toHaveBeenCalledExactlyOnceWith('row', 1, 3);
});
it('announces a refusal before dropping and cancels with Escape', () => {
  const { hooks, key } = fixture();
  hooks.reason = () => 'test.locked';
  key(' ');
  key('ArrowDown');
  expect(hooks.announce).toHaveBeenLastCalledWith('target', 'row', 2, 'test.locked');
  key('Enter');
  expect(hooks.move).not.toHaveBeenCalled();
  hooks.reason = () => null;
  key(' ');
  key('ArrowDown');
  key('Escape');
  expect(hooks.move).not.toHaveBeenCalled();
  expect(hooks.announce).toHaveBeenLastCalledWith('cancel', 'row', 2, null);
});
it.each(['mouse', 'pen'])('commits a %s drag only on release', (kind) => {
  const { hooks, pointer } = fixture();
  pointer('pointerdown', 0, kind);
  pointer('pointermove', 20, kind);
  expect(hooks.move).not.toHaveBeenCalled();
  pointer('pointerup', 20, kind);
  expect(hooks.move).toHaveBeenCalledExactlyOnceWith('row', 1, 8);
});
it('requires a short touch press and cancels a touch moved before the press', () => {
  vi.useFakeTimers();
  const { hooks, pointer } = fixture();
  pointer('pointerdown', 0, 'touch');
  pointer('pointermove', 20, 'touch');
  vi.advanceTimersByTime(200);
  pointer('pointerup', 20, 'touch');
  expect(hooks.move).not.toHaveBeenCalled();
  pointer('pointerdown', 0, 'touch');
  vi.advanceTimersByTime(220);
  pointer('pointermove', 20, 'touch');
  pointer('pointerup', 20, 'touch');
  expect(hooks.move).toHaveBeenCalledExactlyOnceWith('row', 1, 8);
});

it('cancels a touch released outside the grid, which is the only way out a touch has', () => {
  vi.useFakeTimers();
  const { pointer, hooks } = fixture();
  const outside = vi.fn();
  Object.assign(hooks, { bounds: () => new DOMRect(0, 0, 100, 100), outside });
  let inside = true;
  hooks.hit = () => (inside ? 8 : null);
  pointer('pointerdown', 0, 'touch');
  vi.advanceTimersByTime(220);
  pointer('pointermove', 20, 'touch');
  expect(hooks.preview).toHaveBeenLastCalledWith('row', 8, null, 1);
  inside = false;
  pointer('pointermove', 120, 'touch');
  expect(outside).toHaveBeenCalledExactlyOnceWith('row', 1);
  pointer('pointermove', 130, 'touch');
  expect(outside).toHaveBeenCalledExactlyOnceWith('row', 1);
  pointer('pointerup', 130, 'touch');
  expect(hooks.move).not.toHaveBeenCalled();
  expect(hooks.announce).toHaveBeenLastCalledWith('cancel', 'row', 8, null);
  // Returning inside offers the drop again, so backing out costs nothing but the trip.
  pointer('pointerdown', 0, 'touch');
  vi.advanceTimersByTime(220);
  pointer('pointermove', 20, 'touch');
  inside = true;
  pointer('pointermove', 30, 'touch');
  pointer('pointerup', 30, 'touch');
  expect(hooks.move).toHaveBeenCalledExactlyOnceWith('row', 1, 8);
});

it('keeps an activated touch drag when implicit capture transfers from its source', () => {
  vi.useFakeTimers();
  const { root, handle, pointer, hooks } = fixture();
  root.setPointerCapture = () => {
    const lost = new Event('lostpointercapture', { bubbles: true });
    Object.assign(lost, { pointerId: 1 });
    handle.dispatchEvent(lost);
  };
  pointer('pointerdown', 0, 'touch');
  vi.advanceTimersByTime(220);
  pointer('pointermove', 20, 'touch');
  pointer('pointerup', 20, 'touch');
  expect(hooks.move).toHaveBeenCalledExactlyOnceWith('row', 1, 8);
});

it('waits 220 milliseconds and tolerates seven pixels before touch activation', () => {
  vi.useFakeTimers();
  const { pointer, hooks } = fixture();
  pointer('pointerdown', 0, 'touch');
  vi.advanceTimersByTime(219);
  expect(hooks.announce).not.toHaveBeenCalled();
  pointer('pointermove', 6, 'touch');
  vi.advanceTimersByTime(1);
  pointer('pointermove', 20, 'touch');
  pointer('pointerup', 20, 'touch');
  expect(hooks.move).toHaveBeenCalledExactlyOnceWith('row', 1, 8);
});

it.each(['pointer', 'focus'])('cancels a keyboard move when %s interaction leaves the move', (kind) => {
  const { key, root, hooks, handle } = fixture();
  handle.focus();
  key(' ');
  key('ArrowDown');
  const input = document.createElement('textarea');
  (kind === 'focus' ? document.body : root).append(input);
  if (kind === 'pointer') input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  input.focus();
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(hooks.move).not.toHaveBeenCalled();
  expect(hooks.announce).toHaveBeenLastCalledWith('cancel', 'row', 2, null);
});

it('leaves the next unrelated pointer click available after a touch drop', () => {
  vi.useFakeTimers();
  const { pointer, root } = fixture();
  pointer('pointerdown', 0, 'touch');
  vi.advanceTimersByTime(220);
  pointer('pointermove', 20, 'touch');
  pointer('pointerup', 20, 'touch');
  const button = document.createElement('button');
  root.append(button);
  const clicked = vi.fn();
  button.addEventListener('click', clicked);
  button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  button.click();
  expect(clicked).toHaveBeenCalledOnce();
});

it('moves columns in visual arrow direction in RTL', () => {
  const { key, handle, hooks } = fixture('rtl');
  handle.removeAttribute('data-rio-drag-row');
  handle.dataset.rioColumn = '4';
  handle.focus();
  key(' ');
  key('ArrowRight');
  key('Enter');
  expect(hooks.move).toHaveBeenCalledExactlyOnceWith('column', 4, 3);
});

it('keeps scrolling at the pointer edge and previews rows outside the initial window', () => {
  vi.useFakeTimers();
  const { pointer, hooks } = fixture();
  let offset = 0;
  const scroll = vi.fn((_dx: number, dy: number) => {
    offset += dy;
  });
  Object.assign(hooks, { bounds: () => new DOMRect(0, 0, 100, 100), scroll });
  hooks.hit = () => 8 + Math.floor(offset / 32);
  pointer('pointerdown', 0);
  pointer('pointermove', 20);
  vi.advanceTimersByTime(100);
  expect(scroll).toHaveBeenCalled();
  expect(hooks.preview).toHaveBeenCalledWith('row', expect.any(Number), null, 1);
  pointer('pointerup', 20);
  const calls = scroll.mock.calls.length;
  vi.advanceTimersByTime(100);
  expect(scroll).toHaveBeenCalledTimes(calls);
});
