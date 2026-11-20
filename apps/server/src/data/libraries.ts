import {
  AppError,
  type KnowledgeLibrary,
  type KnowledgeDocument,
  type KnowledgePassage,
  type LibraryScope,
  type KnowledgeSettings,
} from '@riosoma/contracts';
import { providerFor } from '@riosoma/ai';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { AppContext } from '../app.js';
import type { Actor } from '../http/policy.js';
import { embed } from '../ai/knowledge-calls.js';
import { settingsFor } from '../ai/settings.js';
import { zoneFor } from '../ai/footprint.js';
import { AccessScope } from './access.js';
import { dataStore, type DataSchemas } from './context.js';
import { cosine, embeddingKey, knowledgeSettings } from './knowledge.js';
import { recordKnowledgeUse } from './knowledge-usage.js';

export type LibraryRow = {
  id: string;
  org_id: string;
  scope: LibraryScope['kind'];
  target: string;
  name: string;
  description: string;
  label: KnowledgeLibrary['label'];
  guidance: string;
};
export const libraryTarget = (scope: LibraryScope, actor: Actor) =>
  scope.kind === 'database'
    ? scope.databaseId
    : scope.kind === 'unit'
      ? scope.unitId
      : scope.kind === 'personal'
        ? actor.userId
        : actor.orgId;
export const libraryScope = (row: LibraryRow): LibraryScope =>
  row.scope === 'database'
    ? { kind: row.scope, databaseId: row.target }
    : row.scope === 'unit'
      ? { kind: row.scope, unitId: row.target }
      : { kind: row.scope };

/** Classification labels from the loosest to the strictest. */
const LABEL_RANK: Record<KnowledgeLibrary['label'], number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

/** The stricter of two classification labels, so merging never loosens a live library. */
export function stricterLabel(
  left: KnowledgeLibrary['label'],
  right: KnowledgeLibrary['label'],
): KnowledgeLibrary['label'] {
  return LABEL_RANK[left] >= LABEL_RANK[right] ? left : right;
}

export async function requireLibrary(
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  id: string,
  manage = false,
) {
  const scope = new AccessScope(db, schemas, actor);
  await scope.requireOrganization();
  const result = await query<LibraryRow>(
    db,
    sql`SELECT id, org_id, scope, target, name, description, label, guidance FROM ${ident(schemas.app, 'knowledge_libraries')} WHERE id = ${id} AND org_id = ${actor.orgId}`,
  );
  const row = result.rows[0];
  if (!row || (row.scope === 'personal' && row.target !== actor.userId))
    throw new AppError('not_found', 'errors.notFound');
  await scope.requireLibraryScope(libraryScope(row), manage);
  return row;
}

export async function libraries(ctx: AppContext, actor: Actor): Promise<KnowledgeLibrary[]> {
  const { pool, schemas } = dataStore(ctx);
  const access = new AccessScope(pool, schemas, actor);
  await access.requireOrganization();
  const rows = await query<LibraryRow>(
    pool,
    sql`SELECT id, org_id, scope, target, name, description, label, guidance FROM ${ident(schemas.app, 'knowledge_libraries')} WHERE org_id = ${actor.orgId} AND (scope <> 'personal' OR target = ${actor.userId}) ORDER BY name, id`,
  );
  const visible: KnowledgeLibrary[] = [];
  for (const row of rows.rows) {
    try {
      await access.requireLibraryScope(libraryScope(row));
    } catch (error) {
      if (error instanceof AppError && error.userFault) continue;
      throw error;
    }
    let canManage = true;
    try {
      await access.requireLibraryScope(libraryScope(row), true);
    } catch (error) {
      if (!(error instanceof AppError && error.userFault)) throw error;
      canManage = false;
    }
    visible.push({
      id: row.id,
      scope: libraryScope(row),
      name: row.name,
      description: row.description,
      label: row.label,
      guidance: row.guidance,
      canManage,
    });
  }
  return visible;
}

