import { safeLink, type SiteSettings } from '@riosoma/contracts';

/** Relative links may name a published page, while absolute links follow the shared link rule. */
export function siteLink(
  href: string,
  settings: SiteSettings,
  base: string,
  origin: string,
  slug: string,
): { href: string; external: boolean } | null {
  if (/[\s\p{Cc}]/u.test(href) || !href) return null;
  try {
    const url = new URL(href, `${origin || 'https://site.invalid'}${base}/${slug}`);
    if (!safeLink(url.href)) return null;
    const internal =
      url.origin === (origin || 'https://site.invalid') &&
      (url.pathname === (base || '/') ||
        settings.pages.some((page) => url.pathname === `${base}/${page.slug}`));
    if (!safeLink(href) && !internal) return null;
    return { href: internal ? `${url.pathname}${url.search}${url.hash}` : url.href, external: !internal };
  } catch {
    return null;
  }
}
