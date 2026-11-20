import { z } from 'zod';
import { FieldId } from './data/fields.js';
import { HeroButton, InterfacePageId, RecordAttachment } from './data/interfaces.js';

export const SiteSlug = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
export const SiteImage = RecordAttachment;
export const SitePageSettings = z.object({
  pageId: InterfacePageId,
  slug: SiteSlug.refine((slug) => !['assets', 'forms', 'media', 'api', 'sites'].includes(slug)),
  title: z.string().trim().min(1).max(200),
  navLabel: z.string().trim().min(1).max(200).optional(),
  showInNav: z.boolean().default(true),
  description: z.string().max(500).default(''),
  slugFieldId: FieldId.nullable().default(null),
});
export type SitePageSettings = z.infer<typeof SitePageSettings>;
export const SiteSettings = z.object({
  slug: SiteSlug,
  title: z.string().trim().min(1).max(200),
  pages: z
    .array(SitePageSettings)
    .min(1)
    .max(20)
    .refine(
      (pages) =>
        new Set(pages.map((page) => page.pageId)).size === pages.length &&
        new Set(pages.map((page) => page.slug)).size === pages.length,
    ),
  theme: z.object({ id: SiteSlug, scheme: SiteSlug }).default({ id: 'palette', scheme: 'house' }),
  motion: z.enum(['subtle', 'none']).default('subtle'),
  favicon: SiteImage.nullable().default(null),
  logo: SiteImage.nullable().default(null),
  headerButton: HeroButton.nullable().default(null),
  footer: z.string().max(500).default(''),
  footerFormat: z.enum(['plain', 'markdown']).default('plain'),
  socialImage: SiteImage.nullable().default(null),
  noIndex: z.boolean().default(false),
  domainId: z.uuid().nullable().default(null),
});
export type SiteSettings = z.infer<typeof SiteSettings>;
export interface PublishedSite {
  settings: SiteSettings;
  published: boolean;
  path: string;
  publisherId: string | null;
}
