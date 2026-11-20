import { IngestRowReason, IngestRowState, type IngestFile, type TableMeta } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { pairValuesEqual, text } from '@riosoma/ingest';
import { loadTable } from '../../data/metadata.js';
import { currentValues } from '../../data/physical/records.js';
import { sourceChoices } from '../../data/select-options.js';
import { pairFieldType } from '../pairs/index.js';
import { checkOutputValue, type CheckContext } from './check.js';
import {
  applyMutations,
  joinReasons,
  reasonNote,
  safePatch,
  snapshot,
  withoutFileContribution,
  type RowMutation,
} from './mutations.js';
import {
  BATCH_SIZE,
  WriterStopped,
  addResult,
  emptyResult,
  hashValue,
  keyedValues,
  locked,
  readCheckpoint,
  readFile,
  readRecords,
  readStates,
  releaseIdentityReservations,
  rowIdentity,
  saveCheckpoint,
  saveCounts,
  saveStates,
  stableId,
  type Environment,
} from './storage.js';
import type { Disagreement, IdentityChoice, WriteResult, WriteRow, WriterServices } from './types.js';
export type * from './types.js';

interface PreparedRow {
  row: number;
  input: WriteRow;
  values: Record<string, unknown>;
  identity: string | null;
  reasons: IngestRowReason[];
}
interface RowOutcome {
  result: WriteResult;
  settled: boolean;
}
interface WriteProgress {
  outcomes: Record<number, RowOutcome>;
  tableOnly: number;
}
function progressResult(progress: WriteProgress, undoGroupId: string) {
  const result = emptyResult(undoGroupId);
  result.comparison.tableOnly = progress.tableOnly;
  for (const outcome of Object.values(progress.outcomes)) addResult(result, outcome.result);
  return result;
}
const formatHash = (env: Environment) =>
  hashValue({
    settings: env.settings,
    fields: [...env.byKey]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, field]) => ({ key, id: field.id, type: field.type, options: field.options })),
  });
