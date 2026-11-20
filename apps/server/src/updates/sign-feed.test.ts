import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { verifyFeed } from './feed.js';

describe('feed signing utility', () => {
  it.each(['pem', 'raw', 'der'] as const)('signs the exact payload from a runtime %s keypair', (format) => {
    const directory = mkdtempSync(join(tmpdir(), 'riosoma-sign-feed-'));
    try {
      const now = new Date();
      const pair = generateKeyPairSync('ed25519');
      const privateJwk = pair.privateKey.export({ format: 'jwk' });
      const material =
        format === 'pem'
          ? pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
          : format === 'raw'
            ? privateJwk.d!
            : pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
      const payload = JSON.stringify({ schema: 1, issuedAt: now.toISOString(), releases: [] }, null, 2);
      const input = join(directory, 'payload.json');
      const output = join(directory, 'envelope.json');
      writeFileSync(input, payload);
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('../../../../tools/sign-feed.mjs', import.meta.url)),
          input,
          output,
          'test-key',
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, RIOSOMA_FEED_SIGNING_KEY: material },
        },
      );
      expect(result.status).toBe(0);
      expect(result.stdout + result.stderr).toBe('');
      const envelope = readFileSync(output, 'utf8');
      expect(JSON.parse(envelope).payload).toBe(payload);
      expect(
        verifyFeed(
          envelope,
          [{ id: 'test-key', publicKey: pair.publicKey.export({ format: 'jwk' }).x! }],
          now,
        ),
      ).toMatchObject({ status: 'ok', keyId: 'test-key' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails without echoing invalid key material', () => {
    const secret = 'invalid-private-key-material';
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('../../../../tools/sign-feed.mjs', import.meta.url)),
        'input.json',
        'output.json',
        'test-key',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, RIOSOMA_FEED_SIGNING_KEY: secret },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toBe('');
  });
});
