import { refuseDemo } from '../../demo/boundary.js';
import { z } from 'zod';
import { AppError, OrganizationBranding } from '@riosoma/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { dataStore } from '../context.js';
import { AccessScope } from '../access.js';
import { requireActor } from '../../auth/sessions.js';
import { parse } from '../../http/validate.js';
import { fileStorage } from '../files/storage.js';
import { organizationBranding } from './store.js';

const Key = z.object({ key: z.string().uuid() });
export async function brandingRoutes(app: FastifyInstance) {
  const session = { config: { policy: { kind: 'session' as const } } };
  const publicRoute = { config: { policy: { kind: 'public' as const } } };
  const send = (branding: OrganizationBranding | null, key: string, reply: FastifyReply) => {
    const asset = [branding?.logo?.main, branding?.logo?.compact].find((asset) => asset?.key === key);
    if (!asset) throw new AppError('not_found', 'errors.notFound');
    if (asset.storage === 's3' || asset.storage === 'azure-blob') refuseDemo();
    const { pool, schemas } = dataStore(app.ctx);
    reply
      .type(asset.type)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', 'attachment')
      .header(
        'Content-Security-Policy',
        "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
      )
      .header('Cross-Origin-Resource-Policy', 'same-origin')
      .header('Cache-Control', 'private, no-store');
    return reply.send(fileStorage(asset.storage, pool, schemas.app, app.ctx.config).read(asset.key));
  };
  app.get('/api/org/appearance', session, async (request) => {
    const { pool, schemas } = dataStore(app.ctx);
    return organizationBranding({ db: pool, schemas, actor: requireActor(request) });
  });
  app.get('/api/org/logo/:key', session, async (request, reply) => {
    const { pool, schemas } = dataStore(app.ctx);
    const branding = await organizationBranding({ db: pool, schemas, actor: requireActor(request) });
    return send(branding, parse(Key, request.params).key, reply);
  });
  app.get('/api/auth/logo/:key', publicRoute, async (request, reply) => {
    const { pool, schemas } = dataStore(app.ctx);
    const branding = OrganizationBranding.nullable().parse(
      await AccessScope.signInBranding(pool, schemas.app),
    );
    return send(branding, parse(Key, request.params).key, reply);
  });
}
