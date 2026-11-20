import { classificationRevision, requireClassificationRevision } from './governance.js';
import { AppError, type ChangeBody, type MemoryNote } from '@riosoma/contracts';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { embed } from '../ai/knowledge-calls.js';
import { rowsById, tableAccess } from '../api-v1/reads.js';
import type { AppContext } from '../app.js';
import { actorFor } from '../automations/run.js';
import type { Actor } from '../http/policy.js';
import { AccessScope } from './access.js';
import { dataStore, type DataSchemas } from './context.js';
import { cosine, embeddingKey, knowledgeSettings, memories, saveEmbedding, textDigest } from './knowledge.js';
import { loadFields, loadTable } from './metadata.js';
import { fetchPageByRid } from './physical/records.js';
import { readsLive } from '../sources/live.js';

export async function queueEmbeddings(
  db: Queryable,
  schemas: DataSchemas,
  databaseId: string,
  body: ChangeBody,
) {
  if (!/^(record|table|field)\./.test(body.kind)) return;
  const tableId =
    'tableId' in body
      ? body.tableId
      : 'table' in body
        ? body.table.id
        : 'field' in body
          ? body.field.tableId
          : null;
  const ids =
    'records' in body ? body.records.map((row) => row.id) : 'recordIds' in body ? body.recordIds : null;
  // Record edits share the worker's table lock without restarting its initial scan.
  const queued = await query<{ table_id: string }>(
    db,
    sql`SELECT table_id FROM ${ident(schemas.app, 'embedding_tables')}
    WHERE enabled AND database_id = ${databaseId} AND (${tableId}::text IS NULL OR table_id = ${tableId}) FOR UPDATE`,
  );
  if (!queued.rowCount) return;
  if (body.kind.startsWith('record.') && ids) {
    for (const row of queued.rows)
      await query(
        db,
        sql`INSERT INTO ${ident(schemas.app, 'embedding_changes')} AS pending (table_id, record_id)
        SELECT ${row.table_id}, id FROM unnest(${ids}::text[]) AS changed(id)
        ON CONFLICT (table_id, record_id) DO UPDATE
        SET generation = pending.generation + 1, queued_at = clock_timestamp()`,
      );
  } else {
    await query(
      db,
      sql`UPDATE ${ident(schemas.app, 'embedding_tables')}
      SET generation = generation + 1, cursor = 0 WHERE table_id = ANY(${queued.rows.map((row) => row.table_id)}::text[])`,
    );
  }
  await query(
    db,
    sql`DELETE FROM ${ident(schemas.app, 'embeddings')} WHERE database_id = ${databaseId}
    AND table_id IS NOT NULL AND (${tableId}::text IS NULL OR table_id = ${tableId})
    AND (${ids}::text[] IS NULL OR source_id = ANY(${ids ?? []}::text[]))`,
  );
}

