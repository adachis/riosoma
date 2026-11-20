import { Readable } from 'node:stream';
import sharp from 'sharp';
import {
  AppError,
  newId,
  type MemberKind,
  type PersonalProfile,
  type ProfileUpdate,
  type PersonIdentity,
  type Member,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import type { RuntimeConfig } from '../config.js';
import { oauthActing } from '../authorization/store.js';
import { ENTERPRISE_SCHEMA } from '../auth/scim/patch.js';
import { revokeAccess, removeAccount } from '../auth/scim/store.js';
import { organizationChannel } from './notify.js';
import { digest, scope, type AdminContext } from './organization-admin/store.js';
import { fileStorage } from './files/storage.js';
import { checkFileSafety, requireSafeFile } from './files/safety.js';
import { uploadLimit } from './files/settings.js';

export interface MemberState {
  kind: MemberKind;
  deactivated: boolean;
  managed: boolean;
  shared: boolean;
  unitId: string | null;
}

export async function memberState(c: AdminContext, userId: string): Promise<MemberState> {
  const result = await query<MemberState>(
    c.db,
    sql`SELECT m.kind,
    u.deactivated_at IS NOT NULL AS deactivated, m.org_unit_id AS "unitId",
    EXISTS (SELECT 1 FROM ${ident(c.schemas.app, 'scim_users')} s
      WHERE s.org_id = m.org_id AND s.user_id = m.user_id) AS managed,
    EXISTS (SELECT 1 FROM ${ident(c.schemas.app, 'memberships')} other
      WHERE other.user_id = u.id AND other.org_id <> m.org_id) AS shared
    FROM ${ident(c.schemas.app, 'memberships')} m JOIN ${ident(c.schemas.app, 'users')} u ON u.id = m.user_id
    WHERE m.org_id = ${c.actor.orgId} AND m.user_id = ${userId} FOR NO KEY UPDATE OF u, m`,
  );
  if (!result.rows[0]) throw new AppError('not_found', 'errors.notFound');
  return result.rows[0];
}

export async function keepOwner(c: AdminContext, userId: string, before: MemberState): Promise<void> {
  if (before.kind !== 'owner' || before.deactivated) return;
  const other = await query(
    c.db,
    sql`SELECT 1 FROM ${ident(c.schemas.app, 'memberships')} m
    JOIN ${ident(c.schemas.app, 'users')} u ON u.id = m.user_id
    WHERE m.org_id = ${c.actor.orgId} AND m.kind = 'owner' AND m.user_id <> ${userId}
      AND u.deactivated_at IS NULL LIMIT 1`,
  );
  if (!other.rowCount) throw new AppError('conflict', 'people.guard.lastOwner');
}

export async function changeKind(c: AdminContext, userId: string, kind: MemberKind): Promise<MemberState> {
  await scope(c).requirePeoplePerson(userId);
  const before = await memberState(c, userId);
  const actor = await scope(c).currentPerson();
  if ((kind === 'owner' || before.kind === 'owner') && actor.kind !== 'owner')
    throw new AppError('forbidden', 'people.guard.ownerReach');
  if (before.managed) throw new AppError('conflict', 'people.guard.directory');
  if (kind === 'owner' && before.deactivated) throw new AppError('conflict', 'people.guard.inactiveOwner');
  if (before.kind === 'owner' && kind !== 'owner') await keepOwner(c, userId, before);
  if (kind === 'guest') {
    const admins = await query(
      c.db,
      sql`SELECT 1 FROM ${ident(c.schemas.app, 'org_unit_admins')}
      WHERE org_id = ${c.actor.orgId} AND user_id = ${userId} AND cardinality(roles) > 0`,
    );
    if (
      admins.rowCount ||
      (actor.kind !== 'owner' &&
        (
          await query<{ roles: string[] }>(
            c.db,
            sql`SELECT admin_roles AS roles FROM ${ident(c.schemas.app, 'memberships')}
        WHERE org_id = ${c.actor.orgId} AND user_id = ${userId}`,
          )
        ).rows[0]?.roles.length)
    )
      throw new AppError('conflict', 'people.guard.adminGuest');
  }
  await oauthActing(c.db, c.actor.userId, { actorKind: 'administrator' });
  await query(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, 'memberships')} SET kind = ${kind}
    WHERE org_id = ${c.actor.orgId} AND user_id = ${userId}`,
  );
  return before;
}

export async function changeStatus(
  c: AdminContext,
  userId: string,
  deactivated: boolean,
): Promise<MemberState> {
  await scope(c).requirePeoplePerson(userId);
  const before = await memberState(c, userId);
  if (before.managed) throw new AppError('conflict', 'people.guard.directory');
  if (before.shared) throw new AppError('forbidden', 'people.remove.shared');
  if (before.kind === 'owner' && (await scope(c).currentPerson()).kind !== 'owner')
    throw new AppError('forbidden', 'people.guard.ownerReach');
  if (deactivated) await keepOwner(c, userId, before);
  await oauthActing(c.db, c.actor.userId, { actorKind: 'administrator' });
  await query(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, 'users')}
    SET deactivated_at = CASE WHEN ${deactivated} THEN COALESCE(deactivated_at, clock_timestamp()) ELSE NULL END,
      automation_access_retained = ${deactivated}
    WHERE id = ${userId}`,
  );
  if (deactivated)
    await revokeAccess(
      c.db,
      c.schemas.app,
      { orgId: c.actor.orgId, actorId: c.actor.userId, audit: `"${c.schemas.audit}"`, metadata: {} },
      userId,
      'creatorSuspended',
    );
  return before;
}

