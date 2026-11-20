import { refuseDemo } from '../../demo/boundary.js';
import { randomUUID } from 'node:crypto';
import {
  AiSettingsUpdate,
  AppError,
  ProviderId,
  type AiSettings,
  type GatewayChange,
  type ErrorBody,
} from '@riosoma/contracts';
import { compile, ident, query, sql } from '@riosoma/db';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Actor } from '../../http/policy.js';
import { parse } from '../../http/validate.js';
import { auditEvent } from '../../auth/database.js';
import {
  aiSettingsRevision,
  prepareAiSettings,
  prepareAiGateways,
  readAiSettings,
  writeAiSettings,
} from '../ai-settings.js';
import { lockOrganization } from '../organization-admin/store.js';
import type { CommandContext } from './context.js';
import type { StoredAiSettings } from '../ai-settings.js';
import { runStored } from './transaction.js';

type Result = {
  status: 'applied' | 'duplicate' | 'rejected';
  settings?: AiSettings;
  error?: ErrorBody['error'];
};

/** The organization lock serializes revision checks with presets and other settings commands. */
export async function runAiSettingsCommand(app: FastifyInstance, actor: Actor, input: unknown) {
  refuseDemo(actor);
  const supplied = parse(z.record(z.string(), z.unknown()), input);
  if (Object.hasOwn(supplied, 'gateways')) throw new AppError('validation_failed', 'ai.gateway.useForm');
  const expectedRevision = parse(z.string().length(64).optional(), supplied.expectedRevision);
  const keys =
    parse(z.record(ProviderId, z.string().trim().min(1).max(10000)).optional(), supplied.keys) ?? {};
  const parsed = parse(AiSettingsUpdate, supplied);
  const update = Object.fromEntries(
    Object.entries(parsed).filter(
      ([key]) =>
        !['expectedRevision', 'gatewayChanges', 'removedGatewayIds'].includes(key) &&
        Object.hasOwn(supplied, key),
    ),
  );
  return saveState(app, actor, expectedRevision, async (c, before) => {
    const gateways = await prepareAiGateways(
      c,
      before,
      parsed.gatewayChanges ?? [],
      parsed.removedGatewayIds ?? [],
    );
    return prepareAiSettings(c, gateways, update, keys, [
      ...(parsed.gatewayChanges ?? []).map((change) => change.gateway.providerId),
      ...(parsed.removedGatewayIds ?? []),
    ]);
  });
}

export async function runAiGatewayCommand(
  app: FastifyInstance,
  actor: Actor,
  changes: GatewayChange[],
  removed: string[],
) {
  refuseDemo(actor);
  return saveState(app, actor, undefined, (c, before) => prepareAiGateways(c, before, changes, removed));
}

export async function runAiKeyCommand(
  app: FastifyInstance,
  actor: Actor,
  providerId: string,
  key: string | null,
) {
  refuseDemo(actor);
  return saveState(app, actor, undefined, async (c, before) => {
    if (key !== null) return prepareAiSettings(c, before, {}, { [providerId]: key });
    const keys = { ...before.keys };
    delete keys[providerId];
    return { ...before, keys };
  });
}

async function saveState(
  app: FastifyInstance,
  actor: Actor,
  expectedRevision: string | undefined,
  prepare: (c: CommandContext, before: StoredAiSettings) => Promise<StoredAiSettings>,
) {
  const id = randomUUID();
  const result = await runStored<Result>(
    app,
    actor,
    '',
    {
      commandId: id,
      lockKey: `ai:${actor.orgId}`,
      groupId: id,
      duplicate: (value) => ({ ...(value as Result), status: 'duplicate' }),
      rejected: (error) => ({ status: 'rejected', error: error.toBody().error }),
    },
    async (c) => {
      // Legacy gateway routes and organization presets share this record with page saves.
      await query(c.db, sql`SELECT pg_advisory_xact_lock(hashtext(${`ai:${actor.orgId}`}))`);
      await lockOrganization(c);
      const before = await readAiSettings(c);
      if (expectedRevision !== undefined && expectedRevision !== aiSettingsRevision(before))
        throw new AppError('conflict', 'errors.conflict');
      const after = await prepare(c, before);
      await writeAiSettings(c, after);
      const state = (value: typeof before) => ({ kind: 'ai.settings', target: actor.orgId, value });
      await query(
        c.db,
        sql`INSERT INTO ${ident(c.schemas.app, 'knowledge_actions')}
      (id, org_id, user_id, database_id, before, after)
      VALUES (${id}, ${actor.orgId}, ${actor.userId}, NULL,
        ${JSON.stringify(state(before))}::jsonb, ${JSON.stringify(state(after))}::jsonb)`,
      );
      await auditEvent(c.db, compile(sql`${ident(c.schemas.audit)}`).text, 'ai.settings', actor, {
        target: actor.orgId,
        before: before.settings,
        after: after.settings,
      });
      for (const gateway of after.settings.gateways ?? []) {
        const previous = before.settings.gateways?.find((entry) => entry.providerId === gateway.providerId);
        if (
          JSON.stringify(previous) !== JSON.stringify(gateway) ||
          before.keys[gateway.providerId] !== after.keys[gateway.providerId]
        )
          await auditEvent(c.db, compile(sql`${ident(c.schemas.audit)}`).text, 'ai.gateway.saved', actor, {
            providerId: gateway.providerId,
          });
      }
      for (const gateway of before.settings.gateways ?? [])
        if (!after.settings.gateways?.some((entry) => entry.providerId === gateway.providerId))
          await auditEvent(c.db, compile(sql`${ident(c.schemas.audit)}`).text, 'ai.gateway.removed', actor, {
            providerId: gateway.providerId,
          });
      return { status: 'applied', settings: after.settings };
    },
  );
  if (result.error) throw new AppError(result.error.code, result.error.messageKey, result.error);
  return result.settings!;
}
