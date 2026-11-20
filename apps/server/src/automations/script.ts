import {
  newQuickJSWASMModule,
  newVariant,
  RELEASE_SYNC,
  type QuickJSWASMModule,
  type QuickJSHandle,
  type QuickJSDeferredPromise,
} from 'quickjs-emscripten';

// The server excludes browser declarations, so describe only the host memory constructor used here
declare const WebAssembly: {
  Memory: new (descriptor: { initial: number; maximum: number }) => ReturnType<
    QuickJSWASMModule['getWasmMemory']
  > & {
    toResizableBuffer?: () => ArrayBuffer;
  };
};

export interface ScriptLog {
  level: 'log' | 'info' | 'warn' | 'error';
  text: string;
}

export class ScriptError extends Error {
  output: unknown = null;
  constructor(
    readonly messageKey: string,
    readonly detail = '',
    readonly line = 1,
    readonly column = 1,
  ) {
    super(messageKey);
  }
}

/** What one script may use.  The defaults are `scriptLimits()` in `script-limits.ts`. */
export interface ScriptLimits {
  memoryBytes: number;
  timeoutMs: number;
  outputBytes: number;
  logBytes: number;
}

export interface ScriptHost {
  call(method: string, args: unknown[], remainingMs: number): Promise<unknown>;
  /** Paging avoids rebuilding cell objects in the worker just to serialize them again. */
  callSerialized?(method: string, args: string, remainingMs: number): Promise<string>;
}

/**
 * Which globals a script gets.  An automation step's script reads `input` as the values mapped to
 * it and sets its result with `output(value)`.  The script panel's asks the person with
 * `input.textAsync` and the like, shows things with `output.text`, `output.markdown`, and
 * `output.table`, and may also `records.delete`.
 */
export type ScriptSurface = 'automation' | 'panel' | 'ingest';

/** Methods the host answers, by surface.  Everything else is the sandbox's own or refused. */
const HOST_METHODS: Record<ScriptSurface, readonly string[]> = {
  ingest: [
    'source.sheets',
    'source.rows',
    'source.pages',
    'source.email',
    'emit',
    'check',
    'note',
    'lookup',
    'fact',
  ],
  automation: ['fetch', 'records.find', 'records.create', 'records.update'],
  panel: [
    'fetch',
    'records.find',
    'records.create',
    'records.update',
    'records.delete',
    'input.buttonRecord',
    'input.text',
    'input.buttons',
    'input.table',
    'input.record',
  ],
};

/** What the panel's script showed, in the order it showed it */
export type PanelOutput =
  | { kind: 'text'; text: string }
  | { kind: 'markdown'; text: string }
  | { kind: 'table'; columns: string[]; rows: string[][] };

const PANEL_TABLE = { columns: 100, rows: 5_000 };
const INGEST_BRIDGE_BYTES = 4 * 1024 * 1024;

/** A cell of `output.table` as text: strings as they are, nothing as empty, and the rest as JSON. */
function cellText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return JSON.stringify(value) ?? '';
}

/**
 * Rows for `output.table`.  Objects make a column of each key, in the order they first appear,
 * arrays a column of each position, and anything else a single column named ''.
 */
export function panelTable(rows: unknown): { columns: string[]; rows: string[][] } {
  if (!Array.isArray(rows) || rows.length > PANEL_TABLE.rows)
    throw new ScriptError('automations.script.outputLimit');
  const objects = rows.every((row) => row !== null && typeof row === 'object' && !Array.isArray(row));
  const arrays = rows.every((row) => Array.isArray(row));
  let columns: string[];
  if (rows.length && objects) {
    const seen = new Set<string>();
    for (const row of rows as Array<Record<string, unknown>>)
      for (const key of Object.keys(row)) seen.add(key);
    columns = [...seen];
  } else if (rows.length && arrays)
    columns = Array.from({ length: Math.max(...(rows as unknown[][]).map((row) => row.length)) }, (_, i) =>
      String(i),
    );
  else columns = [''];
  if (columns.length > PANEL_TABLE.columns) throw new ScriptError('automations.script.outputLimit');
  return {
    columns,
    rows: rows.map((row) =>
      objects && rows.length
        ? columns.map((key) => cellText((row as Record<string, unknown>)[key]))
        : arrays && rows.length
          ? columns.map((_, i) => cellText((row as unknown[])[i]))
          : [cellText(row)],
    ),
  };
}

