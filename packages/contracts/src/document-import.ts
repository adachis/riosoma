import { z } from 'zod';
import { DatabaseId, TableId } from './data/fields.js';
import { KnowledgeLabel } from './knowledge-libraries.js';

export const DocumentImportSettings = z.object({
  uploadBytes: z
    .number()
    .int()
    .min(1024)
    .max(10 * 1024 * 1024)
    .default(5 * 1024 * 1024),
  pages: z.number().int().min(1).max(50).default(10),
  model: z
    .object({ providerId: z.string().min(2).max(32), model: z.string().trim().min(1).max(200) })
    .nullable()
    .default(null),
  /** A configured local model takes precedence and never falls back to a remote service. */
  localModel: z
    .object({ providerId: z.string().min(2).max(32), model: z.string().trim().min(1).max(200) })
    .nullable()
    .default(null),
  powerWatts: z.number().finite().positive().max(1_000_000).nullable().default(null),
});
export type DocumentImportSettings = z.infer<typeof DocumentImportSettings>;

export const DOCUMENT_IMPORT_LIMITS = { rows: 500, columns: 50, characters: 100_000 } as const;
export const DocumentColumnType = z.enum([
  'text',
  'longText',
  'number',
  'date',
  'dateTime',
  'checkbox',
  'email',
  'url',
  'phone',
]);
export type DocumentColumnType = z.infer<typeof DocumentColumnType>;

export const DocumentImportRequest = z.object({
  data: z
    .string()
    .min(4)
    .max(14 * 1024 * 1024),
  mediaType: z.enum([
    'image/png',
    'image/jpeg',
    'image/webp',
    'application/pdf',
    'text/csv',
    'text/tab-separated-values',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ]),
  label: KnowledgeLabel,
  locale: z.string().min(2).max(35),
  databaseId: DatabaseId.optional(),
  tableId: TableId.optional(),
});
export type DocumentImportRequest = z.infer<typeof DocumentImportRequest>;

export const DocumentImportPreview = z
  .object({
    columns: z
      .array(z.object({ name: z.string().trim().min(1).max(255), type: DocumentColumnType }))
      .min(1)
      .max(DOCUMENT_IMPORT_LIMITS.columns),
    rows: z
      .array(
        z
          .array(z.object({ value: z.string().max(4000), confidence: z.number().min(0).max(1) }))
          .max(DOCUMENT_IMPORT_LIMITS.columns),
      )
      .min(1)
      .max(DOCUMENT_IMPORT_LIMITS.rows),
  })
  .superRefine((value, ctx) => {
    if (value.rows.some((row) => row.length !== value.columns.length))
      ctx.addIssue({ code: 'custom', message: 'import.document.invalid' });
    if (new Set(value.columns.map((column) => column.name.toLowerCase())).size !== value.columns.length)
      ctx.addIssue({ code: 'custom', message: 'import.document.invalid' });
    if (
      value.rows.reduce((sum, row) => sum + row.reduce((size, cell) => size + cell.value.length, 0), 0) >
      DOCUMENT_IMPORT_LIMITS.characters
    )
      ctx.addIssue({ code: 'custom', message: 'import.document.tooLarge' });
  });
export type DocumentImportPreview = z.infer<typeof DocumentImportPreview>;

const range = z.object({ min: z.number().nonnegative(), max: z.number().nonnegative() });
export const DocumentImportResult = DocumentImportPreview.safeExtend({
  usage: z.object({
    providerId: z.string(),
    model: z.string(),
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    costUsd: z.number().nonnegative().nullable(),
    ms: z.number().nonnegative(),
    tokensEstimated: z.boolean().optional(),
    footprint: z.object({ energyWh: range, gwpG: range, method: z.string(), zone: z.string() }).nullable(),
  }),
});
export type DocumentImportResult = z.infer<typeof DocumentImportResult>;
