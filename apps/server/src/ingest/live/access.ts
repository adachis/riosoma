import type { FastifyInstance } from 'fastify';
import { AppError, roleAllows } from '@riosoma/contracts';
import type { Queryable } from '@riosoma/db';
import type { Actor } from '../../http/policy.js';
import { dataStore } from '../../data/context.js';
import { loadTable } from '../../data/metadata.js';
import { scopeOf, type CommandContext } from '../../data/commands/context.js';
import { refuseDemo } from '../../demo/boundary.js';
import { requireEvidenceAccess } from '../setup/evidence.js';

export async function liveAccess(
  app: FastifyInstance,
  actor: Actor,
  tableId: string,
  db: Queryable = dataStore(app.ctx).pool,
  edit = false,
) {
  refuseDemo(actor);
  const { schemas } = dataStore(app.ctx);
  const table = await loadTable(db, schemas, tableId);
  if (!table || table.orgId !== actor.orgId || table.trashed)
    throw new AppError('not_found', 'errors.notFound');
  const c: CommandContext = {
    db,
    schemas,
    actor,
    databaseId: table.databaseId,
    appContext: app.ctx,
    fileConfig: app.ctx.config,
  };
  const scope = await scopeOf(c, tableId);
  const role = await scope.require(table.databaseId, 'read');
  if (!table.ingest) throw new AppError('conflict', 'ingest.live.notInMode');
  if (table.ingest.state === 'setup') throw new AppError('conflict', 'ingest.live.inSetup');
  if (edit && !roleAllows(role, 'editRecords')) throw new AppError('forbidden', 'ingest.live.editRequired');
  let evidence = true;
  try {
    await requireEvidenceAccess(c, tableId);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'forbidden') throw error;
    evidence = false;
  }
  return {
    c,
    table,
    evidence,
    schema: roleAllows(role, 'editSchema'),
    context: { orgId: actor.orgId, tableId },
  };
}
export type LiveAccess = Awaited<ReturnType<typeof liveAccess>>;
