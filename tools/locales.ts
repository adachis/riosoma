import { readdirSync } from 'node:fs';

const catalogs = readdirSync(new URL('../apps/web/src/locales/', import.meta.url), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
const source = 'en-US';
const pseudo = ['en-XA', 'en-XB'];

/** Release builds offer only configured languages.  Development keeps layout test locales. */
export function enabledLocales(production = true, value = process.env.RIOSOMA_LOCALES): string[] {
  if (!production) return [...new Set([...catalogs, ...pseudo])];
  const locales = [...new Set((value?.trim() || source).split(',').map((locale) => locale.trim()))];
  if (!locales.includes(source)) throw new Error('RIOSOMA_LOCALES must include en-US for fallback');
  for (const locale of locales) {
    if (!catalogs.includes(locale) || pseudo.includes(locale))
      throw new Error(`Unsupported release locale: ${locale}`);
  }
  return locales;
}
