import sharp from 'sharp';
import { organizationPolicy, organizationThemeValues, validateThemes } from '../../org-units/policy.js';
import { themeManifest } from '../../themes/catalog.js';
import type { OrganizationAppearance, OrgSettings } from '@riosoma/contracts';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  AppError,
  LogoChange,
  OrganizationLogo,
  type LogoUpload,
  type OrganizationLogo as Logo,
  type OrganizationBranding,
} from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import { fileStorage } from '../files/storage.js';
import type { RuntimeConfig } from '../../config.js';
import type { AdminContext } from '../organization-admin/store.js';
import { scope } from '../organization-admin/store.js';
import { sanitizeLogo } from './sanitize.js';

export async function currentLogo(db: Queryable, schema: string, orgId: string): Promise<Logo | null> {
  const result = await query<{ logo: unknown }>(
    db,
    sql`SELECT settings->'logo' AS logo FROM ${ident(schema, 'orgs')} WHERE id = ${orgId}`,
  );
  const logo = OrganizationLogo.nullable().safeParse(result.rows[0]?.logo ?? null);
  return logo.success ? logo.data : null;
}

export async function saveLogo(
  db: Queryable,
  schema: string,
  orgId: string,
  logo: Logo | null,
): Promise<void> {
  await query(
    db,
    sql`UPDATE ${ident(schema, 'orgs')} SET settings = jsonb_set(settings, '{logo}', ${JSON.stringify(logo)}::jsonb) WHERE id = ${orgId}`,
  );
}

async function storeUpload(
  db: Queryable,
  schema: string,
  config: RuntimeConfig,
  upload: LogoUpload,
): Promise<Logo['main']> {
  const bytes = await sanitizeLogo(upload);
  const key = randomUUID();
  // Small identity assets stay transactional, including audit failures and command retries.
  await fileStorage('postgres', db, schema, config).write(key, Readable.from([bytes]));
  const sample = await sharp(bytes, { limitInputPixels: 16_777_216 })
    .toColourspace('srgb')
    .ensureAlpha()
    .resize(32, 32, { fit: 'inside' })
    .raw()
    .toBuffer({ resolveWithObject: true })
    .catch(() => {
      throw new AppError('validation_failed', 'branding.raster');
    });
  let luminance = 0;
  let weight = 0;
  for (let i = 0; i < sample.data.length; i += sample.info.channels) {
    const alpha = sample.data[i + 3]! / 255;
    luminance +=
      (sample.data[i]! * 0.2126 + sample.data[i + 1]! * 0.7152 + sample.data[i + 2]! * 0.0722) * alpha;
    weight += alpha;
  }
  return {
    key,
    type: upload.type,
    storage: 'postgres',
    surface: weight && luminance / weight > 128 ? 'dark' : 'light',
  };
}

export async function changeLogo(c: AdminContext, config: RuntimeConfig, change: LogoChange) {
  await scope(c).requireOrganizationAdmin('people');
  const before = await currentLogo(c.db, c.schemas.app, c.actor.orgId);
  const main =
    change.main === undefined
      ? before?.main
      : change.main === null
        ? null
        : await storeUpload(c.db, c.schemas.app, config, change.main);
  const compact =
    change.compact === undefined
      ? (before?.compact ?? null)
      : change.compact === null
        ? null
        : await storeUpload(c.db, c.schemas.app, config, change.compact);
  if (!main && (change.compact || change.main === undefined))
    throw new AppError('validation_failed', 'branding.mainRequired');
  const after: Logo | null = main ? { main, compact, mode: change.mode } : null;
  await saveLogo(c.db, c.schemas.app, c.actor.orgId, after);
  return { before, after };
}

