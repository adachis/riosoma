import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRESS_MS, useHeld, useViewDrag, type ScrollTarget } from './useViewDrag';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const i18n = setupI18n({ locale: 'en', messages: { en: {} } });

function Harness({
  value,
  drop,
  open,
  move,
  scroll,
  range,
  insets,
}: {
  value: string;
  drop(): void;
  open?(): void;
  move?(): void;
  scroll?: ScrollTarget;
  range?: string;
  insets?: Partial<Record<'left' | 'right' | 'top' | 'bottom', number>>;
}) {
  const drag = useViewDrag();
  const held = useHeld(value, drag.holding, range);
  return (
    <>
      <button
        onPointerDown={(event) =>
          drag.start(event, {
            move: move ?? (() => undefined),
            drop,
            scroll,
            scrollInsets: insets ?? { left: 240, top: 40 },
          })
        }
        onClick={() => {
          if (!drag.suppressClick.current) open?.();
        }}
      >
        Record
      </button>
      <div data-testid="snapshot">{held}</div>
      <div role="status">{drag.announcement}</div>
      <button onClick={() => drag.setStatus('Saved')}>Announce</button>
    </>
  );
}
function content(value: string, drop: () => void, open?: () => void) {
  return (
    <I18nProvider i18n={i18n}>
      <Harness value={value} drop={drop} open={open} />
    </I18nProvider>
  );
}

describe('shared view pointer gestures', () => {
  it('suppresses the canceled pointer click and allows keyboard activation after release', () => {
    vi.useFakeTimers();
    const drop = vi.fn();
    const open = vi.fn();
    render(content('Before', drop, open));
    const button = screen.getByRole('button', { name: 'Record' });
    fireEvent.pointerDown(button, { button: 0, pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, clientX: 40, clientY: 20 });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.pointerUp(window, { pointerId: 1 });
    fireEvent.click(button);
    expect(open).not.toHaveBeenCalled();
    expect(drop).not.toHaveBeenCalled();
    act(() => vi.runOnlyPendingTimers());
    fireEvent.click(button, { detail: 0 });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it.each(['mouse', 'pen'])(
    'commits one %s drop only on release and holds arriving changes',
    (pointerType) => {
      if (pointerType === 'pen') vi.useFakeTimers();
      const drop = vi.fn();
      const ui = render(content('Before', drop));
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Record' }), {
        button: 0,
        pointerId: 1,
        pointerType,
        clientX: 20,
        clientY: 20,
      });
      ui.rerender(content('After', drop));
      expect(screen.getByTestId('snapshot').textContent).toBe('Before');
      if (pointerType === 'pen') act(() => vi.advanceTimersByTime(PRESS_MS + 1));
      fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, clientX: 40, clientY: 20 });
      expect(drop).not.toHaveBeenCalled();
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 40, clientY: 20 });
      expect(drop).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('snapshot').textContent).toBe('After');
    },
  );

  it.each(['touch', 'pen'])(
    'lets early %s movement scroll and activates a held press before dropping',
    (pointerType) => {
      vi.useFakeTimers();
      const drop = vi.fn();
      render(content('Before', drop));
      const press = () =>
        fireEvent.pointerDown(screen.getByRole('button', { name: 'Record' }), {
          button: 0,
          pointerId: 2,
          pointerType,
          clientX: 20,
          clientY: 20,
        });
      press();
      fireEvent.pointerMove(window, { buttons: 1, pointerId: 2, clientX: 20, clientY: 40 });
      act(() => vi.advanceTimersByTime(PRESS_MS + 1));
      fireEvent.pointerUp(window, { pointerId: 2 });
      expect(drop).not.toHaveBeenCalled();
      press();
      act(() => vi.advanceTimersByTime(PRESS_MS + 1));
      expect(screen.getByRole('status').textContent).toContain('Picked up');
      fireEvent.pointerMove(window, { buttons: 1, pointerId: 2, clientX: 40, clientY: 20 });
      fireEvent.pointerUp(window, { pointerId: 2, clientX: 40, clientY: 20 });
      expect(drop).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['Escape', 'pointercancel'])('cancels with %s and never commits a later release', (cancel) => {
    const drop = vi.fn();
    render(content('Before', drop));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Record' }), {
      button: 0,
      pointerId: 1,
      clientX: 20,
      clientY: 20,
    });
    fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, clientX: 40, clientY: 20 });
    if (cancel === 'Escape') fireEvent.keyDown(window, { key: 'Escape' });
    else fireEvent.pointerCancel(window, { pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(drop).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe('Move canceled.');
  });
});

