import { finishSyncRun, startSyncRun } from './history.js';
import {
  AppError,
  newId,
  removesMissing,
  type CellValue,
  type SyncStats,
  type SyncStatus,
  type TableSourceSettings,
  type SourceSecrets,
} from '@riosoma/contracts';
import {
  ConnectorError,
  connectorFor,
  NotModified,
  sourceKey,
  type SourceRow,
  type Validators,
} from '@riosoma/connectors';
import { ident, join, query, sql, withTransaction, type Sql } from '@riosoma/db';
import type { AppContext } from '../app.js';
import { dataStore } from '../data/context.js';
import { bumpVersion, publicField, publicTable, type CommandContext } from '../data/commands/context.js';
import { lock, LONG_DEADLINES, recordChange } from '../data/commands/transaction.js';
import { loadFields, loadTable } from '../data/metadata.js';
import { columnRef, jsonValueExpr, selectExpr } from '../data/physical/columns.js';
import { matchedLinks, MatchRefresh } from '../data/physical/matches.js';
import type { StoredField } from '../data/types.js';
import {
  ARRAY_CELL_ERROR,
  sourceArrayCondition,
  sourceCellValue,
  withSourceCellErrors,
} from '../data/source-cell-errors.js';
import { notifySync, reasonOf } from '../notifications/produce.js';
import { connectorContext, loadSource, messageParams, safeDetail } from './store.js';

export interface SyncJob {
  table_id: string;
  database_id: string;
  org_id: string;
  settings: TableSourceSettings;
  status: SyncStatus;
  lease_token: string;
  failures: number;
  held_token: string | null;
  confirm_removals: boolean;
  /** What a feed's last answer said about itself, sent with the next read */
  fetch_state: Validators | null;
}

/** What staging found: rows to apply, or a source that said nothing changed since the last sync. */
type Staged = { changed: true; validators: Validators | null; incremental?: boolean } | { changed: false };

function context(ctx: AppContext, db: CommandContext['db'], job: SyncJob): CommandContext {
  return {
    db,
    schemas: dataStore(ctx).schemas,
    databaseId: job.database_id,
    actor: { userId: '', orgId: job.org_id, sessionId: '', kind: 'owner', adminRoles: [], csrfToken: '' },
  };
}

const changeIds = () => ({
  commandId: newId('command'),
  groupId: newId('action'),
  clientId: null,
  system: true,
});

async function publish(
  c: CommandContext,
  job: SyncJob,
  stats?: SyncStats,
  syncProgress = false,
): Promise<void> {
  const table = await loadTable(c.db, c.schemas, job.table_id);
  if (!table) return;
  const ids = changeIds();
  await recordChange(
    c,
    {
      body: stats
        ? { kind: 'table.synced', table: publicTable(table), stats }
        : {
            kind: 'table.updated',
            table: publicTable(table),
            ...(syncProgress ? { syncProgress: true as const } : {}),
          },
      prev: {},
    },
    ids,
  );
  if (stats)
    await query(
      c.db,
      sql`UPDATE ${ident(c.schemas.app, 'sync_runs')}
    SET seq = (SELECT seq FROM ${ident(c.schemas.app, 'changes')}
      WHERE database_id = ${c.databaseId} AND command_id = ${ids.commandId} AND kind = 'table.synced')
    WHERE id = ${job.lease_token}`,
    );
}

/** The row lease is claimed briefly; remote I/O never owns a command lock. */
export async function claimSyncs(
  ctx: AppContext,
  limit: number,
  priority: string[] = [],
): Promise<SyncJob[]> {
  const { pool, schemas } = dataStore(ctx);
  return withTransaction(pool, async (db) => {
    const result = await query<SyncJob>(
      db,
      sql`SELECT ts.*, t.database_id, t.org_id
      FROM ${ident(schemas.app, 'table_sources')} ts
      JOIN ${ident(schemas.app, 'tables')} t ON t.id = ts.table_id
      JOIN ${ident(schemas.app, 'databases')} d ON d.id = t.database_id
      WHERE t.trashed_at IS NULL AND d.trashed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM ${ident(schemas.app, 'sources')} s WHERE s.id = ts.source_id AND s.import_paused)
      AND ((ts.next_sync_at <= now() AND ts.lease_at IS NULL) OR ts.lease_at < now() - interval '30 minutes')
      ORDER BY (ts.table_id = ANY(${priority}::text[])) DESC,
        ts.next_sync_at NULLS FIRST, ts.table_id LIMIT ${limit} FOR UPDATE OF ts SKIP LOCKED`,
    );
    for (const job of result.rows) {
      job.lease_token = newId('job');
      await query(
        db,
        sql`UPDATE ${ident(schemas.app, 'table_sources')} SET lease_at = now(), lease_token = ${job.lease_token}
        WHERE table_id = ${job.table_id}`,
      );
    }
    return result.rows;
  });
}

