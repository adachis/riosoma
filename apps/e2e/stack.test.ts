import { spawn, type ChildProcess } from 'node:child_process';
import type * as ChildProcesses from 'node:child_process';
import { once } from 'node:events';
import type * as FileSystem from 'node:fs';
import { existsSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startMailCatcher } from './mail';
import type * as Mail from './mail';
import { startStack, type Stack } from './stack';

vi.mock('node:child_process', async (original) => {
  const childProcess = await original<typeof ChildProcesses>();
  return { ...childProcess, spawn: vi.fn(childProcess.spawn) };
});
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof FileSystem>();
  return { ...fs, rmSync: vi.fn(fs.rmSync) };
});
vi.mock('./mail', async (original) => {
  const mail = await original<typeof Mail>();
  return { ...mail, startMailCatcher: vi.fn(mail.startMailCatcher) };
});

let stack: Stack | undefined;
let server: ChildProcess | undefined;
let closed: Promise<void> | undefined;

afterEach(async () => {
  vi.useRealTimers();
  if (server && server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
  await closed;
  if (stack) {
    await stack.stop().catch(() => {});
    const fs = await vi.importActual<typeof FileSystem>('node:fs');
    fs.rmSync(dirname(stack.mailDir), { recursive: true, force: true });
  }
  stack = undefined;
  server = undefined;
  closed = undefined;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

async function fixture(ignoreTermination = false) {
  const childProcess = await vi.importActual<typeof ChildProcesses>('node:child_process');
  vi.stubEnv('RIOSOMA_E2E_MAILPIT', undefined);
  vi.stubEnv('RIOSOMA_E2E_WEB_DIR', import.meta.dirname);
  vi.mocked(spawn).mockImplementationOnce((command, _args, options) => {
    server = childProcess.spawn(
      command,
      [
        '-e',
        `
          const { createServer } = require('node:http');
          const server = createServer((_, response) => response.end('ready'));
          server.listen(Number(process.env.RIOSOMA_PORT), '127.0.0.1');
          process.on('SIGTERM', () => {
            ${ignoreTermination ? '' : 'server.close(() => process.exit(0));'}
          });
        `,
      ],
      options,
    );
    closed = once(server, 'close').then(() => {});
    return server;
  });
  stack = await startStack({ database: false });
  return stack;
}

function failRemoval() {
  const error = Object.assign(new Error('Directory not empty'), { code: 'ENOTEMPTY' });
  vi.mocked(rmSync).mockImplementation(() => {
    throw error;
  });
  return error;
}

it('retries configuration-folder removal after the server and mail catcher close', async () => {
  const stack = await fixture();
  const mail = await vi.mocked(startMailCatcher).mock.results[0]!.value;
  const socket = createConnection({ port: Number(new URL(mail.url).port), host: '127.0.0.1' });
  const socketClosed = once(socket, 'close');
  await once(socket, 'data');
  const stopMail = mail.stop;
  let mailStopped = false;
  vi.spyOn(mail, 'stop').mockImplementation(async () => {
    await stopMail();
    mailStopped = true;
  });
  const configDir = dirname(stack.mailDir);
  const fs = await vi.importActual<typeof FileSystem>('node:fs');
  let processClosed = false;
  void closed!.then(() => (processClosed = true));
  vi.mocked(rmSync).mockImplementation((directory, options) => {
    expect(processClosed).toBe(true);
    expect(mailStopped).toBe(true);
    expect(options).toMatchObject({ recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(directory, options);
  });
  await stack.stop();
  await socketClosed;
  expect(rmSync).toHaveBeenCalledOnce();
  expect(existsSync(configDir)).toBe(false);
});

it('warns about leftover configuration files without failing a successfully stopped stack', async () => {
  const stack = await fixture();
  const error = failRemoval();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await expect(stack.stop()).resolves.toBeUndefined();
  expect(warning).toHaveBeenCalledWith(expect.stringContaining(dirname(stack.mailDir)), error);
  expect(existsSync(dirname(stack.mailDir))).toBe(true);
  await closed;
});

it('keeps the process deadline fatal and names the server when folder removal also fails', async () => {
  const stack = await fixture(true);
  const error = failRemoval();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const stopped = stack.stop().catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await stopped).toMatchObject({
    message: expect.stringContaining(
      `Browser test server at ${stack.baseURL} (PID ${server!.pid}) did not exit within 10 seconds`,
    ),
    errors: [expect.objectContaining({ message: expect.stringContaining('did not exit within 10 seconds') })],
  });
  await closed;
  expect(server!.signalCode).toBe('SIGKILL');
  expect(warning).toHaveBeenCalledWith(expect.stringContaining(dirname(stack.mailDir)), error);
});
