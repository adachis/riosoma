import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { PassThrough } from 'node:stream';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { newId } from '@riosoma/contracts';
import type { AppContext } from '../app.js';
import { installPolicies, type Actor } from './policy.js';

it.each(['GET', 'POST'] as const)(
  'closes a protected %s response stream and removes its watcher when the session ends',
  async (method) => {
    const app = Fastify();
    const actor: Actor = {
      userId: newId('user'),
      orgId: newId('org'),
      sessionId: newId('session'),
      csrfToken: randomBytes(32).toString('base64url'),
      kind: 'member',
      adminRoles: [],
    };
    let end!: () => void;
    let watched: string | undefined;
    const unwatch = vi.fn();
    app.decorate('ctx', {
      config: { database: { schemas: { app: 'stream_sessions' } } },
      pool: { query: vi.fn().mockResolvedValue({ rows: [{ id: actor.sessionId }], rowCount: 1 }) },
      watchSession: (id: string, close: () => void) => {
        watched = id;
        end = close;
        return unwatch;
      },
    } as unknown as AppContext);
    installPolicies(app, {
      sessions: () => ({ resolve: async () => actor }),
      verifySetupToken: () => false,
    });
    const source = new PassThrough();
    app.route({
      method,
      url: '/api/session-stream',
      config: { policy: { kind: 'session' } },
      handler: (_request, reply) => reply.header('content-type', 'application/x-ndjson').send(source),
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const request = httpRequest(`${address}/api/session-stream`, {
      method,
      headers: { 'x-csrf-token': actor.csrfToken },
    });
    let arrived!: () => void;
    const ready = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const closed = new Promise<void>((resolve, reject) => {
      request.on('response', (response) => {
        response.on('data', arrived);
        response.on('close', resolve);
        response.on('error', () => {});
      });
      request.on('error', reject);
    });
    request.end();
    source.write('first chunk');
    try {
      await ready;
      expect(watched).toBe(actor.sessionId);
      end();
      await closed;
      expect(source.destroyed).toBe(true);
      await vi.waitFor(() => expect(unwatch).toHaveBeenCalledOnce());
    } finally {
      source.destroy();
      request.destroy();
      await app.close();
    }
  },
);
