import { gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { checkShell, measurePrecache, measureShell, type Manifest } from './shell-budget.ts';

/** Measures transferred files separately, as the browser requests them. */
export function bundleReport(): Plugin {
  let output: string;
  let written = false;
  return {
    name: 'web-bundle-report',
    apply: 'build',
    configResolved(config) {
      output = resolve(config.root, config.build.outDir);
    },
    writeBundle: {
      order: 'post',
      handler(_, bundle) {
        const chunks = Object.values(bundle).filter((file) => file.type === 'chunk');
        const entries = chunks.filter((chunk) => chunk.isEntry);
        const report = {
          entries: entries.map((chunk) => chunk.fileName),
          chunks: chunks.map((chunk) => ({
            file: chunk.fileName,
            facade: chunk.facadeModuleId?.replace(process.cwd(), ''),
            bytes: Buffer.byteLength(chunk.code),
            gzip: gzipSync(chunk.code).length,
            imports: chunk.imports,
            dynamicImports: chunk.dynamicImports,
            modules: Object.entries(chunk.modules)
              .map(([id, module]) => ({ id: id.replace(process.cwd(), ''), bytes: module.renderedLength }))
              .sort((a, b) => b.bytes - a.bytes),
          })),
          assets: Object.values(bundle)
            .filter((file) => file.type === 'asset' && file.fileName.endsWith('.css'))
            .map((file) => ({ file: file.fileName, gzip: gzipSync(file.source).length })),
        };
        written = true;
        // Written chunk names include changes made by the final output plugins.
        writeFileSync(resolve(output, 'bundle-report.json'), JSON.stringify(report, null, 2));
      },
    },
    closeBundle: {
      order: 'post',
      handler() {
        if (!written) return;
        const manifest = JSON.parse(readFileSync(resolve(output, '.vite/manifest.json'), 'utf8')) as Manifest;
        const shell = measureShell(manifest, (file) => readFileSync(resolve(output, file)));
        const precache = measurePrecache(manifest, (file) => readFileSync(resolve(output, file)), shell);
        const path = resolve(output, 'bundle-report.json');
        const report = JSON.parse(readFileSync(path, 'utf8'));
        // Final plugins can rewrite emitted code; transferred sizes come from the written files.
        for (const chunk of report.chunks) {
          const source = readFileSync(resolve(output, chunk.file));
          chunk.bytes = source.length;
          chunk.gzip = gzipSync(source).length;
        }
        writeFileSync(path, JSON.stringify({ ...report, shell, precache }, null, 2));
        checkShell(shell, precache);
      },
    },
  };
}
