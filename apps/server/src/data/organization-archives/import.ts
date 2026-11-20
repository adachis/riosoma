import { restoreLogo } from '../branding/store.js';
import { credentialArchiveRow } from './catalog.js';
import { sourceChoiceId, flattenAutomationSteps } from '@riosoma/contracts';
import { units, validateTree } from '../../org-units/store.js';
import { UnitPolicy } from '@riosoma/contracts';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { z } from 'zod';
import {
  AiSettings,
  AppError,
  AutomationConfig,
  idKind,
  MENTION_PATTERN,
  newId,
  SqlSettings,
  type OrganizationArchiveJob,
  type OrganizationDestination,
  type OrganizationManifest,
} from '@riosoma/contracts';
import { compile, ident, join, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { AppContext } from '../../app.js';
import { auditEvent, randomToken } from '../../auth/database.js';
import { newWebhookSecret } from '../../automations/store.js';
import { newOAuthId } from '../../authorization/store.js';
import { newBookingPageId } from '../../bookings/pages.js';
import type { Actor } from '../../http/policy.js';
import { seal } from '../../secrets.js';
import { dataStore, type DataSchemas } from '../context.js';
import { LONG_DEADLINES } from '../commands/transaction.js';
import { managedColumns } from '../managed.js';
import { loadFields } from '../metadata.js';
import { createRecordTable, ensureSourceChoiceIndex } from '../physical/ddl.js';
import { finishUpload } from '../files/finish.js';
import {
  applySecret,
  canonical,
  CATALOG_PLAN,
  identityOf,
  STREAMED_CATALOGS,
  withoutSignerVisit,
  type CatalogLine,
  type DataLine,
  type Row,
} from './catalog.js';
import { type ArchiveDirectory, invalidArchive, jsonLines, unsigned } from './container.js';
import { archiveKeys, checkMac, decryptSecret, forgetKeys, manifestMac, notAuthentic } from './encryption.js';
import { catalogColumns, inspect, placeKey, readTemplate, SecretLine } from './inspect.js';
import { addressMissing, outsideFindings, type CatalogRow } from './outside.js';

const REFERENCE_FIELDS = new Set(['singleSelect', 'multipleSelect', 'attachment', 'user']);
const ArchivedSourceUrl = z
  .string()
  .max(4096)
  .refine((value) => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  });
// Archives can carry provenance, but their preview references never describe newly stored bytes.
const ArchivedSourceMetadata = z.object({
  source: z.object({
    url: ArchivedSourceUrl,
    imageUrl: ArchivedSourceUrl,
    license: z.string().max(300).optional(),
  }),
});
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const AUTHORS = [
  'created_by',
  'updated_by',
  'trashed_by',
  'run_as_id',
  'author_id',
  'published_by',
  'draft_updated_by',
];
/**
 * The organization settings an import restores.  Sign-in and security settings stay as this
 * server has them, and anything added later stays out until it's listed here.
 */
const ORG_SETTINGS = [
  'classification_labels',
  'retention_policy',
  'retired_database_retention',
  'settings',
  'calendar_feeds',
  'report_outside_recipients',
  'automation_sms_enabled',
  'feedback_github_enabled',
  'feedback_github_repository',
  'feedback_github_token',
] as const;

/**
 * The catalogs the plan says an import restores with a step of its own, rather than row by row:
 * the organization's settings, group memberships that wait for people to join, files checked as
 * uploads are, and templates read from their own entries.
 */
export const OWN_STEPS: ReadonlySet<string> = new Set(['orgs', 'group_members', 'files', 'org_templates']);

/** A reference to an ID inside text: a `{{…}}` token, or a field named in braces */
const REFERENCE = /\{\{[^{}]*\}\}|\{([a-z]{2,3}[0-9A-Za-z]{14})\}/g;
const ID_IN_TOKEN = /\b[a-z]{2,3}[0-9A-Za-z]{14}\b/g;

/**
 * A keyed mapping gives records new IDs without retaining one map entry per record.  An ID only
 * ever changes where the schema puts one: a whole value or key that is an ID, a `{{…}}` token, a
 * field named in braces as formulas, AI prompts, and button links name them, a comment's mention,
 * and the row a sealing context names.  Everything else, such as free text and web addresses,
 * keeps every character, even where part of it looks like an ID.
 */
