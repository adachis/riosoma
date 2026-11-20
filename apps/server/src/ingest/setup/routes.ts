import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type IngestSetupCommand, SPREADSHEET_LIMITS, TableId, statusFor } from '@riosoma/contracts';
import { requireActor } from '../../auth/sessions.js';
import { parse } from '../../http/validate.js';
import { refuseDemo } from '../../demo/boundary.js';
import {
  readIngestReadiness,
  readIngestSetup,
  runIngestSetupCommand,
} from '../../data/commands/ingest-setup.js';

const session = { config: { policy: { kind: 'session' as const, beforeBody: true as const } } };
const base = '/api/tables/:tableId/ingest';

/**
 * Named routes and the command endpoint use identical validation and command replay.  Every route needs a
 * signed-in session, so a token never reaches a command here, and the go-live command checks its actor again.
 */
export async function ingestSetupRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });
  app.get(base, session, async (request) => {
    const actor = requireActor(request);
    refuseDemo(actor);
    const { tableId } = parse(z.object({ tableId: TableId }), request.params);
    return readIngestSetup(app, actor, tableId);
  });
  app.get(`${base}/readiness`, session, async (request) => {
    const actor = requireActor(request);
    refuseDemo(actor);
    const { tableId } = parse(z.object({ tableId: TableId }), request.params);
    return readIngestReadiness(app, actor, tableId);
  });
  const paths: ReadonlyArray<[string, IngestSetupCommand['kind'] | null]> = [
    ['/commands', null],
    ['/begin', 'ingest.begin'],
    ['/output', 'ingest.output'],
    ['/propose', 'ingest.propose'],
    ['/senders/add', 'ingest.sender.add'],
    ['/senders/update', 'ingest.sender.update'],
    ['/senders/remove', 'ingest.sender.remove'],
    ['/formats/add', 'ingest.format.add'],
    ['/formats/rename', 'ingest.format.rename'],
    ['/formats/remove', 'ingest.format.remove'],
    ['/formats/rules', 'ingest.format.rules'],
    ['/drafts/start', 'ingest.draft.start'],
    ['/drafts/correct', 'ingest.draft.correct'],
    ['/drafts/discard', 'ingest.draft.discard'],
    ['/drafts/checks', 'ingest.draft.checks'],
    ['/drafts/answer', 'ingest.draft.answer'],
    ['/drafts/confirm', 'ingest.draft.confirm'],
    ['/examples/add', 'ingest.example.add'],
    ['/examples/remove', 'ingest.example.remove'],
    ['/go-live', 'ingest.goLive'],
    ['/pause', 'ingest.pause'],
    ['/resume', 'ingest.resume'],
    ['/take-over', 'ingest.takeOver'],
    ['/redo', 'ingest.redo'],
    ['/turn-off', 'ingest.turnOff'],
  ];
  for (const [path, kind] of paths)
    app.post(
      `${base}${path}`,
      {
        ...session,
        // Two uploads may accompany one pair, with base64's encoding overhead and bounded metadata.
        bodyLimit: Math.ceil(SPREADSHEET_LIMITS.uploadBytes / 3) * 8 + 1024 * 1024,
      },
      async (request, reply) => {
        const actor = requireActor(request);
        refuseDemo(actor);
        const { tableId } = parse(z.object({ tableId: TableId }), request.params);
        const body = parse(z.record(z.string(), z.unknown()), request.body);
        const result = await runIngestSetupCommand(app, actor, {
          ...body,
          ...(kind ? { kind } : {}),
          tableId,
        });
        if (result.error) reply.code(statusFor(result.error.code));
        return result;
      },
    );
}