export async function removePerson(c: AdminContext, userId: string) {
  await scope(c).requirePeoplePerson(userId);
  const before = await memberState(c, userId);
  await keepOwner(c, userId, before);
  if (before.kind === 'owner') throw new AppError('forbidden', 'people.remove.owner');
  if (!before.managed) throw new AppError('conflict', 'people.remove.notManaged');
  if (!before.deactivated) throw new AppError('conflict', 'people.remove.active');
  if (before.shared) throw new AppError('forbidden', 'people.remove.shared');
  const directory = await query<{ userName: string | null; externalId: string | null }>(
    c.db,
    sql`SELECT document->>'userName' AS "userName", external_id AS "externalId"
    FROM ${ident(c.schemas.app, 'scim_users')} WHERE org_id = ${c.actor.orgId} AND user_id = ${userId}`,
  );
  await removeAccount(
    c.db,
    c.schemas.app,
    { orgId: c.actor.orgId, actorId: c.actor.userId, audit: `"${c.schemas.audit}"`, metadata: {} },
    userId,
  );
  return { ...before, ...directory.rows[0] };
}

export async function personIdentity(c: AdminContext, userId: string): Promise<PersonIdentity | null> {
  await scope(c).requirePersonRead(userId);
  const result = await query<PersonIdentity>(
    c.db,
    sql`SELECT id, name, email,
    CASE WHEN profile_picture IS NULL THEN NULL ELSE '/api/people/' || id || '/picture?v=' || (profile_picture->>'key') END AS "pictureUrl",
    deactivated_at IS NOT NULL AS deactivated FROM ${ident(c.schemas.app, 'users')} WHERE id = ${userId}`,
  );
  return result.rows[0] ?? null;
}

export async function profile(
  c: AdminContext,
  config: RuntimeConfig,
  mailAvailable: boolean,
): Promise<PersonalProfile> {
  await scope(c).requireOrganization();
  const result = await query<{
    name: string;
    email: string;
    picture: { key: string } | null;
    managed: boolean;
  }>(
    c.db,
    sql`SELECT u.name, u.email, u.profile_picture AS picture,
      EXISTS (SELECT 1 FROM ${ident(c.schemas.app, 'scim_users')} s WHERE s.user_id = u.id)
      OR EXISTS (SELECT 1 FROM ${ident(c.schemas.app, 'sso_identities')} s WHERE s.user_id = u.id) AS managed
      FROM ${ident(c.schemas.app, 'users')} u WHERE u.id = ${c.actor.userId}`,
  );
  const row = result.rows[0];
  if (!row) throw new AppError('not_found', 'errors.notFound');
  return {
    name: row.name,
    email: row.email,
    pictureUrl: row.picture ? `/api/people/${c.actor.userId}/picture?v=${row.picture.key}` : null,
    managedFields: row.managed ? ['name', 'email', 'picture'] : [],
    emailChangeAllowed: !row.managed && mailAvailable && Boolean(config.baseUrl),
    revision: digest(row),
  };
}

