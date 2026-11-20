import type { TableMeta, IngestFile, IngestRowReason } from '@riosoma/contracts';
import type {
  BuiltInRule,
  FormatDefinition,
  DecisionItem,
  DecisionQuestion,
  ExtractedSource,
  IngestRow,
  QuestionResponse,
} from '@riosoma/ingest';
import type { StoredIngestFormat } from '../tables/store.js';
import type { IngestWorker } from './worker.js';
import type { StudyResult } from '../study/runner.js';

export interface ReadingDoubt {
  item: DecisionItem;
  question: DecisionQuestion;
  builtIns?: BuiltInRule[];
}
export interface PipelineReading {
  rows: (IngestRow & { aiFields?: string[]; reasons?: IngestRowReason[] })[];
  flagged?: boolean;
  notes?: IngestFile['notes'];
  checks?: Record<string, unknown>;
  doubts?: ReadingDoubt[];
  failure?: { messageId: string; params?: Record<string, string | number | boolean> };
}
export interface PipelineFunctions {
  studyUnknown?: (
    source: ExtractedSource,
    table: TableMeta,
    context: { claim: IngestClaim; worker: IngestWorker },
  ) => Promise<StoredIngestFormat | FormatDefinition | StudyResult | null>;
  readWithAi?: (
    source: ExtractedSource,
    format: StoredIngestFormat,
    table: TableMeta,
    previousChecks?: PipelineReading['checks'],
  ) => Promise<PipelineReading | null>;
  attemptOnce?: (
    question: DecisionQuestion,
    evidence: DecisionQuestion['evidence'],
  ) => Promise<QuestionResponse | null>;
}
/** A caller can distinguish unavailable providers and spent budgets from broken reading code. */
export class TryLaterError extends Error {
  constructor(
    readonly messageId = 'ingest.pipeline.tryLater',
    readonly checks?: PipelineReading['checks'],
  ) {
    super(messageId);
  }
}
export function isTryLater(error: unknown): boolean {
  return (
    error instanceof TryLaterError ||
    (error instanceof Error &&
      (('tryLater' in error && error.tryLater === true) ||
        ('code' in error &&
          ['try_later', 'unavailable', 'provider_unavailable', 'budget_exhausted'].includes(
            String(error.code),
          )) ||
        /^try later$/i.test(error.message)))
  );
}
export interface PipelineJob {
  org_id: string;
  table_id: string;
  file_id: string;
  run_id: string;
  prepared: (PipelineReading & { reread?: boolean }) | null;
  question_ids: string[];
  notified_questions: string[];
  notified: boolean;
  attempts: Record<string, QuestionResponse | null>;
  started_at: Date | null;
  parts_created: boolean;
}
export interface IngestClaim {
  file: IngestFile;
  token: string;
  job: PipelineJob;
}
