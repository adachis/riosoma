import { z } from 'zod';
import { FieldId, TableId, UserId, RecordId } from './data/fields.js';
import { IngestFieldKey } from './ingest-fields.js';

const id = z.string().min(1).max(200);
const count = z.number().int().nonnegative();
const time = z.iso.datetime();
export const IngestOriginalKeepDays = z.union([z.number().int().min(1).max(3650), z.literal('forever')]);
export const IngestOrganizationSettings = z.strictObject({
  originalKeepDays: IngestOriginalKeepDays.default(90),
  probationFiles: z.number().int().min(1).max(10).default(3),
});
export type IngestOrganizationSettings = z.infer<typeof IngestOrganizationSettings>;
export const IngestTableSettings = z
  .strictObject({
    state: z.enum(['setup', 'live', 'paused']),
    ownerId: UserId.nullable(),
    rowMeaning: z.string().max(4096),
    identity: z.array(IngestFieldKey).min(1).nullable(),
    identityDecided: z.boolean().optional(),
    fields: z.array(
      z.strictObject({
        key: IngestFieldKey,
        fieldId: FieldId,
        meaning: z.string().max(4096),
        required: z.boolean(),
      }),
    ),
    originals: z.strictObject({
      keepDays: IngestOriginalKeepDays.nullable(),
      readOnlyAccess: z.boolean().default(false),
    }),
    reply: z.boolean().default(true),
    revision: count,
  })
  .superRefine((value, context) => {
    const keys = new Set(value.fields.map((field) => field.key));
    if (
      keys.size !== value.fields.length ||
      new Set(value.fields.map((field) => field.fieldId)).size !== value.fields.length ||
      (value.identity &&
        (new Set(value.identity).size !== value.identity.length ||
          value.identity.some((key) => !keys.has(key)))) ||
      (value.state !== 'setup' && !value.ownerId)
    )
      context.addIssue({ code: 'custom', message: 'ingest.tables.invalid' });
  });
export type IngestTableSettings = z.infer<typeof IngestTableSettings>;
const context = { orgId: id, tableId: TableId };
export const IngestSender = z.strictObject({
  ...context,
  id,
  label: z.string().max(4096),
  kind: z.enum(['address', 'domain']),
  value: z.string().trim().toLowerCase().min(1).max(320),
  approved: z.boolean(),
  addedBy: UserId.nullable(),
  addedAt: time,
});
export type IngestSender = z.infer<typeof IngestSender>;
export const IngestSignature = z.strictObject({
  id,
  kind: z.enum(['workbook', 'text', 'pdf', 'email', 'image', 'tree', 'archive']),
  headerGroups: z.array(z.array(z.string().min(1)).min(1)),
  markers: z.array(z.string().min(1)),
  markerRows: z.number().int().positive().optional(),
});
export const IngestFormat = z
  .strictObject({
    ...context,
    id,
    name: z.string().min(1).max(4096),
    state: z.enum(['draft', 'probation', 'live', 'failing']),
    signature: IngestSignature,
    reading: z.enum(['layout', 'reader', 'ai']),
    rules: z.record(z.string(), z.unknown()).nullable(),
    checks: z.record(z.string(), z.unknown()).optional(),
    valueSources: z.record(z.string(), z.unknown()).optional(),
    blindFailures: count.optional(),
    studyFileId: id.nullable().optional(),
    ignoredHeadings: z.array(z.string()).optional(),
    unknownSenderId: id.nullable().optional(),
    probationPassed: count,
    revision: count,
    createdBy: UserId.nullable(),
    createdAt: time,
    updatedAt: time,
  })
  .refine((format) => (format.reading === 'ai' ? format.rules === null : format.rules !== null));
