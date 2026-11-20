import { execFileSync } from 'node:child_process';
import { cell, type ExtractedSource } from '@riosoma/ingest';
import { newQuickJSWASMModule, TestQuickJSWASMModule } from 'quickjs-emscripten';
import { expect, it, vi } from 'vitest';
import { ingestScriptLimits } from '../../automations/script-limits.js';
import { runScript } from '../../automations/script.js';
import { runReader } from './index.js';
import { ReaderBridge } from './bridge.js';
import { TOOLKIT_SCRIPT, TOOLKIT_VERSION } from './toolkit-bundle.js';

const source: ExtractedSource = {
  kind: 'workbook',
  name: 'rows.xlsx',
  warnings: [],
  sheets: [
    {
      name: 'Data',
      hidden: false,
      rows: [[cell('0042'), cell(17)], [cell(true)]],
      merges: [{ top: 1, left: 1, bottom: 2, right: 1 }],
    },
  ],
};
const emitted = `await emit([{ values: { id: '0042' }, at: { sheet: 'Data', row: 1 }, raw: {} }])`;

it('loads the toolkit and reader defaults when selecting the ingest surface directly', async () => {
  const bridge = new ReaderBridge(source, {}, {});
  await runScript(
    `await emit([{ values: { version: ingest.version, now: Date.now() }, at: {}, raw: {} }])`,
    {},
    bridge,
    [],
    { surface: 'ingest' },
  );
  expect(bridge.rows).toEqual([{ values: { version: TOOLKIT_VERSION, now: 0 }, at: {}, raw: {} }]);
});

it('evaluates the portable, frozen toolkit in a bare sandbox and verifies its build asset', async () => {
  execFileSync(process.execPath, ['tools/build-ingest-toolkit.mjs', '--check'], {
    cwd: new URL('../../../../../', import.meta.url),
  });
  const module = new TestQuickJSWASMModule(await newQuickJSWASMModule());
  const vm = module.newContext();
  try {
    const evaluated = vm.evalCode(TOOLKIT_SCRIPT);
    vm.unwrapResult(evaluated).dispose();
    const result = vm.evalCode(`JSON.stringify([
      ingest.number('1,234.50', { decimalMark: '.' }).value,
      ingest.tableByName([[ingest.cell('ID')], [ingest.cell('0042')]], 0).headers,
      ingest.version, Object.isFrozen(ingest), Object.isFrozen(ingest.DATE_FORMATS),
      Object.getPrototypeOf(ingest), typeof ingest.interpretLayout, typeof ingest.generateCorpus
    ])`);
    const value = vm.unwrapResult(result);
    expect(JSON.parse(vm.getString(value))).toEqual([
      '1234.5',
      ['ID'],
      TOOLKIT_VERSION,
      true,
      true,
      null,
      'undefined',
      'undefined',
    ]);
    value.dispose();
  } finally {
    vm.dispose();
    module.assertNoMemoryAllocated();
  }
});

it('pages cells, hides cells from metadata, records checks and notes, and consults lookup tables and facts', async () => {
  const result = await runReader(
    source,
    `
const sheets = await source.sheets()
const cells = await source.rows('Data', 0, 1)
await check('ingest.reader.test.total', 17, cells[0][1].v)
await note('ingest.reader.test.note')
await emit([{ values: {
  id: cells[0][0].v, match: (await lookup('status', ' active ')).value,
  missing: await fact('missing'), answer: await fact('approved'),
  count: sheets[0].rowCount, columns: sheets[0].columnCount,
  hidden: sheets[0].hidden, noCells: !('rows' in sheets[0]), merged: sheets[0].merges.length,
  pages: (await source.pages()).length, noEmail: await source.email(),
}, at: { sheet: 'Data', row: 1 }, raw: { id: '0042' } }])`,
    { status: { Active: 'A' } },
    { approved: true },
  );
  expect(result).toEqual({
    status: 'read',
    toolkitVersion: TOOLKIT_VERSION,
    rows: [
      {
        values: {
          id: '0042',
          match: 'A',
          missing: null,
          answer: true,
          count: 2,
          columns: 2,
          hidden: false,
          noCells: true,
          merged: 1,
          pages: 0,
          noEmail: null,
        },
        at: { sheet: 'Data', row: 1 },
        raw: { id: '0042' },
      },
    ],
    checks: [{ name: 'ingest.reader.test.total', expected: 17, actual: 17 }],
    notes: ['ingest.reader.test.note'],
  });
});

