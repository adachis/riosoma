import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startDisplay } from './display';

let running: Awaited<ReturnType<typeof startDisplay>> | undefined;
const temporary: string[] = [];
afterEach(async () => {
  await running?.stop();
  running = undefined;
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function binary(script: string) {
  const root = join(import.meta.dirname, '.unit-logs');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'display-test-'));
  temporary.push(directory);
  const executable = join(directory, 'display.mjs');
  writeFileSync(executable, `#!${process.execPath}\n${script}`, { mode: 0o700 });
  vi.stubEnv('DISPLAY', undefined);
  vi.stubEnv('RIOSOMA_E2E_XVFB', executable);
  return executable;
}

it('preserves a display supplied by the caller', async () => {
  vi.stubEnv('DISPLAY', ':72');
  running = await startDisplay();
  expect(process.env.DISPLAY).toBe(':72');
  await running.stop();
  running = undefined;
  expect(process.env.DISPLAY).toBe(':72');
});

it('uses the allocated display and restores the environment after output closes', async () => {
  binary(`import { writeSync } from 'node:fs';
    writeSync(3, '27\\n');
    setInterval(() => {}, 1000);
    process.on('SIGTERM', () => { console.log('Display stopped'); process.exit(0); });`);
  vi.stubEnv('LIBGL_ALWAYS_SOFTWARE', 'previous');
  running = await startDisplay();
  expect(process.env.DISPLAY).toBe(':27');
  expect(process.env.LIBGL_ALWAYS_SOFTWARE).toBe('1');
  await running.stop();
  running = undefined;
  expect(process.env.DISPLAY).toBeUndefined();
  expect(process.env.LIBGL_ALWAYS_SOFTWARE).toBe('previous');
});

it('reports an early display failure without publishing an unusable address', async () => {
  binary(`console.error('Cannot start display'); process.exit(3);`);
  await expect(startDisplay()).rejects.toThrow('Xvfb exited with 3');
  expect(process.env.DISPLAY).toBeUndefined();
});

// startDisplay looks for Xvfb on PATH only on Linux.  Elsewhere it starts one only when
// RIOSOMA_E2E_XVFB names it.
const linux = process.platform === 'linux';

it.runIf(linux)('finds Xvfb on PATH when no override is supplied', async () => {
  const executable = binary(`import { writeSync } from 'node:fs';
    writeSync(3, '28\\n');
    setInterval(() => {}, 1000);`);
  const directory = join(executable, '..');
  renameSync(executable, join(directory, 'Xvfb'));
  vi.stubEnv('RIOSOMA_E2E_XVFB', undefined);
  vi.stubEnv('PATH', directory);
  running = await startDisplay();
  expect(process.env.DISPLAY).toBe(':28');
});

it.runIf(linux)('requires Xvfb when neither PATH nor an override supplies it', async () => {
  vi.stubEnv('DISPLAY', undefined);
  vi.stubEnv('RIOSOMA_E2E_XVFB', undefined);
  vi.stubEnv('PATH', '');
  await expect(startDisplay()).rejects.toThrow('Xvfb is required');
});

it.skipIf(linux)('starts no display outside Linux unless an override is supplied', async () => {
  vi.stubEnv('DISPLAY', undefined);
  vi.stubEnv('RIOSOMA_E2E_XVFB', undefined);
  running = await startDisplay();
  expect(process.env.DISPLAY).toBeUndefined();
});
