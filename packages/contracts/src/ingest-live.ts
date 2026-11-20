import { z } from 'zod';
import { IngestDecisionAnswer, IngestDecisionQuestion, IngestDecisionRule } from './ingest-decisions.js';
import { IngestExample, IngestFile, IngestFormat, IngestTableSettings } from './ingest-tables.js';
import { TableId } from './data/fields.js';
import { IngestValueSource } from './ingest-build.js';

const id = z.string().min(1).max(4096);
export const IngestLivePage = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
export type IngestLivePage = z.infer<typeof IngestLivePage>;

export const IngestLiveAnswer = z
  .strictObject({
    questionVersion: id,
    response: IngestDecisionAnswer.shape.response,
    remember: z.boolean().default(false),
    scope: IngestDecisionRule.shape.scope.optional(),
    source: IngestValueSource.optional(),
  })
  .refine((value) => value.remember === (value.scope !== undefined));
export type IngestLiveAnswer = z.infer<typeof IngestLiveAnswer>;

export const IngestLiveRequest = z.strictObject({
  id,
  state: z.enum(['queued', 'running', 'complete', 'failed']),
  messageId: id.nullable(),
  undoGroupId: id.nullable(),
});
export type IngestLiveRequest = z.infer<typeof IngestLiveRequest>;

export const IngestLiveQuestion = z.strictObject({
  id,
  version: id,
  kind: id,
  messageId: id,
  state: z.enum(['open', 'answered']),
  fileId: id,
  createdAt: id,
  defaultScope: IngestDecisionQuestion.shape.defaultScope,
  allowedScopes: IngestDecisionQuestion.shape.allowedScopes,
  allowUnknown: z.boolean(),
  exits: IngestDecisionQuestion.shape.exits,
  canRemember: z.boolean(),
  application: IngestLiveRequest.optional(),
  evidenceWithheld: z.boolean(),
  details: IngestDecisionQuestion.optional(),
});
export type IngestLiveQuestion = z.infer<typeof IngestLiveQuestion>;

export const IngestLiveFile = z.strictObject({
  id,
  name: z.string(),
  state: IngestFile.shape.state,
  holdReason: IngestFile.shape.holdReason,
  sender: z.strictObject({ id: id.nullable(), label: z.string().nullable(), userId: id.nullable() }),
  format: z.strictObject({ id: id.nullable(), name: z.string().nullable() }),
  counts: IngestFile.shape.counts,
  receivedAt: id,
  originalKept: z.boolean(),
  isExample: z.boolean(),
  evidenceWithheld: z.boolean(),
  notes: IngestFile.shape.notes.optional(),
  checks: IngestFile.shape.checks.optional(),
  questions: z.array(IngestLiveQuestion).optional(),
  questionsNextOffset: z.number().int().nullable().optional(),
});
export type IngestLiveFile = z.infer<typeof IngestLiveFile>;

export const IngestLiveRule = z.strictObject({
  id,
  kind: id,
  enabled: z.boolean(),
  createdBy: id.nullable(),
  createdAt: id,
  scope: z.strictObject({ messageId: id, params: z.record(z.string(), z.string()) }),
  evidenceWithheld: z.boolean(),
  details: IngestDecisionRule.optional(),
});
export type IngestLiveRule = z.infer<typeof IngestLiveRule>;
export const IngestLiveExample = z.strictObject({
  id,
  fileId: id,
  passed: z.boolean().nullable(),
  evidenceWithheld: z.boolean(),
  details: IngestExample.optional(),
});
export type IngestLiveExample = z.infer<typeof IngestLiveExample>;
export const IngestLiveFormat = z.strictObject({
  id,
  name: z.string(),
  state: IngestFormat.shape.state,
  reading: IngestFormat.shape.reading,
  probationPassed: z.number().int().nonnegative(),
  mapping: z.record(z.string(), z.unknown()).optional(),
  code: z.string().optional(),
  evidenceWithheld: z.boolean(),
  examples: z.array(IngestLiveExample),
  examplesNextOffset: z.number().int().nullable(),
});
export type IngestLiveFormat = z.infer<typeof IngestLiveFormat>;
export const IngestLiveSummary = z.strictObject({
  state: IngestTableSettings.shape.state,
  openQuestions: z.number().int().nonnegative(),
  heldFiles: z.number().int().nonnegative(),
  lastReceivedAt: id.nullable(),
});
export type IngestLiveSummary = z.infer<typeof IngestLiveSummary>;
export const IngestLiveEvent = z.strictObject({
  type: z.literal('ingestChanged'),
  databaseId: id,
  tableId: TableId,
  kind: z.enum(['file', 'question', 'rule', 'build']),
  id,
  state: id,
});
export type IngestLiveEvent = z.infer<typeof IngestLiveEvent>;