export class OrganizationIds {
  private readonly seed = randomBytes(32);
  private readonly overrides = new Map<string, string>();
  set(old: string, fresh: string): void {
    this.overrides.set(old, fresh);
  }
  get(old: string): string {
    const known = this.overrides.get(old);
    if (known) return known;
    if (!idKind(old)) return old;
    const bytes = createHmac('sha256', this.seed).update(old).digest();
    return old.slice(0, -14) + [...bytes.subarray(0, 14)].map((value) => ALPHABET[value % 62]).join('');
  }
  /** A key, which changes only when it's an ID */
  key = (text: string): string => (this.overrides.has(text) || idKind(text) ? this.get(text) : text);
  /** The references in text, whatever else it holds */
  references = (text: string): string =>
    text
      .replace(REFERENCE, (reference, braced: string | undefined) =>
        braced === undefined ? reference.replace(ID_IN_TOKEN, (id) => this.get(id)) : `{${this.get(braced)}}`,
      )
      .replace(
        /\b(tbl[0-9A-Za-z]{14})\[(fld[0-9A-Za-z]{14})\]/g,
        (_reference, table: string, field: string) => `${this.get(table)}[${this.get(field)}]`,
      )
      .replace(MENTION_PATTERN, (mention, name: string, user: string) => `@[${name}](${this.get(user)})`);
  /** A value, which changes when it's an ID or where it holds references */
  value = (text: string): string =>
    this.overrides.has(text) || idKind(text) ? this.get(text) : this.references(text);
  /** A sealing context, such as `source:<ID>`, whose parts between colons may be IDs */
  context = (text: string): string => text.split(':').map(this.key).join(':');
  json<T>(value: T): T {
    const walk = (item: unknown): unknown => {
      if (typeof item === 'string') return this.value(item);
      if (Array.isArray(item)) return item.map(walk);
      if (item && typeof item === 'object')
        return Object.fromEntries(Object.entries(item).map(([key, value]) => [this.key(key), walk(value)]));
      return item;
    };
    return walk(value) as T;
  }
}

export async function requireEmpty(db: Queryable, schemas: DataSchemas, actor: Actor): Promise<void> {
  for (const table of [
    'databases',
    'sources',
    'folders',
    'groups',
    'org_templates',
    'org_units',
    'oauth_clients',
  ]) {
    const existing = await query(
      db,
      sql`SELECT 1 FROM ${ident(schemas.app, table)} WHERE org_id = ${actor.orgId} LIMIT 1`,
    );
    if (existing.rowCount) throw new AppError('conflict', 'organizationArchive.notEmpty');
  }
  const people = await query(
    db,
    sql`SELECT 1 FROM ${ident(schemas.app, 'memberships')}
    WHERE org_id = ${actor.orgId} AND user_id <> ${actor.userId} LIMIT 1`,
  );
  if (people.rowCount) throw new AppError('conflict', 'organizationArchive.notEmpty');
  const invitations = await query(
    db,
    sql`SELECT 1 FROM ${ident(schemas.app, 'invitations')}
    WHERE org_id = ${actor.orgId} AND accepted_at IS NULL LIMIT 1`,
  );
  if (invitations.rowCount) throw new AppError('conflict', 'organizationArchive.notEmpty');
  const review = await query(
    db,
    sql`SELECT 1 FROM ${ident(schemas.app, 'organization_import_review')} WHERE org_id = ${actor.orgId} LIMIT 1`,
  );
  if (review.rowCount) throw new AppError('conflict', 'organizationArchive.notEmpty');
}

async function insertRow(db: Queryable, schema: string, table: string, row: Row): Promise<void> {
  const columns = Object.keys(row);
  if (!columns.length || columns.some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) throw invalidArchive();
  const names = join(
    columns.map((column) => sql`${ident(column)}`),
    ', ',
  );
  await query(
    db,
    sql`INSERT INTO ${ident(schema, table)} (${names})
    SELECT ${names} FROM jsonb_populate_record(NULL::${ident(schema, table)}, ${JSON.stringify(row)}::jsonb)`,
  );
}

/** A credential the passphrase unsealed, keyed by the place its associated data named */
type Secrets = Map<string, { value: unknown; context: string | null }>;

/**
 * Proves the archive unchanged since export with its passphrase: the manifest's HMAC must match,
 * and every secret must open with associated data naming that HMAC and the place it belongs.  A
 * wrong passphrase and a changed archive look the same, and both are refused.
 */
export async function authenticate(
  directory: ArchiveDirectory,
  summary: OrganizationManifest,
  passphrase: string,
): Promise<Secrets> {
  if (!summary.encryption) throw unsigned();
  const keys = await archiveKeys(passphrase, summary.encryption);
  try {
    const mac = await manifestMac(keys.authentication, directory.read('manifest.jsonl'));
    checkMac(mac, await directory.bytes('manifest.hmac'));
    const secrets: Secrets = new Map();
    for await (const item of jsonLines(directory.read('secrets.jsonl'))) {
      const line = SecretLine.safeParse(item);
      if (!line.success) throw invalidArchive();
      const { sealed, ...place } = line.data;
      const key = placeKey(place.entry, place.catalog, place.identity, place.path);
      if (secrets.has(key)) throw invalidArchive();
      const value = decryptSecret(keys.encryption, mac, place, sealed);
      if (typeof value !== 'string') throw notAuthentic();
      secrets.set(key, { value, context: place.context });
    }
    return secrets;
  } finally {
    forgetKeys(keys);
  }
}

