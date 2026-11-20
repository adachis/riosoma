import type { NamedFunctionMeta } from '@riosoma/contracts';
import { ident, query, sql, type Queryable, type Sql } from '@riosoma/db';
import type { AccessScope } from './access.js';
import type { DataSchemas } from './context.js';
import type { Ast } from '@riosoma/formula';

export function functionCalls(ast: Ast): string[] {
  if (ast.kind === 'call') return [ast.name.toUpperCase(), ...ast.args.flatMap(functionCalls)];
  if (ast.kind === 'binary') return [...functionCalls(ast.left), ...functionCalls(ast.right)];
  return ast.kind === 'unary' ? functionCalls(ast.operand) : [];
}

async function definitions(db: Queryable, schemas: DataSchemas, where: Sql): Promise<NamedFunctionMeta[]> {
  const result = await query<
    Omit<NamedFunctionMeta, 'createdAt' | 'updatedAt'> & { createdAt: Date; updatedAt: Date }
  >(
    db,
    sql`
    SELECT id, database_id AS "databaseId", name, parameters, body, description,
      created_by AS "createdBy", updated_by AS "updatedBy", created_at AS "createdAt",
      updated_at AS "updatedAt", revision
    FROM ${ident(schemas.app, 'named_functions')} WHERE ${where} ORDER BY lower(name), id`,
  );
  return result.rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export async function readNamedFunctions(
  db: Queryable,
  schemas: DataSchemas,
  databaseId: string,
  scope: AccessScope,
  options: { includeTrashed?: boolean; organizationArchive?: boolean } = {},
): Promise<NamedFunctionMeta[]> {
  if (options.organizationArchive) await scope.requireOrganizationAdmin('ai', true);
  else await scope.require(databaseId, 'read', options);
  return definitions(
    db,
    schemas,
    sql`database_id = ${databaseId} AND database_id IN
      (SELECT id FROM ${ident(schemas.app, 'databases')} WHERE org_id = ${scope.actor.orgId})`,
  );
}

/** Internal execution metadata, also needed while AccessScope prepares field dependencies. */
export async function namedFunctionsForTables(
  db: Queryable,
  schemas: DataSchemas,
  tableIds: readonly string[],
): Promise<NamedFunctionMeta[]> {
  return definitions(
    db,
    schemas,
    sql`database_id IN (SELECT database_id FROM ${ident(schemas.app, 'tables')} WHERE id = ANY(${tableIds}::text[]))`,
  );
}
