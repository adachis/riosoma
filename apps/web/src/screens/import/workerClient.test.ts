import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectFile, streamFile, type WorkerRequest, type WorkerResponse } from './workerClient';

class TestWorker {
  static instances: TestWorker[] = [];
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  messages: WorkerRequest[] = [];
  constructor(
    readonly url: string | URL,
    readonly options: WorkerOptions,
  ) {
    TestWorker.instances.push(this);
  }
  postMessage(message: WorkerRequest) {
    this.messages.push(message);
  }
  reply(response: WorkerResponse) {
    this.onmessage?.({ data: response } as MessageEvent<WorkerResponse>);
  }
}
afterEach(() => {
  TestWorker.instances = [];
  vi.unstubAllGlobals();
});
function worker() {
  return TestWorker.instances.at(-1)!;
}
describe('worker lifecycle', () => {
  it('requests the next chunk only after the consumer finishes the previous chunk', async () => {
    vi.stubGlobal('Worker', TestWorker);
    const stream = streamFile({ kind: 'csv', file: new Blob(['A\nB']) });
    const first = stream.next();
    const instance = worker();
    expect(instance.options).toEqual({ type: 'module' });
    expect(new URL(String(instance.url), window.location.href).pathname).toContain('/rowsWorker.ts');
    instance.reply({ kind: 'rows', rows: [['A'], ['B']], done: false });
    expect(await first).toEqual({ value: ['A'], done: false });
    expect(instance.messages).toHaveLength(1);
    expect(await stream.next()).toEqual({ value: ['B'], done: false });
    expect(instance.messages).toHaveLength(1);
    const next = stream.next();
    await vi.waitFor(() => expect(instance.messages.at(-1)).toEqual({ kind: 'next' }));
    instance.reply({ kind: 'rows', rows: [], done: true });
    expect((await next).done).toBe(true);
    expect(instance.terminate).toHaveBeenCalledOnce();
  });
  it('terminates streaming when the consumer cancels', async () => {
    vi.stubGlobal('Worker', TestWorker);
    const stream = streamFile({ kind: 'csv', file: new Blob(['A']) });
    const first = stream.next();
    worker().reply({ kind: 'rows', rows: [['A']], done: false });
    await first;
    await stream.return(undefined);
    expect(worker().terminate).toHaveBeenCalledOnce();
    expect(worker().messages).toHaveLength(1);
  });
  it('forwards progress and releases the worker after a preview', async () => {
    vi.stubGlobal('Worker', TestWorker);
    const progress = vi.fn();
    const promise = inspectFile({ kind: 'csv', file: new Blob(['A']) }, true, undefined, progress);
    worker().reply({ kind: 'progress', fraction: 0.5 });
    worker().reply({ kind: 'preview', preview: { header: ['A'], rows: [], stats: [], total: 0 } });
    expect((await promise).header).toEqual(['A']);
    expect(progress).toHaveBeenCalledWith(0.5);
    expect(worker().terminate).toHaveBeenCalledOnce();
  });
  it('aborts stale scans and rejects worker errors', async () => {
    vi.stubGlobal('Worker', TestWorker);
    const controller = new AbortController();
    const promise = inspectFile({ kind: 'csv', file: new Blob(['A']) }, true, controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow('import.unreadable');
    expect(worker().terminate).toHaveBeenCalled();
    const failed = inspectFile({ kind: 'sheet', rows: new Blob(['[1,"A"]\n']) }, true);
    worker().reply({ kind: 'error' });
    await expect(failed).rejects.toThrow('import.unreadable');
    expect(worker().terminate).toHaveBeenCalledOnce();
  });
});
