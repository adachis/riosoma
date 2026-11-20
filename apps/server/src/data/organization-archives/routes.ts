import type { Readable } from 'node:stream';
import {
  CopyJobId,
  OrganizationArchivePassphrase,
  OrganizationExportOptions,
  OrganizationImportOptions,
  OrganizationReviewInvite,
} from '@riosoma/contracts';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { requireActor } from '../../auth/sessions.js';
import { parse } from '../../http/validate.js';
import { OrganizationArchives } from './jobs.js';
import { ImportReview } from './review.js';

export async function organizationArchiveRoutes(app: FastifyInstance): Promise<void> {
  const jobs = new OrganizationArchives(app);
  const review = new ImportReview(app);
  app.ctx.organizationArchives = jobs;
  const session = { config: { policy: { kind: 'session' as const } } };
  const params = z.object({ id: CopyJobId });
  const reviewParams = z.object({ id: z.string().min(1).max(100) });
  app.addContentTypeParser('application/vnd.riosoma.organization', (_request, payload, done) =>
    done(null, payload),
  );
  // Nothing the server reads at startup comes from an archive, so no archive can stop it starting.
  app.addHook('onReady', async () => {
    await jobs.start();
  });
  app.addHook('onClose', async () => {
    await jobs.close();
  });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'private, no-store');
  });
  app.get('/api/organization-archives', session, async (request) => jobs.list(requireActor(request)));
  app.post('/api/organization-archives/export', session, async (request) =>
    jobs.export(requireActor(request), parse(OrganizationExportOptions, request.body)),
  );
  app.post('/api/organization-archives/import', session, async (request) =>
    jobs.upload(requireActor(request), request.body as Readable),
  );
  app.get('/api/organization-archives/review', session, async (request) => {
    const actor = requireActor(request);
    await jobs.owner(actor);
    return review.list(actor);
  });
  app.post('/api/organization-archives/review/invite', session, async (request) => {
    const actor = requireActor(request);
    await jobs.owner(actor);
    return review.invite(actor, parse(OrganizationReviewInvite, request.body).ids);
  });
  app.post('/api/organization-archives/review/:id/enable', session, async (request, reply) => {
    const actor = requireActor(request);
    await jobs.owner(actor);
    const controller = new AbortController();
    const close = () => controller.abort();
    reply.raw.once('close', close);
    try {
      return await review.enable(actor, parse(reviewParams, request.params).id, controller.signal);
    } finally {
      reply.raw.removeListener('close', close);
    }
  });
  app.post(
    '/api/organization-archives/review/:id/dismiss',
    {
      config: { policy: { kind: 'admin', area: 'ai', scope: 'organization' } },
    },
    async (request) => {
      const actor = requireActor(request);
      await jobs.owner(actor);
      return review.dismiss(actor, parse(reviewParams, request.params).id);
    },
  );
  app.get('/api/organization-archives/:id', session, async (request) =>
    jobs.get(requireActor(request), parse(params, request.params).id),
  );
  app.post('/api/organization-archives/:id/verify', session, async (request) =>
    jobs.verify(
      requireActor(request),
      parse(params, request.params).id,
      parse(OrganizationArchivePassphrase, request.body).passphrase,
    ),
  );
  app.post('/api/organization-archives/:id/confirm', session, async (request) =>
    jobs.confirm(
      requireActor(request),
      parse(params, request.params).id,
      parse(OrganizationImportOptions, request.body).passphrase,
    ),
  );
  app.get('/api/organization-archives/:id/download', session, async (request, reply) => {
    const stream = await jobs.download(requireActor(request), parse(params, request.params).id);
    reply.header('content-type', 'application/vnd.riosoma.organization');
    reply.header('content-disposition', 'attachment; filename="organization.rio"');
    reply.header('x-content-type-options', 'nosniff');
    // The archive uses an explicit binary type, attachment disposition, and nosniff.
    // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
    return reply.send(stream);
  });
  app.delete('/api/organization-archives/:id', session, async (request, reply) => {
    await jobs.delete(requireActor(request), parse(params, request.params).id);
    return reply.status(204).send();
  });
}
