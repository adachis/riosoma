import {
  AppError,
  SYNC_OUT_KEY_COLUMN,
  type SyncOutMessage,
  type SyncOutPreview,
  type SyncOutPreviewColumn,
  type SyncOutPreviewRequest,
} from '@riosoma/contracts';
import type { Actor } from '../http/policy.js';
import { destinationFor } from './destination.js';
import { syncRead } from './read.js';
import { buildColumnPlans } from './values.js';
import type { SyncWorkerLike } from './engine.js';

/**
 * How the view's fields would line up with the destination's columns, without writing anything.
 * Today only a new table is made, so every field becomes a new column and the key column is new;
 * a name already in the base, or a service limit, is reported as a blocking problem.
 */

function cut(name: string, length: number): string {
  return [...name.trim()].slice(0, length).join('');
}

export async function syncOutPreview(
  worker: SyncWorkerLike,
  actor: Actor & { locale?: string },
  viewId: string,
  request: SyncOutPreviewRequest,
): Promise<SyncOutPreview> {
  const adapter = destinationFor(request.destination.kind);
  if (!adapter) throw new AppError('validation_failed', 'syncOut.destination.unknownKind');
  if (request.destination.table.mode !== 'new')
    throw new AppError('validation_failed', 'syncOut.target.newOnly');

  const reading = await syncRead(worker.app.ctx, worker.snapshots, actor, viewId, request.timeZone);
  if (!reading.ok) {
    const key = 'stop' in reading ? reading.stop : reading.fail.messageKey;
    throw new AppError('validation_failed', key);
  }

  const limits = adapter.limits;
  const { plans } = buildColumnPlans(reading.fields, reading.read.table.primaryFieldId, {
    timeZone: request.timeZone,
    locale: request.locale,
  });
  const planByField = new Map(plans.map((plan) => [plan.fieldId, plan]));
  const snapshot = (await worker.snapshots.get(reading.read)).snapshot;
  const rows = snapshot.rids.length;

  const problems: SyncOutMessage[] = [];
  const columnCount = plans.length + 1;
  if (columnCount > limits.columns)
    problems.push({
      messageKey: 'syncOut.airtable.columns',
      params: { count: columnCount, limit: limits.columns },
    });
  if (rows > limits.rows)
    problems.push({ messageKey: 'syncOut.airtable.rows', params: { count: rows, limit: limits.rows } });
  if (limits.cells !== null && rows * columnCount > limits.cells)
    problems.push({
      messageKey: 'syncOut.airtable.cells',
      params: { count: rows * columnCount, limit: limits.cells },
    });

  // A new table whose name is already in the base can't be made, so Continue is blocked.
  if (request.destination.kind === 'airtable' && request.destination.table.mode === 'new') {
    const name = request.destination.table.name;
    const lookup = {
      kind: 'airtable' as const,
      credential: request.credential,
      baseId: request.destination.baseId,
    };
    const ctx = worker.context(adapter, lookup, request.credential, AbortSignal.timeout(60_000));
    const places = await adapter.places(ctx, lookup);
    if (places.places.some((place) => place.name.trim().toLowerCase() === name.trim().toLowerCase()))
      problems.push({ messageKey: 'syncOut.airtable.nameTaken', params: { name } });
  }

  const columns: SyncOutPreviewColumn[] = reading.fields.map((field) => {
    const plan = planByField.get(field.id)!;
    return {
      fieldId: field.id,
      fieldName: field.name,
      fieldType: field.type,
      action: 'create',
      columnName: cut(plan.name, limits.columnNameLength),
      columnType: adapter.columnType(plan),
      write: 'typed',
      reason: null,
    };
  });

  return {
    columns,
    key: { name: SYNC_OUT_KEY_COLUMN, action: 'create' },
    withheld: reading.withheld,
    untouched: [],
    rows,
    problems,
  };
}
