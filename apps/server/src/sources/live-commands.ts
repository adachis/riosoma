import {
  AppError,
  Command,
  isGroup,
  liveAllowsType,
  supportsLive,
  type CellValue,
  type FilterGroup,
  type TableMeta,
} from '@riosoma/contracts';
import type { AppContext } from '../app.js';
import type { Actor } from '../http/policy.js';
import { AccessScope } from '../data/access.js';
import { table as loadCommandTable, type CommandContext } from '../data/commands/context.js';
import { dataStore } from '../data/context.js';
import { loadFields, loadTable } from '../data/metadata.js';
import { loadDatabaseRules } from '../data/permissions/store.js';
import type { StoredField } from '../data/types.js';
import {
  liveDeps,
  overriddenFields,
  readsLive,
  refreshLiveCells,
  rulesTranslate,
  sourceValues,
  visibleLive,
} from './live.js';

/**
 * What a command on a live table needs from the source, read before the command's transaction so
 * the database's lock is never held while the source answers: current source values of the
 * records it changes, and which of them the actor's record rules let them see.  A failure to read
 * is kept and raised inside the command, only for a command that needs the source.
 */
export interface LiveCommandContext {
  tableId: string;
  values?: Map<string, Record<string, CellValue>>;
  visible?: Set<string>;
  error?: AppError;
}

/**
 * What a source answered about its records, kept by table and record so a caller that makes many
 * commands, such as a simulation, reads no record from its source twice.  A source that failed
 * once isn't asked again.
 */
export class LiveReads {
  readonly visible = new Map<string, boolean>();
  readonly values = new Map<string, Record<string, CellValue> | null>();
  readonly failed = new Map<string, AppError>();
}

function fieldIdsIn(group: FilterGroup, out = new Set<string>()): Set<string> {
  for (const item of group.conditions) {
    if (isGroup(item)) fieldIdsIn(item, out);
    else out.add(item.fieldId);
  }
  return out;
}

export async function prepareLiveCommand(
  ctx: AppContext,
  actor: Actor,
  databaseId: string,
  input: unknown,
  reads?: LiveReads,
): Promise<LiveCommandContext | undefined> {
  const kind = input && typeof input === 'object' && 'kind' in input ? input.kind : undefined;
  if (
    kind !== 'record.update' &&
    kind !== 'record.clearOverrides' &&
    kind !== 'comment.create' &&
    kind !== 'record.generateDocument' &&
    kind !== 'record.attachFromUrl'
  )
    return undefined;
  const parsed = Command.safeParse(input);
  if (!parsed.success) return undefined;
  const command = parsed.data;
  let tableId: string;
  let ids: string[];
  let needsValues = false;
  if (command.kind === 'record.update' || command.kind === 'record.clearOverrides') {
    tableId = command.tableId;
    ids = command.records.map((record) => record.id);
  } else if (
    command.kind === 'comment.create' ||
    command.kind === 'record.generateDocument' ||
    command.kind === 'record.attachFromUrl'
  ) {
    tableId = command.tableId;
    ids = [command.recordId];
  } else return undefined;
  const { pool, schemas } = dataStore(ctx);
  const table = await loadTable(pool, schemas, tableId);
  if (!table || table.trashed || table.databaseId !== databaseId || !readsLive(table)) return undefined;
  if (
    command.kind === 'record.clearOverrides' ||
    command.kind === 'record.generateDocument' ||
    command.kind === 'record.attachFromUrl'
  )
    needsValues = true;
  if (command.kind === 'record.update') {
    const fields = await loadFields(pool, schemas, [tableId]);
    const sourceIds = new Set(fields.filter((field) => field.source).map((field) => field.id));
    const sourceRules = fields.some(
      (field) => field.source && 'validation' in field.options && field.options.validation,
    );
    needsValues =
      Boolean(table.recordLock?.condition) ||
      sourceRules ||
      command.records.some((record) => Object.keys(record.values).some((id) => sourceIds.has(id)));
  }
  const live: LiveCommandContext = { tableId };
  const failed = reads?.failed.get(tableId);
  if (failed) return { tableId, error: failed };
  const key = (id: string) => `${tableId}:${id}`;
  try {
    const scope = new AccessScope(pool, schemas, actor);
    await scope.require(databaseId, 'read');
    const deps = liveDeps(ctx);
    if (scope.liveRules(tableId) !== null) {
      const unread = reads ? ids.filter((id) => !reads.visible.has(key(id))) : ids;
      const found = unread.length ? await visibleLive(deps, table, scope, unread) : new Set<string>();
      for (const id of unread) reads?.visible.set(key(id), found.has(id));
      live.visible = reads ? new Set(ids.filter((id) => reads.visible.get(key(id)))) : found;
    }
    if (needsValues) {
      const unread = reads ? ids.filter((id) => !reads.values.has(key(id))) : ids;
      const found = unread.length
        ? (await sourceValues(deps, table, unread)).values
        : new Map<string, Record<string, CellValue>>();
      for (const id of unread) reads?.values.set(key(id), found.get(id) ?? null);
      live.values = reads
        ? new Map(
            ids.flatMap((id) => {
              const values = reads.values.get(key(id));
              return values ? [[id, values] as const] : [];
            }),
          )
        : found;
    }
  } catch (error) {
    if (error instanceof AppError && error.messageKey.startsWith('sources.')) live.error = error;
    else if (!(error instanceof AppError))
      live.error = new AppError('unavailable', 'sources.live.unreachable');
    else return undefined;
    reads?.failed.set(tableId, live.error);
  }
  return live;
}

