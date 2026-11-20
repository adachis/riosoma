import type { ExtractedSource } from '@riosoma/ingest';
import { expect, it } from 'vitest';
import { runReader, type ReaderMeasurement } from './index.js';

it('pages a 200,000-row, 20-column workbook within its time and memory budgets', async () => {
  let peakProcessBytes = process.memoryUsage().rss;
  const workbook: ExtractedSource = {
    kind: 'workbook',
    name: 'large.xlsx',
    warnings: [],
    sheets: [
      {
        name: 'Data',
        hidden: false,
        rows: Array.from({ length: 200_000 }, (_, row) =>
          Array.from({ length: 20 }, (_, column) => ({ v: row * 20 + column, t: 'number' as const })),
        ),
      },
    ],
  };
  const sample = () => {
    peakProcessBytes = Math.max(peakProcessBytes, process.memoryUsage().rss);
  };
  sample();
  const timer = setInterval(sample, 5);
  let measurement: ReaderMeasurement | undefined;
  const started = performance.now();
  try {
    const result = await runReader(
      workbook,
      `
const sheet = (await source.sheets())[0]
for (let start = 0; start < sheet.rowCount; start += 1000) {
  const cells = await source.rows(sheet.name, start, 1000)
  await emit(cells.map((row, index) => ({
    values: Object.fromEntries(row.map((cell, column) => ['field' + column, cell.v])),
    at: { sheet: sheet.name, row: start + index + 1 }, raw: {},
  })))
}`,
      {},
      {},
      {
        onMeasurement: (value) => {
          measurement = value;
        },
      },
    );
    sample();
    // RSS includes the host's source and output, the worker, and its WebAssembly memory.
    peakProcessBytes = Math.max(peakProcessBytes, process.resourceUsage().maxRSS * 1024);
    const wallMs = performance.now() - started;
    process.stdout.write(
      JSON.stringify({
        rows: 200_000,
        columns: 20,
        wallMs,
        peakSandboxBytes: measurement?.peakSandboxBytes,
        peakProcessBytes,
      }) + '\n',
    );
    expect(
      result.status,
      JSON.stringify(result.status === 'failed' ? result : { status: result.status }),
    ).toBe('read');
    if (result.status !== 'read') throw new Error(result.messageKey);
    expect(result.rows).toHaveLength(200_000);
    expect(result.rows[0]?.values).toEqual(
      Object.fromEntries(Array.from({ length: 20 }, (_, column) => [`field${column}`, column])),
    );
    expect(result.rows[199_999]?.values).toEqual(
      Object.fromEntries(
        Array.from({ length: 20 }, (_, column) => [`field${column}`, 199_999 * 20 + column]),
      ),
    );
    expect(result.rows[199_999]?.at).toEqual({ sheet: 'Data', row: 200_000 });
    expect(wallMs).toBeLessThan(30_000);
    expect(measurement?.peakSandboxBytes).toBeGreaterThan(0);
    expect(measurement?.peakSandboxBytes).toBeLessThanOrEqual(128 * 1024 * 1024);
    // A runtime without resizable memory reserves the sandbox's whole ceiling up front, so only the
    // ceiling above can be held there.  Where memory grows on demand, paging must stay small.
    const memory = (Reflect.get(globalThis, 'WebAssembly') as { Memory: { prototype: object } }).Memory;
    if ('toResizableBuffer' in memory.prototype)
      expect(measurement?.peakSandboxBytes).toBeLessThan(32 * 1024 * 1024);
    expect(peakProcessBytes).toBeLessThan(800 * 1024 * 1024);
  } finally {
    clearInterval(timer);
  }
}, 70_000);

it('fails at emitted row 200,001 and returns no partial rows, checks, or notes', async () => {
  const result = await runReader(
    { kind: 'workbook', name: 'limit.xlsx', warnings: [] },
    `
await note('ingest.reader.test.note')
await check('ingest.reader.test.total', 1, 1)
for (let start = 0; start < 200000; start += 1000)
  await emit(Array.from({ length: 1000 }, (_, index) => ({ values: { id: start + index }, at: {}, raw: {} })))
try { await emit([{ values: { id: 200000 }, at: {}, raw: {} }]) } catch {}
`,
  );
  expect(result).toMatchObject({ status: 'failed', code: 'row-limit', messageKey: 'ingest.reader.rowLimit' });
  expect(result).not.toHaveProperty('rows');
  expect(result).not.toHaveProperty('checks');
  expect(result).not.toHaveProperty('notes');
});