async function owned(c: CommandContext, job: SyncJob): Promise<boolean> {
  const result = await query(
    c.db,
    sql`SELECT ts.table_id FROM ${ident(c.schemas.app, 'table_sources')} ts
    JOIN ${ident(c.schemas.app, 'tables')} t ON t.id = ts.table_id
    JOIN ${ident(c.schemas.app, 'databases')} d ON d.id = t.database_id
    WHERE ts.table_id = ${job.table_id} AND ts.lease_token = ${job.lease_token}
    AND t.trashed_at IS NULL AND d.trashed_at IS NULL FOR UPDATE OF ts`,
  );
  return Boolean(result.rowCount);
}

async function saveStatus(
  c: CommandContext,
  job: SyncJob,
  status: SyncStatus,
  failures: number,
  heldToken: string | null = null,
): Promise<void> {
  await finishSyncRun(c.db, c.schemas, job.lease_token, status);
  const pending = await query<{ queued_again: boolean }>(
    c.db,
    sql`SELECT queued_again FROM ${ident(c.schemas.app, 'table_sources')} WHERE table_id = ${job.table_id}`,
  );
  if (pending.rows[0]?.queued_again && status.state !== 'held') {
    status = { ...status, state: 'queued', nextSyncAt: new Date().toISOString() };
  }
  await query(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, 'table_sources')} SET queued_again = false, status = ${JSON.stringify(status)}::jsonb,
    next_sync_at = ${status.nextSyncAt}::timestamptz, lease_at = NULL, lease_token = NULL,
    failures = ${failures}, held_token = ${heldToken}, confirm_removals = false
    WHERE table_id = ${job.table_id} AND lease_token = ${job.lease_token}`,
  );
}

export function retryMinutes(failures: number, interval: number | null): number {
  return Math.min(5 * 2 ** Math.min(Math.max(failures - 1, 0), 20), interval ?? 10_080);
}

async function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new ConnectorError('sources.sync.timeout'));
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}

async function stage(
  ctx: AppContext,
  job: SyncJob,
  signal: AbortSignal,
  diagnostics: { secrets?: SourceSecrets },
): Promise<Staged> {
  const { pool, schemas } = dataStore(ctx);
  const source = await loadSource(pool, schemas, job.settings.sourceId, job.org_id);
  const fields = (await loadFields(pool, schemas, [job.table_id], { includeTrashed: true })).filter(
    (field) => field.source,
  );
  const types: Record<string, string> = Object.fromEntries(
    fields.map((field) => [field.source!.column, field.type]),
  );
  const connector = connectorFor(source.kind);
  const connection = await connectorContext(source, ctx.config.secretKey, signal, undefined, ctx);
  diagnostics.secrets = connection.secrets;
  const columns = [...new Set([...Object.keys(types), ...job.settings.keyColumns])];
  const described = await bounded(connector.describe(connection, job.settings.select), signal);
  for (const key of job.settings.keyColumns)
    types[key] ??= described.find((column) => column.name === key)?.suggested?.type ?? 'text';
  let validators: Validators | null = null;
  let incremental = false;
  const batches = connector.read(connection, job.settings.select, {
    columns,
    types,
    keyColumns: job.settings.keyColumns,
    batchSize: 5_000,
    onIncremental: () => {
      incremental = true;
    },
    ...(job.fetch_state ? { since: job.fetch_state } : {}),
    onValidators: (given) => {
      validators = Object.keys(given).length ? given : null;
    },
  });
  const iterator = batches[Symbol.asyncIterator]();
  // Counts rows across batches, so the apply can add new records in the order the source gave them.
  let ordinal = 0;
  let reported = 0;
  let reportedAt = 0;
  const report = async () => {
    await withTransaction(pool, async (db) => {
      const c = context(ctx, db, job);
      await lock(c, [`database:${job.database_id}`]);
      if (!(await owned(c, job))) return;
      await query(
        db,
        sql`UPDATE ${ident(schemas.app, 'table_sources')}
        SET status = jsonb_set(status, '{progress}', ${JSON.stringify({ rowsRead: ordinal })}::jsonb)
        WHERE table_id = ${job.table_id}`,
      );
      await publish(c, job, undefined, true);
    });
    reported = ordinal;
    reportedAt = Date.now();
  };
  try {
    for (;;) {
      let batch: IteratorResult<SourceRow[]>;
      try {
        batch = await bounded(iterator.next(), signal);
      } catch (error) {
        // A feed that says nothing changed since the last sync has nothing to stage.
        if (error instanceof NotModified && ordinal === 0) return { changed: false };
        throw error;
      }
      if (batch.done) break;
      const mappedRows = batch.value.map((row) => {
        let keys: CellValue[];
        try {
          keys = JSON.parse(row.key) as CellValue[];
        } catch {
          throw new ConnectorError('sources.sync.keyEmpty');
        }
        if (
          !Array.isArray(keys) ||
          keys.length !== job.settings.keyColumns.length ||
          keys.some((key) => key === null || key === undefined || key === '')
        )
          throw new ConnectorError('sources.sync.keyEmpty');
        ordinal += 1;
        return {
          source_key: sourceKey(keys),
          record_id: newId('record'),
          ordinal,
          values: row.deleted ? null : row.values,
        };
      });
      const rows = incremental
        ? [...new Map(mappedRows.map((row) => [row.source_key, row])).values()]
        : mappedRows;
      const seen = new Set<string>();
      for (const row of rows) {
        if (seen.has(row.source_key))
          throw new ConnectorError('sources.sync.keyDuplicate', undefined, { key: row.source_key });
        seen.add(row.source_key);
      }
      const duplicates = await query<{ source_key: string }>(
        pool,
        sql`SELECT source_key FROM ${ident(schemas.app, 'source_stage')}
        WHERE token = ${job.lease_token} AND source_key = ANY(${[...seen]}::text[]) LIMIT 1`,
      );
      if (!incremental && duplicates.rows[0])
        throw new ConnectorError('sources.sync.keyDuplicate', undefined, {
          key: duplicates.rows[0].source_key,
        });
      await query(
        pool,
        sql`INSERT INTO ${ident(schemas.app, 'source_stage')} (token, table_id, source_key, record_id, ordinal, values)
        SELECT ${job.lease_token}, ${job.table_id}, source_key, record_id, ordinal, COALESCE(values, 'null'::jsonb)
        FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS batch(source_key text, record_id text, ordinal bigint, values jsonb)
        ${incremental ? sql`ON CONFLICT (token, source_key) DO UPDATE SET values = EXCLUDED.values, ordinal = EXCLUDED.ordinal` : sql``}`,
      );
      // Bound status traffic even when a connector gives many small batches.
      if (Date.now() - reportedAt >= 250) await report();
    }
    if (ordinal !== reported) await report();
  } finally {
    // Do not let an unresponsive remote iterator hold shutdown past its deadline.
    void iterator.return?.().catch(() => undefined);
  }
  return { changed: true, validators, incremental };
}

async function selectChoices(c: CommandContext, fields: StoredField[], token: string): Promise<void> {
  for (const field of fields) {
    if (field.type !== 'singleSelect' && field.type !== 'multipleSelect') continue;
    const column = field.source!.column;
    const labels = await query<{ label: string }>(
      c.db,
      field.type === 'singleSelect'
        ? sql`SELECT DISTINCT values ->> ${column} AS label FROM ${ident(c.schemas.app, 'source_stage')} WHERE token = ${token} AND values ->> ${column} IS NOT NULL AND values ->> ${column} <> ''`
        : sql`SELECT DISTINCT label FROM ${ident(c.schemas.app, 'source_stage')}, jsonb_array_elements_text(CASE WHEN jsonb_typeof(values -> ${column}) = 'array' THEN values -> ${column} ELSE '[]'::jsonb END) label WHERE token = ${token}`,
    );
    const existing = new Set(field.options.choices.map((choice) => choice.name));
    const additions = labels.rows
      .filter(({ label }) => !existing.has(label))
      .map(({ label }) => ({ id: newId('choice'), name: label, color: 'gray' as const }));
    if (additions.length) {
      const before = publicField(field);
      field.options = { ...field.options, choices: [...field.options.choices, ...additions] };
      await query(
        c.db,
        sql`UPDATE ${ident(c.schemas.app, 'fields')} SET options = ${JSON.stringify(field.options)}::jsonb, updated_at = now() WHERE id = ${field.id}`,
      );
      await recordChange(
        c,
        {
          body: { kind: 'field.updated', field: publicField(field), removedChoiceIds: [] },
          prev: { field: { ...before, columnName: field.columnName } },
        },
        changeIds(),
      );
    }
    const mapping = JSON.stringify(
      Object.fromEntries(field.options.choices.map((choice) => [choice.name, choice.id])),
    );
    const mapped =
      field.type === 'singleSelect'
        ? sql`${mapping}::jsonb -> (values ->> ${column})`
        : sql`(SELECT jsonb_agg(${mapping}::jsonb -> label ORDER BY position) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(values -> ${column}) = 'array' THEN values -> ${column} ELSE '[]'::jsonb END) WITH ORDINALITY AS labels(label, position))`;
    // Store mapped values by field ID; two fields may map the same source column differently.
    await query(
      c.db,
      sql`UPDATE ${ident(c.schemas.app, 'source_stage')} SET values = jsonb_set(values, ARRAY[${field.id}]::text[], COALESCE(${mapped}, 'null'::jsonb)) WHERE token = ${token} AND values <> 'null'::jsonb`,
    );
  }
}

/**
 * Links that follow values from the synced table catch up in the same transaction: added and
 * changed records link to their matches, and records that went missing or came back show or hide
 * in their partners' lists.  Their list changes are broadcast like any others.
 */
async function followMatches(c: CommandContext, tableId: string): Promise<void> {
  const links = matchedLinks(await loadFields(c.db, c.schemas, [tableId]));
  if (!links.length) return;
  const refresh = new MatchRefresh(c.db, c.schemas.data, null);
  for (const link of links) {
    await refresh.refresh(
      link,
      sql`t.__source_key IN (SELECT source_key FROM sync_plan WHERE added OR changed)`,
    );
    await refresh.partners(
      link,
      sql`(t.__source_gone AND t.__synced_at = now())
      OR t.__source_key IN (SELECT source_key FROM sync_plan WHERE returned)`,
    );
  }
  const ids = changeIds();
  for await (const body of refresh.changes()) await recordChange(c, { body, prev: {} }, ids);
}

function jsonObject(entries: Array<[string, Sql]>): Sql {
  // Fifty pairs fit the function argument limit without repeatedly copying a growing object.
  const objects: Sql[] = [];
  for (let offset = 0; offset < entries.length; offset += 50) {
    const pairs = entries.slice(offset, offset + 50).flatMap(([key, value]) => [sql`${key}::text`, value]);
    objects.push(sql`jsonb_build_object(${join(pairs, ', ')})`);
  }
  return objects.reduce<Sql>((result, object) => sql`${result} || ${object}`, sql`'{}'::jsonb`);
}

async function apply(
  ctx: AppContext,
  job: SyncJob,
  started: number,
  staged: Staged = {
    changed: true,
    validators: job.fetch_state?.pending?.validators ?? job.fetch_state,
    incremental: job.fetch_state?.pending?.incremental ?? false,
  },
): Promise<void> {
  const { pool, schemas } = dataStore(ctx);
  await withTransaction(
    pool,
    async (db) => {
      const c = context(ctx, db, job);
      await lock(c, [`database:${job.database_id}`]);
      if (!(await owned(c, job))) return;
      const table = (await loadTable(db, schemas, job.table_id))!;
      const settings = table.source!;
      const token = job.confirm_removals && job.held_token ? job.held_token : job.lease_token;
      const target = ident(schemas.data, job.table_id);
      // Items that scroll out of a feed stay, unless the table says to remove them.
      const removes = removesMissing(settings, settings.sourceKind);
      const incremental = staged.changed && staged.incremental === true;
      const missing = incremental
        ? sql`EXISTS (SELECT 1 FROM ${ident(schemas.app, 'source_stage')} s WHERE s.token = ${token} AND s.source_key = r.__source_key AND s.values = 'null'::jsonb)`
        : sql`NOT EXISTS (SELECT 1 FROM ${ident(schemas.app, 'source_stage')} s WHERE s.token = ${token} AND s.source_key = r.__source_key)`;
      const counts = await query<{ total: string; removing: string }>(
        db,
        sql`SELECT count(*) AS total,
      count(*) FILTER (WHERE ${removes}::boolean AND ${missing}) AS removing
      FROM ${target} r WHERE NOT r.__source_gone AND r.__deleted_at IS NULL`,
      );
      const total = Number(counts.rows[0]!.total);
      const removing = Number(counts.rows[0]!.removing);
      const now = new Date().toISOString();
      const nextSyncAt =
        settings.everyMinutes === null || settings.freshness === 'live'
          ? null
          : new Date(Date.now() + settings.everyMinutes * 60_000).toISOString();
      if (!staged.changed) {
        // The source said nothing changed, so every record stands as it is.
        await saveStatus(
          c,
          job,
          {
            state: 'idle',
            lastSyncAt: now,
            lastSuccessAt: now,
            nextSyncAt,
            stats: {
              added: 0,
              changed: 0,
              removed: 0,
              unchanged: total,
              overridesCleared: 0,
              ms: Date.now() - started,
            },
            error: null,
            held: null,
          },
          0,
        );
        await publish(c, job);
        return;
      }
      if (!job.confirm_removals && total >= 20 && removing / total > settings.holdAboveDeleteShare) {
        await saveStatus(
          c,
          job,
          {
            ...settings.status,
            state: 'held',
            lastSyncAt: now,
            nextSyncAt: null,
            error: null,
            held: { removing, total },
          },
          0,
          token,
        );
        if (staged.changed)
          await query(
            db,
            sql`UPDATE ${ident(schemas.app, 'table_sources')}
          SET fetch_state = ${JSON.stringify({ ...job.fetch_state, pending: { validators: staged.validators, incremental } })}::jsonb
          WHERE table_id = ${job.table_id}`,
          );
        // Its creator hears once when it starts waiting, not again for each sync that waits on.
        if (!job.held_token)
          await notifySync(db, schemas, 'syncHeld', job.table_id, { held: { removing, total } });
        await publish(c, job);
        return;
      }
      const fields = (await loadFields(db, schemas, [job.table_id])).filter((field) => field.source);
      await selectChoices(c, fields, token);
      const typed = fields.map(
        (field) =>
          sql`${sourceCellValue(field, sql`s.values -> ${['singleSelect', 'multipleSelect'].includes(field.type) ? field.id : field.source!.column}`)} AS ${ident(field.columnName)}`,
      );
      const sourceValue = (field: StoredField) =>
        sql`COALESCE(to_jsonb(${field.type === 'number' ? columnRef(field, 's') : selectExpr(field, 's')}), 'null'::jsonb)`;
      const currentValue = (field: StoredField) =>
        sql`COALESCE(to_jsonb(${field.type === 'number' ? columnRef(field, 'r') : selectExpr(field, 'r')}), 'null'::jsonb)`;
      const pinSource = (field: StoredField) => {
        const raw = sql`s.values -> ${field.source!.column}`;
        return sql`CASE WHEN ${sourceArrayCondition(field, raw)} THEN ${raw} ELSE ${sourceValue(field)} END`;
      };
      const keepsOverride = (field: StoredField) =>
        sql`(r.__overrides ? ${field.id} AND (${sourceArrayCondition(field, sql`s.values -> ${field.source!.column}`)} OR ${currentValue(field)} IS DISTINCT FROM ${sourceValue(field)}))`;
      const values = jsonObject(
        fields.map((field) => [
          field.id,
          sql`CASE WHEN ${keepsOverride(field)} THEN ${currentValue(field)} ELSE ${sourceValue(field)} END`,
        ]),
      );
      const previous = jsonObject(fields.map((field) => [field.id, currentValue(field)]));
      const sourceBefore = jsonObject(
        fields.map((field) => [
          field.id,
          sql`CASE WHEN r.__id IS NULL THEN 'null'::jsonb WHEN r.__overrides ? ${field.id} THEN r.__overrides -> ${field.id} -> 'source' ELSE ${currentValue(field)} END`,
        ]),
      );
      const sourceAfter = jsonObject(fields.map((field) => [field.id, sourceValue(field)]));
      const retainedOverrides = sql`NULLIF((COALESCE(r.__overrides, '{}'::jsonb) - ${fields.map((field) => field.id)}::text[]) ||
      ${fields.reduce<Sql>(
        (
          result,
          field,
        ) => sql`${result} || CASE WHEN ${keepsOverride(field)} THEN jsonb_build_object(${field.id}::text,
        jsonb_set(r.__overrides -> ${field.id}, '{source}', ${pinSource(field)})) ELSE '{}'::jsonb END`,
        sql`'{}'::jsonb`,
      )}, '{}'::jsonb)`;
      const cellErrors = sql`jsonb_strip_nulls(${jsonObject(
        fields.map((field) => {
          const value = sql`s.values -> ${field.source!.column}`;
          return [
            field.id,
            sql`CASE WHEN ${sourceArrayCondition(field, value)} THEN jsonb_build_object('messageKey', ${ARRAY_CELL_ERROR}::text, 'source', ${value}) END`,
          ];
        }),
      )})`;
      const overrides = withSourceCellErrors(retainedOverrides, cellErrors);
      const cleared = fields.reduce<Sql>(
        (result, field) =>
          sql`${result} + CASE WHEN r.__overrides ? ${field.id} AND NOT ${keepsOverride(field)} THEN 1 ELSE 0 END`,
        sql`0`,
      );
      // Materializing casts and comparisons keeps wide plans from reevaluating the same cells.
      // Carry raw values with their casts so stale token statistics cannot cause a quadratic self-join.
      await query(
        db,
        sql`CREATE TEMP TABLE sync_plan ON COMMIT DROP AS
      WITH staged AS MATERIALIZED (
        SELECT s.source_key, s.ordinal, s.record_id, s.values || '{}'::jsonb AS values
        FROM ${ident(schemas.app, 'source_stage')} s
        WHERE s.token = ${token} AND s.values <> 'null'::jsonb
      ), incoming AS MATERIALIZED (
        SELECT s.*, ${typed.length ? join(typed, ', ') : sql`TRUE AS unused`}
        FROM staged s
      ), planned AS MATERIALIZED (
      SELECT s.source_key, s.ordinal, COALESCE(r.__id, s.record_id) AS id, r.__id IS NULL AS added,
      r.__source_gone AS returned, ${values} AS values, ${overrides} AS overrides,
      ${sourceBefore} AS source_before, ${sourceAfter} AS source_after,
      ${cleared} AS cleared, ${previous} AS previous, r.__overrides AS previous_overrides
      FROM incoming s
      LEFT JOIN ${target} r ON r.__source_key = s.source_key
      ) SELECT source_key, ordinal, id, added, returned, values, overrides, source_before, source_after, cleared,
        (returned OR values IS DISTINCT FROM previous OR overrides IS DISTINCT FROM previous_overrides) AS changed
      FROM planned`,
      );
      await query(
        db,
        sql`INSERT INTO ${ident(schemas.app, 'sync_record_changes')}
        (run_id, record_id, before_values, after_values)
        SELECT ${job.lease_token}, id,
          COALESCE((SELECT jsonb_object_agg(key, value) FROM jsonb_each(source_before)
            WHERE value IS DISTINCT FROM source_after -> key), '{}'::jsonb),
          COALESCE((SELECT jsonb_object_agg(key, value) FROM jsonb_each(source_after)
            WHERE value IS DISTINCT FROM source_before -> key), '{}'::jsonb)
        FROM sync_plan WHERE source_before IS DISTINCT FROM source_after`,
      );
      const summary = await query<{
        added: string;
        changed: string;
        unchanged: string;
        cleared: string;
        returned: string;
      }>(
        db,
        sql`SELECT
      count(*) FILTER (WHERE added) AS added, count(*) FILTER (WHERE NOT added AND changed) AS changed,
      count(*) FILTER (WHERE NOT added AND returned) AS returned,
      count(*) FILTER (WHERE NOT added AND NOT changed) AS unchanged, COALESCE(sum(cleared), 0) AS cleared FROM sync_plan`,
      );
      // Rows are numbered (`__rid`) as they're inserted, and a view without sorts lists records by
      // that number, so new records go in the order the source gave them.
      // Unpack once per record so wide values are not decompressed for every field being written.
      const cells = fields.length
        ? sql`CROSS JOIN LATERAL jsonb_to_record(p.values) AS cells(${join(
            fields.map((field) => sql`${ident(field.id)} jsonb`),
            ', ',
          )})`
        : sql``;
      const writeValue = (field: StoredField) => jsonValueExpr(field, sql`${ident('cells', field.id)}`);
      await query(
        db,
        sql`INSERT INTO ${target} (__id, __source_key, __synced_at, __overrides ${
          fields.length
            ? sql`, ${join(
                fields.map((field) => sql`${ident(field.columnName)}`),
                ', ',
              )}`
            : sql``
        })
      SELECT id, source_key, now(), p.overrides ${
        fields.length ? sql`, ${join(fields.map(writeValue), ', ')}` : sql``
      } FROM sync_plan p ${cells} WHERE added ORDER BY p.ordinal, p.source_key`,
      );
      await query(
        db,
        sql`UPDATE ${target} r SET __source_gone = false, __synced_at = now(), __overrides = p.overrides,
      __updated_at = CASE WHEN p.changed THEN now() ELSE r.__updated_at END,
      __updated_by = CASE WHEN p.changed THEN NULL ELSE r.__updated_by END
      ${
        fields.length
          ? sql`, ${join(
              fields.map((field) => sql`${ident(field.columnName)} = ${writeValue(field)}`),
              ', ',
            )}`
          : sql``
      }
      FROM sync_plan p ${cells} WHERE NOT p.added AND r.__source_key = p.source_key`,
      );
      if (removes)
        await query(
          db,
          sql`UPDATE ${target} r SET __source_gone = true, __synced_at = now(), __updated_at = now(), __updated_by = NULL
        WHERE NOT r.__source_gone AND ${missing}`,
        );
      // The answer's validators go with the records it gave, so a sync that fails asks in full again.
      await query(
        db,
        sql`UPDATE ${ident(schemas.app, 'table_sources')} SET fetch_state = ${staged.validators ? JSON.stringify(staged.validators) : null}::jsonb
        WHERE table_id = ${job.table_id}`,
      );
      await followMatches(c, job.table_id);
      const result = summary.rows[0]!;
      const stats: SyncStats = {
        added: Number(result.added),
        changed: Number(result.changed),
        unchanged: incremental
          ? Math.max(0, total - removing - Number(result.changed) + Number(result.returned))
          : Number(result.unchanged),
        removed: removing,
        overridesCleared: Number(result.cleared),
        ms: Date.now() - started,
      };
      await saveStatus(
        c,
        job,
        {
          state: 'idle',
          lastSyncAt: now,
          lastSuccessAt: now,
          // A table switched to Live while this sync ran doesn't sync again.
          nextSyncAt,
          stats,
          error: null,
          held: null,
        },
        0,
      );
      await bumpVersion(c, job.table_id);
      await publish(c, job, stats);
      await publish(c, job);
    },
    LONG_DEADLINES,
  );
}

export async function runSync(
  ctx: AppContext,
  job: SyncJob,
  signal = AbortSignal.timeout(25 * 60_000),
): Promise<void> {
  const { pool, schemas } = dataStore(ctx);
  const started = Date.now();
  const diagnostics: { secrets?: SourceSecrets } = {};
  try {
    const ready = await withTransaction(pool, async (db) => {
      const c = context(ctx, db, job);
      await lock(c, [`database:${job.database_id}`]);
      if (!(await owned(c, job))) return false;
      await startSyncRun(db, schemas, job.table_id, job.lease_token);
      const latest = await query<SyncJob>(
        db,
        sql`SELECT * FROM ${ident(schemas.app, 'table_sources')} WHERE table_id = ${job.table_id}`,
      );
      Object.assign(job, latest.rows[0]);
      const status = {
        ...job.status,
        state: 'running',
        lastSyncAt: new Date().toISOString(),
        nextSyncAt: null,
        progress: { rowsRead: 0 },
      };
      await query(
        db,
        sql`UPDATE ${ident(schemas.app, 'table_sources')} SET status = ${JSON.stringify(status)}::jsonb WHERE table_id = ${job.table_id}`,
      );
      await publish(c, job, undefined, true);
      return true;
    });
    if (!ready) return;
    const staged =
      !job.confirm_removals || !job.held_token ? await stage(ctx, job, signal, diagnostics) : undefined;
    signal.throwIfAborted();
    await apply(ctx, job, started, staged);
  } catch (error) {
    const timedOut =
      signal.aborted ||
      (error &&
        typeof error === 'object' &&
        'code' in error &&
        (error.code === '57014' || error.code === '55P03'));
    const messageKey = timedOut
      ? 'sources.sync.timeout'
      : error instanceof ConnectorError || error instanceof AppError
        ? error.messageKey
        : 'sources.sync.failed';
    const detail =
      error instanceof ConnectorError && diagnostics.secrets
        ? safeDetail(error.detail, diagnostics.secrets)
        : undefined;
    const params =
      error instanceof ConnectorError
        ? messageParams(error)
        : error instanceof AppError
          ? error.params
          : undefined;
    await withTransaction(pool, async (db) => {
      const c = context(ctx, db, job);
      await lock(c, [`database:${job.database_id}`]);
      if (!(await owned(c, job))) return;
      const table = (await loadTable(db, schemas, job.table_id))!;
      const failures = job.failures + 1;
      await saveStatus(
        c,
        job,
        {
          ...table.source!.status,
          state: 'failed',
          lastSyncAt: new Date().toISOString(),
          nextSyncAt:
            table.source!.freshness === 'live'
              ? null
              : new Date(
                  Date.now() + retryMinutes(failures, table.source!.everyMinutes) * 60_000,
                ).toISOString(),
          error: { messageKey, ...(detail ? { detail } : {}), ...(params ? { params } : {}) },
          held: null,
        },
        failures,
      );
      // Its creator hears when it starts failing, not again for each retry that fails.
      if (failures === 1)
        await notifySync(db, schemas, 'syncFailed', job.table_id, { reason: reasonOf(messageKey, params) });
      await publish(c, job);
    });
  } finally {
    await query(
      pool,
      sql`DELETE FROM ${ident(schemas.app, 'source_stage')} s WHERE s.table_id = ${job.table_id}
      AND NOT EXISTS (SELECT 1 FROM ${ident(schemas.app, 'table_sources')} ts WHERE ts.table_id = s.table_id AND (ts.held_token = s.token OR ts.lease_token = s.token))`,
    );
    await query(
      pool,
      sql`UPDATE ${ident(schemas.app, 'sync_runs')}
      SET outcome = 'canceled', ended_at = now(), stats = jsonb_build_object(
        'added', 0, 'changed', 0, 'removed', 0, 'unchanged', 0, 'overridesCleared', 0,
        'ms', EXTRACT(epoch FROM now() - started_at) * 1000)
      WHERE id = ${job.lease_token} AND outcome = 'running'`,
    );
    // Trashing a table while staging cancels the apply and releases its claim for restoration.
    await query(
      pool,
      sql`UPDATE ${ident(schemas.app, 'table_sources')} SET lease_at = NULL, lease_token = NULL
      WHERE table_id = ${job.table_id} AND lease_token = ${job.lease_token}`,
    );
  }
}
