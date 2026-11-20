import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { DocumentImportSettings } from '@riosoma/contracts';
import { documentMessage } from './document.js';

const state = vi.hoisted(() => ({
  workers: [] as Array<{
    emit: (event: string, ...args: unknown[]) => boolean;
    terminate: ReturnType<typeof vi.fn>;
  }>,
  options: [] as unknown[],
}));
vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    terminate = vi.fn(async () => 0);
    constructor(_url: URL, options: unknown) {
      super();
      state.workers.push(this);
      state.options.push(options);
    }
  },
}));
beforeEach(() => {
  state.workers = [];
  state.options = [];
});
afterEach(() => vi.useRealTimers());
async function source() {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  return {
    data: Buffer.from(await pdf.save()).toString('base64'),
    mediaType: 'application/pdf' as const,
    label: 'internal' as const,
    locale: 'en-US',
  };
}
it('counts pages off the main thread with a bounded heap and terminates the worker', async () => {
  const pending = documentMessage(
    await source(),
    DocumentImportSettings.parse({}),
    new AbortController().signal,
  );
  expect(state.workers).toHaveLength(1);
  expect(state.options[0]).toMatchObject({
    resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
  });
  state.workers[0]!.emit('message', { pages: 1 });
  await pending;
  expect(state.workers[0]!.terminate).toHaveBeenCalledOnce();
});
it.each(['error', 'exit'] as const)('rejects a worker %s and frees its resources', async (event) => {
  const pending = documentMessage(
    await source(),
    DocumentImportSettings.parse({}),
    new AbortController().signal,
  );
  expect(state.workers).toHaveLength(1);
  const rejected = expect(pending).rejects.toMatchObject({ messageKey: 'import.document.invalid' });
  state.workers[0]!.emit(event, new Error('Fixture worker failure'));
  await rejected;
  expect(state.workers[0]!.terminate).toHaveBeenCalledOnce();
});
it('terminates PDF parsing on cancellation', async () => {
  const controller = new AbortController();
  const pending = documentMessage(await source(), DocumentImportSettings.parse({}), controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ messageKey: 'import.document.invalid' });
  controller.abort();
  await rejected;
  expect(state.workers[0]!.terminate).toHaveBeenCalledOnce();
});
it('terminates PDF parsing at its hard deadline', async () => {
  const input = await source();
  vi.useFakeTimers();
  const pending = documentMessage(input, DocumentImportSettings.parse({}), new AbortController().signal);
  const rejected = expect(pending).rejects.toMatchObject({ messageKey: 'import.document.invalid' });
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;
  expect(state.workers[0]!.terminate).toHaveBeenCalledOnce();
});