export async function organizationBranding(c: AdminContext): Promise<OrganizationBranding> {
  await scope(c).requireOrganization();
  const result = await query<{ name: string }>(
    c.db,
    sql`SELECT name FROM ${ident(c.schemas.app, 'orgs')} WHERE id = ${c.actor.orgId}`,
  );
  if (!result.rows[0]) throw new AppError('not_found', 'errors.notFound');
  return { name: result.rows[0].name, logo: await currentLogo(c.db, c.schemas.app, c.actor.orgId) };
}

export async function archiveLogo(db: Queryable, schema: string, config: RuntimeConfig, logo: Logo | null) {
  if (!logo) return null;
  const read = async (asset: Logo['main']) => {
    const chunks: Buffer[] = [];
    for await (const chunk of fileStorage(asset.storage, db, schema, config).read(asset.key))
      chunks.push(chunk as Buffer);
    return { type: asset.type, data: Buffer.concat(chunks).toString('base64') };
  };
  return {
    main: await read(logo.main),
    compact: logo.compact ? await read(logo.compact) : null,
    mode: logo.mode,
  };
}

export async function restoreLogo(
  db: Queryable,
  schema: string,
  config: RuntimeConfig,
  value: unknown,
): Promise<Logo | null> {
  if (value === null || value === undefined) return null;
  const parsed = LogoChange.required().safeParse(value);
  if (!parsed.success || !parsed.data.main) throw new AppError('validation_failed', 'branding.archive');
  return {
    main: await storeUpload(db, schema, config, parsed.data.main),
    compact: parsed.data.compact ? await storeUpload(db, schema, config, parsed.data.compact) : null,
    mode: parsed.data.mode,
  };
}

export async function currentAppearance(c: AdminContext): Promise<OrganizationAppearance> {
  const result = await query<{ settings: OrgSettings }>(
    c.db,
    sql`SELECT settings FROM ${ident(c.schemas.app, 'orgs')} WHERE id = ${c.actor.orgId}`,
  );
  return organizationThemeValues(result.rows[0]?.settings);
}

export async function changeAppearance(
  c: AdminContext,
  config: RuntimeConfig,
  change: OrganizationAppearance,
  restoredThemes?: Pick<OrgSettings, 'defaultTheme' | 'allowedThemes'>,
) {
  await scope(c).requireOrganizationAdmin('people');
  const after = { defaultTheme: change.defaultTheme, allowedThemes: change.allowedThemes };
  const before = await currentAppearance(c);
  validateThemes(after);
  for (const theme of new Set(
    [after.defaultTheme, ...(after.allowedThemes ?? [])].filter((theme): theme is string => theme !== null),
  ))
    if (!(await themeManifest(config, theme))) throw new AppError('validation_failed', 'themes.unknown');
  const result = await query<{ settings: OrgSettings }>(
    c.db,
    sql`SELECT settings FROM ${ident(c.schemas.app, 'orgs')} WHERE id = ${c.actor.orgId}`,
  );
  const policy = organizationPolicy(result.rows[0]?.settings);
  const next = { ...policy, values: { ...policy.values, ...after } };
  const previousThemes = {
    ...(result.rows[0]?.settings.defaultTheme ? { defaultTheme: result.rows[0].settings.defaultTheme } : {}),
    ...(result.rows[0]?.settings.allowedThemes
      ? { allowedThemes: result.rows[0].settings.allowedThemes }
      : {}),
  };
  const canonical = restoredThemes ?? {
    ...(after.defaultTheme ? { defaultTheme: { theme: after.defaultTheme } } : {}),
    ...(after.allowedThemes ? { allowedThemes: after.allowedThemes } : {}),
  };
  // The unit policy may tighten the canonical fields, so both must reflect an appearance save.
  await query(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, 'orgs')} SET settings = (settings - 'defaultTheme' - 'allowedThemes') || jsonb_build_object('unitPolicy', ${JSON.stringify(next)}::jsonb) || ${JSON.stringify(canonical)}::jsonb WHERE id = ${c.actor.orgId}`,
  );
  return { before, after, previousThemes };
}
