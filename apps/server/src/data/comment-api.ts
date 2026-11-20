import { AppError, newId, type CommentCreate } from '@riosoma/contracts';
import type { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Actor } from '../http/policy.js';
import { AccessScope } from './access.js';
import { dataStore } from './context.js';
import { loadTable } from './metadata.js';
import { runCommands } from './commands/index.js';

export async function createComment(
  app: FastifyInstance,
  actor: Actor,
  tableId: string,
  recordId: string,
  comment: z.infer<typeof CommentCreate>,
) {
  const { pool, schemas } = dataStore(app.ctx);
  const table = await loadTable(pool, schemas, tableId);
  if (!table || table.trashed) throw new AppError('not_found', 'errors.notFound');
  const scope = new AccessScope(pool, schemas, actor);
  await scope.require(table.databaseId, 'comment');
  await scope.requireMachineUse(table.databaseId, tableId);
  const result = await runCommands(app, actor, table.databaseId, {
    clientId: newId('client'),
    commands: [
      { kind: 'comment.create', id: newId('command'), groupId: newId('action'), tableId, recordId, comment },
    ],
  });
  const failure = result.results.find((item) => item.status === 'rejected');
  if (failure?.error) throw new AppError(failure.error.code, failure.error.messageKey);
  return { commentId: comment.id };
}
