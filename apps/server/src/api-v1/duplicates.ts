import { AppError, newId, type Command } from '@riosoma/contracts';
import type { FastifyInstance } from 'fastify';
import type { Actor } from '../http/policy.js';
import { dataStore } from '../data/context.js';
import { loadField, loadTable } from '../data/metadata.js';
import { AccessScope } from '../data/access.js';
import { parseCommand, runCommands } from '../data/commands/index.js';

export async function duplicateAction(app: FastifyInstance, actor: Actor, input: Record<string, unknown>) {
  const { pool, schemas } = dataStore(app.ctx);
  const source =
    input.kind === 'field.duplicate' ? await loadField(pool, schemas, String(input.fieldId)) : undefined;
  const table = await loadTable(pool, schemas, source?.tableId ?? String(input.tableId));
  if (!table || table.orgId !== actor.orgId || table.trashed)
    throw new AppError('not_found', 'errors.notFound');
  await new AccessScope(pool, schemas, actor).require(
    table.databaseId,
    input.kind === 'record.duplicate' ? 'editRecords' : 'editSchema',
  );
  const undoGroupId = newId('action');
  const command: Command = parseCommand({
    ...input,
    id: newId('command'),
    groupId: undoGroupId,
    ...(input.kind === 'field.duplicate' ? { newFieldId: newId('field') } : {}),
    ...(input.kind === 'table.duplicate' ? { newTableId: newId('table') } : {}),
  });
  const { results } = await runCommands(app, actor, table.databaseId, {
    clientId: newId('client'),
    commands: [command],
  });
  const result = results[0]!;
  if (result.status === 'rejected')
    throw new AppError(result.error!.code, result.error!.messageKey, { params: result.error!.params });
  return { ...result.output, undoGroupId };
}
