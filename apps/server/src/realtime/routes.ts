import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import websocket, { type WebSocket } from '@fastify/websocket';
import { AppError, ClientMessage } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { dataStore } from '../data/context.js';
import { scriptRunRoutes } from '../scripts/routes.js';
import { RealtimeHub, type RealtimeTab } from './hub.js';

export function validOrigin(request: FastifyRequest, baseUrl: string | undefined): boolean {
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    const expected = new URL(baseUrl ?? `${request.protocol}://${request.host}`);
    return (expected.protocol === 'http:' || expected.protocol === 'https:') && origin === expected.origin;
  } catch {
    return false;
  }
}

function connect(app: FastifyInstance, hub: RealtimeHub, socket: WebSocket, request: FastifyRequest): void {
  const actor = request.actor;
  if (!actor) {
    socket.close(4401);
    return;
  }
  let hello = false;
  let lastMessage = Date.now();
  let nextSessionCheck = Date.now() + 60_000;
  let checkingSession = false;
  let queued = 0;
  let received: number[] = [];
  let chain = Promise.resolve();
  let forceClose: NodeJS.Timeout | undefined;
  const close = (code: number) => {
    if (!tab.open) return;
    hub.detach(tab);
    socket.close(code);
    forceClose = setTimeout(() => socket.terminate(), 1_000);
    forceClose.unref();
  };
  const tab: RealtimeTab = {
    actor,
    clientId: '',
    name: '',
    open: true,
    send(message) {
      if (!tab.open || socket.readyState !== socket.OPEN) return false;
      if (socket.bufferedAmount > 16 * 1024 * 1024) {
        close(1013);
        return false;
      }
      socket.send(JSON.stringify(message));
      return true;
    },
    terminate(code) {
      if (code) {
        socket.close(code);
        forceClose = setTimeout(() => socket.terminate(), 1_000);
        forceClose.unref();
      } else socket.terminate();
    },
  };
  hub.attach(tab);
  const unwatchSession = hub.watchSession(actor.sessionId, () => close(4401));
  const timer = setInterval(() => {
    if (!tab.open) return;
    const now = Date.now();
    if (now - lastMessage >= 60_000) {
      close(4408);
      return;
    }
    if (now < nextSessionCheck || checkingSession) return;
    checkingSession = true;
    nextSessionCheck = now + 60_000;
    void app.ctx.sessions
      .resolve(request)
      .then(
        (current) => {
          if (
            !current ||
            current.sessionId !== actor.sessionId ||
            current.userId !== actor.userId ||
            current.orgId !== actor.orgId
          )
            close(4401);
          else tab.actor = current;
        },
        () => close(4401),
      )
      .finally(() => {
        checkingSession = false;
      });
  }, 1_000);
  timer.unref();
  socket.on('close', () => {
    clearInterval(timer);
    clearTimeout(forceClose);
    unwatchSession();
    hub.detach(tab);
  });
  socket.on('message', (raw, binary) => {
    if (!tab.open) return;
    lastMessage = Date.now();
    received = received.filter((at) => at > lastMessage - 1_000);
    if (received.length >= 50 || queued >= 100) {
      tab.send({ type: 'error', messageKey: 'errors.badRequest' });
      close(1008);
      return;
    }
    received.push(lastMessage);
    queued++;
    chain = chain
      .then(async () => {
        if (!tab.open) return;
        let input: unknown;
        try {
          const bytes = Array.isArray(raw)
            ? Buffer.concat(raw)
            : raw instanceof ArrayBuffer
              ? Buffer.from(raw)
              : raw;
          input = binary ? undefined : JSON.parse(bytes.toString('utf8'));
        } catch {
          input = undefined;
        }
        const parsed = ClientMessage.safeParse(input);
        if (!hello) {
          if (!parsed.success || parsed.data.type !== 'hello') {
            close(4401);
            return;
          }
          const digest = (value: string) => createHash('sha256').update(value).digest();
          if (!timingSafeEqual(digest(parsed.data.csrf), digest(actor.csrfToken))) {
            close(4401);
            return;
          }
          const { pool, schemas } = dataStore(app.ctx);
          const result = await query<{ name: string }>(
            pool,
            sql`SELECT name FROM ${ident(schemas.app, 'users')} WHERE id = ${actor.userId}`,
          );
          if (!result.rows[0]) {
            close(4401);
            return;
          }
          tab.clientId = parsed.data.clientId;
          tab.name = result.rows[0].name;
          hello = true;
          tab.send({ type: 'ready' });
        } else if (!parsed.success) {
          tab.send({ type: 'error', messageKey: 'errors.badRequest' });
        } else if (parsed.data.type === 'ping') {
          await hub.handle(tab, parsed.data);
        } else {
          const current = await app.ctx.sessions.resolve(request);
          if (
            !current ||
            current.sessionId !== actor.sessionId ||
            current.userId !== actor.userId ||
            current.orgId !== actor.orgId
          ) {
            close(4401);
            return;
          }
          tab.actor = current;
          await hub.handle(tab, parsed.data);
        }
      })
      .catch((error: unknown) => {
        tab.send({
          type: 'error',
          messageKey: error instanceof AppError ? error.messageKey : 'errors.internal',
        });
      })
      .finally(() => {
        queued--;
      });
  });
}

/** The realtime WebSocket: changes, presence, and view deltas, and the script panel's run sockets. */
export async function realtimeRoutes(app: FastifyInstance): Promise<void> {
  const hub = new RealtimeHub(app);
  app.ctx.watchSession = (sessionId, end) => hub.watchSession(sessionId, end);
  app.addHook('preClose', async () => hub.close());
  app.addHook('onReady', async () => hub.start());
  await app.register(websocket, {
    options: { maxPayload: 64 * 1024 },
    // The transport sends 1009 for an oversized frame; terminating here would discard that close.
    errorHandler(_error, socket) {
      if (socket.readyState === socket.OPEN) socket.close(1008);
    },
  });
  app.get(
    '/api/realtime',
    {
      websocket: true,
      config: { policy: { kind: 'session' } },
      onRequest: async (request) => {
        if (!validOrigin(request, app.ctx.config.baseUrl))
          throw new AppError('forbidden', 'errors.badRequest');
      },
    },
    (socket, request) => connect(app, hub, socket, request),
  );
  // The script panel's runs are sockets too, so they're registered where the socket server is.
  await app.register(scriptRunRoutes, {
    validOrigin: (request: FastifyRequest) => validOrigin(request, app.ctx.config.baseUrl),
    watchSession: (sessionId: string, end: () => void) => hub.watchSession(sessionId, end),
  });
}
