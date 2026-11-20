import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { ProviderError, providerFailure, type ChatMessage, type ToolCall } from '@riosoma/ai';
import type { Actor } from '../../http/policy.js';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import { dataStore } from '../../data/context.js';
import { recordSpend } from '../../ai/conversations.js';
import { estimateCall, recordAiUse, zoneFor } from '../../ai/footprint.js';
import { modelFor } from '../../ai/settings.js';
import type { AiSettings } from '@riosoma/contracts';
import { BuildCeiling } from './runner.js';
import { buildTools } from './tools.js';
import { LeaseLost } from '../pipeline/store.js';
import { logModelFailure } from '../model-failure.js';

export async function buildModel(
  app: FastifyInstance,
  actor: Actor,
  settings: AiSettings,
  signal: AbortSignal,
  lease?: { fileId: string; token: string },
  feature: 'builder' | 'study' = 'builder',
) {
  const model = await modelFor(app.ctx, actor.orgId, settings, 'power');
  if (!model || !model.registry?.tools || !model.registry.price) return null;
  const { pool, schemas } = dataStore(app.ctx);
  return {
    model,
    async call(messages: ChatMessage[], remainingUsd: number) {
      const price = model.registry!.price!;
      const requestBytes = Buffer.byteLength(JSON.stringify({ messages, tools: buildTools }));
      const estimatedInput = requestBytes + 1024;
      // Reserve the full possible output before opening a call.  Unknown prices cannot enforce a ceiling.
      const maxOutputTokens = Math.min(model.registry?.maxOutputTokens ?? 8192, 8192);
      if ((estimatedInput * price.input + maxOutputTokens * price.output) / 1_000_000 > remainingUsd)
        throw new BuildCeiling();
      const started = performance.now();
      let inputTokens = 0;
      let outputTokens = 0;
      let reported = false;
      let characters = 0;
      let failed: 'keyRefused' | 'providerDown' | undefined;
      let answered = false;
      let malformed = false;
      const calls: ToolCall[] = [];
      try {
        for await (const part of model.adapter.stream(model.config, {
          model: model.ref.model,
          messages,
          tools: buildTools,
          maxOutputTokens,
          signal,
        })) {
          answered = true;
          if (part.type === 'usage') {
            inputTokens = part.inputTokens;
            outputTokens = part.outputTokens;
            reported = true;
          }
          if (part.type === 'text') characters += part.delta.length;
          if (part.type === 'toolCall') {
            calls.push(part.call);
            characters += JSON.stringify(part.call.arguments).length;
          }
          if (part.type === 'toolCallInput') {
            let args: unknown;
            characters +=
              typeof part.input === 'string' ? part.input.length : (JSON.stringify(part.input)?.length ?? 0);
            try {
              args = part.encoding === 'json' ? JSON.parse(String(part.input)) : part.input;
            } catch {
              args = null;
            }
            calls.push({
              id: randomUUID(),
              name: part.name,
              arguments: args as Record<string, unknown>,
            });
          }
          if (
            part.type === 'outputLimit' ||
            (part.type === 'done' && ['length', 'filtered'].includes(part.stop))
          )
            malformed = true;
        }
      } catch (error) {
        const failure = providerFailure(error);
        logModelFailure(app.log, feature, model.ref.providerId, failure);
        if (error instanceof ProviderError && error.detail?.startsWith('The model sent arguments for '))
          malformed = true;
        else
          failed =
            failure.messageKey === 'ai.provider.unauthorized' || [401, 403].includes(failure.status ?? 0)
              ? 'keyRefused'
              : 'providerDown';
      }
      if (malformed) calls.splice(0, calls.length, { id: randomUUID(), name: 'look', arguments: {} });
      // Starting a stream does not prove the provider received a call or spent any tokens.
      if (!reported && (!answered || failed || malformed))
        return { calls, costUsd: 0, ...(failed ? { reason: failed } : {}) };
      if (!reported) {
        inputTokens = estimatedInput;
        outputTokens = Math.min(maxOutputTokens, Math.ceil(characters / 2));
      }
      const ms = performance.now() - started;
      const costUsd = (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
      await withTransaction(pool, async (db) => {
        if (lease) {
          const owned = await query(
            db,
            sql`SELECT id FROM ${ident(schemas.app, 'ingest_files')}
            WHERE org_id = ${actor.orgId} AND id = ${lease.fileId} AND state = 'reading' AND leased_by = ${lease.token} AND lease_until > clock_timestamp() FOR UPDATE`,
          );
          if (!owned.rowCount) throw new LeaseLost();
        }
        await recordSpend(db, schemas, actor.orgId, costUsd);
        await recordAiUse(db, schemas, {
          orgId: actor.orgId,
          userId: actor.userId,
          feature: 'ingest',
          usage: {
            ...model.ref,
            inputTokens,
            outputTokens,
            costUsd,
            tokensEstimated: !reported,
            footprint: estimateCall(
              { ...model.ref, outputTokens, ms, estimateRef: model.estimateRef },
              zoneFor(app.ctx, settings),
            ),
          },
        });
      });
      return { calls, costUsd, ...(failed ? { reason: failed } : {}) };
    },
  };
}
