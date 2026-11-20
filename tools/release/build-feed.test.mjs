import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { buildFeed, FEED_MAX_BYTES, readSignedFeed, releaseNotes, serializeFeed } from './build-feed.mjs';
import { root } from './version.mjs';

const manifest = {
  manifests: [
    { digest: `sha256:${'a'.repeat(64)}`, platform: { os: 'linux', architecture: 'amd64' } },
    { digest: `sha256:${'b'.repeat(64)}`, platform: { os: 'linux', architecture: 'arm64' } },
    { digest: `sha256:${'c'.repeat(64)}`, platform: { os: 'unknown', architecture: 'unknown' } },
  ],
};
const options = {
  version: '0.95.0',
  metadata: { minimumVersion: '0.95.0', security: false, date: '2026-10-03' },
  manifest,
  notes: 'Release notes',
};

test('the current changelog and feed metadata describe a valid release', async () => {
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  const metadata = JSON.parse(await readFile(join(root, 'tools/release/releases.json'), 'utf8'))[version];
  const changelog = await readFile(join(root, 'CHANGELOG.md'), 'utf8');
  assert.ok(changelog.split('\n').includes(`## [${version}] - ${metadata.date}`));
  assert.equal(
    buildFeed({ version, metadata, manifest, notes: releaseNotes(changelog, version) }).releases[0].version,
    version,
  );
});

test('feed history stays within the client download limit after serialization and signing', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyId = 'test'.padEnd(64, '-');
  const keys = [{ id: keyId, publicKey: publicKey.export({ format: 'jwk' }).x }];
  const envelope = (feed) => {
    const payload = `${JSON.stringify(feed, null, 2)}\n`;
    return `${JSON.stringify({ payload, signature: sign(null, Buffer.from(payload), privateKey).toString('base64'), keyId })}\n`;
  };
  const history = { ...buildFeed(options), releases: [] };
  const release = buildFeed(options).releases[0];
  for (let index = 0; ; index += 1) {
    history.releases.unshift({ ...release, version: `0.94.${index}`, notes: '😀"\n'.repeat(4000) });
    if (Buffer.byteLength(envelope(history)) > 2_000_000) {
      history.releases.shift();
      break;
    }
  }
  // Use the remaining space so a small release crosses the signed envelope limit.
  let low = 0;
  let high = 20_000;
  history.releases.push({ ...release, version: '0.93.0', notes: '' });
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    history.releases.at(-1).notes = '\n'.repeat(middle);
    if (Buffer.byteLength(envelope(history)) <= 1_999_950) low = middle;
    else high = middle - 1;
  }
  history.releases.at(-1).notes = '\n'.repeat(low);
  const previous = envelope(history);
  assert.ok(Buffer.byteLength(previous) <= 2_000_000);
  assert.ok(Buffer.byteLength(previous) > 1_999_900);
  const { verifyFeed } = await import(pathToFileURL(join(root, 'apps/server/dist/updates/feed.js')));
  assert.equal(verifyFeed(previous, keys, new Date()).status, 'ok');
  const client = await readFile(join(root, 'apps/server/src/updates/service.ts'), 'utf8');
  assert.equal(Number(/const FETCH_LIMIT = ([\d_]+);/.exec(client)[1].replaceAll('_', '')), FEED_MAX_BYTES);
  const updated = buildFeed({ ...options, previous, keys });
  const signed = envelope(updated);
  assert.ok(Buffer.byteLength(signed) <= 2_000_000, `Signed feed has ${Buffer.byteLength(signed)} bytes`);
  assert.equal(updated.releases[0].version, options.version);
  assert.equal(updated.releases[1].version, history.releases[0].version);
  assert.ok(updated.releases.length < history.releases.length + 1);
  const { checkFeed } = await import('./check-feed.mjs');
  assert.equal(checkFeed(signed, keys).releases.length, updated.releases.length);
  assert.equal(verifyFeed(signed, keys, new Date()).status, 'ok');
  const next = history.releases[updated.releases.length - 1];
  assert.ok(
    Buffer.byteLength(envelope({ ...updated, releases: [...updated.releases, next] })) > FEED_MAX_BYTES,
  );
  const directory = await mkdtemp(join(tmpdir(), 'riosoma-feed-size-'));
  try {
    const input = join(directory, 'payload.json');
    const output = join(directory, 'updates.json');
    await writeFile(input, serializeFeed(updated));
    const result = spawnSync(process.execPath, [join(root, 'tools/sign-feed.mjs'), input, output, keyId], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RIOSOMA_FEED_SIGNING_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const actual = await readFile(output, 'utf8');
    assert.equal(actual, signed);
    assert.equal(verifyFeed(actual, keys, new Date()).status, 'ok');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the upload check refuses oversized envelopes even when their signatures are valid', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keys = [{ id: 'test', publicKey: publicKey.export({ format: 'jwk' }).x }];
  const payload = JSON.stringify(buildFeed(options));
  const valid = JSON.stringify({
    keyId: 'test',
    payload,
    signature: sign(null, Buffer.from(payload), privateKey).toString('base64'),
  });
  const oversized = valid + ' '.repeat(2_000_001 - Buffer.byteLength(valid));
  assert.equal(readSignedFeed(oversized, keys).releases[0].version, options.version);
  const { checkFeed } = await import('./check-feed.mjs');
  const boundary = valid + ' '.repeat(2_000_000 - Buffer.byteLength(valid));
  assert.equal(checkFeed(boundary, keys).releases[0].version, options.version);
  assert.throws(() => checkFeed(oversized, keys), /download limit/);
});

test('feed entries name executable platform digests and this version only', () => {
  const notes = releaseNotes(
    '# Changelog\n\n## [0.95.0] - 2026-10-03\n\nNew release.\n\n## [0.94.0] - 2026-09-01\n\nOlder release.',
    '0.95.0',
  );
  assert.equal(notes, 'New release.');
  const feed = buildFeed({ ...options, notes });
  assert.deepEqual(feed.releases[0].images, {
    'linux/amd64': `sha256:${'a'.repeat(64)}`,
    'linux/arm64': `sha256:${'b'.repeat(64)}`,
  });
  assert.throws(() => buildFeed({ ...options, manifest: { manifests: [] } }), /digest missing/);
  assert.throws(() => releaseNotes('# Changelog', '0.95.0'), /missing/);
});

test('feed updates preserve verified history, replace a repeated version, and reject tampering', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keys = [{ id: 'test', publicKey: publicKey.export({ format: 'jwk' }).x }];
  const payload = JSON.stringify({
    schema: 1,
    releases: [
      { ...buildFeed(options).releases[0], notes: 'Old notes' },
      { ...buildFeed(options).releases[0], version: '0.94.0' },
    ],
  });
  const envelope = {
    keyId: 'test',
    payload,
    signature: sign(null, Buffer.from(payload), privateKey).toString('base64'),
  };
  const feed = buildFeed({ ...options, previous: JSON.stringify(envelope), keys });
  assert.equal(readSignedFeed(JSON.stringify(envelope), keys).releases.length, 2);
  assert.throws(() => readSignedFeed(JSON.stringify(envelope), []), /signature invalid/);
  assert.deepEqual(
    feed.releases.map((release) => release.version),
    ['0.95.0', '0.94.0'],
  );
  assert.equal(feed.releases[0].notes, 'Release notes');
  assert.throws(
    () =>
      buildFeed({
        ...options,
        previous: JSON.stringify({ ...envelope, payload: payload.replace('Old notes', 'Tampered') }),
        keys,
      }),
    /signature invalid/,
  );
});
