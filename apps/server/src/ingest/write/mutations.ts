import { AppError, type IngestRowState, type IngestRowReason } from '@riosoma/contracts';
import { serializableValue } from '@riosoma/ingest';
import { currentValues } from '../../data/physical/records.js';
import { runCommands } from '../../data/commands/index.js';
import { ingestCapability } from '../tables/capability.js';
import type { WriterServices, WriteResult } from './types.js';
import { hashValue, keyedValues, rowIdentity, stableId, type Environment } from './storage.js';

export interface RowMutation {
  row: number;
  id: string;
  fileId: string;
  at: IngestRowState['at'];
  kind: 'create' | 'update' | 'trash';
  values: Record<string, unknown>;
  state?: IngestRowState;
  deleteState?: boolean;
  refreshIdentity?: boolean;
}
export const snapshot = (state: IngestRowState): IngestRowState['history'][number] =>
  structuredClone({
    fileId: state.fileId,
    identity: state.identity,
    values: state.values,
    hashes: state.hashes,
    at: state.at,
    reasons: state.reasons,
  });

/** Consecutive snapshots remember which file actually wrote each cell, including inherited cells. */
export function withoutFileContribution(state: IngestRowState, fileId: string) {
  const cellFiles = new Map<string, string | null>();
  let previousHashes: Record<string, string> = {};
  const values: IngestRowState['values'] = {};
  const hashes: IngestRowState['hashes'] = {};
  const history: IngestRowState['history'] = [];
  for (const version of [...state.history, snapshot(state)]) {
    for (const [key, value] of Object.entries(version.values)) {
      if (version.hashes[key] === previousHashes[key]) continue;
      cellFiles.set(key, version.fileId);
      if (version.fileId === fileId) continue;
      values[key] = structuredClone(value);
      hashes[key] = version.hashes[key]!;
    }
    previousHashes = version.hashes;
    if (version.fileId !== fileId) history.push(structuredClone({ ...version, values, hashes }));
  }
  const prior = history.pop();
  if (!prior) return null;
  return {
    prior,
    history,
    desired: Object.fromEntries(
      [...cellFiles].filter(([, owner]) => owner === fileId).map(([key]) => [key, values[key] ?? null]),
    ),
  };
}
export function joinReasons(left: readonly IngestRowReason[], right: readonly IngestRowReason[]) {
  const seen = new Set<string>();
  return [...left, ...right].filter((reason) => {
    const hash = hashValue(reason);
    if (seen.has(hash)) return false;
    seen.add(hash);
    return true;
  });
}
export function reasonNote(services: WriterServices, reasons: readonly IngestRowReason[]) {
  return reasons.map((reason) => services.message(reason.messageId, reason.params)).join('\n') || null;
}
export function safePatch(
  env: Environment,
  state: IngestRowState,
  current: Record<string, unknown>,
  desired: Record<string, unknown>,
  result: WriteResult,
  newReason = false,
  createdFieldKeys: readonly string[] = [],
) {
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(desired)) {
    if (!env.byKey.has(key)) continue;
    const actual = current[key] ?? null;
    // Once a model contributed, even removing that file cannot clear this provenance mark.
    if (key === 'readByAi' && actual === true) continue;
    if (hashValue(actual) === hashValue(value)) continue;
    // A field added after reading has no process hash, and its blank cell has no edit to preserve.
    const newBlankField =
      createdFieldKeys.includes(key) && state.hashes[key] === undefined && actual === null;
    if (
      !newBlankField &&
      hashValue(actual) !== state.hashes[key] &&
      !(key === 'needsReview' && newReason && value === true)
    ) {
      result.cellsLeftAlone.push({
        recordId: state.recordId,
        fieldKey: key,
        messageId: 'ingest.write.handEdit',
      });
      continue;
    }
    values[key] = value;
  }
  return values;
}

/** A rejected batch is split at savepoints until the bus has identified every refused row. */
export async function applyMutations(
  env: Environment,
  services: WriterServices,
  runId: string,
  operation: string,
  batch: number,
  rows: RowMutation[],
  result: WriteResult,
) {
  const applied: RowMutation[] = [];
  const send = async (items: RowMutation[], path: string): Promise<void> => {
    if (!items.length) return;
    const first = items[0]!;
    const kind = first.kind;
    const id = stableId(
      'cmd',
      env.actor.orgId,
      env.table.id,
      first.fileId,
      runId,
      operation,
      batch,
      kind,
      path,
    );
    const command = {
      id,
      groupId: result.undoGroupId,
      kind: `record.${kind}`,
      tableId: env.table.id,
      ...(kind === 'trash'
        ? { recordIds: items.map((row) => row.id) }
        : {
            records: items.map((row) => ({
              id: row.id,
              values: Object.fromEntries(
                Object.entries(row.values).map(([key, value]) => [env.byKey.get(key)!.id, value]),
              ),
            })),
          }),
    };
    result.busCalls += 1;
    const response = await runCommands(
      services.app,
      env.actor,
      env.table.databaseId,
      { clientId: stableId('cli', env.table.id, first.fileId), commands: [command] },
      env.db,
      undefined,
      undefined,
      { origin: { kind: 'ingest', fileId: first.fileId }, ingestCapability },
    );
    const outcome = response.results[0]!;
    if (outcome.status !== 'rejected') {
      applied.push(...items);
      return;
    }
    const error = outcome.error;
    if (!error) throw new AppError('internal', 'errors.internal');
    if (items.length === 1) {
      result.counts.refused += 1;
      result.refused.push({ row: first.row, recordId: first.id, at: first.at, reason: error });
      return;
    }
    // A cell refusal names its exact record.  Unique indexes may name only a field, which needs
    // bisection so duplicates inside this file also receive the bus's actual refusal.
    const rejectedIds = new Set(error.issues?.map((issue) => issue.recordId) ?? []);
    if (typeof error.params?.recordId === 'string') rejectedIds.add(error.params.recordId);
    if (rejectedIds.size && items.some((row) => rejectedIds.has(row.id))) {
      await send(
        items.filter((row) => !rejectedIds.has(row.id)),
        `${path}valid`,
      );
      for (const [position, row] of items.filter((row) => rejectedIds.has(row.id)).entries())
        await send([row], `${path}refused${position}`);
      return;
    }
    const middle = Math.floor(items.length / 2);
    await send(items.slice(0, middle), `${path}l`);
    await send(items.slice(middle), `${path}r`);
  };
  const groups = new Map<string, RowMutation[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.fileId, row.kind]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  for (const [key, items] of groups) await send(items, hashValue(key).slice(0, 12));
  const current = await currentValues(
    env.db,
    env.schemas.data,
    env.table.id,
    env.fields,
    applied.filter((row) => row.kind !== 'trash').map((row) => row.id),
  );
  for (const row of applied) {
    if (row.kind === 'create') result.counts.added += 1;
    else if (row.kind === 'update') result.counts.updated += 1;
    if (row.state?.reasons.length) result.counts.flagged += 1;
    if (!row.state || row.kind === 'trash') continue;
    const values = keyedValues(env, current.get(row.id) ?? {});
    for (const key of Object.keys(row.values)) {
      row.state.hashes[key] = hashValue(values[key]);
      row.state.values[key] = serializableValue(values[key]);
    }
    // An identity answer confirms the key.  Other updates retain aliases for hand-edited keys.
    if (row.refreshIdentity) row.state.identity = rowIdentity(env, values);
  }
  return applied;
}
