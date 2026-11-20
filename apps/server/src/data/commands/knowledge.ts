import { refuseDemo } from '../../demo/boundary.js';
import { isDeepStrictEqual } from 'node:util';
import { AppError, KnowledgeCommand, KnowledgeSettings } from '@riosoma/contracts';
import { compile, ident, query, sql } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { auditEvent } from '../../auth/database.js';
import type { Actor } from '../../http/policy.js';
import { parse } from '../../http/validate.js';
import { organizationAdmin } from '../../org-units/store.js';
import { seal } from '../../secrets.js';
import { AccessScope } from '../access.js';
import { readKnowledgeSettings } from '../knowledge.js';
import { loadTable } from '../metadata.js';
import type { CommandContext } from './context.js';
import { readAiSettings, writeAiSettings, type StoredAiSettings } from '../ai-settings.js';
import { lockOrganization } from '../organization-admin/store.js';
import { lock, runStored } from './transaction.js';

type State = {
  kind: 'memory.save' | 'knowledge.settings' | 'knowledge.key' | 'embedding.table' | 'ai.settings';
  databaseId?: string;
  target: string;
  personal?: boolean;
  remoteDataBlocked?: boolean;
  value: unknown;
};
const missing = () => new AppError('not_found', 'errors.notFound');

async function authorize(c: CommandContext, state: State) {
  const scope = new AccessScope(c.db, c.schemas, c.actor);
  await scope.requireOrganization();
  if (state.databaseId)
    await scope.require(
      state.databaseId,
      state.kind === 'memory.save' && !state.personal ? 'editSchema' : 'read',
    );
  if (state.kind !== 'memory.save' && !organizationAdmin(c.actor, 'ai'))
    throw new AppError('forbidden', 'data.access.denied');
  if (state.kind === 'embedding.table') {
    const table = await loadTable(c.db, c.schemas, state.target);
    if (!table || table.trashed || table.databaseId !== state.databaseId || table.orgId !== c.actor.orgId)
      throw missing();
  }
}

async function current(c: CommandContext, state: State): Promise<State> {
  const { db, schemas, actor } = c;
  let value: unknown;
  switch (state.kind) {
    case 'ai.settings':
      value = await readAiSettings(c);
      break;
    case 'memory.save': {
      const result = await query<{
        org_id: string;
        database_id: string;
        user_id: string | null;
        text: string;
        remote_data_blocked: boolean;
      }>(
        db,
        sql`SELECT org_id, database_id, user_id, text, remote_data_blocked FROM ${ident(schemas.app, 'memories')} WHERE id = ${state.target}`,
      );
      const row = result.rows[0];
      if (
        row &&
        (row.org_id !== actor.orgId ||
          row.database_id !== state.databaseId ||
          row.user_id !== (state.personal ? actor.userId : null))
      )
        throw missing();
      state = { ...state, remoteDataBlocked: row?.remote_data_blocked ?? false };
      value = row?.text ?? null;
      break;
    }
    case 'knowledge.settings':
      value = await readKnowledgeSettings(db, schemas, actor);
      break;
    case 'knowledge.key': {
      const result = await query<{ sealed: string }>(
        db,
        sql`SELECT sealed FROM ${ident(schemas.app, 'ai_keys')}
        WHERE org_id = ${actor.orgId} AND provider_id = ${state.target}`,
      );
      value = result.rows[0]?.sealed ?? null;
      break;
    }
    case 'embedding.table': {
      const result = await query<{ enabled: boolean }>(
        db,
        sql`SELECT enabled FROM ${ident(schemas.app, 'embedding_tables')}
        WHERE org_id = ${actor.orgId} AND table_id = ${state.target}`,
      );
      value = result.rows[0]?.enabled ?? false;
    }
  }
  return { ...state, value };
}

/**
 * `searchKey` is the sealed key a settings change brought for its paid search service.  It stays
 * out of the state, so the history that undo reads never holds it.
 */
