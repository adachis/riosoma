import {
  AppError,
  newId,
  type TableCreate,
  type JoinedTable,
  type FieldCreate,
  type ColumnSuggestionsRequest,
} from '@riosoma/contracts';
import { withTransaction } from '@riosoma/db';
import { suggestColumns } from './column-mappings.js';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import type { Actor } from '../http/policy.js';
import { syncHistory } from '../sources/history.js';
import { AccessScope } from './access.js';
import { runCommands } from './commands/index.js';
import { dataStore } from './context.js';
import { loadTable } from './metadata.js';

export function readSyncHistory(ctx: AppContext, actor: Actor, tableId: string, cursor?: string) {
  const { pool, schemas } = dataStore(ctx);
  return syncHistory(pool, schemas, new AccessScope(pool, schemas, actor), tableId, cursor);
}

/**
 * The table's database, once the person may read it.  Asking first keeps a table out of reach
 * answering exactly as one that isn't there, so an ID never says whether it exists.
 */
async function reachable(ctx: AppContext, actor: Actor, tableId: string): Promise<string> {
  const { pool, schemas } = dataStore(ctx);
  const table = await loadTable(pool, schemas, tableId);
  if (!table || table.trashed) throw new AppError('not_found', 'errors.notFound');
  await new AccessScope(pool, schemas, actor).require(table.databaseId, 'read');
  return table.databaseId;
}

export async function createJoinedTable(
  app: FastifyInstance,
  actor: Actor,
  databaseId: string,
  table: TableCreate,
) {
  if (!table.joined) throw new AppError('validation_failed', 'joined.invalid');
  return runCommands(app, actor, databaseId, {
    clientId: newId('client'),
    commands: [
      {
        id: newId('command'),
        groupId: newId('action'),
        kind: 'table.create',
        table,
      },
    ],
  });
}

export async function configureOverrides(
  app: FastifyInstance,
  actor: Actor,
  tableId: string,
  settings: { allowComputedOverrides?: boolean; historyRetentionDays?: number },
) {
  const databaseId = await reachable(app.ctx, actor, tableId);
  return runCommands(app, actor, databaseId, {
    clientId: newId('client'),
    commands: [
      {
        id: newId('command'),
        groupId: newId('action'),
        kind: 'table.update',
        tableId,
        ...settings,
      },
    ],
  });
}

export async function clearPins(
  app: FastifyInstance,
  actor: Actor,
  tableId: string,
  records: Array<{ id: string; fieldIds: string[] }>,
) {
  const databaseId = await reachable(app.ctx, actor, tableId);
  return runCommands(app, actor, databaseId, {
    clientId: newId('client'),
    commands: [
      {
        id: newId('command'),
        groupId: newId('action'),
        kind: 'record.clearOverrides',
        tableId,
        records,
      },
    ],
  });
}

export async function readColumnSuggestions(
  ctx: AppContext,
  actor: Actor,
  databaseId: string,
  input: ColumnSuggestionsRequest,
) {
  const { pool, schemas } = dataStore(ctx);
  return withTransaction(pool, async (db) => {
    const scope = new AccessScope(db, schemas, actor);
    await scope.require(databaseId, 'editSchema');
    return suggestColumns(db, schemas, scope, databaseId, input);
  });
}
export async function configureJoinedColumns(
  app: FastifyInstance,
  actor: Actor,
  tableId: string,
  joined: JoinedTable,
  joinedFields?: FieldCreate[],
) {
  const databaseId = await reachable(app.ctx, actor, tableId);
  return runCommands(app, actor, databaseId, {
    clientId: newId('client'),
    commands: [
      {
        id: newId('command'),
        groupId: newId('action'),
        kind: 'table.update',
        tableId,
        joined,
        joinedFields,
      },
    ],
  });
}