describe('gesture recovery and shared thresholds', () => {
  const press = (pointerType = 'mouse') =>
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Record' }), {
      button: 0,
      buttons: 1,
      pointerId: 1,
      pointerType,
      clientX: 300,
      clientY: 100,
    });
  const move = (buttons = 1, clientX = 310) =>
    fireEvent.pointerMove(window, {
      pointerId: 1,
      pointerType: 'mouse',
      buttons,
      clientX,
      clientY: 100,
    });
  it('uses a 220 ms touch press, 7 px tolerance, and 5 px pointer distance', () => {
    vi.useFakeTimers();
    render(content('Before', vi.fn()));
    press('touch');
    act(() => vi.advanceTimersByTime(220));
    expect(screen.getByRole('status').textContent).toContain('Picked up');
    fireEvent.pointerCancel(window, { pointerId: 1 });
    press('touch');
    move(1, 307.5);
    act(() => vi.advanceTimersByTime(220));
    expect(screen.getByRole('status').textContent).not.toContain('Picked up');
    press();
    move(1, 304);
    expect(screen.getByRole('status').textContent).not.toContain('Picked up');
    move(1, 305);
    expect(screen.getByRole('status').textContent).toContain('Picked up');
  });
  it.each(['blur', 'visibilitychange', 'mouse', 'pen'])('cancels a lost release on %s', (reason) => {
    if (reason === 'pen') vi.useFakeTimers();
    const drop = vi.fn();
    render(content('Before', drop));
    press(reason === 'pen' ? 'pen' : 'mouse');
    if (reason === 'pen') act(() => vi.advanceTimersByTime(PRESS_MS + 1));
    move();
    if (reason === 'blur') fireEvent(window, new Event('blur'));
    else if (reason === 'visibilitychange') fireEvent(document, new Event('visibilitychange'));
    else fireEvent.pointerMove(window, { pointerId: 1, pointerType: reason, buttons: 0, clientX: 320 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(drop).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe('Move canceled.');
  });
  it('handles Escape before an overlay and stops its propagation', () => {
    render(content('Before', vi.fn()));
    const button = screen.getByRole('button', { name: 'Record' });
    const overlay = vi.fn((event: Event) => event.stopPropagation());
    button.addEventListener('keydown', overlay);
    press();
    move();
    fireEvent.keyDown(button, { key: 'Escape' });
    expect(screen.getByRole('status').textContent).toBe('Move canceled.');
    expect(overlay).not.toHaveBeenCalled();
  });
  it('replaces canceled feedback and re-announces identical messages', () => {
    render(content('Before', vi.fn()));
    press();
    move();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Announce' }));
    expect(screen.getByRole('status').textContent).toBe('Saved');
    const message = screen.getByRole('status').firstChild;
    fireEvent.click(screen.getByRole('button', { name: 'Announce' }));
    expect(screen.getByRole('status').firstChild).not.toBe(message);
  });
  it('holds a snapshot only within the same range', () => {
    const ui = render(
      <I18nProvider i18n={i18n}>
        <Harness value="Old" range="week1" drop={vi.fn()} />
      </I18nProvider>,
    );
    press();
    ui.rerender(
      <I18nProvider i18n={i18n}>
        <Harness value="New" range="week2" drop={vi.fn()} />
      </I18nProvider>,
    );
    expect(screen.getByTestId('snapshot').textContent).toBe('New');
  });
  it('updates stationary gestures only when scrolling and measures the chart edge', () => {
    vi.useFakeTimers();
    const scroller = document.createElement('div');
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
    } as DOMRect);
    const moved = vi.fn();
    render(
      <I18nProvider i18n={i18n}>
        <Harness value="Before" drop={vi.fn()} move={moved} scroll={scroller} />
      </I18nProvider>,
    );
    press();
    move();
    moved.mockClear();
    act(() => vi.advanceTimersByTime(64));
    expect(moved).not.toHaveBeenCalled();
    move(1, 250);
    moved.mockClear();
    act(() => vi.advanceTimersByTime(32));
    expect(scroller.scrollLeft).toBeLessThan(0);
    expect(moved).toHaveBeenCalled();
  });
});