async function checkContext(env: Environment, rows: readonly WriteRow[]): Promise<CheckContext> {
  const choices: Map<string, Map<string, string | null>> = new Map();
  const links = new Map<string, Set<string>>();
  for (const definition of env.settings.fields) {
    const field = env.byKey.get(definition.key)!;
    const items = rows
      .flatMap((row) => {
        const value = Object.hasOwn(row.values, definition.key) ? row.values[definition.key] : null;
        return Array.isArray(value) ? value : [value];
      })
      .filter((item): item is string => typeof item === 'string');
    if (field.type === 'singleSelect' || field.type === 'multipleSelect') {
      const allowed = [...field.options.choices];
      if (field.options.source) {
        const offered = [...new Set(items)];
        for (let start = 0; start < offered.length; start += BATCH_SIZE) {
          const part = offered.slice(start, start + BATCH_SIZE);
          allowed.push(...(await sourceChoices(env.db, env.schemas, env.scope, field, { names: part })));
          allowed.push(...(await sourceChoices(env.db, env.schemas, env.scope, field, { ids: part })));
        }
      }
      const map = new Map<string, string | null>();
      for (const option of allowed) {
        const name = text(option.name).value!;
        if (!map.has(name)) map.set(name, option.id);
        else if (map.get(name) !== option.id) map.set(name, null);
      }
      for (const option of allowed) map.set(option.id, option.id);
      choices.set(field.id, map);
    }
    if (field.type === 'link') {
      const found = new Set<string>();
      const target = await loadTable(env.db, env.schemas, field.options.linkedTableId);
      if (
        target &&
        !target.trashed &&
        target.orgId === env.actor.orgId &&
        (await env.scope.databaseRole(target.databaseId))
      ) {
        await env.scope.prepare(target.databaseId);
        const result = await query<{ __id: string }>(
          env.db,
          sql`SELECT __id FROM ${ident(env.schemas.data, target.id)}
          WHERE __id = ANY(${[...new Set(items)]}::text[]) AND __deleted_at IS NULL
            AND (${env.scope.recordPredicate(target.id)})`,
        );
        for (const row of result.rows) found.add(row.__id);
      }
      links.set(field.id, found);
    }
  }
  return { choices, links };
}
function prepare(env: Environment, rows: readonly WriteRow[], context: CheckContext): PreparedRow[] {
  return rows.map((input, row) => {
    const reasons = input.reasons.map((reason) => IngestRowReason.parse(reason));
    const suppressed = new Set(
      reasons.flatMap((reason) =>
        reason.fieldKey && reason.source.kind === 'question' ? [reason.fieldKey] : [],
      ),
    );
    const values: Record<string, unknown> = {};
    for (const definition of env.settings.fields) {
      const checked = checkOutputValue(
        env.byKey.get(definition.key)!,
        definition.key,
        suppressed.has(definition.key)
          ? null
          : Object.hasOwn(input.values, definition.key)
            ? input.values[definition.key]
            : null,
        definition.required,
        context,
        input.reasons.some((reason) => reason.source.kind === 'model' && reason.fieldKey === definition.key),
      );
      values[definition.key] = checked.value;
      reasons.push(...checked.reasons);
    }
    // Without an identity, every row of a new run is added.  The caller checks duplicate files
    // before starting that run.  Command IDs protect interrupted retries of the same run only.
    return { input, row, values, reasons: joinReasons([], reasons), identity: rowIdentity(env, values) };
  });
}
function processValues(services: WriterServices, file: IngestFile, row: PreparedRow) {
  const parts = [file.name];
  for (const key of ['sheet', 'table', 'page', 'line', 'row'] as const) {
    const value = row.input.at[key];
    if (value !== undefined) parts.push(services.message(`ingest.write.source.${key}`, { value }));
  }
  return {
    needsReview: row.reasons.length > 0,
    reviewNote: reasonNote(services, row.reasons),
    readByAi: row.input.aiFields.length > 0,
    source: parts.join(', '),
    received: file.receivedAt,
  };
}
function baseState(
  env: Environment,
  recordId: string,
  fileId: string,
  identity: string | null,
  values: Record<string, unknown>,
) {
  return IngestRowState.parse({
    orgId: env.actor.orgId,
    tableId: env.table.id,
    recordId,
    fileId,
    identity,
    hashes: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, hashValue(value)])),
    values,
  });
}
function indexRecords(
  env: Environment,
  records: Map<string, Record<string, unknown>>,
  states: Map<string, IngestRowState>,
) {
  const index = new Map<string, Set<string>>();
  for (const [id, values] of records) {
    for (const identity of [rowIdentity(env, values), states.get(id)?.identity]) {
      if (!identity) continue;
      const group = index.get(identity) ?? new Set();
      group.add(id);
      index.set(identity, group);
    }
  }
  return index;
}
function stopped(result: WriteResult, error: unknown): WriteResult {
  if (!(error instanceof WriterStopped)) throw error;
  return { ...result, status: 'stopped', messageId: error.messageId };
}