export type IngestFormat = z.infer<typeof IngestFormat>;
export const IngestFileCounts = z.strictObject({
  added: count,
  updated: count,
  identical: count,
  flagged: count,
  refused: count,
});
export type IngestFileCounts = z.infer<typeof IngestFileCounts>;
export const IngestFile = z.strictObject({
  ...context,
  id,
  parentId: id.nullable(),
  origin: z.enum(['drop', 'email', 'part']),
  name: z.string().max(4096),
  mediaType: z.string().max(200),
  sizeBytes: count,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  storedFile: id.nullable(),
  senderId: id.nullable(),
  droppedBy: UserId.nullable(),
  receivedAt: time,
  seq: count,
  state: z.enum(['received', 'held', 'waiting', 'reading', 'read', 'failed', 'skipped', 'removed']),
  holdReason: id.nullable(),
  formatId: id.nullable(),
  counts: IngestFileCounts,
  notes: z.array(
    z.strictObject({
      messageId: id,
      params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    }),
  ),
  checks: z.record(z.string(), z.unknown()),
  expiresAt: time.nullable(),
  originalExpiredAt: time.nullable().optional(),
  isExample: z.boolean(),
  attempts: count,
  leaseUntil: time.nullable(),
  leasedBy: id.nullable(),
  nextAttemptAt: time.nullable(),
});
export type IngestFile = z.infer<typeof IngestFile>;
export const IngestExampleDifference = z.strictObject({
  row: count,
  key: IngestFieldKey.nullable(),
  expected: z.unknown(),
  actual: z.unknown(),
  kind: z
    .enum(['cell', 'missing-row', 'extra-row', 'duplicate-expected-identity', 'duplicate-actual-identity'])
    .optional(),
  messageId: id.optional(),
  identity: z.record(IngestFieldKey, z.json()).nullable().optional(),
  expectedPosition: count.nullable().optional(),
  actualPosition: count.nullable().optional(),
  run: z.union([z.literal(1), z.literal(2)]).optional(),
});
export const IngestExampleFailure = z.strictObject({
  kind: z.enum([
    'cannot-run-yet',
    'original-expired',
    'original-unavailable',
    'extraction-failed',
    'read-failed',
    'save-failed',
    'invalid-context',
  ]),
  messageId: id,
  reasonId: id.optional(),
  details: z.json().optional(),
  run: z.union([z.literal(1), z.literal(2)]).optional(),
});
export const IngestExampleResult = z.strictObject({
  passed: z.boolean(),
  differences: z.array(IngestExampleDifference),
  status: z.enum(['passed', 'failed', 'cannot-run-yet']).optional(),
  failure: IngestExampleFailure.optional(),
  runs: z
    .array(
      z.strictObject({
        run: z.union([z.literal(1), z.literal(2)]),
        passed: z.boolean(),
        differences: z.array(IngestExampleDifference),
        failure: IngestExampleFailure.optional(),
      }),
    )
    .optional(),
});
export const IngestExample = z.strictObject({
  ...context,
  id,
  formatId: id,
  fileId: id,
  expected: z.array(z.strictObject({ values: z.record(IngestFieldKey, z.unknown()) })),
  own: z.boolean(),
  confirmedAt: time,
  confirmedBy: UserId.nullable(),
  confirmedFindings: z
    .array(
      z.strictObject({
        kind: id,
        messageId: id,
        blocks: z.literal(false),
        facts: z.record(z.string(), z.unknown()),
      }),
    )
    .optional(),
  lastResult: IngestExampleResult.nullable(),
  builderShown: z.boolean().optional(),
});
export type IngestExample = z.infer<typeof IngestExample>;
export const IngestRowReason = z.strictObject({
  messageId: id,
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  fieldKey: IngestFieldKey.optional(),
  source: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('question'), questionId: id }),
    z.strictObject({ kind: z.literal('check'), name: id }),
    z.strictObject({ kind: z.literal('model') }),
  ]),
});
export type IngestRowReason = z.infer<typeof IngestRowReason>;
const rowLocation = z.strictObject({
  sheet: z.string().optional(),
  row: count.optional(),
  page: count.optional(),
  line: count.optional(),
  table: count.optional(),
});
const writtenRow = {
  fileId: id,
  identity: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  hashes: z.record(IngestFieldKey, z.string().regex(/^[a-f0-9]{64}$/)),
  values: z.record(IngestFieldKey, z.json()).default({}),
  at: rowLocation.default({}),
  reasons: z.array(IngestRowReason).default([]),
};
export const IngestRowState = z.strictObject({
  ...context,
  recordId: RecordId,
  ...writtenRow,
  createdByFileId: id.nullable().default(null),
  history: z.array(z.strictObject({ ...writtenRow, fileId: id.nullable() })).default([]),
});
export type IngestRowState = z.infer<typeof IngestRowState>;
export const IngestOrigin = z.strictObject({ kind: z.literal('ingest'), fileId: id });
export type IngestOrigin = z.infer<typeof IngestOrigin>;
