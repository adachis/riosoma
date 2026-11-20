import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { APP_PRESETS } from '../packages/connectors/dist/apps/index.js';
import { appBrandsSource, catalogSource } from './app_source_catalog.mjs';

test('keeps the standalone public catalog current with the preset index', async () => {
  const current = await readFile(
    new URL('../packages/contracts/src/app-catalog.generated.ts', import.meta.url),
    'utf8',
  );
  assert.equal(current, await catalogSource(APP_PRESETS));
});

test('keeps bundled brands current and generates new catalog brands without a manual mapping', async () => {
  assert.equal(
    await readFile(new URL('../packages/icons/src/app-brands.generated.ts', import.meta.url), 'utf8'),
    await appBrandsSource(APP_PRESETS),
  );
  const presets = ['HubSpot', 'GitHub', 'Garden Forms'].map((name, index) => ({
    catalog: { id: `app-${index}`, name },
  }));
  const source = await appBrandsSource(presets);
  assert.match(source, /free-brands-svg-icons\/faHubspot/);
  assert.match(source, /free-brands-svg-icons\/faGithub/);
  assert.doesNotMatch(source, /faGarden/);
  assert.doesNotMatch(source, /import.*\bfab\b/);
});

test('generates a third indexed app as public metadata without its transport', async () => {
  const base = APP_PRESETS[0];
  const presets = [
    ...APP_PRESETS,
    {
      ...base,
      catalog: {
        ...base.catalog,
        id: 'example',
        name: 'Example',
        secret: { ...base.catalog.secret, name: 'password' },
      },
    },
  ];
  const source = await catalogSource(presets);
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(source.replace(' as const', '')).toString('base64')}`
  );
  assert.deepEqual(
    module.APP_CATALOG_ENTRIES,
    presets.map((preset) => preset.catalog),
  );
  assert.equal(module.APP_CATALOG_ENTRIES.at(-1).secret.name, 'password');
  assert.equal(
    module.APP_CATALOG_ENTRIES.some((entry) => 'target' in entry || 'objects' in entry),
    false,
  );
});
