import { describe, expect, it } from 'vitest';
import { watchUncaughtErrors, type ErrorProcess, type ErrorWindow } from './uncaught';

/** A window stand-in that hands its listeners back to the test. */
function standInWindow(): ErrorWindow & { fire(type: 'error' | 'unhandledrejection', event: Event): void } {
  const listeners = new Map<string, Array<(event: Event) => void>>();
  return {
    addEventListener: (type, listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    fire: (type, event) => {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
}

/** A process stand-in that hands its listeners back to the test. */
function standInProcess(): ErrorProcess & { reject(reason: unknown): void } {
  const listeners: Array<(reason: unknown) => void> = [];
  return {
    on: (_event, listener) => {
      listeners.push(listener);
    },
    reject: (reason) => {
      for (const listener of listeners) listener(reason);
    },
  };
}

function errorEvent(error: unknown): ErrorEvent {
  return new ErrorEvent('error', {
    error,
    message: error instanceof Error ? error.message : String(error),
  });
}

describe('errors nothing caught', () => {
  it('keeps a stack that ran out and lets another kind of error pass', () => {
    const view = standInWindow();
    const uncaught = watchUncaughtErrors(view, standInProcess());
    view.fire('error', errorEvent(new TypeError('A value was the wrong shape')));
    expect(uncaught.take()).toEqual([]);
    view.fire('error', errorEvent(new RangeError('Maximum call stack size exceeded')));
    const kept = uncaught.take();
    expect(kept).toHaveLength(1);
    expect(kept[0]).toContain('Maximum call stack size exceeded');
  });

  it('keeps one error once when it arrives through both hatches', () => {
    const view = standInWindow();
    const host = standInProcess();
    const uncaught = watchUncaughtErrors(view, host);
    const overflow = new RangeError('Maximum call stack size exceeded');
    // React hands the same error to the window and to the console, and a rejection in a page
    // reaches the window and the process alike.
    view.fire('error', errorEvent(overflow));
    view.fire('error', errorEvent(overflow));
    host.reject(overflow);
    expect(uncaught.take()).toHaveLength(1);
  });

  it('keeps a promise nothing answered, whatever it was rejected with', () => {
    const view = standInWindow();
    const host = standInProcess();
    const uncaught = watchUncaughtErrors(view, host);
    host.reject(new Error('The save never came back'));
    host.reject('a reason that is not an error');
    view.fire('unhandledrejection', { reason: new RangeError('out of stack') } as PromiseRejectionEvent);
    const kept = uncaught.take();
    expect(kept).toHaveLength(3);
    expect(kept[0]).toContain('The save never came back');
    expect(kept[1]).toBe('a reason that is not an error');
    expect(kept[2]).toContain('out of stack');
    // What a test has been told about is not held against the next one.
    expect(uncaught.take()).toEqual([]);
  });

  it('describes an error that carries no stack by its name and message', () => {
    const view = standInWindow();
    const uncaught = watchUncaughtErrors(view, standInProcess());
    const bare = new RangeError('Maximum call stack size exceeded');
    delete bare.stack;
    view.fire('error', errorEvent(bare));
    expect(uncaught.take()).toEqual(['RangeError: Maximum call stack size exceeded']);
  });
});