/** Only this internal entry point turns decided file rows into owner-attributed record commands. */
export async function writeIngestRows(
  table: TableMeta,
  fileId: string,
  runId: string,
  rows: readonly WriteRow[],
  services: WriterServices,
  choices: Readonly<Record<string, IdentityChoice>> = {},
): Promise<WriteResult> {
  const result = emptyResult(stableId('act', table.id, fileId, 'write'));
  const operation = `write:${hashValue(services.checkpointInputId ? [choices, rows] : choices)}`;
  const inputHash = services.checkpointInputId ?? hashValue(rows);
  try {
    let initial = await locked(services, table, async (env) => {
      const file = await readFile(env, fileId);
      const previous = await query<{ input_hash: string }>(
        env.db,
        sql`SELECT input_hash FROM ${ident(env.schemas.app, 'ingest_write_batches')}
        WHERE org_id = ${env.actor.orgId} AND table_id = ${table.id} AND file_id = ${fileId} AND run_id = ${runId}
          AND operation LIKE 'write:%' LIMIT 1`,
      );
      if (previous.rows[0] && previous.rows[0].input_hash !== inputHash)
        throw new WriterStopped('ingest.write.changedRun');
      const prepared = prepare(env, rows, await checkContext(env, rows));
      return {
        file,
        prepared,
        settingsHash: formatHash(env),
        version: env.table.dataVersion,
        records: env.settings.identity ? await readRecords(env) : new Map<string, Record<string, unknown>>(),
        states: await readStates(env),
      };
    });
    const groups = new Map<string, number[]>();
    for (const row of initial.prepared) {
      if (row.identity && !row.input.held) {
        const group = groups.get(row.identity) ?? [];
        group.push(row.row);
        groups.set(row.identity, group);
      }
    }
    const count = Math.max(1, Math.ceil(rows.length / BATCH_SIZE));
    if (
      services.requireAllDecisions &&
      initial.file.counts.added + initial.file.counts.updated + initial.file.counts.identical === 0
    ) {
      const pending = await locked(services, table, async (env) => {
        if (initial.version !== env.table.dataVersion) {
          initial.records = env.settings.identity ? await readRecords(env) : initial.records;
          initial.states = await readStates(env);
          initial.version = env.table.dataVersion;
        }
        const index = indexRecords(env, initial.records, initial.states);
        const findings: Disagreement[] = [];
        for (const row of initial.prepared) {
          if (!row.identity || row.input.held || Object.hasOwn(choices, row.identity)) continue;
          const repeated = groups.get(row.identity)!;
          if (row.row !== repeated[0]) continue;
          const ids = [...(index.get(row.identity) ?? [])];
          const ambiguous = repeated.length > 1 || ids.length > 1;
          const different =
            ids.length === 1 &&
            env.settings.fields.some(
              (field) =>
                !pairValuesEqual(
                  row.values[field.key],
                  initial.records.get(ids[0]!)![field.key],
                  pairFieldType(env.byKey.get(field.key)!),
                ),
            );
          if (!ambiguous && !different) continue;
          findings.push({
            identity: row.identity,
            kind:
              repeated.length > 1
                ? 'repeated-file-identity'
                : ids.length > 1
                  ? 'repeated-table-identity'
                  : 'different',
            messageId:
              repeated.length > 1
                ? 'ingest.write.repeatedFileIdentity'
                : ids.length > 1
                  ? 'ingest.write.repeatedTableIdentity'
                  : 'ingest.write.different',
            rows: repeated,
            records: ids.map((id) => ({ id, values: initial.records.get(id)! })),
          });
        }
        return findings;
      });
      if (pending.length) return { ...result, status: 'disagreement', disagreements: pending };
    }
    for (let batch = 0; batch < count; batch += 1) {
      const part = await locked(services, table, async (env) => {
        const file = await readFile(env, fileId);
        if (formatHash(env) !== initial.settingsHash) throw new WriterStopped('ingest.write.changedRun');
        const checkpoint = { fileId, runId, operation, inputHash, batch };
        const progressKey = { ...checkpoint, operation: 'write:outcomes' };
        const progress = (await readCheckpoint<WriteProgress>(env, progressKey)) ?? {
          outcomes: {},
          tableOnly: 0,
        };
        const cached = await readCheckpoint<WriteResult>(env, checkpoint);
        if (cached)
          return { result: progressResult(progress, result.undoGroupId), version: env.table.dataVersion };
        if (initial.version !== env.table.dataVersion)
          initial = {
            ...initial,
            records: env.settings.identity ? await readRecords(env) : initial.records,
            states: await readStates(env),
          };
        const index = indexRecords(env, initial.records, initial.states);
        const current = await currentValues(env.db, env.schemas.data, table.id, env.fields, [
          ...new Set(
            initial.prepared
              .slice(batch * BATCH_SIZE, (batch + 1) * BATCH_SIZE)
              .flatMap((row) => (row.identity ? [...(index.get(row.identity) ?? [])] : [])),
          ),
        ]);
        if (batch === 0 && env.settings.identity)
          progress.tableOnly = [...initial.states.values()].filter(
            (state) =>
              state.fileId !== fileId &&
              state.identity &&
              !groups.has(state.identity) &&
              initial.records.has(state.recordId),
          ).length;
        const mutations: RowMutation[] = [];
        const metadata: IngestRowState[] = [];
        const identityClaims = new Map<string, string[]>();
        for (const row of initial.prepared.slice(batch * BATCH_SIZE, (batch + 1) * BATCH_SIZE)) {
          // A choice checkpoint revisits unresolved rows while preserving completed row outcomes.
          if (progress.outcomes[row.row]?.settled) continue;
          const chunk = emptyResult(result.undoGroupId);
          progress.outcomes[row.row] = { result: chunk, settled: false };
          if (row.input.held) {
            chunk.held.push({ row: row.row, questionId: row.input.held.questionId });
            continue;
          }
          const repeated = row.identity ? groups.get(row.identity)! : [row.row];
          const ids = row.identity ? [...(index.get(row.identity) ?? [])] : [];
          const choice =
            row.identity && Object.hasOwn(choices, row.identity) ? choices[row.identity] : undefined;
          const ambiguousFile =
            repeated.length > 1 && choice?.choice !== 'keepTable' && !repeated.includes(choice?.row ?? -1);
          const ambiguousTable =
            ids.length > 1 && choice?.choice !== 'keepTable' && !ids.includes(choice?.recordId ?? '');
          if (ambiguousFile || ambiguousTable) {
            chunk.comparison.different += 1;
            if (row.row === repeated[0])
              chunk.disagreements.push({
                identity: row.identity!,
                kind: ambiguousFile ? 'repeated-file-identity' : 'repeated-table-identity',
                messageId: ambiguousFile
                  ? 'ingest.write.repeatedFileIdentity'
                  : 'ingest.write.repeatedTableIdentity',
                rows: repeated,
                records: ids.map((id) => ({ id, values: initial.records.get(id)! })),
              });
            continue;
          }
          if (repeated.length > 1 && (choice?.choice === 'keepTable' || choice?.row !== row.row)) continue;
          const id = ids.includes(choice?.recordId ?? '') ? choice!.recordId! : ids[0];
          if (!id) {
            chunk.comparison.fileOnly += 1;
            if (choice?.choice === 'keepTable') continue;
            const recordId = stableId('rec', table.id, fileId, runId, operation, batch, row.row);
            const desired = { ...row.values, ...processValues(services, file, row) };
            const state = baseState(env, recordId, fileId, row.identity, desired);
            state.createdByFileId = fileId;
            state.at = row.input.at;
            state.reasons = row.reasons;
            mutations.push({
              row: row.row,
              id: recordId,
              fileId,
              at: row.input.at,
              kind: 'create',
              values: desired,
              state,
            });
            continue;
          }
          const actual = keyedValues(env, current.get(id) ?? {});
          const old = initial.states.get(id);
          const state = old ? structuredClone(old) : baseState(env, id, fileId, row.identity, actual);
          if (!old) {
            // Existing data has no remembered process write.  Only blank process fields can be
            // initialized here, so accepting a file never adopts a person's values as our hashes.
            state.values = Object.fromEntries(
              Object.entries(state.values).filter(
                ([key, value]) =>
                  env.byKey.get(key)?.ingest?.role === 'process' && (value === null || value === false),
              ),
            );
            state.hashes = Object.fromEntries(
              Object.keys(state.values).map((key) => [key, hashValue(state.values[key])]),
            );
          }
          const reasons = joinReasons(state.reasons, row.reasons);
          const newReason = reasons.some(
            (reason) => !state.reasons.some((previous) => hashValue(previous) === hashValue(reason)),
          );
          const identical = env.settings.fields.every((field) =>
            pairValuesEqual(
              row.values[field.key],
              actual[field.key],
              pairFieldType(env.byKey.get(field.key)!),
            ),
          );
          if (identical) {
            chunk.comparison.identical += 1;
            chunk.counts.identical += 1;
          } else chunk.comparison.different += 1;
          const desired = { ...row.values, ...processValues(services, file, { ...row, reasons }) };
          if (!identical && choice?.choice !== 'takeFile') {
            if (choice?.choice !== 'keepTable')
              chunk.disagreements.push({
                identity: row.identity!,
                kind: 'different',
                messageId: 'ingest.write.different',
                rows: [row.row],
                records: [{ id, values: actual }],
              });
            safePatch(env, state, actual, desired, chunk, newReason);
            continue;
          }
          if (choice?.choice === 'keepTable') continue;
          if (ids.length > 1)
            identityClaims.set(
              id,
              ids.filter((other) => other !== id),
            );
          const proposed = identical
            ? { needsReview: desired.needsReview, reviewNote: desired.reviewNote, readByAi: desired.readByAi }
            : desired;
          const values = safePatch(env, state, actual, proposed, chunk, newReason);
          if (old && old.fileId !== fileId) state.history.push(snapshot(old));
          if (!old) state.history.push({ ...snapshot(state), fileId: null });
          state.fileId = fileId;
          state.at = row.input.at;
          state.identity = row.identity;
          state.reasons = reasons;
          if (Object.keys(values).length)
            mutations.push({ row: row.row, id, fileId, at: row.input.at, kind: 'update', values, state });
          else {
            if (reasons.length) chunk.counts.flagged += 1;
            if (newReason) metadata.push(state);
            progress.outcomes[row.row]!.settled = true;
          }
        }
        await releaseIdentityReservations(
          env,
          mutations.flatMap((row) =>
            row.kind === 'create' && row.state?.identity ? [row.state.identity] : [],
          ),
        );
        const busResult = emptyResult(result.undoGroupId);
        const applied = await applyMutations(env, services, runId, operation, batch, mutations, busResult);
        for (const mutation of applied) {
          const outcome = progress.outcomes[mutation.row]!;
          if (mutation.kind === 'create') outcome.result.counts.added += 1;
          else outcome.result.counts.updated += 1;
          if (mutation.state?.reasons.length) outcome.result.counts.flagged += 1;
          outcome.settled = true;
        }
        for (const refused of busResult.refused) {
          const outcome = progress.outcomes[refused.row]!;
          outcome.result.counts.refused += 1;
          outcome.result.refused.push(refused);
          outcome.settled = true;
        }
        for (const outcome of Object.values(progress.outcomes))
          if (outcome.result.counts.identical) outcome.settled = true;
        const saved = [...metadata, ...applied.flatMap((row) => (row.state ? [row.state] : []))];
        for (const state of saved) {
          const others = identityClaims.get(state.recordId);
          if (state.identity && others?.length)
            await releaseIdentityReservations(env, [state.identity], others);
        }
        await saveStates(env, saved);
        const values = await currentValues(
          env.db,
          env.schemas.data,
          table.id,
          env.fields,
          applied.map((row) => row.id),
        );
        for (const state of saved) initial.states.set(state.recordId, state);
        for (const [id, value] of values) initial.records.set(id, keyedValues(env, value));
        await saveCheckpoint(env, progressKey, progress, true);
        const chunk = progressResult(progress, result.undoGroupId);
        chunk.busCalls = busResult.busCalls;
        await saveCheckpoint(env, checkpoint, chunk);
        const accumulated = structuredClone(result);
        addResult(accumulated, chunk);
        await saveCounts(env, fileId, accumulated);
        return { result: chunk, version: (await loadTable(env.db, env.schemas, table.id))!.dataVersion };
      });
      addResult(result, part.result);
      initial.version = part.version;
    }
    // Replaying checkpoints also restores their saved counts if a later operation changed them.
    await locked(services, table, (env) => saveCounts(env, fileId, result));
    return result;
  } catch (error) {
    return stopped(result, error);
  }
}

