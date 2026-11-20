import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { waitForVersionServerShutdown } from '../apps/e2e/tests/qa-version-change-server.ts';

async function serverWithOpenPipes(exitEarly) {
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
    ${exitEarly ? 'process.exit(0);' : 'setInterval(() => {}, 1000);'}
  `,
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  let closed = false;
  const ended = once(server, 'close').then(() => {
    closed = true;
  });
  const exited = once(server, 'exit');
  const [holderPid] = await once(server, 'message');
  return {
    server,
    ended,
    exited,
    closed: () => closed,
    async remove() {
      if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
      process.kill(holderPid, 'SIGKILL');
      await ended;
    },
  };
}

for (const exitEarly of [true, false]) {
  test(
    exitEarly
      ? 'shutdown accepts an exited server while inherited output pipes remain open'
      : 'shutdown accepts a server that exits during its grace period while output pipes remain open',
    async (context) => {
      const fixture = await serverWithOpenPipes(exitEarly);
      try {
        if (exitEarly) await fixture.exited;
        context.mock.timers.enable({ apis: ['setTimeout'] });
        if (!exitEarly) fixture.server.kill('SIGTERM');
        const stopped = waitForVersionServerShutdown(fixture.ended, fixture.server);
        const result = assert.doesNotReject(stopped);
        await fixture.exited;
        assert.equal(fixture.server.exitCode, 0);
        assert.equal(fixture.closed(), false);
        context.mock.timers.tick(10_000);
        await result;
        await fixture.ended;
        assert.equal(fixture.server.stdout.destroyed, true);
        assert.equal(fixture.server.stderr.destroyed, true);
      } finally {
        context.mock.timers.reset();
        await fixture.remove();
      }
    },
  );
}

test('shutdown rejects and kills a server that remains alive at its deadline', async (context) => {
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
  const ended = once(server, 'close').then(() => {});
  try {
    await once(server, 'message');
    context.mock.timers.enable({ apis: ['setTimeout'] });
    server.kill('SIGTERM');
    const stopped = waitForVersionServerShutdown(ended, server);
    const result = assert.rejects(stopped, /Version test server did not exit within 10 seconds/);
    assert.equal(server.exitCode, null);
    assert.equal(server.signalCode, null);
    context.mock.timers.tick(10_000);
    await result;
    await ended;
    assert.equal(server.signalCode, 'SIGKILL');
  } finally {
    context.mock.timers.reset();
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
    await ended;
  }
});
