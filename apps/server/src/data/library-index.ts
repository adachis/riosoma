import { randomUUID } from 'node:crypto';
import { AppError, type KnowledgeSettings } from '@riosoma/contracts';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { embed } from '../ai/knowledge-calls.js';
import { actorFor } from '../automations/run.js';
import type { Actor } from '../http/policy.js';
import { AccessScope } from './access.js';
import { dataStore, type DataSchemas } from './context.js';
import { embeddingKey, readKnowledgeSettings } from './knowledge.js';
import { libraryAllows, requireLibrary, type LibraryRow } from './libraries.js';
import { prepareLibraryText, type LibraryChunk } from './library-text.js';

/** How far one document's indexing may go.  Tests narrow these to reach each edge quickly. */
export const LIBRARY_INDEX_LIMITS = {
  /** How many times a job is claimed before it reports failure, so a server that keeps stopping can't loop. */
  attempts: 4,
  /** The longest one claim may run, reading and embedding included, before it reports failure. */
  runMs: 15 * 60_000,
  /** How long a claim holds without renewal.  A stopped server's job is claimed again after this. */
  leaseSeconds: 90,
  /** How long an unexpected failure waits before the job is tried again. */
  retrySeconds: 5,
};
/** Chunks per embedding request, the same bound the response limit puts on a search. */
const BATCH = 8;
/** How many times a run starts over for a new embedding model before it gives up. */
const RESTARTS = 2;

export interface LibraryIndexJob {
  id: string;
  org_id: string;
  library_id: string;
  document_id: string;
  /** Empty once the person who queued it is gone, and nobody indexes on their behalf. */
  user_id: string | null;
  file_name: string;
  payload: Buffer;
  restoring: boolean;
  attempts: number;
}

/** What one document's indexing came to, written with the job's removal as one change. */
interface Outcome {
  status: 'ready' | 'failed' | 'blocked';
  errorKey: string | null;
  /** The text read so far.  Empty keeps the text the document already holds. */
  text?: string;
  passages?: LibraryChunk[];
  modelKey?: string | null;
}

/** The job stopped being this run's: it was canceled, replaced, deleted, or claimed again. */
class IndexStopped extends Error {}
/** A change on this server touched the document, so the run checks whether it still holds the job. */
class IndexInterrupted extends Error {}
/** The server is closing, so the job goes back on the queue for the next start. */
class IndexShutdown extends Error {}
/** The run took longer than `LIBRARY_INDEX_LIMITS.runMs`. */
class IndexDeadline extends Error {}

const jobs = (schemas: DataSchemas) => ident(schemas.app, 'knowledge_index_jobs');
const documents = (schemas: DataSchemas) => ident(schemas.app, 'knowledge_documents');
const chunks = (schemas: DataSchemas) => ident(schemas.app, 'knowledge_chunks');
const libraries = (schemas: DataSchemas) => ident(schemas.app, 'knowledge_libraries');

/**
 * The runs in progress on each server, so a change made here can stop its outbound call at once.
 * Keyed by the server's shared context, which every plugin of one server sees.
 */
const running = new WeakMap<object, Map<string, { documentId: string; stop: AbortController }>>();
const runsOf = (app: FastifyInstance) => {
  let runs = running.get(app.ctx);
  if (!runs) running.set(app.ctx, (runs = new Map()));
  return runs;
};
/** Starts a pass right away on servers that index in the background. */
const wakers = new WeakMap<object, () => void>();
/** Servers that have begun to close, which claim nothing more and hand back what they just claimed. */
const closing = new WeakSet<object>();

/**
 * Queues a document's indexing inside the caller's transaction, so the document and its job appear
 * together and a restart finds both.  Empty bytes mean the job reads the text the document holds.
 */
