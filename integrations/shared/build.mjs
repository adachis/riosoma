import { createRequire } from 'node:module';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { enabledLocales } from '../../tools/locales.ts';

// Both bundles use the existing application compiler and localization runtime.
const web = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { build } = await import(web.resolve('vite'));
const root = fileURLToPath(new URL('../../', import.meta.url));
const kind = process.argv[2];
const folder = resolve(root, 'integrations', kind);
const common = { configFile: false, root: folder, logLevel: 'warn' };
// These modules import nothing that needs a bundler, so Node loads the TypeScript directly.
const load = (path) => import(pathToFileURL(resolve(root, path)).href);

if (kind === 'zapier') {
  await build({
    ...common,
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      target: 'node22',
      lib: { entry: resolve(folder, 'src/entry.ts'), formats: ['cjs'], fileName: () => 'index.cjs' },
      rolldownOptions: { external: ['node:crypto', 'zapier-platform-core'], output: { exports: 'default' } },
    },
  });
} else if (kind === 'clipper') {
  const { manifest } = await load('integrations/clipper/src/manifest.ts');
  const { integrationMessages } = await load('packages/ui/src/integrations/messages.ts');
  const { compileMessage } = await import(
    createRequire(web.resolve('@lingui/core')).resolve('@lingui/message-utils/compileMessage')
  );
  const { version } = JSON.parse(await readFile(resolve(folder, 'package.json'), 'utf8'));
  const offered = enabledLocales(process.argv[process.argv.indexOf('--mode') + 1] !== 'test');

  // Every language the app ships, from its own catalogs.  A string not translated yet stays in
  // American English, and the pseudo-locale is only for testing the app.
  const english = Object.fromEntries(
    Object.values(integrationMessages).map(({ id, message }) => [id, message]),
  );
  const locales = resolve(root, 'apps/web/src/locales');
  // The browser shows the extension's name and description from _locales, under its own names.
  const folderNames = { 'en-US': 'en_US', 'pt-BR': 'pt_BR', 'zh-Hans': 'zh_CN', 'zh-Hant': 'zh_TW' };
  const catalogs = {};
  const listings = {};
  for (const entry of await readdir(locales, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'en-XA' || !offered.includes(entry.name)) continue;
    const translated =
      entry.name === 'en-US'
        ? {}
        : readPo(await readFile(resolve(locales, entry.name, 'messages.po'), 'utf8'));
    const text = (id) => translated[id] || english[id];
    catalogs[entry.name] = Object.fromEntries(
      Object.keys(english).map((id) => [id, compileMessage(text(id))]),
    );
    // A listing still in English adds nothing to the default one.
    if (entry.name === 'en-US' || translated['clipper.name'] || translated['clipper.description'])
      listings[folderNames[entry.name] ?? entry.name] = {
        name: { message: text('clipper.name') },
        description: { message: text('clipper.description') },
      };
  }
  if (!listings.en_US) throw new Error('The American English catalog is missing.');

  // The popup wears the app's default theme.  Its fonts aren't bundled, so the font stacks fall back
  // to system faces, and nothing left in the stylesheet may load a file.
  const tokens = await readFile(resolve(root, 'packages/tokens/src/themes.ts'), 'utf8');
  const theme = /DEFAULT_THEME: ThemeChoice = \{ theme: '([\w-]+)'/.exec(tokens)?.[1];
  if (!theme) throw new Error('The default theme could not be read from packages/tokens.');
  const themeInfo = JSON.parse(await readFile(resolve(root, 'themes', theme, 'theme.json'), 'utf8'));
  const themeCss = (await readFile(resolve(root, 'themes', theme, 'theme.css'), 'utf8')).replace(
    /@font-face\s*\{[^}]*\}/g,
    '',
  );
  if (/url\(|@import/.test(themeCss))
    throw new Error(`The ${theme} theme loads a file the clipper can't bundle.`);
  const schemes = {
    theme,
    light: themeInfo.defaultScheme,
    dark: themeInfo.schemes.find((scheme) => scheme.appearance === 'dark')?.id ?? themeInfo.defaultScheme,
  };
  const themeModule = {
    name: 'riosoma-theme',
    resolveId: (id) => (id === 'virtual:riosoma-theme.css' ? '\0riosoma-theme.css' : undefined),
    load: (id) => (id === '\0riosoma-theme.css' ? themeCss : undefined),
  };
  const define = {
    __RIOSOMA_LOCALES__: JSON.stringify(offered),
    __CLIPPER_CATALOGS__: JSON.stringify(catalogs),
    __CLIPPER_THEME__: JSON.stringify(schemes),
    'process.env.NODE_ENV': JSON.stringify('production'),
  };

  await build({
    ...common,
    define,
    plugins: [themeModule],
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      target: 'es2022',
      rolldownOptions: {
        input: resolve(folder, 'popup.html'),
        output: { entryFileNames: 'popup.js', assetFileNames: '[name][extname]' },
      },
    },
  });
  await build({
    ...common,
    define,
    build: {
      outDir: 'dist',
      emptyOutDir: false,
      target: 'es2022',
      lib: {
        entry: resolve(folder, 'src/worker.ts'),
        formats: ['iife'],
        name: 'ClipperWorker',
        fileName: () => 'worker.js',
      },
    },
  });
  for (const [name, messages] of Object.entries(listings)) {
    await mkdir(resolve(folder, 'dist/_locales', name), { recursive: true });
    await writeFile(
      resolve(folder, 'dist/_locales', name, 'messages.json'),
      JSON.stringify(messages, null, 2),
    );
  }
  await writeFile(
    resolve(folder, 'dist/manifest.json'),
    JSON.stringify(manifest('chrome', version), null, 2),
  );
  await writeFile(
    resolve(folder, 'dist/manifest.firefox.json'),
    JSON.stringify(manifest('firefox', version), null, 2),
  );
} else throw new Error('integration.build.target');

/** Reads msgid and msgstr pairs from a PO catalog, joining continued lines. */
function readPo(text) {
  const entries = {};
  let field = null;
  let current = { msgid: '', msgstr: '' };
  const flush = () => {
    if (current.msgid) entries[current.msgid] = current.msgstr;
    current = { msgid: '', msgstr: '' };
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('msgid ')) {
      flush();
      field = 'msgid';
      current.msgid = JSON.parse(line.slice(6));
    } else if (line.startsWith('msgstr ')) {
      field = 'msgstr';
      current.msgstr = JSON.parse(line.slice(7));
    } else if (line.startsWith('"') && field) {
      current[field] += JSON.parse(line);
    } else if (!line.trim()) {
      field = null;
    }
  }
  flush();
  return entries;
}
