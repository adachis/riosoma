import { fork, type ChildProcess } from 'node:child_process';
import { failed, LIMITS, type ExtractionResult } from './types.js';

export interface WorkerLimits {
  milliseconds?: number;
  memoryMb?: number;
}

export interface WorkerRequest {
  url: string;
  workerData: unknown;
  memoryBytes: number;
}

export type WorkerHostMessage = { kind: 'ready' } | { kind: 'result'; result: ExtractionResult };

/** The deadline belongs to the parent, so even a parser that blocks its event loop is terminated. */
export async function runLimitedWorker(
  url: URL,
  workerData: unknown,
  limits: WorkerLimits = {},
): Promise<ExtractionResult> {
  const milliseconds = limits.milliseconds ?? LIMITS.milliseconds;
  const memoryMb = limits.memoryMb ?? LIMITS.memoryMb;
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds <= 0 ||
    milliseconds > LIMITS.milliseconds ||
    !Number.isFinite(memoryMb) ||
    memoryMb < 8 ||
    memoryMb > LIMITS.memoryMb
  )
    return failed('invalid');
  const built = import.meta.url.endsWith('.js');
  let host: ChildProcess;
  try {
    host = fork(
      new URL(built ? './limited-worker-host.js' : './limited-worker-host.ts', import.meta.url),
      [],
      {
        // The executable is an absolute path, and module resolution needs no server variables.
        env: {},
        execArgv: built ? [] : ['--import', 'tsx'],
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      },
    );
  } catch {
    return failed('worker-died');
  }
  const exited = new Promise<void>((resolve) => host.once('close', () => resolve()));
  try {
    return await new Promise<ExtractionResult>((resolve) => {
      let settled = false;
      const finish = (result: ExtractionResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => finish(failed('timeout')), milliseconds);
      host.on('message', (message: WorkerHostMessage) => {
        if (settled) return;
        if (message.kind === 'ready') {
          const request: WorkerRequest = { url: url.href, workerData, memoryBytes: memoryMb * 1024 * 1024 };
          host.send(request, (error) => {
            if (error) finish(failed('worker-died'));
          });
        } else finish(message.result);
      });
      host.once('error', () => finish(failed('worker-died')));
      host.once('exit', () => finish(failed('worker-died')));
    });
  } finally {
    // Killing only this host also stops native work that cannot service thread termination promptly.
    host.kill('SIGKILL');
    await exited;
  }
}
