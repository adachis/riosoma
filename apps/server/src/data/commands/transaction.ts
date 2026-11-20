import { refuseDemo } from '../../demo/boundary.js';
import { buildSourceChoiceIndex } from '../physical/indexes.js';
import type { StoredField } from '../types.js';
import { clearSelectOptionCache } from '../select-options.js';
import { validateSelectSchema } from './select-options.js';
import { refreshJoinedTables } from '../physical/joined.js';
import { refreshComputedOverrides } from '../physical/refresh-overrides.js';
import { queueEmbeddings } from '../embeddings.js';
import { validateRecords } from './validation.js';
import { loadFields, loadTable } from '../metadata.js';
import { uniqueViolation } from '../physical/unique.js';
import { AppError, newId, type ChangeBody } from '@riosoma/contracts';
import { afterCommit, compile, ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { auditEvent } from '../../auth/database.js';
import { queueTriggeredRuns } from '../../automations/triggers.js';
import { queueAiFieldRuns } from '../../ai-fields/queue.js';
import type { Actor } from '../../http/policy.js';
import { notifyChange } from '../../notifications/produce.js';
import { queueWebhookEvents } from '../../webhooks/events.js';
import { dataStore } from '../context.js';
import { changesChannel, homeChannel } from '../notify.js';
import { bumpVersion, type CommandContext, type Mutation } from './context.js';

export const LONG_DEADLINES = {
  queryTimeoutMs: 600_000,
  statementTimeoutMs: 600_000,
  lockTimeoutMs: 600_000,
};

export async function retry<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if ((code === '40P01' || code === '40001') && attempt < 3) continue;
      if (error instanceof AppError) throw error;
      throw new AppError('unavailable', 'errors.unavailable', { cause: error });
    }
  }
}

export async function lock(c: CommandContext, keys: string[]): Promise<void> {
  for (const key of [...new Set(keys)].sort()) {
    await query(c.db, sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${c.schemas.app}:${key}`}, 0))`);
  }
}

export function userError(error: unknown): AppError | null {
  const unique = uniqueViolation(error);
  if (unique) return unique;
  if (error instanceof AppError) return error.userFault ? error : null;
  if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
    if ('constraint' in error && error.constraint === 'fields_name')
      return new AppError('validation_failed', 'data.field.nameTaken');
    return new AppError('conflict', 'errors.conflict');
  }
  return null;
}

export async function runStored<T extends { status: 'applied' | 'duplicate' | 'nothing' | 'rejected' }>(
  app: FastifyInstance,
  actor: Actor,
  databaseId: string,
  options: {
    commandId: string;
    groupId: string;
    long?: boolean;
    lockKey?: string;
    transaction?: Queryable;
    duplicate: (value: unknown) => T;
    storedResult?: (result: T) => T;
    afterStore?: (c: CommandContext, result: T) => Promise<void>;
    rejected: (error: AppError) => T;
  },
  work: (c: CommandContext) => Promise<T>,
): Promise<T> {
  refuseDemo(actor);
  const { pool, schemas } = dataStore(app.ctx);
  const workInTransaction = async (db: Queryable) => {
    const c: CommandContext = {
      appContext: app.ctx,
      secretKey: app.ctx.config.secretKey,
      fileConfig: app.ctx.config,
      db,
      schemas,
      actor,
      databaseId,
    };
    // The database lock also protects constraints that span metadata and physical tables.
    await lock(c, [
      `command:${options.commandId}`,
      options.lockKey ?? `database:${databaseId}`,
      `group:${options.groupId}`,
    ]);
    const previous = await query<{
      actor_id: string;
      org_id: string;
      database_id: string;
      result: unknown;
    }>(
      db,
      sql`SELECT actor_id, org_id, database_id, result FROM ${ident(schemas.app, 'commands')} WHERE id = ${options.commandId}`,
    );
    const stored = previous.rows[0];
    if (stored) {
      if (
        stored.actor_id !== actor.userId ||
        stored.org_id !== actor.orgId ||
        stored.database_id !== databaseId
      )
        throw new AppError('not_found', 'errors.notFound');
      return options.duplicate(stored.result);
    }
    await query(db, sql`SAVEPOINT command_work`);
    let result: T;
    try {
      result = await work(c);
    } catch (error) {
      const rejection = userError(error);
      if (!rejection) throw error;
      await query(db, sql`ROLLBACK TO SAVEPOINT command_work`);
      result = options.rejected(rejection);
    }
    if (result.status === 'applied' && c.sourceChoiceTables?.size) {
      const sources = [...c.sourceChoiceTables];
      afterCommit(db, () => {
        for (const tableId of sources)
          void buildSourceChoiceIndex(pool, schemas, tableId).catch((error: unknown) => {
            app.log.warn({ err: error, tableId }, 'Source choice index could not be built');
          });
      });
    }
    if (result.status === 'applied' && c.sourceSyncTables?.size) {
      const tables = [...c.sourceSyncTables];
      afterCommit(db, () => {
        for (const tableId of tables) app.ctx.sourceScheduler?.wake(tableId);
      });
    }
    await query(db, sql`RELEASE SAVEPOINT command_work`);
    await query(
      db,
      sql`INSERT INTO ${ident(schemas.app, 'commands')} (id, org_id, actor_id, database_id, status, result)
      VALUES (${options.commandId}, ${actor.orgId}, ${actor.userId}, ${databaseId},
        ${result.status === 'rejected' ? 'rejected' : 'applied'}, ${JSON.stringify(options.storedResult?.(result) ?? result)}::jsonb)`,
    );
    await options.afterStore?.(c, result);
    return result;
  };
  if (options.transaction) return workInTransaction(options.transaction);
  return retry(() => withTransaction(pool, workInTransaction, options.long ? LONG_DEADLINES : undefined));
}

