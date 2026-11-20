import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { IngestDraftFailure, IngestDraftRow, type IngestDraftFailure as Failure } from '@riosoma/contracts';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import type { AppContext } from '../../app.js';
import type { Actor } from '../../http/policy.js';
import type { CommandContext } from '../../data/commands/context.js';
import { lock } from '../../data/commands/transaction.js';
import { dataStore } from '../../data/context.js';
import { loadFields, loadTable } from '../../data/metadata.js';
import { loadOriginal } from '../../data/files/originals.js';
import { AccessScope } from '../../data/access.js';
import { createAiReader } from '../ai-reader/index.js';
import { TryLaterError } from '../pipeline/types.js';
import { requireEvidenceAccess, setupStore } from '../setup/evidence.js';
import { outputFingerprint } from '../setup/readiness.js';
import { extractSource } from '../extract/index.js';
import {
  checkpointDraft,
  claimDraft,
  failDraftClaim,
  readDraft,
  saveDraft,
  type DraftDocument,
} from './store.js';

const jobs = new WeakMap<AppContext, Set<Promise<void>>>();
export async function waitForDraftWork(app: FastifyInstance): Promise<void> {
  await Promise.allSettled([...(jobs.get(app.ctx) ?? [])]);
}

/** The claim commits before reading, and a revision check rejects late output after discard or restart. */
export function startDraftWork(app: FastifyInstance, actor: Actor, tableId: string, draftId: string): void {
  const running = jobs.get(app.ctx) ?? new Set<Promise<void>>();
  jobs.set(app.ctx, running);
  const job = produceDraft(app, actor, tableId, draftId)
    .catch((error: unknown) => {
      app.log.warn({ err: error }, 'draft reading failed');
    })
    .finally(() => running.delete(job));
  running.add(job);
}

async function produceDraft(
  app: FastifyInstance,
  actor: Actor,
  tableId: string,
  draftId: string,
): Promise<void> {
  const { pool, schemas } = dataStore(app.ctx);
  const token = randomUUID();
  const c: CommandContext = {
    db: pool,
    schemas,
    actor,
    databaseId: '',
    appContext: app.ctx,
    fileConfig: app.ctx.config,
  };
  try {
    const draft = await claimDraft(c, tableId, draftId, token);
    if (!draft) return;
    const table = await loadTable(pool, schemas, tableId);
    c.databaseId = table?.databaseId ?? '';
    let failure: Failure | null = null;
    let rows: DraftDocument['rows'] = [];
    let readerChecks = draft.readerChecks;
    try {
      await new AccessScope(pool, schemas, actor).require(c.databaseId, 'editSchema');
      await requireEvidenceAccess(c, tableId);
      const format = await setupStore(c).readFormat({ orgId: actor.orgId, tableId }, draft.formatId);
      const file = await setupStore(c).readFile({ orgId: actor.orgId, tableId }, draft.fileId);
      const bytes = file && (await loadOriginal(pool, schemas.app, app.ctx.config, file));
      if (!table?.ingest || !format || !file || !bytes) failure = 'inputUnavailable';
      else {
        const extracted = await extractSource(file.name, bytes);
        if (extracted.status !== 'extracted') failure = 'inputUnavailable';
        else {
          const reading = await createAiReader(app.ctx, actor)(
            extracted.source,
            format,
            table,
            draft.readerChecks,
            async (checks) => {
              await checkpointDraft(c, draft, token, checks);
              readerChecks = checks;
            },
          );
          readerChecks = reading.checks ?? readerChecks;
          if (reading.status !== 'read') failure = reading.reason;
          else
            rows = reading.rows.map((row) =>
              IngestDraftRow.parse({
                id: randomUUID(),
                values: row.values,
                at: row.at,
                doubts: [
                  ...new Set(
                    row.reasons?.flatMap((reason) => (reason.fieldKey ? [reason.fieldKey] : [])) ?? [],
                  ),
                ],
                corrected: [],
                needsCorrection: false,
              }),
            );
        }
      }
    } catch (error) {
      if (error instanceof TryLaterError) {
        const reason = IngestDraftFailure.safeParse(error.messageId.replace('ingest.aiReader.', ''));
        failure = reason.success ? reason.data : 'providerUnavailable';
        readerChecks = error.checks ?? readerChecks;
      } else failure = 'invalidReading';
      rows = [];
    }
    await withTransaction(pool, async (db) => {
      const currentContext = { ...c, db };
      await lock(currentContext, [`database:${c.databaseId}`]);
      const active = await query(
        db,
        sql`SELECT id FROM ${ident(schemas.app, 'ingest_drafts')}
      WHERE org_id = ${actor.orgId} AND table_id = ${tableId} AND id = ${draftId} AND state = 'drafting'
      AND revision = ${draft.revision} AND run_token = ${token} FOR UPDATE`,
      );
      if (!active.rowCount) {
        // Discarded output stays erased, while its completed spend still bounds a later attempt on this file.
        await query(
          db,
          sql`UPDATE ${ident(schemas.app, 'ingest_drafts')}
        SET document = jsonb_set(document, '{readerChecks}', ${JSON.stringify(readerChecks)}::jsonb), run_token = NULL
        WHERE org_id = ${actor.orgId} AND table_id = ${tableId} AND id = ${draftId} AND run_token = ${token}`,
        );
        return;
      }
      const current = await readDraft(currentContext, tableId, draftId);
      const parent = await loadTable(db, schemas, tableId);
      const fields = await loadFields(db, schemas, [tableId]);
      if (!parent?.ingest || current.outputHash !== outputFingerprint(parent.ingest, fields))
        failure = 'outputChanged';
      try {
        await new AccessScope(db, schemas, actor).require(c.databaseId, 'editSchema');
        await requireEvidenceAccess(currentContext, tableId);
      } catch {
        failure = 'classification';
      }
      current.revision++;
      current.state = failure ? 'failed' : 'ready';
      current.failure = failure;
      current.readerChecks = readerChecks;
      current.rows = failure ? [] : rows;
      current.originalRows = current.rows;
      await saveDraft(currentContext, current);
    });
  } catch (error) {
    await failDraftClaim(c, tableId, draftId, token);
    throw error;
  }
}
