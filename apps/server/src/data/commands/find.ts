import { prepareJoinedRead } from '../../sources/joined-live.js';
import { LiveReads, liveRead, readsLive } from '../../sources/live.js';
import {
  FilterGroup,
  isGroup,
  operatorsForField,
  checkCondition,
  TableId,
  AppError,
  GridConfig,
  RowsQuery,
  ViewMeta,
  newId,
  type RowData,
} from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../../http/policy.js';
import { AccessScope } from '../access.js';
import { dataStore } from '../context.js';
import { loadFields, loadTable } from '../metadata.js';
import { compileFilter } from '../physical/filters.js';
import { joinedInputs } from '../physical/joined.js';
import { fetchPageByRid } from '../physical/records.js';

const Find = z.object({
  tableId: TableId,
  filter: FilterGroup.nullable().default(null),
  limit: z.number().int().min(1).max(100).default(20),
});

/** Reads share the command boundary's actor and scope without producing a record mutation */
export async function findRecords(
  app: FastifyInstance,
  actor: Actor,
  databaseId: string,
  input: unknown,
  transaction?: Queryable,
  simulation?: { rid(): number },
) {
  const args = Find.parse(input);
  const { pool, schemas } = dataStore(app.ctx);
  const db = transaction ?? pool;
  const scope = new AccessScope(db, schemas, actor);
  await scope.require(databaseId, 'read');
  const table = await loadTable(db, schemas, args.tableId);
  if (!table || table.trashed || table.databaseId !== databaseId)
    throw new AppError('not_found', 'errors.notFound');
  if (transaction && table.joined) {
    const waiting = joinedInputs(table.joined);
    const seen = new Set<string>();
    while (waiting.length) {
      const id = waiting.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const input = await loadTable(db, schemas, id);
      if (input && readsLive(input)) throw new AppError('unavailable', 'automations.find.liveJoin');
      if (input?.joined) waiting.push(...joinedInputs(input.joined));
    }
  }
  await prepareJoinedRead(app.ctx, scope, table, { readOnly: Boolean(transaction) });
  const fields = scope.visibleFields(table.id, await loadFields(db, schemas, [table.id]));
  const byId = new Map(fields.map((field) => [field.id, field]));
  const check = (group: FilterGroup) => {
    for (const part of group.conditions) {
      if (isGroup(part)) check(part);
      else {
        const field = byId.get(part.fieldId);
        if (
          !field ||
          !operatorsForField(field).includes(part.operator) ||
          !checkCondition(field, part).usable
        )
          throw new AppError('validation_failed', 'errors.validationFailed');
      }
    }
  };
  if (args.filter) check(args.filter);
  const context = { now: new Date(), timeZone: 'UTC', natural: false };
  if (readsLive(table)) {
    const live = new LiveReads(
      app.ctx,
      8 * 1024 * 1024,
      app.log,
      transaction && simulation ? { db, schemas, actor, databaseId, scope, simulation } : undefined,
    );
    const view = ViewMeta.parse({
      id: newId('view'),
      tableId: table.id,
      name: table.name,
      type: 'grid',
      config: GridConfig.parse({ filter: args.filter }),
      position: 0,
      createdBy: actor.userId,
      createdAt: '',
      updatedAt: '',
    });
    const read = await liveRead(
      app.ctx,
      {
        table,
        view,
        fields,
        predicate: scope.recordPredicate(table.id),
        access: scope.accessKey(table.id),
        context,
      },
      scope,
    );
    if (transaction) read.allFields = await loadFields(db, schemas, [table.id]);
    const page = await live.page(read, RowsQuery.parse({ offset: 0, limit: args.limit, refresh: '1' }));
    if (page.live?.skipped.some((part) => part.part === 'filter'))
      throw new AppError('validation_failed', 'sources.filterUnsupported');
    return page.rows.filter((row): row is RowData => row !== null);
  }
  const found = await query<{ __rid: string }>(
    db,
    sql`
    SELECT __rid FROM ${ident(schemas.data, table.id)}
    WHERE __deleted_at IS NULL AND NOT __source_gone AND (${scope.recordPredicate(table.id)})
      AND ${compileFilter(args.filter, byId, context, schemas.app)}
    ORDER BY __rid LIMIT ${args.limit}`,
  );
  return fetchPageByRid(
    db,
    schemas.data,
    table.id,
    fields,
    found.rows.map((row) => Number(row.__rid)),
    scope.recordPredicate(table.id),
    context,
  );
}
