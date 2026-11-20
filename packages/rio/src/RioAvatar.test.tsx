/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Profiler } from 'react';
import { i18n } from '@lingui/core';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RioAvatar } from './RioAvatar';
import { RIO_MOODS } from './moods';
import { useRioMood } from './useRioMood';

let reducedMotion = false;
let motionListener: (() => void) | undefined;
let observed: Element | undefined;
let intersection: IntersectionObserverCallback;
const disconnect = vi.fn();
const removeMotionListener = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  reducedMotion = false;
  observed = undefined;
  motionListener = undefined;
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: reducedMotion,
      media: '(prefers-reduced-motion: reduce)',
      addEventListener: (_event: string, listener: () => void) => {
        motionListener = listener;
      },
      removeEventListener: removeMotionListener,
    })),
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersection = callback;
      }
      observe(element: Element) {
        observed = element;
      }
      disconnect = disconnect;
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function advance(milliseconds: number) {
  act(() => {
    vi.advanceTimersByTime(milliseconds);
  });
}

function avatar() {
  return screen.getByRole('button', { name: 'Rio' }).closest('.rio-avatar');
}

function intersect(isIntersecting: boolean) {
  intersection(
    [{ target: observed, isIntersecting } as IntersectionObserverEntry],
    {} as IntersectionObserver,
  );
}

