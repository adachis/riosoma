import { folderGrantSource } from '../../data/access.js';
import { newId } from '@riosoma/contracts';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { AppContext } from '../../app.js';
import { authDatabase, lockKeys } from '../database.js';
import { endPersonOAuth, oauthActing } from '../../authorization/store.js';
import { dataStore, type DataSchemas } from '../../data/context.js';
import { fileStorage } from '../../data/files/storage.js';
import { accessChannel, organizationChannel } from '../../data/notify.js';
import { booleanOf, ScimError } from './errors.js';
import { attribute, filterSql, parseFilter } from './filter.js';
import { ENTERPRISE_SCHEMA, object, patchResource, type ResourceKind } from './patch.js';
import { listResponse, normalizeResource, personEmail, personName } from './resources.js';
import type { TokenRow } from './admin.js';
import { moveEntry, placementFor, placePerson, unitMappings } from '../../org-units/scim.js';

export interface ResourceRow {
  id: string;
  document: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export function resourceView(row: ResourceRow, kind: ResourceKind, baseUrl: string) {
  return {
    ...row.document,
    id: row.id,
    meta: {
      resourceType: kind === 'Users' ? 'User' : 'Group',
      created: row.created_at.toISOString(),
      lastModified: row.updated_at.toISOString(),
      location: `${baseUrl}/${kind}/${encodeURIComponent(row.id)}`,
    },
  };
}

export function notFound(): never {
  throw new ScimError(404, 'errors.notFound');
}

function table(schema: string, kind: ResourceKind) {
  return ident(schema, kind === 'Users' ? 'scim_users' : 'scim_groups');
}
function idColumn(kind: ResourceKind) {
  return ident(kind === 'Users' ? 'user_id' : 'group_id');
}

export async function getResource(
  db: Queryable,
  schema: string,
  orgId: string,
  kind: ResourceKind,
  id: string,
): Promise<ResourceRow> {
  const result = await query<ResourceRow>(
    db,
    sql`SELECT ${idColumn(kind)} AS id, document, created_at, updated_at FROM ${table(schema, kind)} WHERE org_id = ${orgId} AND ${idColumn(kind)} = ${id} AND deleted_at IS NULL`,
  );
  return result.rows[0] ?? notFound();
}

export async function listResources(
  ctx: AppContext,
  token: TokenRow,
  kind: ResourceKind,
  baseUrl: string,
  filter: string | undefined,
  startIndex: number,
  count: number,
) {
  const { pool, schemas } = dataStore(ctx);
  const predicate = filter === undefined ? sql`TRUE` : filterSql(parseFilter(filter), sql`document`);
  return withTransaction(pool, async (db) => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const condition = sql`org_id = ${token.org_id} AND deleted_at IS NULL AND ${predicate}`;
    const total = await query<{ total: number }>(
      db,
      sql`SELECT count(*)::integer AS total FROM ${table(schemas.app, kind)} WHERE ${condition}`,
    );
    const rows = await query<ResourceRow>(
      db,
      sql`SELECT ${idColumn(kind)} AS id, document, created_at, updated_at FROM ${table(schemas.app, kind)} WHERE ${condition} ORDER BY created_at, ${idColumn(kind)} LIMIT ${count} OFFSET ${startIndex - 1}`,
    );
    return listResponse(
      rows.rows.map((row) => resourceView(row, kind, baseUrl)),
      total.rows[0]!.total,
      startIndex,
    );
  });
}

/** The same object with one attribute set, whatever case the request spelled its name in */
function withAttribute(value: Record<string, unknown>, name: string, item: unknown): Record<string, unknown> {
  const result = Object.fromEntries(
    Object.entries(value).filter(([key]) => key.toLowerCase() !== name.toLowerCase()),
  );
  result[name] = item;
  return result;
}

