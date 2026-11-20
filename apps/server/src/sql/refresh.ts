import { redactUrlUserinfo } from '../logger.js';

/**
 * How often the SQL views are checked, and the longest a failing refresh waits before it tries
 * again.  The wait after a failure starts at `everyMs` and doubles each time, up to `longestMs`.
 */
export const SQL_VIEWS_REFRESH = { everyMs: 5_000, longestMs: 5 * 60_000 };

export interface RefreshLog {
  error(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
}

/**
 * What a failure says in the log: its code and message, and nothing else it carries.  An address
 * in the message loses its user name and password, and a long message is cut short.
 */
export function failureCause(error: unknown): { code?: string; message: string } {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  return {
    ...(typeof code === 'string' ? { code } : {}),
    message: redactUrlUserinfo(typeof message === 'string' ? message : String(error)).slice(0, 500),
  };
}

/**
 * Runs `refresh` every `everyMs`.  It answers `undefined` when there's nothing to refresh yet, as
 * before a database is set up.  The first failure is logged with its cause, and later ones are
 * quiet while the wait between tries doubles.  The first success after them is logged once.
 */
export function scheduleRefresh(
  refresh: () => Promise<void> | undefined,
  log: RefreshLog,
  timing: { everyMs: number; longestMs: number } = SQL_VIEWS_REFRESH,
): { stop(): Promise<void> } {
  let failures = 0;
  let stopped = false;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = () =>
    failures ? Math.min(timing.everyMs * 2 ** (failures - 1), timing.longestMs) : timing.everyMs;
  const next = () => {
    if (stopped) return;
    timer = setTimeout(tick, wait());
    timer.unref?.();
  };
  function tick() {
    const pending = refresh();
    if (!pending) return next();
    running = pending
      .then(
        () => {
          if (failures) log.info({ failures }, 'SQL views are refreshing again');
          failures = 0;
        },
        (error: unknown) => {
          if (!failures) log.error({ cause: failureCause(error) }, 'SQL views could not be refreshed');
          failures += 1;
        },
      )
      .finally(() => {
        running = undefined;
        next();
      });
  }
  next();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
