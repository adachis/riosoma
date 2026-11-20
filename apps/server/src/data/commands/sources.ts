import { refuseDemo } from '../../demo/boundary.js';
import { createHash } from 'node:crypto';
import {
  AppError,
  SourceCommand,
  SourceConnection,
  isFileApiSource,
  newId,
  requiredSecrets,
  type SourceCommandResult,
  type SourceMeta,
  type SourceSecrets,
} from '@riosoma/contracts';
import { compile, ident, query, sql, withTransaction } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { auditEvent } from '../../auth/database.js';
import { sealCredential } from '../../credentials/service.js';
import type { Actor } from '../../http/policy.js';
import { parse } from '../../http/validate.js';
import { lockUnits, requirePerson, requireSource } from '../../org-units/store.js';
import { checkFileAddress, checkFileHost } from '../../sources/files.js';
import { checkApiAddress } from '../../sources/rest.js';
import {
  checkSecrets,
  requireSourceAccess,
  secretsFor,
  sourceAdmin,
  sourceMeta,
  type SourceRow,
} from '../../sources/store.js';
import { retargets } from '../../sources/target.js';
import { dataStore } from '../context.js';
import { homeChannel } from '../notify.js';
import type { CommandContext } from './context.js';
import { runStored } from './transaction.js';

type Snapshot = Record<string, unknown>;
interface Stored {
  status: 'applied' | 'duplicate' | 'rejected';
  id: string;
  family: 'source';
  sourceId?: string;
  undoOf?: string;
  before?: Snapshot | null;
  guard?: string;
  source?: SourceMeta | null;
  error?: ReturnType<AppError['toBody']>['error'];
}
async function snapshot(c: CommandContext, id: string): Promise<Snapshot | null> {
  const rows = await query<{ value: Snapshot }>(
    c.db,
    sql`SELECT to_jsonb(s) AS value
    FROM ${ident(c.schemas.app, 'sources')} s WHERE s.id = ${id} AND s.org_id = ${c.actor.orgId} FOR UPDATE`,
  );
  return rows.rows[0]?.value ?? null;
}
function digest(value: Snapshot | null): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
async function unused(c: CommandContext, id: string) {
  const used = await query(
    c.db,
    sql`SELECT table_id FROM ${ident(c.schemas.app, 'table_sources')}
    WHERE source_id = ${id} LIMIT 1`,
  );
  if (used.rowCount) throw new AppError('conflict', 'sources.inUse');
}
async function authorize(
  c: CommandContext,
  id: string,
  current: Snapshot | null,
  restoring?: Snapshot | null,
) {
  if (current) return requireSource(c.db, `"${c.schemas.app}"`, c.actor, id);
  const maker = restoring ? restoring.created_by : c.actor.userId;
  if (sourceAdmin(c.actor)) return null;
  if (typeof maker !== 'string') throw new AppError('forbidden', 'errors.adminOnly');
  return requirePerson(c.db, `"${c.schemas.app}"`, c.actor, maker, 'data_sources');
}
function supported(value: unknown) {
  const connection = parse(SourceConnection, value);
  if (!isFileApiSource(connection.kind)) throw new AppError('validation_failed', 'sources.kindFixed');
  return connection;
}

/** Read and authorize the candidate without keeping database locks across a DNS lookup. */
async function connectionToCheck(
  app: FastifyInstance,
  actor: Actor,
  command: SourceCommand,
): Promise<SourceConnection | undefined> {
  const action = command.action;
  if (action.kind === 'delete') return;
  const { pool, schemas } = dataStore(app.ctx);
  return withTransaction(pool, async (db) => {
    const c: CommandContext = { db, schemas, actor, databaseId: actor.orgId };
    const replay = await query(
      db,
      sql`SELECT id FROM ${ident(schemas.app, 'commands')}
      WHERE id = ${command.id} AND org_id = ${actor.orgId} AND actor_id = ${actor.userId}`,
    );
    if (replay.rowCount) return;
    let prior: Stored | undefined;
    if (action.kind === 'undo') {
      prior = (
        await query<{ result: Stored }>(
          db,
          sql`SELECT result FROM ${ident(schemas.app, 'commands')}
        WHERE id = ${action.commandId} AND org_id = ${actor.orgId} AND actor_id = ${actor.userId}`,
        )
      ).rows[0]?.result;
      if (prior?.family !== 'source' || !prior.sourceId || prior.before === undefined)
        throw new AppError('not_found', 'errors.notFound');
    }
    const sourceId = prior?.sourceId ?? (action.kind === 'update' ? action.sourceId : '');
    const before = sourceId ? await snapshot(c, sourceId) : null;
    if (before) await requireSourceAccess(db, schemas, actor, before as unknown as SourceRow);
    await authorize(c, sourceId, before, prior?.before);
    if (action.kind === 'update' && !before) throw new AppError('not_found', 'errors.notFound');
    if (action.kind === 'undo') return prior?.before ? supported(prior.before.connection) : undefined;
    return supported(action.input.connection ?? before?.connection);
  });
}