export async function saveProfile(
  c: AdminContext,
  config: RuntimeConfig,
  mailAvailable: boolean,
  command: ProfileUpdate,
) {
  await query(
    c.db,
    sql`SELECT id FROM ${ident(c.schemas.app, 'users')} WHERE id = ${c.actor.userId} FOR NO KEY UPDATE`,
  );
  const before = await profile(c, config, mailAvailable);
  if (before.revision !== command.revision) throw new AppError('conflict', 'errors.conflict');
  if (
    (command.name !== undefined && before.managedFields.includes('name')) ||
    (command.picture !== undefined && before.managedFields.includes('picture'))
  )
    throw new AppError('forbidden', 'profile.managed');
  if (command.name !== undefined)
    await query(
      c.db,
      sql`UPDATE ${ident(c.schemas.app, 'users')}
    SET name = ${command.name} WHERE id = ${c.actor.userId}`,
    );
  if (command.picture !== undefined) {
    let picture: { key: string } | null = null;
    if (command.picture !== null) {
      const encoded = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(command.picture);
      if (!encoded) throw new AppError('validation_failed', 'profile.picture.invalid');
      const bytes = Buffer.from(encoded[1]!, 'base64');
      if (bytes.length > Math.min(2_000_000, await uploadLimit(c.db, c.schemas.app, c.actor.orgId)))
        throw new AppError('payload_too_large', 'profile.picture.invalid');
      requireSafeFile(
        await checkFileSafety(
          { db: c.db, schema: c.schemas.app, orgId: c.actor.orgId, config },
          { bytes, statedType: command.picture.slice(5, command.picture.indexOf(';')) },
        ),
        { invalid: 'profile.picture.invalid', infected: 'profile.picture.invalid' },
      );
      let safe: Buffer;
      try {
        const image = sharp(bytes, { limitInputPixels: 16_000_000, animated: false });
        const metadata = await image.metadata();
        if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '') || metadata.width !== metadata.height)
          throw new Error('Invalid square picture');
        safe = await image.rotate().resize(256, 256).png().toBuffer();
      } catch {
        throw new AppError('validation_failed', 'profile.picture.invalid');
      }
      // Small profile pictures use transaction-backed storage so a failed save leaves no orphan.
      picture = { key: newId('attachment') };
      await fileStorage('postgres', c.db, c.schemas.app, config).write(picture.key, Readable.from([safe]));
    }
    const old = await query<{ key: string | null }>(
      c.db,
      sql`SELECT profile_picture->>'key' AS key
      FROM ${ident(c.schemas.app, 'users')} WHERE id = ${c.actor.userId}`,
    );
    await query(
      c.db,
      sql`UPDATE ${ident(c.schemas.app, 'users')} SET profile_picture = ${picture ? JSON.stringify(picture) : null}::jsonb
      WHERE id = ${c.actor.userId}`,
    );
    if (old.rows[0]?.key) await fileStorage('postgres', c.db, c.schemas.app, config).delete(old.rows[0].key);
  }
  return { before, after: await profile(c, config, mailAvailable) };
}

/** The notice identifies the changed person, and each receiving tab rechecks what it can read. */
export async function peopleChanged(c: AdminContext, userId: string, allMemberships = false): Promise<void> {
  if (allMemberships) {
    // A profile belongs to the account, so its changes reach every organization the person belongs to.
    await query(
      c.db,
      sql`SELECT pg_notify(${organizationChannel(c.schemas)},
        json_build_object('orgId', org_id, 'personChanged', user_id)::text)
        FROM ${ident(c.schemas.app, 'memberships')} WHERE user_id = ${userId}`,
    );
    return;
  }
  await query(
    c.db,
    sql`SELECT pg_notify(${organizationChannel(c.schemas)},
    ${JSON.stringify({ orgId: c.actor.orgId, personChanged: userId })})`,
  );
}

