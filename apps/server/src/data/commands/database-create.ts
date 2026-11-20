import { refuseDemo } from '../../demo/boundary.js';
import { AppError, newId, type DatabaseCreate } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { AccessScope } from '../access.js';
import { databaseMeta, type CommandContext } from './context.js';
import { ensureGroup, lock, recordChange } from './transaction.js';
import { placementAccessLosses } from './home.js';

export type DatabaseDefinition = Pick<DatabaseCreate, 'id' | 'name' | 'icon' | 'color'> & {
  folderId: string | null;
};

/** Creation and folder placement commit together, with the same audit and live updates. */
export async function createDatabase(
  c: CommandContext,
  definition: DatabaseDefinition,
  groupId: string,
): Promise<void> {
  refuseDemo(c.actor);
  const { db, schemas, actor } = c;
  if (actor.kind === 'guest' || actor.token?.databases) throw new AppError('forbidden', 'data.access.denied');
  await lock(c, [`home:${actor.orgId}`, `database:${definition.id}`]);
  if (definition.folderId)
    await new AccessScope(db, schemas, actor).requireFolder(definition.folderId, 'editRecords');
  await query(
    db,
    sql`INSERT INTO ${ident(schemas.app, 'databases')} (id, org_id, name, icon, color, created_by)
      VALUES (${definition.id}, ${actor.orgId}, ${definition.name}, ${definition.icon}, ${definition.color}, ${actor.userId})`,
  );
  await query(
    db,
    sql`INSERT INTO ${ident(schemas.app, 'grants')}
      (org_id, resource_kind, resource_id, principal_kind, principal_id, role, created_by)
      VALUES (${actor.orgId}, 'database', ${definition.id}, 'user', ${actor.userId}, 'owner', ${actor.userId})`,
  );
  if (definition.folderId) {
    // Placement expands inherited access, so creation must enforce the same policies as a move.
    await placementAccessLosses(c, {
      kind: 'database.move',
      databaseId: definition.id,
      parentId: definition.folderId,
      confirmedLosses: [],
    });
    await query(
      db,
      sql`INSERT INTO ${ident(schemas.app, 'folder_databases')} (org_id, folder_id, database_id)
        VALUES (${actor.orgId}, ${definition.folderId}, ${definition.id})`,
    );
  }
  if (!c.preview) {
    await ensureGroup(c, groupId);
    await recordChange(
      c,
      { body: { kind: 'database.created', database: await databaseMeta(c) }, prev: {} },
      { commandId: newId('command'), groupId, clientId: null },
    );
  }
}
