import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FEED_MAX_BYTES, readSignedFeed } from './build-feed.mjs';
import { root } from './version.mjs';

export function checkFeed(text, keys) {
  if (Buffer.byteLength(text) > FEED_MAX_BYTES)
    throw new Error('Signed feed exceeds the client download limit');
  return readSignedFeed(text, keys);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [input, ...extra] = process.argv.slice(2);
  if (!input || extra.length) throw new Error('Expected signed feed path');
  // Check size and the published trust list before uploading, so updates remain readable and trusted.
  checkFeed(
    await readFile(input, 'utf8'),
    JSON.parse(await readFile(join(root, 'deploy/updater/feed-keys.json'), 'utf8')),
  );
}