it('uses a fixed clock and randomness in fresh workers with byte-identical rows', async () => {
  const code = `await emit([{ values: { now: Date.now(), date: new Date().toISOString(), called: Date(),
    constructor: new Date.prototype.constructor().getTime(), random: Math.random(),
    explicit: new Date('2026-03-01').toISOString() }, at: {}, raw: {} }])`;
  const first = await runReader(source, code);
  const second = await runReader(source, code);
  expect(first.status).toBe('read');
  expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  expect(first).toMatchObject({
    rows: [{ values: { now: 0, date: '1970-01-01T00:00:00.000Z', random: 0.5, constructor: 0 } }],
  });
});

it('keeps the native clock private when a reader replaces reflection helpers', async () => {
  const result = await runReader(
    source,
    `
Reflect.construct = NativeDate => { globalThis.nativeDate = NativeDate; return new NativeDate() }
await emit([{ values: { now: new Date().getTime(), leaked: typeof nativeDate }, at: {}, raw: {} }])`,
  );
  expect(result).toMatchObject({ status: 'read', rows: [{ values: { now: 0, leaked: 'undefined' } }] });
});

it.each([
  'fetch("https://example.test")',
  'require("node:fs")',
  'await import("node:fs")',
  'process.env',
  'records.find({})',
  'source.constructor.constructor("return process")()',
  'Object.defineProperty(Object.getPrototypeOf(await source.rows("Data", 0, 1)), "secret", { value: "changed" })',
  'Object.getPrototypeOf((await source.rows("Data", 0, 1))[0][0]).secret',
])('refuses an escape through %s and discards prior rows', async (attempt) => {
  const result = await runReader(source, `${emitted}\n${attempt}`);
  expect(result).toMatchObject({ status: 'failed', code: 'script-error' });
  expect(result).not.toHaveProperty('rows');
  expect(({} as Record<string, unknown>).secret).toBeUndefined();
});

it('keeps globals and source mutations confined to one run', async () => {
  expect(await runReader(source, `globalThis.secret = 42; ${emitted}`)).toMatchObject({ status: 'read' });
  const result = await runReader(
    source,
    `await emit([{ values: { secret: typeof secret,
    host: typeof Function('return this')().process, sourcePrototype: Object.getPrototypeOf(source) === null,
    bridge: typeof __bridge }, at: {}, raw: {} }])`,
  );
  expect(result).toMatchObject({
    status: 'read',
    rows: [
      { values: { secret: 'undefined', host: 'undefined', sourcePrototype: true, bridge: 'undefined' } },
    ],
  });
  expect(source.sheets?.[0]?.rows[0]?.[0]?.v).toBe('0042');
});

it('terminates an endless loop off the main thread', async () => {
  let responsive = false;
  const timer = setTimeout(() => {
    responsive = true;
  }, 30);
  const result = await runReader(source, 'while (true) {}', {}, {}, { timeoutMs: 100 });
  clearTimeout(timer);
  expect(result).toMatchObject({ status: 'failed', code: 'timeout' });
  expect(responsive).toBe(true);
});

it('bounds sandbox memory and returns a typed failure', async () => {
  const result = await runReader(
    source,
    `const values = []; while (true) values.push(new Array(100000).fill('x'))`,
  );
  expect(result).toMatchObject({ status: 'failed', code: 'memory' });
  expect(result).not.toHaveProperty('rows');
});

it.each(['exception', 'throw'])(
  'fails with memory when a host response allocation returns %s, even when caught',
  async (failure) => {
    const module = new TestQuickJSWASMModule(await newQuickJSWASMModule());
    const create = module.newContext.bind(module);
    const payload = 'x'.repeat(3_900_000);
    const serialized = JSON.stringify(payload);
    const context = vi.spyOn(module, 'newContext').mockImplementation((...args) => {
      const vm = create(...args);
      const allocate = vm.newString.bind(vm);
      vi.spyOn(vm, 'newString').mockImplementation((value) => {
        if (value !== serialized) return allocate(value);
        if (failure === 'throw') throw new RangeError('allocation failed');
        // Exhaust the runtime budget only at delivery, keeping setup and guest execution healthy.
        vm.runtime.setMemoryLimit(1);
        return allocate(value);
      });
      return vm;
    });
    const bridge = new ReaderBridge(source, {}, { payload });
    try {
      await expect(
        runScript(`${emitted}\ntry { await fact('payload') } catch {}`, {}, bridge, [], {
          module,
          surface: 'ingest',
          limits: { ...ingestScriptLimits(), timeoutMs: 1_000 },
        }),
      ).rejects.toMatchObject({ messageKey: 'automations.script.memory' });
    } finally {
      context.mockRestore();
      module.assertNoMemoryAllocated();
    }
  },
);

