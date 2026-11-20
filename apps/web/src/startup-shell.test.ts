// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { expect, it } from 'vitest';
import { shellCatalog } from '../build/shell-catalog';

it('inlines the unchanged recovery source as a classic head script', async () => {
  const scratch = resolve('.unit-logs');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'startup-shell-'));
  try {
    writeFileSync(
      join(root, 'index.html'),
      '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/entry.js"></script></body></html>',
    );
    writeFileSync(join(root, 'entry.js'), 'console.log("entry");');
    const result = await build({
      configFile: false,
      root,
      plugins: [shellCatalog()],
      build: { write: false },
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((result) =>
      'output' in result ? result.output : [],
    );
    const asset = outputs.find((output) => output.fileName === 'index.html');
    if (asset?.type !== 'asset') throw new Error('Missing built shell');
    const html = String(asset.source);
    const script = /<script id="rio-startup-recovery">([\s\S]*?)<\/script>/.exec(html);
    expect(script?.[1]).toBe(readFileSync(resolve('public/startup-recovery.js'), 'utf8'));
    // A plain head script runs while the document parses, so it is listening before any module
    // script can run or fail.  The exact opening tag above rules out type, async, and defer.
    expect(html.indexOf(script![0])).toBeGreaterThan(html.indexOf('<head>'));
    expect(html.indexOf(script![0])).toBeLessThan(html.indexOf('</head>'));
    expect(html).not.toContain('src="/startup-recovery.js"');
    expect(html).toContain('id="rio-startup-error" hidden');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
