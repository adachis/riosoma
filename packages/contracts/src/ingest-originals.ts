import { z } from 'zod';
import { TableId } from './data/fields.js';
import { IngestOrganizationSettings, IngestOriginalKeepDays } from './ingest-tables.js';

export const IngestOriginalShare = z.strictObject({
  kind: z.enum(['view', 'interface', 'site']),
  id: z.string().min(1).max(200),
});
export const IngestOriginalCommand = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ingest.originals.readOnly'), enabled: z.boolean() }),
  z.strictObject({
    kind: z.literal('ingest.originals.share'),
    share: IngestOriginalShare,
    enabled: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('ingest.originals.retention'),
    keepDays: IngestOriginalKeepDays.nullable(),
    confirmationToken: z.string().max(4096).optional(),
  }),
]);
export type IngestOriginalCommand = z.infer<typeof IngestOriginalCommand>;
export const IngestOrganizationCommand = z.strictObject({
  kind: z.literal('organization.ingest'),
  settings: IngestOrganizationSettings,
  confirmationToken: z.string().max(4096).optional(),
});
export type IngestOrganizationCommand = z.infer<typeof IngestOrganizationCommand>;
export const IngestRetentionResult = z.strictObject({
  status: z.enum(['applied', 'confirmation-required']),
  originals: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  examples: z.number().int().nonnegative(),
  confirmationToken: z.string().optional(),
});
export type IngestRetentionResult = z.infer<typeof IngestRetentionResult>;
export const IngestOriginalExpired = z.strictObject({
  outcome: z.literal('expired'),
  tableId: TableId,
  fileId: z.string().min(1).max(200),
  messageId: z.literal('ingest.pipeline.originalExpired'),
});