export async function libraryDocuments(
  ctx: AppContext,
  actor: Actor,
  libraryId: string,
): Promise<KnowledgeDocument[]> {
  const { pool, schemas } = dataStore(ctx);
  const library = await requireLibrary(pool, schemas, actor, libraryId);
  const settings = await knowledgeSettings(ctx, actor);
  const permitted = libraryAllows(library.label, settings, settings.embedding?.providerId);
  const rows = await query<{
    id: string;
    name: string;
    size: number;
    status: KnowledgeDocument['status'];
    error_key: string | null;
    model_key: string | null;
    updated_at: Date;
  }>(
    pool,
    sql`SELECT id, name, size, status, error_key, model_key, updated_at FROM ${ident(schemas.app, 'knowledge_documents')} WHERE library_id = ${libraryId} ORDER BY name, id`,
  );
  return rows.rows.map((row) => {
    // A document still being read or embedded reports its own progress, whatever the rules say now.
    if (row.status === 'indexing')
      return {
        id: row.id,
        libraryId,
        name: row.name,
        size: row.size,
        status: row.status,
        errorKey: null,
        updatedAt: row.updated_at.toISOString(),
      };
    const stale =
      row.status === 'blocked' || (row.status === 'ready' && row.model_key !== embeddingKey(settings));
    return {
      id: row.id,
      libraryId,
      name: row.name,
      size: row.size,
      status: !permitted ? ('blocked' as const) : stale ? ('failed' as const) : row.status,
      errorKey: !permitted ? 'libraries.blocked' : stale ? 'libraries.reindexNeeded' : row.error_key,
      updatedAt: row.updated_at.toISOString(),
    };
  });
}

export function libraryAllows(
  label: KnowledgeLibrary['label'],
  settings: KnowledgeSettings,
  providerId?: string,
) {
  const rule = settings.libraries.rules[label];
  if (rule === 'blocked') return false;
  if (rule === 'allowed') return true;
  return Boolean(providerId && providerFor(providerId).local);
}

export async function libraryPrompt(
  ctx: AppContext,
  actor: Actor,
  providerId: string | null,
  options: { databaseId?: string; all?: boolean } = {},
) {
  const settings = await knowledgeSettings(ctx, actor);
  const allowed = await settingsFor(ctx, actor.orgId, actor);
  if (
    !allowed.enabled ||
    (providerId !== null && !allowed.providers.some((provider) => provider.providerId === providerId))
  )
    return { descriptions: [], guidance: [] };
  const visible = (await libraries(ctx, actor)).filter((library) =>
    libraryAllows(library.label, settings, providerId ?? undefined),
  );
  const priority = (library: KnowledgeLibrary) =>
    library.scope.kind === 'organization'
      ? 0
      : library.scope.kind === 'personal'
        ? 1
        : library.scope.kind === 'database' && library.scope.databaseId === options.databaseId
          ? 2
          : library.scope.kind === 'unit'
            ? 3
            : 4;
  visible.sort((a, b) => priority(a) - priority(b) || a.id.localeCompare(b.id));
  const descriptions = [];
  let bytes = 2;
  for (const { id, scope, name, description } of visible) {
    const entry = { id, scope, name, description };
    const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (!options.all && (descriptions.length >= 12 || bytes + size > 8000)) break;
    descriptions.push(entry);
    bytes += size;
  }
  return {
    descriptions,
    guidance: visible
      .filter((library) => ['organization', 'personal'].includes(library.scope.kind) && library.guidance)
      .map(({ scope, guidance }) => ({ scope: scope.kind, text: guidance })),
  };
}

export function libraryUrl(library: Pick<KnowledgeLibrary, 'id' | 'scope'>, documentId?: string) {
  const path = `/knowledge/${library.id}`;
  const params = new URLSearchParams({ library: library.id });
  if (library.scope.kind === 'unit') params.set('unit', library.scope.unitId);
  if (documentId) params.set('document', documentId);
  return `${path}?${params}`;
}

