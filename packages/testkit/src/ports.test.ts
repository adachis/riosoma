import { connect } from 'node:net';
import { describe, expect, it } from 'vitest';
import { refusedPort } from './ports.js';

/** What the loopback answers with on a port nothing holds, or why it answered at all. */
function attempt(port: number): Promise<unknown> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(new Error('something answered'));
    });
    socket.once('error', (error: unknown) => {
      socket.destroy();
      resolve(error);
    });
  });
}

describe('a port nothing answers on', () => {
  it('refuses a connection, which is what a stopped server looks like', async () => {
    await expect(attempt(await refusedPort())).resolves.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('is a port an HTTP client dials, so a refused request names the network', async () => {
    const failure = await fetch(`http://127.0.0.1:${await refusedPort()}/`).then(
      () => null,
      (error: unknown) => error as { cause?: { code?: string } },
    );
    expect(failure?.cause).toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('stays below the range a test server can bind, so nobody takes it over mid-test', async () => {
    for (let call = 0; call < 3; call += 1) {
      const port = await refusedPort();
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThan(1024);
      await expect(attempt(port)).resolves.toMatchObject({ code: 'ECONNREFUSED' });
    }
  });
});
