import type { OrgSettings } from '@riosoma/contracts';
import { archiveLogo } from '../branding/store.js';
import { credentialArchiveRow } from './catalog.js';
import { Readable } from 'node:stream';
import {
  ORGANIZATION_ARCHIVE_FORMAT,
  ORGANIZATION_ARCHIVE_VERSION,
  type OrganizationExportOptions,
  type OrganizationManifest,
  type OrganizationPerson,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { AppContext } from '../../app.js';
import type { Actor } from '../../http/policy.js';
import { AccessScope } from '../access.js';
import { dataStore, type DataSchemas } from '../context.js';
import { LONG_DEADLINES } from '../commands/transaction.js';
import { writeArchive } from '../archives/write.js';
import { decompress } from '../archives/store.js';
import { fileStorage, type StorageKind } from '../files/storage.js';
import { MIGRATIONS } from '../../migrations/index.js';
import { ArchiveDirectory, invalidArchive, line, workDirOf } from './container.js';
import {
  DATABASE_CATALOGS,
  ORG_CATALOGS,
  publicRow,
  rows,
  withoutSignerVisit,
  type Row,
  type SecretValue,
} from './catalog.js';
import {
  archiveKeys,
  encryptSecret,
  encryptionParameters,
  forgetKeys,
  manifestMac,
  type SecretPlace,
} from './encryption.js';

export const SCHEMA_VERSION = Math.max(...MIGRATIONS.map((migration) => Number(migration.id.slice(0, 4))));

function databaseRows(schemas: DataSchemas, catalog: string, databaseId: string) {
  const table = ident(schemas.app, catalog);
  const database = sql`SELECT id FROM ${ident(schemas.app, 'databases')}
    WHERE id = ${databaseId} AND purged_at IS NULL`;
  const tables = sql`SELECT t.id FROM ${ident(schemas.app, 'tables')} t
    JOIN ${ident(schemas.app, 'databases')} d ON d.id = t.database_id
    WHERE d.id IN (${database}) AND d.purged_at IS NULL AND t.purged_at IS NULL`;
  if (catalog === 'tables')
    return sql`SELECT * FROM ${table} WHERE database_id IN (${database}) AND purged_at IS NULL`;
  // Originals depend on ingest arrivals, which are deliberately excluded from archives.
  if (catalog === 'files')
    return sql`SELECT * FROM ${table} WHERE table_id IN (${tables}) AND field_id IS NOT NULL AND ingest_file_id IS NULL`;
  if (catalog === 'databases') return sql`SELECT * FROM ${table} WHERE id IN (${database})`;
  if (
    [
      'fields',
      'views',
      'files',
      'table_sources',
      'payment_fields',
      'payment_pages',
      'field_permissions',
      'record_rules',
      'record_locks',
      'booking_pages',
    ].includes(catalog)
  )
    return sql`SELECT * FROM ${table} WHERE table_id IN (${tables})`;
  if (catalog === 'links')
    // The left database owns the entry, including when the destination is another exported database.
    return sql`SELECT l.* FROM ${table} l
      JOIN ${ident(schemas.app, 'tables')} rt ON rt.id = l.right_table_id
      JOIN ${ident(schemas.app, 'databases')} rd ON rd.id = rt.database_id
      WHERE l.left_table_id IN (${tables}) AND rt.purged_at IS NULL AND rd.purged_at IS NULL
        AND rd.org_id = (SELECT org_id FROM ${ident(schemas.app, 'databases')} WHERE id = ${databaseId})`;
  if (catalog === 'record_positions')
    return sql`SELECT p.* FROM ${table} p
    JOIN ${ident(schemas.app, 'views')} v ON v.id = p.view_id WHERE v.table_id IN (${tables})`;
  if (catalog === 'comments')
    return sql`SELECT * FROM ${table} WHERE database_id IN (${database})
      AND (table_id IS NULL OR table_id IN (${tables}))`;
  if (catalog === 'grants')
    return sql`SELECT * FROM ${table} WHERE resource_kind = 'database' AND resource_id IN (${database})`;
  // Restoring an installation's webhook without its grant would bypass the need for fresh consent.
  if (catalog === 'webhooks')
    return sql`SELECT w.* FROM ${table} w WHERE w.database_id IN (${database})
      AND NOT EXISTS (SELECT 1 FROM ${ident(schemas.app, 'oauth_webhooks')} o WHERE o.webhook_id = w.id)`;
  // Only live public links and forms: stopped ones are history, and every address is made anew.
  if (catalog === 'shared_views' || catalog === 'public_forms')
    return sql`SELECT * FROM ${table} WHERE database_id IN (${database}) AND stopped_at IS NULL
      AND view_id IN (SELECT id FROM ${ident(schemas.app, 'views')} WHERE table_id IN (${tables}))`;
  return sql`SELECT * FROM ${table} WHERE database_id IN (${database})`;
}

function organizationRows(schemas: DataSchemas, catalog: string, orgId: string) {
  const table = ident(schemas.app, catalog);
  if (catalog === 'knowledge_libraries' || catalog === 'knowledge_documents') {
    const libraries = ident(schemas.app, 'knowledge_libraries');
    const review = ident(schemas.app, 'organization_import_review');
    // Pending definitions travel only while their scope is still unclaimed and their target exists.
    const pending = sql`SELECT r.id, r.org_id, r.scope, r.target, r.name, r.description, r.label, r.guidance
      FROM ${review} p, jsonb_populate_record(NULL::${libraries}, p.detail->'row') r
      WHERE p.org_id = ${orgId} AND p.kind = 'knowledgeLibrary' AND p.done_at IS NULL
        AND r.org_id = ${orgId} AND r.scope <> 'personal'
        AND NOT EXISTS (SELECT 1 FROM ${libraries} live WHERE live.org_id = ${orgId}
          AND (live.id = r.id OR (live.scope = r.scope AND live.target = r.target)))
        AND (r.scope = 'organization' AND r.target = ${orgId}
          OR r.scope = 'unit' AND EXISTS (SELECT 1 FROM ${ident(schemas.app, 'org_units')} u WHERE u.id = r.target AND u.org_id = ${orgId})
          OR r.scope = 'database' AND EXISTS (SELECT 1 FROM ${ident(schemas.app, 'databases')} d WHERE d.id = r.target AND d.org_id = ${orgId} AND d.purged_at IS NULL))`;
    const exported = sql`SELECT id, org_id, scope, target, name, description, label, guidance
      FROM ${libraries} WHERE org_id = ${orgId} AND scope <> 'personal'
        AND (scope <> 'database' OR target IN (SELECT id FROM ${ident(schemas.app, 'databases')}
          WHERE org_id = ${orgId} AND purged_at IS NULL)) UNION ALL ${pending}`;
    if (catalog === 'knowledge_libraries') return exported;
    return sql`WITH exported AS (${exported}),
      pending_libraries AS (
        SELECT r.id, r.org_id, r.scope, r.target FROM ${review} p,
          jsonb_populate_record(NULL::${libraries}, p.detail->'row') r
        WHERE p.org_id = ${orgId} AND p.kind = 'knowledgeLibrary' AND p.done_at IS NULL),
      -- A pending definition whose scope a live library took: its documents follow the live one,
      -- the way a restore merges them, so waiting text is not left behind in the archive.
      merged AS (
        SELECT pending.id AS pending_id, live.id AS library_id FROM pending_libraries pending
        JOIN ${libraries} live ON live.org_id = pending.org_id
          AND live.scope = pending.scope AND live.target = pending.target),
      pending_documents AS (
        SELECT r.id, r.library_id, r.name, r.size, r.source_text FROM ${review} p,
          jsonb_populate_record(NULL::${table}, p.detail->'row') r
        WHERE p.org_id = ${orgId} AND p.kind = 'knowledgeDocument' AND p.done_at IS NULL)
      SELECT d.id, d.library_id, d.name, d.size, d.source_text FROM ${table} d
      JOIN exported l ON l.id = d.library_id
      -- A document still being read has no text to carry yet, and none to search on the other side.
      WHERE length(d.source_text) > 0
      UNION ALL SELECT d.id, COALESCE(m.library_id, d.library_id), d.name, d.size, d.source_text
      FROM pending_documents d LEFT JOIN merged m ON m.pending_id = d.library_id
      WHERE COALESCE(m.library_id, d.library_id) IN (SELECT id FROM exported)
        AND NOT EXISTS (SELECT 1 FROM ${table} live WHERE live.id = d.id)`;
  }
  if (catalog === 'folder_databases')
    return sql`SELECT * FROM ${table} WHERE org_id = ${orgId}
      AND database_id IN (SELECT id FROM ${ident(schemas.app, 'databases')}
        WHERE org_id = ${orgId} AND purged_at IS NULL)`;
  if (catalog === 'orgs') return sql`SELECT * FROM ${table} WHERE id = ${orgId}`;
  if (catalog === 'events')
    return sql`SELECT * FROM ${ident(schemas.audit, 'events')} WHERE org_id = ${orgId} ORDER BY id`;
  if (catalog === 'grants')
    return sql`SELECT * FROM ${table} WHERE org_id = ${orgId} AND resource_kind = 'folder'`;
  // Only registrations an admin made: automatic ones are made again by the clients that need them.
  if (catalog === 'oauth_clients')
    return sql`SELECT * FROM ${table} WHERE org_id = ${orgId} AND verified AND revoked_at IS NULL`;
  return sql`SELECT * FROM ${table} WHERE org_id = ${orgId}`;
}

export async function exportOrganization(
  ctx: AppContext,
  actor: Actor,
  options: OrganizationExportOptions,
  progress: (done: number, total: number) => Promise<void>,
): Promise<ArchiveDirectory> {
  const { pool, schemas } = dataStore(ctx);
  await new AccessScope(pool, schemas, actor).requireOrganizationAdmin('ai', true);
  const directory = await ArchiveDirectory.create(workDirOf(ctx.config));
  const encryption = options.passphrase ? encryptionParameters() : null;
  const keys = encryption ? await archiveKeys(options.passphrase!, encryption) : null;
  try {
    await withTransaction(
      pool,
      async (db) => {
        await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
        const databases = (
          await query<{ id: string; name: string; trashed: boolean }>(
            db,
            sql`SELECT id, name, trashed_at IS NOT NULL AS trashed FROM ${ident(schemas.app, 'databases')}
          WHERE org_id = ${actor.orgId} AND purged_at IS NULL ORDER BY id`,
          )
        ).rows;
        const people = (
          await query<OrganizationPerson>(
            db,
            sql`SELECT u.id, u.name, u.email, m.kind, m.admin_roles AS "adminRoles", m.org_unit_id AS "unitId",
          COALESCE((SELECT jsonb_agg(jsonb_build_object('unitId', a.unit_id, 'roles', a.roles))
            FROM ${ident(schemas.app, 'org_unit_admins')} a WHERE a.org_id = m.org_id AND a.user_id = m.user_id), '[]'::jsonb) AS "unitAdmins",
          EXISTS (SELECT 1 FROM ${ident(schemas.app, 'scim_users')} su
            WHERE su.org_id = m.org_id AND su.user_id = m.user_id AND su.deleted_at IS NULL) AS "scimManaged"
        FROM ${ident(schemas.app, 'memberships')} m JOIN ${ident(schemas.app, 'users')} u ON u.id = m.user_id
        WHERE m.org_id = ${actor.orgId} ORDER BY u.id`,
          )
        ).rows;
        // People an earlier import found who haven't joined yet keep their place in this archive.
        const pending = (
          await query<OrganizationPerson>(
            db,
            sql`SELECT DISTINCT ON (lower(email)) id, name, email, kind, '{}'::text[] AS "adminRoles", false AS "scimManaged",
          (SELECT r.detail->>'unitId' FROM ${ident(schemas.app, 'organization_import_review')} r WHERE r.org_id = ${actor.orgId} AND r.kind = 'person' AND r.target_id = waiting.id LIMIT 1) AS "unitId",
          COALESCE((SELECT r.detail->'unitAdmins' FROM ${ident(schemas.app, 'organization_import_review')} r WHERE r.org_id = ${actor.orgId} AND r.kind = 'person' AND r.target_id = waiting.id LIMIT 1), '[]'::jsonb) AS "unitAdmins"
        FROM (
          SELECT i.reserved_user_id AS id, i.display_name AS name, i.email, i.kind, i.created_at
          FROM ${ident(schemas.app, 'invitations')} i WHERE i.org_id = ${actor.orgId}
            AND i.reserved_user_id IS NOT NULL AND i.accepted_at IS NULL AND i.expires_at > clock_timestamp()
          UNION ALL
          SELECT r.target_id, r.name, r.destinations->0->>'value',
            CASE WHEN r.detail->>'invitedAs' = 'guest' THEN 'guest' ELSE 'member' END, r.created_at
          FROM ${ident(schemas.app, 'organization_import_review')} r
          WHERE r.org_id = ${actor.orgId} AND r.kind = 'person' AND r.done_at IS NULL
        ) waiting
        ORDER BY lower(email), created_at DESC`,
          )
        ).rows;
        for (const person of pending)
          if (!people.some((known) => known.email.toLowerCase() === person.email.toLowerCase()))
            people.push(person);
        const org = (
          await query<{ id: string; name: string }>(
            db,
            sql`SELECT id, name FROM ${ident(schemas.app, 'orgs')} WHERE id = ${actor.orgId}`,
          )
        ).rows[0]!;
        const summary: OrganizationManifest = {
          format: ORGANIZATION_ARCHIVE_FORMAT,
          version: ORGANIZATION_ARCHIVE_VERSION,
          schemaVersion: SCHEMA_VERSION,
          automationPublication: true,
          createdAt: new Date().toISOString(),
          organization: org,
          files: options.files,
          audit: options.audit,
          encryption,
          databases,
          people,
          counts: { databases: 0, people: people.length, records: 0, files: 0 },
        };
        const secrets: Array<SecretValue & { entry: string }> = [];
        const catalog = async function* (
          entry: string,
          name: string,
          select: ReturnType<typeof databaseRows>,
        ) {
          const found = keys ? (secret: SecretValue) => secrets.push({ ...secret, entry }) : undefined;
          for await (const stored of rows(db, select)) {
            const row = name === 'events' ? withoutSignerVisit(stored) : stored;
            summary.counts[name] = (summary.counts[name] ?? 0) + 1;
            if (name === 'org_templates') {
              const archive = await decompress(row.archive as Buffer);
              await directory.add(
                `templates/${String(row.id)}.json`,
                Readable.from([
                  JSON.stringify(publicRow('template', archive as unknown as Row, ctx.config.secretKey).row),
                ]),
              );
              delete row.archive;
            }
            if (name === 'orgs') {
              const settings = row.settings as OrgSettings;
              if (settings?.logo)
                row.settings = {
                  ...settings,
                  logo: await archiveLogo(db, schemas.app, ctx.config, settings.logo),
                };
            }
            const cleaned = publicRow(
              name,
              found
                ? await credentialArchiveRow(name, row, ctx.config.secretKey, actor.orgId, false, db)
                : row,
              ctx.config.secretKey,
              found,
            );
            yield line({
              kind: 'catalog',
              catalog: name,
              row: cleaned.row,
              ...(cleaned.omitted.length ? { omitted: cleaned.omitted } : {}),
            });
          }
        };
        await directory.add(
          'organization.jsonl',
          (async function* () {
            for (const name of ORG_CATALOGS)
              if (name !== 'events' || options.audit)
                yield* catalog('organization.jsonl', name, organizationRows(schemas, name, actor.orgId));
          })(),
        );
        for (const [index, database] of databases.entries()) {
          const entry = `databases/${database.id}.jsonl`;
          await directory.add(
            entry,
            (async function* () {
              const archive = await writeArchive(
                db,
                schemas,
                database.id,
                {
                  records: 'none',
                  comments: false,
                  includeTrashed: true,
                  organizationArchive: true,
                },
                new AccessScope(db, schemas, actor),
              );
              yield line({
                kind: 'archive',
                archive: publicRow('archive', archive as unknown as Row, ctx.config.secretKey).row,
              });
              for (const name of DATABASE_CATALOGS)
                yield* catalog(entry, name, databaseRows(schemas, name, database.id));
              for (const table of archive.tables) {
                const columns = await query<{ column_name: string }>(
                  db,
                  sql`SELECT column_name
              FROM information_schema.columns WHERE table_schema = ${schemas.data} AND table_name = ${table.id}`,
                );
                const fieldColumns = new Set(
                  (
                    await query<{ column_name: string }>(
                      db,
                      sql`SELECT column_name FROM ${ident(schemas.app, 'fields')} WHERE table_id = ${table.id}`,
                    )
                  ).rows.map((row) => row.column_name),
                );
                for await (const row of rows(
                  db,
                  sql`SELECT * FROM ${ident(schemas.data, table.id)} ORDER BY __rid`,
                )) {
                  // Undo's retired columns are not part of the current schema.
                  for (const { column_name: column } of columns.rows)
                    if (!column.startsWith('__') && !fieldColumns.has(column)) delete row[column];
                  summary.counts.records!++;
                  yield line({ kind: 'records', table: table.id, row });
                }
              }
              for await (const link of rows(db, databaseRows(schemas, 'links', database.id)))
                for await (const row of rows(
                  db,
                  sql`SELECT * FROM ${ident(schemas.data, `lnk_${String(link.id)}`)}`,
                ))
                  yield line({ kind: 'links', table: String(link.id), row });
            })(),
          );
          await progress(index + 1, databases.length);
        }
        if (options.files) await exportFiles(ctx, db, schemas, actor.orgId, directory);
        // Server settings, such as mail and AI provider keys, never travel: they're the server's own.
        if (keys) summary.counts.secrets = secrets.length;
        await directory.manifest(summary);
        if (keys) {
          // The manifest lists every other entry's SHA-256, so its HMAC covers the whole archive.
          // Each secret's associated data holds that HMAC and the place the secret belongs.
          const mac = await manifestMac(keys.authentication, directory.read('manifest.jsonl'));
          await directory.add('manifest.hmac', Readable.from([mac]));
          await directory.add(
            'secrets.jsonl',
            (async function* () {
              for (const { entry, catalog, identity, path, context, value } of secrets) {
                const place: SecretPlace = { entry, catalog, identity, path, context };
                yield line({ ...place, sealed: encryptSecret(keys.encryption, mac, place, value) });
              }
            })(),
          );
        }
      },
      LONG_DEADLINES,
    );
    return directory;
  } catch (error) {
    await directory.close();
    throw error;
  } finally {
    forgetKeys(keys);
  }
}

async function exportFiles(
  ctx: AppContext,
  db: Queryable,
  schemas: DataSchemas,
  orgId: string,
  directory: ArchiveDirectory,
): Promise<void> {
  for await (const row of rows(
    db,
    sql`SELECT f.* FROM ${ident(schemas.app, 'files')} f
      JOIN ${ident(schemas.app, 'tables')} t ON t.id = f.table_id
      JOIN ${ident(schemas.app, 'databases')} d ON d.id = t.database_id
      WHERE f.org_id = ${orgId} AND f.field_id IS NOT NULL AND f.ingest_file_id IS NULL AND t.purged_at IS NULL AND d.purged_at IS NULL`,
  )) {
    const entry = await directory.add(
      `files/${String(row.id)}`,
      fileStorage(row.storage as StorageKind, db, schemas.app, ctx.config).read(String(row.storage_key)),
    );
    if (entry.sha256 !== row.sha256 || entry.size !== Number(row.size)) throw invalidArchive();
  }
}
