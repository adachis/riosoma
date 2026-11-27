import { createServer, type AddressInfo, type Server } from 'node:net';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { startTestPostgres } from './postgres.js';

/** A listener on a loopback port, standing for whatever took a port before PostgreSQL could. */
async function listener(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

/** A port free when asked, the way the kit chooses one: something can still take it later. */
async function freePort(): Promise<number> {
  const { server, port } = await listener();
  await close(server);
  return port;
}

describe('a private test cluster', () => {
  it('starts on another port when something takes the chosen one before PostgreSQL binds it', async () => {
    const taken = await listener();
    const chosen: number[] = [];
    try {
      const kit = await startTestPostgres({
        choosePort: async () => {
          const port = chosen.length ? await freePort() : taken.port;
          chosen.push(port);
          return port;
        },
      });
      try {
        expect(chosen[0]).toBe(taken.port);
        expect(chosen.length).toBeGreaterThanOrEqual(2);
        expect(Number(new URL(kit.url).port)).toBe(chosen.at(-1));
        const client = new pg.Client({ connectionString: kit.url });
        await client.connect();
        try {
          expect((await client.query('SELECT 1 AS one')).rows).toEqual([{ one: 1 }]);
        } finally {
          await client.end();
        }
      } finally {
        await kit.stop();
      }
    } finally {
      await close(taken.server);
    }
  }, 60_000);

  it('gives up after a few ports when every one it chose was taken', async () => {
    const taken = await listener();
    let attempts = 0;
    try {
      await expect(
        startTestPostgres({
          choosePort: async () => {
            attempts++;
            return taken.port;
          },
        }),
      ).rejects.toThrow();
      expect(attempts).toBe(5);
    } finally {
      await close(taken.server);
    }
  }, 60_000);
});
