import { refuseDemo } from '../demo/boundary.js';
import {
  AirtableToken,
  AppError,
  SYNC_OUT_LIMITS,
  newId,
  roleAllows,
  type OutboundDestination,
  type OutboundSyncCreate,
  type OutboundSyncUpdate,
  type SyncOutCommand,
  type SyncOutCommandResult,
  type SyncOutStatus,
} from '@riosoma/contracts';
import { afterCommit, ident, query, sql } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { auditEvent, authDatabase } from '../auth/database.js';
import { scopeOf } from '../data/commands/context.js';
import type { CommandContext } from '../data/commands/context.js';
import { runStored } from '../data/commands/transaction.js';
import { AccessScope } from '../data/access.js';
import { dataStore } from '../data/context.js';
import { loadTable, loadView } from '../data/metadata.js';
import { requirePolicy } from '../org-units/policy.js';
import { readsLive } from '../sources/live.js';
import { sealCredential } from '../credentials/service.js';
import { destinationFor } from './destination.js';
import { loadSync, settingsOf, statusOf, syncViewer, toOutboundSync, viewSyncCount } from './store.js';
import type { Actor } from '../http/policy.js';

/**
 * The commands that set up, change, delete, and start a sync.  Every change goes through the
 * command bus, so each command ID applies at most once, writes one audit event, and is refused the
 * same way on a repeat.  No command calls the destination: the first run does, and the preview has
 * already checked the token.
 */

const EMPTY_STATUS: SyncOutStatus = {
  state: 'queued',
  lastRunAt: null,
  lastSuccessAt: null,
  nextRunAt: null,
  error: null,
  stats: null,
  progress: null,
  withheld: [],
};

interface Stored {
  status: 'applied' | 'duplicate' | 'rejected';
  id: string;
  family: 'syncOut';
  syncId?: string;
  error?: ReturnType<AppError['toBody']>['error'];
}

const notFound = () => new AppError('not_found', 'errors.notFound');

function checkLocale(locale: string): void {
  try {
    new Intl.NumberFormat(locale);
    new Intl.DateTimeFormat(locale);
  } catch {
    throw new AppError('validation_failed', 'errors.validationFailed', {
      fields: { locale: 'errors.validationFailed' },
    });
  }
}

export async function runSyncOutCommand(
  app: FastifyInstance,
  actor: Actor,
  databaseId: string,
  command: SyncOutCommand,
): Promise<SyncOutCommandResult> {
  refuseDemo(actor);
  const result = await runStored<Stored>(
    app,
    actor,
    databaseId,
    {
      commandId: command.id,
      groupId: command.id,
      duplicate: (value) => {
        const stored = value as Stored;
        if (stored.family !== 'syncOut') throw notFound();
        return { ...stored, status: stored.error ? 'rejected' : 'duplicate' };
      },
      rejected: (error) => ({
        id: command.id,
        family: 'syncOut',
        status: 'rejected',
        error: error.toBody().error,
      }),
    },
    (c) => work(app, c, databaseId, command),
  );
  if (result.error)
    throw new AppError(result.error.code, result.error.messageKey, {
      params: result.error.params,
      fields: result.error.fields,
    });

  const { pool, schemas } = dataStore(app.ctx);
  const status = result.status as 'applied' | 'duplicate';
  if (!result.syncId) return { id: result.id, status, sync: null };
  const row = await loadSync(pool, schemas, result.syncId);
  if (!row) return { id: result.id, status, sync: null };
  const scope = new AccessScope(pool, schemas, actor);
  const role = await scope.databaseRole(row.database_id);
  await scope.prepare(row.database_id);
  const viewer = await syncViewer(pool, schemas, scope, row, role);
  return { id: result.id, status, sync: toOutboundSync(row, viewer) };
}

async function work(
  app: FastifyInstance,
  c: CommandContext,
  databaseId: string,
  command: SyncOutCommand,
): Promise<Stored> {
  const scope = await scopeOf(c);
  const applied = (syncId?: string): Stored => ({
    id: command.id,
    family: 'syncOut',
    status: 'applied',
    ...(syncId ? { syncId } : {}),
  });
  const audit = (action: string, facts: Record<string, unknown>) =>
    auditEvent(c.db, authDatabase(c.appContext!).audit, action, c.actor, facts);

  switch (command.action.kind) {
    case 'create': {
      const input = command.action.input;
      const id = await create(c, scope, databaseId, command.id, input, audit);
      afterCommit(c.db, () => void app.ctx.outboundSyncs?.tick());
      return applied(id);
    }
    case 'update':
      await update(c, scope, databaseId, command.id, command.action.syncId, command.action.input, audit);
      afterCommit(c.db, () => void app.ctx.outboundSyncs?.tick());
      return applied(command.action.syncId);
    case 'delete':
      await remove(c, scope, databaseId, command.id, command.action.syncId, audit);
      return applied(command.action.syncId);
    case 'run':
      await runNow(c, scope, databaseId, command.id, command.action.syncId, audit);
      afterCommit(c.db, () => void app.ctx.outboundSyncs?.tick());
      return applied(command.action.syncId);
  }
}