/** Who is changing an organization's people: a provisioning token, or an administrator */
export interface Acting {
  orgId: string;
  /** The audit schema, quoted */
  audit: string;
  /** The administrator, or null when a token acts and no person does */
  actorId: string | null;
  /** What every event says about who acted, such as the token's ID and name */
  metadata: Record<string, unknown>;
}

function tokenActing(token: TokenRow, audit: string): Acting {
  return {
    orgId: token.org_id,
    audit,
    actorId: null,
    metadata: { actorKind: 'scim_token', tokenId: token.id, tokenName: token.name },
  };
}

/** An audit event naming whoever acts: the administrator, or the token and no person. */
async function tokenEvent(
  db: Queryable,
  acting: Acting,
  action: string,
  target: string | null,
  metadata: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO ${acting.audit}.events (org_id, actor_id, action, target, metadata) VALUES ($1, $2, $3, $4, $5)`,
    [acting.orgId, acting.actorId, action, target, JSON.stringify({ ...acting.metadata, ...metadata })],
  );
}

/**
 * Ends everything a person could reach Riosoma with, the provisioning tokens they made included.
 * Reactivation never brings any of it back: the person signs in again and makes new tokens and
 * calendar addresses.
 */
export async function revokeAccess(
  db: Queryable,
  schema: string,
  acting: Acting,
  userId: string,
  reason: 'creatorSuspended' | 'creatorRemoved',
): Promise<void> {
  const orgId = acting.orgId;
  // A token outlives no one: its maker's access to provisioning ends with the rest of it.
  const tokens = await query<{ id: string; name: string }>(
    db,
    sql`UPDATE ${ident(schema, 'scim_tokens')} SET revoked_at = clock_timestamp()
    WHERE org_id = ${orgId} AND created_by = ${userId} AND revoked_at IS NULL RETURNING id, name`,
  );
  for (const revoked of tokens.rows)
    await tokenEvent(db, acting, 'scim.token.revoked', revoked.id, {
      revokedTokenId: revoked.id,
      revokedTokenName: revoked.name,
      creatorId: userId,
      reason,
    });
  await query(
    db,
    sql`UPDATE ${ident(schema, 'sessions')} SET revoked_at = clock_timestamp() WHERE user_id = ${userId} AND revoked_at IS NULL`,
  );
  await query(
    db,
    sql`UPDATE ${ident(schema, 'api_tokens')} SET revoked_at = clock_timestamp() WHERE org_id = ${orgId} AND user_id = ${userId} AND revoked_at IS NULL`,
  );
  await query(
    db,
    sql`UPDATE ${ident(schema, 'login_tokens')} SET used_at = clock_timestamp() WHERE user_id = ${userId} AND used_at IS NULL`,
  );
  await query(
    db,
    sql`UPDATE ${ident(schema, 'calendar_feeds')} SET stopped_at = clock_timestamp() WHERE user_id = ${userId} AND stopped_at IS NULL`,
  );
  // Every OAuth app connection ends too, and the webhooks those apps made turn off.
  await endPersonOAuth(
    db,
    schema,
    acting,
    userId,
    reason === 'creatorRemoved' ? 'person_removed' : 'person_inactive',
  );
}

/**
 * Provisioning never changes the organization's owner, who is never a person it manages, or an
 * account another organization shares.  The refusal names neither, so it reveals no one's role.
 */
async function protectedPerson(db: Queryable, schema: string, orgId: string, userId: string): Promise<void> {
  const result = await query(
    db,
    sql`SELECT 1 FROM ${ident(schema, 'memberships')} WHERE user_id = ${userId} AND (org_id <> ${orgId} OR kind = 'owner')`,
  );
  if (result.rowCount) throw new ScimError(409, 'scim.errors.protectedAccount');
}

/**
 * A directory may give a person only an address on a domain its organization has verified, so it
 * can't claim, or learn about, addresses that belong to anyone else.
 */
async function requireOwnDomain(
  db: Queryable,
  schema: string,
  orgId: string,
  address: string,
): Promise<void> {
  const domain = address.slice(address.lastIndexOf('@') + 1);
  // As for the first single sign-on link, the connection must still be on and still list the domain.
  const verified = await query(
    db,
    sql`SELECT 1 FROM ${ident(schema, 'sso_domain_verifications')} v
    JOIN ${ident(schema, 'sso_providers')} p ON p.id = v.provider_id AND p.org_id = v.org_id
    WHERE v.org_id = ${orgId} AND v.domain = ${domain} AND v.verified_at IS NOT NULL
      AND p.enabled AND ${domain} = ANY(p.allowed_domains) LIMIT 1`,
  );
  if (!verified.rowCount)
    throw new ScimError(
      400,
      'scim.errors.addressDomain',
      'invalidValue',
      `The email domain ${domain} is not verified for this organization.  Verify it in Riosoma's provisioning settings.`,
    );
}

