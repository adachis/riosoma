import type { FastifyInstance } from 'fastify';
import type { IngestFileCounts, IngestRowReason, ErrorBody } from '@riosoma/contracts';
import type { IngestRow } from '@riosoma/ingest';
import type { Queryable } from '@riosoma/db';

export interface WriteRow extends IngestRow {
  aiFields: readonly string[];
  reasons: readonly IngestRowReason[];
  held?: { questionId: string } | null;
}
export interface WriterServices {
  app: FastifyInstance;
  /** Corrections and their saved answers commit together in the caller's command transaction. */
  transaction?: Queryable;
  /** Only fields created by this answer may initialize blank cells without a previous process hash. */
  createdFieldKeys?: readonly string[];
  /** Person whose requested row action is checked in every writer batch. */
  userId?: string;
  /** A pipeline claim fences each batch against expiry and replacement. */
  lease?: { fileId: string; token: string };
  /** The saved reading identifies input while decisions change across resumes. */
  checkpointInputId?: string;
  /** Unknown arrivals settle every identity disagreement before their first row write. */
  requireAllDecisions?: boolean;
  /** A study keeps its arrival available when undoing writes for a skip decision. */
  preserveFileState?: boolean;
  /** Explicit field answers may fill existing records while arrivals wait. */
  allowPaused?: boolean;
  /** The caller renders catalog messages in the table owner's language. */
  message: (id: string, params?: Record<string, string | number | boolean>) => string;
}
export interface IdentityChoice {
  choice: 'keepTable' | 'takeFile';
  /** A repeated identity requires the person to select one zero-based input position. */
  row?: number;
  /** Required when the table itself contains more than one record with this identity. */
  recordId?: string;
}
export interface Disagreement {
  identity: string;
  kind: 'different' | 'repeated-file-identity' | 'repeated-table-identity';
  messageId: string;
  rows: number[];
  records: Array<{ id: string; values: Record<string, unknown> }>;
}
export interface RefusedRow {
  row: number;
  recordId: string;
  at: IngestRow['at'];
  reason: ErrorBody['error'];
}
export interface UntouchedCell {
  recordId: string;
  fieldKey: string;
  messageId: 'ingest.write.handEdit';
}
export interface WriteResult {
  status: 'written' | 'disagreement' | 'stopped';
  messageId?: string;
  counts: IngestFileCounts;
  comparison: { identical: number; different: number; fileOnly: number; tableOnly: number };
  disagreements: Disagreement[];
  refused: RefusedRow[];
  cellsLeftAlone: UntouchedCell[];
  held: Array<{ row: number; questionId: string }>;
  undoGroupId: string;
  busCalls: number;
}
