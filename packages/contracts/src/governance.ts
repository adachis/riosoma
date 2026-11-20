import { z } from 'zod';
import type { ErrorBody } from './errors.js';
import { CommandId, ChoiceColor, DatabaseId, FieldId, TableId } from './data/fields.js';

export const CLASSIFICATION_LIMIT = 12;
export const AUDIT_RETENTION_FLOOR_DAYS = 365;
export const ClassificationRules = z.strictObject({
  noPublicLinks: z.boolean().default(false),
  noExport: z.boolean().default(false),
  noProviders: z.boolean().default(false),
  noExternalSharing: z.boolean().default(false),
  maskGuests: z.boolean().default(false),
});
export type ClassificationRules = z.infer<typeof ClassificationRules>;
export const ClassificationLabelId = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const ClassificationLabel = z.strictObject({
  id: ClassificationLabelId,
  name: z.string().trim().min(1).max(80),
  color: ChoiceColor,
  description: z.string().max(1000),
  rules: ClassificationRules,
});
export type ClassificationLabel = z.infer<typeof ClassificationLabel>;
export const ClassificationLabels = z
  .array(ClassificationLabel)
  .max(CLASSIFICATION_LIMIT)
  .refine(
    (labels) =>
      new Set(labels.map((label) => label.id)).size === labels.length &&
      new Set(labels.map((label) => label.name.toLowerCase())).size === labels.length,
  );

const days = z.number().int().min(1).max(36500).nullable();
/** Null keeps data indefinitely, and an omitted database value inherits the organization. */
export const RetentionPolicy = z.strictObject({
  trashDays: days.optional(),
  historyDays: days.optional(),
  deletedCommentsDays: days.optional(),
  automationRunsDays: days.optional(),
  routineRunsDays: days.optional(),
  auditDays: z.number().int().min(AUDIT_RETENTION_FLOOR_DAYS).max(36500).nullable().optional(),
});
export type RetentionPolicy = z.infer<typeof RetentionPolicy>;
export const RETENTION_DEFAULTS: Required<RetentionPolicy> = {
  trashDays: 30,
  historyDays: null,
  deletedCommentsDays: 30,
  automationRunsDays: 30,
  routineRunsDays: 90,
  auditDays: null,
};

export const ClassificationTarget = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('database'), databaseId: DatabaseId }),
  z.strictObject({ kind: z.literal('table'), databaseId: DatabaseId, tableId: TableId }),
  z.strictObject({ kind: z.literal('field'), databaseId: DatabaseId, fieldId: FieldId }),
]);
export type ClassificationTarget = z.infer<typeof ClassificationTarget>;
export const GovernanceAction = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('classification.labels'), labels: ClassificationLabels }),
  z.strictObject({
    kind: z.literal('classification.assign'),
    target: ClassificationTarget,
    labelId: ClassificationLabelId.nullable(),
  }),
  z.strictObject({
    kind: z.literal('retention.set'),
    databaseId: DatabaseId.nullable(),
    policy: RetentionPolicy,
    legalHold: z.boolean().default(false),
  }),
]);
export type GovernanceAction = z.infer<typeof GovernanceAction>;
export const GovernanceCommand = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('governance.apply'), id: CommandId, action: GovernanceAction }),
  z.strictObject({ kind: z.literal('governance.undo'), id: CommandId, undoOf: CommandId }),
]);
export type GovernanceCommand = z.infer<typeof GovernanceCommand>;
export interface GovernanceResult {
  id: string;
  status: 'applied' | 'duplicate' | 'rejected';
  error?: ErrorBody['error'];
}
export interface GovernanceView {
  databases: Array<{ id: string; name: string }>;
  names: Record<string, string>;
  labels: ClassificationLabel[];
  policy: RetentionPolicy;
  effective: Required<RetentionPolicy>;
  legalHold: boolean;
  assignments: Array<{ target: ClassificationTarget; labelId: string | null }>;
}