/** Record rules of a table, as conditions. */
async function ruleConditions(
  c: Pick<CommandContext, 'db' | 'schemas'>,
  databaseId: string,
  tableId: string,
) {
  return (await loadDatabaseRules(c.db, c.schemas, databaseId)).records
    .filter((rule) => rule.tableId === tableId)
    .map((rule) => rule.condition);
}

/**
 * Before a change to a live table's records: its source values as the source has them now, and a
 * refusal for an override of a field its record rules read, since rules there read the source.
 */
export async function beforeLiveUpdate(
  c: CommandContext,
  parent: TableMeta,
  command: Extract<Command, { kind: 'record.update' | 'record.clearOverrides' }>,
  fields: readonly StoredField[],
): Promise<void> {
  const sourceIds = new Set(fields.filter((field) => field.source).map((field) => field.id));
  const touched =
    command.kind === 'record.clearOverrides'
      ? command.records.flatMap((record) => record.fieldIds)
      : command.records.flatMap((record) => Object.keys(record.values));
  const sourceTouched = touched.filter((id) => sourceIds.has(id));
  const sourceRules = fields.some(
    (field) => field.source && 'validation' in field.options && field.options.validation,
  );
  if (!sourceTouched.length && !parent.recordLock?.condition && !sourceRules) return;
  if (command.kind === 'record.update') {
    const ruled = new Set(
      (await ruleConditions(c, c.databaseId, parent.id)).flatMap((condition) => [...fieldIdsIn(condition)]),
    );
    if (sourceTouched.some((id) => ruled.has(id))) throw new AppError('forbidden', 'sources.live.ruleField');
  }
  const ids = command.records.map((record) => record.id);
  let values = c.live?.tableId === parent.id ? c.live.values : undefined;
  if (!values) {
    if (!c.secretKey) throw new AppError('unavailable', 'errors.unavailable');
    const found = await sourceValues(
      { db: c.db, schemas: c.schemas, secretKey: c.secretKey },
      await loadCommandTable(c, parent.id),
      ids,
    );
    values = found.values;
  }
  await refreshLiveCells(c, parent.id, values);
}

/** Refuses a field type a live table can't hold, and a link to a live table from anywhere. */
export async function requireLiveField(
  c: CommandContext,
  tableId: string,
  spec: { id?: string; type: string; options?: unknown },
): Promise<void> {
  const parent = await loadCommandTable(c, tableId);
  if (readsLive(parent) && !liveAllowsType(spec.type))
    throw new AppError('validation_failed', 'sources.live.fieldUnavailable');
  if (spec.type === 'link') {
    // An unavailable copied destination has no junction or values to read live.
    if (spec.id && c.copiedLinkFields?.get(spec.id) === 'unavailable') return;
    const linkedId = (spec.options as { linkedTableId?: string } | undefined)?.linkedTableId;
    if (linkedId && linkedId !== tableId && readsLive(await loadCommandTable(c, linkedId, false, 'read')))
      throw new AppError('validation_failed', 'sources.live.fieldUnavailable');
  }
}

/**
 * Checks a synced table can read its source live: the source is a SQL database, the table holds
 * no field a live table can't, and every record rule reads only what the source answers exactly.
 */
export async function requireLiveSwitch(
  c: CommandContext,
  table: TableMeta & { source: NonNullable<TableMeta['source']> },
): Promise<void> {
  if (!supportsLive(table.source.sourceKind))
    throw new AppError('validation_failed', 'sources.live.unsupported');
  const fields = await loadFields(c.db, c.schemas, [table.id]);
  if (fields.some((field) => !liveAllowsType(field.type)))
    throw new AppError('validation_failed', 'sources.live.fieldsInTheWay');
  const conditions = await ruleConditions(c, c.databaseId, table.id);
  if (
    conditions.length &&
    !rulesTranslate(
      table.source.sourceKind,
      fields,
      await overriddenFields(c.db, c.schemas, table.id),
      conditions,
    )
  )
    throw new AppError('validation_failed', 'sources.live.ruleUntranslatable');
}
