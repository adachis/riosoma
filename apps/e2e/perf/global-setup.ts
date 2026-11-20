import { readFileSync, accessSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FullConfig } from '@playwright/test';
import setupStack from '../global-setup';
import { testWebDirectory } from '../web-build';

export default async function setup(config: FullConfig): Promise<() => Promise<void>> {
  accessSync(resolve(import.meta.dirname, '../../server/dist/main.js'));
  const stop = await setupStack(config);
  try {
    const directory = testWebDirectory();
    const html = readFileSync(`${directory}/index.html`, 'utf8');
    for (const match of html.matchAll(/(?:src|href)="(\/assets\/[^"?]+)"/g))
      accessSync(`${directory}${match[1]}`);
    return stop;
  } catch (error) {
    await stop();
    throw error;
  }
}
