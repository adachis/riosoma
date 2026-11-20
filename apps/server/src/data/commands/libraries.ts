import { refuseDemo } from '../../demo/boundary.js';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AppError, LibraryCommand, type LibraryScope } from '@riosoma/contracts';
import { compile, ident, query, sql } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { auditEvent } from '../../auth/database.js';
import type { Actor } from '../../http/policy.js';
import { parse } from '../../http/validate.js';
import { AccessScope } from '../access.js';
import { dataStore } from '../context.js';
import { libraryScope, libraryTarget, requireLibrary, stricterLabel, type LibraryRow } from '../libraries.js';
import {
  enqueueLibraryIndex,
  interruptLibraryIndex,
  queuedLibraryBytes,
  wakeLibraryIndexing,
} from '../library-index.js';
import type { LibraryChunk } from '../library-text.js';
import { readKnowledgeSettings } from '../knowledge.js';
import { checkFileSafety, requireSafeFile } from '../files/safety.js';
import type { CommandContext } from './context.js';
import { runStored } from './transaction.js';

type Document = {
  id: string;
  name: string;
  size: number;
  /** The command that last wrote the document, which indexing never changes.  Older snapshots lack it. */
  revision?: string;
  source_text: string;
  status: string;
  error_key: string | null;
  model_key: string | null;
  chunks: LibraryChunk[];
};
type State =
  | { kind: 'library'; libraryId: string; scope: LibraryScope; value: LibraryRow | null }
  | { kind: 'document'; libraryId: string; documentId: string; value: Document | null };
const missing = () => new AppError('not_found', 'errors.notFound');
const checkCanceled = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new AppError('conflict', 'errors.conflict');
};
function snapshot(state: State): State {
  return state.kind === 'document' && state.value
    ? { ...state, value: { ...state.value, chunks: [] } }
    : state;
}

/**
 * Whether a library or document is still what an earlier read recorded.  A document's indexing job
 * owns its status, its error, its model, and the text it extracts, so a job that finishes in between
 * is not a conflict.  Any command that wrote the document since is, even one that kept its name and
 * size, because each command leaves its own revision.  A document that never gave up its text may
 * also have been stopped and removed since.
 */
function unchangedSince(now: State, recorded: State): boolean {
  if (now.kind !== recorded.kind || now.libraryId !== recorded.libraryId) return false;
  if (now.kind === 'library' || recorded.kind === 'library') return isDeepStrictEqual(now, recorded);
  if (now.documentId !== recorded.documentId) return false;
  const found = now.value;
  const wanted = recorded.value;
  if (!found)
    // A document that never gave up its text may have been stopped and removed since.
    return !wanted || (wanted.status === 'indexing' && !wanted.source_text);
  if (!wanted) return false;
  return (
    found.id === wanted.id &&
    found.name === wanted.name &&
    found.size === wanted.size &&
    (found.revision ?? '') === (wanted.revision ?? '')
  );
}

/** A document row as it waits for its indexing job, carrying whatever text it already has. */
function waiting(documentId: string, name: string, size: number, text = ''): Document {
  return {
    id: documentId,
    name,
    size,
    source_text: text,
    status: 'indexing',
    error_key: null,
    model_key: null,
    chunks: [],
  };
}

/**
 * A document whose indexing was stopped keeps the text it already gave up, so it can be indexed
 * again.  One that was never read has nothing to keep and goes, and undo brings back what it can.
 */
function stopped(document: Document): Document | null {
  return document.source_text
    ? { ...document, status: 'failed', error_key: 'libraries.indexCanceled', model_key: null, chunks: [] }
    : null;
}

