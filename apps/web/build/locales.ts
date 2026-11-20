import type { Plugin } from 'vite';

/** Restrict globs before Vite discovers modules, so disabled catalogs never enter the bundle. */
export function localeAssets(locales: readonly string[]): Plugin {
  return {
    name: 'enabled-locale-assets',
    enforce: 'pre',
    transform(code, id) {
      if (!/\.(?:ts|tsx)$/.test(id)) return;
      const transformed = code.replace(
        /(['"])([^'"]*(?:locales\/\*\/messages\.po|docs\/modules\/\*\*\/\*\.md))\1/g,
        (_, _quote: string, pattern: string) =>
          JSON.stringify(
            locales.map((locale) =>
              pattern.endsWith('.po')
                ? pattern.replace('*/messages.po', `${locale}/messages.po`)
                : pattern.replace('*.md', `${locale}.md`),
            ),
          ),
      );
      if (transformed === code) return;
      return {
        code: transformed,
        map: {
          version: 3,
          sources: [id],
          sourcesContent: [code],
          names: [],
          // Replacing a glob preserves lines.  Each line maps to its original source line.
          mappings: code
            .split('\n')
            .map((_, index) => (index ? 'AACA' : 'AAAA'))
            .join(';'),
        },
      };
    },
  };
}