export async function enqueueLibraryIndex(
  db: Queryable,
  schemas: DataSchemas,
  job: {
    orgId: string;
    libraryId: string;
    documentId: string;
    userId: string;
    fileName?: string;
    payload?: Buffer;
    restoring?: boolean;
  },
): Promise<void> {
  await query(
    db,
    sql`INSERT INTO ${jobs(schemas)} (id, org_id, library_id, document_id, user_id, file_name, payload, restoring)
    VALUES (${randomUUID()}, ${job.orgId}, ${job.libraryId}, ${job.documentId}, ${job.userId},
      ${job.fileName ?? ''}, ${job.payload ?? Buffer.alloc(0)}, ${Boolean(job.restoring)})
    ON CONFLICT (document_id) DO UPDATE SET library_id = EXCLUDED.library_id, user_id = EXCLUDED.user_id,
      restoring = EXCLUDED.restoring, file_name = EXCLUDED.file_name, payload = EXCLUDED.payload,
      attempts = 0, queued_at = clock_timestamp(), lease_at = NULL, lease_token = NULL`,
  );
}

/** The bytes still waiting for a document that was never read, which a re-index must keep. */
export async function queuedLibraryBytes(
  db: Queryable,
  schemas: DataSchemas,
  documentId: string,
): Promise<{ fileName: string; payload: Buffer } | null> {
  const queued = await query<{ file_name: string; payload: Buffer }>(
    db,
    sql`SELECT file_name, payload FROM ${jobs(schemas)} WHERE document_id = ${documentId}`,
  );
  const row = queued.rows[0];
  return row?.payload.length ? { fileName: row.file_name, payload: row.payload } : null;
}

/**
 * Stops this server's run for documents a committed change replaced, canceled, or removed, so its
 * outbound call ends now rather than at the next batch.  Other servers notice at their next batch.
 */
export function interruptLibraryIndex(app: FastifyInstance, documentId: string) {
  for (const run of runsOf(app).values())
    if (run.documentId === documentId) run.stop.abort(new IndexInterrupted());
}

/** Asks the background worker for a pass now, instead of at its next tick. */
export function wakeLibraryIndexing(app: FastifyInstance) {
  wakers.get(app.ctx)?.();
}

/** Indexes one waiting document, answering false when the queue is empty or leased out. */
export async function indexLibraryNext(app: FastifyInstance): Promise<boolean> {
  if (!app.ctx.pool || closing.has(app.ctx)) return false;
  const { pool, schemas } = dataStore(app.ctx);
  const token = randomUUID();
  const claimed = await query<LibraryIndexJob>(
    pool,
    sql`UPDATE ${jobs(schemas)} SET lease_token = ${token}, attempts = attempts + 1,
      lease_at = clock_timestamp() + make_interval(secs => ${LIBRARY_INDEX_LIMITS.leaseSeconds}::double precision)
    WHERE id = (SELECT id FROM ${jobs(schemas)}
      WHERE lease_at IS NULL OR lease_at < clock_timestamp()
      ORDER BY queued_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING id, org_id, library_id, document_id, user_id, file_name, payload, restoring, attempts`,
  );
  const job = claimed.rows[0];
  if (!job) return false;
  // A close that began while the claim was on its way already stopped every run, so this one goes
  // back on the queue for the next start without using a try.
  if (closing.has(app.ctx)) {
    await release(app, job, token, true);
    return false;
  }
  const stop = new AbortController();
  const runs = runsOf(app);
  runs.set(job.id, { documentId: job.document_id, stop });
  const deadline = setTimeout(() => stop.abort(new IndexDeadline()), LIBRARY_INDEX_LIMITS.runMs);
  deadline.unref();
  // The text read so far, which a document that fails afterward keeps for its next try.
  const progress = { text: '' };
  try {
    await indexJob(app, job, token, stop.signal, progress);
  } catch (error) {
    // An outbound call reports its own abort as a failed request, so the reason it stopped wins.
    await settle(app, job, token, stop.signal.aborted ? stop.signal.reason : error, progress.text);
  } finally {
    clearTimeout(deadline);
    runs.delete(job.id);
  }
  return true;
}

