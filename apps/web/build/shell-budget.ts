import { gzipSync } from 'node:zlib';

export const SHELL_BUDGET = 250_000;
export const PRECACHE_BUDGET = 60_000;

export const RECOVERY_ENTRIES = [
  'src/shell/ToastRegion.tsx',
  'src/shell/FeatureErrorDialog.tsx',
  '../../packages/ui/src/ButtonTooltip.tsx',
];

export interface ManifestEntry {
  file: string;
  imports?: string[];
  css?: string[];
}
export type Manifest = Record<string, ManifestEntry>;

/** Follow only static imports because each locale is a separate possible first screen. */
export function measureShell(manifest: Manifest, read: (file: string) => Buffer) {
  // The default header paints this mask before any feature opens.
  const common = new Set<string>(['index.html', 'brand/riosoma-wordmark-mask.svg']);
  const visited = new Set<string>();
  const visit = (key: string, files: Set<string>) => {
    if (visited.has(key)) return;
    const entry = manifest[key];
    if (!entry) throw new Error(`Missing manifest entry: ${key}`);
    visited.add(key);
    files.add(entry.file);
    for (const css of entry.css ?? []) files.add(css);
    for (const dependency of entry.imports ?? []) visit(dependency, files);
  };
  visit('index.html', common);
  if (manifest['src/screens/HomeScreen.tsx']) visit('src/screens/HomeScreen.tsx', common);
  const html = read('index.html').toString('utf8');
  for (const match of html.matchAll(/(?:src|href)=["']\/?([^"']+\.(?:js|css))["']/g)) common.add(match[1]!);
  const sizes = new Map<string, number>();
  const gzip = (file: string) => {
    let bytes = sizes.get(file);
    if (bytes === undefined) {
      bytes = gzipSync(read(file)).length;
      sizes.set(file, bytes);
    }
    return bytes;
  };
  const locales = Object.keys(manifest).filter((key) =>
    /^src\/locales\/[^/]+\/messages\.po\?shell$/.test(key),
  );
  if (!locales.length) throw new Error('No startup locale catalogs in the manifest');
  const measurements = locales
    .map((key) => {
      const files = new Set(common);
      visited.clear();
      visit(key, files);
      return {
        locale: key.split('/')[2]!,
        gzip: [...files].reduce((sum, file) => sum + gzip(file), 0),
        files: [...files].sort(),
      };
    })
    .sort((a, b) => b.gzip - a.gzip);
  const entryGzip = gzip(manifest['index.html']!.file);
  return {
    budget: SHELL_BUDGET,
    entryGzip,
    commonFiles: [...common].sort(),
    locales: measurements,
    largest: measurements[0]!,
    files: [...sizes].map(([file, gzip]) => ({ file, gzip })).sort((a, b) => b.gzip - a.gzip),
  };
}

/** Keep the worker's recovery graph and its transfer report on the same static imports. */
export function precacheFiles(manifest: Manifest, shell: ReturnType<typeof measureShell>): string[] {
  const files = new Set(shell.commonFiles);
  const visited = new Set<string>();
  const visit = (key: string) => {
    if (visited.has(key)) return;
    visited.add(key);
    const entry = manifest[key];
    if (!entry) throw new Error(`Missing manifest entry: ${key}`);
    files.add(entry.file);
    for (const css of entry.css ?? []) files.add(css);
    for (const dependency of entry.imports ?? []) visit(dependency);
  };
  for (const key of RECOVERY_ENTRIES) visit(key);
  return [...files].sort();
}

/** Recovery assets install in the background and do not count toward any page's shell. */
export function measurePrecache(
  manifest: Manifest,
  read: (file: string) => Buffer,
  shell: ReturnType<typeof measureShell>,
) {
  const common = new Set(shell.commonFiles);
  const files = precacheFiles(manifest, shell).filter((file) => !common.has(file));
  const assets = files.map((file) => ({ file, gzip: gzipSync(read(file)).length }));
  return {
    budget: PRECACHE_BUDGET,
    gzip: assets.reduce((sum, asset) => sum + asset.gzip, 0),
    files,
    assets: assets.sort((a, b) => b.gzip - a.gzip),
  };
}

function enforceBudget(message: string): void {
  if (process.env.RIOSOMA_ENFORCE_BUDGETS === '1') throw new Error(message);
  console.warn(`${message}.  Set RIOSOMA_ENFORCE_BUDGETS=1 to enforce the budget.`);
}

export function checkShell(
  report: ReturnType<typeof measureShell>,
  precache?: ReturnType<typeof measurePrecache>,
): void {
  console.info(
    `Web shell: ${report.largest.gzip} bytes gzipped (${report.largest.locale}), entry ${report.entryGzip}, budget ${SHELL_BUDGET}` +
      (precache ? `, recovery precache: ${precache.gzip} bytes gzipped, budget ${PRECACHE_BUDGET}` : ''),
  );
  if (report.entryGzip > SHELL_BUDGET || report.largest.gzip > SHELL_BUDGET) {
    enforceBudget(
      `Web shell exceeds ${SHELL_BUDGET} bytes gzipped: ${report.largest.gzip} (${report.largest.locale}), entry ${report.entryGzip}`,
    );
  }
  if (precache && precache.gzip > PRECACHE_BUDGET) {
    enforceBudget(`Web recovery precache exceeds ${PRECACHE_BUDGET} bytes gzipped: ${precache.gzip}`);
  }
}
