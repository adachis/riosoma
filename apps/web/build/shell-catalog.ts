import { readFileSync, existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { getConfig } from '@lingui/conf';
import { getCatalogs, getCatalogForFile, createCompiledCatalog } from '@lingui/cli/api';
import ts from 'typescript';
import type { Plugin } from 'vite';

/** Startup needs only messages reachable through static imports of the shell and home. */
export function shellCatalog(): Plugin {
  return {
    name: 'web-shell-catalog',
    enforce: 'pre',
    async load(id) {
      const recovery = id.endsWith('.po?recovery');
      if (!recovery && !id.endsWith('.po?shell')) return;
      const config = getConfig();
      const file = id.slice(0, -(recovery ? '?recovery' : '?shell').length);
      const catalog = getCatalogForFile(relative(config.rootDir, file), await getCatalogs(config));
      if (!catalog) throw new Error(`Unknown locale catalog: ${file}`);
      this.addWatchFile(file);
      const root = resolve(config.rootDir, 'apps/web/src');
      const seen = new Set<string>();
      const ids = new Set<string>();
      const locate = (path: string) =>
        [path, `${path}.ts`, `${path}.tsx`, `${path}/index.ts`, `${path}/index.tsx`].find(
          (candidate) => /\.tsx?$/.test(candidate) && existsSync(candidate),
        );
      const visit = (path: string) => {
        if (seen.has(path) || /[/\\]messages[/\\](?:server|formula)\.ts$/.test(path)) return;
        seen.add(path);
        this.addWatchFile(path);
        const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
        const walk = (node: ts.Node) => {
          if (ts.isStringLiteralLike(node)) ids.add(node.text);
          if (
            (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) ||
            ts.isExportDeclaration(node)
          ) {
            const module = node.moduleSpecifier;
            if (module && ts.isStringLiteral(module)) {
              const name = module.text;
              const target = name.startsWith('.')
                ? resolve(dirname(path), name.replace(/\.js$/, ''))
                : name.startsWith('@riosoma/') && name !== '@riosoma/contracts'
                  ? resolve(config.rootDir, 'packages', name.slice('@riosoma/'.length), 'src/index')
                  : null;
              const next = target && locate(target);
              if (next) visit(next);
            }
          }
          ts.forEachChild(node, walk);
        };
        walk(source);
      };
      visit(resolve(root, 'main.tsx'));
      visit(resolve(root, 'screens/HomeScreen.tsx'));
      const { messages } = await catalog.catalog.getTranslations(catalog.locale, {
        fallbackLocales: config.fallbackLocales,
        sourceLocale: config.sourceLocale,
      });
      // Home messages follow static imports so closed forms keep their translations deferred.
      const selected = Object.fromEntries(
        Object.entries(messages).filter(([key]) =>
          recovery
            ? /^(app\.load|boot\.error)\./.test(key)
            : ids.has(key) || /^(shell|celebrations)\./.test(key),
        ),
      );
      const pseudo = config.pseudoLocale.find((item) => item.locale === catalog.locale);
      const compiled = createCompiledCatalog(catalog.locale, selected, {
        namespace: 'es',
        pseudoLocale: pseudo?.locale,
        pseudoLocaleOptions: pseudo?.options,
      });
      if (compiled.errors.length) throw new Error(`Could not compile shell catalog: ${file}`);
      return { code: compiled.source, map: null, moduleType: 'js' };
    },
    transformIndexHtml: {
      order: 'post',
      async handler(html) {
        const config = getConfig();
        const catalog = getCatalogForFile(
          'apps/web/src/locales/en-US/messages.po',
          await getCatalogs(config),
        );
        if (!catalog) throw new Error('Missing startup recovery catalog');
        const { messages } = await catalog.catalog.getTranslations(catalog.locale, {
          fallbackLocales: config.fallbackLocales,
          sourceLocale: config.sourceLocale,
        });
        const text = (id: string) =>
          String(messages[id]).replace(
            /[&<>"']/g,
            (character) =>
              ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;',
              })[character]!,
          );
        // This screen and its inline script survive a missing entry module, its static imports, or any
        // other failed request, because the document itself carries both.
        return {
          html: html.replace(
            '<div id="root"></div>',
            `<div id="root"><div id="rio-startup-error" hidden role="alert"><h1>${text('app.load.title')}</h1><p>${text('app.load.body')}</p><button type="button">${text('app.load.reload')}</button></div></div>`,
          ),
          tags: [
            {
              tag: 'script',
              attrs: { id: 'rio-startup-recovery' },
              children: readFileSync(resolve(config.rootDir, 'apps/web/public/startup-recovery.js'), 'utf8'),
              injectTo: 'head',
            },
            { tag: 'link', attrs: { rel: 'stylesheet', href: '/startup-recovery.css' }, injectTo: 'head' },
          ],
        };
      },
    },
  };
}
