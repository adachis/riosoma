import { mkdtempSync, rmSync } from 'node:fs';
import { Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMainThread } from 'node:worker_threads';
import { guardTestConnection, neutralizeCloudEnvironment, noteRunningTestServer } from './isolation.js';

const installed = Symbol.for('riosoma.testIsolation');
const current = Socket.prototype.connect as typeof Socket.prototype.connect & { [installed]?: string };
let directory = current[installed];

/** The signals that end a test worker without running its `exit` handlers. */
const endingSignals = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;

/**
 * Removes a worker's folder when the worker ends.  Vitest ends fork workers with SIGTERM, which skips
 * `exit` handlers, so a fork worker also removes the folder on SIGTERM, SIGINT, or SIGHUP and then
 * raises the signal again, so the process still ends by it.  Those handlers go only to a Vitest
 * worker's main thread that handles none of these signals yet.  The main Vitest process loads this
 * file through the global setup, and its logger already handles SIGINT and SIGTERM by flushing output
 * before it exits, which a second raise would cut short.  Thread workers never receive signals.
 */
function removeWhenEnded(folder: string): void {
  const remove = () => rmSync(folder, { recursive: true, force: true });
  process.once('exit', remove);
  if (!process.env.VITEST_POOL_ID || !isMainThread) return;
  if (endingSignals.some((signal) => process.listenerCount(signal) > 0)) return;
  for (const signal of endingSignals) {
    process.once(signal, () => {
      try {
        remove();
      } catch {
        // The signal still ends the worker.
      }
      // A handler added since then decides what the signal does, as it would have without this one.
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    });
  }
}

// Built-in modules survive Vitest's per-file module reset, so install one guard per worker.
if (!directory) {
  directory = mkdtempSync(join(tmpdir(), 'rio-test-cloud-'));
  removeWhenEnded(directory);
  const guarded = new Proxy(current, {
    apply(target, socket, args: unknown[]) {
      return Reflect.apply(target, socket, guardTestConnection(args));
    },
  });
  Object.defineProperty(guarded, installed, { value: directory });
  Socket.prototype.connect = guarded;

  // A listener of this process taking a port ends any claim on it, so a port an earlier server
  // stopped on is not still refused after something here holds it again.
  const binding = new Proxy(Server.prototype.listen, {
    apply(target, server, args: unknown[]) {
      const bound = Reflect.apply(target, server, args) as Server;
      bound.once('listening', () => {
        const address = bound.address();
        if (address && typeof address === 'object') noteRunningTestServer(address.port);
      });
      return bound;
    },
  });
  Server.prototype.listen = binding;
}

neutralizeCloudEnvironment(directory);