it.each(['ascii', 'unicode'])(
  'delivers a large %s fact within the sandbox memory ceiling',
  async (encoding) => {
    const payload = 'x'.repeat(3_900_000) + (encoding === 'unicode' ? '\u0100' : '');
    let peakSandboxBytes = 0;
    const result = await runReader(
      source,
      `const payload = await fact('payload')
await emit([{ values: { length: payload.length, last: payload[payload.length - 1] }, at: {}, raw: {} }])`,
      {},
      { payload },
      {
        onMeasurement: (measurement) => {
          peakSandboxBytes = measurement.peakSandboxBytes;
        },
      },
    );
    expect(result, JSON.stringify(result)).toMatchObject({
      status: 'read',
      rows: [{ values: { length: payload.length, last: payload.at(-1) } }],
    });
    expect(peakSandboxBytes).toBeGreaterThan(0);
    expect(peakSandboxBytes).toBeLessThanOrEqual(ingestScriptLimits().memoryBytes);
  },
);

it('discards partial output when a large fact cannot fit after caught guest heap exhaustion', async () => {
  const code = `const retained = []
try { while (true) retained.push(new Array(100000).fill('x')) } catch {}
${emitted}
await check('ingest.reader.test.total', 1, 1)
await note('ingest.reader.test.note')`;
  const control = await runReader(source, code);
  expect(control, JSON.stringify(control)).toMatchObject({ status: 'read' });
  const result = await runReader(
    source,
    `${code}\ntry { await fact('payload') } catch {}`,
    {},
    { payload: 'x'.repeat(3_900_000) },
  );
  expect(result).toMatchObject({ status: 'failed', code: 'memory', messageKey: 'ingest.reader.memory' });
  expect(result).not.toHaveProperty('rows');
  expect(result).not.toHaveProperty('checks');
  expect(result).not.toHaveProperty('notes');
});

it('preserves null characters, Unicode, and escaped surrogates across the bridge', async () => {
  const payload = ['\u0000', '\u0100', '\u{1f642}', '\ud800', '\udc00', '"\\\n'];
  const result = await runReader(
    source,
    `const payload = await fact('payload')
await emit(payload.map(text => ({ values: { text }, at: {}, raw: {} })))`,
    {},
    { payload },
  );
  expect(result).toMatchObject({
    status: 'read',
    rows: payload.map((text) => ({ values: { text }, at: {}, raw: {} })),
  });
});

it('counts slow host work against the deadline', async () => {
  const result = await runReader(
    source,
    `for (let i = 0; i < 100000; i++) await source.rows('Data', 0, 1)`,
    {},
    {},
    { timeoutMs: 100 },
  );
  expect(result).toMatchObject({ status: 'failed', code: 'timeout' });
});

it.each([
  '{}',
  '{ values: { x: {} }, at: {}, raw: {} }',
  '{ values: { x: [] }, at: {}, raw: {} }',
  '{ values: { x: NaN }, at: {}, raw: {} }',
  '{ values: { x: Infinity }, at: {}, raw: {} }',
  '{ values: { x: undefined }, at: {}, raw: {} }',
  '{ values: { x: 1n }, at: {}, raw: {} }',
  '{ values: { x: () => 1 }, at: {}, raw: {} }',
  '{ values: { x: Symbol() }, at: {}, raw: {} }',
  '{ values: { x: new Date() }, at: {}, raw: {} }',
  '{ values: { x: new Number(1) }, at: {}, raw: {} }',
  '{ values: { x: new Number(NaN) }, at: {}, raw: {} }',
  '{ values: { x: new String("text") }, at: {}, raw: {} }',
  '{ values: { x: new Boolean(true) }, at: {}, raw: {} }',
  '{ values: { x: { toJSON: () => "text" } }, at: {}, raw: {} }',
  '{ values: { toJSON: () => ({ x: "text" }) }, at: {}, raw: {} }',
  '{ values: {}, at: { row: 0 }, raw: {} }',
  '{ values: {}, at: { row: 1.5 }, raw: {} }',
  '{ values: {}, at: { path: "secret" }, raw: {} }',
  '{ values: {}, at: {}, raw: { x: 1 } }',
  '{ values: {}, at: {}, raw: { x: new String("text") } }',
  '{ values: {}, at: { row: new Number(1) }, raw: {} }',
  '{ values: {}, at: {}, raw: {}, extra: 1 }',
])('rejects invalid emitted row %s even when caught by the script', async (row) => {
  const result = await runReader(source, `${emitted}\ntry { await emit([${row}]) } catch {}`);
  expect(result).toMatchObject({ status: 'failed', code: 'invalid-row' });
  expect(result).not.toHaveProperty('rows');
});

it('rejects circular values without crashing the bridge', async () => {
  expect(
    await runReader(
      source,
      `const values = {}; values.x = values; await emit([{ values, at: {}, raw: {} }])`,
    ),
  ).toMatchObject({ status: 'failed', code: 'invalid-row' });
});

