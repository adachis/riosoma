import { beforeAll, describe, expect, it, vi } from 'vitest';
import { DEBUG_SYNC, newQuickJSWASMModule, TestQuickJSWASMModule } from 'quickjs-emscripten';
import {
  createScriptModule,
  panelTable,
  runScript,
  ScriptClock,
  ScriptError,
  type PanelOutput,
  type ScriptHost,
  type ScriptLog,
  type ScriptSurface,
} from './script.js';
import { scriptLimits } from './script-limits.js';

const host: ScriptHost = { call: async () => null };

async function run(
  source: string,
  input: Record<string, unknown> = {},
  timeoutMs = 1000,
  boundedMemory = false,
  extra: {
    surface?: ScriptSurface;
    host?: ScriptHost;
    clock?: ScriptClock;
    signal?: AbortSignal;
    outputs?: PanelOutput[];
  } = {},
) {
  const module = new TestQuickJSWASMModule(
    boundedMemory ? await createScriptModule(16 * 1024 * 1024) : await newQuickJSWASMModule(DEBUG_SYNC),
  );
  const logs: ScriptLog[] = [];
  try {
    const value = await runScript(source, input, extra.host ?? host, logs, {
      module,
      limits: { ...scriptLimits(), timeoutMs, memoryBytes: 16 * 1024 * 1024 },
      surface: extra.surface,
      clock: extra.clock,
      signal: extra.signal,
      onOutput: (output) => extra.outputs?.push(output),
    });
    return { value, logs };
  } finally {
    expect([...module.contexts].every((context) => !context.alive)).toBe(true);
    module.assertNoMemoryAllocated();
    if (boundedMemory) expect(module.getWasmMemory().buffer.byteLength).toBeLessThanOrEqual(16 * 1024 * 1024);
  }
}

beforeAll(async () => {
  // First-use compilation belongs to setup, before the tests exercise their execution budgets.
  await run(
    'await console.info(input.count)\nawait output({ count: input.count + 1 })',
    { count: 0 },
    10_000,
  );
});

