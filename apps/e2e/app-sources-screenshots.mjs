import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
const html = new URL('../web/app-sources-screenshots.html', import.meta.url);
const entry = new URL('../web/app-sources-screenshots.tsx', import.meta.url);
const themesRoot = new URL('../../themes/', import.meta.url);
const themeAssets = process.env.RIOSOMA_THEME_ASSETS;
const buildOnly = process.argv[2] === '--build-only';
const prepared = buildOnly ? undefined : process.env.RIOSOMA_E2E_APP_SOURCES_WEB_DIR;

// Render the actual dialogs with an isolated catalog and intercepted source requests.
const fixture = `
import '@riosoma/tokens/base.css';
import './src/app.css';
import './src/docs/docs.css';
import { createRoot } from 'react-dom/client';
import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SourceDialog } from './src/screens/settings/sources/SourceDialog';
import { SyncWizard } from './src/screens/database/synced/SyncWizard';
import { TEST_APP_CATALOG, TEST_APP_MESSAGES } from './src/screens/settings/sources/app-catalog.test-support';
import { messages } from './src/locales/en-US/messages.po';
const catalog = TEST_APP_CATALOG.map(app => ({
  ...app,
  settings: app.settings.map(setting => setting.type === 'choice'
    ? {...setting, values: ['east', 'west', ...Array.from({length: 10}, (_, index) => 'region-' + (index + 1))]}
    : setting),
}));
// Release builds remove the macros' default text, and fixture labels are literal compiled messages.
const fixtureMessages = Object.fromEntries(Object.entries(TEST_APP_MESSAGES).map(([id, text]) => [id, [text]]));
const i18n = setupI18n({locale: 'en-US', messages: {'en-US': {...messages, ...fixtureMessages}}});
const wizard = new URLSearchParams(location.search).has('wizard');
const client = new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}});
createRoot(document.getElementById('root')!).render(
  <I18nProvider i18n={i18n}><QueryClientProvider client={client}>
    {wizard ? <SyncWizard appCatalog={catalog} sources={[]} admin session={{}} onClose={() => {}} onCreated={() => {}} />
      : <SourceDialog appCatalog={catalog} onSaved={() => {}} onClose={() => {}} />}
  </QueryClientProvider></I18nProvider>
);
`;

