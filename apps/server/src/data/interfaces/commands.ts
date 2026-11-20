import { AppError, type Command } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { missing, scopeOf, type CommandContext, type Mutation } from '../commands/context.js';
import { guardConfig } from '../permissions/config-guard.js';
import { validateInterfacePages } from './config.js';
import { interfaceMeta, loadInterface, type StoredInterface } from './store.js';

type InterfaceCommand = Extract<Command, { kind: `interface.${string}` }>;

/** An interface of the command's database, including trashed ones only when asked. */
export async function storedInterface(
  c: CommandContext,
  id: string,
  includeTrashed = false,
): Promise<StoredInterface> {
  const value = await loadInterface(c.db, c.schemas, id);
  if (
    !value ||
    value.databaseId !== c.databaseId ||
    value.orgId !== c.actor.orgId ||
    (!includeTrashed && value.trashed)
  )
    return missing();
  return value;
}

/**
 * The five interface commands.  They need the right to change the database's schema, which the
 * command bus checks before calling here, and they undo, broadcast, and go to the trash like
 * dashboards.
 */
export async function applyInterfaces(c: CommandContext, command: InterfaceCommand): Promise<Mutation> {
  const table = ident(c.schemas.app, 'interfaces');
  switch (command.kind) {
    case 'interface.create': {
      const input = command.interface;
      guardConfig((await scopeOf(c)).hiddenFieldIds(c.databaseId), null, input.pages);
      const existing = await query(c.db, sql`SELECT id FROM ${table} WHERE id = ${input.id}`);
      if (existing.rowCount) throw new AppError('conflict', 'errors.conflict');
      await validateInterfacePages(c, input.pages, null);
      await query(
        c.db,
        sql`INSERT INTO ${table} (id, org_id, database_id, name, position, pages, created_by)
        VALUES (${input.id}, ${c.actor.orgId}, ${c.databaseId}, ${input.name},
          ${command.position ?? sql`(SELECT COALESCE(max(position), -1) + 1 FROM ${table} WHERE database_id = ${c.databaseId})`},
          ${JSON.stringify(input.pages)}::jsonb, ${c.actor.userId})`,
      );
      return {
        body: { kind: 'interface.created', interface: interfaceMeta(await storedInterface(c, input.id)) },
        prev: {},
      };
    }
    case 'interface.update':
    case 'interface.move': {
      const before = await storedInterface(c, command.interfaceId);
      let update = command.kind === 'interface.update' ? command : null;
      if (update?.pages)
        update = {
          ...update,
          pages: guardConfig((await scopeOf(c)).hiddenFieldIds(c.databaseId), before.pages, update.pages),
        };
      // Only new pages are checked, so renaming never trips over an old block.
      if (update?.pages) await validateInterfacePages(c, update.pages, before.pages);
      const name = update?.name ?? before.name;
      const pages = update?.pages ?? before.pages;
      const position = command.kind === 'interface.move' ? command.position : before.position;
      await query(
        c.db,
        sql`UPDATE ${table} SET name = ${name}, pages = ${JSON.stringify(pages)}::jsonb,
        position = ${position}, updated_at = statement_timestamp() WHERE id = ${before.id}`,
      );
      return {
        body: { kind: 'interface.updated', interface: interfaceMeta(await storedInterface(c, before.id)) },
        prev: { interface: interfaceMeta(before) },
      };
    }
    case 'interface.trash':
    case 'interface.restore': {
      const before = await storedInterface(c, command.interfaceId, true);
      const trash = command.kind === 'interface.trash';
      await query(
        c.db,
        sql`UPDATE ${table} SET
        trashed_at = CASE WHEN ${trash} THEN statement_timestamp() ELSE NULL END,
        trashed_by = ${trash ? c.actor.userId : null}, updated_at = statement_timestamp()
        WHERE id = ${before.id}`,
      );
      return {
        body: trash
          ? { kind: 'interface.trashed', interfaceId: before.id }
          : { kind: 'interface.restored', interface: interfaceMeta(await storedInterface(c, before.id)) },
        prev: { trashed: before.trashed },
      };
    }
  }
}
