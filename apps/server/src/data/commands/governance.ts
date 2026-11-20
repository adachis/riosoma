import { refuseDemo } from '../../demo/boundary.js';
import { isDeepStrictEqual } from 'node:util';
import {
  AppError,
  ClassificationLabels,
  GovernanceAction,
  GovernanceCommand,
  type GovernanceResult,
} from '@riosoma/contracts';
import { compile, ident, query, sql } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { auditEvent } from '../../auth/database.js';
import type { Actor } from '../../http/policy.js';
import { parse } from '../../http/validate.js';
import { AccessScope } from '../access.js';
import { governanceView } from '../governance.js';
import { loadField, loadTable } from '../metadata.js';
import { accessChannel, homeChannel } from '../notify.js';
import type { CommandContext } from './context.js';
import { lock, runStored } from './transaction.js';

type Stored = GovernanceResult & { before?: GovernanceAction; after?: GovernanceAction };
const databaseOf = (action: GovernanceAction) =>
  action.kind === 'classification.assign'
    ? action.target.databaseId
    : action.kind === 'retention.set'
      ? action.databaseId
      : null;

async function authorize(c: CommandContext, action: GovernanceAction) {
  const scope = new AccessScope(c.db, c.schemas, c.actor);
  await scope.requireOrganizationAdmin('security');
  const databaseId = databaseOf(action);
  if (databaseId) {
    await lock(c, [`database:${databaseId}`]);
    await scope.requireGovernanceDatabase(databaseId);
  }
  if (action.kind === 'classification.assign') {
    const target = action.target;
    const table =
      target.kind === 'table'
        ? await loadTable(c.db, c.schemas, target.tableId)
        : target.kind === 'field'
          ? await loadField(c.db, c.schemas, target.fieldId).then((field) =>
              field ? loadTable(c.db, c.schemas, field.tableId) : null,
            )
          : null;
    if (
      target.kind !== 'database' &&
      (!table || table.databaseId !== target.databaseId || table.orgId !== c.actor.orgId)
    )
      throw new AppError('not_found', 'errors.notFound');
  }
  return scope;
}

async function current(
  c: CommandContext,
  action: GovernanceAction,
  scope: AccessScope,
): Promise<GovernanceAction> {
  const view = await governanceView(scope, c.db, c.schemas, databaseOf(action) ?? undefined);
  if (action.kind === 'classification.labels') return { ...action, labels: view.labels };
  if (action.kind === 'retention.set') return { ...action, policy: view.policy, legalHold: view.legalHold };
  const assignment = view.assignments.find((item) => isDeepStrictEqual(item.target, action.target));
  if (!assignment) throw new AppError('not_found', 'errors.notFound');
  return { ...action, labelId: assignment.labelId };
}

async function write(c: CommandContext, action: GovernanceAction) {
  const { db, schemas, actor } = c;
  if (action.kind === 'classification.labels') {
    const ids = action.labels.map((label) => label.id);
    const used = await query(
      db,
      sql`SELECT 1 FROM (
      SELECT classification_label FROM ${ident(schemas.app, 'databases')} WHERE org_id = ${actor.orgId}
      UNION ALL SELECT t.classification_label FROM ${ident(schemas.app, 'tables')} t WHERE t.org_id = ${actor.orgId}
      UNION ALL SELECT f.classification_label FROM ${ident(schemas.app, 'fields')} f
        JOIN ${ident(schemas.app, 'tables')} t ON t.id = f.table_id WHERE t.org_id = ${actor.orgId}
    ) labels WHERE classification_label IS NOT NULL AND NOT (classification_label = ANY(${ids}::text[])) LIMIT 1`,
    );
    if (used.rowCount) throw new AppError('conflict', 'governance.labelInUse');
    await query(
      db,
      sql`UPDATE ${ident(schemas.app, 'orgs')} SET classification_labels = ${JSON.stringify(action.labels)}::jsonb WHERE id = ${actor.orgId}`,
    );
  } else if (action.kind === 'classification.assign') {
    const labels = await query<{ classification_labels: unknown }>(
      db,
      sql`SELECT classification_labels FROM ${ident(schemas.app, 'orgs')} WHERE id = ${actor.orgId}`,
    );
    if (
      action.labelId !== null &&
      !ClassificationLabels.parse(labels.rows[0]!.classification_labels).some(
        (label) => label.id === action.labelId,
      )
    )
      throw new AppError('not_found', 'errors.notFound');
    const target = action.target;
    const id =
      target.kind === 'database'
        ? target.databaseId
        : target.kind === 'table'
          ? target.tableId
          : target.fieldId;
    await query(
      db,
      sql`UPDATE ${ident(schemas.app, `${target.kind}s`)} SET classification_label = ${action.labelId} WHERE id = ${id}`,
    );
  } else if (action.databaseId) {
    await query(
      db,
      sql`UPDATE ${ident(schemas.app, 'databases')} SET retention_policy = ${JSON.stringify(action.policy)}::jsonb,
      legal_hold = ${action.legalHold} WHERE id = ${action.databaseId} AND org_id = ${actor.orgId}`,
    );
  } else {
    if (action.legalHold) throw new AppError('validation_failed', 'governance.holdDatabaseOnly');
    await query(
      db,
      sql`UPDATE ${ident(schemas.app, 'orgs')} SET retention_policy = ${JSON.stringify(action.policy)}::jsonb WHERE id = ${actor.orgId}`,
    );
  }
}

