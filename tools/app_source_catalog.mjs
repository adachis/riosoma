import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { format, resolveConfig } from 'prettier';

/** Generate public metadata after building the connector presets, without exposing transport code. */
export async function catalogSource(presets) {
  const config = await resolveConfig(
    fileURLToPath(new URL('../packages/contracts/src/app-catalog.generated.ts', import.meta.url)),
  );
  return format(
    '// Generated from the preset index by tools/app_source_catalog.mjs.\n' +
      `export const APP_CATALOG_ENTRIES = ${JSON.stringify(presets.map((preset) => preset.catalog))} as const;\n`,
    { ...config, parser: 'typescript' },
  );
}

/** Include only catalog brands so opening a source form does not load the whole icon set. */
export async function appBrandsSource(presets) {
  const require = createRequire(new URL('../packages/icons/package.json', import.meta.url));
  const { fab } = require('@fortawesome/free-brands-svg-icons');
  const normalize = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const brands = Object.entries(fab);
  const names = new Set();
  for (const { catalog } of presets) {
    const found =
      brands.find(([, icon]) => normalize(icon.iconName) === normalize(catalog.id)) ??
      brands.find(([, icon]) => normalize(icon.iconName) === normalize(catalog.name));
    if (found) names.add(found[0]);
  }
  const config = await resolveConfig(
    fileURLToPath(new URL('../packages/icons/src/app-brands.generated.ts', import.meta.url)),
  );
  return format(
    '// Generated from the app catalog by tools/app_source_catalog.mjs.\n' +
      [...names]
        .map((name) => `import { ${name} } from '@fortawesome/free-brands-svg-icons/${name}';\n`)
        .join('') +
      "import type { IconDefinition } from '@fortawesome/fontawesome-common-types';\n" +
      `export const APP_BRANDS: readonly IconDefinition[] = [${[...names].join(', ')}];\n`,
    { ...config, parser: 'typescript' },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { APP_PRESETS } = await import('../packages/connectors/dist/apps/index.js');
  const outputs = [
    [
      new URL('../packages/contracts/src/app-catalog.generated.ts', import.meta.url),
      await catalogSource(APP_PRESETS),
    ],
    [
      new URL('../packages/icons/src/app-brands.generated.ts', import.meta.url),
      await appBrandsSource(APP_PRESETS),
    ],
  ];
  for (const [destination, source] of outputs) {
    if (process.argv.includes('--check')) {
      if ((await readFile(destination, 'utf8')) !== source)
        throw new Error('Run node tools/app_source_catalog.mjs after building the app presets.');
    } else await writeFile(destination, source);
  }
}
