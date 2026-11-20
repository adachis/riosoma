import type { FastifyInstance } from 'fastify';
import { AppError, DatabaseId, DatabaseRole, newId, type OrganizationFolder } from '@riosoma/contracts';
import { ident, query, sql, withTransaction, type Sql } from '@riosoma/db';
import { z } from 'zod';
import { authDatabase, lockKeys } from '../auth/database.js';
import { requireActor } from '../auth/sessions.js';
import { AccessScope } from '../data/access.js';
import { dataStore } from '../data/context.js';
import { lock } from '../data/commands/transaction.js';
import { runHomeCommand } from '../data/commands/home.js';
import type { Actor } from '../http/policy.js';
import { parse } from '../http/validate.js';
import { lockUnits, organizationAdmin, requireGroup, unitResourceAdmin } from '../org-units/store.js';

const policy = {
  config: { policy: { kind: 'admin' as const, area: 'people' as const, scope: 'subtree' as const } },
};
const FolderInput = z.object({
  name: z.string().trim().min(1).max(120),
  databases: z.array(DatabaseId).max(1000),
  confirmedLosses: z.array(z.string()).default([]),
});
const GrantInput = z.object({ groupId: z.string().min(1).max(100), role: DatabaseRole.nullable() });
const Params = z.object({ folderId: z.string().min(1).max(100) });

/**
 * Who may give groups roles on a folder: the organization's owner, and anyone in a group the folder
 * makes an owner.  Guests never are, since group roles don't reach them.
 */
function ownsFolder(schema: string, actor: Actor, folder: Sql): Sql {
  return sql`(${actor.kind === 'owner'} OR (${actor.kind !== 'guest'} AND EXISTS (
    SELECT 1 FROM ${ident(schema, 'grants')} g
    JOIN ${ident(schema, 'group_members')} gm ON gm.org_id = g.org_id AND gm.group_id = g.principal_id
    WHERE g.org_id = ${actor.orgId} AND g.resource_kind = 'folder' AND g.resource_id = ${folder}
      AND g.principal_kind = 'group' AND g.role = 'owner' AND gm.user_id = ${actor.userId})))`;
}