/** Settings and their inverse commit with audit, idempotency, and access invalidation. */
export async function runGovernanceCommand(
  app: FastifyInstance,
  actor: Actor,
  input: unknown,
): Promise<GovernanceResult> {
  refuseDemo(actor);
  const command = parse(GovernanceCommand, input);
  const result = await runStored<Stored>(
    app,
    actor,
    `governance:${actor.orgId}`,
    {
      commandId: command.id,
      groupId: command.id,
      duplicate: (value) => ({ ...(value as Stored), status: 'duplicate' }),
      rejected: (error) => ({ id: command.id, status: 'rejected', error: error.toBody().error }),
    },
    async (c) => {
      let action: GovernanceAction;
      let expected: GovernanceAction | undefined;
      if (command.kind === 'governance.undo') {
        const stored = await query<{ result: Stored }>(
          c.db,
          sql`SELECT result FROM ${ident(c.schemas.app, 'commands')}
        WHERE id = ${command.undoOf} AND org_id = ${actor.orgId} AND actor_id = ${actor.userId}
        AND database_id = ${`governance:${actor.orgId}`} AND status = 'applied'`,
        );
        const previous = stored.rows[0]?.result;
        if (!previous?.before || !previous.after) throw new AppError('not_found', 'errors.notFound');
        action = GovernanceAction.parse(previous.before);
        expected = GovernanceAction.parse(previous.after);
      } else action = command.action;
      const scope = await authorize(c, action);
      const before = await current(c, action, scope);
      if (expected && !isDeepStrictEqual(before, expected))
        throw new AppError('conflict', 'governance.undoChanged');
      await write(c, action);
      if (action.kind !== 'retention.set')
        await query(
          c.db,
          sql`UPDATE ${ident(c.schemas.app, 'orgs')} SET classification_revision = classification_revision + 1 WHERE id = ${actor.orgId}`,
        );
      await auditEvent(
        c.db,
        compile(sql`${ident(c.schemas.audit)}`).text,
        `governance.${action.kind}`,
        actor,
        {
          databaseId: databaseOf(action),
          before,
          after: action,
          ...(command.kind === 'governance.undo' ? { undoOf: command.undoOf } : {}),
        },
      );
      const databases = await query<{ id: string }>(
        c.db,
        sql`SELECT id FROM ${ident(c.schemas.app, 'databases')}
      WHERE org_id = ${actor.orgId} AND (${databaseOf(action)}::text IS NULL OR id = ${databaseOf(action)})`,
      );
      // SQL views hold only what a label lets leave, so a changed label has them rebuilt rather
      // than waiting for the views' own expiration.
      if (action.kind !== 'retention.set' && databases.rows.length)
        await query(
          c.db,
          sql`UPDATE ${ident(c.schemas.app, 'sql_logins')} SET ready = false
          WHERE database_id = ANY(${databases.rows.map((database) => database.id)}::text[])`,
        );
      for (const database of databases.rows)
        await query(c.db, sql`SELECT pg_notify(${accessChannel(c.schemas)}, ${database.id})`);
      await query(c.db, sql`SELECT pg_notify(${homeChannel(c.schemas)}, ${actor.orgId})`);
      return { id: command.id, status: 'applied', before, after: action };
    },
  );
  return { id: result.id, status: result.status, ...(result.error ? { error: result.error } : {}) };
}
