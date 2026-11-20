import { z } from 'zod';
import { CommandId, TableId } from './data/fields.js';
import { SPREADSHEET_LIMITS } from './data/imports.js';
import { IngestFieldKey } from './ingest-fields.js';

const id = z.string().min(1).max(200);
const revision = z.number().int().nonnegative();
export const IngestSetupUpload = z.strictObject({
  name: z.string().min(1).max(1000),
  base64: z
    .string()
    .max(Math.ceil(SPREADSHEET_LIMITS.uploadBytes / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  mediaType: z.string().max(200).optional(),
});

export const IngestDraftState = z.enum(['drafting', 'ready', 'failed', 'confirmed', 'discarded']);
export const IngestDraftFailure = z.enum([
  'aiOff',
  'ingestOff',
  'classification',
  'unsupported',
  'tooLarge',
  'fileLimit',
  'unpriced',
  'dynamicChoices',
  'monthlyBudget',
  'providerUnavailable',
  'keyRefused',
  'outputChanged',
  'inputUnavailable',
  'invalidReading',
]);
export const IngestDraftPlace = z
  .strictObject({
    sheet: z.string().min(1).max(1000).optional(),
    row: z.number().int().positive().optional(),
    page: z.number().int().positive().optional(),
    line: z.number().int().positive().optional(),
    table: z.number().int().positive().optional(),
  })
  .refine(
    (place) =>
      place.page !== undefined ||
      (place.row !== undefined && (place.sheet !== undefined || place.table !== undefined)),
    { message: 'ingest.tables.invalid' },
  );
export const IngestDraftRow = z.strictObject({
  id,
  values: z.record(IngestFieldKey, z.json()),
  at: IngestDraftPlace,
  doubts: z.array(IngestFieldKey),
  corrected: z.array(IngestFieldKey),
  needsCorrection: z.boolean(),
});
export const IngestSpotCheck = z.strictObject({
  id,
  rowId: id,
  field: IngestFieldKey,
  name: z.string(),
  meaning: z.string(),
  at: IngestDraftPlace,
  content: z.string(),
  choices: z.array(z.json()).max(4),
  noneMessageId: z.literal('ingest.drafts.none'),
  passed: z.boolean(),
});
export const IngestDraft = z.strictObject({
  id,
  tableId: TableId,
  formatId: id,
  fileId: id,
  revision,
  state: IngestDraftState,
  failure: IngestDraftFailure.nullable(),
  rowCount: z.number().int().nonnegative(),
  checkCount: z.number().int().nonnegative(),
  passedCount: z.number().int().nonnegative(),
  markedRowCount: z.number().int().nonnegative(),
  evidenceWithheld: z.boolean(),
  rows: z.array(IngestDraftRow).optional(),
  checks: z.array(IngestSpotCheck).optional(),
  corrections: z
    .array(z.strictObject({ rowId: id, field: IngestFieldKey, before: z.json(), after: z.json() }))
    .optional(),
  mismatches: z
    .array(
      z.strictObject({ checkId: id, rowId: id, field: IngestFieldKey, answer: z.json(), current: z.json() }),
    )
    .optional(),
});
export type IngestDraft = z.infer<typeof IngestDraft>;
export type IngestDraftRow = z.infer<typeof IngestDraftRow>;
export type IngestSpotCheck = z.infer<typeof IngestSpotCheck>;
export type IngestDraftFailure = z.infer<typeof IngestDraftFailure>;
const base = { id: CommandId, tableId: TableId };
const target = { ...base, draftId: id, revision };
export const IngestDraftCommand = z.discriminatedUnion('kind', [
  z.strictObject({ ...base, kind: z.literal('ingest.draft.start'), formatId: id, file: IngestSetupUpload }),
  z.strictObject({
    ...target,
    kind: z.literal('ingest.draft.correct'),
    rows: z
      .array(
        z.strictObject({
          id: id.optional(),
          values: z.record(IngestFieldKey, z.json()),
          at: IngestDraftPlace.optional(),
        }),
      )
      .max(SPREADSHEET_LIMITS.rowsPerSheet),
  }),
  z.strictObject({ ...target, kind: z.literal('ingest.draft.discard') }),
  z.strictObject({ ...target, kind: z.literal('ingest.draft.checks') }),
  z.strictObject({
    ...target,
    kind: z.literal('ingest.draft.answer'),
    checkId: id,
    answer: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('typed'), value: z.json() }),
      z.strictObject({ kind: z.literal('choice'), index: z.number().int().min(0).max(3) }),
      z.strictObject({ kind: z.literal('none'), value: z.json() }),
    ]),
  }),
  z.strictObject({
    ...target,
    kind: z.literal('ingest.draft.confirm'),
    confirm: z.boolean().default(false),
    confirmationId: CommandId.optional(),
  }),
]);
export type IngestDraftCommand = z.infer<typeof IngestDraftCommand>;