async function authorize(c: CommandContext, state: State) {
  if (state.kind === 'library') {
    await new AccessScope(c.db, c.schemas, c.actor).requireLibraryScope(state.scope, true);
    const current = await query<LibraryRow>(
      c.db,
      sql`SELECT id, org_id, scope, target, name, description, label, guidance FROM ${ident(c.schemas.app, 'knowledge_libraries')} WHERE id = ${state.libraryId}`,
    );
    const row = current.rows[0];
    if (
      row &&
      (row.org_id !== c.actor.orgId ||
        row.scope !== state.scope.kind ||
        row.target !== libraryTarget(state.scope, c.actor))
    )
      throw missing();
  } else await requireLibrary(c.db, c.schemas, c.actor, state.libraryId, true);
}
async function current(c: CommandContext, state: State): Promise<State> {
  if (state.kind === 'library') {
    const result = await query<LibraryRow>(
      c.db,
      sql`SELECT id, org_id, scope, target, name, description, label, guidance FROM ${ident(c.schemas.app, 'knowledge_libraries')} WHERE id = ${state.libraryId}`,
    );
    return { ...state, value: result.rows[0] ?? null };
  }
  const result = await query<Omit<Document, 'chunks'> & { library_id: string }>(
    c.db,
    sql`SELECT id, library_id, name, size, source_text, status, error_key, model_key, revision FROM ${ident(c.schemas.app, 'knowledge_documents')} WHERE id = ${state.documentId}`,
  );
  const row = result.rows[0];
  if (!row) return { ...state, value: null };
  if (row.library_id !== state.libraryId) throw missing();
  const chunks = await query<LibraryChunk>(
    c.db,
    sql`SELECT section, text, value FROM ${ident(c.schemas.app, 'knowledge_chunks')} WHERE document_id = ${state.documentId} ORDER BY position`,
  );
  const { library_id: _library, ...document } = row;
  return { ...state, value: { ...document, chunks: chunks.rows } };
}
/** Writes a library or document as a command left it.  `revision` names the command for undo. */
async function write(c: CommandContext, state: State, revision: string, limits = true) {
  const { db, schemas } = c;
  if (state.kind === 'library') {
    if (!state.value) {
      const documents = await query(
        db,
        sql`SELECT 1 FROM ${ident(schemas.app, 'knowledge_documents')} WHERE library_id = ${state.libraryId} LIMIT 1`,
      );
      if (documents.rowCount) throw new AppError('conflict', 'errors.conflict');
      await query(
        db,
        sql`DELETE FROM ${ident(schemas.app, 'knowledge_libraries')} WHERE id = ${state.libraryId}`,
      );
    } else {
      const row = state.value;
      await query(
        db,
        sql`INSERT INTO ${ident(schemas.app, 'knowledge_libraries')} (id, org_id, scope, target, name, description, label, guidance)
        VALUES (${row.id}, ${row.org_id}, ${row.scope}, ${row.target}, ${row.name}, ${row.description}, ${row.label}, ${row.guidance})
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, label = EXCLUDED.label, guidance = EXCLUDED.guidance`,
      );
    }
    return;
  }
  await query(
    db,
    sql`DELETE FROM ${ident(schemas.app, 'knowledge_documents')} WHERE id = ${state.documentId}`,
  );
  if (!state.value) return;
  // The snapshot an undo compares against names this command too.
  state.value.revision = revision;
  const row = state.value;
  // Stopping a job keeps what the document already had, even under limits lowered since.
  if (limits) await documentLimits(c, state.libraryId, row);
  await query(
    db,
    sql`INSERT INTO ${ident(schemas.app, 'knowledge_documents')} (id, library_id, name, size, source_text, status, error_key, model_key, revision)
    VALUES (${row.id}, ${state.libraryId}, ${row.name}, ${row.size}, ${row.source_text}, ${row.status}, ${row.error_key}, ${row.model_key}, ${revision})`,
  );
  for (let at = 0; at < row.chunks.length; at += 32) {
    const batch = row.chunks.slice(at, at + 32).map((chunk, index) => ({ ...chunk, position: at + index }));
    await query(
      db,
      sql`INSERT INTO ${ident(schemas.app, 'knowledge_chunks')}
      (document_id, position, section, text, value)
      SELECT ${row.id}, position, section, text, value FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb)
      AS chunks(position integer, section text, text text, value double precision[])`,
    );
  }
}

async function documentLimits(c: CommandContext, libraryId: string, row: Document) {
  const settings = await readKnowledgeSettings(c.db, c.schemas, c.actor);
  const count = await query<{ count: number }>(
    c.db,
    sql`SELECT count(*)::int AS count FROM ${ident(c.schemas.app, 'knowledge_documents')} WHERE library_id = ${libraryId} AND id <> ${row.id}`,
  );
  if (
    count.rows[0]!.count >= settings.libraries.documents ||
    row.size > settings.libraries.uploadBytes ||
    row.source_text.length > settings.libraries.extractedCharacters
  )
    throw new AppError('validation_failed', 'libraries.limit');
}