export async function ensureGroup(c: CommandContext, groupId: string): Promise<void> {
  const group = await query<{ database_id: string; actor_id: string; state: string }>(
    c.db,
    sql`SELECT database_id, actor_id, state FROM ${ident(c.schemas.app, 'undo_groups')} WHERE group_id = ${groupId}`,
  );
  const existing = group.rows[0];
  if (existing) {
    if (existing.database_id !== c.databaseId) throw new AppError('not_found', 'errors.notFound');
    if (existing.actor_id !== c.actor.userId) throw new AppError('forbidden', 'data.access.denied');
    if (existing.state !== 'done') throw new AppError('conflict', 'errors.conflict');
    return;
  }
  await query(
    c.db,
    sql`INSERT INTO ${ident(c.schemas.app, 'undo_groups')} (group_id, database_id, actor_id, state)
    VALUES (${groupId}, ${c.databaseId}, ${c.actor.userId}, 'done')`,
  );
}

function tableIdOf(body: ChangeBody): string | null {
  if ('comment' in body) return body.comment.tableId;
  if ('tableId' in body) return body.tableId;
  if ('table' in body) return body.table.id;
  if ('field' in body) return body.field.tableId;
  if ('view' in body) return body.view.tableId;
  return null;
}

export async function recordChange(
  c: CommandContext,
  mutation: Mutation,
  ids: {
    commandId: string;
    groupId: string;
    clientId: string | null;
    system?: boolean;
    undoOf?: string;
    redoOf?: string;
  },
): Promise<number> {
  const { body, prev } = mutation;
  const originDatabaseId = c.databaseId;
  const changeSequences = (c.changeSequences ??= new Map());
  const tableId = tableIdOf(body);
  if (tableId) {
    const parent = await loadTable(c.db, c.schemas, tableId);
    if (!parent || parent.orgId !== c.actor.orgId) throw new AppError('not_found', 'errors.notFound');
    if (parent.databaseId !== c.databaseId) c = { ...c, databaseId: parent.databaseId };
  }
  clearSelectOptionCache(c.scope);
  // Staging progress leaves committed rows and navigation unchanged.
  if (body.kind !== 'table.updated' || !body.syncProgress) {
    await queueEmbeddings(c.db, c.schemas, c.databaseId, body);
    if (
      ['database.', 'view.', 'dashboard.', 'interface.', 'table.'].some((kind) => body.kind.startsWith(kind))
    )
      await query(c.db, sql`SELECT pg_notify(${homeChannel(c.schemas)}, ${c.actor.orgId})`);
  }
  if (tableId && body.kind.startsWith('field.') && 'field' in body)
    await validateSelectSchema(c, tableId, body.field.id, prev.field as StoredField | undefined);
  if (ids.system && (body.kind === 'record.created' || body.kind === 'record.updated')) {
    const fields = await loadFields(c.db, c.schemas, [body.tableId]);
    const touched = new Set(body.records.flatMap((row) => Object.keys(row.values)));
    const cascades = fields.filter(
      (field) =>
        (field.type === 'singleSelect' || field.type === 'multipleSelect') &&
        field.options.cascade &&
        (touched.has(field.id) || touched.has(field.options.cascade.fieldId)),
    );
    for (const child of cascades) {
      if ((child.type !== 'singleSelect' && child.type !== 'multipleSelect') || !child.options.cascade)
        continue;
      const parentId = child.options.cascade.fieldId;
      const records = body.records.filter(
        (row) => Object.hasOwn(row.values, child.id) || Object.hasOwn(row.values, parentId),
      );
      await validateRecords(
        c,
        body.tableId,
        fields
          .filter((field) => field.id === child.id || field.id === parentId)
          .map(
            (field) =>
              ({
                ...field,
                options: {
                  ...field.options,
                  validation: undefined,
                  ...(field.id === parentId ? { cascade: undefined } : {}),
                },
              }) as StoredField,
          ),
        records,
        true,
        [],
        true,
      );
    }
  }
  const metadata: Record<string, unknown> = { databaseId: c.databaseId };
  if (tableId) metadata.tableId = tableId;
  if ('field' in body) metadata.fieldId = body.field.id;
  if ('fieldId' in body) metadata.fieldId = body.fieldId;
  if ('view' in body) metadata.viewId = body.view.id;
  if ('viewId' in body) metadata.viewId = body.viewId;
  if ('dashboard' in body) metadata.dashboardId = body.dashboard.id;
  if ('dashboardId' in body) metadata.dashboardId = body.dashboardId;
  if ('interface' in body) metadata.interfaceId = body.interface.id;
  if ('interfaceId' in body) metadata.interfaceId = body.interfaceId;
  if ('script' in body) metadata.scriptId = body.script.id;
  if ('scriptId' in body) metadata.scriptId = body.scriptId;
  if (body.kind === 'namedFunction.changed') {
    metadata.functionId = body.functionId;
    metadata.revision = body.definition?.revision;
    metadata.operation = !body.definition ? 'delete' : prev.namedFunction ? 'update' : 'create';
  }
  if ('automation' in body) metadata.automationId = body.automation.id;
  if ('automationId' in body) metadata.automationId = body.automationId;
  if (body.kind === 'automation.runCanceled' || body.kind === 'button.ran') metadata.runId = body.runId;
  // Changes an automation makes say so, alongside the person it acts as.
  if (c.actor.automation) {
    metadata.automationId = c.actor.automation.id;
    metadata.runId = c.actor.automation.runId;
  }
  // So do changes a script makes from the panel, as the person running it.
  if (c.actor.script) {
    metadata.scriptId = c.actor.script.id;
    metadata.scriptRunId = c.actor.script.runId;
    if (c.actor.script.button) metadata.button = c.actor.script.button;
  }
  // And values an AI field's model wrote, as the field's person.
  if (c.actor.aiField) {
    metadata.aiFieldId = c.actor.aiField.id;
    metadata.aiFieldRunId = c.actor.aiField.runId;
  }
  // And changes a routine's run makes, as the routine's owner.  What a run changes on its own sets
  // nothing else off (no automation, AI field, webhook, or canceled signature request), which the
  // entry says, and a plan its owner approved acts as the owner's own change would.
  if (c.actor.routine) {
    metadata.routineId = c.actor.routine.id;
    metadata.routineRunId = c.actor.routine.runId;
    if (c.actor.routine.approved) metadata.routineApproved = true;
    else metadata.sideEffectsSkipped = 'routineRun';
  }
  // And changes a webhook's post makes, as the person its table writes as.
  if (c.actor.source) {
    metadata.sourceId = c.actor.source.id;
    metadata.deliveryId = c.actor.source.deliveryId;
  }
  if (body.kind === 'record.linksChanged')
    await validateRecords(
      c,
      body.tableId,
      await loadFields(c.db, c.schemas, [body.tableId]),
      body.records.map((row) => ({ id: row.id, values: {} })),
      true,
    );
  const isRecordChange = body.kind.startsWith('record.');
  if (isRecordChange) {
    metadata.count =
      'records' in body ? body.records.length : 'recordIds' in body ? body.recordIds.length : 0;
    await bumpVersion(c, tableId!);
  }
  if (c.origin) metadata.origin = c.origin;
  if (ids.undoOf) metadata.undoOf = ids.undoOf;
  if (ids.redoOf) metadata.redoOf = ids.redoOf;
  if (ids.system && body.kind === 'table.synced')
    await query(
      c.db,
      sql`INSERT INTO ${ident(c.schemas.audit, 'events')} (org_id, actor_id, action, metadata)
      VALUES (${c.actor.orgId}, NULL, 'data.table.synced', ${JSON.stringify({ ...metadata, ...body.stats })}::jsonb)`,
    );
  if (!ids.system && (body.kind !== 'record.linksChanged' || c.databaseId !== originDatabaseId)) {
    const action = `data.${isRecordChange ? body.kind.replace('record.', 'records.') : body.kind}`;
    if (c.deferredAudit) c.deferredAudit.push({ action, metadata });
    else await auditEvent(c.db, compile(sql`${ident(c.schemas.audit)}`).text, action, c.actor, metadata);
  }
  // Keep the sequence row lock through commit: later sequences cannot commit ahead of this one.
  const sequence = await query<{ change_seq: string }>(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, 'databases')}
    SET change_seq = change_seq + 1, updated_at = statement_timestamp() WHERE id = ${c.databaseId} RETURNING change_seq`,
  );
  const seq = Number(sequence.rows[0]!.change_seq);
  changeSequences.set(c.databaseId, seq);
  await query(
    c.db,
    sql`INSERT INTO ${ident(c.schemas.app, 'changes')}
    (database_id, seq, org_id, table_id, command_id, group_id, actor_id, client_id, kind, body, prev, undo_of, redo_of, origin)
    VALUES (${c.databaseId}, ${seq}, ${c.actor.orgId}, ${tableId}, ${ids.commandId}, ${ids.groupId},
      ${ids.system ? null : c.actor.userId}, ${ids.clientId}, ${body.kind}, ${JSON.stringify(body)}::jsonb, ${JSON.stringify(prev)}::jsonb,
      ${ids.undoOf ?? null}, ${ids.redoOf ?? null}, ${JSON.stringify(c.origin ?? null)}::jsonb)`,
  );
  // A sync run's place in the sequence is what puts the values it changed in a record's history.
  if (mutation.syncRunId)
    await query(
      c.db,
      sql`UPDATE ${ident(c.schemas.app, 'sync_runs')} SET seq = ${seq} WHERE id = ${mutation.syncRunId}`,
    );
  const recordIds =
    body.kind === 'record.trashed' || body.kind === 'record.locksChanged'
      ? body.recordIds
      : body.kind === 'record.created' ||
          body.kind === 'record.updated' ||
          body.kind === 'record.restored' ||
          body.kind === 'table.created'
        ? body.records.map((record) => record.id)
        : [];
  if (recordIds.length) {
    await query(
      c.db,
      sql`INSERT INTO ${ident(c.schemas.app, 'record_changes')}
      (database_id, table_id, record_id, seq)
      SELECT ${c.databaseId}, ${tableId}, id, ${seq} FROM unnest(${recordIds}::text[]) AS r(id)
      ON CONFLICT DO NOTHING`,
    );
  }
  await queueTriggeredRuns(c, mutation);
  // AI fields whose prompts read a changed value queue their runs with the change, too.
  await queueAiFieldRuns(c, mutation);
  // Mentions are told in this transaction, so they commit or roll back with the comment.
  await notifyChange(c, body);
  await queueWebhookEvents(c, body, seq);
  await query(
    c.db,
    sql`SELECT pg_notify(${changesChannel(c.schemas)}, ${JSON.stringify({ databaseId: c.databaseId, seq })})`,
  );
  for await (const extra of mutation.additional ?? [])
    await recordChange(mutation.refreshJoined ? { ...c, refreshingDerived: true } : c, extra, ids);
  if (
    !c.refreshingDerived &&
    (mutation.refreshJoined ||
      isRecordChange ||
      body.kind === 'table.synced' ||
      body.kind.startsWith('field.') ||
      body.kind === 'namedFunction.changed' ||
      body.kind === 'table.created' ||
      body.kind === 'table.trashed' ||
      body.kind === 'table.restored')
  ) {
    c.refreshingDerived = true;
    try {
      for await (const extra of refreshComputedOverrides(c))
        await recordChange(c, extra, {
          commandId: newId('command'),
          groupId: newId('action'),
          clientId: null,
          system: true,
        });
      // Only the joins this table's values can reach are rebuilt, and without one, all of them are.
      for await (const extra of refreshJoinedTables(c, tableId ? new Set([tableId]) : null))
        await recordChange(c, extra, {
          commandId: newId('command'),
          groupId: newId('action'),
          clientId: null,
          system: true,
        });
      for await (const extra of refreshComputedOverrides(c))
        await recordChange(c, extra, {
          commandId: newId('command'),
          groupId: newId('action'),
          clientId: null,
          system: true,
        });
    } finally {
      c.refreshingDerived = false;
    }
  }
  return changeSequences.get(originDatabaseId) ?? seq;
}