/** Answers use stable target plans because removing a reason changes the next query's targets. */
export async function answerIngestRows(
  table: TableMeta,
  questionId: string,
  answer: unknown,
  runId: string,
  services: WriterServices,
  correction?: {
    fileId: string;
    field?: string;
    at?: IngestRowState['at'][];
    reasons?: IngestRowState['reasons'];
  },
): Promise<WriteResult> {
  const result = emptyResult(stableId('act', table.id, questionId, runId, 'answer'));
  const operation = `answer:${hashValue([questionId, answer])}`;
  try {
    const plan = await locked(services, table, async (env) => {
      const states = await readStates(env);
      const matches = (state: IngestRowState) =>
        correction
          ? state.fileId === correction.fileId &&
            (!correction.at?.length || correction.at.some((at) => hashValue(at) === hashValue(state.at)))
          : state.reasons.some(
              (reason) => reason.source.kind === 'question' && reason.source.questionId === questionId,
            );
      const first = [...states.values()].find(matches);
      // A completed answer's plan is found even when its last reason has already gone.
      const stored = await query<{ file_id: string; result: { records: string[] } }>(
        env.db,
        sql`SELECT file_id, result
        FROM ${ident(env.schemas.app, 'ingest_write_batches')} WHERE org_id = ${env.actor.orgId} AND table_id = ${table.id}
          AND run_id = ${runId} AND operation = ${`${operation}:plan`} AND batch = 0`,
      );
      if (stored.rows[0]) return { fileId: stored.rows[0].file_id, records: stored.rows[0].result.records };
      if (!first) return null;
      const records = [...states.values()]
        .filter(matches)
        .map((state) => state.recordId)
        .sort();
      await saveCheckpoint(
        env,
        {
          fileId: first.fileId,
          runId,
          operation: `${operation}:plan`,
          inputHash: hashValue(answer),
          batch: 0,
        },
        { records },
      );
      return { fileId: first.fileId, records };
    });
    if (!plan) return result;
    for (let start = 0; start < plan.records.length; start += BATCH_SIZE) {
      const batch = start / BATCH_SIZE;
      const chunk = await locked(services, table, async (env) => {
        const key = { fileId: plan.fileId, runId, operation, inputHash: hashValue(answer), batch };
        const cached = await readCheckpoint<WriteResult & { attempt?: number }>(env, key);
        if (cached && !cached.refused.length) return { ...cached, busCalls: 0 };
        const states = await readStates(env);
        const ids = plan.records.slice(start, start + BATCH_SIZE);
        const current = await currentValues(env.db, env.schemas.data, table.id, env.fields, ids);
        const part = cached
          ? { ...cached, counts: { ...cached.counts, refused: 0 }, refused: [], busCalls: 0 }
          : emptyResult(result.undoGroupId);
        const attempt = cached ? (cached.attempt ?? 0) + 1 : 0;
        const mutations: RowMutation[] = [];
        const metadata: IngestRowState[] = [];
        const inputRows = ids.map((id) => ({
          values: correction
            ? correction.field
              ? { [correction.field]: answer }
              : {}
            : Object.fromEntries(
                (states.get(id)?.reasons ?? [])
                  .filter(
                    (reason) =>
                      reason.source.kind === 'question' &&
                      reason.source.questionId === questionId &&
                      reason.fieldKey,
                  )
                  .map((reason) => [reason.fieldKey!, answer]),
              ),
          at: {},
          raw: {},
          reasons: [],
          aiFields: [],
        }));
        const context = await checkContext(env, inputRows);
        const identityTargets = new Set<string>();
        for (const [row, id] of ids.entries()) {
          const old = states.get(id);
          if (!old || !current.has(id)) continue;
          await readFile(env, old.fileId);
          const state = structuredClone(old);
          const matching = state.reasons.filter(
            (reason) => reason.source.kind === 'question' && reason.source.questionId === questionId,
          );
          // Successful rows already dropped this reason and must keep their later edits.
          if (!matching.length && !correction) continue;
          const desired: Record<string, unknown> = {};
          state.reasons = state.reasons.filter((reason) => !matching.includes(reason));
          state.reasons = joinReasons(state.reasons, correction?.reasons ?? []);
          for (const fieldKey of correction
            ? correction.field
              ? [correction.field]
              : []
            : new Set(matching.flatMap((reason) => (reason.fieldKey ? [reason.fieldKey] : [])))) {
            const field = env.byKey.get(fieldKey);
            if (!field) throw new WriterStopped('ingest.tables.invalid');
            const checked = checkOutputValue(
              field,
              fieldKey,
              answer,
              env.settings.fields.find((definition) => definition.key === fieldKey)?.required ?? false,
              context,
            );
            desired[fieldKey] = checked.value;
            state.reasons = state.reasons.filter(
              (reason) => !(reason.source.kind === 'check' && reason.params?.key === fieldKey),
            );
            state.reasons = joinReasons(state.reasons, checked.reasons);
          }
          desired.needsReview = state.reasons.length > 0;
          desired.reviewNote = reasonNote(services, state.reasons);
          const refreshIdentity = env.settings.identity?.some((key) => Object.hasOwn(desired, key)) ?? false;
          if (refreshIdentity) identityTargets.add(id);
          const values = safePatch(
            env,
            old,
            keyedValues(env, current.get(id)!),
            desired,
            part,
            state.reasons.some(
              (reason) => !old.reasons.some((previous) => hashValue(previous) === hashValue(reason)),
            ),
            services.createdFieldKeys,
          );
          if (Object.keys(values).length)
            mutations.push({
              row,
              id,
              fileId: old.fileId,
              at: old.at,
              kind: 'update',
              values,
              state,
              refreshIdentity,
            });
          else {
            if (refreshIdentity) state.identity = rowIdentity(env, keyedValues(env, current.get(id)!));
            metadata.push(state);
          }
        }
        const proposals: RowMutation[] = [
          ...mutations,
          ...metadata.map((state): RowMutation => ({
            row: ids.indexOf(state.recordId),
            id: state.recordId,
            fileId: state.fileId,
            at: state.at,
            kind: 'update',
            values: {},
            state,
          })),
        ];
        const identityMutations = proposals.filter(
          (mutation) =>
            identityTargets.has(mutation.id) &&
            rowIdentity(env, { ...keyedValues(env, current.get(mutation.id)!), ...mutation.values }) !==
              states.get(mutation.id)?.identity,
        );
        if (identityMutations.length) {
          const records = await readRecords(env);
          const index = indexRecords(env, records, states);
          for (const mutation of identityMutations) {
            for (const ids of index.values()) ids.delete(mutation.id);
          }
          for (const mutation of identityMutations) {
            const identity = rowIdentity(env, { ...records.get(mutation.id), ...mutation.values })!;
            const ids = index.get(identity) ?? new Set<string>();
            ids.add(mutation.id);
            index.set(identity, ids);
          }
          for (const [identity, ids] of index) {
            if (ids.size < 2) continue;
            const affected = identityMutations.filter(
              (mutation) =>
                ids.has(mutation.id) &&
                rowIdentity(env, { ...records.get(mutation.id), ...mutation.values }) === identity,
            );
            if (!affected.length) continue;
            part.status = 'disagreement';
            part.disagreements.push({
              identity,
              kind: 'repeated-table-identity',
              messageId: 'ingest.write.repeatedTableIdentity',
              rows: affected.map((mutation) => mutation.row),
              records: [...ids].map((id) => ({ id, values: records.get(id)! })),
            });
          }
        }
        // A colliding batch retains every pending answer so reservations and values move together.
        if (part.disagreements.length) return part;
        // Refused commands are durable receipts, so a retry needs new IDs for pending rows.
        const applied = await applyMutations(
          env,
          services,
          runId,
          attempt ? `${operation}:retry:${attempt}` : operation,
          batch,
          mutations,
          part,
        );
        await releaseIdentityReservations(
          env,
          [...metadata, ...applied.flatMap((row) => (row.state ? [row.state] : []))].flatMap((state) =>
            state.identity ? [state.identity] : [],
          ),
        );
        await saveStates(env, [...metadata, ...applied.flatMap((row) => (row.state ? [row.state] : []))]);
        await saveCheckpoint(env, key, { ...part, attempt }, Boolean(cached));
        return part;
      });
      addResult(result, chunk);
    }
    return result;
  } catch (error) {
    return stopped(result, error);
  }
}

