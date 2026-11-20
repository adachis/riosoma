import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { lastLines } from './stack';
import { stopProcess } from './process-shutdown';

async function xvfb(): Promise<string> {
  if (process.env.RIOSOMA_E2E_XVFB) return process.env.RIOSOMA_E2E_XVFB;
  for (const directory of (process.env.PATH ?? '').split(':')) {
    const binary = join(directory, 'Xvfb');
    try {
      accessSync(binary, constants.X_OK);
      return binary;
    } catch {
      /* Try the next directory. */
    }
  }
  throw new Error('Xvfb is required; install it on PATH or set RIOSOMA_E2E_XVFB to its executable');
}

/** Headless Firefox still needs an X display to create Mesa's software WebGL contexts on Linux. */
export async function startDisplay(): Promise<{ stop(): Promise<void> }> {
  if (process.env.DISPLAY || (process.platform !== 'linux' && !process.env.RIOSOMA_E2E_XVFB))
    return { async stop() {} };
  const child = spawn(await xvfb(), ['-displayfd', '3', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'], {
    env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  const printed = lastLines(child);
  const previous = process.env.LIBGL_ALWAYS_SOFTWARE;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const number = await new Promise<string>((fulfill, reject) => {
      let output = '';
      timer = setTimeout(
        () => reject(new Error('Xvfb did not report its display within 15 seconds')),
        15_000,
      );
      child.once('error', reject);
      child.once('exit', (code) =>
        reject(new Error(`Xvfb exited with ${code}: ${printed.lines().join('\n')}`)),
      );
      child.stdio[3]!.on('data', (bytes: Buffer) => {
        output += bytes.toString();
        const match = /^(\d+)\n/.exec(output);
        if (match) fulfill(match[1]!);
      });
    });
    process.env.DISPLAY = `:${number}`;
    process.env.LIBGL_ALWAYS_SOFTWARE = '1';
  } catch (error) {
    await stopProcess(child, printed.ended, 'Browser test display');
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return {
    async stop() {
      try {
        await stopProcess(child, printed.ended, 'Browser test display');
      } finally {
        delete process.env.DISPLAY;
        if (previous === undefined) delete process.env.LIBGL_ALWAYS_SOFTWARE;
        else process.env.LIBGL_ALWAYS_SOFTWARE = previous;
      }
    },
  };
}