/** The organization command journal keeps inverse credentials sealed and returns only source metadata */
export async function runSourceCommand(
  app: FastifyInstance,
  actor: Actor,
  input: unknown,
  diagnostic?: { sourceId: string; updatedAt: string; lastTest: NonNullable<SourceMeta['lastTest']> },
): Promise<SourceCommandResult> {
  refuseDemo(actor);
  const command = parse(SourceCommand, input);
  let checkedConnection: SourceConnection | undefined;
  let preparationError: unknown;
  if (!diagnostic) {
    try {
      checkedConnection = await connectionToCheck(app, actor, command);
      if (checkedConnection) {
        checkFileAddress(checkedConnection, app.ctx.config);
        checkApiAddress(checkedConnection, app.ctx.config);
        await checkFileHost(checkedConnection, app.ctx.config);
      }
    } catch (error) {
      preparationError = error;
    }
  }
  const checkPrepared = (connection: SourceConnection) => {
    if (preparationError) throw preparationError;
    // A concurrent edit must not substitute a connection whose host was never checked.
    if (!checkedConnection || JSON.stringify(connection) !== JSON.stringify(checkedConnection))
      throw new AppError('conflict', 'errors.conflict');
    checkFileAddress(connection, app.ctx.config);
    checkApiAddress(connection, app.ctx.config);
  };
  const result = await runStored<Stored>(
    app,
    actor,
    actor.orgId,
    {
      commandId: command.id,
      groupId: command.id,
      duplicate: (value) => {
        const stored = value as Stored;
        if (stored.family !== 'source') throw new AppError('not_found', 'errors.notFound');
        return { ...stored, status: stored.error ? 'rejected' : 'duplicate' };
      },
      rejected: (error) => ({
        id: command.id,
        family: 'source',
        status: 'rejected',
        error: error.toBody().error,
      }),
    },
    async (c) => {
      await lockUnits(c.db, actor.orgId);
      const action = command.action;
      let prior: Stored | undefined;
      if (action.kind === 'undo') {
        const rows = await query<{ result: Stored }>(
          c.db,
          sql`SELECT result FROM ${ident(c.schemas.app, 'commands')}
        WHERE id = ${action.commandId} AND org_id = ${actor.orgId} AND actor_id = ${actor.userId}`,
        );
        prior = rows.rows[0]?.result;
        if (prior?.family !== 'source' || !prior.sourceId || !prior.guard || prior.before === undefined)
          throw new AppError('not_found', 'errors.notFound');
        const undone = await query(
          c.db,
          sql`SELECT id FROM ${ident(c.schemas.app, 'commands')}
          WHERE org_id = ${actor.orgId} AND result->>'family' = 'source'
          AND result->>'undoOf' = ${prior.id} AND status = 'applied' LIMIT 1`,
        );
        if (undone.rowCount) throw new AppError('conflict', 'errors.conflict');
      }
      const sourceId =
        prior?.sourceId ??
        (action.kind === 'create' ? newId('source') : 'sourceId' in action ? action.sourceId : '');
      const before = await snapshot(c, sourceId);
      if (before) supported(before.connection);
      actor.auditUnitId = await authorize(c, sourceId, before, prior?.before);
      if (action.kind !== 'create' && action.kind !== 'undo' && !before)
        throw new AppError('not_found', 'errors.notFound');
      let verb: string;
      if (prior) {
        if (digest(before) !== prior.guard) throw new AppError('conflict', 'errors.conflict');
        const restore = prior.before!;
        if (restore) {
          const connection = supported(restore.connection);
          checkPrepared(connection);
          const secrets = await secretsFor(restore as unknown as SourceRow, app.ctx.config.secretKey, c.db);
          restore.sealed_secrets = await sealCredential(
            app.ctx.config.secretKey,
            JSON.stringify(secrets),
            `source:${sourceId}`,
            actor.orgId,
            c.db,
          );
        }
        if (!restore) {
          await unused(c, sourceId);
          await query(c.db, sql`DELETE FROM ${ident(c.schemas.app, 'sources')} WHERE id = ${sourceId}`);
        } else if (!before) {
          await query(
            c.db,
            sql`INSERT INTO ${ident(c.schemas.app, 'sources')}
          SELECT * FROM jsonb_populate_record(NULL::${ident(c.schemas.app, 'sources')}, ${JSON.stringify(restore)}::jsonb)`,
          );
        } else {
          await query(
            c.db,
            sql`UPDATE ${ident(c.schemas.app, 'sources')} SET
          name = ${restore.name}, description = ${restore.description}, kind = ${restore.kind},
          connection = ${JSON.stringify(restore.connection)}::jsonb, sealed_secrets = ${restore.sealed_secrets},
          access = ${restore.access}, last_test = ${JSON.stringify(restore.last_test)}::jsonb, updated_at = now()
          WHERE id = ${sourceId}`,
          );
        }
        verb = 'undone';
      } else if (diagnostic) {
        if (
          diagnostic.sourceId !== sourceId ||
          new Date(String(before!.updated_at)).toISOString() !== diagnostic.updatedAt
        )
          throw new AppError('conflict', 'errors.conflict');
        await query(
          c.db,
          sql`UPDATE ${ident(c.schemas.app, 'sources')}
        SET last_test = ${JSON.stringify(diagnostic.lastTest)}::jsonb WHERE id = ${sourceId}`,
        );
        verb = 'tested';
      } else if (action.kind === 'delete') {
        await unused(c, sourceId);
        await query(c.db, sql`DELETE FROM ${ident(c.schemas.app, 'sources')} WHERE id = ${sourceId}`);
        verb = 'deleted';
      } else if (action.kind === 'create' || action.kind === 'update') {
        const data = action.input;
        const connection = supported(data.connection ?? before?.connection);
        checkPrepared(connection);
        let secrets: SourceSecrets = {};
        if (before && !retargets(supported(before.connection), connection))
          secrets = await secretsFor(before as unknown as SourceRow, app.ctx.config.secretKey, c.db);
        for (const name of Object.keys(data.secrets ?? {}) as Array<keyof SourceSecrets>) {
          const value = data.secrets![name];
          if (value === null) delete secrets[name];
          else if (value !== undefined) secrets[name] = value;
        }
        if (
          before &&
          retargets(supported(before.connection), connection) &&
          requiredSecrets(connection).some((name) => !secrets[name])
        )
          throw new AppError('validation_failed', 'sources.secretsReenter');
        checkSecrets(connection, secrets);
        const sealed = await sealCredential(
          app.ctx.config.secretKey,
          JSON.stringify(secrets),
          `source:${sourceId}`,
          actor.orgId,
          c.db,
        );
        if (action.kind === 'create') {
          await query(
            c.db,
            sql`INSERT INTO ${ident(c.schemas.app, 'sources')}
          (id, org_id, name, description, kind, connection, sealed_secrets, access, created_by)
          VALUES (${sourceId}, ${actor.orgId}, ${data.name}, ${data.description}, ${connection.kind},
          ${JSON.stringify(connection)}::jsonb, ${sealed}, ${data.access}, ${actor.userId})`,
          );
        } else {
          await query(
            c.db,
            sql`UPDATE ${ident(c.schemas.app, 'sources')} SET name = ${data.name ?? before!.name},
          description = ${data.description ?? before!.description}, kind = ${connection.kind},
          connection = ${JSON.stringify(connection)}::jsonb, sealed_secrets = ${sealed},
          access = ${data.access ?? before!.access}, updated_at = now() WHERE id = ${sourceId}`,
          );
        }
        verb = action.kind === 'create' ? 'created' : 'updated';
      } else throw new AppError('validation_failed', 'errors.validationFailed');
      if (verb === 'updated' || verb === 'undone')
        await query(
          c.db,
          sql`UPDATE ${ident(c.schemas.app, 'table_sources')} SET fetch_state = NULL WHERE source_id = ${sourceId}`,
        );
      await auditEvent(c.db, compile(sql`${ident(c.schemas.audit)}`).text, `data.source.${verb}`, actor, {
        sourceId,
        commandId: command.id,
        ...(prior ? { undoOf: prior.id } : {}),
      });
      await query(c.db, sql`SELECT pg_notify(${homeChannel(c.schemas)}, ${actor.orgId})`);
      const after = await snapshot(c, sourceId);
      const row = after
        ? ({
            ...after,
            created_at: new Date(String(after.created_at)),
            updated_at: new Date(String(after.updated_at)),
          } as unknown as SourceRow)
        : null;
      return {
        id: command.id,
        family: 'source',
        ...(prior ? { undoOf: prior.id } : {}),
        status: 'applied',
        sourceId,
        before,
        guard: digest(after),
        source: row ? await sourceMeta(c.db, c.schemas, row, actor, app.ctx.config.secretKey) : null,
      };
    },
  );
  if (result.error)
    throw new AppError(result.error.code, result.error.messageKey, {
      params: result.error.params,
      fields: result.error.fields,
    });
  let source = result.source ?? null;
  if (result.status === 'duplicate' && result.sourceId) {
    const { pool, schemas } = dataStore(app.ctx);
    source = await withTransaction(pool, async (db) => {
      await lockUnits(db, actor.orgId);
      const rows = await query<SourceRow>(
        db,
        sql`SELECT * FROM ${ident(schemas.app, 'sources')}
        WHERE id = ${result.sourceId} AND org_id = ${actor.orgId} FOR UPDATE`,
      );
      const row = rows.rows[0];
      if (!row) return null;
      await requireSource(db, `"${schemas.app}"`, actor, row.id);
      await requireSourceAccess(db, schemas, actor, row);
      return sourceMeta(db, schemas, row, actor, app.ctx.config.secretKey);
    });
  }
  return {
    id: result.id,
    status: result.status as 'applied' | 'duplicate',
    source: source ? { ...source, commandId: result.id } : null,
  };
}
