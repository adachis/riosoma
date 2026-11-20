import type { Plugin } from 'vite';

/** Separate icon modules let a feature's drawings travel with that feature. */
export function iconImports(): Plugin {
  return {
    name: 'web-icon-imports',
    enforce: 'pre',
    transform(code, id) {
      if (!/\.tsx?$/.test(id) || !code.includes('@fortawesome/free-')) return;
      const rewritten = code.replace(
        /import\s*\{([^}]+)\}\s*from\s*'(@fortawesome\/free-(?:solid|regular)-svg-icons)'\s*;/g,
        (original, names: string, library: string) => {
          const imports = names
            .split(',')
            .map((name) => name.trim())
            .filter(Boolean);
          if (!imports.every((name) => /^fa[A-Z]\w*(?:\s+as\s+\w+)?$/.test(name))) return original;
          return imports
            .map((name) => `import { ${name} } from '${library}/${name.split(/\s/)[0]}';`)
            .join('\n');
        },
      );
      return rewritten === code ? undefined : { code: rewritten, map: null };
    },
  };
}
