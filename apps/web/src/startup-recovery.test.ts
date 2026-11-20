// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../public/startup-recovery.js', import.meta.url), 'utf8');

it('answers the repair guard before the entry module links and keeps it across a new document', () => {
  const storage = new Map<string, string>();
  const sessionStorage = {
    getItem: (key: string) => storage.get(key),
    setItem: (key: string, value: string) => storage.set(key, value),
  };
  const open = () => {
    const serviceWorker = new EventTarget();
    runInNewContext(source, {
      window: { addEventListener: vi.fn() },
      document: { addEventListener: vi.fn(), readyState: 'loading' },
      navigator: { serviceWorker },
      sessionStorage,
      Date,
      setTimeout,
      clearTimeout,
    });
    return (start = false) => {
      const reply = vi.fn();
      serviceWorker.dispatchEvent(
        Object.assign(new Event('message'), {
          data: { type: 'asset-repair-guard', start },
          ports: [{ postMessage: reply }],
        }),
      );
      return reply;
    };
  };
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100_000);
  try {
    const first = open();
    expect(first(true)).toHaveBeenCalledWith({ lastAttempt: 100_000, started: true });
    const replacement = open();
    clock.mockReturnValue(100_010);
    expect(replacement()).toHaveBeenCalledWith({ lastAttempt: 100_000 });
    expect(replacement(true)).toHaveBeenCalledWith({ lastAttempt: 100_000, started: false });
    clock.mockReturnValue(130_001);
    expect(replacement(true)).toHaveBeenCalledWith({ lastAttempt: 130_001, started: true });
  } finally {
    clock.mockRestore();
  }
});

function startup() {
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), {
    readyState: 'loading',
    getElementById: () => screen,
  });
  const screen = { hidden: true };
  runInNewContext(source, {
    window,
    document,
    navigator: {},
    Date,
    setTimeout,
    clearTimeout,
  });
  return { window, document, screen, loaded: () => window.dispatchEvent(new Event('load')) };
}

it('exposes recovery after a bounded startup with no mount and no error event', () => {
  vi.useFakeTimers();
  try {
    const { screen, loaded } = startup();
    loaded();
    vi.advanceTimersByTime(9_999);
    expect(screen.hidden).toBe(true);
    vi.advanceTimersByTime(1);
    expect(screen.hidden).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it('does not count the time a slow download takes before the page has loaded', () => {
  vi.useFakeTimers();
  try {
    const { screen, loaded } = startup();
    // The page and its scripts are still arriving: no wait has started.
    vi.advanceTimersByTime(60_000);
    expect(screen.hidden).toBe(true);
    loaded();
    vi.advanceTimersByTime(9_999);
    expect(screen.hidden).toBe(true);
    vi.advanceTimersByTime(1);
    expect(screen.hidden).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it('starts the wait at once on a page that had already loaded', () => {
  vi.useFakeTimers();
  try {
    const window = new EventTarget();
    const screen = { hidden: true };
    runInNewContext(source, {
      window,
      document: Object.assign(new EventTarget(), { readyState: 'complete', getElementById: () => screen }),
      navigator: {},
      Date,
      setTimeout,
      clearTimeout,
    });
    vi.advanceTimersByTime(10_000);
    expect(screen.hidden).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it('leaves a mounted app alone and clears a fallback if startup eventually finishes', () => {
  vi.useFakeTimers();
  try {
    const ready = startup();
    ready.loaded();
    ready.window.dispatchEvent(new Event('rio:app-ready'));
    vi.advanceTimersByTime(10_000);
    expect(ready.screen.hidden).toBe(true);
    const slow = startup();
    slow.loaded();
    vi.advanceTimersByTime(10_000);
    expect(slow.screen.hidden).toBe(false);
    slow.window.dispatchEvent(new Event('rio:app-ready'));
    expect(slow.screen.hidden).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
