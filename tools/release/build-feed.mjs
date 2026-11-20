import { createPublicKey, verify } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { releaseVersion, root } from './version.mjs';

export const FEED_MAX_BYTES = 2_000_000;

export function serializeFeed(feed) {
  return `${JSON.stringify(feed, null, 2)}\n`;
}

function envelopeBytes(feed) {
  // Reserve the longest allowed key ID and the fixed Ed25519 signature before signing.
  return Buffer.byteLength(
    `${JSON.stringify({
      payload: serializeFeed(feed),
      signature: 'x'.repeat(88),
      keyId: 'x'.repeat(64),
    })}\n`,
  );
}

export function releaseNotes(changelog, version) {
  if (!releaseVersion.test(version)) throw new Error('Invalid release version');
  const sections = changelog.split(/^## /m).slice(1);
  const section = sections.find((text) => text.startsWith(`[${version}] - `));
  if (!section) throw new Error(`Changelog entry missing: ${version}`);
  return section.slice(section.indexOf('\n') + 1).trim();
}

export function readSignedFeed(previous, keys) {
  const envelope = JSON.parse(previous);
  const key = keys.find((candidate) => candidate.id === envelope.keyId);
  if (
    !key ||
    typeof envelope.payload !== 'string' ||
    typeof envelope.signature !== 'string' ||
    !verify(
      null,
      Buffer.from(envelope.payload),
      createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.publicKey }, format: 'jwk' }),
      Buffer.from(envelope.signature, 'base64'),
    )
  )
    throw new Error('Feed signature invalid');
  const feed = JSON.parse(envelope.payload);
  if (
    feed.schema !== 1 ||
    !Array.isArray(feed.releases) ||
    (feed.repository && feed.repository !== 'ghcr.io/adachis/riosoma')
  )
    throw new Error('Invalid signed feed');
  return feed;
}

export function buildFeed({ version, metadata, manifest, notes, previous, keys = [], now = new Date() }) {
  if (
    !releaseVersion.test(version) ||
    !metadata ||
    !releaseVersion.test(metadata.minimumVersion) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(metadata.date) ||
    typeof metadata.security !== 'boolean' ||
    notes.length > 20_000
  )
    throw new Error('Invalid release metadata');
  const images = {};
  for (const platform of ['linux/amd64', 'linux/arm64']) {
    const [os, architecture] = platform.split('/');
    const image = manifest.manifests?.find(
      (item) => item.platform?.os === os && item.platform?.architecture === architecture,
    );
    if (!/^sha256:[a-f0-9]{64}$/.test(image?.digest ?? ''))
      throw new Error(`Image digest missing: ${platform}`);
    images[platform] = image.digest;
  }
  let releases = [];
  if (previous) {
    const feed = readSignedFeed(previous, keys);
    releases = feed.releases.filter((release) => release.version !== version);
  }
  const feed = {
    schema: 1,
    issuedAt: now.toISOString(),
    repository: 'ghcr.io/adachis/riosoma',
    releases: [{ version, ...metadata, notes, images }, ...releases].slice(0, 500),
  };
  if (envelopeBytes(feed) > FEED_MAX_BYTES) {
    const fits = (count) =>
      envelopeBytes({ ...feed, releases: feed.releases.slice(0, count) }) <= FEED_MAX_BYTES;
    if (!fits(1)) throw new Error('Current release exceeds the feed download limit');
    let low = 1;
    let high = feed.releases.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(middle)) low = middle;
      else high = middle - 1;
    }
    feed.releases = feed.releases.slice(0, low);
  }
  return feed;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [version, manifest, output, prior, ...extra] = process.argv.slice(2);
  if (!version || !manifest || !output || extra.length)
    throw new Error('Expected version, image manifest, output payload, and optional previous envelope');
  const metadata = JSON.parse(await readFile(join(root, 'tools/release/releases.json'), 'utf8'))[version];
  const changelog = await readFile(join(root, 'CHANGELOG.md'), 'utf8');
  if (!metadata || !changelog.split('\n').includes(`## [${version}] - ${metadata.date}`))
    throw new Error('Release date disagrees with changelog');
  const notes = releaseNotes(changelog, version);
  const feed = buildFeed({
    version,
    metadata,
    notes,
    manifest: JSON.parse(await readFile(manifest, 'utf8')),
    previous: prior ? await readFile(prior, 'utf8') : undefined,
    keys: JSON.parse(await readFile(join(root, 'deploy/updater/feed-keys.json'), 'utf8')),
  });
  await writeFile(output, serializeFeed(feed));
}