describe('RioAvatar', () => {
  it('preserves every supplied mascot path in the cached artwork', () => {
    const readSvg = (relative: string) =>
      new DOMParser().parseFromString(
        readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8'),
        'image/svg+xml',
      );
    const supplied = readSvg('../../../apps/web/public/brand/riosoma-mascot.svg');
    const cached = readSvg('./mascot.svg');
    for (const part of supplied.querySelectorAll('path[id]')) {
      const preserved = cached.getElementById(part.id);
      expect(preserved, part.id).toBeTruthy();
      expect(preserved?.getAttribute('d'), part.id).toBe(part.getAttribute('d'));
    }
    expect(cached.querySelectorAll('#resting use').length).toBeGreaterThan(10);
  });

  it.each(RIO_MOODS)('names the %s image with its translated mood', (mood) => {
    render(<RioAvatar mood={mood} size={96} autoNap={false} />);
    expect(screen.getByRole('img', { name: `Rio, ${mood}` })).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('updates accessible names when the language changes', () => {
    render(<RioAvatar size={96} />);
    act(() => {
      i18n.load('test', {
        'rio.mood.idle': 'resting',
        'rio.avatar.label': ['Companion, ', ['mood']],
      });
      i18n.activate('test');
    });
    expect(screen.getByRole('img', { name: 'Companion, resting' })).toBeTruthy();
    act(() => {
      i18n.activate('en-US');
    });
  });

  it('naps after twelve seconds by default and wakes on a controlled mood change', () => {
    const { rerender } = render(<RioAvatar size={96} />);
    advance(11999);
    expect(screen.getByRole('img', { name: 'Rio, idle' })).toBeTruthy();
    advance(1);
    expect(screen.getByRole('img', { name: 'Rio, napping' })).toBeTruthy();
    rerender(<RioAvatar size={96} mood="thinking" />);
    expect(screen.getByRole('img', { name: 'Rio, thinking' })).toBeTruthy();
    advance(30000);
    expect(screen.getByRole('img', { name: 'Rio, thinking' })).toBeTruthy();
  });

  it('restarts the idle delay after a mood change and honors a custom delay', () => {
    const { rerender } = render(<RioAvatar size={96} napDelaySeconds={3} />);
    advance(2000);
    rerender(<RioAvatar size={96} mood="thinking" napDelaySeconds={3} />);
    rerender(<RioAvatar size={96} mood="idle" napDelaySeconds={3} />);
    advance(2999);
    expect(screen.getByRole('img', { name: 'Rio, idle' })).toBeTruthy();
    advance(1);
    expect(screen.getByRole('img', { name: 'Rio, napping' })).toBeTruthy();
  });

  it('can disable auto-napping', () => {
    render(<RioAvatar size={48} autoNap={false} />);
    advance(60000);
    expect(screen.getByRole('img', { name: 'Rio, idle' })).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['idle', 'idle'],
    ['thinking', 'thinking'],
    ['oops', 'idle'],
  ] as const)('pokes %s into happy for 1.6 seconds, then settles into %s', (mood, after) => {
    const onPoke = vi.fn();
    render(<RioAvatar mood={mood} size={96} onPoke={onPoke} autoNap={false} />);
    expect(screen.queryByRole('img')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Rio' }));
    expect(avatar()?.getAttribute('data-mood')).toBe('happy');
    expect(onPoke).toHaveBeenCalledOnce();
    advance(1599);
    expect(avatar()?.getAttribute('data-mood')).toBe('happy');
    advance(1);
    expect(avatar()?.getAttribute('data-mood')).toBe(after);
  });

  it.each(['happy', 'celebrating'] as const)('calls onPoke without a reaction while %s', (mood) => {
    const onPoke = vi.fn();
    render(<RioAvatar mood={mood} size={96} onPoke={onPoke} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rio' }));
    expect(avatar()?.getAttribute('data-mood')).toBe(mood);
    expect(onPoke).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('wakes a nap into oops for 1.3 seconds, then idles and restarts the nap delay', () => {
    render(<RioAvatar size={96} napDelaySeconds={2} onPoke={() => {}} />);
    advance(2000);
    expect(avatar()?.getAttribute('data-mood')).toBe('napping');
    fireEvent.click(screen.getByRole('button', { name: 'Rio' }));
    expect(avatar()?.getAttribute('data-mood')).toBe('oops');
    advance(1299);
    expect(avatar()?.getAttribute('data-mood')).toBe('oops');
    advance(1);
    expect(avatar()?.getAttribute('data-mood')).toBe('idle');
    advance(1999);
    expect(avatar()?.getAttribute('data-mood')).toBe('idle');
    advance(1);
    expect(avatar()?.getAttribute('data-mood')).toBe('napping');
  });

  it('resets the nap delay on a poke', () => {
    render(<RioAvatar size={96} onPoke={() => {}} />);
    advance(11000);
    fireEvent.click(screen.getByRole('button', { name: 'Rio' }));
    advance(1600);
    advance(11999);
    expect(avatar()?.getAttribute('data-mood')).toBe('idle');
    advance(1);
    expect(avatar()?.getAttribute('data-mood')).toBe('napping');
  });

  it('does not extend a reaction when poked again during happy', () => {
    const onPoke = vi.fn();
    render(<RioAvatar size={96} onPoke={onPoke} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rio' }));
    advance(1000);
    fireEvent.click(screen.getByRole('button', { name: 'Rio' }));
    advance(600);
    expect(avatar()?.getAttribute('data-mood')).toBe('idle');
    expect(onPoke).toHaveBeenCalledTimes(2);
  });

  it('lets a controlled mood change cancel an in-flight poke', () => {
    const onPoke = vi.fn();
    const { rerender } = render(<RioAvatar size={96} onPoke={onPoke} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rio' }));
    advance(500);
    rerender(<RioAvatar mood="celebrating" size={96} onPoke={onPoke} />);
    advance(5000);
    expect(avatar()?.getAttribute('data-mood')).toBe('celebrating');
  });

  it('supports Enter and Space through native button semantics', async () => {
    vi.useRealTimers();
    const onPoke = vi.fn();
    const user = userEvent.setup();
    render(<RioAvatar size={96} onPoke={onPoke} autoNap={false} />);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Rio' }));
    await user.keyboard('{Enter}');
    expect(avatar()?.getAttribute('data-mood')).toBe('happy');
    await user.keyboard(' ');
    expect(avatar()?.getAttribute('data-mood')).toBe('happy');
    expect(onPoke).toHaveBeenCalledTimes(2);
  });

  it('sets reduced motion from the explicit prop and live system preference', () => {
    const { container, rerender } = render(<RioAvatar size={96} motion="reduce" />);
    expect(container.firstElementChild?.getAttribute('data-motion')).toBe('reduce');
    rerender(<RioAvatar size={96} />);
    expect(container.firstElementChild?.getAttribute('data-motion')).toBe('auto');
    act(() => {
      reducedMotion = true;
      motionListener?.();
    });
    expect(container.firstElementChild?.getAttribute('data-motion')).toBe('reduce');
    act(() => {
      reducedMotion = false;
      motionListener?.();
    });
    expect(container.firstElementChild?.getAttribute('data-motion')).toBe('auto');
  });

  it('marks small avatars and uses unique body clips for multiple instances', () => {
    render(
      <>
        <RioAvatar size={32} />
        <RioAvatar size={48} />
        <RioAvatar size={96} scene />
      </>,
    );
    const images = screen.getAllByRole('img');
    expect(images.map((image) => image.closest('.rio-avatar')?.getAttribute('data-small'))).toEqual([
      'true',
      'true',
      'false',
    ]);
    expect(images.map((image) => image.getAttribute('width'))).toEqual(['32', '48', '96']);
    const clips = images.map((image) => image.querySelector('clipPath')?.id);
    expect(new Set(clips).size).toBe(3);
    images.forEach((image, index) =>
      expect(image.querySelector('[clip-path]')?.getAttribute('clip-path')).toBe(`url(#${clips[index]})`),
    );
    expect(images[2]?.getAttribute('data-scene')).toBe('true');
  });

  it('pauses offscreen and hidden instances without rendering', () => {
    const onRender = vi.fn();
    const { container, unmount } = render(
      <Profiler id="rio" onRender={onRender}>
        <RioAvatar size={96} />
      </Profiler>,
    );
    onRender.mockClear();
    act(() => {
      intersect(false);
    });
    expect(container.firstElementChild?.getAttribute('data-offscreen')).toBe('true');
    act(() => {
      intersect(true);
    });
    expect(container.firstElementChild?.getAttribute('data-offscreen')).toBe('false');
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    fireEvent(document, new Event('visibilitychange'));
    expect(container.firstElementChild?.getAttribute('data-hidden')).toBe('true');
    hidden.mockReturnValue(false);
    fireEvent(document, new Event('visibilitychange'));
    expect(container.firstElementChild?.getAttribute('data-hidden')).toBe('false');
    expect(onRender).not.toHaveBeenCalled();
    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(removeMotionListener).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not request animation frames or re-render during ten seconds of idle', () => {
    const frame = vi.fn();
    vi.stubGlobal('requestAnimationFrame', frame);
    const onRender = vi.fn();
    render(
      <Profiler id="rio" onRender={onRender}>
        <RioAvatar size={96} />
      </Profiler>,
    );
    expect(onRender).toHaveBeenCalledOnce();
    advance(10000);
    expect(onRender).toHaveBeenCalledOnce();
    expect(frame).not.toHaveBeenCalled();
  });
  it.each([32, 48])('keeps an idle avatar at %s pixels free of timers when auto-nap is disabled', (size) => {
    render(<RioAvatar size={size} autoNap={false} />);
    expect(vi.getTimerCount()).toBe(0);
    advance(10000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('suspends nap and poke deadlines while hidden and resumes their remaining delays', () => {
    render(<RioAvatar size={48} napDelaySeconds={3} onPoke={() => {}} />);
    advance(1000);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    fireEvent(document, new Event('visibilitychange'));
    expect(vi.getTimerCount()).toBe(0);
    advance(5000);
    expect(avatar()?.getAttribute('data-mood')).toBe('idle');
    hidden.mockReturnValue(false);
    fireEvent(document, new Event('visibilitychange'));
    advance(2000);
    expect(avatar()?.getAttribute('data-mood')).toBe('napping');
    fireEvent.click(screen.getByRole('button', { name: 'Rio' }));
    advance(300);
    hidden.mockReturnValue(true);
    fireEvent(document, new Event('visibilitychange'));
    expect(vi.getTimerCount()).toBe(0);
    advance(5000);
    expect(avatar()?.getAttribute('data-mood')).toBe('oops');
    hidden.mockReturnValue(false);
    fireEvent(document, new Event('visibilitychange'));
    advance(1000);
    expect(avatar()?.getAttribute('data-mood')).toBe('idle');
  });

  it('preserves an outgoing body pose, blends for 400 milliseconds, and releases animation work', () => {
    const original = getComputedStyle;
    vi.stubGlobal('getComputedStyle', (element: Element) => {
      if (element.classList.contains('rio-avatar__body'))
        return {
          transform:
            element.getAttribute('data-body-mood') === 'happy' ? 'matrix(0.97, 0, 0, 1.05, 0, -28)' : 'none',
        };
      return original(element);
    });
    const cancel = vi.fn();
    const pause = vi.fn();
    const play = vi.fn();
    const transition = {
      cancel,
      pause,
      play,
      playState: 'running',
      finished: new Promise(() => {}),
      onfinish: null,
    };
    const animate = vi
      .spyOn(SVGElement.prototype, 'animate')
      .mockReturnValue(transition as unknown as Animation);
    const { container, rerender } = render(<RioAvatar mood="happy" size={48} autoNap={false} />);
    rerender(<RioAvatar mood="idle" size={48} autoNap={false} />);
    expect(animate).toHaveBeenCalledWith(
      [{ transform: 'matrix(0.97, 0, 0, 1.05, 0, -28)' }, { transform: 'none' }],
      { duration: 400, easing: 'ease-in-out' },
    );
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    fireEvent(document, new Event('visibilitychange'));
    expect(pause).toHaveBeenCalledOnce();
    hidden.mockReturnValue(false);
    transition.playState = 'paused';
    fireEvent(document, new Event('visibilitychange'));
    expect(play).toHaveBeenCalledOnce();
    (transition.onfinish as unknown as () => void)();
    expect(cancel).toHaveBeenCalledOnce();
    expect(container.querySelector('.rio-avatar__body')?.getAttribute('style') ?? '').not.toContain('paused');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up poke timeouts on unmount', () => {
    const { unmount } = render(<RioAvatar size={96} onPoke={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rio' }));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('useRioMood', () => {
  it('pulses a mood for the requested duration before returning', () => {
    const { result } = renderHook(() => useRioMood('thinking'));
    act(() => {
      result.current[2]('happy', 2);
    });
    expect(result.current[0]).toBe('happy');
    advance(1999);
    expect(result.current[0]).toBe('happy');
    advance(1);
    expect(result.current[0]).toBe('thinking');
  });

  it('preserves the original return mood when a pulse is replaced', () => {
    const { result } = renderHook(() => useRioMood());
    act(() => {
      result.current[2]('happy', 2);
    });
    advance(1000);
    act(() => {
      result.current[2]('celebrating', 3);
    });
    advance(2999);
    expect(result.current[0]).toBe('celebrating');
    advance(1);
    expect(result.current[0]).toBe('idle');
  });

  it('cancels a pulse when the caller sets a mood, including functional updates', () => {
    const { result } = renderHook(() => useRioMood());
    act(() => {
      result.current[2]('happy', 2);
    });
    act(() => {
      result.current[1]((mood) => (mood === 'happy' ? 'thinking' : 'oops'));
    });
    advance(2000);
    expect(result.current[0]).toBe('thinking');
  });

  it('cleans up a pulse on unmount', () => {
    const { result, unmount } = renderHook(() => useRioMood());
    act(() => {
      result.current[2]('happy', 2);
    });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
