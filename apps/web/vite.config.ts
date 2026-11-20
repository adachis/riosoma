import { trustedTypesGuard } from './build/trusted-types-guard.ts';
import { trustedTypesDependencies } from './build/trusted-types.ts';
import babel from '@rolldown/plugin-babel';
import { lingui } from '@lingui/vite-plugin';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bundleReport } from './build/bundle-report.ts';
import { shellCatalog } from './build/shell-catalog.ts';
import { iconImports } from './build/icon-imports.ts';
import { settingsRegistry } from './build/settings-registry.ts';
import { pdfRendererAssets } from './build/pdf-renderer.ts';
import { measureShell, precacheFiles, type Manifest } from './build/shell-budget.ts';
import { enabledLocales } from '../../tools/locales.ts';
import { localeAssets } from './build/locales.ts';
import { listFiles, selectPrecache, serviceWorker } from './build/service-worker.ts';

const server = process.env.RIOSOMA_DEV_SERVER ?? 'http://127.0.0.1:8080';

export default defineConfig(({ command, mode }) => {
  const production = command === 'build' && mode !== 'test' && mode !== 'development';
  const locales = enabledLocales(production);
  const inspectedScripts = new Set<string>();
  return {
    define: { __RIOSOMA_LOCALES__: production ? JSON.stringify(locales) : 'undefined' },
    plugins: [
      trustedTypesDependencies(),
      localeAssets(locales),
      settingsRegistry(locales.length > 1),
      pdfRendererAssets(),
      bundleReport(),
      shellCatalog(),
      iconImports(),
      react(),
      babel({ plugins: ['@lingui/babel-plugin-lingui-macro'], presets: [reactCompilerPreset()] }),
      lingui(),
      serviceWorker({
        // The imported listener validates responses before the precache routes, so it loads first.
        importScripts: ['/notification-worker.js'],
        manifest: {
          name: 'Riosoma',
          short_name: 'Riosoma',
          description: 'A fast, friendly, self-hosted database platform.',
          start_url: '/',
          display: 'standalone',
          background_color: '#f9fbf3',
          theme_color: '#374836',
          lang: 'en',
          scope: '/',
          id: '/',
          icons: [
            { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        precache: (output) => {
          const manifest = JSON.parse(
            readFileSync(resolve(output, '.vite/manifest.json'), 'utf8'),
          ) as Manifest;
          const shell = measureShell(manifest, (file) => readFileSync(resolve(output, file)));
          // Recovery controls and update notices must survive a deployment without entering startup.
          const common = new Set(precacheFiles(manifest, shell));
          // Locale and feature chunks enter the runtime cache only after this person requests them.
          const precache = selectPrecache(listFiles(output), common);
          // Keep build membership separate from caches that preserve assets for older open pages.
          writeFileSync(
            resolve(output, 'notification-worker.js'),
            readFileSync(resolve(import.meta.dirname, 'public/notification-worker.js'), 'utf8') +
              `\nself.rioBuildFiles = ${JSON.stringify(precache)};\n`,
          );
          return precache;
        },
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/sites(?:\/|$)/, /^\/api\//, /^\/themes\//, /^\/healthz/, /^\/readyz/],
      }),
      trustedTypesGuard(inspectedScripts),
    ],
    server: {
      port: 5173,
      // Help modules live in docs/ at the repository root.
      fs: { allow: ['../..'] },
      // The API and the theme files come from the Riosoma server during development.
      proxy: {
        '/api': { target: server, ws: true },
        '/themes': server,
        '/healthz': server,
        '/feeds': server,
      },
    },
    worker: { plugins: () => [trustedTypesDependencies(), trustedTypesGuard(inspectedScripts)] },
    build: {
      manifest: true,
      target: 'es2023',
      rolldownOptions: {
        output: {
          // Keep the static shell together without pulling in dependencies of dynamic features.
          codeSplitting: { groups: [{ name: 'shell', tags: ['$initial'] }] },
        },
        treeshake: {
          // Contract and locale modules declare data and helpers without registering behavior.
          moduleSideEffects: (id) => !/[\\/]packages[\\/](?:contracts|i18n)[\\/](?:src|dist)[\\/]/.test(id),
        },
      },
      sourcemap: true,
    },
    test: {
      environment: 'happy-dom',
      css: false,
      // Interaction tests with long lists run slowly when the whole workspace tests in parallel.
      testTimeout: 20_000,
      // A busy machine (several workspaces testing at once) can starve an interaction test.  A local
      // gate may allow one retry, and a test that really fails still fails twice.
      retry: Number(process.env.RIOSOMA_TEST_RETRY ?? 0),
      setupFiles: ['./src/test-setup.ts'],
    },
  };
});
