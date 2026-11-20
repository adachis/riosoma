import { z } from 'zod';
import { CommandId, FieldId, FieldMeta, FieldType, LIMITS, Name, RecordId, TableId } from './data/fields.js';
import { IngestDraftCommand, IngestSetupUpload } from './ingest-drafts.js';
import { SPREADSHEET_LIMITS } from './data/imports.js';
import { INGEST_PROCESS_FIELDS, IngestFieldKey } from './ingest-fields.js';
import {
  IngestExample,
  IngestFile,
  IngestFormat,
  IngestSender,
  IngestSignature,
  IngestTableSettings,
} from './ingest-tables.js';
import { CommandResult } from './data/commands.js';

const id = z.string().min(1).max(200);
const revision = z.number().int().nonnegative();
const outputFieldKey = IngestFieldKey.refine((key) => !Object.hasOwn(INGEST_PROCESS_FIELDS, key), {
  message: 'ingest.tables.invalid',
});
export { IngestSetupUpload } from './ingest-drafts.js';
export const IngestExpectedInput = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('upload'), file: IngestSetupUpload }),
  z.strictObject({ kind: z.literal('paste'), text: z.string().max(SPREADSHEET_LIMITS.uploadBytes) }),
  z.strictObject({
    kind: z.literal('records'),
    recordIds: z.array(RecordId).min(1).max(LIMITS.recordsPerCommand),
  }),
  z.strictObject({ kind: z.literal('draft'), exampleId: id }),
]);
export const IngestOutputInput = z
  .strictObject({
    revision,
    rowMeaning: z.string().max(4096),
    identity: z.array(IngestFieldKey).min(1).nullable(),
    fields: z
      .array(
        z.strictObject({
          key: outputFieldKey,
          field: z.union([
            z.strictObject({ id: FieldId }),
            z.strictObject({
              name: Name,
              type: FieldType,
              options: z.record(z.string(), z.unknown()).optional(),
            }),
          ]),
          meaning: z.string().max(4096),
          required: z.boolean(),
          allowedValues: z.array(Name).max(LIMITS.choicesPerField).optional(),
        }),
      )
      .max(LIMITS.fieldsPerTable),
  })
  .superRefine((value, context) => {
    const keys = new Set(value.fields.map((field) => field.key));
    if (
      keys.size !== value.fields.length ||
      value.identity?.some((key) => !keys.has(key)) ||
      (value.identity && new Set(value.identity).size !== value.identity.length)
    )
      context.addIssue({ code: 'custom', message: 'ingest.tables.invalid' });
  });
export type IngestOutputInput = z.infer<typeof IngestOutputInput>;

const base = { id: CommandId, tableId: TableId };
export const IngestSetupCommand = z.discriminatedUnion('kind', [
  ...IngestDraftCommand.options,
  z.strictObject({ ...base, kind: z.literal('ingest.begin') }),
  z.strictObject({ ...base, kind: z.literal('ingest.output'), output: IngestOutputInput }),
  z.strictObject({ ...base, kind: z.literal('ingest.propose'), file: IngestSetupUpload }),
  z.strictObject({
    ...base,
    kind: z.literal('ingest.sender.add'),
    label: Name,
    senderKind: z.enum(['address', 'domain']),
    value: z.string().trim().toLowerCase().min(1).max(320),
    approved: z.boolean().default(false),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('ingest.sender.update'),
    senderId: id,
    label: Name.optional(),
    approved: z.boolean().optional(),
  }),
  z.strictObject({ ...base, kind: z.literal('ingest.sender.remove'), senderId: id }),
  z.strictObject({ ...base, kind: z.literal('ingest.format.add'), name: Name }),
  z.strictObject({ ...base, kind: z.literal('ingest.format.rename'), formatId: id, name: Name }),
  z.strictObject({ ...base, kind: z.literal('ingest.format.remove'), formatId: id }),
  z.strictObject({
    ...base,
    kind: z.literal('ingest.format.rules'),
    formatId: id,
    revision,
    signature: IngestSignature,
    reading: z.enum(['layout', 'reader', 'ai']),
    rules: z.record(z.string(), z.unknown()).nullable(),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('ingest.example.add'),
    formatId: id,
    file: IngestSetupUpload,
    expected: IngestExpectedInput,
    confirm: z.boolean().default(false),
    confirmationId: CommandId.optional(),
  }),
  z.strictObject({ ...base, kind: z.literal('ingest.example.remove'), exampleId: id }),
  z.strictObject({ ...base, kind: z.literal('ingest.goLive') }),
  z.strictObject({ ...base, kind: z.literal('ingest.pause') }),
  z.strictObject({ ...base, kind: z.literal('ingest.resume') }),
  z.strictObject({ ...base, kind: z.literal('ingest.takeOver') }),
  z.strictObject({
    ...base,
    kind: z.literal('ingest.redo'),
    revision,
    confirm: z.boolean().default(false),
    dryRun: z.boolean().default(false),
  }),
  z.strictObject({ ...base, kind: z.literal('ingest.turnOff') }),
]);
export type IngestSetupCommand = z.infer<typeof IngestSetupCommand>;

export const IngestReadinessGap = z.strictObject({
  messageId: id,
  facts: z.record(z.string(), z.json()),
});
export type IngestReadinessGap = z.infer<typeof IngestReadinessGap>;
export const IngestReadiness = z.strictObject({
  ready: z.boolean(),
  gates: z.array(
    z.strictObject({
      id: z.enum(['G1', 'G2', 'G3', 'G4', 'G5', 'G6']),
      met: z.boolean(),
      gaps: z.array(IngestReadinessGap),
    }),
  ),
  formats: z.array(z.strictObject({ formatId: id, ready: z.boolean(), gaps: z.array(IngestReadinessGap) })),
});
export type IngestReadiness = z.infer<typeof IngestReadiness>;
export const IngestSetupDetails = z.strictObject({
  settings: IngestTableSettings,
  fields: z.array(FieldMeta),
  formats: z.array(IngestFormat),
  examples: z.array(IngestExample),
  senders: z.array(IngestSender),
  files: z.array(
    IngestFile.pick({
      id: true,
      name: true,
      mediaType: true,
      sizeBytes: true,
      sha256: true,
      receivedAt: true,
      expiresAt: true,
      formatId: true,
      senderId: true,
      isExample: true,
    }),
  ),
});
export type IngestSetupDetails = z.infer<typeof IngestSetupDetails>;
export const IngestSheetProposal = z.strictObject({
  fields: z.array(
    z.strictObject({
      heading: z.string(),
      key: outputFieldKey,
      type: FieldType,
      hasEmpty: z.boolean(),
      examples: z.array(z.json()).max(3),
    }),
  ),
});

export type IngestSheetProposal = z.infer<typeof IngestSheetProposal>;

export const IngestSetupResult = CommandResult.extend({
  details: z.record(z.string(), z.unknown()).optional(),
});
export type IngestSetupResult = z.infer<typeof IngestSetupResult>;
