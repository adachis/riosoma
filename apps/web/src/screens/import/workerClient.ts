import rowsWorkerUrl from './rowsWorker.ts?worker&url';
import { trustedScriptURL } from '../../security/trusted-script-url';
import type { ImportCell } from './cells';
import type { Column, Preview } from './columns';
import type { ImportSource } from './source';
import type { PlanRequest, UpsertPlan } from './upsert';

export type WorkerRequest =
  | { kind: 'analyze'; source: ImportSource; header: boolean }
  | {
      kind: 'prepare';
      source: ImportSource;
      header: boolean;
      columns: Column[];
      existing: boolean;
      timeZone: string;
    }
  | { kind: 'plan'; source: ImportSource; header: boolean; request: PlanRequest }
  | { kind: 'stream'; source: ImportSource }
  | { kind: 'next' };
export type WorkerResponse =
  | { kind: 'progress'; fraction: number }
  | { kind: 'preview'; preview: Preview }
  | { kind: 'prepared'; columns: Column[]; misfits: number[] }
  | { kind: 'planned'; plan: UpsertPlan }
  | { kind: 'rows'; rows: ImportCell[][]; done: boolean }
  | { kind: 'error' };

function connection(signal?: AbortSignal, progress?: (fraction: number) => void) {
  const worker = new Worker(trustedScriptURL(rowsWorkerUrl), { type: 'module' });
  let pending: { resolve: (response: WorkerResponse) => void; reject: (error: Error) => void } | undefined;
  const fail = () => {
    pending?.reject(new Error('import.unreadable'));
    pending = undefined;
  };
  const close = () => {
    worker.terminate();
    fail();
    signal?.removeEventListener('abort', close);
  };
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    if (event.data.kind === 'progress') {
      progress?.(event.data.fraction);
      return;
    }
    if (event.data.kind === 'error') fail();
    else {
      pending?.resolve(event.data);
      pending = undefined;
    }
  };
  worker.onerror = fail;
  worker.onmessageerror = fail;
  signal?.addEventListener('abort', close, { once: true });
  return {
    close,
    request: (message: WorkerRequest) =>
      new Promise<WorkerResponse>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('import.unreadable'));
          return;
        }
        pending = { resolve, reject };
        worker.postMessage(message);
      }),
  };
}
export async function inspectFile(
  source: ImportSource,
  header: boolean,
  signal?: AbortSignal,
  progress?: (fraction: number) => void,
): Promise<Preview> {
  const worker = connection(signal, progress);
  try {
    const response = await worker.request({ kind: 'analyze', source, header });
    if (response.kind !== 'preview') throw new Error('import.unreadable');
    return response.preview;
  } finally {
    worker.close();
  }
}
export async function validateFile(
  source: ImportSource,
  columns: Column[],
  header: boolean,
  existing: boolean,
  timeZone: string,
  signal?: AbortSignal,
): Promise<{ columns: Column[]; misfits: number[] }> {
  const worker = connection(signal);
  try {
    const response = await worker.request({ kind: 'prepare', source, columns, header, existing, timeZone });
    if (response.kind !== 'prepared') throw new Error('import.unreadable');
    return response;
  } finally {
    worker.close();
  }
}
/** Reads every row against the table: what each would add or update, and what doesn't fit. */
export async function planFile(
  source: ImportSource,
  header: boolean,
  request: PlanRequest,
  signal?: AbortSignal,
): Promise<UpsertPlan> {
  const worker = connection(signal);
  try {
    const response = await worker.request({ kind: 'plan', source, header, request });
    if (response.kind !== 'planned') throw new Error('import.unreadable');
    return response.plan;
  } finally {
    worker.close();
  }
}
export async function* streamFile(source: ImportSource): AsyncGenerator<ImportCell[]> {
  const worker = connection();
  try {
    let response = await worker.request({ kind: 'stream', source });
    while (response.kind === 'rows') {
      yield* response.rows;
      if (response.done) return;
      response = await worker.request({ kind: 'next' });
    }
    throw new Error('import.unreadable');
  } finally {
    worker.close();
  }
}
