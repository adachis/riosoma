import { z } from 'zod';
import { DatabaseId } from './data/fields.js';

export const KnowledgeLabel = z.enum(['public', 'internal', 'confidential', 'restricted']);
export type KnowledgeLabel = z.infer<typeof KnowledgeLabel>;
export const LibraryScope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('organization') }),
  z.object({ kind: z.literal('unit'), unitId: z.string().min(1).max(100) }),
  z.object({ kind: z.literal('database'), databaseId: DatabaseId }),
  z.object({ kind: z.literal('personal') }),
]);
export type LibraryScope = z.infer<typeof LibraryScope>;
export const LibrarySettings = z.object({
  documents: z.number().int().min(1).max(1000).default(100),
  uploadBytes: z
    .number()
    .int()
    .min(1024)
    .max(10 * 1024 * 1024)
    .default(5 * 1024 * 1024),
  extractedCharacters: z.number().int().min(1000).max(500000).default(100000),
  rules: z
    .object({
      public: z.enum(['allowed', 'local', 'blocked']).default('allowed'),
      internal: z.enum(['allowed', 'local', 'blocked']).default('allowed'),
      confidential: z.enum(['allowed', 'local', 'blocked']).default('local'),
      restricted: z.enum(['allowed', 'local', 'blocked']).default('blocked'),
    })
    .prefault({}),
  searchPowerWatts: z.number().finite().positive().max(1000000).nullable().default(null),
});
export const LibraryDetails = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(300),
  label: KnowledgeLabel.default('internal'),
  guidance: z.string().trim().max(1000).default(''),
});
export type KnowledgeLibrary = z.infer<typeof LibraryDetails> & {
  id: string;
  scope: LibraryScope;
  canManage: boolean;
};
export interface KnowledgeDocument {
  id: string;
  libraryId: string;
  name: string;
  size: number;
  /** `indexing` while its background job reads and embeds it, which the library screen can stop */
  status: 'indexing' | 'ready' | 'failed' | 'blocked';
  errorKey: string | null;
  updatedAt: string;
}
export interface KnowledgePassage {
  documentId: string;
  libraryId: string;
  document: string;
  section: string;
  text: string;
  score: number;
  url: string;
}
export const SearchKnowledge = z.object({
  query: z.string().trim().min(1).max(2000),
  libraryId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(8).default(5),
});
const id = z.string().uuid();
export const LibraryCommand = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('library.dismissReview'), id, reviewId: z.string().min(1).max(100) }),
  z.object({
    kind: z.literal('library.save'),
    id,
    libraryId: id,
    scope: LibraryScope,
    details: LibraryDetails,
  }),
  z.object({
    kind: z.literal('library.document'),
    id,
    libraryId: id,
    documentId: id,
    name: z.string().trim().min(1).max(200),
    source: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('text'), text: z.string().trim().min(1).max(500000) }),
      z.object({
        kind: z.literal('file'),
        base64: z
          .string()
          .min(1)
          .max(14 * 1024 * 1024),
      }),
    ]),
  }),
  z.object({ kind: z.literal('library.deleteDocument'), id, libraryId: id, documentId: id }),
  z.object({ kind: z.literal('library.index'), id, libraryId: id, documentId: id }),
  z.object({ kind: z.literal('library.cancelIndex'), id, libraryId: id, documentId: id }),
  z.object({ kind: z.literal('library.undo'), id, actionId: id }),
]);
export type LibraryCommand = z.infer<typeof LibraryCommand>;
