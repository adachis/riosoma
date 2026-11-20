import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import {
  AppError,
  ScriptClientMessage,
  ScriptId,
  SCRIPT_LIMITS,
  newId,
  roleAllows,
  type ScriptServerMessage,
  type ScriptButtonContext,
} from '@riosoma/contracts';
import { ScriptError } from '../automations/script.js';
import { AccessScope } from '../data/access.js';
import { dataStore } from '../data/context.js';
import { RUN_CANCELED, runPanelScript, type PanelIo } from './run.js';
import { loadScript } from './store.js';

/**
 * The script panel's runs.  Each run is one WebSocket, so the server that runs the script is the
 * one the panel talks to, and the run ends when the socket does:
 *
 * `GET /api/scripts/:scriptId/run` (session, same origin, record editing access).  The panel's
 * first message is `start` with the session's CSRF token.  The server answers `started`, streams
 * `log`, `output`, `prompt`, and `wrote`, and ends with `finished` before closing.  An `answer`
 * resumes the script waiting on that prompt, and `cancel`, or closing the socket, stops it.
 *
 * It's registered beside the realtime socket, which owns the WebSocket server.
 */

/** Runs one person, and one server, may have going at once */
export const PANEL_RUNS = { perPerson: 2, perServer: 8 };

interface ActiveRun {
  userId: string;
  stop(reason: ScriptError): void;
}

function connect(
  app: FastifyInstance,
  runs: Set<ActiveRun>,
  socket: WebSocket,
  request: FastifyRequest,
  watchSession: (sessionId: string, end: () => void) => () => void,
): void {
  const actor = request.actor;
  if (!actor) {
    socket.close(4401);
    return;
  }
  const scriptId = ScriptId.safeParse((request.params as { scriptId?: unknown }).scriptId);
  const controller = new AbortController();
  const stop = (reason: ScriptError) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  let started = false;
  let prompt: { id: number; resolve(value: unknown): void } | null = null;
  let prompts = 0;
  let received: number[] = [];
  const send = (message: ScriptServerMessage) => {
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > 16 * 1024 * 1024) {
      stop(new ScriptError(RUN_CANCELED));
      socket.close(1013);
      return;
    }
    socket.send(JSON.stringify(message));
  };
  const finish = (code = 1000) => {
    if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) socket.close(code);
  };
  // The panel says who it is at once, or the socket goes.
  const hello = setTimeout(() => finish(4408), 10_000);
  hello.unref();
  // Pings keep proxies from closing a socket that waits a long time on the person.
  let checking = false;
  const timer = setInterval(() => {
    if (socket.readyState === socket.OPEN) socket.ping();
    if (checking || !started) return;
    checking = true;
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
            stop(new ScriptError('errors.signInRequired'));
        },
        () => stop(new ScriptError('errors.signInRequired')),
      )
      .finally(() => {
        checking = false;
      });
  }, 30_000);
  timer.unref();
  const unwatch = watchSession(actor.sessionId, () => {
    stop(new ScriptError('errors.signInRequired'));
    finish(4401);
  });
  socket.on('close', () => {
    unwatch();
    clearTimeout(hello);
    clearInterval(timer);
    stop(new ScriptError(RUN_CANCELED));
  });

  const io: PanelIo = {
    log: (entry) => send({ type: 'log', level: entry.level, text: entry.text }),
    output: (output) => send({ type: 'output', output }),
    wrote: (writes) => send({ type: 'wrote', writes }),
    ask: (question) =>
      new Promise((resolve) => {
        prompts += 1;
        prompt = { id: prompts, resolve };
        send({ type: 'prompt', promptId: prompts, prompt: question });
      }),
  };

  const begin = async (button?: ScriptButtonContext) => {
    clearTimeout(hello);
    const refuse = (messageKey: string) => {
      send({ type: 'refused', messageKey });
      finish();
    };
    if (!scriptId.success) return refuse('errors.notFound');
    const { pool, schemas } = dataStore(app.ctx);
    const script = await loadScript(pool, schemas, scriptId.data);
    if (!script || script.trashed || script.orgId !== actor.orgId) return refuse('errors.notFound');
    const role = await new AccessScope(pool, schemas, actor).databaseRole(script.databaseId);
    if (!role) return refuse('errors.notFound');
    if (!roleAllows(role, 'editRecords')) return refuse('data.access.denied');
    const mine = [...runs].filter((run) => run.userId === actor.userId).length;
    if (mine >= PANEL_RUNS.perPerson || runs.size >= PANEL_RUNS.perServer) return refuse('scripts.run.busy');
    if (controller.signal.aborted) return finish();
    const run: ActiveRun = { userId: actor.userId, stop };
    runs.add(run);
    try {
      const runId = newId('job');
      const groupId = newId('action');
      const timeoutMs = app.ctx.config.scriptPanelTimeoutMs ?? SCRIPT_LIMITS.timeoutMs;
      const runMs = app.ctx.config.scriptPanelRunMs ?? SCRIPT_LIMITS.runMs;
      send({ type: 'started', runId, groupId, timeoutMs, runMs });
      const result = await runPanelScript(app, actor, script, io, {
        runId,
        groupId,
        signal: controller.signal,
        timeoutMs,
        runMs,
        button,
      });
      send({ type: 'finished', ...result });
    } finally {
      runs.delete(run);
      finish();
    }
  };

  socket.on('message', (raw, binary) => {
    const now = Date.now();
    received = received.filter((at) => at > now - 1_000);
    if (received.length >= 20) {
      stop(new ScriptError(RUN_CANCELED));
      finish(1008);
      return;
    }
    received.push(now);
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
    const parsed = ScriptClientMessage.safeParse(input);
    if (!started) {
      const digest = (value: string) => createHash('sha256').update(value).digest();
      if (
        !parsed.success ||
        parsed.data.type !== 'start' ||
        !timingSafeEqual(digest(parsed.data.csrf), digest(actor.csrfToken))
      ) {
        finish(4401);
        return;
      }
      started = true;
      void begin(parsed.data.button).catch((error: unknown) => {
        app.log.error(
          { errorName: error instanceof Error ? error.name : typeof error },
          'script run could not start',
        );
        send({
          type: 'refused',
          messageKey: error instanceof AppError ? error.messageKey : 'errors.internal',
        });
        finish();
      });
      return;
    }
    if (!parsed.success) return;
    if (parsed.data.type === 'cancel') stop(new ScriptError(RUN_CANCELED));
    else if (parsed.data.type === 'answer' && prompt?.id === parsed.data.promptId) {
      const answered = prompt;
      prompt = null;
      answered.resolve(parsed.data.value);
    }
  });
}

/** Registers the run socket.  Call it where `@fastify/websocket` is registered. */
export async function scriptRunRoutes(
  app: FastifyInstance,
  options: {
    validOrigin(request: FastifyRequest): boolean;
    watchSession(sessionId: string, end: () => void): () => void;
  },
): Promise<void> {
  const runs = new Set<ActiveRun>();
  app.addHook('preClose', async () => {
    for (const run of runs) run.stop(new ScriptError(RUN_CANCELED));
  });
  app.get(
    '/api/scripts/:scriptId/run',
    {
      websocket: true,
      config: { policy: { kind: 'session' } },
      onRequest: async (request) => {
        if (!options.validOrigin(request)) throw new AppError('forbidden', 'errors.badRequest');
      },
    },
    (socket, request) => connect(app, runs, socket, request, options.watchSession),
  );
}
