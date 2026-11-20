import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { stopProcess } from './process-shutdown.ts';

async function serverWithOpenPipes() {
  const server = spawn(
    process.execPath,
    [
      '-e',
      `
        const { spawn } = require('node:child_process');
        const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          stdio: ['ignore', 'inherit', 'inherit'],
        });
        holder.unref();
        process.on('SIGTERM', () => process.exit(0));
        process.send(holder.pid);
        process.disconnect();
        setInterval(() => {}, 1000);
      `,
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  const closed = once(server, 'close').then(() => {});
  const exited = once(server, 'exit');
  const [holderPid] = await once(server, 'message');
  return {
    server,
    closed,
    exited,
    holderPid,
    async remove() {
      if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
      try {
        process.kill(holderPid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
      await closed;
    },
  };
}

test('shutdown waits for inherited output pipes after the server exits', async () => {
  const fixture = await serverWithOpenPipes();
  try {
    let stopped = false;
    const shutdown = stopProcess(fixture.server, fixture.closed, 'Browser test server').then(() => {
      stopped = true;
    });
    await fixture.exited;
    assert.equal(fixture.server.exitCode, 0);
    assert.equal(stopped, false);
    process.kill(fixture.holderPid, 'SIGTERM');
    await shutdown;
    assert.equal(stopped, true);
  } finally {
    await fixture.remove();
  }
});

test('shutdown names and kills a server that does not exit by its deadline', async (context) => {
  const server = spawn(
    process.execPath,
    [
      '-e',
      `
        process.on('SIGTERM', () => {});
        process.send('ready');
        process.disconnect();
        setInterval(() => {}, 1000);
      `,
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  const closed = once(server, 'close').then(() => {});
  try {
    await once(server, 'message');
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const shutdown = stopProcess(server, closed, 'Browser test server at http://127.0.0.1:1234');
    const rejected = assert.rejects(
      shutdown,
      new RegExp(
        `Browser test server at http://127.0.0.1:1234 \\(PID ${server.pid}\\) did not exit within 10 seconds`,
      ),
    );
    context.mock.timers.tick(10_000);
    await rejected;
    await closed;
    assert.equal(server.signalCode, 'SIGKILL');
  } finally {
    context.mock.timers.reset();
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
    await closed;
  }
});

test('shutdown fails when an exited server still has inherited pipes at its deadline', async (context) => {
  const fixture = await serverWithOpenPipes();
  try {
    fixture.server.kill('SIGTERM');
    await fixture.exited;
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const shutdown = stopProcess(fixture.server, fixture.closed, 'Browser test server');
    const rejected = assert.rejects(shutdown, /did not close its output streams within 10 seconds/);
    context.mock.timers.tick(10_000);
    await rejected;
    await fixture.closed;
    assert.equal(fixture.server.stdout.destroyed, true);
    assert.equal(fixture.server.stderr.destroyed, true);
  } finally {
    context.mock.timers.reset();
    await fixture.remove();
  }
});