type CommandResult = {
  status: 'applied' | 'duplicate' | 'rejected';
  actionId: string;
  error?: ReturnType<AppError['toBody']>['error'];
};

/**
 * What a command sent again learns.  A refusal stays a refusal, so a client that retries after a
 * lost answer never takes a rejected change for one that was made.
 */
function replayed(stored: unknown, actionId: string): CommandResult {
  const result = stored as Partial<CommandResult> | null;
  return result?.status === 'rejected'
    ? { status: 'rejected', actionId, ...(result.error ? { error: result.error } : {}) }
    : { status: 'duplicate', actionId };
}

export async function runLibraryCommand(
  app: FastifyInstance,
  actor: Actor,
  input: unknown,
  signal?: AbortSignal,
) {
  refuseDemo(actor);
  const command = parse(LibraryCommand, input);
  if (command.kind === 'library.dismissReview')
    return dismissLibraryReview(app, actor, command.reviewId, command.id);
  const { pool, schemas } = dataStore(app.ctx);
  const preparation = { db: pool, schemas, actor, databaseId: '', secretKey: app.ctx.config.secretKey };
  let prepared: { state: State; before: State; library?: LibraryRow; settings?: unknown } | undefined;
  // The bytes a document's indexing job reads, or nothing when it reads the stored text again.
  let job: { fileName?: string; payload?: Buffer; keepPayload?: boolean } | undefined;
  // A stopped job's document must still be waiting when the change is made.
  let stopping = false;
  let failure: unknown;
  try {
    await new AccessScope(pool, schemas, actor).requireOrganization();
    const replay = await query<{ actor_id: string; org_id: string; database_id: string; result: unknown }>(
      pool,
      sql`SELECT actor_id, org_id, database_id, result FROM ${ident(schemas.app, 'commands')} WHERE id = ${command.id}`,
    );
    if (replay.rows[0]) {
      const previous = replay.rows[0];
      if (
        previous.actor_id !== actor.userId ||
        previous.org_id !== actor.orgId ||
        previous.database_id !== ''
      )
        throw missing();
      return replayed(previous.result, command.id);
    }
    let state: State;
    let undoAfter: State | undefined;
    if (command.kind === 'library.undo') {
      const saved = await query<{ before: State; after: State; undone: boolean }>(
        pool,
        sql`SELECT before, after, undone FROM ${ident(schemas.app, 'knowledge_actions')}
        WHERE id = ${command.actionId} AND org_id = ${actor.orgId} AND user_id = ${actor.userId}
        AND created_at > now() - interval '30 days'`,
      );
      const action = saved.rows[0];
      if (!action || action.undone || !['library', 'document'].includes(action.before.kind)) throw missing();
      state = action.before;
      undoAfter = action.after;
    } else if (command.kind === 'library.save') {
      if (!['organization', 'personal'].includes(command.scope.kind) && command.details.guidance)
        throw new AppError('validation_failed', 'libraries.guidanceScope');
      state = {
        kind: 'library',
        libraryId: command.libraryId,
        scope: command.scope,
        value: {
          ...command.details,
          id: command.libraryId,
          org_id: actor.orgId,
          scope: command.scope.kind,
          target: libraryTarget(command.scope, actor),
        },
      };
    } else
      state = { kind: 'document', libraryId: command.libraryId, documentId: command.documentId, value: null };
    await authorize(preparation, state);
    const before = await current(preparation, state);
    if (undoAfter && !unchangedSince(before, undoAfter)) throw new AppError('conflict', 'errors.conflict');
    prepared = { state, before };
    if (
      (command.kind === 'library.document' || command.kind === 'library.index') &&
      state.kind === 'document'
    ) {
      const library = await requireLibrary(pool, schemas, actor, state.libraryId, true);
      const settings = await readKnowledgeSettings(pool, schemas, actor);
      prepared.library = library;
      prepared.settings = settings;
      if (command.kind === 'library.document') {
        const count = await query<{ count: number }>(
          pool,
          sql`SELECT count(*)::int AS count FROM ${ident(schemas.app, 'knowledge_documents')}
          WHERE library_id = ${state.libraryId} AND id <> ${state.documentId}`,
        );
        if (count.rows[0]!.count >= settings.libraries.documents)
          throw new AppError('validation_failed', 'libraries.limit');
        const bytes =
          command.source.kind === 'text'
            ? Buffer.from(command.source.text)
            : Buffer.from(command.source.base64, 'base64');
        if (!bytes.length || bytes.length > settings.libraries.uploadBytes)
          throw new AppError('payload_too_large', 'libraries.limit');
        requireSafeFile(
          await checkFileSafety(
            { db: pool, schema: schemas.app, orgId: actor.orgId, config: app.ctx.config },
            { bytes, ...(command.source.kind === 'file' ? { name: command.name } : {}) },
          ),
          {
            infected: 'libraries.infected',
            unavailable: 'files.scanUnavailable',
            addressNotApproved: 'unavailable',
          },
        );
        // The upload answers once its bytes are stored, and reading and embedding follow in the job.
        state.value = waiting(state.documentId, command.name, bytes.length);
        job = {
          fileName: command.source.kind === 'text' ? '' : command.name,
          payload: bytes,
        };
      } else {
        if (before.kind !== 'document' || !before.value) throw missing();
        const stored = before.value;
        state.value = waiting(state.documentId, stored.name, stored.size, stored.source_text);
        // A document still waiting to be read keeps the bytes already queued for it.
        job = { keepPayload: !stored.source_text };
      }
    }
    if (command.kind === 'library.cancelIndex' && state.kind === 'document') {
      if (before.kind !== 'document' || !before.value) throw missing();
      if (before.value.status !== 'indexing') throw new AppError('conflict', 'libraries.notIndexing');
      state.value = stopped(before.value);
      stopping = true;
    }
    if (command.kind === 'library.undo' && state.kind === 'document' && state.value) {
      const library = await requireLibrary(pool, schemas, actor, state.libraryId, true);
      const settings = await readKnowledgeSettings(pool, schemas, actor);
      prepared.library = library;
      prepared.settings = settings;
      const restored = state.value;
      // A document restored with its text is indexed again.  One that never gave up its text can't be.
      state.value = restored.source_text
        ? waiting(state.documentId, restored.name, restored.size, restored.source_text)
        : {
            ...restored,
            status: 'failed',
            error_key: 'libraries.indexIncomplete',
            model_key: null,
            chunks: [],
          };
      job = restored.source_text ? {} : undefined;
    }
    checkCanceled(signal);
  } catch (error) {
    failure = signal?.aborted ? new AppError('conflict', 'errors.conflict') : error;
  }
  // A connection that closed leaves nothing stored, so the same command may be sent again instead of
  // reading as a refusal it never earned or as a duplicate of work that never happened.
  if (signal?.aborted)
    throw failure instanceof AppError ? failure : new AppError('conflict', 'errors.conflict');
  const result = await runStored<CommandResult>(
    app,
    actor,
    '',
    {
      commandId: command.id,
      groupId: command.id,
      lockKey: `library:${prepared?.state.libraryId ?? command.id}`,
      duplicate: (stored) => replayed(stored, command.id),
      rejected: (error) => ({ status: 'rejected', actionId: command.id, error: error.toBody().error }),
    },
    async (c) => {
      if (failure) throw failure;
      const { state, before, library, settings } = prepared!;
      await authorize(c, state);
      const now = await current(c, state);
      if (!unchangedSince(now, before)) throw new AppError('conflict', 'errors.conflict');
      if (stopping && state.kind === 'document') {
        // A job that finished in between leaves nothing to stop, and text it read since is kept.
        if (now.kind !== 'document' || now.value?.status !== 'indexing')
          throw new AppError('conflict', 'libraries.notIndexing');
        state.value = stopped(now.value);
      }
      if (command.kind === 'library.index' && state.kind === 'document') {
        // The job may have read the document since the first look, so the text it kept is used, and
        // bytes it already let go of aren't looked for.
        if (now.kind !== 'document' || !now.value) throw missing();
        const stored = now.value;
        state.value = waiting(state.documentId, stored.name, stored.size, stored.source_text);
        job = { keepPayload: !stored.source_text };
      }
      if (
        library &&
        (!isDeepStrictEqual(library, await requireLibrary(c.db, schemas, actor, state.libraryId, true)) ||
          !isDeepStrictEqual(settings, await readKnowledgeSettings(c.db, schemas, actor)))
      )
        throw new AppError('conflict', 'errors.conflict');
      if (command.kind === 'library.undo') {
        const updated = await query(
          c.db,
          sql`UPDATE ${ident(schemas.app, 'knowledge_actions')} SET undone = true
        WHERE id = ${command.actionId} AND NOT undone AND created_at > now() - interval '30 days' RETURNING id`,
        );
        if (!updated.rowCount) throw missing();
      }
      const scope =
        state.kind === 'library'
          ? state.scope
          : libraryScope(await requireLibrary(c.db, schemas, actor, state.libraryId));
      // Rewriting the document drops its waiting job, so bytes never read yet are taken first.
      const queued =
        job?.keepPayload && state.kind === 'document'
          ? await queuedLibraryBytes(c.db, c.schemas, state.documentId)
          : null;
      await write(c, state, command.id, !stopping);
      if (job && state.kind === 'document')
        await enqueueLibraryIndex(c.db, c.schemas, {
          orgId: actor.orgId,
          libraryId: state.libraryId,
          documentId: state.documentId,
          userId: actor.userId,
          fileName: queued?.fileName ?? job.fileName,
          payload: queued?.payload ?? job.payload,
        });
      await query(
        c.db,
        sql`INSERT INTO ${ident(schemas.app, 'knowledge_actions')}
      (id, org_id, user_id, database_id, library_user_id, library_unit_id, before, after)
      VALUES (${command.id}, ${actor.orgId}, ${actor.userId}, ${scope.kind === 'database' ? scope.databaseId : null},
      ${scope.kind === 'personal' ? actor.userId : null}, ${scope.kind === 'unit' ? scope.unitId : null},
      ${JSON.stringify(snapshot(now))}::jsonb, ${JSON.stringify(snapshot(state))}::jsonb)`,
      );
      await auditEvent(c.db, compile(sql`${ident(schemas.audit)}`).text, command.kind, actor, {
        libraryId: state.libraryId,
        databaseId: scope.kind === 'database' ? scope.databaseId : undefined,
        unitId: scope.kind === 'unit' ? scope.unitId : undefined,
        documentId: state.kind === 'document' ? state.documentId : undefined,
      });
      await query(
        c.db,
        sql`SELECT pg_notify(${`${schemas.app}_knowledge`.slice(0, 63)}, ${JSON.stringify({ orgId: actor.orgId, libraryId: state.libraryId })})`,
      );
      return { status: 'applied', actionId: command.id };
    },
  );
  if (result.status === 'applied' && prepared?.state.kind === 'document') {
    // Whatever this server was doing for the document's earlier state stops, and its new job starts.
    interruptLibraryIndex(app, prepared.state.documentId);
    wakeLibraryIndexing(app);
  }
  return result;
}

