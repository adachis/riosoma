import { AppError, forcedThemeOf, themeAllowed, type ThemePick } from '@riosoma/contracts';
import type { Queryable } from '@riosoma/db';
import type { RuntimeConfig } from '../config.js';
import { orgSettings } from '../auth/levels.js';
import {
  effectivePolicy,
  memberPolicy,
  organizationThemeValues,
  type PolicyPerson,
} from '../org-units/policy.js';
import { themeManifest } from './catalog.js';

/**
 * Themes picked for a database or a public page, following `packages/contracts/src/themes.ts`.
 * Saving one checks that it exists and that the person saving may choose it.  Reading one for a
 * public page checks it against the list allowed where the page was shared from, and falls back
 * when the list has changed since, without touching what was saved.
 */

type Config = Pick<RuntimeConfig, 'themesDir'> | undefined;

/** Refuses a theme that this server doesn't have, or a scheme the theme doesn't have. */
export async function requireKnownTheme(config: Config, pick: ThemePick): Promise<void> {
  const manifest = await themeManifest(config ?? { themesDir: undefined }, pick.id);
  if (!manifest?.schemes.some((scheme) => scheme.id === pick.scheme))
    throw new AppError('validation_failed', 'themes.unknown');
}

/** The themes a person may choose, or null when every theme is allowed. */
export async function allowedThemes(
  db: Queryable,
  appSchema: string,
  who: PolicyPerson,
): Promise<string[] | null> {
  return (await memberPolicy(db, appSchema, who))?.values.allowedThemes ?? null;
}

/**
 * Refuses a theme picked for others unless it exists and the person picking may choose it.
 * `appSchema` is the quoted name of the app schema, as the policy helpers take it.
 */
export async function requireThemeChoice(
  db: Queryable,
  appSchema: string,
  who: PolicyPerson,
  pick: ThemePick,
  config: Config,
): Promise<void> {
  await requireKnownTheme(config, pick);
  if (!themeAllowed(pick.id, await allowedThemes(db, appSchema, who)))
    throw new AppError('forbidden', 'orgUnits.policy.theme');
}

/**
 * The theme a public page shows in: its own pick, else its database's forced theme.  The first of
 * those the page's sharer may choose wins.  When neither is allowed anymore, the page shows in
 * the organization's default theme, or the first allowed one when it names no default.  Pages
 * with no picks follow the same default.  A sharer who is gone counts as the organization itself.
 */
export async function publicTheme(
  db: Queryable,
  appSchema: string,
  page: { orgId: string; sharerId: string | null; hasUnits?: boolean },
  own: ThemePick | null | undefined,
  databaseSettings: unknown,
  config: Config,
): Promise<ThemePick | null> {
  const picks = [own ?? null, forcedThemeOf(databaseSettings)].filter(
    (pick): pick is ThemePick => pick !== null,
  );
  const settings = await orgSettings(db, appSchema, page.orgId);
  // Only a unit hierarchy needs the sharer's full policy, which the public lookup already detects.
  const policy =
    page.hasUnits === false
      ? null
      : ((page.sharerId
          ? await memberPolicy(db, appSchema, { orgId: page.orgId, userId: page.sharerId })
          : null) ?? (await effectivePolicy(db, appSchema, page.orgId, { unitId: null }).catch(() => null)));
  const values = policy?.values ?? organizationThemeValues(settings);
  const allowed = picks.find((pick) => themeAllowed(pick.id, values?.allowedThemes));
  if (allowed) return allowed;
  const fallback =
    values.defaultTheme && themeAllowed(values.defaultTheme, values.allowedThemes)
      ? values.defaultTheme
      : (values.allowedThemes?.[0] ?? null);
  const manifest = fallback ? await themeManifest(config ?? { themesDir: undefined }, fallback) : null;
  if (!fallback || !manifest) return null;
  const configured = settings?.defaultTheme;
  // A scheme belongs to its configured theme, even when policy selects a different default.
  const scheme =
    configured?.theme === fallback && manifest.schemes.some((scheme) => scheme.id === configured.scheme)
      ? configured.scheme!
      : manifest.defaultScheme;
  return { id: fallback, scheme };
}
