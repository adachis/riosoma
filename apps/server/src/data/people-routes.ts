import { z } from 'zod';
import {
  ChangeMemberRole,
  ChangeMemberStatus,
  ProfileUpdate,
  TransferOwnership,
  UserId,
} from '@riosoma/contracts';
import type { FastifyInstance } from 'fastify';
import { requireActor } from '../auth/sessions.js';
import { parse } from '../http/validate.js';
import { dataStore } from './context.js';
import { memberAccess, personPicture, profile } from './people.js';
import { scope, type AdminContext } from './organization-admin/store.js';
import { runOrganizationCommand } from './commands/organization.js';
import { fileStorage } from './files/storage.js';
import { withOwnershipProof } from '../auth/ownership-proof.js';
import { profileEmailRoutes } from './profile-email-routes.js';

const Person = z.object({ userId: UserId });
const admin = {
  config: { policy: { kind: 'admin' as const, area: 'people' as const, scope: 'person' as const } },
};
const personal = {
  config: { policy: { kind: 'session' as const, beforeBody: true as const } },
  bodyLimit: 3_100_000,
};

export async function peopleRoutes(app: FastifyInstance): Promise<void> {
  await app.register(profileEmailRoutes);
  const context = (actor: AdminContext['actor']): AdminContext => {
    const { pool, schemas } = dataStore(app.ctx);
    return { db: pool, schemas, actor };
  };
  app.get('/api/me/profile', personal, (request) =>
    profile(context(requireActor(request)), app.ctx.config, Boolean(app.ctx.mailer)),
  );
  app.patch('/api/me/profile', personal, async (request) =>
    runOrganizationCommand(app, requireActor(request), {
      ...parse(ProfileUpdate, request.body),
      kind: 'profile.update',
    }),
  );
  app.post('/api/me/profile/undo', personal, (request) =>
    runOrganizationCommand(
      app,
      requireActor(request),
      {
        kind: 'organization.undo',
        ...parse(z.object({ eventId: z.string().regex(/^[1-9][0-9]{0,18}$/) }).strict(), request.body),
      },
      { profileUndo: true },
    ),
  );
  app.get('/api/people/:userId/picture', personal, async (request, reply) => {
    const c = context(requireActor(request));
    const { userId } = parse(Person, request.params);
    const key = await personPicture(c, userId);
    reply
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', 'inline; filename="profile.png"')
      .type('image/png');
    // Only normalized PNG bytes are served, after the same person visibility check as the directory.
    // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
    return reply.send(fileStorage('postgres', c.db, c.schemas.app, app.ctx.config).read(key));
  });
  app.get('/api/org/members/:userId/access', admin, async (request) => {
    const c = context(requireActor(request));
    const { userId } = parse(Person, request.params);
    return memberAccess(c, userId);
  });
  app.patch('/api/org/members/:userId/role', admin, (request) =>
    runOrganizationCommand(app, requireActor(request), {
      kind: 'people.role',
      userId: parse(Person, request.params).userId,
      ...parse(ChangeMemberRole, request.body),
    }),
  );
  app.patch('/api/org/members/:userId/status', admin, (request) =>
    runOrganizationCommand(app, requireActor(request), {
      kind: 'people.status',
      userId: parse(Person, request.params).userId,
      ...parse(ChangeMemberStatus, request.body),
    }),
  );
  app.post('/api/org/members/:userId/undo', admin, (request) =>
    runOrganizationCommand(
      app,
      requireActor(request),
      {
        kind: 'organization.undo',
        ...parse(z.object({ eventId: z.string().regex(/^[1-9][0-9]{0,18}$/) }).strict(), request.body),
      },
      { undoPerson: parse(Person, request.params).userId },
    ),
  );
  app.post('/api/org/members/:userId/transfer-ownership', admin, async (request, reply) => {
    const actor = requireActor(request);
    const userId = parse(Person, request.params).userId;
    const input = parse(TransferOwnership, request.body ?? {});
    await scope(context(actor)).requireOrganizationAdmin('people', true);
    return withOwnershipProof(app.ctx, request, reply, actor, input, (db) =>
      runOrganizationCommand(
        app,
        actor,
        { kind: 'people.transfer', userId },
        { db, ownershipVerified: true },
      ),
    );
  });
}