/** An owner's review restores archived scopes exactly, including another person's ownership. */
export async function restoreLibraryReview(
  app: FastifyInstance,
  actor: Actor,
  reviewId: string,
  signal?: AbortSignal,
) {
  checkCanceled(signal);
  const { pool, schemas } = dataStore(app.ctx);
  const c = { db: pool, schemas, actor, databaseId: '', secretKey: app.ctx.config.secretKey };
  const access = new AccessScope(pool, schemas, actor);
  await access.requireOrganizationAdmin('ai', true);
  type Review = {
    kind: string;
    detail: { row: LibraryRow | (Document & { library_id: string }) };
    done_at: Date | null;
  };
  const saved = await query<Review>(
    pool,
    sql`SELECT kind, detail, done_at FROM ${ident(schemas.app, 'organization_import_review')}
    WHERE id = ${reviewId} AND org_id = ${actor.orgId}`,
  );
  const review = saved.rows[0];
  if (!review || !['knowledgeLibrary', 'knowledgeDocument'].includes(review.kind)) throw missing();
  if (review.done_at) return;
  const archived = review.detail.row;
  const archivedLibraryId =
    review.kind === 'knowledgeLibrary'
      ? archived.id
      : (archived as Document & { library_id: string }).library_id;
  let libraryId = archivedLibraryId;
  const load = async (db: CommandContext['db']) => {
    await new AccessScope(db, schemas, actor).requireOrganizationAdmin('ai', true);
    const rows = await query<LibraryRow>(
      db,
      sql`SELECT id, org_id, scope, target, name, description, label, guidance
      FROM ${ident(schemas.app, 'knowledge_libraries')} WHERE id = ${libraryId} AND org_id = ${actor.orgId}`,
    );
    return rows.rows[0];
  };
  let state: State;
  let definition: LibraryRow;
  // An archived document answers to the organization's administrators rather than to library rights.
  let restoring = false;
  const settings = await readKnowledgeSettings(pool, schemas, actor);
  if (review.kind === 'knowledgeLibrary') {
    definition = archived as LibraryRow;
    if (definition.org_id !== actor.orgId) throw missing();
    const scope = libraryScope(definition);
    if (scope.kind === 'personal') {
      const person = await query(
        pool,
        sql`SELECT 1 FROM ${ident(schemas.app, 'memberships')}
        WHERE org_id = ${actor.orgId} AND user_id = ${definition.target}`,
      );
      if (!person.rowCount) throw new AppError('conflict', 'errors.conflict');
    } else await access.requireLibraryScope(scope, true);
    const existing = await query<LibraryRow>(
      pool,
      sql`SELECT id, org_id, scope, target, name, description, label, guidance
      FROM ${ident(schemas.app, 'knowledge_libraries')}
      WHERE org_id = ${actor.orgId} AND scope = ${definition.scope} AND target = ${definition.target}`,
    );
    if (existing.rows[0]) {
      const live = existing.rows[0];
      // The live library keeps its own name and description.  A merge never loosens its
      // classification, and archived guidance fills in only where the live library has none.
      definition = {
        ...live,
        label: stricterLabel(live.label, definition.label),
        guidance:
          live.guidance || (['organization', 'personal'].includes(live.scope) ? definition.guidance : ''),
      };
      libraryId = live.id;
    }
    state = { kind: 'library', libraryId, scope, value: definition };
  } else {
    const library = await load(pool);
    if (!library) throw new AppError('conflict', 'errors.conflict');
    definition = library;
    const document = archived as Document;
    // Its archived text goes in as it is, and reading and embedding follow in the document's own job.
    state = {
      kind: 'document',
      libraryId,
      documentId: archived.id,
      value: waiting(document.id, document.name, document.size, document.source_text),
    };
    restoring = true;
  }
  const before = await current(c, state);
  if (state.kind === 'document' && before.value) throw new AppError('conflict', 'errors.conflict');
  // A closed connection stores nothing here, so the same review can be turned on again.
  checkCanceled(signal);
  const id = randomUUID();
  const result = await runStored<{ status: 'applied' | 'duplicate' | 'rejected'; error?: AppError }>(
    app,
    actor,
    '',
    {
      commandId: id,
      groupId: id,
      lockKey: `library:${libraryId}`,
      duplicate: () => ({ status: 'duplicate' as const }),
      rejected: (error) => ({ status: 'rejected' as const, error }),
    },
    async (transaction) => {
      await new AccessScope(transaction.db, schemas, actor).requireOrganizationAdmin('ai', true);
      const pending = await query(
        transaction.db,
        sql`SELECT 1 FROM ${ident(schemas.app, 'organization_import_review')}
      WHERE id = ${reviewId} AND org_id = ${actor.orgId} AND done_at IS NULL AND detail = ${JSON.stringify(review.detail)}::jsonb FOR UPDATE`,
      );
      if (!pending.rowCount) return { status: 'duplicate' as const };
      const now = await current(transaction, state);
      if (
        !unchangedSince(now, before) ||
        !isDeepStrictEqual(settings, await readKnowledgeSettings(transaction.db, schemas, actor)) ||
        (state.kind === 'document' && !isDeepStrictEqual(definition, await load(transaction.db)))
      )
        throw new AppError('conflict', 'errors.conflict');
      await write(transaction, state, id);
      if (restoring && state.kind === 'document') {
        // A personal library is indexed only as its owner, under that person's own access, AI
        // permissions, and usage.  Other scopes answer to the administrator who turned it on.
        const personal = definition.scope === 'personal';
        await enqueueLibraryIndex(transaction.db, schemas, {
          orgId: actor.orgId,
          libraryId,
          documentId: state.documentId,
          userId: personal ? definition.target : actor.userId,
          restoring: !personal,
        });
      }
      if (state.kind === 'library' && libraryId !== archivedLibraryId)
        await query(
          transaction.db,
          sql`UPDATE ${ident(schemas.app, 'organization_import_review')}
          SET detail = jsonb_set(detail, '{row,library_id}', to_jsonb(${libraryId}::text))
          WHERE org_id = ${actor.orgId} AND kind = 'knowledgeDocument' AND done_at IS NULL
            AND detail->'row'->>'library_id' = ${archivedLibraryId}`,
        );
      await query(
        transaction.db,
        sql`INSERT INTO ${ident(schemas.app, 'knowledge_actions')}
      (id, org_id, user_id, database_id, library_user_id, library_unit_id, before, after)
      VALUES (${id}, ${actor.orgId}, ${actor.userId}, ${definition.scope === 'database' ? definition.target : null},
        ${definition.scope === 'personal' ? definition.target : null}, ${definition.scope === 'unit' ? definition.target : null},
        ${JSON.stringify(snapshot(now))}::jsonb, ${JSON.stringify(snapshot(state))}::jsonb)`,
      );
      await query(
        transaction.db,
        sql`UPDATE ${ident(schemas.app, 'organization_import_review')}
      SET done_at = now(), detail = '{}'::jsonb WHERE id = ${reviewId}`,
      );
      await auditEvent(transaction.db, compile(sql`${ident(schemas.audit)}`).text, 'library.restore', actor, {
        reviewId,
        libraryId,
      });
      await query(
        transaction.db,
        sql`SELECT pg_notify(${`${schemas.app}_knowledge`.slice(0, 63)}, ${JSON.stringify({ orgId: actor.orgId, libraryId })})`,
      );
      return { status: 'applied' as const };
    },
  );
  if (result.status === 'rejected' && 'error' in result) throw result.error;
  if (result.status === 'applied' && restoring) wakeLibraryIndexing(app);
}

