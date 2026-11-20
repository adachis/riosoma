import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { extractSource } from './index.js';
import { runLimitedWorker } from './limited-worker.js';

/** Generated worker programs exercise actual termination without adding behavior to production parsers. */
async function fixture(program: string, check: (url: URL) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'extract-worker-'));
  const file = join(directory, 'reader.mjs');
  try {
    await writeFile(file, program);
    await check(pathToFileURL(file));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

it('terminates an actual worker that cannot finish reading its generated file before the deadline', async () => {
  await fixture(
    "import { workerData } from 'node:worker_threads'; while (workerData.bytes.length) {}",
    async (url) => {
      const start = Date.now();
      const result = await runLimitedWorker(
        url,
        { bytes: Buffer.from('Generated slow file') },
        { milliseconds: 100 },
      );
      expect(result).toMatchObject({
        status: 'failed',
        code: 'timeout',
        messageKey: 'ingest.extract.timeout',
      });
      expect(Date.now() - start).toBeLessThan(3000);
    },
  );
});

it('returns a typed failure when an actual worker exhausts its heap reading generated records', async () => {
  await fixture(
    "import { workerData } from 'node:worker_threads'; const records = []; while (true) records.push(Array.from(workerData.bytes, (value, index) => ({ value, index, text: String(value) })));",
    async (url) => {
      const result = await runLimitedWorker(url, { bytes: Buffer.alloc(20000, 65) }, { memoryMb: 16 });
      expect(result).toMatchObject({
        status: 'failed',
        code: 'memory-limit',
        messageKey: 'ingest.extract.memoryLimit',
      });
    },
  );
});

it.each(['throw new Error("Fixture failure")', 'process.exit(0)'])(
  'returns a typed failure when a worker dies',
  async (program) => {
    await fixture(program, async (url) => {
      expect(await runLimitedWorker(url, {})).toMatchObject({ status: 'failed', code: 'worker-died' });
    });
  },
);

it.each(['Buffer.alloc(128 * 1024 * 1024)', 'new ArrayBuffer(128 * 1024 * 1024)'])(
  'budgets external memory from %s before accepting a result',
  async (allocation) => {
    await fixture(
      `import { parentPort } from 'node:worker_threads'; const bytes = ${allocation}; parentPort.postMessage({ status: 'empty', sniffedType: 'text/plain', messageKey: 'ingest.extract.empty', length: bytes.byteLength });`,
      async (url) => {
        expect(await runLimitedWorker(url, {}, { memoryMb: 16 })).toMatchObject({
          status: 'failed',
          code: 'memory-limit',
        });
      },
    );
  },
);

it('budgets the output copy together with buffers that the worker retains', async () => {
  await fixture(
    "import { parentPort } from 'node:worker_threads'; const bytes = Buffer.alloc(10 * 1024 * 1024); parentPort.postMessage({ status: 'extracted', sniffedType: 'application/zip', source: { kind: 'archive', name: '', warnings: [], parts: [{ name: '', bytes }] } });",
    async (url) => {
      expect(await runLimitedWorker(url, {}, { memoryMb: 24 })).toMatchObject({
        status: 'failed',
        code: 'memory-limit',
      });
    },
  );
});

it('budgets external buffers even while the worker blocks its event loop', async () => {
  await fixture('const bytes = Buffer.alloc(128 * 1024 * 1024); while (bytes.byteLength) {}', async (url) => {
    expect(await runLimitedWorker(url, {}, { memoryMb: 16, milliseconds: 3000 })).toMatchObject({
      status: 'failed',
      code: 'memory-limit',
    });
  });
});

it('budgets native image allocations alongside the heap and external buffers', async () => {
  // Progressive PNG encoding materializes the 256 MiB pixel image in native memory.
  // Ordinary PNG encoding streams through small regions, especially with glibc's
  // single-thread default; use one thread everywhere so CPU count cannot decide the result.
  await fixture(
    `import { parentPort } from 'node:worker_threads'; const { default: sharp } = await import(${JSON.stringify(import.meta.resolve('sharp'))}); sharp.concurrency(1); await sharp({ create: { width: 8192, height: 8192, channels: 4, background: '#abcdef' } }).blur(10).png({ progressive: true }).toBuffer(); parentPort.postMessage({ status: 'empty', sniffedType: 'text/plain', messageKey: 'ingest.extract.empty' });`,
    async (url) => {
      expect(await runLimitedWorker(url, {}, { memoryMb: 48 })).toMatchObject({
        status: 'failed',
        code: 'memory-limit',
      });
    },
  );
});

it('keeps a small worker within its budget while another reader exceeds its own budget', async () => {
  await fixture(
    "import { parentPort } from 'node:worker_threads'; parentPort.postMessage({ status: 'empty', sniffedType: 'text/plain', messageKey: 'ingest.extract.empty' });",
    async (small) => {
      await fixture(
        'const bytes = Buffer.alloc(128 * 1024 * 1024); while (bytes.byteLength) {}',
        async (large) => {
          const [smallResult, largeResult] = await Promise.all([
            runLimitedWorker(small, {}, { memoryMb: 16 }),
            runLimitedWorker(large, {}, { memoryMb: 16, milliseconds: 3000 }),
          ]);
          expect(smallResult, JSON.stringify(smallResult)).toMatchObject({ status: 'empty' });
          expect(largeResult).toMatchObject({ status: 'failed', code: 'memory-limit' });
        },
      );
    },
  );
});

it('applies the time limit to recognition and extraction through the public API', async () => {
  expect(await extractSource('slow.txt', Buffer.alloc(1000000, 65), { milliseconds: 1 })).toMatchObject({
    status: 'failed',
    code: 'timeout',
  });
});

it('refuses limits that would remove the worker bounds', async () => {
  expect(await extractSource('', Buffer.from('Text'), { milliseconds: Infinity })).toMatchObject({
    status: 'failed',
    code: 'invalid',
  });
  expect(await extractSource('', Buffer.from('Text'), { memoryMb: 1024 })).toMatchObject({
    status: 'failed',
    code: 'invalid',
  });
});

it('starts the reader without variables from the server environment', async () => {
  const key = 'EXTRACTION_TEST_SERVER_SECRET';
  const previous = process.env[key];
  process.env[key] = 'Fixture secret';
  try {
    await fixture(
      "import { parentPort, workerData } from 'node:worker_threads'; parentPort.postMessage({ status: 'empty', sniffedType: 'text/plain', messageKey: 'ingest.extract.empty', defined: process.env[workerData.key] !== undefined, keys: Object.keys(process.env) });",
      async (url) => {
        const result = await runLimitedWorker(url, { key });
        expect(result).toMatchObject({
          status: 'empty',
          defined: false,
        });
        // macOS may insert its text-encoding variable when it starts a process.
        const keys = (result as typeof result & { keys: string[] }).keys;
        expect(keys.filter((name) => name !== '__CF_USER_TEXT_ENCODING')).toEqual([]);
      },
    );
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});
