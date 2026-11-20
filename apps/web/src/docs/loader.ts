import { APP_CATALOG, DocModuleMeta } from '@riosoma/contracts';
import { recoverImport } from '../asset-recovery';

export interface DocModule {
  meta: DocModuleMeta;
  body: string;
}

function scalar(value: string): string | number {
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value);
  if (/^"(?:[^"\\]|\\["\\nrt])*"$/.test(value)) return JSON.parse(value) as string;
  if (/^'(?:[^']|'')*'$/.test(value)) return value.slice(1, -1).replaceAll("''", "'");
  if (
    !value ||
    /^[[\]{}&*!|>@`%#'"?,:-]/.test(value) ||
    /:\s|\s#|[[\]{}]/.test(value) ||
    /^(?:true|false|null|yes|no|on|off|~|[-+]?\.(?:inf|nan)|\d{4}-\d\d-\d\d)$/i.test(value)
  )
    throw new Error(`Unsupported front matter value: ${value}`);
  return value;
}

function valueOf(value: string): string | number | (string | number)[] {
  if (!value.startsWith('[')) return scalar(value);
  if (!value.endsWith(']')) throw new Error('Unclosed front matter list');
  const inner = value.slice(1, -1).trim();
  if (!inner) return [];
  const pattern = /\s*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,[\]'"\s][^,[\]'"]*)\s*(,|$)/y;
  const entries: (string | number)[] = [];
  while (pattern.lastIndex < inner.length) {
    const match = pattern.exec(inner);
    if (!match || (match[2] === ',' && pattern.lastIndex === inner.length)) {
      throw new Error(`Unsupported front matter list: ${value}`);
    }
    entries.push(scalar(match[1]!.trim()));
  }
  return entries;
}

export function parseModule(source: string, name = 'module'): DocModule {
  const lines = source
    .replace(/^\uFEFF/, '')
    .replaceAll('\r\n', '\n')
    .split('\n');
  const end = lines.indexOf('---', 1);
  if (lines[0] !== '---' || end < 0) throw new Error(`${name}: Missing front matter delimiters`);
  const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (let index = 1; index < end; index++) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    const match = /^([a-zA-Z][\w-]*):\s*(.+)$/.exec(line);
    if (!match) throw new Error(`${name}:${index + 1}: Unsupported front matter syntax`);
    const key = match[1]!;
    if (Object.hasOwn(fields, key)) throw new Error(`${name}:${index + 1}: Duplicate field ${key}`);
    try {
      fields[key] = valueOf(match[2]!.trim());
    } catch (error) {
      throw new Error(`${name}:${index + 1}: ${String(error)}`, { cause: error });
    }
  }
  const result = DocModuleMeta.strict().safeParse(fields);
  if (!result.success) throw new Error(`${name}: Invalid module metadata: ${result.error.message}`);
  return {
    meta: result.data,
    body: lines
      .slice(end + 1)
      .join('\n')
      .trim(),
  };
}

export function createModuleLoader(sources: Record<string, () => Promise<string>>) {
  const modules = new Map<string, Map<string, { path: string; area: string; load: () => Promise<string> }>>();
  const cache = new Map<string, Promise<DocModule>>();
  for (const [path, load] of Object.entries(sources)) {
    const match = /\/([^/]+)\/([^/]+)\/([^/]+)\.md$/.exec(path);
    if (!match) throw new Error(`Invalid module path: ${path}`);
    const area = match[1]!;
    const id = match[2]!;
    const locale = match[3]!;
    const languages = modules.get(id) ?? new Map();
    if (languages.has(locale)) throw new Error(`Duplicate module id and locale: ${id}/${locale}`);
    languages.set(locale, { path, area, load });
    modules.set(id, languages);
  }

  async function loadModule(id: string, locale: string): Promise<DocModule | null> {
    const languages = modules.get(id);
    if (!languages) return null;
    if (!languages.has('en-US')) throw new Error(`${id}: Missing en-US module`);
    const entry = languages.get(locale) ?? languages.get('en-US')!;
    let pending = cache.get(entry.path);
    if (!pending) {
      pending = recoverImport(entry.load)
        .then((source) => {
          const module = parseModule(source, entry.path);
          if (module.meta.id !== id || module.meta.area !== entry.area) {
            throw new Error(`${entry.path}: Module id or area does not match its path`);
          }
          // Key pages follow the catalog so an app added by a preset also appears in help.
          module.body = module.body.replace(
            '{{app-keys}}',
            APP_CATALOG.map((app) =>
              app.secret
                ? `${app.name} | [{{ui:sources.app.createKey}}](${app.keyUrl}) | {{ui:${app.secret.helpMessageId}}}`
                : `${app.name} | {{ui:sources.app.account}} | {{ui:sources.app.connectedHelp}}`,
            ).join('\n'),
          );
          return module;
        })
        .catch((error: unknown) => {
          cache.delete(entry.path);
          throw error;
        });
      cache.set(entry.path, pending);
    }
    return pending;
  }

  async function listModules(locale: string): Promise<DocModuleMeta[]> {
    const loaded = await Promise.all([...modules.keys()].map((id) => loadModule(id, locale)));
    return loaded
      .map((module) => module!.meta)
      .sort(
        (a, b) => a.area.localeCompare(b.area) || a.order - b.order || a.title.localeCompare(b.title, locale),
      );
  }
  return { listModules, loadModule };
}

const loader = createModuleLoader(
  import.meta.glob<string>('../../../../docs/modules/**/*.md', {
    query: '?raw',
    import: 'default',
  }),
);
export const { listModules, loadModule } = loader;
