/**
 * An error nothing caught, and a promise nothing answered, both stop at the page's window: the
 * emulator hands them to an event nobody listens to, and the reporter drops what a listener logs.
 * A test can pass, then, on a page that would be broken in use.  This keeps whatever escapes and
 * hands it back, so the setup can fail the test it escaped from.
 */

/** An escaping error as a line a person can read. */
function describe(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? typeof value;
  } catch {
    return typeof value;
  }
}

/** The window a test's page runs in, which hears an error no listener caught. */
export interface ErrorWindow {
  addEventListener(type: 'error' | 'unhandledrejection', listener: (event: Event) => void): void;
}

/** The process the tests run in, which hears a promise nothing answered. */
export interface ErrorProcess {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
}

export interface UncaughtErrors {
  /** What escaped since the last call, oldest first. */
  take(): string[];
}

/** A test that runs outside a page, such as a service worker's, has no window to hear from. */
function pageWindow(): ErrorWindow | null {
  return typeof window === 'undefined' ? null : window;
}

export function watchUncaughtErrors(
  view: ErrorWindow | null = pageWindow(),
  host: ErrorProcess = process,
): UncaughtErrors {
  const kept: string[] = [];
  const seen = new Set<unknown>();

  const keep = (value: unknown): void => {
    // The same error can arrive through more than one hatch: React hands it to the window and to
    // the console, and a rejection in a page reaches the window and the process alike.
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return;
      seen.add(value);
    }
    kept.push(describe(value));
  };

  view?.addEventListener('error', (event) => {
    const error = (event as ErrorEvent).error ?? (event as ErrorEvent).message;
    // A stack that ran out is the one that used to vanish, and the one a recursion always throws.
    if (error instanceof RangeError) keep(error);
  });
  view?.addEventListener('unhandledrejection', (event) => keep((event as PromiseRejectionEvent).reason));
  host.on('unhandledRejection', (reason) => keep(reason));

  return {
    take: () => {
      const taken = kept.splice(0);
      seen.clear();
      return taken;
    },
  };
}