/** Removal preserves the creator, restores preceding contributions, and leaves trash restorable. */
export async function removeIngestFileRows(
  table: TableMeta,
  fileId: string,
  runId: string,
  services: WriterServices,
): Promise<WriteResult> {
  const result = emptyResult(stableId('act', table.id, fileId, runId, 'remove'));
  const operation = 'remove';
  try {
    const plan = await locked(services, table, async (env) => {
      const key = { fileId, runId, operation: 'remove:plan', inputHash: hashValue(fileId), batch: 0 };
      const cached = await readCheckpoint<{ records: string[] }>(env, key);
      if (cached) return cached;
      await readFile(env, fileId);
      const states = await readStates(env);
      const records = [...states.values()]
        .filter(
          (state) =>
            state.createdByFileId === fileId ||
            state.fileId === fileId ||
            state.history.some((previous) => previous.fileId === fileId),
        )
        .map((state) => state.recordId)
        .sort();
      await saveCheckpoint(env, key, { records });
      return { records };
    });
    for (let start = 0; start < plan.records.length; start += BATCH_SIZE) {
      const batch = start / BATCH_SIZE;
      const chunk = await locked(services, table, async (env) => {
        const key = { fileId, runId, operation, inputHash: hashValue(fileId), batch };
        const cached = await readCheckpoint<WriteResult>(env, key);
        if (cached) return { ...cached, busCalls: 0 };
        const states = await readStates(env);
        const ids = plan.records.slice(start, start + BATCH_SIZE);
        const current = await currentValues(env.db, env.schemas.data, table.id, env.fields, ids);
        const part = emptyResult(result.undoGroupId);
        const mutations: RowMutation[] = [];
        const metadata: IngestRowState[] = [];
        for (const [row, id] of ids.entries()) {
          const old = states.get(id);
          if (!old) continue;
          if (old.createdByFileId === fileId) {
            if (current.has(id)) mutations.push({ row, id, fileId, at: old.at, kind: 'trash', values: {} });
            continue;
          }
          const state = structuredClone(old);
          const contribution = withoutFileContribution(old, fileId);
          if (!contribution) continue;
          const { prior, history, desired } = contribution;
          state.history = history;
          const actual = keyedValues(env, current.get(id) ?? {});
          const values = safePatch(env, old, actual, desired, part);
          state.fileId = prior.fileId ?? fileId;
          state.at = prior.at;
          state.identity = env.settings.identity?.some((key) => Object.hasOwn(values, key))
            ? rowIdentity(env, { ...actual, ...values })
            : prior.identity;
          state.reasons = prior.reasons;
          // Hashes of cells left alone still describe the last process write, never a hand edit.
          state.values = { ...old.values };
          state.hashes = { ...old.hashes };
          const mutation: RowMutation = {
            row,
            id,
            fileId,
            at: old.at,
            kind: 'update',
            values,
            state,
            deleteState: prior.fileId === null,
          };
          if (Object.keys(values).length) mutations.push(mutation);
          else if (mutation.deleteState) await deleteStates(env, [id]);
          else metadata.push(state);
        }
        const applied = await applyMutations(env, services, runId, operation, batch, mutations, part);
        await saveStates(env, [
          ...metadata,
          ...applied.flatMap((row) => (row.state && !row.deleteState ? [row.state] : [])),
        ]);
        await deleteStates(
          env,
          applied.filter((row) => row.deleteState).map((row) => row.id),
        );
        await saveCheckpoint(env, key, part);
        return part;
      });
      addResult(result, chunk);
    }
    await locked(services, table, async (env) => {
      await saveCounts(env, fileId, result);
      // A refused removal stays retryable under a new run rather than claiming every row is gone.
      if (!result.refused.length && !services.preserveFileState)
        await query(
          env.db,
          sql`UPDATE ${ident(env.schemas.app, 'ingest_files')} SET state = 'removed'
        WHERE org_id = ${env.actor.orgId} AND table_id = ${table.id} AND id = ${fileId}`,
        );
    });
    return result;
  } catch (error) {
    return stopped(result, error);
  }
}
async function deleteStates(env: Environment, ids: string[]) {
  if (!ids.length) return;
  await query(
    env.db,
    sql`DELETE FROM ${ident(env.schemas.app, 'ingest_row_state')}
    WHERE org_id = ${env.actor.orgId} AND table_id = ${env.table.id} AND record_id = ANY(${ids}::text[])`,
  );
}
