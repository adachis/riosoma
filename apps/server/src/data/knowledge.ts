import { createHash } from 'node:crypto';
import { AppError, KnowledgeSettings, type MemoryNote } from '@riosoma/contracts';
import { ident, query, sql, type Queryable, type Sql } from '@riosoma/db';
import type { AppContext } from '../app.js';
import type { Actor } from '../http/policy.js';
import { AccessScope } from './access.js';
import { dataStore, type DataSchemas } from './context.js';

export async function readKnowledgeSettings(db: Queryable, schemas: DataSchemas, actor: Actor) {
  await new AccessScope(db, schemas, actor).requireOrganization();
  const rows = await query<{ settings: unknown }>(
    db,
    sql`SELECT settings FROM ${ident(schemas.app, 'knowledge_settings')} WHERE org_id = ${actor.orgId}`,
  );
  return KnowledgeSettings.parse(rows.rows[0]?.settings ?? {});
}

export async function knowledgeSettings(ctx: AppContext, actor: Actor) {
  const { pool, schemas } = dataStore(ctx);
  const settings = await readKnowledgeSettings(pool, schemas, actor);
  if (settings.search.engine === 'searxng' && settings.search.address === null && ctx.config.searchUrl)
    settings.search.address = ctx.config.searchUrl;
  return settings;
}

export async function memories(
  ctx: AppContext,
  actor: Actor,
  databaseId: string,
  visibility?: 'personal' | 'database',
): Promise<MemoryNote[]> {
  const { pool, schemas } = dataStore(ctx);
  await new AccessScope(pool, schemas, actor).require(databaseId, 'read');
  const rows = await query<{
    id: string;
    text: string;
    user_id: string | null;
    remote_data_blocked: boolean;
    updated_at: Date;
  }>(
    pool,
    sql`SELECT id, text, user_id, remote_data_blocked, updated_at FROM ${ident(schemas.app, 'memories')}
      WHERE org_id = ${actor.orgId} AND database_id = ${databaseId}
      AND (user_id = ${actor.userId} OR user_id IS NULL)
      AND (${visibility ?? null}::text IS NULL OR (${visibility === 'personal'} AND user_id = ${actor.userId})
        OR (${visibility === 'database'} AND user_id IS NULL))
      ORDER BY updated_at DESC, id LIMIT 500`,
  );
  return rows.rows.map((row) => ({
    id: row.id,
    databaseId,
    text: row.text,
    ...(row.remote_data_blocked ? { remoteDataBlocked: true } : {}),
    visibility: row.user_id === null ? 'database' : 'personal',
    updatedAt: row.updated_at.toISOString(),
  }));
}

export const textDigest = (text: string) => createHash('sha256').update(text).digest('hex');
export const embeddingKey = (settings: KnowledgeSettings) => textDigest(JSON.stringify(settings.embedding));

/** The extension is optional, and may have been installed into a nondefault schema. */
export async function cosine(db: Queryable, value: Sql, vector: number[]): Promise<Sql> {
  const extension = await query<{ schema: string }>(
    db,
    sql`SELECT n.nspname AS schema
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector'`,
  );
  const schema = extension.rows[0]?.schema;
  if (schema)
    return sql`1 - (${value}::real[]::${ident(schema, 'vector')}
    OPERATOR(${ident(schema)}.<=>) ${vector}::real[]::${ident(schema, 'vector')})`;
  return sql`(SELECT sum(a * b) / NULLIF(sqrt(sum(a * a)) * sqrt(sum(b * b)), 0)
    FROM unnest(${value}, ${vector}::float8[]) AS parts(a, b))`;
}

export async function saveEmbedding(
  db: Queryable,
  schemas: DataSchemas,
  input: {
    orgId: string;
    databaseId: string;
    sourceId: string;
    fieldId?: string;
    tableId?: string;
    modelKey: string;
    digest: string;
    value: number[];
  },
) {
  await query(
    db,
    sql`INSERT INTO ${ident(schemas.app, 'embeddings')}
    (org_id, database_id, source_id, field_id, table_id, model_key, digest, value)
    VALUES (${input.orgId}, ${input.databaseId}, ${input.sourceId}, ${input.fieldId ?? ''},
      ${input.tableId ?? null}, ${input.modelKey}, ${input.digest}, ${input.value}::float8[])
    ON CONFLICT (org_id, database_id, source_id, field_id) DO UPDATE
      SET model_key = EXCLUDED.model_key, digest = EXCLUDED.digest, value = EXCLUDED.value`,
  );
}

export async function requireMemoryEnabled(ctx: AppContext, actor: Actor) {
  const settings = await knowledgeSettings(ctx, actor);
  if (!settings.memory) throw new AppError('forbidden', 'knowledge.memoryDisabled');
  return settings;
}