/**
 * Before a person's account is removed, each database they alone own goes to the organization's
 * owner, so nobody is left unable to share, trash, or restore it.  Another owner, by a grant of
 * their own or through a group, directly or by a folder, means the database isn't theirs alone.
 */
async function handOverDatabases(
  db: Queryable,
  schema: string,
  acting: Acting,
  userId: string,
): Promise<void> {
  const orgId = acting.orgId;
  const owner = await query<{ user_id: string }>(
    db,
    sql`SELECT user_id FROM ${ident(schema, 'memberships')} WHERE org_id = ${orgId} AND kind = 'owner'
    ORDER BY user_id LIMIT 1`,
  );
  const successor = owner.rows[0]?.user_id;
  if (!successor || successor === userId) return;
  const grants = ident(schema, 'grants');
  const orphans = await query<{ id: string }>(
    db,
    sql`SELECT d.id FROM ${ident(schema, 'databases')} d
    WHERE d.org_id = ${orgId}
      AND EXISTS (SELECT 1 FROM ${grants} mine WHERE mine.org_id = ${orgId} AND mine.resource_kind = 'database'
        AND mine.resource_id = d.id AND mine.principal_kind = 'user' AND mine.principal_id = ${userId}
        AND mine.role = 'owner')
      AND NOT EXISTS (SELECT 1 FROM (${folderGrantSource({ app: schema })}) other WHERE other.org_id = ${orgId} AND other.role = 'owner'
        AND NOT (other.principal_kind = 'user' AND other.principal_id = ${userId})
        AND ((other.resource_kind = 'database' AND other.resource_id = d.id)
          OR (other.resource_kind = 'folder' AND EXISTS (
            SELECT 1 FROM ${ident(schema, 'folder_databases')} fd
            JOIN ${ident(schema, 'folders')} f ON f.org_id = fd.org_id AND f.id = fd.folder_id
            WHERE fd.org_id = ${orgId} AND (f.id = other.resource_id OR other.resource_id = ANY(f.path)) AND fd.database_id = d.id))))
    ORDER BY d.id FOR UPDATE OF d`,
  );
  for (const database of orphans.rows) {
    await query(
      db,
      sql`INSERT INTO ${grants} (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
      VALUES (${orgId}, 'database', ${database.id}, 'user', ${successor}, 'owner')
      ON CONFLICT (resource_kind, resource_id, principal_kind, principal_id) DO UPDATE SET role = 'owner'`,
    );
    await tokenEvent(db, acting, 'scim.database.ownerChanged', database.id, {
      databaseId: database.id,
      previousOwnerId: userId,
      ownerId: successor,
      reason: 'ownerRemoved',
    });
  }
}

/**
 * Removes a person's account the way deleting them does when deletion means removal: their access
 * ends, each database they alone owned goes to the organization's owner, their links and forms
 * stop for good, and the account goes, which frees their directory login name.  Their records
 * stay.  The caller checks who may be removed.
 */
