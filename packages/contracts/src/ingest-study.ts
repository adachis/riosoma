import { z } from 'zod';
import { IngestDecisionAnswer, IngestDecisionQuestion } from './ingest-decisions.js';
import { IngestLiveQuestion } from './ingest-live.js';
import { IngestBuildReason } from './ingest-build.js';

const id = z.string().min(1).max(4096);
export const IngestStudyAssumption = z.strictObject({
  id,
  messageId: id,
  reasonId: id,
  confirmed: z.boolean(),
  evidenceWithheld: z.boolean(),
  answer: IngestDecisionAnswer.shape.response.optional(),
  question: IngestDecisionQuestion.optional(),
});
export type IngestStudyAssumption = z.infer<typeof IngestStudyAssumption>;
export const IngestStudy = z.strictObject({
  fileId: id,
  state: z.enum(['studying', 'questions', 'ready', 'unavailable', 'skipped']),
  messageId: id.nullable(),
  reason: IngestBuildReason.optional(),
  formatId: id.nullable(),
  approvalPending: z.boolean(),
  spentUsd: z.number().nonnegative(),
  evidenceWithheld: z.boolean(),
  questions: z.array(IngestLiveQuestion),
  assumptions: z.array(IngestStudyAssumption),
});
export type IngestStudy = z.infer<typeof IngestStudy>;
export const IngestStudyAssumptionAnswer = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('confirm') }),
  z.strictObject({ action: z.literal('change'), response: IngestDecisionAnswer.shape.response }),
]);
export type IngestStudyAssumptionAnswer = z.infer<typeof IngestStudyAssumptionAnswer>;