export type ImportReport = NonNullable<OrganizationArchiveJob['report']>;

export async function importOrganization(
  ctx: AppContext,
  actor: Actor,
  directory: ArchiveDirectory,
  summary: OrganizationManifest,
  passphrase: string | undefined,
  progress: (done: number, total: number) => Promise<void>,
  finish?: (db: Queryable, report: ImportReport) => Promise<void>,
): Promise<ImportReport> {
  // A passphrase can only check an archive that has an HMAC for it to check.
  if (passphrase && !summary.encryption) throw unsigned();
  const { pool, schemas } = dataStore(ctx);
  const inspection = await inspect(directory, summary, await catalogColumns(pool, schemas));
  // Nothing is restored from an archive a passphrase was given for until the passphrase proves it.
  const authenticated = Boolean(passphrase && summary.encryption);
  const secrets: Secrets = authenticated ? await authenticate(directory, summary, passphrase!) : new Map();
  const secretsRestored = authenticated;
  const ids = new OrganizationIds();
  ids.set(summary.organization.id, actor.orgId);
  const restored = (item: CatalogRow, path: string[]) =>
    secrets.has(placeKey(item.entry, item.catalog, identityOf(item.row), path));
  const report: ImportReport = {
    databases: summary.databases.map((database) => ({ id: ids.get(database.id), name: database.name })),
    people: 0,
    secretsRestored,
    authenticated,
    review: 0,
  };
  await withTransaction(
    pool,
    async (db) => {
      // Blocking inserts closes the race between an empty check and another request creating data.
      for (const table of [
        'databases',
        'sources',
        'folders',
        'groups',
        'org_templates',
        'org_units',
        'memberships',
        'invitations',
        'organization_import_review',
        'oauth_clients',
      ])
        await query(db, sql`LOCK TABLE ${ident(schemas.app, table)} IN SHARE ROW EXCLUSIVE MODE`);
      await requireEmpty(db, schemas, actor);
      const owner = (
        await query<{ email: string }>(
          db,
          sql`SELECT email FROM ${ident(schemas.app, 'users')} WHERE id = ${actor.userId}`,
        )
      ).rows[0]!;
      const review = async (item: {
        kind: string;
        targetId: string;
        databaseId?: string | null;
        name: string;
        destinations: OrganizationDestination[];
        detail: Row;
      }) => {
        const id = newId('job');
        await query(
          db,
          sql`INSERT INTO ${ident(schemas.app, 'organization_import_review')}
          (id, org_id, kind, target_id, database_id, name, destinations, detail)
          VALUES (${id}, ${actor.orgId}, ${item.kind}, ${item.targetId}, ${item.databaseId ?? null}, ${item.name},
            ${JSON.stringify(item.destinations)}::jsonb, ${JSON.stringify(item.detail)}::jsonb)`,
        );
        report.review++;
        return id;
      };
      // Everyone is invited as a member, or as a guest when they were one, and nobody is invited
      // until the owner chooses to send it.  The importing owner is the organization's only owner.
      const waiting = new Map<string, { groups: string[] }>();
      const people: Array<{ reserved: string; person: OrganizationManifest['people'][number] }> = [];
      for (const person of summary.people) {
        if (person.email.toLowerCase() === owner.email.toLowerCase()) {
          ids.set(person.id, actor.userId);
          continue;
        }
        const existing = (
          await query<{ id: string }>(
            db,
            sql`SELECT id FROM ${ident(schemas.app, 'users')}
        WHERE lower(email) = ${person.email.toLowerCase()}`,
          )
        ).rows[0];
        if (existing) ids.set(person.id, existing.id);
        const reserved = ids.get(person.id);
        waiting.set(reserved, { groups: [] });
        people.push({ reserved, person });
      }
      const get = (name: string) => inspection.catalogs.get(name) ?? [];
      // Public page and OAuth identifiers use their own formats, outside the ordinary ID mapping.
      for (const { row } of get('booking_pages')) ids.set(String(row.id), newBookingPageId());
      for (const { row } of get('oauth_clients')) ids.set(String(row.id), newOAuthId());
      for (const catalog of ['knowledge_libraries', 'knowledge_documents'])
        for (const { row } of get(catalog)) ids.set(String(row.id), randomUUID());
      const unitIds = new Set(get('org_units').map((item) => String(item.row.id)));
      for (const person of summary.people) {
        if (
          (person.unitId && !unitIds.has(person.unitId)) ||
          person.unitAdmins?.some((grant) => !unitIds.has(grant.unitId))
        )
          throw invalidArchive();
      }
      const knownPeople = new Set(summary.people.map((person) => person.id));
      const mapped = async (item: CatalogRow): Promise<Row> => {
        const { catalog } = item;
        const row = ids.json(item.row);
        for (const path of item.omitted) {
          const secret = secrets.get(placeKey(item.entry, catalog, identityOf(item.row), path));
          if (!secret) continue;
          // A credential comes back exactly, sealed again for this server when it was sealed.  Only
          // the references in plain text, such as a `{{…}}` token in an address, follow the new IDs.
          const value = secret.context ? secret.value : ids.references(String(secret.value));
          applySecret(row, path.map(ids.key), value, secret.context, ctx.config.secretKey, ids.context);
        }
        if ('org_id' in row) row.org_id = actor.orgId;
        // Reserved people have no account until they accept their invitation.
        for (const key of AUTHORS) if (key in row && row[key] !== actor.userId) row[key] = null;
        if (catalog === 'folders') row.owner_id = actor.userId;
        if (catalog === 'org_units') {
          const policy = UnitPolicy.safeParse(row.policy ?? {});
          if (!policy.success) throw invalidArchive();
          row.policy = policy.data;
        }
        if (catalog === 'databases') {
          row.change_seq = 0;
          row.history_floor = 0;
        }
        if (catalog === 'named_functions') {
          // Parameters are local symbols, so ID-shaped names and bodies keep their original text.
          for (const key of ['name', 'parameters', 'body', 'description']) row[key] = item.row[key];
        }
        if (catalog === 'tables' || catalog === 'fields') row.ingest = null;
        if (catalog === 'sources') {
          if (!row.sealed_secrets)
            row.sealed_secrets = seal(ctx.config.secretKey, '{}', `source:${String(row.id)}`);
          // Whatever the passphrase, a source stays paused until the owner turns it on.
          row.import_paused = true;
          row.import_note = 'organizationArchive.sourcePaused';
        }
        if (catalog === 'automations') {
          if (!summary.automationPublication && row.published_at == null) row.published_at = row.updated_at;
          const fresh = newWebhookSecret(ctx.config.secretKey, String(row.id));
          row.webhook_secret_hash = fresh.hash;
          row.webhook_salt = fresh.salt;
          row.enabled = false;
          row.run_as_id = null;
          row.next_run_at = null;
          row.stopped_because = 'organizationArchive.reviewAutomation';
        }
        if (catalog === 'webhooks') {
          row.enabled = false;
          row.disabled_reason = 'organizationArchive.reviewIntegration';
          row.secret ||= seal(
            ctx.config.secretKey,
            randomToken(),
            `riosoma.webhooks.secret:${String(row.id)}`,
          );
          row.previous_secret = null;
          row.previous_secret_until = null;
          row.failing_since = null;
        }
        if (catalog === 'table_sources') {
          row.fetch_state = null;
          row.lease_at = null;
          row.lease_token = null;
          row.held_token = null;
          if (!secretsRestored) row.next_sync_at = null;
          row.status = {
            ...(row.status as Row),
            state: row.next_sync_at ? 'queued' : 'idle',
            nextSyncAt: row.next_sync_at,
            error: secretsRestored ? null : { messageKey: 'organizationArchive.secretsMissing', params: {} },
          };
        }
        if (catalog === 'oauth_apps') row.enabled = false;
        if (catalog === 'booking_pages') {
          row.enabled = false;
          row.owner_id = null;
        }
        if (catalog === 'oauth_clients') {
          row.import_paused = true;
          row.secret_hash = item.row.secret_hash === null ? null : '';
          row.last_used_at = null;
        }
        if (catalog === 'sql_settings') row.settings = SqlSettings.parse(row.settings);
        // An archive nobody could check brings no credential of any kind, even one in the clear.
        if (!authenticated) {
          if (catalog === 'orgs') row.feedback_github_token = null;
          if (catalog === 'sources')
            row.sealed_secrets = seal(ctx.config.secretKey, '{}', `source:${String(row.id)}`);
          if (catalog === 'webhooks')
            row.secret = seal(
              ctx.config.secretKey,
              randomToken(),
              `riosoma.webhooks.secret:${String(row.id)}`,
            );
          if (catalog === 'automations') row.messaging_secrets = {};
          if (catalog === 'oauth_apps') {
            row.sealed_secret = '';
            row.api_key = '';
          }
        }
        if (catalog === 'ai_settings') {
          // AI comes in off, pointed at no provider, with only its model choices kept.
          const settings = AiSettings.safeParse(row.settings);
          row.settings = AiSettings.parse({
            enabled: false,
            models: settings.success ? settings.data.models : { everyday: null, power: null },
          });
        }
        return credentialArchiveRow(catalog, row, ctx.config.secretKey, actor.orgId, true, db);
      };
      const retainAuthors = async (catalog: string, original: Row) => {
        const keyColumn = 'id' in original ? 'id' : 'field_id' in original ? 'field_id' : null;
        if (!keyColumn) return;
        for (const column of AUTHORS) {
          const old = original[column];
          if (typeof old !== 'string' || !knownPeople.has(old) || ids.get(old) === actor.userId) continue;
          await query(
            db,
            sql`INSERT INTO ${ident(schemas.app, 'organization_import_authors')}
          (org_id, user_id, catalog, row_id, key_column, author_column)
          VALUES (${actor.orgId}, ${ids.get(old)}, ${catalog}, ${ids.get(String(original[keyColumn]))}, ${keyColumn}, ${column})
          ON CONFLICT DO NOTHING`,
          );
        }
      };
      const sourceTables = new Set(
        get('fields').flatMap(({ row }) => {
          const options = row.options as { source?: { tableId?: string } } | null;
          return REFERENCE_FIELDS.has(String(row.type)) && options?.source?.tableId
            ? [options.source.tableId]
            : [];
        }),
      );
      // Choice identities follow the new record IDs wherever the archive refers to them.
      for (const database of summary.databases) {
        if (!sourceTables.size) break;
        for await (const item of jsonLines(directory.read(`databases/${database.id}.jsonl`))) {
          const value = item as DataLine;
          if (value.kind !== 'records' || !sourceTables.has(value.table)) continue;
          const old = String(value.row.__id);
          ids.set(await sourceChoiceId(old), await sourceChoiceId(ids.get(old)));
        }
      }
      const orgRow = get('orgs')[0]!;
      const org = await mapped(orgRow);
      const restoredOrg: Row = { name: summary.organization.name };
      for (const column of ORG_SETTINGS) if (column in org) restoredOrg[column] = org[column];
      if ('settings' in restoredOrg) {
        const restored = restoredOrg.settings;
        const settings: Row =
          restored && typeof restored === 'object' && !Array.isArray(restored)
            ? { ...(restored as Row) }
            : {};
        const current = await query<{ settings: Row }>(
          db,
          sql`SELECT settings FROM ${ident(schemas.app, 'orgs')} WHERE id = ${actor.orgId}`,
        );
        // An archive cannot disable the destination's scanner or permit unscanned downloads.
        for (const key of ['fileScanner', 'fileScannerStatus']) {
          delete settings[key];
          const value = current.rows[0]?.settings[key];
          if (value !== undefined) settings[key] = value;
        }
        if (settings.logo !== undefined)
          settings.logo = await restoreLogo(db, schemas.app, ctx.config, settings.logo);
        restoredOrg.settings = settings;
      }
      // Calendar feeds and feedback sent to a repository come in off, for the owner to review.
      restoredOrg.calendar_feeds = false;
      restoredOrg.feedback_github_enabled = false;
      restoredOrg.feedback_hub_enabled = false;
      await query(
        db,
        sql`UPDATE ${ident(schemas.app, 'orgs')} SET ${join(
          Object.entries(restoredOrg).map(
            ([key, value]) =>
              sql`${ident(key)} = (jsonb_populate_record(NULL::${ident(schemas.app, 'orgs')}, ${JSON.stringify({ [key]: value })}::jsonb)).${ident(key)}`,
          ),
          ', ',
        )}
      WHERE id = ${actor.orgId}`,
      );
      for (const { catalog: name, restore } of CATALOG_PLAN) {
        if (restore !== 'rows') continue;
        for (const item of get(name)) {
          await insertRow(db, schemas.app, name, await mapped(item));
          if (name !== 'organization_import_authors') await retainAuthors(name, item.row);
        }
      }
      // The unit tree has to hold together as it arrived.  The owner who imports stays in the
      // organization itself, as owners always do, and needs no unit grants.
      validateTree(await units(db, `"${schemas.app}"`, actor.orgId));
      // A group membership needs a membership, so people who haven't joined wait for it.
      for (const { row } of get('group_members')) {
        const userId = ids.get(String(row.user_id));
        const groupId = ids.get(String(row.group_id));
        if (userId === actor.userId)
          await query(
            db,
            sql`INSERT INTO ${ident(schemas.app, 'group_members')} (org_id, group_id, user_id)
            VALUES (${actor.orgId}, ${groupId}, ${userId}) ON CONFLICT DO NOTHING`,
          );
        else waiting.get(userId)?.groups.push(groupId);
      }
      for (const { reserved, person } of people) {
        await review({
          kind: 'person',
          targetId: reserved,
          name: person.name,
          destinations: [{ kind: 'email', value: person.email.toLowerCase() }],
          detail: {
            invitedAs: person.kind === 'guest' ? 'guest' : 'member',
            scimManaged: person.scimManaged,
            unitId: person.unitId ? ids.get(person.unitId) : null,
            unitAdmins: (person.unitAdmins ?? []).map((grant) => ({
              ...grant,
              unitId: ids.get(grant.unitId),
            })),
            groups: waiting.get(reserved)?.groups ?? [],
          },
        });
        report.people++;
      }
      for (const database of report.databases)
        await query(
          db,
          sql`INSERT INTO ${ident(schemas.app, 'grants')}
        (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
        VALUES (${actor.orgId}, 'database', ${database.id}, 'user', ${actor.userId}, 'owner')
        ON CONFLICT (resource_kind, resource_id, principal_kind, principal_id) DO UPDATE SET role = 'owner'`,
        );
      for (const { row: table } of get('tables')) {
        const tableId = ids.get(String(table.id));
        const fields = await loadFields(db, schemas, [tableId], { includeTrashed: true });
        await createRecordTable(db, schemas.data, tableId, fields);
        if (sourceTables.has(String(table.id))) await ensureSourceChoiceIndex(db, schemas.data, tableId);
        if (table.joined || get('table_sources').some(({ row }) => row.table_id === table.id))
          await query(
            db,
            sql`ALTER TABLE ${ident(schemas.data, tableId)} ADD COLUMN __source_key text UNIQUE, ADD COLUMN __synced_at timestamptz`,
          );
        if (table.joined)
          await query(
            db,
            sql`ALTER TABLE ${ident(schemas.data, tableId)} ADD COLUMN __joined_records jsonb NOT NULL DEFAULT '{}'::jsonb`,
          );
      }
      for (const { row: link } of get('links')) {
        const row = ids.json(link);
        const name = `lnk_${String(row.id)}`;
        await query(
          db,
          sql`CREATE TABLE ${ident(schemas.data, name)} (
        left_rid bigint NOT NULL REFERENCES ${ident(schemas.data, String(row.left_table_id))} (__rid) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
        right_rid bigint NOT NULL REFERENCES ${ident(schemas.data, String(row.right_table_id))} (__rid) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
        left_pos double precision NOT NULL, right_pos double precision NOT NULL, PRIMARY KEY (left_rid, right_rid))`,
        );
        await query(
          db,
          sql`CREATE INDEX ${ident(`${name}_right`)} ON ${ident(schemas.data, name)} (right_rid)`,
        );
      }
      // Payment result fields are managed exactly when a table's payment settings name them,
      // whatever an archive's field rows say, and their values never come from an archive: the
      // payments behind them stay with the Stripe account.
      await query(
        db,
        sql`UPDATE ${ident(schemas.app, 'fields')} f SET managed = CASE WHEN EXISTS (
          SELECT 1 FROM ${ident(schemas.app, 'payment_fields')} p
          WHERE f.id IN (p.status_field, p.amount_field, p.reference_field)) THEN 'payment' END
        WHERE f.org_id = ${actor.orgId}`,
      );
      const managed = new Map<string, Set<string>>();
      for (const { row: table } of get('tables')) {
        const tableId = ids.get(String(table.id));
        managed.set(
          tableId,
          managedColumns(await loadFields(db, schemas, [tableId], { includeTrashed: true })),
        );
      }
      const references = new Map<string, Set<string>>();
      for (const { row: field } of get('fields')) {
        if (!REFERENCE_FIELDS.has(String(field.type))) continue;
        const columns = references.get(String(field.table_id)) ?? new Set<string>();
        columns.add(String(field.column_name));
        references.set(String(field.table_id), columns);
      }
      const systemReferences = new Set([
        '__id',
        '__created_by',
        '__updated_by',
        '__trashed_by',
        '__overrides',
        '__joined_records',
      ]);
      for (const [index, database] of summary.databases.entries()) {
        for await (const item of jsonLines(directory.read(`databases/${database.id}.jsonl`))) {
          const value = item as DataLine;
          if (value.kind === 'records' || value.kind === 'links') {
            const leftOut = value.kind === 'records' ? managed.get(ids.get(value.table)) : undefined;
            // Text cells keep their exact contents even when they contain an identifier.
            const row = Object.fromEntries(
              Object.entries(value.row)
                .map(([column, cell]): [string, unknown] => [
                  ids.key(column),
                  systemReferences.has(column) || references.get(value.table)?.has(column)
                    ? ids.json(cell)
                    : cell,
                ])
                .filter(([column]) => !leftOut?.has(column)),
            );
            await insertRow(
              db,
              schemas.data,
              `${value.kind === 'links' ? 'lnk_' : ''}${ids.get(value.table)}`,
              row,
            );
          }
        }
        await progress(index + 1, summary.databases.length);
      }
      for (const { row: table } of get('tables')) {
        const tableId = ids.get(String(table.id));
        if (table.joined)
          await query(
            db,
            sql`UPDATE ${ident(schemas.data, tableId)} SET __source_key = __joined_records::text`,
          );
        await query(
          db,
          sql`SELECT setval(pg_get_serial_sequence(${`"${schemas.data}"."${tableId}"`}, '__rid'),
        GREATEST(max(__rid), 1), max(__rid) IS NOT NULL) FROM ${ident(schemas.data, tableId)}`,
        );
        for (const field of await loadFields(db, schemas, [tableId], { includeTrashed: true }))
          if (field.type === 'autoNumber')
            await query(
              db,
              sql`SELECT setval(${`"${schemas.data}"."${field.id}"`}::regclass,
          GREATEST(max(${ident(field.columnName)}), 1), count(*) > 0) FROM ${ident(schemas.data, tableId)}`,
            );
      }
      await importFiles(ctx, db, schemas, actor, directory, summary, get('files'), ids, retainAuthors);
      for (const item of get('org_templates')) {
        const template = await readTemplate(directory, `templates/${String(item.row.id)}.json`);
        // A template's sample records may be gone from its database, so their choice identities
        // follow the new record IDs here too, before the template's own IDs change.
        const templateSources = new Set(
          template.tables.flatMap((table) =>
            table.fields.flatMap((field) =>
              (field.type === 'singleSelect' || field.type === 'multipleSelect') && field.options.source
                ? [field.options.source.tableId]
                : [],
            ),
          ),
        );
        for (const table of template.tables)
          if (templateSources.has(table.id))
            for (const record of table.records)
              ids.set(await sourceChoiceId(record.id), await sourceChoiceId(ids.get(record.id)));
        const archive = ids.json(template);
        for (const [tableIndex, table] of template.tables.entries())
          for (const [recordIndex, record] of table.records.entries())
            for (const [fieldId, value] of Object.entries(record.values))
              if (!REFERENCE_FIELDS.has(table.fields.find((field) => field.id === fieldId)?.type ?? ''))
                archive.tables[tableIndex]!.records[recordIndex]!.values[ids.get(fieldId)] = value;
        const row = await mapped(item);
        row.archive = `\\x${gzipSync(JSON.stringify(archive)).toString('hex')}`;
        await insertRow(db, schemas.app, 'org_templates', row);
        await retainAuthors('org_templates', item.row);
      }
      const now = new Date().toISOString();
      for (const name of [
        'organization.jsonl',
        ...summary.databases.map((database) => `databases/${database.id}.jsonl`),
      ])
        for await (const item of jsonLines(directory.read(name))) {
          const value = item as CatalogLine;
          if (value.kind !== 'catalog' || !STREAMED_CATALOGS.has(value.catalog)) continue;
          const original: CatalogRow = {
            catalog: value.catalog,
            entry: name,
            row: value.row,
            omitted: value.omitted ?? [],
          };
          if (value.catalog === 'knowledge_documents') {
            const source = value.row;
            const library = get('knowledge_libraries').find((item) => item.row.id === source.library_id)?.row;
            await review({
              kind: 'knowledgeDocument',
              targetId: ids.get(String(source.id)),
              name: String(source.name),
              databaseId: library?.scope === 'database' ? ids.get(String(library.target)) : null,
              destinations: [{ kind: 'inside', value: '' }],
              detail: {
                row: {
                  id: ids.get(String(source.id)),
                  library_id: ids.get(String(source.library_id)),
                  name: source.name,
                  size: source.size,
                  source_text: source.source_text,
                },
              },
            });
            continue;
          }
          const row = await mapped(original);
          if (value.catalog === 'events') {
            // Signers' IP addresses and browsers never come in, even from an archive that has them.
            const event = withoutSignerVisit(row);
            // An event from the archive is kept as history from elsewhere: dated when it came in,
            // credited to nobody here, and marked with when and by whom it first happened.
            await query(
              db,
              sql`INSERT INTO ${ident(schemas.audit, 'events')} (org_id, actor_id, action, target, metadata, at)
              VALUES (${actor.orgId}, NULL, ${String(row.action)}, ${typeof row.target === 'string' ? row.target : null},
                ${JSON.stringify({
                  ...(event.metadata && typeof event.metadata === 'object' ? (event.metadata as Row) : {}),
                  imported: true,
                  originalAt: new Date(String(value.row.at)).toISOString(),
                  originalActorId: typeof value.row.actor_id === 'string' ? value.row.actor_id : null,
                })}::jsonb, ${now})`,
            );
            continue;
          }
          await insertRow(db, schemas.app, value.catalog, row);
          await retainAuthors(value.catalog, value.row);
        }
      for (const finding of outsideFindings(inspection.catalogs, restored)) {
        if (finding.catalog === 'knowledge_documents') continue;
        const row = finding.source.row;
        const detail: Row = { needsSecret: finding.needsSecret };
        let targetId = ids.get(String(row.id ?? ''));
        let databaseId: string | null = row.database_id ? ids.get(String(row.database_id)) : null;
        if (finding.catalog === 'automations') {
          // What each step still missing a credential looked like, so turning it on can tell
          // whether someone has entered the credential since.
          const config = ids.json(AutomationConfig.parse(row.config));
          detail.steps = Object.fromEntries(
            finding.stepsNeedingSecrets.map((stepId) => [
              stepId,
              JSON.stringify(flattenAutomationSteps(config.steps).find((step) => step.id === stepId) ?? null),
            ]),
          );
        }
        if (['shared_views', 'public_forms'].includes(finding.catalog)) {
          const link = await mapped(finding.source);
          targetId = String(link.view_id);
          detail.settings = link.settings ?? {};
          // A password comes back only from an archive its passphrase proved.
          detail.passwordHash =
            authenticated && typeof link.password_hash === 'string' && link.password_hash
              ? link.password_hash
              : null;
          detail.hadPassword = row.password_hash !== null && row.password_hash !== undefined;
        }
        if (finding.catalog === 'knowledge_libraries') {
          detail.row = {
            id: targetId,
            org_id: actor.orgId,
            scope: row.scope,
            target: ids.get(String(row.target)),
            name: row.name,
            description: row.description,
            label: row.label,
            guidance: row.guidance,
          };
          databaseId = row.scope === 'database' ? ids.get(String(row.target)) : null;
        }
        // What an address left without part of itself looks like, so turning it on can tell
        // whether someone has entered it again since.
        if (addressMissing(finding.source, restored)) {
          const imported = await mapped(finding.source);
          if (finding.catalog === 'webhooks') detail.url = String(imported.url);
          if (finding.catalog === 'sources') detail.connection = canonical(imported.connection);
        }
        if (finding.catalog === 'orgs') {
          targetId = actor.orgId;
          databaseId = null;
        }
        if (finding.catalog === 'oauth_apps') targetId = String(row.provider);
        await review({
          kind: finding.kind,
          targetId,
          databaseId,
          name: finding.name,
          destinations: ids.json(finding.destinations),
          detail,
        });
      }
      await auditEvent(
        db,
        compile(sql`${ident(schemas.audit)}`).text,
        'organization.import.finished',
        actor,
        {
          databases: report.databases.length,
          people: report.people,
          secretsRestored,
          authenticated,
          review: report.review,
        },
      );
      await finish?.(db, report);
    },
    LONG_DEADLINES,
  );
  return report;
}

