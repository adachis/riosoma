import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANCHORS } from '../apps/web/src/demos/anchors.ts';

const root = fileURLToPath(new URL('../docs/modules/', import.meta.url));
const documented = new Set();
const missing = [];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await visit(path);
    else if (entry.name === 'en-US.md') {
      const source = await readFile(path, 'utf8');
      const front = source.split('---')[1] ?? '';
      const id = /^id: (.+)$/m.exec(front)?.[1];
      const anchors = /^anchors: \[(.*)\]$/m.exec(front)?.[1].split(',').map((value) => value.trim()).filter(Boolean) ?? [];
      for (const anchor of anchors) {
        if (!Object.hasOwn(ANCHORS, anchor)) missing.push({ module: id, anchor });
        documented.add(anchor);
      }
    }
  }
}

await visit(root);
console.log(JSON.stringify({
  registered: Object.keys(ANCHORS).length,
  documented: documented.size,
  missing,
  uncovered: Object.keys(ANCHORS).filter((id) => !documented.has(id)).sort(),
}, null, 2));
if (missing.length) process.exitCode = 1;
