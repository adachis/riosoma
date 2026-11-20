import { z } from 'zod';
import { LibrarySettings } from './knowledge-libraries.js';
import { DocumentImportSettings } from './document-import.js';
import { DatabaseId, TableId } from './data/fields.js';

const address = z
  .string()
  .url()
  .max(500)
  .refine((value) => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  });

const powerWatts = z.number().finite().positive().max(1_000_000).nullable().optional();

export const KnowledgeSettings = z.object({
  imports: DocumentImportSettings.optional(),
  libraries: LibrarySettings.prefault({}),
  memory: z.boolean().default(true),
  search: z
    .object({
      enabled: z.boolean().default(true),
      engine: z.enum(['searxng', 'subscription', 'research']).default('searxng'),
      address: address.nullable().default(null),
      powerWatts,
    })
    .prefault({}),
  embedding: z
    .object({
      providerId: z.string().min(2).max(32),
      model: z.string().trim().min(1).max(200),
      address,
      protocol: z.enum(['compatible', 'local']).default('compatible'),
      powerWatts,
    })
    .nullable()
    .default(null),
});
export type KnowledgeSettings = z.infer<typeof KnowledgeSettings>;

export const MemoryInput = z.object({
  databaseId: DatabaseId,
  visibility: z.enum(['personal', 'database']).default('personal'),
  memoryId: z.string().uuid(),
  text: z.string().trim().min(1).max(1000).nullable(),
});
export type MemoryInput = z.infer<typeof MemoryInput>;
export interface MemoryNote {
  remoteDataBlocked?: boolean;
  id: string;
  databaseId: string;
  visibility: 'personal' | 'database';
  text: string;
  updatedAt: string;
}

export const SimilarQuery = z.object({
  tableId: TableId,
  text: z.string().trim().min(1).max(2000),
  limit: z.number().int().min(1).max(20).default(10),
});
export const WebQuery = z.object({
  query: z.string().trim().min(1).max(1000),
  readPages: z.boolean().default(false),
});
export interface SearchSource {
  title: string;
  url: string;
  text: string;
}

export const KnowledgeCommand = z.discriminatedUnion('kind', [
  MemoryInput.extend({ kind: z.literal('memory.save'), id: z.string().uuid() }),
  z.object({
    kind: z.literal('knowledge.settings'),
    id: z.string().uuid(),
    settings: KnowledgeSettings,
    /** The paid search service's key, which a changed service or address needs entered again */
    searchKey: z.string().trim().min(1).max(10000).optional(),
  }),
  z.object({
    kind: z.literal('knowledge.key'),
    id: z.string().uuid(),
    engine: z.enum(['subscription', 'research']),
    key: z.string().trim().min(1).max(10000).nullable(),
  }),
  z.object({
    kind: z.literal('embedding.table'),
    id: z.string().uuid(),
    databaseId: DatabaseId,
    tableId: TableId,
    enabled: z.boolean(),
  }),
  z.object({ kind: z.literal('knowledge.undo'), id: z.string().uuid(), actionId: z.string().uuid() }),
]);
export type KnowledgeCommand = z.infer<typeof KnowledgeCommand>;