export async function recall(ctx: AppContext, actor: Actor, databaseId: string, text: string) {
  const settings = await knowledgeSettings(ctx, actor);
  if (!settings.memory) return [];
  const governanceStore = dataStore(ctx);
  const revision = await classificationRevision(governanceStore.pool, governanceStore.schemas, actor.orgId);
  const access = new AccessScope(governanceStore.pool, governanceStore.schemas, actor);
  await access.require(databaseId, 'read');
  if (!access.allowsUse(databaseId, 'provider')) return [];
  const notes = await memories(ctx, actor, databaseId);
  if (!notes.length) return [];
  if (!settings.embedding) return lexicalRecall(notes, text);
  try {
    const { pool, schemas } = dataStore(ctx);
    const modelKey = embeddingKey(settings);
    const stored = await query<{ source_id: string; digest: string }>(
      pool,
      sql`SELECT source_id, digest FROM ${ident(schemas.app, 'embeddings')}
        WHERE org_id = ${actor.orgId} AND database_id = ${databaseId} AND model_key = ${modelKey}
        AND table_id IS NULL AND source_id = ANY(${notes.map((note) => note.id)}::text[])`,
    );
    const hashes = new Map(stored.rows.map((row) => [row.source_id, row.digest]));
    for (let offset = 0; offset < notes.length; offset += 16) {
      const pending = notes
        .slice(offset, offset + 16)
        .filter((note) => hashes.get(note.id) !== textDigest(note.text));
      if (!pending.length) continue;
      await requireClassificationRevision(pool, schemas, actor.orgId, revision);
      const vectors = await embed(
        ctx,
        actor,
        settings,
        pending.map((note) => note.text),
      );
      await withTransaction(pool, async (db) => {
        await new AccessScope(db, schemas, actor).require(databaseId, 'read');
        for (const [index, note] of pending.entries()) {
          const still = await query(
            db,
            sql`SELECT 1 FROM ${ident(schemas.app, 'memories')}
            WHERE id = ${note.id} AND org_id = ${actor.orgId} AND database_id = ${databaseId}
            AND text = ${note.text} AND (user_id = ${actor.userId} OR user_id IS NULL) FOR UPDATE`,
          );
          if (still.rowCount)
            await saveEmbedding(db, schemas, {
              orgId: actor.orgId,
              databaseId,
              sourceId: note.id,
              modelKey,
              digest: textDigest(note.text),
              value: vectors[index]!,
            });
        }
      });
    }
    const [vector] = await embed(ctx, actor, settings, [text.slice(0, 2000)]);
    const score = await cosine(pool, sql`e.value`, vector!);
    await new AccessScope(pool, schemas, actor).require(databaseId, 'read');
    const ranked = await query<{ id: string }>(
      pool,
      sql`SELECT m.id FROM ${ident(schemas.app, 'memories')} m
      JOIN ${ident(schemas.app, 'embeddings')} e ON e.source_id = m.id::text AND e.org_id = m.org_id AND e.database_id = m.database_id
      WHERE m.org_id = ${actor.orgId} AND m.database_id = ${databaseId} AND (m.user_id = ${actor.userId} OR m.user_id IS NULL)
        AND e.model_key = ${modelKey} AND cardinality(e.value) = ${vector!.length}
      ORDER BY ${score} DESC NULLS LAST, m.id LIMIT 8`,
    );
    const current = new Map((await memories(ctx, actor, databaseId)).map((note) => [note.id, note]));
    return ranked.rows.flatMap((row) => (current.has(row.id) ? [current.get(row.id)!] : []));
  } catch (error) {
    if (
      !(error instanceof AppError) ||
      error.code !== 'unavailable' ||
      !['knowledge.requestFailed', 'knowledge.embeddingUnavailable'].includes(error.messageKey)
    )
      throw error;
    // Re-read notes so a failed service cannot retain revoked access or deleted text.
    const current = await memories(ctx, actor, databaseId);
    return (await knowledgeSettings(ctx, actor)).memory ? lexicalRecall(current, text) : [];
  }
}

function lexicalRecall(notes: MemoryNote[], text: string) {
  const words = text
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 2);
  return notes
    .map((note) => ({
      note,
      score: words.filter((word) => note.text.toLocaleLowerCase().includes(word)).length,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ note }) => note);
}

export async function similarRecords(
  app: FastifyInstance,
  request: FastifyRequest,
  input: { tableId: string; text: string; limit: number },
) {
  let access = await tableAccess(app, request, input.tableId);
  const { pool, schemas, actor } = access;
  const settings = await knowledgeSettings(app.ctx, actor);
  if (!settings.embedding) throw new AppError('unavailable', 'knowledge.embeddingUnavailable');
  const enabled = await query(
    pool,
    sql`SELECT 1 FROM ${ident(schemas.app, 'embedding_tables')}
    WHERE org_id = ${actor.orgId} AND table_id = ${input.tableId} AND enabled`,
  );
  if (!enabled.rowCount) throw new AppError('unavailable', 'knowledge.indexDisabled');
  await access.scope.requireUse(access.table.databaseId, 'provider', { tableId: input.tableId });
  const [vector] = await embed(app.ctx, actor, settings, [input.text]);
  access = await tableAccess(app, request, input.tableId);
  const score = await cosine(pool, sql`e.value`, vector!);
  const ranked = await query<{ id: string; score: number }>(
    pool,
    sql`SELECT r.__id AS id, max(${score}) AS score FROM ${ident(schemas.app, 'embeddings')} e
      JOIN ${ident(schemas.data, input.tableId)} r ON r.__id = e.source_id
      JOIN ${ident(schemas.app, 'embedding_tables')} t ON t.table_id = e.table_id AND t.org_id = e.org_id AND t.enabled
      WHERE e.org_id = ${actor.orgId} AND e.database_id = ${access.table.databaseId} AND e.table_id = ${input.tableId}
        AND e.field_id = ANY(${access.fields.map((field) => field.id)}::text[])
        AND e.model_key = ${embeddingKey(settings)} AND cardinality(e.value) = ${vector!.length}
        AND r.__deleted_at IS NULL AND NOT r.__source_gone AND (${access.scope.recordPredicate(input.tableId, 'r')})
      GROUP BY r.__id ORDER BY score DESC NULLS LAST, r.__id LIMIT ${input.limit}`,
  );
  const rows = await rowsById(
    access,
    ranked.rows.map((row) => row.id),
  );
  const scores = new Map(ranked.rows.map((row) => [row.id, row.score]));
  return {
    tableId: input.tableId,
    fieldIds: access.fields.map((field) => field.id),
    records: rows.map((row) => ({ ...row, score: scores.get(row.id) })),
  };
}