export async function folderRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/org/folders', policy, async (request): Promise<OrganizationFolder[]> => {
    const actor = requireActor(request);
    const { pool } = authDatabase(app.ctx);
    const { schemas } = dataStore(app.ctx);
    const result = await query<OrganizationFolder>(
      pool,
      sql`SELECT f.id, f.name,
      ARRAY(SELECT database_id FROM ${ident(schemas.app, 'folder_databases')} d WHERE d.org_id = f.org_id AND d.folder_id = f.id ORDER BY database_id) AS databases,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('groupId', g.principal_id, 'role', g.role)) FROM ${ident(schemas.app, 'grants')} g
        WHERE g.org_id = f.org_id AND g.resource_kind = 'folder' AND g.resource_id = f.id AND g.principal_kind = 'group'), '[]'::jsonb) AS grants,
      ${ownsFolder(schemas.app, actor, sql`f.id`)} AS "canGrant"
      FROM ${ident(schemas.app, 'folders')} f WHERE org_id = ${actor.orgId} AND f.trashed_at IS NULL ORDER BY name, id`,
    );
    const scope = new AccessScope(pool, schemas, actor);
    const visible: OrganizationFolder[] = [];
    for (const folder of result.rows) {
      // A unit admin sees only the folders people in their units own.
      if (
        !organizationAdmin(actor, 'people') &&
        !(await unitResourceAdmin(pool, `"${schemas.app}"`, actor, 'folder', folder.id, 'people'))
      )
        continue;
      if (!(await scope.folderVisibleForAdministration(folder.id))) continue;
      let allowed = true;
      for (const databaseId of folder.databases)
        if ((await scope.databaseRole(databaseId)) !== 'owner') allowed = false;
      folder.canGrant = (await scope.folderRole(folder.id)) === 'owner';
      if (allowed) visible.push(folder);
    }
    return visible;
  });
  for (const method of ['POST', 'PUT'] as const) {
    app.route({
      method,
      url: `/api/org/folders${method === 'PUT' ? '/:folderId' : ''}`,
      ...policy,
      handler: async (request) => {
        const actor = requireActor(request);
        const input = parse(FolderInput, request.body);
        const id = method === 'POST' ? newId('folder') : parse(Params, request.params).folderId;
        const { pool, app: schema } = authDatabase(app.ctx);
        const { schemas } = dataStore(app.ctx);
        return withTransaction(pool, async (db) => {
          await lockUnits(db, actor.orgId);
          await lock({ db, schemas, actor, databaseId: actor.orgId }, [
            `database:${actor.orgId}`,
            `home:${actor.orgId}`,
          ]);
          await lockKeys(db, [`folders:${actor.orgId}`]);
          const current = await db.query<{ id: string }>(
            `SELECT id FROM ${schema}.folders WHERE org_id = $1 AND id = $2`,
            [actor.orgId, id],
          );
          if (method === 'PUT' && !current.rowCount) throw new AppError('not_found', 'errors.notFound');
          // A unit admin changes only folders people in their units own, and a new folder, which
          // nobody owns yet, is the organization's.
          if (
            !organizationAdmin(actor, 'people') &&
            (method === 'POST' || !(await unitResourceAdmin(db, schema, actor, 'folder', id, 'people')))
          )
            throw new AppError('forbidden', 'errors.adminOnly');
          const previous = await db.query<{ database_id: string }>(
            `SELECT database_id FROM ${schema}.folder_databases WHERE org_id = $1 AND folder_id = $2`,
            [actor.orgId, id],
          );
          // Filing a database here takes it out of any folder it was in, so a unit admin needs the
          // folder it leaves inside their units as well as the one it joins.
          if (!organizationAdmin(actor, 'people')) {
            const leaving = await db.query<{ folder_id: string }>(
              `SELECT DISTINCT folder_id FROM ${schema}.folder_databases
               WHERE org_id = $1 AND database_id = ANY($2::text[]) AND folder_id <> $3`,
              [actor.orgId, input.databases, id],
            );
            for (const { folder_id: folderId } of leaving.rows)
              if (!(await unitResourceAdmin(db, schema, actor, 'folder', folderId, 'people')))
                throw new AppError('forbidden', 'errors.adminOnly');
          }
          const affected = [
            ...new Set([...input.databases, ...previous.rows.map((row) => row.database_id)]),
          ].sort();
          const scope = new AccessScope(db, schemas, actor);
          for (const databaseId of affected) {
            await db.query(`SELECT id FROM ${schema}.databases WHERE org_id = $1 AND id = $2 FOR UPDATE`, [
              actor.orgId,
              databaseId,
            ]);
            await scope.require(databaseId, 'manage');
          }
          await runHomeCommand(
            app,
            actor,
            {
              id: newId('command'),
              action:
                method === 'POST'
                  ? { kind: 'folder.create', folderId: id, name: input.name, parentId: null }
                  : { kind: 'folder.rename', folderId: id, name: input.name },
            },
            { transaction: db, administration: true },
          );
          for (const databaseId of affected) {
            const parentId = input.databases.includes(databaseId) ? id : null;
            await runHomeCommand(
              app,
              actor,
              {
                id: newId('command'),
                action: {
                  kind: 'database.move',
                  databaseId,
                  parentId,
                  confirmedLosses: input.confirmedLosses,
                },
              },
              { transaction: db, administration: true },
            );
          }
          return { id, ...input };
        });
      },
    });
  }
  app.put('/api/org/folders/:folderId/grants', policy, async (request) => {
    const actor = requireActor(request);
    const { folderId } = parse(Params, request.params);
    const input = parse(GrantInput, request.body);
    const { pool, app: schema } = authDatabase(app.ctx);
    const { schemas } = dataStore(app.ctx);
    await withTransaction(pool, async (db) => {
      await lockUnits(db, actor.orgId);
      await lock({ db, schemas, actor, databaseId: actor.orgId }, [
        `database:${actor.orgId}`,
        `home:${actor.orgId}`,
      ]);
      await lockKeys(db, [`folders:${actor.orgId}`]);
      const folder = await db.query(
        `SELECT id FROM ${schema}.folders WHERE org_id = $1 AND id = $2 FOR UPDATE`,
        [actor.orgId, folderId],
      );
      const group = await db.query(
        `SELECT id FROM ${schema}.groups WHERE org_id = $1 AND id = $2 FOR SHARE`,
        [actor.orgId, input.groupId],
      );
      if (!folder.rowCount || !group.rowCount) throw new AppError('not_found', 'errors.notFound');
      // A unit admin gives roles only on folders people in their units own, and only to groups
      // made up of people in their units.
      if (!organizationAdmin(actor, 'people')) {
        if (!(await unitResourceAdmin(db, schema, actor, 'folder', folderId, 'people')))
          throw new AppError('forbidden', 'errors.adminOnly');
        await requireGroup(db, schema, actor, input.groupId, 'people');
      }
      const databases = await db.query<{ database_id: string }>(
        `SELECT database_id FROM ${schema}.folder_databases WHERE org_id = $1 AND folder_id = $2 ORDER BY database_id`,
        [actor.orgId, folderId],
      );
      const scope = new AccessScope(db, schemas, actor);
      for (const row of databases.rows) {
        await db.query(`SELECT id FROM ${schema}.databases WHERE org_id = $1 AND id = $2 FOR UPDATE`, [
          actor.orgId,
          row.database_id,
        ]);
        await scope.require(row.database_id, 'manage');
      }
      // An empty folder passes every check above, and its roles reach whatever is filed there later.
      if ((await scope.folderRole(folderId)) !== 'owner')
        throw new AppError('forbidden', 'org.folder.ownersOnly');
      await runHomeCommand(
        app,
        actor,
        {
          id: newId('command'),
          action: {
            kind: 'folder.share',
            folderId,
            principal: { kind: 'group', id: input.groupId },
            role: input.role,
          },
        },
        { transaction: db },
      );
    });
    return { folderId, ...input };
  });
}