export async function captureAppSources(options = {}) {
  const previousDirectory = process.cwd();
  const directory = options.outputDirectory ?? process.env.RIOSOMA_SCREENSHOT_OUTPUT;
  const output = directory
    ? pathToFileURL(`${directory}/`)
    : new URL('./test-results/app-sources/', import.meta.url);
  const pages = new Set();
  const screenshots = new Set();
  let server;
  let browser = options.browser;
  try {
    // Babel resolves the web package's plugins relative to the working directory.
    process.chdir(webRoot);
    const { build, createServer, loadConfigFromFile, preview } = await import(
      pathToFileURL(createRequire(new URL('../web/package.json', import.meta.url)).resolve('vite')).href
    );
    await mkdir(output, { recursive: true });
    if (!prepared) {
      await writeFile(
        html,
        '<!doctype html><html lang="en-US"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/app-sources-screenshots.tsx"></script></body></html>',
      );
      await writeFile(entry, fixture);
    }
    if (buildOnly) {
      const directory = process.argv[3];
      assert.ok(directory, 'Expected an output directory after --build-only');
      const loaded = await loadConfigFromFile(
        { command: 'build', mode: 'test' },
        resolve(webRoot, 'vite.config.ts'),
      );
      assert.ok(loaded, 'Expected the web build configuration');
      const plugins = (await Promise.all(loaded.config.plugins.flat(Infinity))).flat(Infinity);
      await build({
        ...loaded.config,
        configFile: false,
        root: webRoot,
        mode: 'test',
        logLevel: 'error',
        // This isolated dialog page has no application shell or service worker.  The coordinator's
        // normal web builds still exercise their shell budgets and precache manifests.
        plugins: plugins.filter(
          (plugin) => plugin && plugin.name !== 'web-bundle-report' && plugin.name !== 'web-service-worker',
        ),
        build: {
          ...loaded.config.build,
          outDir: directory,
          emptyOutDir: true,
          rolldownOptions: {
            ...loaded.config.build.rolldownOptions,
            input: fileURLToPath(html),
          },
        },
      });
      return 0;
    }
    // Startup must not depend on terminal color codes or chunks in a console URL.
    if (prepared) {
      await access(new URL('app-sources-screenshots.html', pathToFileURL(`${prepared}/`)));
      server = await preview({
        configFile: false,
        root: webRoot,
        build: { outDir: prepared },
        preview: { host: '127.0.0.1', port: 0 },
        logLevel: 'error',
      });
    } else {
      server = await createServer({
        root: webRoot,
        server: { host: '127.0.0.1', port: 0 },
        logLevel: 'error',
      });
      await server.listen();
    }
    const address = server.httpServer.address();
    const baseURL = `http://127.0.0.1:${address.port}`;
    const engine = browser?.browserType().name() ?? process.env.RIOSOMA_SCREENSHOT_BROWSER ?? 'chromium';
    const type = { chromium, firefox, webkit }[engine];
    assert.ok(type, `Unknown screenshot browser: ${engine}`);
    browser ??= await type.launch({
      headless: true,
      ...(engine === 'chromium' ? { args: ['--mute-audio', '--disable-speech-synthesis-api'] } : {}),
      ...(engine === 'firefox'
        ? { firefoxUserPrefs: { 'media.webspeech.synth.enabled': false, 'media.volume_scale': '0.0' } }
        : {}),
    });
    for (const [theme, scheme] of [
      ['nature', 'grove'],
      ['bauhaus', 'midnight'],
    ]) {
      for (const width of [390, 1280]) {
        const page = await browser.newPage({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
        pages.add(page);
        let pass = false;
        await page.route('**/themes/**', async (route) => {
          const path = new URL(route.request().url()).pathname.slice('/themes/'.length);
          const file =
            themeAssets && path.includes('/assets/')
              ? new URL(path, new URL(`file://${themeAssets.replace(/\/$/, '')}/`))
              : new URL(path, themesRoot);
          const data = await readFile(file).catch(() => null);
          if (!data) {
            await route.fulfill({ status: 404 });
            return;
          }
          await route.fulfill({ body: data, contentType: path.endsWith('.css') ? 'text/css' : 'font/woff2' });
        });
        await page.route('**/api/sources**', async (route) => {
          const path = new URL(route.request().url()).pathname;
          const steps = ['resolve', 'connect', 'tls', 'authenticate', 'records', 'paging'].map(
            (step, index) => ({
              step,
              status: pass || index < 3 ? 'ok' : index === 3 ? 'failed' : 'skipped',
              ms: index > 3 && !pass ? null : 2,
              ...(!pass && index === 3 ? { messageKey: 'sources.app.authenticate' } : {}),
            }),
          );
          const response = path.endsWith('/test')
            ? { ok: pass, steps }
            : path.endsWith('/objects')
              ? [
                  { schema: null, name: 'contacts', label: 'Contacts', type: 'table', rowEstimate: null },
                  {
                    schema: null,
                    name: 'forms/spring',
                    label: 'Spring registration',
                    type: 'table',
                    rowEstimate: null,
                  },
                  {
                    schema: null,
                    name: 'custom/plots',
                    label: 'Custom plots',
                    type: 'table',
                    rowEstimate: null,
                  },
                ]
              : {
                  id: 'src0123456789abcd',
                  name: 'Garden data',
                  description: '',
                  kind: 'app',
                  connection: null,
                  secrets: ['apiKey'],
                  access: 'creators',
                  createdAt: '',
                  createdBy: null,
                  updatedAt: '',
                  lastTest: { at: '', ok: true },
                  tables: 0,
                };
          await route.fulfill({ json: response });
        });
        async function open(wizard = false) {
          await page.goto(`${baseURL}/app-sources-screenshots.html${wizard ? '?wizard' : ''}`, {
            waitUntil: 'commit',
          });
          await page.getByRole('dialog').waitFor({ state: 'visible' });
          await page.addStyleTag({ url: `/themes/${theme}/theme.css` });
          await page.evaluate((scheme) => {
            document.documentElement.dataset.scheme = scheme;
          }, scheme);
          await page.evaluate(async () => {
            await document.fonts.ready;
          });
          if (wizard) await page.getByRole('button', { name: 'Connect a new data source' }).click();
          await page.getByRole('searchbox', { name: 'Filter sources' }).fill('Garden');
        }
        async function fill() {
          await page.getByRole('option', { name: 'Garden Forms' }).click();
          await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Garden data');
          await page.getByRole('textbox', { name: 'Description' }).fill('Spring form records');
          await page.getByRole('textbox', { name: 'Workspace code' }).fill('GARDEN');
          await page.getByRole('textbox', { name: 'Account address' }).fill('https://garden.example.com');
          await page.getByRole('button', { name: /Region/ }).click();
          const choices = page.getByRole('listbox', { name: /Region/ });
          assert.equal(await choices.getAttribute('aria-label'), 'Region');
          assert.equal(await choices.getByRole('option').count(), 12);
          await capture('choices');
          await page.getByRole('option', { name: 'east', exact: true }).click();
          await page.getByRole('textbox', { name: 'Optional code' }).fill('2026');
          await page.getByLabel('Key', { exact: true }).fill(['stand', 'in', 'key'].join('-'));
        }
        async function capture(state) {
          await page.evaluate(() => {
            if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          });
          const overflow = await page.evaluate(() => {
            const body = document.querySelector('.rio-dialog__body');
            return (
              document.documentElement.scrollWidth > innerWidth ||
              (body && body.scrollWidth > body.clientWidth)
            );
          });
          if (overflow) throw new Error(`Horizontal overflow in ${theme}, ${width}, ${state}`);
          const filename = `${theme}-${width}-${state}.png`;
          await page.screenshot({
            path: fileURLToPath(new URL(filename, output)),
            animations: 'disabled',
          });
          screenshots.add(filename);
        }
        await open();
        await page.getByRole('searchbox', { name: 'Filter sources' }).fill('');
        await page.getByRole('group', { name: 'Apps', exact: true }).scrollIntoViewIfNeeded();
        await capture('picker');
        await page.getByRole('searchbox', { name: 'Filter sources' }).fill('Garden');
        await fill();
        await page.getByRole('textbox', { name: 'Name', exact: true }).evaluate((input) => {
          const field = input.closest('.rio-field');
          const body = input.closest('.rio-dialog__body');
          if (field && body)
            body.scrollTop += field.getBoundingClientRect().top - body.getBoundingClientRect().top;
        });
        await capture('form');
        await page.getByRole('button', { name: 'Test connection', exact: true }).click();
        await page
          .getByText('The app could not verify the key.  Check its permissions and try again.')
          .waitFor();
        await page.locator('.rio-sources__test').scrollIntoViewIfNeeded();
        await capture('failed-test');
        pass = true;
        await open(true);
        await fill();
        await page.getByRole('button', { name: 'Test connection', exact: true }).click();
        await page.getByText('Connected.', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Save and continue' }).click();
        await page.getByRole('option', { name: 'Spring registration' }).waitFor();
        await capture('objects');
        await page.close();
        pages.delete(page);
      }
    }
    console.log(`Saved ${screenshots.size} screenshots in ${fileURLToPath(output)}`);
    return screenshots.size;
  } finally {
    try {
      await Promise.all([...pages].map((page) => page.close()));
      if (!options.browser) await browser?.close();
      await server?.close();
      if (!prepared) {
        await rm(html, { force: true });
        await rm(entry, { force: true });
      }
    } finally {
      process.chdir(previousDirectory);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await captureAppSources();