export async function removeAccount(
  db: Queryable,
  schema: string,
  acting: Acting,
  userId: string,
): Promise<void> {
  const orgId = acting.orgId;
  await revokeAccess(db, schema, acting, userId, 'creatorRemoved');
  await handOverDatabases(db, schema, acting, userId);
  await query(
    db,
    sql`UPDATE ${ident(schema, 'scim_groups')} SET document = jsonb_set(document, '{members}',
    COALESCE((SELECT jsonb_agg(member) FROM jsonb_array_elements(document->'members') member
      WHERE member->>'value' <> ${userId}), '[]'::jsonb)), updated_at = clock_timestamp()
    WHERE org_id = ${orgId} AND document->'members' @> jsonb_build_array(jsonb_build_object('value', ${userId}::text))`,
  );
  await query(
    db,
    sql`UPDATE ${ident(schema, 'scim_users')} SET document = document #- ARRAY[${ENTERPRISE_SCHEMA}::text, 'manager'],
      updated_at = clock_timestamp()
    WHERE org_id = ${orgId} AND document->${ENTERPRISE_SCHEMA}::text->'manager'->>'value' = ${userId}`,
  );
  await query(
    db,
    sql`DELETE FROM ${ident(schema, 'grants')} WHERE org_id = ${orgId} AND principal_kind = 'user' AND principal_id = ${userId}`,
  );
  // The links and forms would otherwise outlive their person with no one behind them.
  await query(
    db,
    sql`UPDATE ${ident(schema, 'shared_views')} SET stopped_at = clock_timestamp() WHERE created_by = ${userId} AND stopped_at IS NULL`,
  );
  await query(
    db,
    sql`UPDATE ${ident(schema, 'public_forms')} SET stopped_at = clock_timestamp() WHERE created_by = ${userId} AND stopped_at IS NULL`,
  );
  const picture = await query<{ key: string | null }>(
    db,
    sql`SELECT profile_picture->>'key' AS key
    FROM ${ident(schema, 'users')} WHERE id = ${userId}`,
  );
  if (picture.rows[0]?.key) await fileStorage('postgres', db, schema, {}).delete(picture.rows[0].key);
  await query(db, sql`DELETE FROM ${ident(schema, 'users')} WHERE id = ${userId}`);
}

/** Tells every open view of the organization's databases to check its access again, after commit. */
export async function accessChanged(db: Queryable, schemas: DataSchemas, orgId: string): Promise<void> {
  const databases = await query<{ id: string }>(
    db,
    sql`SELECT id FROM ${ident(schemas.app, 'databases')} WHERE org_id = ${orgId}`,
  );
  for (const database of databases.rows)
    await query(db, sql`SELECT pg_notify(${accessChannel(schemas)}, ${database.id})`);
}

/**
 * Group members must be people this directory manages.  Members a group already had stay while they
 * remain in the organization, so a person the directory deleted keeps their groups for a restore.
 */
async function groupMembers(
  db: Queryable,
  schema: string,
  orgId: string,
  requested: string[],
  previous: Set<string>,
): Promise<string[]> {
  const found = await query<{ user_id: string; managed: boolean }>(
    db,
    sql`SELECT m.user_id, (s.user_id IS NOT NULL AND s.deleted_at IS NULL AND m.kind <> 'owner') AS managed
    FROM ${ident(schema, 'memberships')} m
    LEFT JOIN ${ident(schema, 'scim_users')} s ON s.org_id = m.org_id AND s.user_id = m.user_id
    WHERE m.org_id = ${orgId} AND m.user_id = ANY(${requested}::text[])`,
  );
  const people = new Map(found.rows.map((row) => [row.user_id, row.managed]));
  if (requested.some((id) => !previous.has(id) && !people.get(id)))
    throw new ScimError(400, 'scim.errors.groupMember', 'invalidValue');
  return requested.filter((id) => people.has(id));
}

/**
 * Whether a replacement or a change turns the person off: `active` false, as a JSON boolean or
 * Entra's string, on its own path or inside a path-less value.
 */
