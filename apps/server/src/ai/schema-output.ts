import { budgetReached } from './budget.js';
import { createRequire } from 'node:module';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import {
  schemaOutput,
  type ChatRequest,
  type OutputSchema,
  type SchemaOutputResult,
  type ProviderFailure,
} from '@riosoma/ai';
import type { AiFeature, ModelRef } from '@riosoma/contracts';
import { withTransaction } from '@riosoma/db';
import type { AppContext } from '../app.js';
import { dataStore } from '../data/context.js';
import { refuseDemo } from '../demo/boundary.js';
import type { Actor } from '../http/policy.js';
import { recordSpend } from './conversations.js';
import { estimateCall, recordAiUse, zoneFor } from './footprint.js';
import { registeredModel } from './gateway-config.js';
import { connection, settingsFor, spent } from './settings.js';

interface JsonSchemaError {
  keyword: string;
  instancePath: string;
}

interface JsonSchemaEngine {
  compile<T>(schema: Record<string, unknown>): {
    (value: unknown): value is T;
    errors?: readonly JsonSchemaError[] | null;
  };
  errorsText(errors: readonly JsonSchemaError[]): string;
}

function validationPath(pointer: string, value: unknown): PropertyKey[] {
  if (!pointer) return [];
  let current = value;
  return pointer
    .slice(1)
    .split('/')
    .map((part) => {
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
      const segment = Array.isArray(current) ? Number(key) : key;
      current =
        current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined;
      return segment;
    });
}

/** JSON Schema validation is the default.  A caller can retain its original schema's refinements. */
export function outputSchema<T>(
  jsonSchema: Record<string, unknown>,
  validate?: OutputSchema<T>['validate'],
): OutputSchema<T> {
  if (validate) return { jsonSchema, validate };
  if (
    jsonSchema.$schema === 'https://json-schema.org/draft/2020-12/schema' ||
    jsonSchema.$schema === 'https://json-schema.org/draft/2020-12/schema#'
  ) {
    // Resolve the installed validation engine through the SDK that owns it.
    const requireValidation = createRequire(import.meta.resolve('@modelcontextprotocol/sdk/validation/ajv'));
    const { Ajv2020 } = requireValidation('ajv/dist/2020.js') as {
      Ajv2020: new (options: {
        strict: boolean;
        allErrors: boolean;
        validateFormats: boolean;
      }) => JsonSchemaEngine;
    };
    const addFormats = requireValidation('ajv-formats') as (engine: JsonSchemaEngine) => void;
    const engine = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
    addFormats(engine);
    // Compile the original schema so references, their siblings, and annotations retain their meaning.
    const check = engine.compile<T>(jsonSchema);
    return {
      jsonSchema,
      validate: (value) =>
        check(value)
          ? { valid: true, data: value }
          : {
              valid: false,
              errors: (check.errors ?? []).map((error) => ({
                code: error.keyword === 'type' ? 'invalid_type' : error.keyword,
                path: validationPath(error.instancePath, value),
                detail: engine.errorsText([error]),
              })),
            },
    };
  }
  const check = new AjvJsonSchemaValidator().getValidator<T>(jsonSchema);
  return {
    jsonSchema,
    validate: (value) => {
      const result = check(value);
      return result.valid
        ? { valid: true, data: result.data! }
        : { valid: false, errors: [{ code: 'schema', path: [], detail: result.errorMessage }] };
    },
  };
}

/** Records the single attempt, including unsuccessful output, under the caller's feature. */
export async function requestSchemaOutput<T>(
  ctx: AppContext,
  actor: Actor,
  feature: AiFeature,
  ref: ModelRef,
  schema: OutputSchema<T>,
  request: Omit<ChatRequest, 'model'>,
  onFailure?: (failure: ProviderFailure) => void,
): Promise<SchemaOutputResult<T> & { costUsd?: number | null }> {
  refuseDemo(actor);
  const unavailable = (): SchemaOutputResult<T> => ({
    ok: false,
    reason: 'unavailable',
    usage: { inputTokens: 0, outputTokens: 0, reported: false, outputCharacters: 0, ms: 0, started: false },
  });
  const settings = await settingsFor(ctx, actor.orgId, actor);
  if (
    !settings.enabled ||
    (feature === 'ingest' && !settings.ingest) ||
    !settings.providers.some((entry) => entry.providerId === ref.providerId) ||
    (settings.monthlyBudgetUsd !== null &&
      budgetReached(await spent(ctx, actor.orgId), settings.monthlyBudgetUsd))
  )
    return unavailable();
  let connected;
  try {
    connected = await connection(ctx, actor.orgId, ref.providerId, settings);
  } catch {
    return unavailable();
  }
  if (!connected.available) return unavailable();
  const model = registeredModel(settings, ref.providerId, ref.model);
  const result = await schemaOutput(connected.adapter, connected.config, schema, {
    ...request,
    model: ref.model,
  });
  if (result.failure) onFailure?.(result.failure);
  // Failed attempts without reported usage provide no evidence of billable consumption.
  if (!result.usage.started || (!result.ok && !result.usage.reported)) return { ...result, costUsd: 0 };
  const reported = result.usage.reported;
  const inputTokens = reported
    ? result.usage.inputTokens
    : Math.ceil(JSON.stringify({ request, schema: schema.jsonSchema }).length / 4);
  const outputTokens = reported ? result.usage.outputTokens : Math.ceil(result.usage.outputCharacters / 4);
  const price = model?.price;
  const costUsd = price ? (inputTokens * price.input + outputTokens * price.output) / 1_000_000 : null;
  const { pool, schemas } = dataStore(ctx);
  const estimateRef = settings.gateways
    ?.find((gateway) => gateway.providerId === ref.providerId)
    ?.models.find((entry) => entry.model === ref.model)?.mapping;
  await withTransaction(pool, async (db) => {
    await recordSpend(db, schemas, actor.orgId, costUsd);
    await recordAiUse(db, schemas, {
      orgId: actor.orgId,
      userId: actor.userId,
      feature,
      usage: {
        ...ref,
        inputTokens,
        outputTokens,
        costUsd,
        tokensEstimated: !reported,
        footprint: estimateCall(
          { ...ref, outputTokens, ms: result.usage.ms, estimateRef },
          zoneFor(ctx, settings),
        ),
      },
    });
  });
  return { ...result, costUsd };
}
