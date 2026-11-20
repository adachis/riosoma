import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Each child process here gets a folder of its own as its TMPDIR, under the package's own cache
 * folder, so these tests never read or write the shared temporary folders.
 */
const base = fileURLToPath(new URL('../node_modules/.cache/testkit-test-setup/', import.meta.url));
const setup = new URL('./test-setup.ts', import.meta.url).href;
const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
const children = new Set<ChildProcessWithoutNullStreams>();

interface ChildOptions {
  /** Whether the child runs as a Vitest worker does, with `VITEST_POOL_ID` set */
  worker: boolean;
  /** Whether the child handles SIGTERM itself before it loads the setup */
  handlesSigterm?: boolean;
  /** Whether the child keeps running until a signal ends it */
  keepsRunning?: boolean;
}

/**
 * A plain Node process that loads the setup's TypeScript source, as a fork worker does, then
 * reports how many handlers each signal has.  Node runs the source once each relative `.js`
 * import resolves to its `.ts` file.
 */
function start(parent: string, options: ChildOptions): ChildProcessWithoutNullStreams {
  const script = `
    import { registerHooks } from 'node:module';
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (!specifier.startsWith('.') || !specifier.endsWith('.js')) return nextResolve(specifier, context);
        try {
          return nextResolve(specifier, context);
        } catch {
          return nextResolve(specifier.slice(0, -3) + '.ts', context);
        }
      },
    });
    if (${Boolean(options.handlesSigterm)}) process.on('SIGTERM', () => {});
    await import(${JSON.stringify(setup)});
    const counts = Object.fromEntries(${JSON.stringify(signals)}.map((signal) => [signal, process.listenerCount(signal)]));
    process.stdout.write(JSON.stringify(counts) + '\\n');
    if (${Boolean(options.keepsRunning)}) setInterval(() => {}, 1_000);
  `;
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: parent };
  if (options.worker) env.VITEST_POOL_ID = '1';
  else delete env.VITEST_POOL_ID;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], { env });
  children.add(child);
  return child;
}

/** The handler counts the child reports once the setup has loaded. */
function report(child: ChildProcessWithoutNullStreams): Promise<Record<string, number>> {
  return new Promise((resolve, reject) => {
    let output = '';
    let errors = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
      const end = output.indexOf('\n');
      if (end < 0) return;
      try {
        resolve(JSON.parse(output.slice(0, end)) as Record<string, number>);
      } catch (error) {
        reject(error as Error);
      }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (errors += chunk));
    child.once('close', (code, signal) =>
      reject(new Error(`The child ended (${signal ?? code}) before it loaded the setup.  ${errors}`)),
    );
  });
}

function folders(parent: string): string[] {
  return readdirSync(parent).filter((name) => name.startsWith('rio-test-cloud-'));
}

describe("a test worker's temporary folder", () => {
  let parent: string;

  beforeEach(() => {
    mkdirSync(base, { recursive: true });
    parent = mkdtempSync(join(base, 'run-'));
  });

  afterEach(() => {
    // A child a failed test left running would otherwise run on after the suite.
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    children.clear();
    rmSync(parent, { recursive: true, force: true });
  });

  it.each(signals)(
    'is removed when %s ends a fork worker, which still ends by that signal',
    async (signal) => {
      const child = start(parent, { worker: true, keepsRunning: true });
      const closed = once(child, 'close');
      const counts = await report(child);
      expect(folders(parent)).toHaveLength(1);

      child.kill(signal);
      const [code, endedBy] = await closed;
      expect(folders(parent)).toEqual([]);
      expect(endedBy).toBe(signal);
      expect(code).toBeNull();
      expect(counts).toEqual({ SIGTERM: 1, SIGINT: 1, SIGHUP: 1 });
    },
  );

  it('is removed when a fork worker exits', async () => {
    const child = start(parent, { worker: true });
    const closed = once(child, 'close');
    await report(child);
    const [code] = await closed;
    expect(code).toBe(0);
    expect(folders(parent)).toEqual([]);
  });

  it('adds no signal handlers to a process that already handles SIGTERM', async () => {
    const child = start(parent, { worker: true, handlesSigterm: true });
    const closed = once(child, 'close');
    expect(await report(child)).toEqual({ SIGTERM: 1, SIGINT: 0, SIGHUP: 0 });
    await closed;
    expect(folders(parent)).toEqual([]);
  });

  it('adds no signal handlers outside a Vitest worker', async () => {
    const child = start(parent, { worker: false });
    const closed = once(child, 'close');
    expect(await report(child)).toEqual({ SIGTERM: 0, SIGINT: 0, SIGHUP: 0 });
    await closed;
    expect(folders(parent)).toEqual([]);
  });
});