describe('script isolation', () => {
  it('starts the execution budget after trusted bridge setup', async () => {
    const module = new TestQuickJSWASMModule(await newQuickJSWASMModule(DEBUG_SYNC));
    const clock = new ScriptClock(30);
    let now = 0;
    const timer = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const create = module.newContext.bind(module);
    const context = vi.spyOn(module, 'newContext');
    context.mockImplementation((...args) => {
      const vm = create(...args);
      const evaluate = vm.evalCode.bind(vm);
      vm.evalCode = (...input) => {
        if (input[1] === 'script.js') now += 5;
        const result = evaluate(...input);
        if (input[1] === 'bridge.js') now += 1_000;
        return result;
      };
      return vm;
    });
    try {
      await expect(runScript('await output(7)', {}, host, [], { module, clock })).resolves.toBe(7);
      expect(clock.used()).toBe(5);
    } finally {
      context.mockRestore();
      timer.mockRestore();
      module.assertNoMemoryAllocated();
    }
  });

  it('passes JSON and captures logs without leaving live handles', async () => {
    expect(
      await run('await console.info(input.count)\nawait output({ count: input.count + 1 })', { count: 2 }),
    ).toEqual({ value: { count: 3 }, logs: [{ level: 'info', text: '2' }] });
  });

  it('cannot reach host globals or climb function constructors into the host', async () => {
    expect(
      (
        await run(`await output([
      typeof globalThis.process, typeof globalThis.require, typeof globalThis.Buffer,
      typeof globalThis.setTimeout, typeof Function('return this')().process,
      typeof output.constructor('return this')().require,
      typeof globalThis.__bridge
    ])`)
      ).value,
    ).toEqual(Array(7).fill('undefined'));
  });

  it('freezes input and bridge objects without polluting the host', async () => {
    const input = { nested: { count: 1 } };
    expect(
      (
        await run(
          `'use strict'
      let refused = 0
      try { input.nested.count = 2 } catch { refused++ }
      try { Object.setPrototypeOf(input, {}) } catch { refused++ }
      try { records.create = () => null } catch { refused++ }
      try { Object.prototype.polluted = true } catch { refused++ }
      try { Object.setPrototypeOf(records.create, {}) } catch { refused++ }
      await output(refused)`,
          input,
        )
      ).value,
    ).toBe(5);
    expect(input).toEqual({ nested: { count: 1 } });
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
    expect((await run('await output(({}).polluted ?? null)')).value).toBeNull();
  });

  it('interrupts infinite loops and pending waits at the deadline', async () => {
    await expect(run('while (true) {}', {}, 30)).rejects.toMatchObject({
      messageKey: 'automations.script.timeout',
    });
    await expect(run('await sleep(10000)', {}, 30)).rejects.toMatchObject({
      messageKey: 'automations.script.timeout',
    });
    await expect(run('await new Promise(() => {})', {}, 30)).rejects.toMatchObject({
      messageKey: 'automations.script.timeout',
    });
  });

  it('stops unbounded memory allocation', async () => {
    await expect(
      run('const a = []\nwhile (true) a.push(new ArrayBuffer(1024 * 1024))', {}, 1000, true),
    ).rejects.toMatchObject({ messageKey: 'automations.script.memory' });
  });

  it('rejects huge output and huge logs', async () => {
    await expect(run('await output("x".repeat(300000))')).rejects.toMatchObject({
      messageKey: 'automations.script.outputLimit',
    });
    await expect(run('await console.log("x".repeat(100000))')).rejects.toMatchObject({
      messageKey: 'automations.script.logLimit',
    });
  });

  it('blocks module imports and bounds error getters', async () => {
    await expect(run('await import("node:fs")')).rejects.toMatchObject({
      messageKey: 'automations.script.thrown',
    });
    await expect(run('throw { get message() { while (true) {} } }', {}, 30)).rejects.toMatchObject({
      messageKey: 'automations.script.timeout',
    });
    await expect(run('throw null')).rejects.toMatchObject({ messageKey: 'automations.script.thrown' });
  });

  it('retains output when a later statement fails', async () => {
    await expect(run('await output({ count: 2 })\nthrow new Error("failed")')).rejects.toMatchObject({
      messageKey: 'automations.script.thrown',
      output: { count: 2 },
    });
  });

  it('reports syntax and thrown errors with source positions', async () => {
    await expect(run('\nconst =')).rejects.toMatchObject({
      messageKey: 'automations.script.syntax',
      line: 2,
      column: 7,
    });
    await expect(run('\nthrow new Error("broken")')).rejects.toMatchObject({
      messageKey: 'automations.script.thrown',
      line: 2,
      column: 16,
      detail: 'broken',
    });
  });
});

/** The script panel's surface, through the same sandbox and the same checks */
const panel = (source: string, extra: Parameters<typeof run>[4] = {}, timeoutMs = 1000) =>
  run(source, {}, timeoutMs, false, { surface: 'panel', ...extra });