/**
 * The script's own time.  Time spent waiting for the person, between `pause` and `resume`, doesn't
 * count, so a prompt left open never runs the script out of time.  Nothing counts before `begin`.
 */
export class ScriptClock {
  private started: number | null = null;
  private waited = 0;
  private since: number | null = null;

  constructor(readonly budgetMs: number) {}

  begin(): void {
    this.started ??= performance.now();
  }

  get paused(): boolean {
    return this.since !== null;
  }

  /** Milliseconds of the script's own time so far */
  used(): number {
    if (this.started === null) return 0;
    const now = performance.now();
    return now - this.started - this.waited - (this.since === null ? 0 : now - this.since);
  }

  remaining(): number {
    return Math.max(0, this.budgetMs - this.used());
  }

  pause(): void {
    this.since ??= performance.now();
  }

  resume(): void {
    if (this.since === null) return;
    this.waited += performance.now() - this.since;
    this.since = null;
  }
}

/** A separate WebAssembly ceiling also bounds allocations omitted by the runtime's accounting */
export function createScriptModule(memoryBytes: number, stableViews = false) {
  const pages = Math.floor(memoryBytes / 65536);
  let memory = new WebAssembly.Memory({ initial: Math.min(256, pages), maximum: pages });
  if (stableViews) {
    // Pending jobs keep native pointer views across allocations, so growth must not detach them.
    if (memory.toResizableBuffer) memory.toResizableBuffer();
    else memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
  }
  const variant = newVariant(RELEASE_SYNC, { wasmMemory: memory });
  if (stableViews) {
    const importFFI = variant.importFFI;
    return newQuickJSWASMModule({
      ...variant,
      importFFI: async () => {
        const FFI = await importFFI();
        return class extends FFI {
          constructor(native: ConstructorParameters<typeof FFI>[0]) {
            super(native);
            // Bulk UTF-8 copies keep paging fast with resizable memory views.
            native.lengthBytesUTF8 = (value) => Buffer.byteLength(value, 'utf8');
            native.stringToUTF8 = (value, pointer, size) => {
              if (size === undefined || size <= 0) return;
              const bytes = Buffer.from(native.HEAPU8.buffer, pointer, size);
              const written = bytes.write(value, 0, size - 1, 'utf8');
              bytes[written] = 0;
            };
            native.UTF8ToString = (pointer, maximum) => {
              if (!pointer) return '';
              const available = native.HEAPU8.byteLength - pointer;
              const bytes = Buffer.from(
                native.HEAPU8.buffer,
                pointer,
                Math.min(maximum ?? available, available),
              );
              const end = bytes.indexOf(0);
              return bytes.toString('utf8', 0, end < 0 ? bytes.length : end);
            };
            const allocate = native._malloc.bind(native);
            native._malloc = (bytes) => {
              const pointer = allocate(bytes);
              // The bridge must never copy a response into address zero after native allocation fails.
              if (!pointer && bytes) throw new ScriptError('automations.script.memory');
              return pointer;
            };
          }
        };
      },
    });
  }
  return newQuickJSWASMModule(variant);
}