async function create(
  c: CommandContext,
  scope: AccessScope,
  databaseId: string,
  commandId: string,
  input: OutboundSyncCreate,
  audit: (action: string, facts: Record<string, unknown>) => Promise<void>,
): Promise<string> {
  const view = await loadView(c.db, c.schemas, input.viewId);
  if (!view || view.trashed || view.databaseId !== databaseId) throw notFound();
  await scope.require(databaseId, 'editSchema');
  if (c.actor.kind === 'guest') throw new AppError('forbidden', 'syncOut.unavailable.guest');
  await requirePolicy(c.db, `"${c.schemas.app}"`, c.actor, 'syncOut', 'externalSharing');
  const table = await loadTable(c.db, c.schemas, view.view.tableId);
  if (!table) throw notFound();
  if (view.view.type === 'form' || view.view.type === 'chart' || view.view.type === 'pivot')
    throw new AppError('validation_failed', 'syncOut.unavailable.viewType');
  if (readsLive(table)) throw new AppError('validation_failed', 'syncOut.unavailable.live');

  const dest = input.destination;
  if (!destinationFor(dest.kind)) throw new AppError('validation_failed', 'syncOut.destination.unknownKind');
  // Only a new table or sheet is supported today.  The contract carries "existing"; refuse it plainly.
  if (dest.table.mode !== 'new') throw new AppError('validation_failed', 'syncOut.target.newOnly');
  if ((await viewSyncCount(c.db, c.schemas, input.viewId)) >= SYNC_OUT_LIMITS.perView)
    throw new AppError('validation_failed', 'syncOut.limit.perView', {
      params: { limit: SYNC_OUT_LIMITS.perView },
    });
  if (dest.kind === 'airtable' && !AirtableToken.safeParse(input.credential.token).success)
    throw new AppError('validation_failed', 'errors.validationFailed', {
      fields: { token: 'syncOut.airtable.token' },
    });
  checkLocale(input.settings.locale);

  const id = newId('outboundSync');
  const destination: OutboundDestination =
    dest.kind === 'airtable'
      ? {
          kind: 'airtable',
          baseId: dest.baseId,
          baseName: dest.baseName,
          table: { id: null, name: dest.table.name, created: true, url: null },
        }
      : {
          kind: 'smartsheet',
          region: dest.region,
          table: { id: null, name: dest.table.name, created: true, url: null },
        };
  const sealed = await sealCredential(
    c.secretKey!,
    JSON.stringify(input.credential),
    `outbound-sync:${id}`,
    c.actor.orgId,
    c.db,
  );

  await query(
    c.db,
    sql`INSERT INTO ${ident(c.schemas.app, 'outbound_syncs')}
    (id, org_id, database_id, table_id, view_id, created_by, name, kind, destination, settings,
      sealed_credential, status, next_run_at, queued_trigger, queued_by, enabled, needs_reconcile)
    VALUES (${id}, ${c.actor.orgId}, ${databaseId}, ${view.view.tableId}, ${input.viewId}, ${c.actor.userId},
      ${input.name}, ${dest.kind}, ${JSON.stringify(destination)}::jsonb, ${JSON.stringify(input.settings)}::jsonb,
      ${sealed}, ${JSON.stringify(EMPTY_STATUS)}::jsonb, now(), 'setup', ${c.actor.userId}, true, true)`,
  );
  await audit('data.outboundSync.created', {
    syncId: id,
    databaseId,
    viewId: input.viewId,
    kind: dest.kind,
    commandId,
  });
  return id;
}

