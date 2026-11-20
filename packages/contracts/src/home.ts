import { z } from 'zod';
import { HomeItemAction, HomeShortcut, HomeTag, HomeTagLink, HomeTagColor } from './home-items.js';
export * from './home-items.js';
import { CommandId, DatabaseId } from './data/fields.js';
import { DatabaseRole, DatabaseSummary } from './data/schema.js';
import { Principal } from './sharing.js';

export const FolderId = z.string().min(1).max(100);
const folder = { folderId: FolderId };
const move = {
  parentId: FolderId.nullable(),
  confirmedLosses: z.array(z.string()).max(10000).default([]),
};
export const HomeAction = z.discriminatedUnion('kind', [
  ...HomeItemAction.options,
  z.object({
    kind: z.literal('favorite.move'),
    databaseId: DatabaseId,
    position: z.number().finite(),
    beforeId: DatabaseId.nullable().optional(),
  }),
  z.object({ kind: z.literal('favorite.set'), databaseId: DatabaseId, favorite: z.boolean() }),
  z.object({ kind: z.literal('database.trash'), databaseId: DatabaseId }),
  z.object({ kind: z.literal('database.restore'), databaseId: DatabaseId }),
  z.object({
    kind: z.literal('folder.create'),
    ...folder,
    name: z.string().trim().min(1).max(120),
    parentId: FolderId.nullable().default(null),
  }),
  z.object({ kind: z.literal('folder.rename'), ...folder, name: z.string().trim().min(1).max(120) }),
  z.object({ kind: z.literal('folder.move'), ...folder, ...move }),
  z.object({ kind: z.literal('database.move'), databaseId: DatabaseId, ...move }),
  z.object({
    kind: z.literal('folder.share'),
    ...folder,
    principal: Principal,
    role: DatabaseRole.nullable(),
  }),
  z.object({ kind: z.literal('folder.trash'), ...folder }),
  z.object({ kind: z.literal('folder.restore'), ...folder }),
]);
export type HomeAction = z.infer<typeof HomeAction>;
export const HomeCommand = z
  .object({
    id: CommandId,
    action: HomeAction,
  })
  .strict();
export type HomeCommand = z.infer<typeof HomeCommand>;
export const HomeBatchCommand = HomeCommand.extend({
  actions: z.array(HomeAction).min(1).max(100).optional(),
});
export type HomeBatchCommand = z.infer<typeof HomeBatchCommand>;
export const HomeFolder = z.object({
  id: FolderId,
  name: z.string(),
  parentId: FolderId.nullable(),
  ownerId: z.string().nullable(),
  path: z.array(FolderId),
  role: DatabaseRole,
  shared: z.boolean(),
  trashed: z.boolean(),
});
export type HomeFolder = z.infer<typeof HomeFolder>;
export const HomeDatabase = DatabaseSummary.extend({
  parentId: FolderId.nullable(),
  owned: z.boolean(),
  shared: z.boolean(),
});
export type HomeDatabase = z.infer<typeof HomeDatabase>;
export const HomeListing = z.object({
  folders: z.array(HomeFolder),
  databases: z.array(HomeDatabase),
  shortcuts: z.array(HomeShortcut).optional(),
  tags: z.array(HomeTag).optional(),
  tagLinks: z.array(HomeTagLink).optional(),
  tagColors: z.array(HomeTagColor).optional(),
});
export type HomeListing = z.infer<typeof HomeListing>;
export interface AccessLoss {
  id: string;
  name: string;
}
