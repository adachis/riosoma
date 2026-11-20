import { ident, sql, type Sql } from '@riosoma/db';
import type { DataSchemas } from './context.js';

export function recordHistoryQuery(
  schemas: Pick<DataSchemas, 'app'>,
  databaseId: string | Sql,
  tableId: string,
  recordId: string | Sql,
  cursor?: number,
): Sql {
  // Limit record references first, then read only those changes by their primary key.
  return sql`WITH page AS MATERIALIZED (
    SELECT seq FROM ${ident(schemas.app, 'record_changes')}
    WHERE database_id = ${databaseId} AND table_id = ${tableId} AND record_id = ${recordId}
      AND ${cursor === undefined ? sql`TRUE` : sql`seq < ${cursor}`}
    ORDER BY seq DESC LIMIT 51
  ), local AS (SELECT c.seq, c.at, c.actor_id, c.client_id, c.body, c.prev, c.origin, false AS synced FROM page p
    CROSS JOIN LATERAL (
      SELECT seq, at, actor_id, client_id, body, prev, origin FROM ${ident(schemas.app, 'changes')}
      WHERE database_id = ${databaseId} AND seq = p.seq OFFSET 0
    ) c), source AS (
      SELECT sync_run.seq, sync_run.ended_at AS at, NULL::text AS actor_id, NULL::text AS client_id,
        jsonb_build_object('kind', 'record.updated', 'tableId', ${tableId}::text,
          'records', jsonb_build_array(jsonb_build_object('id', h.record_id, 'values', h.after_values))) AS body,
        jsonb_build_object('records', jsonb_build_array(jsonb_build_object('id', h.record_id, 'values', h.before_values))) AS prev,
        NULL::jsonb AS origin, true AS synced
      FROM ${ident(schemas.app, 'sync_record_changes')} h
      JOIN ${ident(schemas.app, 'sync_runs')} sync_run ON sync_run.id = h.run_id
      JOIN ${ident(schemas.app, 'tables')} t ON t.id = sync_run.table_id
      WHERE sync_run.table_id = ${tableId} AND t.database_id = ${databaseId} AND h.record_id = ${recordId}
        AND sync_run.seq IS NOT NULL AND sync_run.started_at >= now() - t.history_retention_days * interval '1 day'
        AND ${cursor === undefined ? sql`TRUE` : sql`sync_run.seq < ${cursor}`}
      ORDER BY sync_run.seq DESC LIMIT 51
    ) SELECT * FROM (SELECT * FROM local UNION ALL SELECT * FROM source) combined ORDER BY seq DESC LIMIT 51`;
}