/** Dismissal erases the source payload, including dependent documents when dismissing a library. */
export async function dismissLibraryReview(
  app: FastifyInstance,
  actor: Actor,
  reviewId: string,
  id: string = randomUUID(),
) {
  return runStored<{
    status: 'applied' | 'duplicate' | 'rejected';
    actionId: string;
    error?: ReturnType<AppError['toBody']>['error'];
  }>(
    app,
    actor,
    '',
    {
      commandId: id,
      groupId: id,
      lockKey: `library-review:${reviewId}`,
      duplicate: (stored) => replayed(stored, id),
      rejected: (error) => ({ status: 'rejected' as const, actionId: id, error: error.toBody().error }),
    },
    async (c) => {
      await new AccessScope(c.db, c.schemas, actor).requireOrganizationAdmin('ai', true);
      const rows = await query<{ kind: string; target_id: string; done_at: Date | null }>(
        c.db,
        sql`SELECT kind, target_id, done_at FROM ${ident(c.schemas.app, 'organization_import_review')}
      WHERE id = ${reviewId} AND org_id = ${actor.orgId} FOR UPDATE`,
      );
      const row = rows.rows[0];
      if (!row || !['knowledgeLibrary', 'knowledgeDocument'].includes(row.kind)) throw missing();
      if (!row.done_at) {
        await query(
          c.db,
          sql`UPDATE ${ident(c.schemas.app, 'organization_import_review')}
        SET detail = '{}'::jsonb, done_at = now()
        WHERE org_id = ${actor.orgId} AND done_at IS NULL AND (id = ${reviewId}
          OR (${row.kind === 'knowledgeLibrary'} AND kind = 'knowledgeDocument'
            AND detail->'row'->>'library_id' = ${row.target_id}))`,
        );
        await auditEvent(c.db, compile(sql`${ident(c.schemas.audit)}`).text, 'library.dismissReview', actor, {
          reviewId,
        });
        await query(
          c.db,
          sql`SELECT pg_notify(${`${c.schemas.app}_knowledge`.slice(0, 63)},
        ${JSON.stringify({ orgId: actor.orgId, libraryId: row.kind === 'knowledgeLibrary' ? row.target_id : null })})`,
        );
      }
      return { status: 'applied' as const, actionId: id };
    },
  );
}