export async function listPeople(c: AdminContext): Promise<Member[]> {
  const { db: pool, schemas, actor } = c;
  const visible = await scope(c).visiblePeople();
  const manageable = await scope(c).manageablePeople();
  const owners = await query<{ count: number }>(
    pool,
    sql`SELECT count(*)::int AS count FROM ${ident(schemas.app, 'memberships')} m JOIN ${ident(schemas.app, 'users')} u ON u.id = m.user_id WHERE m.org_id = ${actor.orgId} AND m.kind = 'owner' AND u.deactivated_at IS NULL`,
  );
  const result = await query<Member>(
    pool,
    sql`
      SELECT u.id, u.name, u.email, m.kind, m.admin_roles AS "adminRoles", m.org_unit_id AS "unitId",
             u.deactivated_at IS NOT NULL AS deactivated,
             EXISTS (SELECT 1 FROM ${ident(schemas.app, 'org_unit_admins')} a
               WHERE a.org_id = m.org_id AND a.user_id = m.user_id AND cardinality(a.roles) > 0) AS "guestRoleBlocked",
             CASE WHEN u.profile_picture IS NULL THEN NULL ELSE '/api/people/' || u.id || '/picture?v=' || (u.profile_picture->>'key') END AS "pictureUrl"
      FROM ${ident(schemas.app, 'memberships')} m
      JOIN ${ident(schemas.app, 'users')} u ON u.id = m.user_id
      WHERE m.org_id = ${actor.orgId} AND (${visible === null} OR u.id = ANY(${[...(visible ?? [])]}::text[])) ORDER BY u.name, u.id`,
  );
  const managed = await query<{ user_id: string; document: Record<string, unknown> }>(
    pool,
    sql`SELECT user_id, document FROM ${ident(schemas.app, 'scim_users')} WHERE org_id = ${actor.orgId}`,
  );
  const profiles = new Map(managed.rows.map((row) => [row.user_id, row.document]));
  return result.rows.map(({ unitId, ...original }) => {
    const row = {
      ...original,
      canManage: manageable === null || manageable.has(original.id),
      lastOwner: original.kind === 'owner' && !original.deactivated && owners.rows[0]?.count === 1,
    };
    // Each person's unit shows once the organization has units, to everyone but guests.
    const member: Member = actor.hasUnits && actor.kind !== 'guest' ? { ...row, unitId } : row;
    // A guest sees other people's names and addresses and nothing of their directory records
    // or administrative roles.  Those are for members and administrators.
    if (actor.kind === 'guest' && member.id !== actor.userId)
      return {
        ...member,
        adminRoles: [],
        canManage: false,
        guestRoleBlocked: undefined,
        lastOwner: undefined,
      };
    const document = profiles.get(member.id);
    // The owner is never managed by a directory, whatever the database says.
    if (!document || member.kind === 'owner') return member;
    const name = document.name as { givenName?: string; familyName?: string } | undefined;
    return {
      ...member,
      managed: 'scim' as const,
      profile: {
        ...(typeof document.userName === 'string' ? { userName: document.userName } : {}),
        ...(typeof document.externalId === 'string' ? { externalId: document.externalId } : {}),
        ...name,
        ...(document[ENTERPRISE_SCHEMA] as Record<string, unknown> | undefined),
      },
    };
  });
}

export async function profilePassword(c: AdminContext): Promise<string | null> {
  await scope(c).currentPerson();
  const result = await query<{ hash: string | null }>(
    c.db,
    sql`SELECT password_hash AS hash
    FROM ${ident(c.schemas.app, 'users')} WHERE id = ${c.actor.userId} AND deactivated_at IS NULL`,
  );
  return result.rows[0]?.hash ?? null;
}

export async function personPicture(c: AdminContext, userId: string): Promise<string> {
  await scope(c).requirePersonRead(userId);
  const result = await query<{ key: string | null }>(
    c.db,
    sql`SELECT profile_picture->>'key' AS key
    FROM ${ident(c.schemas.app, 'users')} WHERE id = ${userId}`,
  );
  const key = result.rows[0]?.key;
  if (!key) throw new AppError('not_found', 'errors.notFound');
  return key;
}

export async function memberAccess(c: AdminContext, userId: string) {
  await scope(c).requirePeoplePerson(userId);
  const state = await query<{ role: MemberKind; deactivated: boolean }>(
    c.db,
    sql`SELECT m.kind AS role, u.deactivated_at IS NOT NULL AS deactivated
    FROM ${ident(c.schemas.app, 'memberships')} m JOIN ${ident(c.schemas.app, 'users')} u ON u.id = m.user_id
    WHERE m.org_id = ${c.actor.orgId} AND m.user_id = ${userId}`,
  );
  if (!state.rows[0]) throw new AppError('not_found', 'errors.notFound');
  return state.rows[0];
}
