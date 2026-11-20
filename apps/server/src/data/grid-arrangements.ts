import { AppError, newId, type GridArrangementPatch } from '@riosoma/contracts';
import type { FastifyInstance } from 'fastify';
import type { Actor } from '../http/policy.js';
import { AccessScope } from './access.js';
import { runCommands } from './commands/index.js';
import { dataStore } from './context.js';
import { loadView } from './metadata.js';

/** API and tool writes share the app's authorization, history, and realtime path. */
export async function arrangeGrid(
  app: FastifyInstance,
  actor: Actor,
  viewId: string,
  change: { config: GridArrangementPatch },
) {
  const { pool, schemas } = dataStore(app.ctx);
  const target = await loadView(pool, schemas, viewId);
  if (!target || target.trashed) throw new AppError('not_found', 'errors.notFound');
  // Access comes first, so someone outside the database can't learn a view's kind from the answer.
  await new AccessScope(pool, schemas, actor).require(target.databaseId, 'editSchema');
  // Pins, column groups, and header colors are a grid's arrangement, so another kind of view has
  // no use for them and never reorders or freezes around them.
  if (target.view.type !== 'grid') throw new AppError('validation_failed', 'data.view.gridOnly');
  return runCommands(app, actor, target.databaseId, {
    clientId: newId('client'),
    commands: [
      {
        id: newId('command'),
        groupId: newId('action'),
        viewId,
        kind: 'view.update',
        config: change.config,
      },
    ],
  });
}
