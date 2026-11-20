import type { Readable } from 'node:stream';
import { AppError } from '@riosoma/contracts';
import { driversDirectory } from '@riosoma/connectors';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { auditEvent, authDatabase } from '../auth/database.js';
import { requireActor } from '../auth/sessions.js';
import { parse } from '../http/validate.js';
import { MAX_DRIVER_BYTES, tooLarge } from './archive.js';
import { DriverInstaller } from './installer.js';

const Params = z.object({ driverId: z.enum(['teradatasql', 'ibm_db']) });
const UploadParams = Params.extend({ artifactId: z.string().regex(/^[a-z0-9_-]{1,100}$/) });
const Install = z
  .object({
    licenseHash: z.string().regex(/^[a-f0-9]{64}$/),
    catalogHash: z.string().regex(/^[a-f0-9]{64}$/),
    offline: z.boolean().optional(),
  })
  .strict();
const ARCHIVE_TYPE = 'application/octet-stream';

export async function driverRoutes(app: FastifyInstance): Promise<void> {
  // Drivers belong to the server, so installing them is for the organization's own admins.
  const config = {
    policy: { kind: 'admin' as const, area: 'data_sources' as const, scope: 'organization' as const },
  };
  // A route that takes a body admits its caller as the request arrives, before any of it is read.
  const beforeBody = { policy: { ...config.policy, beforeBody: true as const } };
  const directory = driversDirectory(app.ctx.config.driversDir);
  const enabled = () => app.ctx.config.driverInstalls !== false;
  const installer = (request: FastifyRequest) => {
    const actor = requireActor(request);
    const { pool, audit } = authDatabase(app.ctx);
    return new DriverInstaller(directory, enabled(), (action, metadata) =>
      auditEvent(pool, audit, action, actor, metadata),
    );
  };
  const refuseWhenOff = () => {
    if (!enabled()) throw new AppError('forbidden', 'sources.drivers.disabled');
  };
  /**
   * Runs a route's own checks as its request arrives.  A refusal ends the connection with its answer,
   * as the sign-in check before it does, so Node never reads the body only to throw it away.
   */
  const beforeReading =
    (check: (request: FastifyRequest) => void) => async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        check(request);
      } catch (error) {
        reply.header('connection', 'close');
        throw error;
      }
    };

  // An uploaded archive reaches its route as the stream it arrives on, never as one buffered body.
  app.addContentTypeParser(ARCHIVE_TYPE, (_request, payload, done) => done(null, payload));
  // What a crash left in driver storage goes before the server takes requests.
  app.addHook('onReady', async () => {
    try {
      await new DriverInstaller(directory, enabled(), async () => undefined).cleanup();
    } catch (error) {
      app.log.warn(
        { errorCode: (error as NodeJS.ErrnoException).code ?? null },
        'driver storage could not be cleaned up',
      );
    }
  });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.get('/api/source-drivers', { config }, async () =>
    new DriverInstaller(directory, enabled(), async () => undefined).list(),
  );
  app.post(
    '/api/source-drivers/:driverId/install',
    { config: beforeBody, onRequest: beforeReading(refuseWhenOff) },
    async (request) => {
      const { driverId } = parse(Params, request.params);
      return installer(request).install(driverId, parse(Install, request.body));
    },
  );
  app.put(
    '/api/source-drivers/:driverId/uploads/:artifactId',
    {
      config: beforeBody,
      onRequest: beforeReading((request) => {
        refuseWhenOff();
        const type = String(request.headers['content-type'] ?? '')
          .split(';')[0]!
          .trim()
          .toLowerCase();
        if (type !== ARCHIVE_TYPE) throw new AppError('bad_request', 'errors.badRequest');
        if (Number(request.headers['content-length'] ?? 0) > MAX_DRIVER_BYTES) throw tooLarge();
      }),
    },
    async (request, reply) => {
      const { driverId, artifactId } = parse(UploadParams, request.params);
      const body = request.body as Readable | undefined;
      const length = request.headers['content-length'];
      try {
        if (typeof body?.iterator !== 'function')
          throw new AppError('validation_failed', 'sources.drivers.archiveInvalid');
        await installer(request).upload(
          driverId,
          artifactId,
          body,
          length === undefined ? undefined : Number(length),
        );
      } catch (error) {
        // What's left of a refused archive stays unread, and the connection ends with the answer.
        reply.header('connection', 'close');
        throw error;
      }
      return reply.code(204).send();
    },
  );
  app.delete('/api/source-drivers/:driverId', { config }, async (request, reply) => {
    const { driverId } = parse(Params, request.params);
    await installer(request).remove(driverId);
    return reply.code(204).send();
  });
}
