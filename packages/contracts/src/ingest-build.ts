import { z } from 'zod';
import { TableId } from './data/fields.js';
import { IngestExampleResult } from './ingest-tables.js';
import { IngestDecisionQuestion, IngestDecisionAnswer } from './ingest-decisions.js';

const id = z.string().min(1).max(200);
export const IngestBuildState = z.enum([
  'queued',
  'running',
  'waiting',
  'passed',
  'blindFailed',
  'stopped',
  'ceiling',
  'unavailable',
  'canceled',
]);
export type IngestBuildState = z.infer<typeof IngestBuildState>;
export const IngestBuildReason = z.enum([
  'aiOff',
  'ingestOff',
  'budgetSpent',
  'providerDown',
  'keyRefused',
  'classification',
  'attempts',
  'noProgress',
  'stale',
]);
export type IngestBuildReason = z.infer<typeof IngestBuildReason>;
export const IngestBuildAnswer = z.strictObject({
  questionVersion: id,
  response: IngestDecisionAnswer.shape.response,
  fact: z.json().optional(),
});
export type IngestBuildAnswer = z.infer<typeof IngestBuildAnswer>;
export const IngestValueSource = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('column'), aliases: z.array(z.string()) }),
  z.strictObject({ kind: z.literal('fixed'), value: z.json() }),
  z.strictObject({
    kind: z.literal('lookup'),
    aliases: z.array(z.string()),
    entries: z.record(z.string(), z.json()),
  }),
  z.strictObject({ kind: z.literal('emailSubject') }),
  z.strictObject({ kind: z.literal('fact'), key: id }),
  z.strictObject({ kind: z.literal('reader'), codeHash: z.string().regex(/^[a-f0-9]{64}$/) }),
]);
export type IngestValueSource = z.infer<typeof IngestValueSource>;
export const IngestBuild = z.strictObject({
  id,
  tableId: TableId,
  formatId: id,
  state: IngestBuildState,
  attempts: z.number().int().min(0).max(6),
  reading: z.enum(['layout', 'reader']).nullable(),
  spentUsd: z.number().nonnegative(),
  reason: IngestBuildReason.optional(),
  messageId: id.optional(),
  questionId: id.optional(),
  question: IngestDecisionQuestion.optional(),
  examples: z.array(
    z.strictObject({
      exampleId: id,
      passed: z.boolean(),
      differenceCount: z.number().int().nonnegative(),
      result: IngestExampleResult.optional(),
    }),
  ),
  readerReason: z.strictObject({ fieldKey: id.nullable(), kind: id, messageId: id }).optional(),
  unresolved: z.strictObject({ fieldKey: id.nullable(), kind: id, messageId: id }).optional(),
  needsExample: z.boolean(),
  offersAi: z.boolean(),
  evidenceWithheld: z.boolean(),
});
export type IngestBuild = z.infer<typeof IngestBuild>;
