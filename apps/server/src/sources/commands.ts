import {
  AppError,
  FEED_SCHEDULE,
  isJsonPath,
  liveAllowsType,
  supportsLive,
  WEBHOOK_FIELD_TYPES,
  WEBHOOK_OBJECT,
  type Command,
  type SourceKind,
  type TableCreate,
  type TableSourceSettings,
} from '@riosoma/contracts';
import { connectorFor } from '@riosoma/connectors';
import { ident, query, sql } from '@riosoma/db';
import { publicTable, table, type CommandContext, type Mutation } from '../data/commands/context.js';
import { columnType } from '../data/physical/columns.js';
import {
  connectorCall,
  connectorContext,
  initialStatus,
  loadSource,
  requireSourceAccess,
  sourceAdmin,
  usableSecrets,
} from './store.js';
import { readsLive } from './live.js';
import { administersSource } from '../org-units/store.js';
import { requireLiveSwitch } from './live-commands.js';

/**
 * What a kind allows of a synced table's schedule: a webhook's posts fill it as they come, so it
 * never syncs, and a feed syncs every 15 minutes to once a day, or when someone asks.
 */
export function checkSchedule(
  kind: SourceKind,
  settings: Pick<TableSourceSettings, 'everyMinutes' | 'freshness'>,
) {
  if (kind === 'webhook' && (settings.everyMinutes !== null || settings.freshness !== 'copy'))
    throw new AppError('validation_failed', 'sources.webhook.noSchedule');
  if (
    kind === 'feed' &&
    settings.everyMinutes !== null &&
    (settings.everyMinutes < FEED_SCHEDULE.min || settings.everyMinutes > FEED_SCHEDULE.max)
  )
    throw new AppError('validation_failed', 'sources.feed.schedule');
}

/**
 * A webhook's columns are paths into its posts, which exist once posts arrive, so any path will
 * do, and its fields take the types a post's values convert to cleanly.  Keys are optional: without
 * one, every post adds records.
 */
function checkWebhookTable(input: TableCreate, settings: NonNullable<TableCreate['source']>): void {
  if (settings.select.kind !== 'object' || settings.select.object.name !== WEBHOOK_OBJECT)
    throw new AppError('validation_failed', 'sources.sync.objectMissing');
  const path = (value: string) => value.trim() !== '' && isJsonPath(value);
  if (new Set(settings.keyColumns).size !== settings.keyColumns.length || !settings.keyColumns.every(path))
    throw new AppError('validation_failed', 'sources.sync.keyEmpty');
  for (const field of input.fields) {
    if (!field.source) continue;
    if (!path(field.source.column) || !(WEBHOOK_FIELD_TYPES as readonly string[]).includes(field.type))
      throw new AppError('validation_failed', 'sources.sourceField');
    field.source.sourceType = 'json';
  }
}

export async function validateSourceTable(c: CommandContext, input: TableCreate): Promise<void> {
  if (!input.source) {
    if (input.fields.some((field) => field.source))
      throw new AppError('validation_failed', 'sources.sourceField');
    return;
  }
  const settings = input.source;
  await query(
    c.db,
    sql`SELECT id FROM ${ident(c.schemas.app, 'sources')} WHERE id = ${settings.sourceId} AND org_id = ${c.actor.orgId} FOR KEY SHARE`,
  );
  const source = await loadSource(c.db, c.schemas, settings.sourceId, c.actor.orgId);
  await requireSourceAccess(c.db, c.schemas, c.actor, source, settings.select);
  if (settings.freshness === 'live') {
    if (!supportsLive(source.kind)) throw new AppError('validation_failed', 'sources.live.unsupported');
    if (input.fields.some((field) => !liveAllowsType(field.type)))
      throw new AppError('validation_failed', 'sources.live.fieldUnavailable');
  }
  checkSchedule(source.kind, settings);
  if (!c.secretKey) throw new AppError('unavailable', 'errors.unavailable');
  await usableSecrets(source, c.secretKey, c.db);
  if (source.kind === 'webhook') return checkWebhookTable(input, settings);
  if (!settings.keyColumns.length) throw new AppError('validation_failed', 'sources.sync.keyEmpty');
  const context = await connectorContext(source, c.secretKey, undefined, c.db, c.appContext);
  const columns = await connectorCall(() => connectorFor(source.kind).describe(context, settings.select));
  if (
    new Set(settings.keyColumns).size !== settings.keyColumns.length ||
    settings.keyColumns.some((key) => !columns.some((column) => column.name === key && column.suggested))
  )
    throw new AppError('validation_failed', 'sources.sync.keyEmpty');
  for (const field of input.fields) {
    if (!field.source) continue;
    const column = columns.find((column) => column.name === field.source!.column);
    if (
      !column?.suggested ||
      !columnType(field) ||
      field.type === 'autoNumber' ||
      (column.suggested.type !== field.type && !column.alternatives.includes(field.type))
    )
      throw new AppError('validation_failed', 'sources.sourceField');
    field.source.sourceType = column.sourceType;
  }
}

