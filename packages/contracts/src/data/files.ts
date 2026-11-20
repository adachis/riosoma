import { z } from 'zod';
import { AttachmentId, FieldId, RecordId, TableId } from './fields.js';

export const FileSettings = z
  .object({
    /** Null leaves attachment size unrestricted. */
    maxUploadBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().default(null),
  })
  .strict();
export type FileSettings = z.infer<typeof FileSettings>;

export const FileSettingsView = FileSettings.extend({ revision: z.string().length(64) });
export type FileSettingsView = z.infer<typeof FileSettingsView>;

export const FileSafetySettings = z
  .object({
    outsideFiles: z.enum(['requireScanner', 'builtInChecksOnly']).default('requireScanner'),
    allowOutsideMacros: z.boolean().default(false),
  })
  .strict();
export type FileSafetySettings = z.infer<typeof FileSafetySettings>;

export const ScannerAddress = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      if (url.username || url.password || url.search || url.hash) return false;
      if (url.protocol === 'unix:')
        return !url.host && url.pathname.startsWith('/') && url.pathname.length > 1;
      return (
        url.protocol === 'tcp:' &&
        Boolean(url.hostname) &&
        Number(url.port) > 0 &&
        Number(url.port) <= 65535 &&
        !url.pathname
      );
    } catch {
      return false;
    }
  });

export const FileScannerSettings = z
  .object({
    enabled: z.boolean(),
    address: ScannerAddress.nullable(),
    oversizedPolicy: z.enum(['quarantine', 'allow']).default('quarantine'),
  })
  .strict();
export type FileScannerSettings = z.infer<typeof FileScannerSettings>;
export interface FileScannerStatus {
  address: string | null;
  reachable: boolean;
  tested: boolean;
  signatureDate: string | null;
  /** A translated diagnostic key, never a raw network error. */
  lastError: string | null;
}
export interface FileScannerInfo {
  settings: FileScannerSettings;
  status: FileScannerStatus;
}

export const FileFromUrl = z.object({
  tableId: TableId,
  fieldId: FieldId,
  recordId: RecordId,
  url: z.string().trim().min(1).max(8192),
  filename: z.string().trim().min(1).max(255).optional(),
  imageSearchToken: z.string().min(1).max(24000).optional(),
});

export const ImageSearchTarget = FileFromUrl.pick({ tableId: true, fieldId: true, recordId: true });
export const ImageSearchQuery = ImageSearchTarget.extend({ query: z.string().trim().min(1).max(1000) });
export interface ImageSearchResult {
  title: string;
  sourceUrl: string;
  license?: string;
  url: string;
  token: string;
  preview: string;
}
export interface ImageSearchStatus {
  available: boolean;
  reason?: string;
  canConfigure: boolean;
}

/**
 * A file an attachment field holds.  Cells hold attachment IDs only; pages and the files route
 * carry these details beside them, the way pages carry linked records' names.
 *
 * Routes (session, read access to the table unless noted):
 * - `POST /api/tables/:tableId/fields/:fieldId/files` (edit access): one file as the raw request
 *   body, its name in `x-file-name` (percent-encoded), returns the new file's details.  The file
 *   isn't in any cell until a record command writes its ID.
 * - `GET /api/files?ids=att…,att…`: details of up to 200 files the person can read.
 * - `GET /api/files/:attachmentId/:name`: the file itself.
 * - `GET /api/files/:attachmentId/thumbnails/:size`: a PNG preview, `small` or `large`.
 */
export const AttachmentMeta = z.object({
  id: AttachmentId,
  name: z.string().min(1).max(255),
  /** Bytes */
  size: z.number().int().min(0),
  /** Media type, detected from the content rather than trusted from the name */
  type: z.string().max(255),
  /** Pixels, for images */
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  createdAt: z.string(),
  scanState: z
    .enum(['clean', 'quarantined', 'infected', 'unavailable', 'too_large', 'too_large_allowed'])
    .optional(),
  scanSignature: z.string().nullable().optional(),
  source: z.object({ url: z.string(), imageUrl: z.string(), license: z.string().optional() }).optional(),
  /** Where the file downloads from, relative to the server */
  url: z.string(),
  /** Scaled previews; null for files without one */
  thumbnails: z.object({ small: z.string().nullable(), large: z.string().nullable() }),
});
export type AttachmentMeta = z.infer<typeof AttachmentMeta>;

export const FILE_LIMITS = {
  nameLength: 255,
  detailsPerRequest: 200,
} as const;
