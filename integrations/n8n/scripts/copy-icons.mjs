// n8n loads a node's icon from beside its compiled files, so the icons go into dist with them.
import { cpSync, globSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = join(import.meta.dirname, '..');
for (const file of globSync(['icons/*.svg', 'nodes/**/*.node.json'], { cwd: root })) {
  const target = join(root, 'dist', file);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(root, file), target);
}