async function indexJob(
  app: FastifyInstance,
  job: LibraryIndexJob,
  token: string,
  signal: AbortSignal,
  progress: { text: string },
) {
  const { pool, schemas } = dataStore(app.ctx);
  if (job.attempts > LIBRARY_INDEX_LIMITS.attempts)
    return finish(app, job, token, failed('libraries.indexFailed'));
  const person = job.user_id ? await actorFor(pool, schemas, job.user_id, job.org_id) : null;
  // Nobody indexes on a person's behalf after they leave, so their documents stop here.
  if (!person) return finish(app, job, token, failed('libraries.indexAccess'));
  const stored = await query<{ source_text: string; library_id: string }>(
    pool,
    sql`SELECT source_text, library_id FROM ${documents(schemas)} WHERE id = ${job.document_id}`,
  );
  const document = stored.rows[0];
  // Deleted while it waited: its job went with it, and there is nothing left to write.
  if (!document || document.library_id !== job.library_id) return;
  // Access comes first, so a person who lost the library stops before anything is read.
  let rules = await rulesFor(pool, schemas, person, job);
  const bytes = job.payload.length ? job.payload : Buffer.from(document.source_text);
  if (!bytes.length) return finish(app, job, token, failed('libraries.indexIncomplete'));
  const name = job.payload.length && job.file_name ? job.file_name : 'document.txt';
  // Reading stays on this server, so a blocked document still keeps its text for a later re-index.
  const { text, chunks: read } = await prepareLibraryText(
    name,
    bytes,
    rules.settings.libraries.extractedCharacters,
    person.userId,
    signal,
  );
  progress.text = text;
  // The text is the document's from here on, so a stop or a restart keeps it, and the upload bytes go.
  await keepText(pool, schemas, job, token, text);
  const passages: LibraryChunk[] = read.map((chunk) => ({ ...chunk, value: null }));
  if (
    passages.length > Math.ceil(rules.settings.libraries.extractedCharacters / 1000) ||
    passages.length > 500
  )
    throw new AppError('payload_too_large', 'libraries.limit');
  let restarts = 0;
  for (let at = 0; ; at += BATCH) {
    await renew(pool, schemas, job.id, token);
    // Access, classification, and the chosen model are checked again before every outbound call,
    // and once more after the last one, so the outcome matches the rules as they are now.
    const current = await rulesFor(pool, schemas, person, job);
    if (!current.allowed) return finish(app, job, token, { ...blocked(), text });
    if (embeddingKey(current.settings) !== embeddingKey(rules.settings)) {
      if (++restarts > RESTARTS) throw new AppError('conflict', 'libraries.reindexNeeded');
      // Vectors from two models never mix, so the run starts over with the new one.
      for (const passage of passages) passage.value = null;
      rules = current;
      at = -BATCH;
      continue;
    }
    rules = current;
    if (at >= passages.length) break;
    const batch = passages.slice(at, at + BATCH);
    const values = await embed(
      app.ctx,
      person,
      rules.settings,
      batch.map((chunk) => `${chunk.section}\n${chunk.text}`),
      signal,
    );
    signal.throwIfAborted();
    for (const [index, chunk] of batch.entries()) chunk.value = values[index]!;
  }
  await finish(app, job, token, {
    status: 'ready',
    errorKey: null,
    text,
    passages,
    modelKey: embeddingKey(rules.settings),
  });
}

/** Whether this person may still index the library, and the rules they would index it under. */
async function rulesFor(
  db: Queryable,
  schemas: DataSchemas,
  person: Actor,
  job: LibraryIndexJob,
): Promise<{ allowed: boolean; library: LibraryRow; settings: KnowledgeSettings }> {
  try {
    const access = new AccessScope(db, schemas, person);
    await access.requireOrganization();
    // An archived document answers to the organization's administrators, not to library management.
    if (job.restoring) await access.requireOrganizationAdmin('ai', true);
    else await requireLibrary(db, schemas, person, job.library_id, true);
  } catch (error) {
    if (error instanceof AppError && error.userFault)
      throw new AppError('forbidden', 'libraries.indexAccess');
    throw error;
  }
  const row = await query<LibraryRow>(
    db,
    sql`SELECT id, org_id, scope, target, name, description, label, guidance
    FROM ${libraries(schemas)} WHERE id = ${job.library_id} AND org_id = ${person.orgId}`,
  );
  const library = row.rows[0];
  if (!library) throw new AppError('forbidden', 'libraries.indexAccess');
  const settings = await readKnowledgeSettings(db, schemas, person);
  return {
    allowed: libraryAllows(library.label, settings, settings.embedding?.providerId),
    library,
    settings,
  };
}

