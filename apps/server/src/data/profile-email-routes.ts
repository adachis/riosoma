import { ChangeEmail, ConfirmEmail } from '@riosoma/contracts';
import type { FastifyInstance } from 'fastify';
import { requireActor } from '../auth/sessions.js';
import { parse } from '../http/validate.js';
import { runOrganizationCommand } from './commands/organization.js';

export async function profileEmailRoutes(app: FastifyInstance): Promise<void> {
  const personal = { config: { policy: { kind: 'session' as const } } };
  app.post('/api/me/profile/email', personal, (request) =>
    runOrganizationCommand(app, requireActor(request), {
      ...parse(ChangeEmail, request.body),
      kind: 'profile.email.request',
    }),
  );
  app.post('/api/me/profile/email/confirm', personal, (request) =>
    runOrganizationCommand(app, requireActor(request), {
      ...parse(ConfirmEmail, request.body),
      kind: 'profile.email.confirm',
    }),
  );
}