/** Only serialized values cross the boundary, and guest functions never become host functions */
export async function runScript(
  source: string,
  input: Record<string, unknown>,
  host: ScriptHost,
  logs: ScriptLog[],
  options: {
    limits?: ScriptLimits;
    module?: Pick<QuickJSWASMModule, 'newContext'> & Partial<Pick<QuickJSWASMModule, 'getWasmMemory'>>;
    surface?: ScriptSurface;
    /** Counts the script's own time against `limits.timeoutMs` when given, so the host can pause it */
    clock?: ScriptClock;
    /** Stops the script.  The reason, when it's a `ScriptError`, is what the run fails with. */
    signal?: AbortSignal;
    /** Each console message as it's captured */
    onLog?: (log: ScriptLog) => void;
    /** Each thing the panel's script shows, as it shows it */
    onOutput?: (output: PanelOutput) => void;
    /** Trusted, prebuilt toolkit code, evaluated before the reader. */
    prelude?: string;
    onMemory?: (bytes: number) => void;
  } = {},
): Promise<unknown> {
  // The defaults come with the configuration's code, which a script's worker thread, started for
  // every script and always told its limits, has no need to load.
  const surface = options.surface ?? 'automation';
  const defaults = options.limits ? undefined : await import('./script-limits.js');
  const limits =
    options.limits ?? (surface === 'ingest' ? defaults!.ingestScriptLimits() : defaults!.scriptLimits());
  const panel = surface === 'panel';
  const ingest = surface === 'ingest';
  const serializedInput = JSON.stringify(input);
  if (Buffer.byteLength(source) > 65536 || Buffer.byteLength(serializedInput) > 1024 * 1024)
    throw new ScriptError('automations.script.bridgeLimit');
  const module = options.module ?? (await createScriptModule(limits.memoryBytes, ingest));
  const vm = module.newContext();
  const runtime = vm.runtime;
  const measure = () => options.onMemory?.(module.getWasmMemory?.().buffer.byteLength ?? 0);
  // Reader responses need a UTF-8 staging buffer and up to twice that space for the guest string.
  // Keep both allocations and runtime overhead inside the separate WebAssembly ceiling.
  const reservedBytes = 2 * 1024 * 1024 + (ingest ? 3 * INGEST_BRIDGE_BYTES : 0);
  runtime.setMemoryLimit(Math.max(1024 * 1024, limits.memoryBytes - reservedBytes));
  runtime.setMaxStackSize(512 * 1024);
  const clock = options.clock ?? new ScriptClock(limits.timeoutMs);
  let fatal: ScriptError | undefined;
  const remaining = () => clock.remaining();
  const timeout = () => (fatal ??= new ScriptError('automations.script.timeout'));
  // Stopping wakes whatever the script is waiting on, and interrupts whatever it's running.
  let wake = () => {};
  const stopped = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const stop = () => {
    const reason: unknown = options.signal?.reason;
    fatal ??= reason instanceof ScriptError ? reason : new ScriptError('automations.script.thrown');
    wake();
  };
  if (options.signal?.aborted) stop();
  else options.signal?.addEventListener('abort', stop, { once: true });
  let interrupted = false;
  runtime.setInterruptHandler(() => {
    interrupted = Boolean(fatal) || remaining() <= 0;
    return interrupted;
  });
  const pending = new Set<QuickJSDeferredPromise>();
  let chain = Promise.resolve();
  let calls = 0;
  let logSize = 0;
  let outputSize = 0;
  let bridgeBytes = 0;
  let output: unknown = null;
  let active = true;
  let main: QuickJSHandle | undefined;
  let bridge: QuickJSHandle | undefined;
  const failure = (handle: QuickJSHandle): ScriptError => {
    if (fatal) return fatal;
    const read = (name: string) => {
      if (vm.typeof(handle) !== 'object') return '';
      const property = vm.getProp(handle, name);
      try {
        return vm.typeof(property) === 'string' ? vm.getString(property).slice(0, 2000) : '';
      } finally {
        property.dispose();
      }
    };
    const message = vm.typeof(handle) === 'string' ? vm.getString(handle).slice(0, 2000) : read('message');
    const stack = read('stack');
    const name = read('name');
    const position = /script\.js:(\d+)(?::(\d+))?/.exec(stack);
    const key = interrupted
      ? 'automations.script.timeout'
      : /out of memory|allocation failed/i.test(message)
        ? 'automations.script.memory'
        : name === 'SyntaxError'
          ? 'automations.script.syntax'
          : 'automations.script.thrown';
    return new ScriptError(
      key,
      message,
      Math.max(1, Number(position?.[1] ?? 2) - 1),
      Number(position?.[2] ?? 1),
    );
  };
  const wait = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // While the host waits for the person, the clock stands still, and only the answer, or
      // stopping, ends the wait.
      await Promise.race([
        chain,
        stopped,
        ...(clock.paused
          ? []
          : [
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, remaining());
              }),
            ]),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const dispose = () => {
    try {
      for (const deferred of pending) deferred.dispose();
      main?.dispose();
      bridge?.dispose();
      vm.dispose();
    } catch (error) {
      // Cleanup of a depleted reader must preserve the allocation failure that ended the run.
      if (!ingest || fatal?.messageKey !== 'automations.script.memory') throw error;
    }
  };
  try {
    bridge = vm.newFunction('__bridge', (methodHandle, jsonHandle) => {
      const method = vm.getString(methodHandle);
      const json = vm.getString(jsonHandle);
      bridgeBytes += Buffer.byteLength(json);
      if (
        ingest
          ? ++calls > 1_000_000 || Buffer.byteLength(json) > INGEST_BRIDGE_BYTES
          : ++calls > 1000 ||
            bridgeBytes > 1024 * 1024 ||
            json.length > Math.max(limits.outputBytes, limits.logBytes)
      ) {
        fatal = new ScriptError(
          method === 'output' || method.startsWith('output.')
            ? 'automations.script.outputLimit'
            : method === 'console'
              ? 'automations.script.logLimit'
              : 'automations.script.bridgeLimit',
        );
        return vm.undefined;
      }
      const deferred = vm.newPromise();
      pending.add(deferred);
      chain = chain.then(async () => {
        if (!active || fatal) return;
        if (!remaining()) {
          timeout();
          return;
        }
        try {
          if (ingest) {
            if (!HOST_METHODS.ingest.includes(method))
              throw new ScriptError(
                method === 'invalid.emit' ? 'ingest.reader.invalidRow' : 'ingest.reader.invalidArgument',
              );
            const serialized = host.callSerialized
              ? await host.callSerialized(method, json, remaining())
              : JSON.stringify((await host.call(method, JSON.parse(json) as unknown[], remaining())) ?? null);
            if (!active || !remaining()) {
              timeout();
              return;
            }
            const responseBytes = Buffer.byteLength(serialized);
            if (responseBytes > INGEST_BRIDGE_BYTES) throw new ScriptError('ingest.reader.invalidArgument');
            let value: QuickJSHandle | undefined;
            try {
              value = vm.newString(serialized);
              // Allocation can return an exception handle instead of throwing a host error.
              if (vm.typeof(value) !== 'string') throw new ScriptError('automations.script.memory');
              deferred.resolve(value);
              measure();
            } catch {
              // A depleted context cannot safely allocate a rejection or run guest error handlers.
              fatal = new ScriptError('automations.script.memory');
            } finally {
              value?.dispose();
            }
            return;
          }
          const args = JSON.parse(json) as unknown[];
          let result: unknown = null;
          if (method === 'output' && !panel) {
            const value = args[0] ?? null;
            if (Buffer.byteLength(JSON.stringify(value)) > limits.outputBytes)
              throw new ScriptError('automations.script.outputLimit');
            output = value;
          } else if (
            panel &&
            (method === 'output.text' || method === 'output.markdown' || method === 'output.table')
          ) {
            // Everything shown counts toward one output limit, as an automation's one result does.
            const shown: PanelOutput =
              method === 'output.table'
                ? { kind: 'table', ...panelTable(args[0]) }
                : {
                    kind: method === 'output.text' ? 'text' : 'markdown',
                    text: typeof args[0] === 'string' ? args[0] : '',
                  };
            outputSize += Buffer.byteLength(JSON.stringify(shown));
            if (outputSize > limits.outputBytes) throw new ScriptError('automations.script.outputLimit');
            options.onOutput?.(shown);
          } else if (method === 'console') {
            const [level, text] = args as [ScriptLog['level'], string];
            if (!['log', 'info', 'warn', 'error'].includes(level) || typeof text !== 'string')
              throw new ScriptError('automations.script.bridgeLimit');
            logSize += Buffer.byteLength(text) + 32;
            if (logSize > limits.logBytes) throw new ScriptError('automations.script.logLimit');
            logs.push({ level, text });
            options.onLog?.({ level, text });
          } else if (method === 'sleep') {
            const ms = args[0];
            if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0)
              throw new ScriptError('automations.script.thrown');
            await new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, remaining())));
          } else {
            if (!HOST_METHODS[surface].includes(method))
              throw new ScriptError('automations.script.bridgeLimit');
            result = await host.call(method, args, remaining());
          }
          if (!active || !remaining()) {
            timeout();
            return;
          }
          const serialized = JSON.stringify(result ?? null);
          if (Buffer.byteLength(serialized) > 1024 * 1024)
            throw new ScriptError('automations.script.bridgeLimit');
          const value = vm.newString(serialized);
          try {
            deferred.resolve(value);
          } finally {
            value.dispose();
          }
        } catch (error) {
          if (error instanceof ScriptError) fatal = error;
          if (!active) return;
          const key =
            error && typeof error === 'object' && 'messageKey' in error
              ? String(error.messageKey)
              : 'automations.script.thrown';
          if (key === 'automations.runAs.denied') fatal = new ScriptError(key);
          const value = vm.newError(key);
          try {
            deferred.reject(value);
          } finally {
            value.dispose();
          }
        } finally {
          if (active) {
            pending.delete(deferred);
            deferred.dispose();
          }
        }
      });
      return deferred.handle;
    });
    vm.setProp(vm.global, '__bridge', bridge);
    const inputHandle = vm.newString(serializedInput);
    vm.setProp(vm.global, '__input', inputHandle);
    inputHandle.dispose();
    const setup = vm.evalCode(
      `(() => {
      const send = globalThis.__bridge
      const parse = JSON.parse
      const stringify = JSON.stringify
      const finite = Number.isFinite
      const ParentSet = Set
      const setAdd = Function.prototype.call.bind(Set.prototype.add)
      const setHas = Function.prototype.call.bind(Set.prototype.has)
      const construct = Reflect.construct
      const array = Array.isArray
      const freeze = Object.freeze
      const keys = Object.keys
      const setPrototypeOf = Object.setPrototypeOf
      const deepFreeze = (value) => {
        if (value && typeof value === 'object') {
          for (const key of keys(value)) deepFreeze(value[key])
          if (!Array.isArray(value)) setPrototypeOf(value, null)
          freeze(value)
        }
        return value
      }
      const call = async (method, args) => parse(await send(method, stringify(args)))
      const reader = ${JSON.stringify(ingest)}
      const readerCall = async (method, args) => {
        let json
        try {
          const scalarParents = new ParentSet()
          if (method !== 'emit') setAdd(scalarParents, args)
          if (method === 'emit' && array(args[0])) {
            for (const row of args[0]) {
              if (row && typeof row === 'object') {
                setAdd(scalarParents, row.values)
                setAdd(scalarParents, row.at)
                setAdd(scalarParents, row.raw)
              }
            }
          }
          json = stringify(args, function(key, value) {
            const original = this[key]
            if (typeof value === 'undefined' || typeof value === 'function' ||
              typeof value === 'symbol' || typeof value === 'bigint' ||
              (typeof value === 'number' && !finite(value)) ||
              (value !== null && typeof value === 'object' && setHas(scalarParents, this)))
              return { invalid: [] }
            if (value !== original && (typeof original === 'undefined' || typeof original === 'function' ||
              typeof original === 'symbol' || typeof original === 'bigint' ||
              (typeof original === 'number' && !finite(original)) ||
              (original !== null && typeof original === 'object' &&
                (original !== value || setHas(scalarParents, this)))))
              return { invalid: [] }
            return value
          })
        } catch {
          return parse(await send('invalid.' + method, '[]'))
        }
        return deepFreeze(parse(await send(method, json)))
      }
      const panel = ${JSON.stringify(panel)}
      const text = (value) => typeof value === 'string' ? value : stringify(value)
      const input = panel
        ? {
          buttonRecordAsync: async () => call('input.buttonRecord', []),
          textAsync: async (label) => call('input.text', [label]),
          buttonsAsync: async (label, options) => call('input.buttons', [label, options]),
          tableAsync: async (label) => call('input.table', [label]),
          recordAsync: async (label, table) => call('input.record', [label, table]),
        }
        : deepFreeze(parse(globalThis.__input))
      delete globalThis.__bridge
      delete globalThis.__input
      const api = reader ? {
        source: {
          sheets: async (...args) => readerCall('source.sheets', args),
          rows: async (...args) => readerCall('source.rows', args),
          pages: async (...args) => readerCall('source.pages', args),
          email: async (...args) => readerCall('source.email', args),
        },
        ...Object.fromEntries(['emit', 'check', 'note', 'lookup', 'fact'].map(method =>
          [method, async (...args) => readerCall(method, args)])),
      } : {
        input,
        output: panel
          ? {
            text: async (value) => call('output.text', [text(value) ?? '']),
            markdown: async (value) => call('output.markdown', [text(value) ?? '']),
            table: async (rows) => call('output.table', [rows]),
          }
          : async (value) => call('output', [value]),
        sleep: async (ms) => call('sleep', [ms]),
        console: Object.fromEntries(['log', 'info', 'warn', 'error'].map(level => [level,
          async (...args) => call('console', [level, args.map(text).join(' ')])])),
        fetch: async (url, init = {}) => {
          const response = await call('fetch', [url, init])
          return freeze({ status: response.status, headers: deepFreeze(response.headers),
            text: async () => response.body, json: async () => parse(response.body) })
        },
        records: Object.fromEntries((panel ? ['find', 'create', 'update', 'delete'] : ['find', 'create', 'update'])
          .map(method => [method, async (...args) => call('records.' + method, args)])),
      }
      const methods = reader ? ['source'] : panel ? ['console', 'records', 'input', 'output'] : ['console', 'records']
      for (const name of methods) {
        for (const method of keys(api[name])) freeze(api[name][method])
        setPrototypeOf(api[name], null)
      }
      freeze(Array.prototype)
      freeze(Object.prototype)
      freeze(Function.prototype)
      freeze(Object.getPrototypeOf(async () => {}))
      if (reader) {
        const NativeDate = Date
        function FixedDate(...args) {
          if (!new.target) return new NativeDate(0).toISOString()
          return construct(NativeDate, args.length ? args : [0], new.target)
        }
        FixedDate.prototype = NativeDate.prototype
        Object.defineProperty(NativeDate.prototype, 'constructor', { value: FixedDate })
        Object.defineProperties(FixedDate, {
          now: { value: () => 0 },
          parse: { value: NativeDate.parse },
          UTC: { value: NativeDate.UTC },
        })
        freeze(NativeDate.prototype)
        freeze(FixedDate)
        Object.defineProperty(globalThis, 'Date', { value: FixedDate, writable: false, configurable: false })
        Object.defineProperty(Math, 'random', { value: () => 0.5, writable: false, configurable: false })
        freeze(Math)
      }
      for (const key of keys(api)) {
        const value = api[key]
        if (typeof value === 'object' || typeof value === 'function') freeze(value)
        Object.defineProperty(globalThis, key, { value, writable: false, configurable: false })
      }
    })()`,
      'bridge.js',
    );
    if (setup.error) {
      try {
        throw failure(setup.error);
      } finally {
        setup.error.dispose();
      }
    }
    setup.value.dispose();
    if (ingest) {
      const prelude = options.prelude ?? (await import('../ingest/readers/toolkit-bundle.js')).TOOLKIT_SCRIPT;
      const toolkit = vm.evalCode(prelude, 'ingest.js');
      if (toolkit.error) {
        try {
          throw failure(toolkit.error);
        } finally {
          toolkit.error.dispose();
        }
      }
      toolkit.value.dispose();
    }
    // Trusted bridge setup does not spend the script's execution budget.
    clock.begin();
    const evaluated = vm.evalCode(`(async () => {\n${source}\n})()`, 'script.js');
    if (evaluated.error) {
      try {
        throw failure(evaluated.error);
      } finally {
        evaluated.error.dispose();
      }
    }
    main = evaluated.value;
    measure();
    for (;;) {
      if (fatal) throw fatal;
      if (!remaining()) throw timeout();
      const jobs = runtime.executePendingJobs(100);
      measure();
      if (jobs.error) {
        try {
          throw failure(jobs.error);
        } finally {
          jobs.error.dispose();
        }
      }
      const state = vm.getPromiseState(main);
      if (state.type === 'rejected') {
        try {
          throw failure(state.error);
        } finally {
          state.error.dispose();
        }
      }
      if (state.type === 'fulfilled') {
        state.value.dispose();
        await wait();
        if (fatal) throw fatal;
        if (!remaining()) throw timeout();
        return output;
      }
      await wait();
      if (!pending.size) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  } catch (error) {
    if (error instanceof ScriptError) {
      error.output = output;
      if (ingest && error.messageKey === 'automations.script.memory') fatal ??= error;
    }
    throw error;
  } finally {
    active = false;
    options.signal?.removeEventListener('abort', stop);
    dispose();
  }
}