export function suspends(method: 'PUT' | 'PATCH', payload: unknown): boolean {
  const off = (value: unknown) => booleanOf(value) === false;
  if (method === 'PUT') return off(attribute(payload, 'active'));
  const operations = attribute(payload, 'Operations');
  if (!Array.isArray(operations)) return false;
  return operations.some((operation) => {
    const op = attribute(operation, 'op');
    if (typeof op !== 'string' || !['add', 'replace'].includes(op.toLowerCase())) return false;
    const path = attribute(operation, 'path');
    const value = attribute(operation, 'value');
    if (path === undefined || path === null) return off(attribute(value, 'active'));
    return typeof path === 'string' &&
      /^(?:urn:ietf:params:scim:schemas:core:2\.0:User:)?active$/i.test(path.trim())
      ? off(value)
      : false;
  });
}

/**
 * Applies a change from the directory.  A replacement or change that turns an existing person off
 * suspends them whatever else it carries: when the rest of it is invalid or clashes with someone
 * else's name, the suspension still applies, so offboarding never waits on it.
 */
export async function changeResource(
  ctx: AppContext,
  token: TokenRow,
  kind: ResourceKind,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  id: string | undefined,
  payload: unknown,
): Promise<{ row?: ResourceRow; dryRun: boolean }> {
  try {
    return await applyChange(ctx, token, kind, method, id, payload);
  } catch (error) {
    if (
      kind === 'Users' &&
      id &&
      (method === 'PUT' || method === 'PATCH') &&
      error instanceof ScimError &&
      (error.status === 400 || error.scimType === 'uniqueness') &&
      suspends(method, payload)
    )
      return suspendOnly(ctx, token, method, id, error);
    throw error;
  }
}

/** Suspends someone the directory turned off, when the rest of its change couldn't be applied */
async function suspendOnly(
  ctx: AppContext,
  token: TokenRow,
  method: 'PUT' | 'PATCH',
  id: string,
  refused: ScimError,
): Promise<{ row?: ResourceRow; dryRun: boolean }> {
  const { pool, schemas } = dataStore(ctx);
  const { app: schema, audit } = authDatabase(ctx);
  const acting = tokenActing(token, audit);
  return withTransaction(pool, async (db) => {
    await lockKeys(db, [`scim:${token.org_id}`]);
    await oauthActing(db, acting.actorId, acting.metadata);
    const live = await db.query(
      `SELECT id FROM ${schema}.scim_tokens WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL FOR SHARE`,
      [token.id, token.org_id],
    );
    if (!live.rowCount) throw new ScimError(401, 'scim.errors.tokenInvalid');
    const settings = await db.query<{ dry_run: boolean }>(
      `SELECT dry_run FROM ${schema}.scim_settings WHERE org_id = $1 FOR SHARE`,
      [token.org_id],
    );
    const dryRun = settings.rows[0]?.dry_run ?? false;
    const before = await getResource(db, schemas.app, token.org_id, 'Users', id);
    await protectedPerson(db, schemas.app, token.org_id, id);
    if (dryRun) await db.query('SAVEPOINT scim_preview');
    await db.query(
      `UPDATE ${schema}.users SET automation_access_retained = false, deactivated_at = COALESCE(deactivated_at, clock_timestamp()) WHERE id = $1`,
      [id],
    );
    await revokeAccess(db, schemas.app, acting, id, 'creatorSuspended');
    const document = { ...before.document, active: false };
    await query(
      db,
      sql`UPDATE ${table(schemas.app, 'Users')} SET document = ${JSON.stringify(document)}::jsonb,
        updated_at = clock_timestamp() WHERE org_id = ${token.org_id} AND user_id = ${id}`,
    );
    const row = await getResource(db, schemas.app, token.org_id, 'Users', id);
    if (dryRun) await db.query('ROLLBACK TO SAVEPOINT scim_preview');
    await tokenEvent(db, acting, `scim.users.${method.toLowerCase()}`, id, {
      dryRun,
      before: before.document,
      after: document,
      suspendedOnly: true,
      refused: refused.messageKey,
    });
    if (!dryRun) {
      await accessChanged(db, schemas, token.org_id);
      await personChanged(db, schemas, token.org_id, id);
    }
    return { row, dryRun };
  });
}

