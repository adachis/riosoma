import { Worker } from 'node:worker_threads';
import {
  ScriptClock,
  ScriptError,
  type PanelOutput,
  type ScriptHost,
  type ScriptLimits,
  type ScriptLog,
  type ScriptSurface,
} from '../automations/script.js';

/** Messages from the server's thread to a run's sandbox */
export type ToSandbox =
  | { type: 'serialized-result'; id: number; value: string }
  | {
      type: 'result';
      id: number;
      value?: unknown;
      /** `fatal` ends the run, as a `ScriptError` from the host does in the automation step */
      error?: { messageKey: string; detail?: string; fatal: boolean };
    }
  /** The server is waiting for the person, so the script's clock stands still */
  | { type: 'clock'; paused: boolean }
  | { type: 'stop'; messageKey: string };

/** Messages from a run's sandbox to the server's thread */
export type FromSandbox =
  /** The sandbox is set up, and the script's own time begins */
  | { type: 'started' }
  | { type: 'call'; id: number; method: string; args: unknown[]; remainingMs: number }
  | { type: 'serialized-call'; id: number; method: string; args: string; remainingMs: number }
  | { type: 'log'; entry: ScriptLog }
  | { type: 'output'; output: PanelOutput }
  | {
      type: 'done';
      ms: number;
      /** What an automation's script set as its output, kept when it fails after setting it */
      value: unknown;
      error: { messageKey: string; detail: string; line: number; column: number } | null;
      peakSandboxBytes?: number;
    };

export interface SandboxRun {
  /** Stops the clock while the host waits for the person, and starts it again */
  pause(paused: boolean): void;
  /** The script's own time so far, as the server's thread follows it */
  used(): number;
  /**
   * Resolves with the script's own time and the output an automation's script set, or rejects
   * with the `ScriptError` it failed with.
   */
  done: Promise<{ ms: number; value: unknown; peakSandboxBytes?: number }>;
}

/** How long a sandbox may take to be ready, before any of the script runs */
const STARTUP_MS = 30_000;
/** How far past its time limit a script's thread may go before the server ends it */
const OVERRUN_MS = 1_000;

/** Where the worker's code is: beside this file once built, and the source under test. */
function workerFile(): { url: URL; execArgv: string[] } {
  const built = import.meta.url.endsWith('.js');
  return {
    url: new URL(built ? './sandbox-worker.js' : './sandbox-worker.ts', import.meta.url),
    // Tests and the dev server run the source, which the worker reads the way they do.
    execArgv: built ? [] : ['--import', 'tsx'],
  };
}

/**
 * Runs a script in a worker thread, answering its calls with `host` on this thread: a panel
 * script unless `options` says it's an automation step's, which also takes the step's `input`.
 * The signal ends the thread at once, even in the middle of a loop, and the run fails with the
 * signal's reason.
 *
 * The sandbox stops a script at its time limit only between the script's own instructions, and a
 * long built-in operation, such as joining a huge list, runs past it.  So this thread follows the
 * script's clock too, and ends the worker soon after the limit whatever the script is doing.
 */
export function runInSandbox(
  source: string,
  limits: ScriptLimits,
  host: ScriptHost,
  events: { log(entry: ScriptLog): void; output(output: PanelOutput): void },
  signal: AbortSignal,
  options: { surface?: ScriptSurface; input?: Record<string, unknown>; prelude?: string } = {},
): SandboxRun {
  const file = workerFile();
  const worker = new Worker(file.url, {
    workerData: {
      source,
      limits,
      surface: options.surface ?? 'panel',
      input: options.input ?? {},
      prelude: options.prelude,
    },
    execArgv: file.execArgv,
    // The script's memory is bounded inside the sandbox.  This bounds the thread around it.
    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 },
  });
  let finished = false;
  const send = (message: ToSandbox) => {
    if (!finished) worker.postMessage(message);
  };
  const clock = new ScriptClock(limits.timeoutMs);
  let started = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let expire = () => {};
  /** Sets the thread's end for when the script's time, which stands still during a pause, is up */
  const follow = () => {
    if (finished || !started) return;
    clearTimeout(deadline);
    if (!clock.paused) deadline = setTimeout(expire, clock.remaining() + OVERRUN_MS);
  };
  const done = new Promise<{ ms: number; value: unknown; peakSandboxBytes?: number }>((resolve, reject) => {
    const end = (outcome: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clock.pause();
      signal.removeEventListener('abort', stop);
      outcome();
      void worker.terminate();
    };
    expire = () => end(() => reject(new ScriptError('automations.script.timeout')));
    deadline = setTimeout(() => end(() => reject(new ScriptError('errors.internal'))), STARTUP_MS);
    const stop = () =>
      end(() =>
        reject(
          signal.reason instanceof ScriptError ? signal.reason : new ScriptError('scripts.run.canceled'),
        ),
      );
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
    worker.on('message', (message: FromSandbox) => {
      if (finished) return;
      switch (message.type) {
        case 'started':
          started = true;
          clock.begin();
          follow();
          return;
        case 'log':
          events.log(message.entry);
          return;
        case 'output':
          events.output(message.output);
          return;
        case 'call':
          void host.call(message.method, message.args, message.remainingMs).then(
            (value) => send({ type: 'result', id: message.id, value: value ?? null }),
            (error: unknown) =>
              send({
                type: 'result',
                id: message.id,
                error: {
                  messageKey:
                    error && typeof error === 'object' && 'messageKey' in error
                      ? String(error.messageKey)
                      : 'automations.script.thrown',
                  ...(error instanceof ScriptError && error.detail ? { detail: error.detail } : {}),
                  fatal: error instanceof ScriptError,
                },
              }),
          );
          return;
        case 'serialized-call':
          void Promise.resolve()
            .then(async () => {
              const args = JSON.parse(message.args) as unknown[];
              const value = await host.call(message.method, args, message.remainingMs);
              send({ type: 'serialized-result', id: message.id, value: JSON.stringify(value ?? null) });
            })
            .catch((error: unknown) =>
              send({
                type: 'result',
                id: message.id,
                error: {
                  messageKey: error instanceof ScriptError ? error.messageKey : 'automations.script.thrown',
                  fatal: true,
                },
              }),
            );
          return;
        case 'done': {
          const failure = message.error;
          end(() => {
            if (!failure)
              return resolve({
                ms: message.ms,
                value: message.value,
                ...(message.peakSandboxBytes === undefined
                  ? {}
                  : { peakSandboxBytes: message.peakSandboxBytes }),
              });
            const error = new ScriptError(failure.messageKey, failure.detail, failure.line, failure.column);
            error.output = message.value;
            reject(error);
          });
          return;
        }
      }
    });
    worker.on('error', (error: Error & { code?: string }) =>
      end(() =>
        reject(
          new ScriptError(
            error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'automations.script.memory' : 'errors.internal',
          ),
        ),
      ),
    );
    worker.on('exit', () => end(() => reject(new ScriptError('errors.internal'))));
  });
  return {
    pause: (paused) => {
      send({ type: 'clock', paused });
      if (!started || finished) return;
      if (paused) clock.pause();
      else clock.resume();
      follow();
    },
    used: () => clock.used(),
    done,
  };
}
