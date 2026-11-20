import { AppError, type IngestOriginalCommand, type IngestOrganizationCommand } from '@riosoma/contracts';
import { compile, ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import type { Actor } from '../../http/policy.js';
import { auditEvent } from '../../auth/database.js';
import { AccessScope } from '../../data/access.js';
import { dataStore, type DataSchemas } from '../../data/context.js';
import { loadTable } from '../../data/metadata.js';
import { refuseDemo } from '../../demo/boundary.js';
import { IngestTableStore } from '../tables/store.js';
import {
  applyPeriods,
  confirmRetention,
  drainOriginalDeletions,
  lockDatabase,
  organizationIngest,
  retentionPreview,
} from './retention.js';

const notFound = () => new AppError('not_found', 'errors.notFound');
export function shareLocation(share: { kind: 'view' | 'interface' | 'site'; id: string }) {
  return share.kind === 'view'
    ? { catalog: 'shared_views', column: 'id' }
    : { catalog: 'published_sites', column: share.kind === 'site' ? 'slug' : 'interface_id' };
}
async function audit(
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  action: string,
  metadata: Record<string, unknown>,
) {
  await auditEvent(db, compile(sql`${ident(schemas.audit)}`).text, action, actor, metadata);
}

export async function runOriginalCommand(
  app: FastifyInstance,
  actor: Actor,
  tableId: string,
  command: IngestOriginalCommand,
) {
  refuseDemo(actor);
  const { pool, schemas } = dataStore(app.ctx);
  const result = await withTransaction(pool, async (db) => {
    const before = await loadTable(db, schemas, tableId);
    if (!before || before.orgId !== actor.orgId || before.trashed) throw notFound();
    await new AccessScope(db, schemas, actor).require(before.databaseId, 'editSchema');
    await lockDatabase(db, schemas, before.databaseId);
    await query(db, sql`SELECT id FROM ${ident(schemas.app, 'orgs')} WHERE id = ${actor.orgId} FOR SHARE`);
    const table = await loadTable(db, schemas, tableId);
    if (!table?.ingest || table.trashed) throw notFound();
    const store = new IngestTableStore(pool, schemas).inTransaction(db);
    if (command.kind === 'ingest.originals.share') {
      const { catalog, column } = shareLocation(command.share);
      const changed = await query(
        db,
        sql`UPDATE ${ident(schemas.app, catalog)} SET originals_access = ${command.enabled}
        WHERE ${ident(column)} = ${command.share.id} AND org_id = ${actor.orgId}
          AND database_id = ${table.databaseId}
          ${command.share.kind === 'view' ? sql`AND view_id IN (SELECT id FROM ${ident(schemas.app, 'views')} WHERE table_id = ${tableId})` : sql``}
        RETURNING ${ident(column)}`,
      );
      if (!changed.rowCount) throw notFound();
      await audit(db, schemas, actor, 'data.ingest.originals.share', {
        tableId,
        share: command.share,
        enabled: command.enabled,
      });
      return { status: 'applied' as const };
    }
    if (command.kind === 'ingest.originals.readOnly') {
      await store.changeSettings({ ...actor, tableId }, table.ingest.revision, {
        ...table.ingest,
        originals: { ...table.ingest.originals, readOnlyAccess: command.enabled },
      });
      await audit(db, schemas, actor, 'data.ingest.originals.readOnly', {
        tableId,
        enabled: command.enabled,
      });
      return { status: 'applied' as const };
    }
    const organization = await organizationIngest(db, schemas, actor.orgId);
    const tables = [
      {
        id: tableId,
        database_id: table.databaseId,
        keepDays: command.keepDays ?? organization.originalKeepDays,
      },
    ];
    const preview = await retentionPreview(db, schemas, actor.orgId, tables);
    const oldDays = table.ingest.originals.keepDays ?? organization.originalKeepDays;
    const shortening =
      tables[0]!.keepDays !== 'forever' && (oldDays === 'forever' || tables[0]!.keepDays < oldDays);
    const confirmation = shortening
      ? confirmRetention(
          app.ctx.config.secretKey,
          [actor.orgId, actor.userId, tableId, command.keepDays, table.ingest.revision, organization],
          preview,
          command.confirmationToken,
        )
      : null;
    if (confirmation) return confirmation;
    await store.changeSettings({ ...actor, tableId }, table.ingest.revision, {
      ...table.ingest,
      originals: { ...table.ingest.originals, keepDays: command.keepDays },
    });
    await applyPeriods(app.ctx, db, actor.orgId, tables);
    const totals = { originals: preview.originals, bytes: preview.bytes, examples: preview.examples };
    await audit(db, schemas, actor, 'data.ingest.originals.retention', {
      tableId,
      keepDays: command.keepDays,
      ...totals,
    });
    return { status: 'applied' as const, ...totals };
  });
  if (result.status === 'applied') await drainOriginalDeletions(app.ctx);
  return result;
}

export async function runIngestOrganizationCommand(
  app: FastifyInstance,
  actor: Actor,
  command: IngestOrganizationCommand,
) {
  refuseDemo(actor);
  const { pool, schemas } = dataStore(app.ctx);
  const result = await withTransaction(pool, async (db) => {
    await new AccessScope(db, schemas, actor).requireOrganizationAdmin('security');
    // Database locks precede the organization row, matching arrival and schema commands.
    const databases = await query<{ id: string }>(
      db,
      sql`SELECT id FROM ${ident(schemas.app, 'databases')} WHERE org_id = ${actor.orgId} ORDER BY id`,
    );
    for (const database of databases.rows) await lockDatabase(db, schemas, database.id);
    await query(
      db,
      sql`SELECT id FROM ${ident(schemas.app, 'orgs')} WHERE id = ${actor.orgId} FOR NO KEY UPDATE`,
    );
    const before = await organizationIngest(db, schemas, actor.orgId);
    const followers = await query<{ id: string; database_id: string }>(
      db,
      sql`SELECT id, database_id FROM ${ident(schemas.app, 'tables')}
      WHERE org_id = ${actor.orgId} AND ingest IS NOT NULL AND ingest->'originals'->>'keepDays' IS NULL ORDER BY id`,
    );
    const tables = followers.rows.map((table) => ({ ...table, keepDays: command.settings.originalKeepDays }));
    const preview = await retentionPreview(db, schemas, actor.orgId, tables);
    const shortening =
      command.settings.originalKeepDays !== 'forever' &&
      (before.originalKeepDays === 'forever' || command.settings.originalKeepDays < before.originalKeepDays);
    const confirmation = !shortening
      ? null
      : confirmRetention(
          app.ctx.config.secretKey,
          [actor.orgId, actor.userId, before, command.settings],
          preview,
          command.confirmationToken,
        );
    if (confirmation) return confirmation;
    await query(
      db,
      sql`UPDATE ${ident(schemas.app, 'orgs')} SET settings = COALESCE(settings, '{}'::jsonb)
        || jsonb_build_object('ingest', ${JSON.stringify(command.settings)}::jsonb) WHERE id = ${actor.orgId}`,
    );
    if (before.originalKeepDays !== command.settings.originalKeepDays)
      await applyPeriods(app.ctx, db, actor.orgId, tables);
    const totals = { originals: preview.originals, bytes: preview.bytes, examples: preview.examples };
    await audit(db, schemas, actor, 'organization.ingest', { settings: command.settings, ...totals });
    return { status: 'applied' as const, settings: command.settings, ...totals };
  });
  if (result.status === 'applied') await drainOriginalDeletions(app.ctx);
  return result;
}
