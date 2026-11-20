import { z } from 'zod';

/**
 * A theme picked for something other than one person: a database that forces its theme, or a
 * public form, view link, or booking page that picks its own.  Themes are chosen per person, with
 * an organization default.  Admins can limit the list people choose from, and a database's owner
 * can force one theme and color scheme on everyone who opens it.  A public page's own theme wins
 * over its database's.
 *
 * Wherever a theme applies, it has to be on the list allowed there.  One that isn't falls back:
 * inside the app to the person's own theme, and on a public page to the organization's default.
 * The stored choice stays as it was, so it comes back if the list grows again.
 *
 * A database keeps its theme in its settings as `theme`, set with `database.update`, which only
 * its owner may change.  Archives, copies, and templates carry it along.  A form keeps its own in
 * its view's `form.theme`, a view link in its settings, and a booking page in its settings.
 */
export const ThemeSlug = z.string().regex(/^[a-z0-9-]{1,64}$/);

export const ThemePick = z.object({ id: ThemeSlug, scheme: ThemeSlug });
export type ThemePick = z.infer<typeof ThemePick>;

/** Whether two picks are the same theme and scheme.  No pick at all equals only no pick. */
export function sameTheme(a: ThemePick | null | undefined, b: ThemePick | null | undefined): boolean {
  return (a ?? null) === (b ?? null) || (!!a && !!b && a.id === b.id && a.scheme === b.scheme);
}

/** Whether a theme is on a list of allowed themes.  No list allows every theme. */
export function themeAllowed(themeId: string, allowed: readonly string[] | null | undefined): boolean {
  return !allowed?.length || allowed.includes(themeId);
}

/** A database's forced theme, read from its stored settings, or null when it has none. */
export function forcedThemeOf(settings: unknown): ThemePick | null {
  const parsed = z.object({ theme: ThemePick }).safeParse(settings);
  return parsed.success ? parsed.data.theme : null;
}