const blocked = (): Outcome => ({ status: 'blocked', errorKey: 'libraries.blocked' });
const failed = (errorKey: string): Outcome => ({ status: 'failed', errorKey });

/** Takes the job's locks in the order library commands do, answering whether the job is still this run's. */
async function hold(db: Queryable, schemas: DataSchemas, job: LibraryIndexJob, token: string) {
  // Library commands hold this lock while they change a document, and take the document before its
  // job, so the two never wait on each other in opposite order.
  await query(
    db,
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${schemas.app}:library:${job.library_id}`}, 0))`,
  );
  const stored = await query<{ library_id: string }>(
    db,
    sql`SELECT library_id FROM ${documents(schemas)} WHERE id = ${job.document_id} FOR UPDATE`,
  );
  const held = await query(
    db,
    sql`SELECT 1 FROM ${jobs(schemas)} WHERE id = ${job.id} AND lease_token = ${token} FOR UPDATE`,
  );
  return Boolean(held.rowCount) && stored.rows[0]?.library_id === job.library_id;
}

/** Stores the text a job read and lets go of the bytes it came from. */
async function keepText(
  pool: Parameters<typeof withTransaction>[0],
  schemas: DataSchemas,
  job: LibraryIndexJob,
  token: string,
  text: string,
) {
  await withTransaction(pool, async (db) => {
    if (!(await hold(db, schemas, job, token))) throw new IndexStopped();
    await query(
      db,
      sql`UPDATE ${documents(schemas)} SET source_text = ${text} WHERE id = ${job.document_id} AND status = 'indexing'`,
    );
    await query(db, sql`UPDATE ${jobs(schemas)} SET payload = '', file_name = '' WHERE id = ${job.id}`);
  });
}

/** Writes the document's new state and drops its job as one change, unless the job moved on. */
async function finish(app: FastifyInstance, job: LibraryIndexJob, token: string, outcome: Outcome) {
  const { pool, schemas } = dataStore(app.ctx);
  const text = outcome.text ?? '';
  const passages = outcome.passages ?? [];
  await withTransaction(pool, async (db) => {
    // Canceled, replaced, or claimed again after a restart: whoever holds it now writes instead.
    if (!(await hold(db, schemas, job, token))) return;
    await query(db, sql`DELETE FROM ${chunks(schemas)} WHERE document_id = ${job.document_id}`);
    await query(
      db,
      sql`UPDATE ${documents(schemas)} SET
      source_text = CASE WHEN ${text} = '' THEN source_text ELSE ${text} END,
      status = ${outcome.status}, error_key = ${outcome.errorKey}, model_key = ${outcome.modelKey ?? null},
      updated_at = CURRENT_TIMESTAMP WHERE id = ${job.document_id}`,
    );
    for (let at = 0; at < passages.length; at += 32) {
      const batch = passages.slice(at, at + 32).map((chunk, index) => ({ ...chunk, position: at + index }));
      await query(
        db,
        sql`INSERT INTO ${chunks(schemas)} (document_id, position, section, text, value)
        SELECT ${job.document_id}, position, section, text, value
        FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb)
        AS chunks(position integer, section text, text text, value double precision[])`,
      );
    }
    await query(db, sql`DELETE FROM ${jobs(schemas)} WHERE id = ${job.id}`);
    await query(
      db,
      sql`SELECT pg_notify(${`${schemas.app}_knowledge`.slice(0, 63)}, ${JSON.stringify({ orgId: job.org_id, libraryId: job.library_id })})`,
    );
  });
}

