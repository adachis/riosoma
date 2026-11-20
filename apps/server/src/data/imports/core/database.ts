import { CHOICE_COLORS, newId } from '@riosoma/contracts';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import type { Actor } from '../../../http/policy.js';
import { databaseMeta, type CommandContext } from '../../commands/context.js';
import { ensureGroup, lock, LONG_DEADLINES, recordChange, retry } from '../../commands/transaction.js';
import { dataStore } from '../../context.js';
import { Writer } from './writer.js';

/**
 * Makes the database an import fills, owned by the person who started it, as the first step of
 * the one action the whole import is in its history.  Its color follows the source's ID, so the
 * same base comes across in the same color.  `link` tells the import its database in the same
 * transaction, so nothing it makes is lost track of.
 */
export async function createImportDatabase(
  app: FastifyInstance,
  actor: Actor,
  options: { name: string; seed: string; link(db: Queryable, databaseId: string): Promise<void> },
): Promise<Writer> {
  const { pool, schemas } = dataStore(app.ctx);
  const databaseId = newId('database');
  const groupId = newId('action');
  const colors = CHOICE_COLORS.filter((color) => color !== 'gray');
  const color = colors[[...options.seed].reduce((sum, char) => sum + char.charCodeAt(0), 0) % colors.length]!;
  await retry(() =>
    withTransaction(
      pool,
      async (db) => {
        const c: CommandContext = { secretKey: app.ctx.config.secretKey, db, schemas, actor, databaseId };
        await lock(c, [`database:${databaseId}`]);
        await query(
          db,
          sql`INSERT INTO ${ident(schemas.app, 'databases')} (id, org_id, name, icon, color, created_by)
          VALUES (${databaseId}, ${actor.orgId}, ${options.name}, ${null}, ${color}, ${actor.userId})`,
        );
        await query(
          db,
          sql`INSERT INTO ${ident(schemas.app, 'grants')}
          (org_id, resource_kind, resource_id, principal_kind, principal_id, role, created_by)
          VALUES (${actor.orgId}, 'database', ${databaseId}, 'user', ${actor.userId}, 'owner', ${actor.userId})`,
        );
        await ensureGroup(c, groupId);
        await recordChange(
          c,
          { body: { kind: 'database.created', database: await databaseMeta(c) }, prev: {} },
          { commandId: newId('command'), groupId, clientId: null },
        );
        await options.link(db, databaseId);
      },
      LONG_DEADLINES,
    ),
  );
  return new Writer(app, actor, databaseId, groupId);
}
