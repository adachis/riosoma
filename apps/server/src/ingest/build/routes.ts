import { budgetReached } from '../../ai/budget.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  AppError,
  IngestBuild,
  IngestBuildAnswer,
  IngestDecisionQuestion,
  TableId,
  newId,
  type IngestBuildReason,
} from '@riosoma/contracts';
import {
  createQuestion,
  matchSignature,
  tableQuestionKind,
  type DecisionQuestion,
  type ExampleResult,
} from '@riosoma/ingest';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import { requireActor } from '../../auth/sessions.js';
import { parse } from '../../http/validate.js';
import type { Actor } from '../../http/policy.js';
import { refuseDemo } from '../../demo/boundary.js';
import { dataStore } from '../../data/context.js';
import { AccessScope } from '../../data/access.js';
import { loadTable } from '../../data/metadata.js';
import { changesChannel } from '../../data/notify.js';
import { loadOriginal } from '../../data/files/originals.js';
import type { CommandContext } from '../../data/commands/context.js';
import { runIngestSetupCommand } from '../../data/commands/ingest-setup.js';
import { connection, settingsFor, spent } from '../../ai/settings.js';
import { IngestTableStore } from '../tables/store.js';
import { requireEvidenceAccess, requireSettings, setupEvidence } from '../setup/evidence.js';
import { DecisionStore } from '../decisions/store.js';
import { pairFieldType, runFormatPairs } from '../pairs/index.js';
import { runReader, type ReaderFact } from '../readers/index.js';
import { buildFingerprint } from './evidence.js';
import { valueSources } from './provenance.js';
import { buildModel } from './model.js';
import { BuildCeiling, BuildRunner, BuildUnavailable, type Draft } from './runner.js';

const base = '/api/tables/:tableId/ingest/formats/:formatId/build';
const params = z.strictObject({ tableId: TableId, formatId: z.string().min(1).max(200) });
const session = { config: { policy: { kind: 'session' as const, beforeBody: true as const } } };
const active = (state: IngestBuild['state']) => ['queued', 'running', 'waiting'].includes(state);

/** Values are opt-in at the last read boundary, even when a build's owner has since lost access. */
export function buildResponse(status: IngestBuild, evidence: boolean): IngestBuild {
  if (evidence) return { ...status, evidenceWithheld: false };
  return {
    id: status.id,
    tableId: status.tableId,
    formatId: status.formatId,
    state: status.state,
    attempts: status.attempts,
    reading: status.reading,
    spentUsd: status.spentUsd,
    needsExample: status.needsExample,
    offersAi: status.offersAi,
    reason: status.reason,
    examples: status.examples.map(({ result: _result, ...counts }) => counts),
    evidenceWithheld: true,
  };
}