/** Lets the job go so it runs again, either right away or after a short wait. */
async function release(app: FastifyInstance, job: LibraryIndexJob, token: string, uncounted: boolean) {
  const { pool, schemas } = dataStore(app.ctx);
  await query(
    pool,
    sql`UPDATE ${jobs(schemas)} SET lease_token = NULL,
      lease_at = ${uncounted ? null : sql`clock_timestamp() + make_interval(secs => ${LIBRARY_INDEX_LIMITS.retrySeconds}::double precision)`},
      attempts = CASE WHEN ${uncounted} THEN greatest(attempts - 1, 0) ELSE attempts END
    WHERE id = ${job.id} AND lease_token = ${token}`,
  );
}

/** What a run that ended early leaves behind: a reported outcome, or the job back on the queue. */
async function settle(
  app: FastifyInstance,
  job: LibraryIndexJob,
  token: string,
  cause: unknown,
  text: string,
) {
  try {
    if (cause instanceof IndexStopped) return;
    // A change here that didn't take the job, or a server closing, puts it back without using a try.
    if (cause instanceof IndexInterrupted || cause instanceof IndexShutdown)
      return await release(app, job, token, true);
    if (cause instanceof IndexDeadline)
      return await finish(app, job, token, { ...failed('libraries.indexFailed'), text });
    // A named refusal is the answer: an unreachable service, a lost permission, or a limit.
    if (cause instanceof AppError)
      return await finish(app, job, token, { ...failed(cause.messageKey), text });
    if (job.attempts >= LIBRARY_INDEX_LIMITS.attempts)
      return await finish(app, job, token, { ...failed('libraries.indexFailed'), text });
    await release(app, job, token, false);
  } catch (error) {
    app.log.warn({ err: error, documentId: job.document_id }, 'knowledge indexing could not report');
  }
}

async function renew(db: Queryable, schemas: DataSchemas, id: string, token: string) {
  const held = await query(
    db,
    sql`UPDATE ${jobs(schemas)} SET lease_at = clock_timestamp() + make_interval(secs => ${LIBRARY_INDEX_LIMITS.leaseSeconds}::double precision)
    WHERE id = ${id} AND lease_token = ${token} RETURNING id`,
  );
  if (!held.rowCount) throw new IndexStopped();
}

/**
 * Indexes waiting documents in the background.  A change wakes it at once, and a timer picks up
 * work another server queued or a stopped one left behind.  At a poll interval of 0 the queue waits
 * to be driven by hand.  Closing the server stops its run and puts the job back for the next start.
 */
export function installLibraryIndexing(app: FastifyInstance) {
  const every = app.ctx.config.libraryIndexPollMs ?? 5000;
  let active: Promise<unknown> | undefined;
  let again = false;
  let closed = false;
  const pass = () => {
    if (closed || !app.ctx.pool) return;
    if (active) {
      again = true;
      return;
    }
    active = (async () => {
      // Bounded, so a burst of uploads can't hold the worker past one pass.
      for (let round = 0; round < 16 && !closed && (await indexLibraryNext(app)); round += 1);
    })()
      .catch((error: unknown) => {
        app.log.warn({ err: error }, 'knowledge indexing pass failed');
      })
      .finally(() => {
        active = undefined;
        if (again) {
          again = false;
          pass();
        }
      });
  };
  const timer = every > 0 ? setInterval(pass, every) : undefined;
  timer?.unref();
  if (timer) wakers.set(app.ctx, pass);
  app.addHook('onClose', async () => {
    closed = true;
    clearInterval(timer);
    stopLibraryIndexRuns(app);
    await active;
  });
}

/** Ends this server's runs as it closes, putting each job back for the next start. */
export function stopLibraryIndexRuns(app: FastifyInstance) {
  closing.add(app.ctx);
  for (const run of runsOf(app).values()) run.stop.abort(new IndexShutdown());
}
