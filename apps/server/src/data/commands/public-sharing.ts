import { refuseDemo } from '../../demo/boundary.js';
import { isDeepStrictEqual } from 'node:util';
import { AppError, PublicSharingCommand, PublicSharingAction } from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { auditEvent, authDatabase } from '../../auth/database.js';
import type { Actor } from '../../http/policy.js';
import { parse } from '../../http/validate.js';
import { organizationAdmin } from '../../org-units/store.js';
import { homeChannel } from '../notify.js';
import { AccessScope } from '../access.js';
import { editableFormFiles } from '../public-form-files.js';
import { editableEmbed, publicLinkTables, publicSharingPolicy } from '../public-sharing.js';
import type { CommandContext } from './context.js';
import { lock, runStored } from './transaction.js';

interface Result {
  id: string;
  status: 'applied' | 'duplicate' | 'rejected';
  action?: PublicSharingAction;
  inverse?: PublicSharingAction;
  error?: ReturnType<AppError['toBody']>['error'];
}

async function current(c: CommandContext, action: PublicSharingAction): Promise<PublicSharingAction> {
  if (action.kind === 'formFiles') {
    const selection = await editableFormFiles(c.db, c.schemas, c.actor, action.linkId);
    return { ...action, fileIds: selection.selected };
  }
  if (action.kind === 'embed') {
    const row = await editableEmbed(c.db, c.schemas, c.actor, action.target);
    return { ...action, embed: row.embed };
  }
  await new AccessScope(c.db, c.schemas, c.actor).requireOrganization();
  if (!organizationAdmin(c.actor, 'security')) throw new AppError('forbidden', 'data.access.denied');
  return { kind: 'policy', policy: await publicSharingPolicy(c.db, c.schemas, c.actor.orgId) };
}

/** Replay, undo, authorization, audit, and invalidation share one transaction. */
export async function runPublicSharingCommand(
  app: FastifyInstance,
  actor: Actor,
  input: unknown,
  transaction?: Queryable,
) {
  refuseDemo(actor);
  const command = parse(PublicSharingCommand, input);
  const result = await runStored<Result>(
    app,
    actor,
    actor.orgId,
    {
      commandId: command.id,
      groupId: command.id,
      ...(transaction ? { transaction } : {}),
      duplicate: (value) => ({ ...(value as Result), status: 'duplicate' }),
      rejected: (error) => ({ id: command.id, status: 'rejected', error: error.toBody().error }),
    },
    async (c) => {
      await lock(c, [`public-sharing:${actor.orgId}`]);
      let action = command.action;
      if (action?.kind === 'embed') action.embed.sites = [...new Set(action.embed.sites)];
      if (command.undoOf) {
        const prior = await query<{ result: Result }>(
          c.db,
          sql`SELECT result FROM ${ident(c.schemas.app, 'commands')}
          WHERE id = ${command.undoOf} AND org_id = ${actor.orgId} AND actor_id = ${actor.userId}`,
        );
        const saved = prior.rows[0]?.result;
        if (
          !PublicSharingAction.safeParse(saved?.action).success ||
          !PublicSharingAction.safeParse(saved?.inverse).success ||
          !saved?.action ||
          !saved.inverse ||
          !isDeepStrictEqual(await current(c, saved.action), saved.action)
        )
          throw new AppError('conflict', 'errors.conflict');
        action = saved.inverse;
      }
      if (!action) throw new AppError('validation_failed', 'errors.validationFailed');
      const inverse = await current(c, action);
      if (action.kind === 'policy') {
        await query(
          c.db,
          sql`UPDATE ${ident(c.schemas.app, 'orgs')}
        SET public_sharing = ${JSON.stringify(action.policy)}::jsonb WHERE id = ${actor.orgId}`,
        );
      } else if (action.kind === 'formFiles') {
        const available = await editableFormFiles(c.db, c.schemas, actor, action.linkId, action.fileIds);
        if (action.fileIds.some((id) => !available.files.some((file) => file.id === id)))
          throw new AppError('forbidden', 'data.access.denied');
        await query(
          c.db,
          sql`UPDATE ${ident(c.schemas.app, 'public_forms')}
        SET files = ${[...new Set(action.fileIds)]}::text[] WHERE id = ${action.linkId} AND org_id = ${actor.orgId}`,
        );
      } else {
        const policy = await publicSharingPolicy(c.db, c.schemas, actor.orgId);
        if (action.embed.enabled && !policy.embeddingEnabled)
          throw new AppError('forbidden', 'data.access.denied');
        const value = JSON.stringify(action.embed);
        await query(
          c.db,
          sql`UPDATE ${ident(c.schemas.app, publicLinkTables[action.target.kind])}
        SET ${
          action.target.kind === 'view'
            ? sql`settings = jsonb_set(settings, '{embed}', ${value}::jsonb), updated_at = statement_timestamp()`
            : sql`embed = ${value}::jsonb`
        }
        WHERE id = ${action.target.linkId} AND org_id = ${actor.orgId}`,
        );
      }
      await auditEvent(c.db, authDatabase(app.ctx).audit, `publicSharing.${action.kind}`, actor, {
        commandId: command.id,
        undoOf: command.undoOf,
        action,
      });
      await query(c.db, sql`SELECT pg_notify(${homeChannel(c.schemas)}, ${actor.orgId})`);
      return { id: command.id, status: 'applied', action, inverse };
    },
  );
  if (result.error)
    throw new AppError(result.error.code, result.error.messageKey, { params: result.error.params });
  return { id: result.id, status: result.status };
}