export async function ingestBuildRoutes(app: FastifyInstance) {
  const running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  const announced = new Map<string, IngestBuild['state']>();
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });
  app.addHook('onClose', async () => {
    for (const job of running.values()) job.controller.abort();
    await Promise.allSettled([...running.values()].map((job) => job.done));
  });
  async function access(actor: Actor, tableId: string, schema = false) {
    refuseDemo(actor);
    const { pool, schemas } = dataStore(app.ctx);
    const table = await loadTable(pool, schemas, tableId);
    if (!table || table.orgId !== actor.orgId || table.trashed)
      throw new AppError('not_found', 'errors.notFound');
    const c: CommandContext = {
      db: pool,
      schemas,
      actor,
      databaseId: table.databaseId,
      appContext: app.ctx,
      fileConfig: app.ctx.config,
    };
    await new AccessScope(pool, schemas, actor).require(table.databaseId, schema ? 'editSchema' : 'read');
    const settings = requireSettings(table.ingest);
    return { c, table, settings, context: { ...actor, tableId } };
  }
  async function latest(actor: Actor, tableId: string, formatId: string) {
    const { pool, schemas } = dataStore(app.ctx);
    const found = await query<{ status: IngestBuild; user_id: string }>(
      pool,
      sql`SELECT status, user_id
      FROM ${ident(schemas.app, 'ingest_builds')} WHERE org_id = ${actor.orgId} AND table_id = ${tableId}
      AND format_id = ${formatId} ORDER BY created_at DESC, id DESC LIMIT 1`,
    );
    if (!found.rows[0]) throw new AppError('not_found', 'errors.notFound');
    return { status: IngestBuild.parse(found.rows[0].status), userId: found.rows[0].user_id };
  }
  async function buildQuestion(actor: Actor, tableId: string, id: string) {
    const { pool, schemas } = dataStore(app.ctx);
    const result = await query<{ document: object; active: boolean }>(
      pool,
      sql`SELECT document, active
      FROM ${ident(schemas.app, 'ingest_questions')} WHERE org_id = ${actor.orgId} AND table_id = ${tableId} AND id = ${id}`,
    );
    if (!result.rows[0]) throw new AppError('not_found', 'errors.notFound');
    return IngestDecisionQuestion.parse({
      ...result.rows[0].document,
      orgId: actor.orgId,
      tableId,
      active: result.rows[0].active,
    });
  }
  async function evidence(c: CommandContext, tableId: string) {
    try {
      await requireEvidenceAccess(c, tableId);
      return true;
    } catch (error) {
      if (error instanceof AppError && error.code === 'forbidden') return false;
      throw error;
    }
  }
  async function persist(databaseId: string, actor: Actor, status: IngestBuild, draft: Draft | null) {
    const { pool, schemas } = dataStore(app.ctx);
    // A cancel in another server process remains authoritative over late model output.
    const saved = await query<{ state: IngestBuild['state'] }>(
      pool,
      sql`UPDATE ${ident(schemas.app, 'ingest_builds')}
      SET status = jsonb_set(${JSON.stringify(status)}::jsonb, '{state}', to_jsonb(CASE WHEN state = 'canceled' THEN 'canceled' ELSE ${status.state} END)),
      state = CASE WHEN state = 'canceled' THEN 'canceled' ELSE ${status.state} END,
      draft = CASE WHEN state = 'canceled' THEN draft ELSE ${draft ? JSON.stringify(draft) : null}::jsonb END,
      updated_at = now() WHERE id = ${status.id} AND org_id = ${actor.orgId} RETURNING state`,
    );
    if (!saved.rows[0]) return;
    status.state = saved.rows[0].state;
    if (announced.get(status.id) !== status.state) {
      await query(
        pool,
        sql`SELECT pg_notify(${changesChannel(schemas)}, ${JSON.stringify({
          type: 'ingestChanged',
          databaseId,
          tableId: status.tableId,
          kind: 'build',
          id: status.id,
          state: status.state,
        })})`,
      );
      announced.set(status.id, status.state);
    }
  }
  app.get(base, session, async (request) => {
    const actor = requireActor(request);
    const { tableId, formatId } = parse(params, request.params);
    const a = await access(actor, tableId);
    const { status } = await latest(actor, tableId, formatId);
    const allowed = await evidence(a.c, tableId);
    if (allowed && status.questionId)
      status.question = await buildQuestion(actor, tableId, status.questionId);
    return buildResponse(status, allowed);
  });
  app.post(`${base}/answer`, session, async (request) => {
    const { pool, schemas } = dataStore(app.ctx);
    const decisions = new DecisionStore(pool, schemas);
    const actor = requireActor(request);
    const { tableId, formatId } = parse(params, request.params);
    const input = parse(IngestBuildAnswer, request.body);
    const a = await access(actor, tableId);
    await new AccessScope(pool, schemas, actor).require(a.table.databaseId, 'editRecords');
    await requireEvidenceAccess(a.c, tableId);
    const { status } = await latest(actor, tableId, formatId);
    if (
      (status.state !== 'waiting' && !(status.state === 'stopped' && status.reason === 'attempts')) ||
      !status.questionId
    )
      throw new AppError('conflict', 'ingest.build.finished');
    const question = await buildQuestion(actor, tableId, status.questionId);
    const answer = await withTransaction(pool, async (db) => {
      const saved = await decisions.inTransaction(db).answerQuestion(
        { ...a.context, canEditRecords: true, canEditSchema: false },
        {
          questionId: question.id,
          questionVersion: input.questionVersion,
          response: input.response,
        },
      );
      if (saved.status === 'stale') throw new AppError('conflict', saved.messageId);
      if (input.fact !== undefined)
        await query(
          db,
          sql`UPDATE ${ident(schemas.app, 'ingest_builds')} SET facts = facts || ${JSON.stringify({ [question.id]: input.fact })}::jsonb
          WHERE id = ${status.id} AND org_id = ${actor.orgId} AND state IN ('waiting', 'stopped')`,
        );
      return saved.answer;
    });
    return answer;
  });
  app.post(`${base}/cancel`, session, async (request) => {
    const { pool, schemas } = dataStore(app.ctx);
    const actor = requireActor(request);
    const { tableId, formatId } = parse(params, request.params);
    const a = await access(actor, tableId);
    const { status, userId } = await latest(actor, tableId, formatId);
    if (userId !== actor.userId) throw new AppError('forbidden', 'ingest.build.owner');
    if (active(status.state)) {
      const canceled = await query(
        pool,
        sql`UPDATE ${ident(schemas.app, 'ingest_builds')}
        SET state = 'canceled', status = jsonb_set(status, '{state}', '"canceled"'::jsonb), updated_at = now()
        WHERE id = ${status.id} AND org_id = ${actor.orgId} AND state IN ('queued', 'running', 'waiting') RETURNING id`,
      );
      if (!canceled.rowCount)
        return buildResponse((await latest(actor, tableId, formatId)).status, await evidence(a.c, tableId));
      const job = running.get(status.id);
      job?.controller.abort();
      if (job) await job.done;
      else {
        status.state = 'canceled';
        await persist(a.table.databaseId, actor, status, null);
      }
    }
    return buildResponse((await latest(actor, tableId, formatId)).status, await evidence(a.c, tableId));
  });
  app.post(base, session, async (request, reply) => {
    const { pool, schemas } = dataStore(app.ctx);
    const store = new IngestTableStore(pool, schemas);
    const decisions = new DecisionStore(pool, schemas);
    const actor = requireActor(request);
    const { tableId, formatId } = parse(params, request.params);
    const a = await access(actor, tableId, true);
    await requireEvidenceAccess(a.c, tableId);
    const format = await store.readFormat(a.context, formatId);
    if (!format) throw new AppError('not_found', 'errors.notFound');
    const existing = await query(
      pool,
      sql`SELECT id FROM ${ident(schemas.app, 'ingest_builds')}
      WHERE org_id = ${actor.orgId} AND table_id = ${tableId} AND format_id = ${formatId}
      AND state IN ('queued', 'running', 'waiting')`,
    );
    if (existing.rowCount) throw new AppError('conflict', 'ingest.build.busy');
    const all = await store.listExamples(a.context, formatId);
    const files = await store.listFiles(a.context);
    const complete = all.filter((example) => {
      const file = files.find((file) => file.id === example.fileId);
      return (
        example.expected.length > 0 &&
        file?.storedFile &&
        (!file.expiresAt || Date.parse(file.expiresAt) > Date.now())
      );
    });
    const unique = complete.filter(
      (example, index) =>
        complete.findIndex((other) => {
          const file = files.find((file) => file.id === example.fileId);
          const otherFile = files.find((file) => file.id === other.fileId);
          return file?.sha256 === otherFile?.sha256;
        }) === index,
    );
    if (unique.length < 3)
      throw new AppError('validation_failed', 'ingest.build.examples', {
        params: { have: unique.length, need: 3 },
      });
    const blind = [...unique]
      .filter((example) => !example.builderShown)
      .sort(
        (left, right) =>
          Date.parse(right.confirmedAt) - Date.parse(left.confirmedAt) || right.id.localeCompare(left.id),
      )[0];
    if (!blind) throw new AppError('validation_failed', 'ingest.build.oneMore');
    const status: IngestBuild = {
      id: randomUUID(),
      tableId,
      formatId,
      state: 'queued',
      attempts: 0,
      reading: null,
      spentUsd: 0,
      examples: [],
      needsExample: false,
      offersAi: false,
      evidenceWithheld: false,
    };
    const inserted = await query(
      pool,
      sql`INSERT INTO ${ident(schemas.app, 'ingest_builds')}
      (id, org_id, table_id, format_id, user_id, state, status) VALUES
      (${status.id}, ${actor.orgId}, ${tableId}, ${formatId}, ${actor.userId}, 'queued', ${JSON.stringify(status)}::jsonb)
      ON CONFLICT DO NOTHING`,
    );
    if (!inserted.rowCount) throw new AppError('conflict', 'ingest.build.busy');
    await persist(a.table.databaseId, actor, status, null);
    const controller = new AbortController();
    const signal = controller.signal;
    const watching = new AbortController();
    // Stored cancellation reaches the owning worker even while a provider call is blocked.
    // Polling also works when a transaction pooler has no dedicated notification connection.
    const cancellation = (async () => {
      try {
        while (!signal.aborted) {
          await delay(250, undefined, { signal: watching.signal });
          const saved = await latest(actor, tableId, formatId);
          if (saved.status.id !== status.id || saved.status.state === 'canceled') controller.abort();
        }
      } catch (error) {
        if (!watching.signal.aborted && !signal.aborted) controller.abort(error);
      }
    })();
    const done = (async () => {
      // Yield before model preparation so the POST can return its queued receipt immediately.
      await delay(0);
      try {
        const ai = await settingsFor(app.ctx, actor.orgId, actor);
        const model = ai.enabled && ai.ingest ? await buildModel(app, actor, ai, signal) : null;
        const gate = async (): Promise<IngestBuildReason | null> => {
          signal.throwIfAborted();
          const saved = await latest(actor, tableId, formatId);
          if (saved.status.id !== status.id || saved.status.state === 'canceled') {
            controller.abort();
            signal.throwIfAborted();
          }
          const current = await settingsFor(app.ctx, actor.orgId, actor);
          if (!current.enabled) return 'aiOff';
          if (!current.ingest) return 'ingestOff';
          if (status.spentUsd >= current.ingestBuildLimitUsd) throw new BuildCeiling();
          if (
            current.monthlyBudgetUsd !== null &&
            budgetReached(await spent(app.ctx, actor.orgId), current.monthlyBudgetUsd)
          )
            return 'budgetSpent';
          if (!model || !current.providers.some((entry) => entry.providerId === model.model.ref.providerId))
            return 'providerDown';
          if (!(await connection(app.ctx, actor.orgId, model.model.ref.providerId, current)).available)
            return 'providerDown';
          try {
            const fresh = await access(
              { ...actor, ...(model.model.adapter.local ? {} : { dataUse: 'provider' as const }) },
              tableId,
              true,
            );
            await requireEvidenceAccess(fresh.c, tableId);
          } catch (error) {
            if (error instanceof AppError && error.code === 'forbidden') return 'classification';
            throw error;
          }
          return null;
        };
        const reason = await gate();
        if (reason) {
          status.state = 'unavailable';
          status.reason = reason;
          status.messageId = `ingest.build.${reason}`;
          await persist(a.table.databaseId, actor, status, null);
          return;
        }
        const snapshot = await setupEvidence(a.c, tableId, a.settings);
        const buildExamples = unique.filter((example) => example.id !== blind.id);
        if (unique.some((example) => !snapshot.sources.has(example.id)))
          throw new AppError('unavailable', 'ingest.build.original');
        const fieldTypes = Object.fromEntries(
          a.settings.fields.map((field) => [
            field.key,
            pairFieldType(snapshot.fields.find((item) => item.id === field.fieldId) ?? { type: 'text' }),
          ]),
        );
        const readPair = async (
          draft: Draft,
          example: typeof blind,
          facts: Parameters<typeof runReader>[3],
        ): Promise<ExampleResult> => {
          signal.throwIfAborted();
          const pair = await runFormatPairs(
            { id: tableId, ingest: a.settings },
            { ...format, ...draft },
            [example],
            {
              actor: a.context,
              fieldTypes,
              store: {
                readFile: (context, id) => store.readFile(context, id),
                updateExample: async () => example,
              },
              loadOriginal: (file) => loadOriginal(pool, schemas.app, app.ctx.config, file),
              readWithReader: async (source, definition) => {
                if (definition.reading !== 'reader')
                  throw new AppError('validation_failed', 'ingest.build.invalidRules');
                const read = await runReader(source, definition.rules.code, {}, facts, {
                  signal,
                  bindings: definition.rules.bindings,
                  anonymousSheets: true,
                });
                if (read.status !== 'read') throw new AppError('validation_failed', read.messageKey);
                return read.rows;
              },
            },
          );
          return pair.examples[0]!.result;
        };
        const questions = new Map<string, DecisionQuestion>();
        const runner = new BuildRunner(status, {
          signal,
          ceilingUsd: ai.ingestBuildLimitUsd,
          fields: a.settings.fields.map(({ key, required }) => ({ key, required })),
          gate,
          call: model!.call,
          examples: buildExamples.map((example) => ({
            id: example.id,
            source: snapshot.sources.get(example.id)!,
            expected: example.expected,
          })),
          shown: async (id) => {
            await store.updateExample(a.context, id, { builderShown: true });
          },
          validateSignature: async (draft) =>
            !snapshot.examples.some(
              (example) =>
                example.formatId !== formatId &&
                snapshot.sources.has(example.id) &&
                matchSignature(snapshot.sources.get(example.id)!, draft.signature),
            ),
          test: async (draft, facts) => {
            for (const example of buildExamples)
              await store.updateExample(a.context, example.id, { builderShown: true });
            const results = [];
            for (const example of buildExamples) {
              const result = await readPair(draft, example, facts);
              if (!matchSignature(snapshot.sources.get(example.id)!, draft.signature))
                results.push({
                  exampleId: example.id,
                  result: {
                    passed: false,
                    differences: result.differences,
                    failure: { kind: 'read-failed' as const, messageId: 'ingest.pairs.ownSignatureMissing' },
                  },
                });
              else results.push({ exampleId: example.id, result });
            }
            return results;
          },
          question: async ({ fieldKey, kind, choices }) => {
            const question = createQuestion(
              tableQuestionKind(
                `build-${kind}`,
                kind === 'valueSource' ? 'ingest.build.valueSource' : 'ingest.build.unresolved',
                'choices',
              ),
              {
                key: `${status.id}:${fieldKey}:${kind}`,
                values: [],
                evidence: [{ file: buildExamples[0]!.fileId, column: fieldKey, examples: [] }],
                target: { type: 'field', file: buildExamples[0]!.fileId, field: fieldKey, rows: [] },
                exits: ['skipFile'],
                form: {
                  type: 'choices',
                  choices: choices.map((id) => ({
                    id,
                    messageId: [
                      'fixed',
                      'lookup',
                      'email',
                      'person',
                      'correctRules',
                      'correctExample',
                    ].includes(id)
                      ? `ingest.build.${id}`
                      : 'ingest.build.choice',
                    params: { choice: id, field: fieldKey, difference: kind },
                  })),
                },
              },
              { format: formatId },
            );
            await decisions.raiseQuestion(a.context, question);
            questions.set(question.id, question);
            return question.id;
          },
          answer: async (id) => {
            while (!signal.aborted) {
              const unavailable = await gate();
              if (unavailable) throw new BuildUnavailable(unavailable);
              const answer = await decisions.findAnswer(a.context, id);
              if (answer && answer.questionVersion === questions.get(id)?.version) {
                const savedFacts = await query<{ facts: Record<string, ReaderFact> }>(
                  pool,
                  sql`SELECT facts FROM ${ident(schemas.app, 'ingest_builds')} WHERE id = ${status.id} AND org_id = ${actor.orgId}`,
                );
                return answer.response.type === 'answer'
                  ? (savedFacts.rows[0]?.facts[id] ?? answer.response.answer.value)
                  : undefined;
              }
              await delay(250, undefined, { signal });
            }
            signal.throwIfAborted();
            return undefined;
          },
          finalize: async (draft, facts, results) => {
            signal.throwIfAborted();
            const result = await readPair(draft, blind, facts);
            signal.throwIfAborted();
            if (!matchSignature(snapshot.sources.get(blind.id)!, draft.signature)) {
              result.passed = false;
              result.failure = { kind: 'read-failed', messageId: 'ingest.pairs.ownSignatureMissing' };
            }
            const outcomes = [...results, { exampleId: blind.id, result }];
            const examples = outcomes.map(({ exampleId, result }) => ({
              exampleId,
              passed: result.passed,
              differenceCount: result.differences.length,
              result: { ...result, differences: result.differences.slice(0, 20) },
            }));
            if (!result.passed) {
              await store.updateExample(a.context, blind.id, { builderShown: true });
              const failures = await query<{ blind_failures: number }>(
                pool,
                sql`UPDATE ${ident(schemas.app, 'ingest_formats')}
                SET blind_failures = blind_failures + 1 WHERE org_id = ${actor.orgId} AND table_id = ${tableId} AND id = ${formatId} RETURNING blind_failures`,
              );
              return {
                state: 'blindFailed',
                examples,
                needsExample: true,
                offersAi: failures.rows[0]!.blind_failures >= 2,
              };
            }
            signal.throwIfAborted();
            const savedRules = draft.reading === 'reader' ? { ...draft.rules, facts } : draft.rules;
            const saved = await runIngestSetupCommand(
              app,
              actor,
              {
                id: newId('command'),
                kind: 'ingest.format.rules',
                tableId,
                formatId,
                revision: format.revision,
                reading: draft.reading,
                signature: draft.signature,
                rules: savedRules,
              },
              'person',
              {
                buildId: status.id,
                status: { ...status, state: 'passed', examples, needsExample: false, offersAi: false },
                fingerprint: buildFingerprint(a.settings, snapshot.examples, snapshot.files, snapshot.fields),
                pairs: { passed: true, examples: outcomes },
                sources: valueSources(
                  draft,
                  a.settings.fields.map((field) => field.key),
                ),
              },
            );
            if (saved.status === 'rejected') {
              status.reason = 'stale';
              status.messageId = 'ingest.build.stale';
              return { state: 'stopped', examples, needsExample: false, offersAi: false };
            }
            return { state: 'passed', examples, needsExample: false, offersAi: false };
          },
          changed: (state, draft) => persist(a.table.databaseId, actor, state, draft),
        });
        await runner.run();
      } catch (error) {
        status.state = signal.aborted
          ? 'canceled'
          : error instanceof BuildCeiling
            ? 'ceiling'
            : 'unavailable';
        status.reason = signal.aborted || error instanceof BuildCeiling ? undefined : 'providerDown';
        status.messageId = signal.aborted
          ? undefined
          : error instanceof BuildCeiling
            ? 'ingest.build.ceiling'
            : 'ingest.build.providerDown';
        await persist(a.table.databaseId, actor, status, null);
      }
    })().finally(async () => {
      watching.abort();
      await cancellation;
      running.delete(status.id);
      announced.delete(status.id);
    });
    running.set(status.id, { controller, done });
    reply.code(202);
    return status;
  });
}
