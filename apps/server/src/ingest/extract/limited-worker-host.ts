import { getHeapStatistics } from 'node:v8';
import { setEnvironmentData, Worker } from 'node:worker_threads';
import type { WorkerHostMessage, WorkerRequest } from './limited-worker.js';
import { startLimitedWorker } from './limited-worker-entry.js';
import { overBudget } from './memory-budget.js';
import { failed, type ExtractionResult } from './types.js';

// A dedicated process makes resident growth attributable to one reader, including native allocations.
const initial = getHeapStatistics();
process.once('disconnect', () => process.exit(0));

process.once('message', ({ url, workerData, memoryBytes }: WorkerRequest) => {
  setEnvironmentData('extractionWorker.entry', url);
  setEnvironmentData('extractionWorker.memoryBytes', memoryBytes);
  setEnvironmentData('extractionWorker.memoryFailure', failed('memory-limit'));
  let worker: Worker;
  try {
    // The loaded bootstrap is JavaScript, so a source run needs no extra type parser to start it.
    const entry = new URL(
      `data:text/javascript,${encodeURIComponent(`(${startLimitedWorker.toString()})()`)}`,
    );
    worker = new Worker(entry, {
      workerData,
      execArgv: url.endsWith('.ts') ? ['--import', 'tsx'] : [],
      resourceLimits: {
        maxOldGenerationSizeMb: memoryBytes / (1024 * 1024),
        maxYoungGenerationSizeMb: 8,
        stackSizeMb: 2,
      },
    });
  } catch {
    process.send!({ kind: 'result', result: failed('worker-died') } satisfies WorkerHostMessage);
    return;
  }
  let settled = false;
  let checking = false;
  let baselineRss: number | undefined;
  const finish = (result: ExtractionResult) => {
    if (settled) return;
    settled = true;
    clearInterval(sampler);
    process.send!({ kind: 'result', result } satisfies WorkerHostMessage);
  };
  const exceeded = (heapBytes = 0, externalBytes = 0) => {
    const current = getHeapStatistics();
    const hostHeap = Math.max(0, current.total_physical_size - initial.total_physical_size);
    const hostExternal = Math.max(0, current.external_memory - initial.external_memory);
    return overBudget(
      {
        heapBytes: heapBytes + hostHeap,
        externalBytes: externalBytes + hostExternal,
        residentBytes: baselineRss === undefined ? 0 : process.memoryUsage.rss() - baselineRss,
      },
      memoryBytes,
    );
  };
  const sampler = setInterval(() => {
    if (settled) return;
    // RSS remains observable even during synchronous native decoding or a blocked worker event loop.
    if (exceeded()) return finish(failed('memory-limit'));
    if (checking) return;
    checking = true;
    void worker
      .getHeapStatistics()
      .then((statistics) => {
        if (!settled && exceeded(statistics.total_physical_size, statistics.external_memory))
          finish(failed('memory-limit'));
      })
      .catch(() => {
        /* The worker's error and exit handlers report its failure. */
      })
      .finally(() => {
        checking = false;
      });
  }, 10);
  worker.on(
    'message',
    (
      message:
        | { kind: 'ready' }
        | {
            kind: 'result';
            result: ExtractionResult;
            heapBytes: number;
            externalBytes: number;
          },
    ) => {
      if (settled) return;
      if (message.kind === 'ready') {
        // File work waits for a baseline, so fixed native thread startup cannot hide decoding allocations.
        baselineRss = process.memoryUsage.rss();
        worker.postMessage('start');
      } else
        finish(exceeded(message.heapBytes, message.externalBytes) ? failed('memory-limit') : message.result);
    },
  );
  worker.once('error', (error: Error & { code?: string }) => {
    finish(failed(error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'memory-limit' : 'worker-died'));
  });
  worker.once('exit', () => finish(failed('worker-died')));
});

process.send!({ kind: 'ready' } satisfies WorkerHostMessage);
