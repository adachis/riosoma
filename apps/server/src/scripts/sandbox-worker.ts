import { parentPort, workerData } from 'node:worker_threads';
import type { ScriptLimits, ScriptSurface } from '../automations/script.js';
import { runScript, ScriptClock, ScriptError } from '../automations/script.js';
import type { FromSandbox, ToSandbox } from './sandbox.js';

/**
 * One script's sandbox, in a worker thread of its own, for a script panel run or an automation's
 * script step.  Only calls cross to the server's thread, as serialized values.  On its own thread,
 * a script that spins never holds up anyone else's requests, and the server can end it whatever
 * it's doing.  A thread starts for every script, so this file loads the sandbox and nothing else
 * of the server's.
 */

const port = parentPort!;
const { source, limits, surface, input, prelude } = workerData as {
  source: string;
  limits: ScriptLimits;
  surface: ScriptSurface;
  input: Record<string, unknown>;
  prelude?: string;
};

const post = (message: FromSandbox) => port.postMessage(message);

/** Tells the server's thread when the script's own time begins, so it can follow the clock */
class SandboxClock extends ScriptClock {
  override begin(): void {
    super.begin();
    post({ type: 'started' });
  }
}

const clock = new SandboxClock(limits.timeoutMs);
const controller = new AbortController();
const calls = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
let next = 0;

/** A refusal the script can catch, carrying only its message key */
class Refusal extends Error {
  constructor(readonly messageKey: string) {
    super(messageKey);
  }
}

port.on('message', (message: ToSandbox) => {
  switch (message.type) {
    case 'serialized-result': {
      const call = calls.get(message.id);
      calls.delete(message.id);
      call?.resolve(message.value);
      return;
    }
    case 'result': {
      const call = calls.get(message.id);
      calls.delete(message.id);
      if (!call) return;
      if (message.error)
        call.reject(
          message.error.fatal
            ? new ScriptError(message.error.messageKey, message.error.detail)
            : new Refusal(message.error.messageKey),
        );
      else call.resolve(message.value);
      return;
    }
    case 'clock':
      if (message.paused) clock.pause();
      else clock.resume();
      return;
    case 'stop':
      controller.abort(new ScriptError(message.messageKey));
      return;
  }
});

const host = {
  callSerialized: (method: string, args: string, remainingMs: number) =>
    new Promise<string>((resolve, reject) => {
      next += 1;
      calls.set(next, { resolve: (value) => resolve(String(value)), reject });
      post({ type: 'serialized-call', id: next, method, args, remainingMs });
    }),
  call: (method: string, args: unknown[], remainingMs: number) =>
    new Promise<unknown>((resolve, reject) => {
      next += 1;
      calls.set(next, { resolve, reject });
      post({ type: 'call', id: next, method, args, remainingMs });
    }),
};
let peakSandboxBytes = 0;

try {
  const value = await runScript(source, input, host, [], {
    limits,
    surface,
    prelude,
    ...(surface === 'ingest'
      ? {
          onMemory: (bytes: number) => {
            peakSandboxBytes = Math.max(peakSandboxBytes, bytes);
          },
        }
      : {}),
    clock,
    signal: controller.signal,
    onLog: (entry) => post({ type: 'log', entry }),
    onOutput: (output) => post({ type: 'output', output }),
  });
  post({
    type: 'done',
    ms: clock.used(),
    value,
    error: null,
    ...(surface === 'ingest' ? { peakSandboxBytes } : {}),
  });
} catch (error) {
  post({
    type: 'done',
    ms: clock.used(),
    // What an automation's script set as its output before it failed is kept.
    value: error instanceof ScriptError ? error.output : null,
    error:
      error instanceof ScriptError
        ? { messageKey: error.messageKey, detail: error.detail, line: error.line, column: error.column }
        : { messageKey: 'errors.internal', detail: '', line: 1, column: 1 },
  });
}
