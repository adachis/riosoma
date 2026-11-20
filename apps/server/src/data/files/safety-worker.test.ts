import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { AppError, FileSafetySettings } from '@riosoma/contracts';
import type * as clamd from './clamd.js';
import { builtInFileChecks, checkFileSafety, type FileSafetyContext } from './safety.js';

const state = vi.hoisted(() => ({
  workers: [] as Array<{
    emit: (event: string, ...args: unknown[]) => boolean;
    terminate: ReturnType<typeof vi.fn>;
  }>,
  options: [] as unknown[],
  urls: [] as URL[],
  scan: vi.fn(),
  approved: vi.fn(),
  scannerSettings: vi.fn(),
  fileSafetySettings: vi.fn(),
}));
vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    terminate = vi.fn(async () => 0);
    constructor(url: URL, options: unknown) {
      super();
      state.workers.push(this);
      state.urls.push(url);
      state.options.push(options);
    }
  },
}));
vi.mock('./settings.js', () => ({
  requireApprovedScanner: state.approved,
  scannerSettings: state.scannerSettings,
  fileSafetySettings: state.fileSafetySettings,
}));
vi.mock('./clamd.js', async (original) => ({
  ...(await original<typeof clamd>()),
  clamAvScanner: () => ({ scan: state.scan }),
}));
beforeEach(() => {
  vi.resetAllMocks();
  state.workers = [];
  state.urls = [];
  state.options = [];
  state.scannerSettings.mockResolvedValue({ enabled: true, address: 'unix:///scanner.sock' });
  state.fileSafetySettings.mockResolvedValue(FileSafetySettings.parse({}));
  state.scan.mockResolvedValue({ state: 'clean' });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function source() {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  return Buffer.from(await pdf.save());
}

it('inspects PDF content off the main thread with a bounded heap and frees the worker', async () => {
  const bytes = await source();
  const load = vi.spyOn(PDFDocument, 'load');
  const pending = builtInFileChecks({ bytes });
  expect(state.workers).toHaveLength(1);
  expect(state.options[0]).toMatchObject({
    resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
  });
  expect(load).not.toHaveBeenCalled();
  state.workers[0]!.emit('message', { encrypted: false, activeContent: true });
  expect(await pending).toMatchObject({ state: 'noted', notes: ['files.checks.pdfActiveContent'] });
  expect(state.workers[0]!.terminate).toHaveBeenCalledOnce();
});

it.each(['error', 'exit'] as const)(
  'holds PDF content after a worker %s and frees resources',
  async (event) => {
    const pending = builtInFileChecks({ bytes: await source() });
    expect(state.workers).toHaveLength(1);
    state.workers[0]!.emit(event, new Error('Fixture worker failure'));
    expect(await pending).toMatchObject({ state: 'held', reason: 'files.checks.unreadable' });
    expect(state.workers[0]!.terminate).toHaveBeenCalledOnce();
  },
);

it('holds PDF inspection at its deadline and terminates the worker', async () => {
  const bytes = await source();
  vi.useFakeTimers();
  const pending = builtInFileChecks({ bytes });
  expect(state.workers).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(5000);
  expect(await pending).toMatchObject({ state: 'held', reason: 'files.checks.inspectionLimit' });
  expect(state.workers[0]!.terminate).toHaveBeenCalledOnce();
});

it.each(['infected', 'unavailable', 'unapproved'] as const)(
  'stops before parsing PDF content after a scanner refusal: %s',
  async (refusal) => {
    if (refusal === 'infected')
      state.scan.mockResolvedValue({ state: 'infected', signature: 'Synthetic-Test-Signature' });
    else if (refusal === 'unavailable') state.scan.mockRejectedValue(new Error('Fixture scanner failure'));
    else
      state.approved.mockImplementation(() => {
        throw new AppError('forbidden', 'files.scanner.addressNotApproved');
      });
    const load = vi.spyOn(PDFDocument, 'load');
    const result = await checkFileSafety({} as FileSafetyContext, { bytes: await source() });
    expect(result).toMatchObject({
      state: 'held',
      reason:
        refusal === 'infected'
          ? 'files.checks.infected'
          : refusal === 'unapproved'
            ? 'files.scanner.addressNotApproved'
            : 'files.checks.scannerUnavailable',
    });
    expect(load).not.toHaveBeenCalled();
    expect(state.workers).toHaveLength(0);
    expect(state.fileSafetySettings).not.toHaveBeenCalled();
  },
);