async function update(
  c: CommandContext,
  scope: AccessScope,
  databaseId: string,
  commandId: string,
  syncId: string,
  input: OutboundSyncUpdate,
  audit: (action: string, facts: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const sync = await loadSync(c.db, c.schemas, syncId, { lock: true });
  if (!sync || sync.org_id !== c.actor.orgId || sync.database_id !== databaseId) throw notFound();
  if (sync.created_by !== c.actor.userId) throw new AppError('forbidden', 'syncOut.edit.creatorOnly');
  await scope.require(databaseId, 'editSchema');
  await requirePolicy(c.db, `"${c.schemas.app}"`, c.actor, 'syncOut', 'externalSharing');

  const changed: string[] = [];
  const prev = settingsOf(sync);
  const settings = { ...prev };
  if (input.everyMinutes !== undefined && input.everyMinutes !== prev.everyMinutes) {
    settings.everyMinutes = input.everyMinutes;
    changed.push('everyMinutes');
  }
  if (input.removeMissing !== undefined && input.removeMissing !== prev.removeMissing) {
    settings.removeMissing = input.removeMissing;
    changed.push('removeMissing');
  }
  if (input.createColumns !== undefined && input.createColumns !== prev.createColumns) {
    settings.createColumns = input.createColumns;
    changed.push('createColumns');
  }
  const name = input.name ?? sync.name;
  if (input.name !== undefined && input.name !== sync.name) changed.push('name');

  const status = statusOf(sync);
  let enabled = sync.enabled;
  let stoppedBecause = sync.stopped_because;
  let failures = sync.failures;
  let nextRunAt: Date | null = sync.next_run_at;
  let queuedTrigger: string | null = sync.queued_trigger;
  let cancelRunning = false;
  let clearQueuedAgain = false;

  if (input.enabled === true) {
    enabled = true;
    stoppedBecause = null;
    failures = 0;
    status.state = 'queued';
    status.progress = null;
    nextRunAt = new Date();
    queuedTrigger = 'manual';
    changed.push('enabled');
  } else if (input.enabled === false) {
    enabled = false;
    status.state = 'idle';
    status.progress = null;
    nextRunAt = null;
    queuedTrigger = null;
    cancelRunning = true;
    clearQueuedAgain = true;
    changed.push('enabled');
  } else if (changed.includes('everyMinutes')) {
    // A changed schedule goes from the last run plus the interval, or stops when there's none.
    const base = status.lastRunAt ? new Date(status.lastRunAt) : new Date();
    nextRunAt =
      enabled && settings.everyMinutes ? new Date(base.getTime() + settings.everyMinutes * 60_000) : null;
  }

  await query(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, 'outbound_syncs')} SET name = ${name}, settings = ${JSON.stringify(settings)}::jsonb,
    enabled = ${enabled}, stopped_because = ${stoppedBecause}, failures = ${failures},
    status = ${JSON.stringify(status)}::jsonb, next_run_at = ${nextRunAt}, queued_trigger = ${queuedTrigger},
    ${clearQueuedAgain ? sql`queued_again = false,` : sql``} updated_at = now()
    WHERE id = ${syncId}`,
  );
  if (cancelRunning)
    await query(
      c.db,
      sql`UPDATE ${ident(c.schemas.app, 'outbound_sync_runs')} SET outcome = 'canceled', ended_at = now()
      WHERE sync_id = ${syncId} AND outcome = 'running'`,
    );
  await audit('data.outboundSync.updated', { syncId, commandId, changed });
}

async function remove(
  c: CommandContext,
  scope: AccessScope,
  databaseId: string,
  commandId: string,
  syncId: string,
  audit: (action: string, facts: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const sync = await loadSync(c.db, c.schemas, syncId, { lock: true });
  if (!sync || sync.org_id !== c.actor.orgId || sync.database_id !== databaseId) throw notFound();
  const role = await scope.databaseRole(databaseId);
  if (sync.created_by !== c.actor.userId && !roleAllows(role, 'manage'))
    throw new AppError('forbidden', 'syncOut.edit.creatorOnly');
  await query(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, 'outbound_sync_runs')} SET outcome = 'canceled', ended_at = now()
    WHERE sync_id = ${syncId} AND outcome = 'running'`,
  );
  await query(c.db, sql`DELETE FROM ${ident(c.schemas.app, 'outbound_syncs')} WHERE id = ${syncId}`);
  await audit('data.outboundSync.deleted', {
    syncId,
    databaseId,
    viewId: sync.view_id,
    kind: sync.kind,
    commandId,
  });
}

async function runNow(
  c: CommandContext,
  scope: AccessScope,
  databaseId: string,
  commandId: string,
  syncId: string,
  audit: (action: string, facts: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const sync = await loadSync(c.db, c.schemas, syncId, { lock: true });
  if (!sync || sync.org_id !== c.actor.orgId || sync.database_id !== databaseId) throw notFound();
  const role = await scope.databaseRole(databaseId);
  if (sync.created_by !== c.actor.userId && !roleAllows(role, 'editSchema'))
    throw new AppError('forbidden', 'syncOut.unavailable.role');
  await requirePolicy(c.db, `"${c.schemas.app}"`, c.actor, 'syncOut', 'externalSharing');
  if (!sync.enabled) throw new AppError('validation_failed', 'syncOut.run.off');
  await query(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, 'outbound_syncs')} SET
    queued_again = CASE WHEN lease_token IS NOT NULL THEN true ELSE queued_again END,
    queued_by = ${c.actor.userId}, queued_trigger = 'manual',
    next_run_at = CASE WHEN lease_token IS NULL THEN now() ELSE next_run_at END,
    status = CASE WHEN lease_token IS NULL THEN jsonb_set(status, '{state}', '"queued"') ELSE status END,
    updated_at = now()
    WHERE id = ${syncId}`,
  );
  await audit('data.outboundSync.requested', { syncId, commandId });
}