async function write(c: CommandContext, state: State, searchUrl?: string, searchKey?: string) {
  const { db, schemas, actor } = c;
  switch (state.kind) {
    case 'ai.settings':
      await writeAiSettings(c, state.value as StoredAiSettings);
      break;
    case 'memory.save': {
      if (state.value === null)
        await query(
          db,
          sql`DELETE FROM ${ident(schemas.app, 'memories')} WHERE id = ${state.target}
        AND org_id = ${actor.orgId} AND database_id = ${state.databaseId}`,
        );
      else {
        const count = await query<{ count: number }>(
          db,
          sql`SELECT count(*)::int AS count FROM ${ident(schemas.app, 'memories')}
          WHERE org_id = ${actor.orgId} AND database_id = ${state.databaseId}
          AND user_id IS NOT DISTINCT FROM ${state.personal ? actor.userId : null} AND id <> ${state.target}`,
        );
        if (count.rows[0]!.count >= 500) throw new AppError('validation_failed', 'knowledge.memoryLimit');
        await query(
          db,
          sql`INSERT INTO ${ident(schemas.app, 'memories')} (id, org_id, database_id, user_id, text, remote_data_blocked)
          VALUES (${state.target}, ${actor.orgId}, ${state.databaseId}, ${state.personal ? actor.userId : null}, ${state.value as string}, ${state.remoteDataBlocked ?? false})
          ON CONFLICT (id) DO UPDATE SET text = EXCLUDED.text, remote_data_blocked = EXCLUDED.remote_data_blocked, updated_at = statement_timestamp()`,
        );
      }
      await query(
        db,
        sql`DELETE FROM ${ident(schemas.app, 'embeddings')} WHERE org_id = ${actor.orgId}
        AND database_id = ${state.databaseId} AND source_id = ${state.target}`,
      );
      break;
    }
    case 'knowledge.settings': {
      const before = await readKnowledgeSettings(db, schemas, actor);
      const after = KnowledgeSettings.parse(state.value);
      const paid = after.search.engine !== 'searxng';
      const target = `search-${after.search.engine}`;
      // A stored search key belongs to the service and address it was entered for, and never
      // follows either somewhere new: otherwise anyone who could change the address could collect
      // the key without ever seeing it.  This holds whether or not search is on, so the address
      // can't be changed first and search turned on after.
      const retargeted =
        paid &&
        (before.search.engine !== after.search.engine || before.search.address !== after.search.address);
      const searchChanged =
        !before.search.enabled ||
        before.search.engine !== after.search.engine ||
        before.search.address !== after.search.address;
      if (after.search.enabled && searchChanged) {
        if (!after.search.address && !(after.search.engine === 'searxng' && searchUrl))
          throw new AppError('validation_failed', 'knowledge.searchAddressRequired');
        if (paid && !searchKey) {
          // A stored key only counts for the service and address it was entered for.
          const keys = retargeted
            ? null
            : await query(
                db,
                sql`SELECT 1 FROM ${ident(schemas.app, 'ai_keys')} WHERE org_id = ${actor.orgId} AND provider_id = ${target}`,
              );
          if (!keys?.rowCount) throw new AppError('validation_failed', 'knowledge.searchKeyRequired');
        }
      }
      if (paid && searchKey)
        await query(
          db,
          sql`INSERT INTO ${ident(schemas.app, 'ai_keys')} (org_id, provider_id, sealed)
          VALUES (${actor.orgId}, ${target}, ${searchKey})
          ON CONFLICT (org_id, provider_id) DO UPDATE SET sealed = EXCLUDED.sealed`,
        );
      else if (retargeted)
        await query(
          db,
          sql`DELETE FROM ${ident(schemas.app, 'ai_keys')}
          WHERE org_id = ${actor.orgId} AND provider_id = ${target}`,
        );
      // Undoing an earlier change to the key would put a key entered for the old address back.
      if (retargeted)
        await query(
          db,
          sql`UPDATE ${ident(schemas.app, 'knowledge_actions')} SET undone = true
          WHERE org_id = ${actor.orgId} AND NOT undone
          AND before ->> 'kind' = 'knowledge.key' AND before ->> 'target' = ${target}`,
        );

      await query(
        db,
        sql`INSERT INTO ${ident(schemas.app, 'knowledge_settings')} (org_id, settings)
        VALUES (${actor.orgId}, ${JSON.stringify(state.value)}::jsonb)
        ON CONFLICT (org_id) DO UPDATE SET settings = EXCLUDED.settings`,
      );
      if (!isDeepStrictEqual(before.embedding, after.embedding))
        await query(
          db,
          sql`UPDATE ${ident(schemas.app, 'embedding_tables')} SET generation = generation + 1, cursor = 0
        WHERE org_id = ${actor.orgId}`,
        );
      break;
    }
    case 'knowledge.key':
      if (state.value === null)
        await query(
          db,
          sql`DELETE FROM ${ident(schemas.app, 'ai_keys')}
        WHERE org_id = ${actor.orgId} AND provider_id = ${state.target}`,
        );
      else
        await query(
          db,
          sql`INSERT INTO ${ident(schemas.app, 'ai_keys')} (org_id, provider_id, sealed)
        VALUES (${actor.orgId}, ${state.target}, ${state.value as string})
        ON CONFLICT (org_id, provider_id) DO UPDATE SET sealed = EXCLUDED.sealed`,
        );
      break;
    case 'embedding.table':
      await query(
        db,
        sql`INSERT INTO ${ident(schemas.app, 'embedding_tables')}
        (table_id, database_id, org_id, user_id, enabled) VALUES
        (${state.target}, ${state.databaseId}, ${actor.orgId}, ${actor.userId}, ${state.value as boolean})
        ON CONFLICT (table_id) DO UPDATE SET enabled = EXCLUDED.enabled, user_id = EXCLUDED.user_id,
          generation = embedding_tables.generation + 1, cursor = 0`,
      );
      await query(
        db,
        sql`DELETE FROM ${ident(schemas.app, 'embeddings')}
        WHERE org_id = ${actor.orgId} AND table_id = ${state.target}`,
      );
  }
}

