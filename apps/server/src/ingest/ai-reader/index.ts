import { budgetReached } from '../../ai/budget.js';
import { REGISTRY } from '@riosoma/ai';
import { DocumentImportSettings, type TableMeta } from '@riosoma/contracts';
import type { ExtractedSource } from '@riosoma/ingest';
import type { AppContext } from '../../app.js';
import type { Actor } from '../../http/policy.js';
import { actorFor } from '../../automations/run.js';
import { requestSchemaOutput } from '../../ai/schema-output.js';
import { connection, settingsFor, spent } from '../../ai/settings.js';
import { registeredModel } from '../../ai/gateway-config.js';
import { dataStore } from '../../data/context.js';
import { AccessScope } from '../../data/access.js';
import { loadFields } from '../../data/metadata.js';
import { knowledgeSettings } from '../../data/knowledge.js';
import { DecisionStore } from '../decisions/store.js';
import type { StoredIngestFormat } from '../tables/store.js';
import { TryLaterError, type PipelineReading } from '../pipeline/types.js';
import { notRead, readFileWithAi, readingSpend, type AiReading, type NotReadReason } from './reader.js';
import type { ReaderOutput } from './schema.js';
import { logModelFailure } from '../model-failure.js';

export { readFileWithAi, notRead, type AiReading } from './reader.js';
export { AI_READER_MAX_CELLS } from './chunks.js';

/** Only output definitions, confirmed reading rules, and numbered cells enter the request. */
export function createAiReader(ctx: AppContext, person?: Actor) {
  return async function readWithAi(
    source: ExtractedSource,
    format: StoredIngestFormat,
    table: TableMeta,
    previousChecks?: PipelineReading['checks'],
    checkpoint?: (checks: NonNullable<PipelineReading['checks']>) => Promise<void>,
  ): Promise<AiReading> {
    const previous = readingSpend(previousChecks);
    const held = (reason: NotReadReason) => notRead(reason, previous.costUsd, previous.chunks);
    const { pool, schemas } = dataStore(ctx);
    const actor =
      person ??
      (table.ingest?.ownerId ? await actorFor(pool, schemas, table.ingest.ownerId, format.orgId) : null);
    if (!actor || actor.orgId !== format.orgId || !table.ingest) return held('aiOff');
    let settings = await settingsFor(ctx, actor.orgId, actor);
    if (!settings.enabled) return held('aiOff');
    if (!settings.ingest) return held('ingestOff');
    const imports = DocumentImportSettings.parse((await knowledgeSettings(ctx, actor)).imports ?? {});
    let ref = imports.localModel ?? imports.model;
    if (!ref) {
      for (const candidate of [
        ...REGISTRY,
        ...(settings.gateways ?? []).flatMap((gateway) =>
          gateway.models.flatMap((model) => {
            const known = registeredModel(settings, gateway.providerId, model.model);
            return known ? [known] : [];
          }),
        ),
      ]) {
        if (
          !candidate.tiers.includes('vision') ||
          !settings.providers.some((provider) => provider.providerId === candidate.providerId)
        )
          continue;
        try {
          if ((await connection(ctx, actor.orgId, candidate.providerId, settings)).available) {
            ref = candidate;
            break;
          }
        } catch {
          /* Another permitted vision provider may be available. */
        }
      }
    }
    if (!ref || !settings.providers.some((provider) => provider.providerId === ref.providerId))
      throw new TryLaterError('ingest.aiReader.providerUnavailable');
    let connected;
    try {
      connected = await connection(ctx, actor.orgId, ref.providerId, settings);
    } catch {
      throw new TryLaterError('ingest.aiReader.providerUnavailable');
    }
    if (!connected.available || (imports.localModel && !connected.adapter.local))
      throw new TryLaterError('ingest.aiReader.providerUnavailable');
    const model = ref;
    const fields = await loadFields(pool, schemas, [table.id]);
    const scope = new AccessScope(pool, schemas, actor);
    await scope.require(table.databaseId, 'read');
    if (scope.limitsRecords(table.id) || scope.visibleFields(table.id, fields).length !== fields.length)
      return held('classification');
    const output: ReaderOutput = {
      rowMeaning: table.ingest.rowMeaning,
      identity: table.ingest.identity,
      fields: table.ingest.fields.map((definition) => {
        const field = fields.find((field) => field.id === definition.fieldId);
        if (!field) throw new TryLaterError();
        return {
          key: definition.key,
          meaning: definition.meaning,
          required: definition.required,
          type: field.type,
          ...(field.type === 'singleSelect' || field.type === 'multipleSelect'
            ? { allowedValues: field.options.choices.map((choice) => choice.name) }
            : {}),
          ...(field.type === 'date' || field.type === 'dateRange'
            ? { includeTime: field.options.includeTime }
            : {}),
        };
      }),
    };
    if (
      fields.some(
        (field) =>
          table.ingest!.fields.some((definition) => definition.fieldId === field.id) &&
          (field.type === 'singleSelect' || field.type === 'multipleSelect') &&
          field.options.source,
      )
    )
      return held('dynamicChoices');
    const rules = (
      await new DecisionStore(pool, schemas).listRules({ orgId: format.orgId, tableId: table.id })
    )
      .filter(
        (rule) =>
          rule.enabled &&
          (rule.scope.type === 'table' || (rule.scope.type === 'format' && rule.scope.format === format.id)),
      )
      .map((rule) => ({ kind: rule.kind, condition: rule.condition, answer: rule.answer }));
    const ceilingUsd = settings.ingestFileLimitUsd;
    return readFileWithAi(source, format, output, {
      ceilingUsd,
      previousChecks,
      checkpoint,
      price: registeredModel(settings, model.providerId, model.model)?.price ?? undefined,
      notes: format.checks?.notes,
      rules,
      guard: async (): Promise<NotReadReason | null> => {
        settings = await settingsFor(ctx, actor.orgId, actor);
        if (!settings.enabled) return 'aiOff';
        if (!settings.ingest) return 'ingestOff';
        if (!settings.providers.some((provider) => provider.providerId === model.providerId))
          throw new TryLaterError('ingest.aiReader.providerUnavailable');
        if (
          settings.monthlyBudgetUsd !== null &&
          budgetReached(await spent(ctx, actor.orgId), settings.monthlyBudgetUsd)
        )
          throw new TryLaterError('ingest.aiReader.monthlyBudget');
        if (!connected.adapter.local) {
          const current = new AccessScope(pool, schemas, actor);
          await current.require(table.databaseId, 'read');
          if (!current.allowsUse(table.databaseId, 'provider', { tableId: table.id }))
            return 'classification';
        }
        return null;
      },
      request: (schema, request) =>
        requestSchemaOutput(ctx, actor, 'ingest', model, schema, request, (failure) =>
          logModelFailure(ctx.ingest!.app.log, 'aiReader', model.providerId, failure),
        ),
    });
  };
}
