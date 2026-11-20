import { AppError, type IngestDraft, type IngestDraftRow, type IngestSpotCheck } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import type { CommandContext } from '../../data/commands/context.js';
import type { DraftField } from './checks.js';

export interface DraftDocument {
  id: string;
  tableId: string;
  formatId: string;
  fileId: string;
  revision: number;
  state: IngestDraft['state'];
  failure: IngestDraft['failure'];
  rows: IngestDraftRow[];
  originalRows: IngestDraftRow[];
  checks: IngestSpotCheck[] | null;
  answers: Record<string, IngestSpotCheck['choices'][number]>;
  corrections: NonNullable<IngestDraft['corrections']>;
  mismatches: NonNullable<IngestDraft['mismatches']>;
  fields: DraftField[];
  outputHash: string;
  readerChecks: Record<string, unknown>;
}

const CLAIM_MS = 5 * 60_000;

export async function hasActiveDraftClaim(c: CommandContext, tableId: string, id: string): Promise<boolean> {
  const result = await query(
    c.db,
    sql`SELECT id FROM ${ident(c.schemas.app, 'ingest_drafts')}
    WHERE org_id = ${c.actor.orgId} AND table_id = ${tableId} AND id = ${id}
      AND (run_token IS NOT NULL OR state = 'drafting')
      AND updated_at > clock_timestamp() - ${CLAIM_MS} * interval '1 millisecond'`,
  );
  return !!result.rowCount;
}

export async function claimDraft(c: CommandContext, tableId: string, id: string, token: string) {
  const result = await query<{ document: DraftDocument }>(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, 'ingest_drafts')} SET run_token = ${token}, updated_at = clock_timestamp()
    WHERE org_id = ${c.actor.orgId} AND table_id = ${tableId} AND id = ${id} AND state = 'drafting'
      AND (run_token IS NULL OR updated_at <= clock_timestamp() - ${CLAIM_MS} * interval '1 millisecond')
    RETURNING document`,
  );
  return result.rows[0]?.document;
}

/** A reservation survives interrupted work, and only its current worker can replace it with actual spend. */
export async function checkpointDraft(
  c: CommandContext,
  draft: DraftDocument,
  token: string,
  checks: DraftDocument['readerChecks'],
) {
  const result = await query(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, 'ingest_drafts')}
    SET document = jsonb_set(document, '{readerChecks}', ${JSON.stringify(checks)}::jsonb), updated_at = clock_timestamp()
    WHERE org_id = ${c.actor.orgId} AND table_id = ${draft.tableId} AND id = ${draft.id} AND run_token = ${token}
      AND updated_at > clock_timestamp() - ${CLAIM_MS} * interval '1 millisecond'`,
  );
  if (!result.rowCount) throw new AppError('conflict', 'ingest.drafts.finishing');
}

/** Unexpected exits leave a retryable state without replacing the last durable spending checkpoint. */
export async function failDraftClaim(c: CommandContext, tableId: string, id: string, token: string) {
  await query(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, 'ingest_drafts')}
    SET state = CASE WHEN state = 'drafting' THEN 'failed' ELSE state END,
      revision = CASE WHEN state = 'drafting' THEN revision + 1 ELSE revision END,
      document = CASE WHEN state = 'drafting' THEN document || jsonb_build_object(
        'state', 'failed', 'failure', 'providerUnavailable', 'revision', revision + 1, 'rows', '[]'::jsonb, 'originalRows', '[]'::jsonb)
        ELSE document END,
      run_token = NULL, updated_at = clock_timestamp()
    WHERE org_id = ${c.actor.orgId} AND table_id = ${tableId} AND id = ${id} AND run_token = ${token}`,
  );
}

export async function listDrafts(c: CommandContext, tableId: string): Promise<DraftDocument[]> {
  const result = await query<{ document: DraftDocument }>(
    c.db,
    sql`SELECT document FROM ${ident(c.schemas.app, 'ingest_drafts')} WHERE org_id = ${c.actor.orgId} AND table_id = ${tableId} ORDER BY id`,
  );
  return result.rows.map(({ document }) => document);
}
export async function readDraft(c: CommandContext, tableId: string, id: string): Promise<DraftDocument> {
  const result = await query<{ document: DraftDocument }>(
    c.db,
    sql`SELECT document FROM ${ident(c.schemas.app, 'ingest_drafts')} WHERE org_id = ${c.actor.orgId} AND table_id = ${tableId} AND id = ${id}`,
  );
  if (!result.rows[0]) throw new AppError('not_found', 'errors.notFound');
  return result.rows[0].document;
}
export async function saveDraft(c: CommandContext, draft: DraftDocument, insert = false): Promise<void> {
  if (insert) {
    await query(
      c.db,
      sql`INSERT INTO ${ident(c.schemas.app, 'ingest_drafts')}
      (id, org_id, table_id, format_id, file_id, revision, state, document)
      VALUES (${draft.id}, ${c.actor.orgId}, ${draft.tableId}, ${draft.formatId}, ${draft.fileId}, ${draft.revision}, ${draft.state}, ${JSON.stringify(draft)}::jsonb)`,
    );
  } else {
    const saved = await query(
      c.db,
      sql`UPDATE ${ident(c.schemas.app, 'ingest_drafts')}
      SET revision = ${draft.revision}, state = ${draft.state}, document = ${JSON.stringify(draft)}::jsonb,
        run_token = CASE WHEN ${draft.state} = 'discarded' THEN run_token ELSE NULL END, updated_at = now()
      WHERE org_id = ${c.actor.orgId} AND table_id = ${draft.tableId} AND id = ${draft.id} AND revision = ${draft.revision - 1}`,
    );
    if (!saved.rowCount) throw new AppError('conflict', 'ingest.tables.stale');
  }
}

export function draftResponse(draft: DraftDocument, evidence: boolean): IngestDraft {
  const summary: IngestDraft = {
    id: draft.id,
    tableId: draft.tableId,
    formatId: draft.formatId,
    fileId: draft.fileId,
    revision: draft.revision,
    state: draft.state,
    failure: draft.failure,
    rowCount: draft.rows.length,
    checkCount: draft.checks?.length ?? 0,
    passedCount: draft.checks?.filter((check) => check.passed).length ?? 0,
    markedRowCount: new Set(draft.mismatches.map((mismatch) => mismatch.rowId)).size,
    evidenceWithheld: !evidence,
  };
  return evidence
    ? {
        ...summary,
        rows: draft.rows,
        checks: draft.checks ?? [],
        corrections: draft.corrections,
        mismatches: draft.mismatches,
      }
    : summary;
}