export async function searchKnowledge(
  ctx: AppContext,
  actor: Actor,
  input: { query: string; libraryId?: string; limit: number },
  recipientProvider?: string | null,
) {
  const { pool, schemas } = dataStore(ctx);
  const started = performance.now();
  let settings = await knowledgeSettings(ctx, actor);
  const allowed = await settingsFor(ctx, actor.orgId, actor);
  if (!allowed.enabled) throw new AppError('forbidden', 'rio.disabled');
  if (recipientProvider && !allowed.providers.some((provider) => provider.providerId === recipientProvider))
    throw new AppError('forbidden', 'libraries.blocked');
  if (input.libraryId) await requireLibrary(pool, schemas, actor, input.libraryId);
  const candidates = (await libraries(ctx, actor)).filter(
    (library) =>
      (!input.libraryId || library.id === input.libraryId) &&
      libraryAllows(library.label, settings, settings.embedding?.providerId) &&
      libraryAllows(
        library.label,
        settings,
        recipientProvider === null ? undefined : (recipientProvider ?? settings.embedding?.providerId),
      ),
  );
  try {
    if (!candidates.length) return { untrusted: true, passages: [] as KnowledgePassage[] };
    const [vector] = await embed(ctx, actor, settings, [input.query]);
    // An outbound request may outlive a permission, a document, or the selected embedding model.
    const currentSettings = await knowledgeSettings(ctx, actor);
    if (embeddingKey(currentSettings) !== embeddingKey(settings))
      return { untrusted: true, passages: [] as KnowledgePassage[] };
    const currentAllowed = await settingsFor(ctx, actor.orgId, actor);
    if (
      !currentAllowed.enabled ||
      !currentAllowed.providers.some(
        (provider) => provider.providerId === currentSettings.embedding?.providerId,
      ) ||
      (recipientProvider &&
        !currentAllowed.providers.some((provider) => provider.providerId === recipientProvider))
    )
      return { untrusted: true, passages: [] as KnowledgePassage[] };
    settings = currentSettings;
    const current = new Map(
      (await libraries(ctx, actor))
        .filter(
          (library) =>
            candidates.some((candidate) => candidate.id === library.id) &&
            libraryAllows(library.label, settings, settings.embedding?.providerId) &&
            libraryAllows(
              library.label,
              settings,
              recipientProvider === null ? undefined : (recipientProvider ?? settings.embedding?.providerId),
            ),
        )
        .map((library) => [library.id, library]),
    );
    const score = await cosine(pool, sql`c.value`, vector!);
    const rows = await query<{
      documentId: string;
      libraryId: string;
      document: string;
      section: string;
      text: string;
      score: number;
    }>(
      pool,
      sql`SELECT d.id AS "documentId", d.library_id AS "libraryId", d.name AS document, c.section, c.text, ${score} AS score
      FROM ${ident(schemas.app, 'knowledge_chunks')} c JOIN ${ident(schemas.app, 'knowledge_documents')} d ON d.id = c.document_id
      WHERE d.library_id = ANY(${[...current.keys()]}::uuid[]) AND d.status = 'ready' AND d.model_key = ${embeddingKey(settings)} AND cardinality(c.value) = ${vector!.length}
      ORDER BY score DESC NULLS LAST, d.id, c.position LIMIT ${input.limit}`,
    );
    return {
      untrusted: true,
      passages: rows.rows
        .filter((row) => Number.isFinite(row.score) && row.score > 0)
        .map((row) => ({ ...row, url: libraryUrl(current.get(row.libraryId)!, row.documentId) })),
    };
  } finally {
    await recordKnowledgeUse(ctx, actor, 'search', 'knowledge', 'passages', 0, {
      durationMs: performance.now() - started,
      powerWatts: settings.libraries.searchPowerWatts,
      zone: zoneFor(ctx, allowed),
    });
  }
}
