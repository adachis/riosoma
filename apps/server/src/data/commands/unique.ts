import { AppError, FieldSpec, type Command } from '@riosoma/contracts';
import type { FastifyInstance } from 'fastify';
import { ident, query, sql } from '@riosoma/db';
import type { Actor } from '../../http/policy.js';
import { AccessScope } from '../access.js';
import { dataStore } from '../context.js';
import { loadField, loadTable } from '../metadata.js';
import {
  buildUniqueIndex,
  duplicatesError,
  isUnique,
  uniqueDuplicates,
  uniqueIndexName,
} from '../physical/unique.js';
import { parse } from '../../http/validate.js';

/** Prepare committed constraints before an atomic plan starts its transaction. */
export async function withPreparedUnique<T>(
  app: FastifyInstance,
  actor: Actor,
  databaseId: string,
  commands: Command[],
  work: () => Promise<T>,
): Promise<T> {
  const candidates = new Map<string, Command>();
  for (const command of commands)
    if (command.kind === 'field.update' && command.options?.unique === true)
      candidates.set(`${command.fieldId}:${command.options.uniqueCaseInsensitive === true}`, command);
  const prepared: Array<{ finish(): Promise<void> }> = [];
  const names = new Set<string>();
  try {
    // A stable order avoids two plans waiting for each other's field preparation locks.
    for (const [, command] of [...candidates].sort(([left], [right]) => left.localeCompare(right))) {
      const preparation = await prepareUnique(app, actor, databaseId, command, names);
      if (preparation) {
        prepared.push(preparation);
        if (preparation.error) throw preparation.error;
      }
    }
    return await work();
  } finally {
    for (const preparation of prepared.reverse()) await preparation.finish();
  }
}

/** Existing columns build outside a transaction, before their rule becomes visible. */
export async function prepareUnique(
  app: FastifyInstance,
  actor: Actor,
  databaseId: string,
  input: unknown,
  prepared?: Set<string>,
): Promise<{ error?: AppError; finish(): Promise<void> } | undefined> {
  if (
    !input ||
    typeof input !== 'object' ||
    !('kind' in input) ||
    input.kind !== 'field.update' ||
    !('fieldId' in input) ||
    typeof input.fieldId !== 'string' ||
    !('options' in input)
  )
    return;
  const { pool, schemas } = dataStore(app.ctx);
  const scope = new AccessScope(pool, schemas, actor);
  await scope.require(databaseId, 'editSchema');
  const before = await loadField(pool, schemas, input.fieldId);
  if (!before || before.trashed) return;
  const parent = await loadTable(pool, schemas, before.tableId);
  if (
    !parent ||
    parent.databaseId !== databaseId ||
    parent.trashed ||
    !scope.visibleFields(before.tableId, [before]).length
  )
    return;
  const field = { ...before, ...parse(FieldSpec, { type: before.type, options: input.options }) };
  if (!isUnique(field)) return;
  if (field.source)
    return {
      error: new AppError('validation_failed', 'data.validation.uniqueSource'),
      finish: async () => {},
    };
  const name = uniqueIndexName(field);
  if (prepared?.has(name)) return;
  prepared?.add(name);
  const client = await pool.connect();
  let error: AppError | undefined;
  try {
    await query(client, sql`SELECT pg_advisory_lock(hashtextextended(${`${schemas.app}:${name}`}, 0))`);
    // Restricted records must never appear in a duplicate report.
    if (scope.limitsRecords(field.tableId)) throw new AppError('forbidden', 'data.access.recordHidden');
    const duplicates = await uniqueDuplicates(client, schemas, field);
    if (duplicates.length) throw duplicatesError(field, databaseId, duplicates);
    try {
      await buildUniqueIndex(client, schemas, field, true);
    } catch (cause) {
      if (cause && typeof cause === 'object' && 'code' in cause && cause.code === '23505')
        throw duplicatesError(field, databaseId, await uniqueDuplicates(client, schemas, field));
      throw cause;
    }
  } catch (cause) {
    if (cause instanceof AppError) error = cause;
    else {
      await query(
        client,
        sql`SELECT pg_advisory_unlock(hashtextextended(${`${schemas.app}:${name}`}, 0))`,
      ).catch(() => undefined);
      client.release();
      throw cause;
    }
  }
  return {
    ...(error ? { error } : {}),
    async finish() {
      try {
        const current = await loadField(client, schemas, field.id);
        if (!current || !isUnique(current) || uniqueIndexName(current) !== name)
          await query(client, sql`DROP INDEX CONCURRENTLY IF EXISTS ${ident(schemas.data, name)}`);
      } finally {
        await query(
          client,
          sql`SELECT pg_advisory_unlock(hashtextextended(${`${schemas.app}:${name}`}, 0))`,
        ).catch(() => undefined);
        client.release();
      }
    },
  };
}