describe('a list of scroll nodes', () => {
  const box = (top: number, bottom: number) => ({ left: 0, top, right: 400, bottom }) as DOMRect;
  const at = (clientY: number) =>
    fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, clientX: 200, clientY });
  const frames = () => act(() => vi.advanceTimersByTime(32));

  it('scrolls the outer view at its own edges, the inner target in between, and hands over a full one', () => {
    vi.useFakeTimers();
    const outer = document.createElement('div');
    const inner = document.createElement('div');
    vi.spyOn(outer, 'getBoundingClientRect').mockReturnValue(box(0, 600));
    vi.spyOn(inner, 'getBoundingClientRect').mockReturnValue(box(100, 620));
    const moved = vi.fn();
    render(
      <I18nProvider i18n={i18n}>
        <Harness value="Before" drop={vi.fn()} move={moved} scroll={[outer, inner]} insets={{ top: 40 }} />
      </I18nProvider>,
    );
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Record' }), {
      button: 0,
      pointerId: 1,
      clientX: 200,
      clientY: 300,
    });
    // Near the outer view's bottom edge, over an inner target that has no edge there: the outer
    // view moves, so a drag over an inner target still reaches what's off screen.
    at(570);
    moved.mockClear();
    frames();
    expect(outer.scrollTop).toBeGreaterThan(0);
    expect(inner.scrollTop).toBe(0);
    expect(moved).toHaveBeenCalled();
    // Away from the outer edge, over the inner target's own top edge: the inner target moves.
    outer.scrollTop = 0;
    at(120);
    moved.mockClear();
    frames();
    expect(outer.scrollTop).toBe(0);
    expect(inner.scrollTop).toBeLessThan(0);
    expect(moved).toHaveBeenCalled();
    // An outer view with no room left in that direction hands the pointer to the inner one.
    inner.scrollTop = 0;
    Object.defineProperty(outer, 'scrollTop', { get: () => 0, set: () => undefined });
    at(600);
    moved.mockClear();
    frames();
    expect(inner.scrollTop).toBeGreaterThan(0);
    expect(moved).toHaveBeenCalled();
  });
});

it('checks the target again after active targets render', () => {
  const seen: boolean[] = [];
  function Targets() {
    const drag = useViewDrag();
    return (
      <>
        <button
          onPointerDown={(event) =>
            drag.start(event, {
              move: () => {
                seen.push(!!document.querySelector('[data-active-target]'));
              },
              drop: () => undefined,
            })
          }
        >
          Pick up
        </button>
        {drag.active && <div data-active-target />}
      </>
    );
  }
  render(
    <I18nProvider i18n={i18n}>
      <Targets />
    </I18nProvider>,
  );
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Pick up' }), {
    button: 0,
    pointerId: 1,
    clientX: 20,
  });
  fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, clientX: 40 });
  expect(seen).toContain(true);
  fireEvent.keyDown(window, { key: 'Escape' });
});