export async function embeddingTables(ctx: AppContext, actor: Actor, databaseId: string) {
  const { pool, schemas } = dataStore(ctx);
  await new AccessScope(pool, schemas, actor).require(databaseId, 'read');
  return (
    await query<{ tableId: string; enabled: boolean; pending: boolean }>(
      pool,
      sql`SELECT table_id AS "tableId", enabled, (generation <> indexed_generation OR EXISTS (
        SELECT 1 FROM ${ident(schemas.app, 'embedding_changes')} c WHERE c.table_id = embedding_tables.table_id
      )) AS pending
      FROM ${ident(schemas.app, 'embedding_tables')} WHERE org_id = ${actor.orgId} AND database_id = ${databaseId}`,
    )
  ).rows;
}

/** Initial pages and changed records each make progress, even while a table is being edited. */
export async function indexNext(app: FastifyInstance): Promise<boolean> {
  const { pool, schemas } = dataStore(app.ctx);
  const claimed = await query<{
    table_id: string;
    org_id: string;
    database_id: string;
    user_id: string;
    generation: string;
    indexed_generation: string;
    cursor: string;
  }>(
    pool,
    sql`UPDATE ${ident(schemas.app, 'embedding_tables')} SET lease_until = clock_timestamp() + interval '90 seconds'
    WHERE table_id = (SELECT table_id FROM ${ident(schemas.app, 'embedding_tables')}
      WHERE enabled AND (generation <> indexed_generation OR EXISTS (
        SELECT 1 FROM ${ident(schemas.app, 'embedding_changes')} c WHERE c.table_id = embedding_tables.table_id
      )) AND (lease_until IS NULL OR lease_until < clock_timestamp())
      ORDER BY lease_until NULLS FIRST, table_id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
  );
  const job = claimed.rows[0];
  if (!job) return false;
  try {
    const person = await actorFor(pool, schemas, job.user_id, job.org_id);
    if (!person) return false;
    const settings = await knowledgeSettings(app.ctx, person);
    if (!settings.embedding) return false;
    const revision = await classificationRevision(pool, schemas, job.org_id);
    const scope = new AccessScope(pool, schemas, { ...person, dataUse: 'provider' });
    await scope.require(job.database_id, 'read');
    const table = await loadTable(pool, schemas, job.table_id);
    if (!table || table.trashed || readsLive(table)) return false;
    const fields = scope
      .visibleFields(job.table_id, await loadFields(pool, schemas, [job.table_id]))
      .filter((field) => ['text', 'longText', 'richText', 'url', 'email'].includes(field.type));
    const changes = await query<{ record_id: string; generation: string }>(
      pool,
      sql`
      SELECT record_id, generation FROM ${ident(schemas.app, 'embedding_changes')}
      WHERE table_id = ${job.table_id} ORDER BY queued_at, record_id LIMIT 16`,
    );
    const revisions = new Map(changes.rows.map((row) => [row.record_id, row.generation]));
    const page = await query<{ rid: number }>(
      pool,
      sql`SELECT __rid::float8 AS rid FROM ${ident(schemas.data, job.table_id)}
      WHERE ${job.generation !== job.indexed_generation} AND __rid > ${job.cursor}::bigint AND __deleted_at IS NULL AND NOT __source_gone
        AND (${scope.recordPredicate(job.table_id)}) ORDER BY __rid LIMIT 16`,
    );
    const changed = await query<{ rid: number }>(
      pool,
      sql`
      SELECT __rid::float8 AS rid FROM ${ident(schemas.data, job.table_id)}
      WHERE __id = ANY(${changes.rows.map((row) => row.record_id)}::text[])
        AND __deleted_at IS NULL AND NOT __source_gone AND (${scope.recordPredicate(job.table_id)})`,
    );
    const rows = await fetchPageByRid(
      pool,
      schemas.data,
      job.table_id,
      fields,
      [...new Set([...page.rows, ...changed.rows].map((row) => row.rid))],
      scope.recordPredicate(job.table_id),
    );
    const modelKey = embeddingKey(settings);
    const saved = await query<{ source_id: string; field_id: string; digest: string }>(
      pool,
      sql`SELECT source_id, field_id, digest FROM ${ident(schemas.app, 'embeddings')}
        WHERE org_id = ${job.org_id} AND table_id = ${job.table_id} AND model_key = ${modelKey}
          AND source_id = ANY(${rows.flatMap((row) => (row ? [row.id] : []))}::text[])`,
    );
    const hashes = new Map(saved.rows.map((row) => [`${row.source_id}:${row.field_id}`, row.digest]));
    const cells = rows.flatMap((row) =>
      row
        ? fields.flatMap((field) => {
            const value = row.values[field.id];
            const text = typeof value === 'string' ? value.slice(0, 3000).trim() : '';
            const digest = textDigest(text);
            return text && hashes.get(`${row.id}:${field.id}`) !== digest
              ? [{ sourceId: row.id, fieldId: field.id, text, digest }]
              : [];
          })
        : [],
    );
    const prepared: Array<{
      sourceId: string;
      fieldId: string;
      text: string;
      digest: string;
      value: number[];
    }> = [];
    for (let offset = 0; offset < cells.length; offset += 16) {
      const batch = cells.slice(offset, offset + 16);
      await requireClassificationRevision(pool, schemas, job.org_id, revision);
      const vectors = await embed(
        app.ctx,
        person,
        settings,
        batch.map((cell) => cell.text),
      );
      prepared.push(...batch.map((cell, index) => ({ ...cell, value: vectors[index]! })));
    }
    await withTransaction(pool, async (db) => {
      const current = await query(
        db,
        sql`SELECT 1 FROM ${ident(schemas.app, 'embedding_tables')}
        WHERE table_id = ${job.table_id} AND enabled AND generation = ${job.generation}::bigint FOR UPDATE`,
      );
      if (!current.rowCount) return;
      const latest = await query<{ record_id: string; generation: string }>(
        db,
        sql`
        SELECT record_id, generation FROM ${ident(schemas.app, 'embedding_changes')}
        WHERE table_id = ${job.table_id} AND record_id = ANY(${prepared.map((cell) => cell.sourceId)}::text[])`,
      );
      const currentRevisions = new Map(latest.rows.map((row) => [row.record_id, row.generation]));
      for (const cell of prepared) {
        // Changes during the request stay queued and must never publish an old vector.
        if (currentRevisions.get(cell.sourceId) !== revisions.get(cell.sourceId)) continue;
        await saveEmbedding(db, schemas, {
          ...cell,
          orgId: job.org_id,
          databaseId: job.database_id,
          tableId: job.table_id,
          modelKey,
        });
      }
      for (const change of changes.rows)
        await query(
          db,
          sql`DELETE FROM ${ident(schemas.app, 'embedding_changes')}
          WHERE table_id = ${job.table_id} AND record_id = ${change.record_id} AND generation = ${change.generation}::bigint`,
        );
      await query(
        db,
        sql`UPDATE ${ident(schemas.app, 'embedding_tables')} SET
        cursor = ${page.rows.at(-1)?.rid ?? job.cursor}, indexed_generation = CASE WHEN ${page.rows.length < 16} THEN generation ELSE indexed_generation END
        WHERE table_id = ${job.table_id}`,
      );
    });
    return true;
  } finally {
    await query(
      pool,
      sql`UPDATE ${ident(schemas.app, 'embedding_tables')}
      SET lease_until = clock_timestamp() + interval '5 seconds' WHERE table_id = ${job.table_id}`,
    );
  }
}

export function installEmbeddings(app: FastifyInstance) {
  const every = app.ctx.config.embeddingsPollMs ?? 10000;
  if (every <= 0) return;
  let active: Promise<unknown> | undefined;
  const timer = setInterval(() => {
    if (active || !app.ctx.pool) return;
    active = indexNext(app)
      .catch(() => undefined)
      .finally(() => {
        active = undefined;
      });
  }, every);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await active;
  });
}