describe('the script panel sandbox', () => {
  it('cannot reach host globals or climb function constructors into the host', async () => {
    const outputs: PanelOutput[] = [];
    await panel(
      `await output.text(JSON.stringify([
      typeof globalThis.process, typeof globalThis.require, typeof globalThis.Buffer,
      typeof globalThis.setTimeout, typeof Function('return this')().process,
      typeof output.text.constructor('return this')().require,
      typeof input.textAsync.constructor('return this')().process,
      typeof globalThis.__bridge, typeof globalThis.__input
    ]))`,
      { outputs },
    );
    expect(JSON.parse((outputs[0] as { text: string }).text)).toEqual(Array(9).fill('undefined'));
  });

  it('freezes its input, output, and records functions without polluting the host', async () => {
    const outputs: PanelOutput[] = [];
    await panel(
      `'use strict'
      let refused = 0
      try { input.textAsync = () => 'forged' } catch { refused++ }
      try { output.text = () => null } catch { refused++ }
      try { records.delete = () => null } catch { refused++ }
      try { Object.setPrototypeOf(input, {}) } catch { refused++ }
      try { Object.setPrototypeOf(output.table, {}) } catch { refused++ }
      try { Object.prototype.polluted = true } catch { refused++ }
      try { globalThis.input = {} } catch { refused++ }
      await output.text(String(refused))`,
      { outputs },
    );
    expect(outputs).toEqual([{ kind: 'text', text: '7' }]);
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });

  it('offers records.delete and the prompts only on the panel', async () => {
    const outputs: PanelOutput[] = [];
    await panel(
      "await output.text([typeof records.delete, typeof input.textAsync, typeof input.buttonsAsync, typeof input.tableAsync, typeof input.recordAsync].join(' '))",
      { outputs },
    );
    expect(outputs).toEqual([{ kind: 'text', text: 'function function function function function' }]);
    expect((await run('await output([typeof records.delete, typeof input.textAsync])')).value).toEqual([
      'undefined',
      'undefined',
    ]);
  });

  it('shows text, Markdown, and tables in order and bounds them by the output limit', async () => {
    const outputs: PanelOutput[] = [];
    await panel(
      `output.text('first')
      output.markdown({ not: 'text' })
      output.table([{ Name: 'Ada', Age: 36 }, { Name: 'Grace', Team: null }])
      output.table([[1, 'two'], [3]])
      await output.table(['plain', 2])`,
      { outputs },
    );
    expect(outputs).toEqual([
      { kind: 'text', text: 'first' },
      { kind: 'markdown', text: '{"not":"text"}' },
      {
        kind: 'table',
        columns: ['Name', 'Age', 'Team'],
        rows: [
          ['Ada', '36', ''],
          ['Grace', '', ''],
        ],
      },
      {
        kind: 'table',
        columns: ['0', '1'],
        rows: [
          ['1', 'two'],
          ['3', ''],
        ],
      },
      { kind: 'table', columns: [''], rows: [['plain'], ['2']] },
    ]);
    await expect(
      panel('for (let i = 0; i < 5; i++) await output.text("x".repeat(60000))'),
    ).rejects.toMatchObject({
      messageKey: 'automations.script.outputLimit',
    });
    await expect(panel('await output.table("not rows")')).rejects.toMatchObject({
      messageKey: 'automations.script.outputLimit',
    });
    expect(() =>
      panelTable([Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`c${i}`, i]))]),
    ).toThrow(ScriptError);
  });

  it('counts only the script’s own time, so waiting for the person never runs it out', async () => {
    // Each wait alone is longer than the whole budget, which the script's own work stays well under
    // even on a busy machine.
    const clock = new ScriptClock(1_000);
    const waiting: ScriptHost = {
      call: async () => {
        clock.pause();
        try {
          await new Promise((resolve) => setTimeout(resolve, 1_200));
          return 'answer';
        } finally {
          clock.resume();
        }
      },
    };
    const outputs: PanelOutput[] = [];
    await panel(
      'const a = await input.textAsync("First")\nconst b = await input.textAsync("Second")\nawait output.text(a + b)',
      {
        host: waiting,
        clock,
        outputs,
      },
    );
    expect(outputs).toEqual([{ kind: 'text', text: 'answeranswer' }]);
    expect(clock.used()).toBeLessThan(1_000);
    // The script's own time still runs out.
    const busy = new ScriptClock(40);
    await expect(
      panel('await input.textAsync("Wait")\nwhile (true) {}', { host: waiting, clock: busy }),
    ).rejects.toMatchObject({ messageKey: 'automations.script.timeout' });
  });

  // A loop that never yields holds its thread until the time limit, so the panel runs scripts on a
  // worker thread it can end at once.  In the sandbox itself, stopping ends whatever it waits on.
  it('stops a pending wait and a waiting prompt with the reason it was given', async () => {
    for (const source of ['await new Promise(() => {})', 'await input.textAsync("Never answered")']) {
      const controller = new AbortController();
      const clock = new ScriptClock(60_000);
      const forever: ScriptHost = {
        call: () => {
          clock.pause();
          return new Promise(() => {});
        },
      };
      setTimeout(() => controller.abort(new ScriptError('scripts.run.canceled')), 50);
      await expect(
        panel(source, { host: forever, clock, signal: controller.signal }, 60_000),
      ).rejects.toMatchObject({ messageKey: 'scripts.run.canceled' });
    }
  });

  it('refuses host methods its surface does not offer', async () => {
    const called: string[] = [];
    const recording: ScriptHost = {
      call: async (method) => {
        called.push(method);
        return null;
      },
    };
    await expect(
      run('await records.find("tbl00000000000000")\nawait output(1)', {}, 1000, false, { host: recording }),
    ).resolves.toMatchObject({ value: 1 });
    expect(called).toEqual(['records.find']);
  });
});
