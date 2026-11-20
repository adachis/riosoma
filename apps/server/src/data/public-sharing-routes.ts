import { AppError, PublicEmbedTarget, SharedViewId } from '@riosoma/contracts';
import type { FastifyInstance } from 'fastify';
import { requireActor } from '../auth/sessions.js';
import { livePage } from '../bookings/public.js';
import { sendShell } from '../http/shell.js';
import { parse } from '../http/validate.js';
import { AccessScope } from './access.js';
import { runPublicSharingCommand } from './commands/public-sharing.js';
import { dataStore } from './context.js';
import { loadLiveForm, publicDefinition } from './public-forms.js';
import { editableFormFiles } from './public-form-files.js';
import { editableEmbed, publicSharingPolicy, storedEmbed } from './public-sharing.js';
import { frameHeaders } from './shared-view-routes.js';

export async function publicSharingRoutes(app: FastifyInstance) {
  const session = { config: { policy: { kind: 'session' as const } } };
  const admin = {
    config: { policy: { kind: 'admin' as const, area: 'security' as const, scope: 'organization' as const } },
  };
  app.get('/api/admin/public-sharing', admin, async (request) => {
    const { pool, schemas } = dataStore(app.ctx);
    const actor = requireActor(request);
    await new AccessScope(pool, schemas, actor).requireOrganization();
    return publicSharingPolicy(pool, schemas, actor.orgId);
  });
  app.post('/api/public-sharing/commands', session, (request) =>
    runPublicSharingCommand(app, requireActor(request), request.body),
  );
  app.get('/api/public-sharing/form/:linkId/files', session, async (request) => {
    const linkId = parse(SharedViewId, (request.params as { linkId: string }).linkId);
    const { pool, schemas } = dataStore(app.ctx);
    return editableFormFiles(pool, schemas, requireActor(request), linkId);
  });
  app.get('/api/public-sharing/:kind/:linkId', session, async (request) => {
    const target = parse(PublicEmbedTarget, request.params);
    const { pool, schemas } = dataStore(app.ctx);
    const row = await editableEmbed(pool, schemas, requireActor(request), target);
    const policy = await publicSharingPolicy(pool, schemas, row.org_id);
    return { embed: row.embed, embeddingEnabled: policy.embeddingEnabled };
  });
  for (const [prefix, kind] of [
    ['f', 'form'],
    ['b', 'booking'],
  ] as const) {
    app.get(`/${prefix}/:linkId`, async (request, reply) => {
      let embed = null;
      const parsed = SharedViewId.safeParse((request.params as { linkId: string }).linkId);
      if (parsed.success && app.ctx.pool && app.ctx.config.database) {
        try {
          const { pool, schemas } = dataStore(app.ctx);
          let orgId: string;
          if (kind === 'form') {
            await publicDefinition(app.ctx, parsed.data);
            orgId = (await loadLiveForm(pool, schemas, parsed.data)).orgId;
          } else orgId = (await livePage(pool, schemas, parsed.data)).row.org_id;
          const policy = await publicSharingPolicy(pool, schemas, orgId);
          if (policy.embeddingEnabled)
            embed = (await storedEmbed(pool, schemas, { kind, linkId: parsed.data })).embed;
        } catch (error) {
          if (!(error instanceof AppError))
            request.log.warn({ err: error }, 'public page frame lookup failed');
        }
      }
      frameHeaders(reply, embed);
      reply.header('cache-control', 'no-store');
      if (typeof reply.sendFile !== 'function')
        return reply.status(404).send(new AppError('not_found', 'errors.notFound').toBody());
      return sendShell(reply, request.customDomain ? app.ctx.publicPageHtml!() : app.ctx.appPageHtml!());
    });
  }
}