it('rejects invalid getter values even when the getter changes its type during serialization', async () => {
  for (const value of ['new Number(NaN)', '() => 1']) {
    expect(
      await runReader(
        source,
        `let calls = 0;
      const values = { get x() { return ++calls === 1 ? ${value} : 'text' } };
      await emit([{ values, at: {}, raw: {} }])`,
      ),
    ).toMatchObject({ status: 'failed', code: 'invalid-row' });
  }
});

it('validates numbers even when the script replaces a guest built-in', async () => {
  expect(
    await runReader(
      source,
      `Number.isFinite = () => true; await emit([{ values: { x: NaN }, at: {}, raw: {} }])`,
    ),
  ).toMatchObject({ status: 'failed', code: 'invalid-row' });
});

it('refuses boxed values when the script replaces guest collection methods', async () => {
  expect(
    await runReader(
      source,
      `Set.prototype.has.call = () => false;
    Set.prototype.add.call = () => {};
    await emit([{ values: { x: new Number(NaN) }, at: {}, raw: {} }])`,
    ),
  ).toMatchObject({ status: 'failed', code: 'invalid-row' });
});

it.each([
  'await source.rows("Data", -1, 1)',
  'await source.rows("Data", 0, 1001)',
  'await source.rows("missing", 0, 1)',
  'await source.rows("Data", "0", 1)',
  'await source.sheets(1)',
  'await source.pages(1)',
  'await source.email(1)',
  'await note(12)',
  'await note(new String("text"))',
  'await check("total", new Number(NaN), 1)',
  'await lookup(new String("status"), "active")',
  'await fact(new String("answer"))',
  'await source.rows("Data", new Number(0), 1)',
  'await note("x".repeat(501))',
  'for (let i = 0; i < 101; i++) await note("ingest.reader.test.note")',
  'await check("total", {}, 1)',
  'await check(1, 1, 1)',
  'await lookup(1, "x")',
  'await fact(1)',
])('rejects invalid bridge arguments in %s', async (code) => {
  expect(await runReader(source, code)).toMatchObject({ status: 'failed', code: 'script-error' });
});

it('validates host results and refuses inherited lookup entries and facts', async () => {
  const bad: ExtractedSource = {
    ...source,
    sheets: [{ name: 'Data', hidden: false, rows: [[{ v: {}, t: 'text' } as never]] }],
  };
  expect(await runReader(bad, `await source.rows('Data', 0, 1)`)).toMatchObject({
    status: 'failed',
    code: 'script-error',
  });
  const boxedType = {
    ...source,
    sheets: [{ name: 'Data', hidden: false, rows: [[{ v: 'text', t: new String('text') }]] }],
  };
  expect(await runReader(boxedType as never, `await source.rows('Data', 0, 1)`)).toMatchObject({
    status: 'failed',
    code: 'script-error',
  });
  expect(await runReader(source, `await fact('bad')`, {}, { bad: new Date() } as never)).toMatchObject({
    status: 'failed',
    code: 'script-error',
  });
  const result = await runReader(
    source,
    `await emit([{ values: {
    fact: await fact('constructor'), lookup: (await lookup('constructor', 'x')).value,
  }, at: {}, raw: {} }])`,
  );
  expect(result).toMatchObject({ status: 'read', rows: [{ values: { fact: null, lookup: null } }] });
});

it('reports the script message and source line', async () => {
  expect(
    await runReader(source, `const id = 1\nthrow new Error('ingest.reader.test.failure')`),
  ).toMatchObject({ status: 'failed', code: 'script-error', detail: 'ingest.reader.test.failure', line: 2 });
});

it('enforces the default timeout and the caller parameter ceiling', async () => {
  expect(ingestScriptLimits()).toMatchObject({ timeoutMs: 60_000, memoryBytes: 128 * 1024 * 1024 });
  expect(await runReader(source, emitted, {}, {}, { timeoutMs: 300_000 })).toMatchObject({ status: 'read' });
  expect(await runReader(source, '', {}, {}, { timeoutMs: 300_001 })).toMatchObject({
    status: 'failed',
    code: 'script-error',
  });
});

it('closes the host after failure and clears every partial artifact', async () => {
  const bridge = new ReaderBridge(source, {}, {});
  await bridge.call('emit', [[{ values: { x: true }, at: {}, raw: {} }]], 1000);
  await bridge.call('check', ['ingest.reader.test.total', 1, 1], 1000);
  await bridge.call('note', ['ingest.reader.test.note'], 1000);
  bridge.close(true);
  expect([bridge.rows, bridge.checks, bridge.notes]).toEqual([[], [], []]);
  await expect(bridge.call('emit', [[]], 1000)).rejects.toMatchObject({
    messageKey: 'automations.script.timeout',
  });
});