/** Uses the bus's replay protection and transaction, with private history for scoped settings. */
export async function runKnowledgeCommand(
  app: FastifyInstance,
  actor: Actor,
  input: unknown,
  conversationId?: string,
) {
  refuseDemo(actor);
  const command = parse(KnowledgeCommand, input);
  const databaseId = 'databaseId' in command ? command.databaseId : '';
  return runStored<{
    status: 'applied' | 'duplicate' | 'rejected';
    actionId: string;
    error?: ReturnType<AppError['toBody']>['error'];
  }>(
    app,
    actor,
    databaseId,
    {
      commandId: command.id,
      groupId: command.id,
      duplicate: () => ({ status: 'duplicate' as const, actionId: command.id }),
      rejected: (error) => ({
        status: 'rejected' as const,
        actionId: command.id,
        error: error.toBody().error,
      }),
    },
    async (c) => {
      await lock(c, [`knowledge:${actor.orgId}`]);
      let after: State;
      if (command.kind === 'knowledge.undo') {
        const saved = await query<{ before: State; after: State; undone: boolean }>(
          c.db,
          sql`SELECT before, after, undone FROM ${ident(c.schemas.app, 'knowledge_actions')}
        WHERE id = ${command.actionId} AND org_id = ${actor.orgId} AND user_id = ${actor.userId} AND created_at > now() - interval '30 days'`,
        );
        const action = saved.rows[0];
        if (
          !action ||
          action.undone ||
          !['memory.save', 'knowledge.settings', 'knowledge.key', 'embedding.table', 'ai.settings'].includes(
            action.before.kind,
          )
        )
          throw missing();
        if (action.before.kind === 'memory.save') {
          action.before.remoteDataBlocked ??= false;
          action.after.remoteDataBlocked ??= false;
        }
        after = action.before;
        if (after.kind === 'ai.settings') await lockOrganization(c);
        await authorize(c, after);
        if (!isDeepStrictEqual(await current(c, after), action.after))
          throw new AppError('conflict', 'errors.conflict');
        await query(
          c.db,
          sql`UPDATE ${ident(c.schemas.app, 'knowledge_actions')} SET undone = true WHERE id = ${command.actionId}`,
        );
      } else if (command.kind === 'memory.save')
        after = {
          kind: command.kind,
          databaseId,
          target: command.memoryId,
          personal: command.visibility === 'personal',
          value: command.text,
        };
      else if (command.kind === 'knowledge.settings')
        after = { kind: command.kind, target: actor.orgId, value: command.settings };
      else if (command.kind === 'knowledge.key') {
        const target = `search-${command.engine}`;
        after = {
          kind: command.kind,
          target,
          value:
            command.key === null
              ? null
              : seal(app.ctx.config.secretKey, command.key, `ai:${actor.orgId}:${target}`),
        };
      } else after = { kind: command.kind, databaseId, target: command.tableId, value: command.enabled };
      await authorize(c, after);
      const before = await current(c, after);
      if (command.kind === 'memory.save') {
        let labeled = false;
        if (conversationId) {
          const conversation = await query<{ remote_data_blocked: boolean }>(
            c.db,
            sql`SELECT remote_data_blocked FROM ${ident(c.schemas.app, 'rio_conversations')} WHERE id = ${conversationId} AND org_id = ${actor.orgId} AND user_id = ${actor.userId}`,
          );
          labeled = conversation.rows[0]?.remote_data_blocked ?? true;
        }
        // Text a person writes themselves, outside a conversation, carries no labeled provenance.
        const rewritten = !conversationId && before.value !== after.value;
        after.remoteDataBlocked =
          after.value !== null && !rewritten && (before.remoteDataBlocked === true || labeled);
      }
      await write(
        c,
        after,
        app.ctx.config.searchUrl,
        command.kind === 'knowledge.settings' &&
          command.searchKey &&
          command.settings.search.engine !== 'searxng'
          ? seal(
              app.ctx.config.secretKey,
              command.searchKey,
              `ai:${actor.orgId}:search-${command.settings.search.engine}`,
            )
          : undefined,
      );
      await query(
        c.db,
        sql`INSERT INTO ${ident(c.schemas.app, 'knowledge_actions')}
      (id, org_id, user_id, database_id, before, after) VALUES (${command.id}, ${actor.orgId}, ${actor.userId},
      ${after.databaseId ?? null}, ${JSON.stringify(before)}::jsonb, ${JSON.stringify(after)}::jsonb)`,
      );
      await auditEvent(c.db, compile(sql`${ident(c.schemas.audit)}`).text, command.kind, actor, {
        target: after.target,
        databaseId: after.databaseId,
        visibility: after.personal ? 'personal' : 'database',
      });
      // Broadcast only invalidation metadata, so another reader never receives private note text.
      await query(
        c.db,
        sql`SELECT pg_notify(${`${c.schemas.app}_knowledge`.slice(0, 63)},
      ${JSON.stringify({ orgId: actor.orgId, databaseId: after.databaseId ?? null })})`,
      );
      return { status: 'applied' as const, actionId: command.id };
    },
  );
}
