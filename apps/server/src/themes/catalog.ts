import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { RuntimeConfig } from '../config.js';

/**
 * The generated themes this server serves at `/themes/`, read from the folder that holds their
 * `index.json`.  Only a theme's manifest is read here, to check that a theme and color scheme
 * someone picks for a database or a public page really exist.
 */
export function themesRoot(config: Pick<RuntimeConfig, 'themesDir'>): string | null {
  const candidates = [
    config.themesDir,
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../../themes'),
    resolve(process.cwd(), 'themes'),
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(join(p, 'index.json'))) ?? null;
}

const Manifest = z.object({
  defaultScheme: z.string(),
  schemes: z.array(z.object({ id: z.string() })),
});
export type ThemeManifest = z.infer<typeof Manifest>;

// Manifests change only with a new build of the themes, which means a new server, so each one found
// is read once.  A theme that isn't there is never remembered, so made-up names can't fill the map.
const manifests = new Map<string, Promise<ThemeManifest | null>>();

/** A theme's manifest, or null when this server has no such theme. */
export function themeManifest(
  config: Pick<RuntimeConfig, 'themesDir'>,
  themeId: string,
): Promise<ThemeManifest | null> {
  const root = themesRoot(config);
  if (!root || !/^[a-z0-9-]{1,64}$/.test(themeId)) return Promise.resolve(null);
  const key = `${root}\n${themeId}`;
  let found = manifests.get(key);
  if (!found) {
    found = readFile(join(root, themeId, 'theme.json'), 'utf8')
      .then((text) => {
        const parsed = Manifest.safeParse(JSON.parse(text));
        return parsed.success ? parsed.data : null;
      })
      .catch(() => null);
    manifests.set(key, found);
    void found.then((manifest) => {
      if (!manifest) manifests.delete(key);
    });
  }
  return found;
}