/**
 * Files come in as uploads do: their type read from their content, quarantined for the scanner
 * when there is one, and their previews made again.  What the archive says about a file's type or
 * scan is never believed.
 */
async function importFiles(
  ctx: AppContext,
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  directory: ArchiveDirectory,
  summary: OrganizationManifest,
  files: CatalogRow[],
  ids: OrganizationIds,
  retainAuthors: (catalog: string, original: Row) => Promise<void>,
): Promise<void> {
  for (const { row: file } of files) {
    const id = ids.get(String(file.id));
    const createdBy = typeof file.created_by === 'string' ? ids.get(file.created_by) : null;
    const metadata = ArchivedSourceMetadata.safeParse(file.thumbnails);
    const source = metadata.success ? metadata.data.source : undefined;
    if (summary.files) {
      await finishUpload(
        db,
        schemas.app,
        ctx.config,
        {
          id,
          orgId: actor.orgId,
          userId: actor.userId,
          tableId: ids.get(String(file.table_id)),
          fieldId: ids.get(String(file.field_id)),
          name: String(file.name),
          storage: 'postgres',
        },
        directory.read(`files/${String(file.id)}`),
        source,
      );
    } else {
      // Without its contents a file can't be read or scanned, so it stays unavailable.
      await query(
        db,
        sql`INSERT INTO ${ident(schemas.app, 'files')}
        (id, org_id, table_id, field_id, name, size, type, sha256, storage, storage_key, scan_state, scan_next_at, thumbnails)
        VALUES (${id}, ${actor.orgId}, ${ids.get(String(file.table_id))}, ${ids.get(String(file.field_id))},
          ${String(file.name)}, ${Number(file.size)}, 'application/octet-stream', ${String(file.sha256)},
          'postgres', ${id}, 'unavailable', 'infinity', ${source ? JSON.stringify({ source }) : null}::jsonb)`,
      );
    }
    await query(
      db,
      sql`UPDATE ${ident(schemas.app, 'files')} SET created_by = ${createdBy === actor.userId ? actor.userId : null},
        created_at = COALESCE(${typeof file.created_at === 'string' ? file.created_at : null}::timestamptz, created_at),
        attached_at = ${typeof file.attached_at === 'string' ? file.attached_at : null}::timestamptz
      WHERE id = ${id}`,
    );
    await retainAuthors('files', file);
  }
}
