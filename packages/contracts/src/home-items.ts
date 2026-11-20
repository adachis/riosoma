import { z } from 'zod';
import { SharingAction } from './sharing.js';

const id = z.string().min(1).max(100);
const name = z.string().trim().min(1).max(120);
export const TagColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const ShortcutTarget = z.object({ kind: z.enum(['dashboard', 'interface', 'view', 'form']), id });
export type ShortcutTarget = z.infer<typeof ShortcutTarget>;
export const TagResource = z.object({ kind: z.enum(['database', 'folder']), id });
export type TagResource = z.infer<typeof TagResource>;
export const HomeItemAction = z.discriminatedUnion('kind', [
  ...SharingAction.options,
  z.object({
    kind: z.literal('shortcut.create'),
    shortcutId: id,
    target: ShortcutTarget,
    parentId: id.nullable().default(null),
  }),
  z.object({ kind: z.literal('shortcut.move'), shortcutId: id, parentId: id.nullable() }),
  z.object({ kind: z.literal('shortcut.trash'), shortcutId: id }),
  z.object({ kind: z.literal('shortcut.restore'), shortcutId: id }),
  z.object({
    kind: z.literal('tag.create'),
    tagId: id,
    name,
    color: TagColor,
    visibility: z.enum(['shared', 'private']),
  }),
  z.object({ kind: z.literal('tag.update'), tagId: id, name, color: TagColor }),
  z.object({ kind: z.literal('tag.trash'), tagId: id }),
  z.object({ kind: z.literal('tag.restore'), tagId: id }),
  z.object({ kind: z.literal('tag.assign'), tagId: id, resource: TagResource, assigned: z.boolean() }),
  z.object({
    kind: z.literal('tagColor.set'),
    colorId: id,
    value: z.object({ name, color: TagColor }).nullable(),
  }),
]);
export type HomeItemAction = z.infer<typeof HomeItemAction>;
export const HomeShortcut = z.object({
  id,
  parentId: id.nullable(),
  owned: z.boolean(),
  trashed: z.boolean(),
  available: z.boolean(),
  name: z.string().optional(),
  href: z.string().optional(),
  target: ShortcutTarget.optional(),
});
export type HomeShortcut = z.infer<typeof HomeShortcut>;
export const HomeTag = z.object({
  id,
  name,
  color: TagColor,
  visibility: z.enum(['shared', 'private']),
  owned: z.boolean(),
});
export type HomeTag = z.infer<typeof HomeTag>;
export const HomeTagLink = z.object({ tagId: id, resource: TagResource });
export const HomeTagColor = z.object({ id, name, color: TagColor });
