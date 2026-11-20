import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { mailerFrom } from '../mail/index.js';
import { RELAY_SIGNATURE_HEADER, RELAY_TIMESTAMP_HEADER } from '../mail/relay.js';
import { sampleMessage, startStandInService } from '../mail/test-helpers.js';

const root = new URL('../../../../', import.meta.url);
const compose = readFileSync(new URL('deploy/compose/compose.yaml', root), 'utf8');
const reference = readFileSync(new URL('docs/install/settings.md', root), 'utf8');
const service = /^ {2}riosoma:\n([\s\S]*?)(?=^ {2}\S)/m.exec(compose)?.[1] ?? '';
const environment = /^ {4}environment:\n([\s\S]*?)(?=^ {4}\S)/m.exec(service)?.[1] ?? '';
const forwarded = new Set(
  [...environment.matchAll(/^ {6}(RIOSOMA_[A-Z0-9_]+):(?:[ \t]*(.*))?$/gm)]
    .filter(([, name, value]) => !value || value.startsWith(`\${${name}`))
    .map(([, name]) => name!),
);

it('forwards documented runtime settings while retaining image and test configuration', () => {
  // These settings control the image layout, listening socket, or standalone test utilities.
  const fixed = new Set([
    'RIOSOMA_HOST',
    'RIOSOMA_PORT',
    'RIOSOMA_CONFIG_DIR',
    'RIOSOMA_VERSION',
    'NODE_ENV',
    'RIOSOMA_WEB_DIR',
    'RIOSOMA_THEMES_DIR',
    'RIOSOMA_SMOKE_PROFILE',
    'RIOSOMA_UPDATE_FEED_KEYS_FILE',
  ]);
  const settings = [...reference.matchAll(/^\| `(RIOSOMA_[A-Z0-9_]+|NODE_ENV)`/gm)]
    .map(([, name]) => name!)
    .filter((name) => !fixed.has(name));
  expect(settings.filter((name) => !forwarded.has(name))).toEqual([]);
});

it('selects the documented relay and signs a delivery with forwarded settings', async () => {
  const relay = await startStandInService();
  const configDir = mkdtempSync(join(tmpdir(), 'riosoma-compose-mail-'));
  try {
    const settings = {
      RIOSOMA_MAIL_TRANSPORT: 'relay',
      RIOSOMA_MAIL_FROM: sampleMessage().to,
      RIOSOMA_MAIL_RELAY_URL: new URL('/outbound/mail', relay.url).href,
      RIOSOMA_MAIL_RELAY_SECRET: randomBytes(32).toString('hex'),
    };
    const config = loadConfig({
      RIOSOMA_CONFIG_DIR: configDir,
      RIOSOMA_SECRET_KEY: randomBytes(32).toString('base64'),
      ...Object.fromEntries(Object.entries(settings).filter(([name]) => forwarded.has(name))),
    });
    const mailer = mailerFrom(config);
    expect(mailer).not.toBeNull();
    relay.answer({ status: 202 });
    await mailer!.send(sampleMessage());
    const request = relay.requests[0]!;
    expect(request.target).toBe('/outbound/mail');
    expect(JSON.parse(request.body)).toMatchObject({ from: settings.RIOSOMA_MAIL_FROM });
    expect(request.headers[RELAY_SIGNATURE_HEADER]).toBe(
      `v1=${createHmac('sha256', settings.RIOSOMA_MAIL_RELAY_SECRET)
        .update(`${request.headers[RELAY_TIMESTAMP_HEADER]}.${request.body}`)
        .digest('hex')}`,
    );
  } finally {
    await relay.close();
    rmSync(configDir, { recursive: true, force: true });
  }
});
