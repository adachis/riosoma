import type { IngestBuild, IngestStudy, IngestStudyAssumption, IngestValueSource } from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { DecisionQuestion, QuestionResponse } from '@riosoma/ingest';
import type { BuildCheckpoint, Draft } from '../build/runner.js';
import type { PipelineStore } from '../pipeline/store.js';
import type { IngestClaim, PipelineReading } from '../pipeline/types.js';
import type { IngestContext } from '../tables/store.js';

export interface StudyDocument {
  state: IngestStudy['state'];
  messageId: string | null;
  draft: Draft | null;
  build: IngestBuild;
  checkpoint?: BuildCheckpoint;
  reading: PipelineReading | null;
  questions: DecisionQuestion[];
  assumptions: (Omit<IngestStudyAssumption, 'question' | 'answer'> & {
    question: DecisionQuestion;
    answer: QuestionResponse;
  })[];
  overrides: Record<string, QuestionResponse>;
  formatId: string | null;
  selectedFormatId?: string;
  ignored: string[];
  fieldRequests: string[];
  approvalPending: boolean;
  approvalNotified: boolean;
  sources: Record<string, IngestValueSource>;
  createdFields?: Record<string, { key: string; fieldId: string; commandId: string }>;
}

export async function loadStudy(
  store: PipelineStore,
  context: IngestContext,
  fileId: string,
  db: Queryable = store.data.pool,
) {
  const found = await query<{ document: StudyDocument }>(
    db,
    sql`SELECT document FROM ${ident(store.data.schemas.app, 'ingest_studies')}
      WHERE org_id = ${context.orgId} AND table_id = ${context.tableId} AND file_id = ${fileId}`,
  );
  return found.rows[0]?.document ?? null;
}

export async function saveStudy(
  store: PipelineStore,
  context: IngestContext,
  fileId: string,
  study: StudyDocument,
  db: Queryable,
) {
  await query(
    db,
    sql`INSERT INTO ${ident(store.data.schemas.app, 'ingest_studies')} (org_id, table_id, file_id, document)
    VALUES (${context.orgId}, ${context.tableId}, ${fileId}, ${JSON.stringify(study)}::jsonb)
    ON CONFLICT (org_id, table_id, file_id) DO UPDATE SET document = EXCLUDED.document, updated_at = now()`,
  );
}

export function checkpointStudy(store: PipelineStore, claim: IngestClaim, study: StudyDocument) {
  return store.fenced(claim, (db) => saveStudy(store, claim.file, claim.file.id, study, db));
}

export async function headingFiles(store: PipelineStore, context: IngestContext, questionId: string) {
  const found = await query<{ file_id: string; prepared: PipelineReading | null }>(
    store.data.pool,
    sql`SELECT file_id, prepared FROM ${ident(store.data.schemas.app, 'ingest_pipeline_jobs')}
      WHERE org_id = ${context.orgId} AND table_id = ${context.tableId}
        AND question_ids @> ${JSON.stringify([questionId])}::jsonb`,
  );
  return found.rows;
}
