import { analyze, prepareColumns } from './columns';
import { numberedRows, sourceRows } from './source';
import { planUpsert } from './upsert';
import type { ImportCell } from './cells';
import type { WorkerRequest, WorkerResponse } from './workerClient';

/** Reads an import's rows off the main thread: the preview, checking every value, matching, and writing. */
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (response: WorkerResponse) => void;
};
let stream: AsyncGenerator<ImportCell[]> | undefined;
async function next() {
  const rows: ImportCell[][] = [];
  let size = 0;
  let done = false;
  while (stream && rows.length < 1000 && size < 512 * 1024) {
    const item = await stream.next();
    if (item.done) {
      done = true;
      break;
    }
    rows.push(item.value);
    size += item.value.reduce<number>(
      (sum, value) => sum + (typeof value === 'string' ? value.length : 8),
      0,
    );
  }
  scope.postMessage({ kind: 'rows', rows, done });
}
scope.onmessage = (event) => {
  const request = event.data;
  void (async () => {
    if (request.kind === 'analyze') {
      const preview = await analyze(
        sourceRows(request.source, (fraction) => scope.postMessage({ kind: 'progress', fraction })),
        request.header,
      );
      scope.postMessage({ kind: 'preview', preview });
    } else if (request.kind === 'prepare') {
      const prepared = await prepareColumns(
        sourceRows(request.source),
        request.columns,
        request.header,
        request.existing,
        request.timeZone,
      );
      scope.postMessage({ kind: 'prepared', ...prepared });
    } else if (request.kind === 'plan') {
      const plan = await planUpsert(numberedRows(request.source), request.header, request.request);
      scope.postMessage({ kind: 'planned', plan });
    } else {
      if (request.kind === 'stream') stream = sourceRows(request.source);
      await next();
    }
  })().catch(() => scope.postMessage({ kind: 'error' }));
};
