import { AppError, type Command } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { missing, type CommandContext, type Mutation } from '../data/commands/context.js';
import { loadScript, scriptMeta, type StoredScript } from './store.js';

type ScriptCommand = Extract<Command, { kind: `script.${string}` }>;

/** A script of the command's database, including trashed ones only when asked. */
export async function storedScript(
  c: CommandContext,
  id: string,
  includeTrashed = false,
): Promise<StoredScript> {
  const value = await loadScript(c.db, c.schemas, id);
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
 * The five script commands.  They need the right to change the database's schema, which the
 * command bus checks before calling here, and they undo, broadcast, and go to the trash like
 * interfaces.  Running a script isn't a command: it's the panel's socket, and only the run's
 * writes go through the bus.
 */
export async function applyScripts(c: CommandContext, command: ScriptCommand): Promise<Mutation> {
  const table = ident(c.schemas.app, 'scripts');
  switch (command.kind) {
    case 'script.create': {
      const input = command.script;
      const existing = await query(c.db, sql`SELECT id FROM ${table} WHERE id = ${input.id}`);
      if (existing.rowCount) throw new AppError('conflict', 'errors.conflict');
      await query(
        c.db,
        sql`INSERT INTO ${table} (id, org_id, database_id, name, description, source, position, created_by)
        VALUES (${input.id}, ${c.actor.orgId}, ${c.databaseId}, ${input.name}, ${input.description},
          ${input.source},
          ${command.position ?? sql`(SELECT COALESCE(max(position), -1) + 1 FROM ${table} WHERE database_id = ${c.databaseId})`},
          ${c.actor.userId})`,
      );
      return {
        body: { kind: 'script.created', script: scriptMeta(await storedScript(c, input.id)) },
        prev: {},
      };
    }
    case 'script.update':
    case 'script.move': {
      const before = await storedScript(c, command.scriptId);
      const update = command.kind === 'script.update' ? command : null;
      const position = command.kind === 'script.move' ? command.position : before.position;
      await query(
        c.db,
        sql`UPDATE ${table} SET name = ${update?.name ?? before.name},
        description = ${update?.description ?? before.description}, source = ${update?.source ?? before.source},
        position = ${position}, updated_at = statement_timestamp() WHERE id = ${before.id}`,
      );
      return {
        body: { kind: 'script.updated', script: scriptMeta(await storedScript(c, before.id)) },
        prev: { script: scriptMeta(before) },
      };
    }
    case 'script.trash':
    case 'script.restore': {
      const before = await storedScript(c, command.scriptId, true);
      const trash = command.kind === 'script.trash';
      await query(
        c.db,
        sql`UPDATE ${table} SET
        trashed_at = CASE WHEN ${trash} THEN statement_timestamp() ELSE NULL END,
        trashed_by = ${trash ? c.actor.userId : null}, updated_at = statement_timestamp()
        WHERE id = ${before.id}`,
      );
      return {
        body: trash
          ? { kind: 'script.trashed', scriptId: before.id }
          : { kind: 'script.restored', script: scriptMeta(await storedScript(c, before.id)) },
        prev: { trashed: before.trashed },
      };
    }
  }
}
