import { z } from 'zod';
import { AttachmentId, CommandId } from './data/fields.js';
import { SharedViewEmbed, SharedViewId } from './shared-views.js';

export const PublicSharingPolicy = z.object({
  embeddingEnabled: z.boolean().default(true),
  publicFiles: z.boolean().default(false),
  fileLifetimeSeconds: z.number().int().min(60).max(604800).default(3600),
});
export type PublicSharingPolicy = z.infer<typeof PublicSharingPolicy>;

export const PublicEmbedTarget = z.object({
  kind: z.enum(['view', 'form', 'booking']),
  linkId: SharedViewId,
});
export type PublicEmbedTarget = z.infer<typeof PublicEmbedTarget>;

export const PublicSharingAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('policy'), policy: PublicSharingPolicy }),
  z.object({ kind: z.literal('formFiles'), linkId: SharedViewId, fileIds: z.array(AttachmentId).max(20) }),
  z.object({ kind: z.literal('embed'), target: PublicEmbedTarget, embed: SharedViewEmbed }),
]);
export type PublicSharingAction = z.infer<typeof PublicSharingAction>;

export const PublicSharingCommand = z
  .object({
    id: CommandId,
    action: PublicSharingAction.optional(),
    undoOf: CommandId.optional(),
  })
  .refine((value) => Boolean(value.action) !== Boolean(value.undoOf));
export type PublicSharingCommand = z.infer<typeof PublicSharingCommand>;