export async function createTableSource(c: CommandContext, input: TableCreate): Promise<void> {
  if (input.source && (await table(c, input.id)).ingest)
    throw new AppError('conflict', 'ingest.tables.exclusive');
  if (!input.source) return;
  const found = await query<{ kind: SourceKind }>(
    c.db,
    sql`SELECT kind FROM ${ident(c.schemas.app, 'sources')} WHERE id = ${input.source.sourceId}`,
  );
  const kind = found.rows[0]?.kind;
  if (!kind) throw new AppError('not_found', 'errors.notFound');
  // A live table has nothing to copy, and a webhook's table waits for posts, so both start ready.
  const status = initialStatus(input.source, kind);
  await query(
    c.db,
    sql`INSERT INTO ${ident(c.schemas.app, 'table_sources')} (table_id, source_id, settings, status, next_sync_at)
    VALUES (${input.id}, ${input.source.sourceId}, ${JSON.stringify(input.source)}::jsonb, ${JSON.stringify(status)}::jsonb, ${status.nextSyncAt}::timestamptz)`,
  );
  await query(
    c.db,
    sql`ALTER TABLE ${ident(c.schemas.data, input.id)} ADD COLUMN __source_key text UNIQUE, ADD COLUMN __synced_at timestamptz`,
  );
  if (status.nextSyncAt) (c.sourceSyncTables ??= new Set()).add(input.id);
}

export async function sourceCommand(
  c: CommandContext,
  command: Extract<Command, { kind: 'table.sync' | 'table.updateSource' }>,
): Promise<Mutation> {
  const before = publicTable(await table(c, command.tableId));
  if (!before.source) throw new AppError('validation_failed', 'sources.sourceField');
  const admin =
    sourceAdmin(c.actor) ||
    (await administersSource(c.db, `"${c.schemas.app}"`, c.actor, before.source.sourceId));
  if (before.source.select.kind === 'query' && !admin)
    throw new AppError('forbidden', 'sources.queryAdminsOnly');
  if (before.source.select.kind === 'object' && before.source.select.filter !== undefined && !admin)
    throw new AppError('forbidden', 'sources.filterAdminsOnly');
  const { sourceName: _name, sourceKind: kind, status: previousStatus, ...settings } = before.source;
  const status = { ...previousStatus };
  const wasLive = readsLive(before);
  // A webhook's table is written as posts arrive, so there's never a sync to ask for.
  if (command.kind === 'table.sync' && kind === 'webhook')
    throw new AppError('validation_failed', 'sources.webhook.noSync');
  if (command.kind === 'table.updateSource') {
    Object.assign(settings, command.settings);
    checkSchedule(kind, settings);
    const switching =
      command.settings.freshness !== undefined && command.settings.freshness !== before.source.freshness;
    if (switching && settings.freshness === 'live') {
      // Copy to Live: overrides and local fields stay with each record, and syncs stop.
      await requireLiveSwitch(c, before as typeof before & { source: NonNullable<typeof before.source> });
      delete status.switchingToCopy;
      if (status.state !== 'running') status.state = 'idle';
      status.nextSyncAt = null;
      status.held = null;
      status.error = null;
    } else if (switching) {
      // Live to Copy: the table reads live until its first sync has copied every record.
      status.switchingToCopy = true;
      if (status.state !== 'running') status.state = 'queued';
      status.nextSyncAt = new Date().toISOString();
    } else if (
      settings.freshness === 'copy' &&
      command.settings.everyMinutes !== undefined &&
      (status.state === 'idle' || status.state === 'failed') &&
      !status.switchingToCopy
    )
      status.nextSyncAt =
        settings.everyMinutes === null
          ? null
          : new Date(
              (status.lastSuccessAt || status.lastSyncAt
                ? Date.parse(status.lastSuccessAt ?? status.lastSyncAt!)
                : Date.now()) +
                settings.everyMinutes * 60_000,
            ).toISOString();
    // A change to what a sync removes needs the whole answer again, not a feed's "nothing changed".
    const rereads =
      command.settings.removeMissing !== undefined &&
      command.settings.removeMissing !== before.source.removeMissing;
    if (rereads && status.state === 'held') {
      status.state = 'queued';
      status.held = null;
      status.nextSyncAt = new Date().toISOString();
    }
    await query(
      c.db,
      sql`UPDATE ${ident(c.schemas.app, 'table_sources')}
      SET held_token = CASE WHEN ${rereads}::boolean THEN NULL ELSE held_token END,
      confirm_removals = CASE WHEN ${rereads}::boolean THEN false ELSE confirm_removals END,
      settings = ${JSON.stringify(settings)}::jsonb, status = ${JSON.stringify(status)}::jsonb,
      next_sync_at = ${status.nextSyncAt}::timestamptz,
      fetch_state = CASE WHEN ${rereads}::boolean THEN NULL ELSE fetch_state END WHERE table_id = ${before.id}`,
    );
  } else if (wasLive && !status.switchingToCopy) {
    throw new AppError('validation_failed', 'sources.live.noSync');
  } else {
    // An active lease owns its staging data; queueing must not invalidate that ownership.
    if (status.state === 'running') {
      status.nextSyncAt = new Date().toISOString();
      await query(
        c.db,
        sql`UPDATE ${ident(c.schemas.app, 'table_sources')} SET queued_again = true, status = ${JSON.stringify(status)}::jsonb WHERE table_id = ${before.id}`,
      );
    } else {
      const confirm = command.confirmRemovals && status.state === 'held';
      status.state = 'queued';
      status.nextSyncAt = new Date().toISOString();
      await query(
        c.db,
        sql`UPDATE ${ident(c.schemas.app, 'table_sources')} SET
        status = ${JSON.stringify(status)}::jsonb, next_sync_at = now(), confirm_removals = ${confirm}
        WHERE table_id = ${before.id}`,
      );
    }
  }
  if (status.nextSyncAt && Date.parse(status.nextSyncAt) <= Date.now())
    (c.sourceSyncTables ??= new Set()).add(before.id);
  return {
    body: { kind: 'table.updated', table: publicTable(await table(c, before.id)) },
    prev: { table: before },
  };
}