async function applyChange(
  ctx: AppContext,
  token: TokenRow,
  kind: ResourceKind,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  id: string | undefined,
  payload: unknown,
): Promise<{ row?: ResourceRow; dryRun: boolean }> {
  const { pool, schemas } = dataStore(ctx);
  const { app: schema, audit } = authDatabase(ctx);
  const acting = tokenActing(token, audit);
  try {
    return await withTransaction(pool, async (db) => {
      // Writes take turns per organization before they hold a token, since a write can revoke
      // tokens itself.  Revocation waits for an in-flight write, and a revoked token cannot
      // begin another one.
      await lockKeys(db, [`scim:${token.org_id}`]);
      // A suspension ends app connections in a database trigger, which credits whoever acts here.
      await oauthActing(db, acting.actorId, acting.metadata);
      const live = await db.query(
        `SELECT id FROM ${schema}.scim_tokens WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL FOR SHARE`,
        [token.id, token.org_id],
      );
      if (!live.rowCount) throw new ScimError(401, 'scim.errors.tokenInvalid');
      const settings = await db.query<{ dry_run: boolean; delete_action: string }>(
        `SELECT * FROM ${schema}.scim_settings WHERE org_id = $1 FOR SHARE`,
        [token.org_id],
      );
      const dryRun = settings.rows[0]?.dry_run ?? false;
      let before = id ? await getResource(db, schemas.app, token.org_id, kind, id) : undefined;
      /** A member who joined outside provisioning, whom this create brings under it */
      let adopted: string | undefined;
      if (method === 'POST' && kind === 'Users') {
        const proposed = normalizeResource(payload, kind);
        const address = personEmail(proposed);
        // Reprovisioning someone the directory deleted restores that same person: the same
        // directory record, or the same address when neither record has an ID.  A login name
        // alone never hands one person's account to another.
        const restored = await db.query<ResourceRow>(
          `SELECT s.user_id AS id, s.document, s.created_at, s.updated_at
          FROM ${schema}.scim_users s JOIN ${schema}.users u ON u.id = s.user_id
          WHERE s.org_id = $1 AND s.deleted_at IS NOT NULL
            AND (s.external_id = $2 OR ($2::text IS NULL AND s.external_id IS NULL AND lower(u.email) = $3))`,
          [token.org_id, proposed.externalId ?? null, address],
        );
        if (restored.rows.length > 1) throw new ScimError(409, 'scim.errors.uniqueness', 'uniqueness');
        before = restored.rows[0];
        const holder = await db.query(
          `SELECT 1 FROM ${schema}.scim_users s JOIN ${schema}.users u ON u.id = s.user_id
          WHERE s.org_id = $1 AND lower(s.document->>'userName') = lower($2) AND u.deactivated_at IS NOT NULL
            AND s.user_id <> $3 AND s.external_id IS DISTINCT FROM $4 LIMIT 1`,
          [token.org_id, proposed.userName, before?.id ?? '', proposed.externalId ?? null],
        );
        if (holder.rowCount)
          throw new ScimError(
            409,
            'scim.errors.uniqueness',
            'uniqueness',
            'This userName belongs to a deactivated Riosoma account for a different directory record.  A Riosoma administrator must remove that account with Remove account in Settings, People, before the name can be used again.',
          );
        if (!before) {
          const member = await db.query<{ id: string }>(
            `SELECT u.id FROM ${schema}.users u
            JOIN ${schema}.memberships m ON m.user_id = u.id AND m.org_id = $1 AND m.kind = 'member'
            WHERE lower(u.email) = $2 AND NOT EXISTS (SELECT 1 FROM ${schema}.scim_users s WHERE s.user_id = u.id)`,
            [token.org_id, address],
          );
          adopted = member.rows[0]?.id;
        }
      }
      const person = before?.id ?? adopted;
      if (kind === 'Users' && person) await protectedPerson(db, schemas.app, token.org_id, person);
      const resourceId = person ?? id ?? newId(kind === 'Users' ? 'user' : 'group');
      let current: { email: string; active: boolean } | undefined;
      if (kind === 'Users' && person) {
        const found = await db.query<{ email: string; active: boolean }>(
          `SELECT email, deactivated_at IS NULL AS active FROM ${schema}.users WHERE id = $1`,
          [resourceId],
        );
        current = found.rows[0];
      }
      if (dryRun) await db.query('SAVEPOINT scim_preview');
      let document: Record<string, unknown> | undefined;
      if (method !== 'DELETE') {
        let input = method === 'PATCH' ? patchResource(before!.document, payload, kind) : payload;
        // A replacement or change that leaves active out, or sets it to null, keeps the person as
        // they are.  RFC 7643 section 2.5 reads null as unassigned, never as reactivation.
        if (
          (method === 'PUT' || method === 'PATCH') &&
          kind === 'Users' &&
          current &&
          object(input) &&
          attribute(input, 'active') == null
        )
          input = withAttribute(input, 'active', current.active);
        document = normalizeResource(input, kind);
        document.id = resourceId;
      }
      if (kind === 'Users') {
        if (document) {
          const address = personEmail(document);
          if (method === 'POST' || address !== current?.email)
            await requireOwnDomain(db, schemas.app, token.org_id, address);
          const enterprise = document[ENTERPRISE_SCHEMA] as { manager?: { value: string } } | undefined;
          if (enterprise?.manager) {
            const manager = await db.query(
              `SELECT user_id FROM ${schema}.memberships WHERE org_id = $1 AND user_id = $2`,
              [token.org_id, enterprise.manager.value],
            );
            if (!manager.rowCount) throw new ScimError(400, 'scim.errors.member', 'invalidValue');
          }
          if (!person) {
            await db.query(
              `INSERT INTO ${schema}.users (id, email, name, deactivated_at) VALUES ($1, $2, $3, CASE WHEN $4 THEN NULL ELSE clock_timestamp() END)`,
              [resourceId, address, personName(document), document.active],
            );
            await db.query(`INSERT INTO ${schema}.memberships (org_id, user_id) VALUES ($1, $2)`, [
              token.org_id,
              resourceId,
            ]);
          } else {
            // A directory that sends no name keeps the one the person has.
            await db.query(
              `UPDATE ${schema}.users SET automation_access_retained = false, email = $1, name = COALESCE(NULLIF($2, ''), name), deactivated_at = CASE WHEN $3 THEN NULL ELSE COALESCE(deactivated_at, clock_timestamp()) END WHERE id = $4`,
              [address, personName(document), document.active, resourceId],
            );
          }
          // Once an admin maps an attribute to units, the directory's record decides the unit.
          const placement = placementFor(await unitMappings(db, schema, token.org_id), document);
          if (placement !== undefined) {
            const placed = await placePerson(db, schema, token.org_id, resourceId, placement);
            if (placed.moved)
              await tokenEvent(
                db,
                acting,
                'org.unit.person_moved',
                resourceId,
                moveEntry(resourceId, placed.from, placement),
              );
          }
          if (!document.active) await revokeAccess(db, schemas.app, acting, resourceId, 'creatorSuspended');
        } else {
          const remove = settings.rows[0]?.delete_action === 'remove';
          await revokeAccess(
            db,
            schemas.app,
            acting,
            resourceId,
            remove ? 'creatorRemoved' : 'creatorSuspended',
          );
          if (remove) await removeAccount(db, schemas.app, acting, resourceId);
          else {
            await db.query(
              `UPDATE ${schema}.users SET automation_access_retained = false, deactivated_at = COALESCE(deactivated_at, clock_timestamp()) WHERE id = $1`,
              [resourceId],
            );
            document = { ...before!.document, active: false };
          }
        }
      } else if (document) {
        const previous = new Set(
          ((before?.document.members ?? []) as Array<{ value: string }>).map((member) => member.value),
        );
        const requested = (document.members as Array<{ value: string }>).map((member) => member.value);
        const members = await groupMembers(db, schemas.app, token.org_id, requested, previous);
        const kept = new Set(members);
        document.members = (document.members as Array<{ value: string }>).filter((member) =>
          kept.has(member.value),
        );
        if (!before)
          await db.query(
            `INSERT INTO ${schema}.groups (id, org_id, name, scim_managed) VALUES ($1, $2, $3, true)`,
            [resourceId, token.org_id, document.displayName],
          );
        else
          await db.query(`UPDATE ${schema}.groups SET name = $1 WHERE id = $2 AND org_id = $3`, [
            document.displayName,
            resourceId,
            token.org_id,
          ]);
        await db.query(`DELETE FROM ${schema}.group_members WHERE org_id = $1 AND group_id = $2`, [
          token.org_id,
          resourceId,
        ]);
        await db.query(
          `INSERT INTO ${schema}.group_members (org_id, group_id, user_id) SELECT $1, $2, unnest($3::text[])`,
          [token.org_id, resourceId, members],
        );
      } else {
        await db.query(
          `DELETE FROM ${schema}.grants WHERE org_id = $1 AND principal_kind = 'group' AND principal_id = $2`,
          [token.org_id, resourceId],
        );
        await db.query(`DELETE FROM ${schema}.groups WHERE org_id = $1 AND id = $2`, [
          token.org_id,
          resourceId,
        ]);
      }
      let row: ResourceRow | undefined;
      if (document) {
        await query(
          db,
          sql`INSERT INTO ${table(schemas.app, kind)} (org_id, ${idColumn(kind)}, external_id, document)
          VALUES (${token.org_id}, ${resourceId}, ${document.externalId ?? null}, ${JSON.stringify(document)}::jsonb)
          ON CONFLICT (org_id, ${idColumn(kind)}) DO UPDATE SET external_id = EXCLUDED.external_id, document = EXCLUDED.document, deleted_at = NULL, updated_at = clock_timestamp()`,
        );
        row = await getResource(db, schemas.app, token.org_id, kind, resourceId);
        if (method === 'DELETE')
          await query(
            db,
            sql`UPDATE ${table(schemas.app, kind)} SET deleted_at = clock_timestamp() WHERE org_id = ${token.org_id} AND ${idColumn(kind)} = ${resourceId}`,
          );
      }
      if (dryRun) await db.query('ROLLBACK TO SAVEPOINT scim_preview');
      // Dry runs retain only the audit description, never account or membership changes.  The
      // token acts, not a person, so the event names it and leaves the person actor empty.
      if (adopted)
        await tokenEvent(db, acting, 'scim.users.adopted', resourceId, { dryRun, userId: resourceId });
      await tokenEvent(db, acting, `scim.${kind.toLowerCase()}.${method.toLowerCase()}`, resourceId, {
        dryRun,
        before: before?.document ?? null,
        after: document ?? null,
      });
      if (!dryRun) {
        await accessChanged(db, schemas, token.org_id);
        if (kind === 'Users') await personChanged(db, schemas, token.org_id, resourceId);
      }
      return { ...(row ? { row } : {}), dryRun };
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505')
      throw new ScimError(409, 'scim.errors.uniqueness', 'uniqueness');
    throw error;
  }
}

async function personChanged(
  db: Queryable,
  schemas: DataSchemas,
  orgId: string,
  userId: string,
): Promise<void> {
  await query(
    db,
    sql`SELECT pg_notify(${organizationChannel(schemas)}, ${JSON.stringify({ orgId, personChanged: userId })})`,
  );
}
