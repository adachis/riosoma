import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyRequest } from 'fastify';
import { afterEach, expect, it } from 'vitest';
import type { AppContext } from './app.js';
import { relyingParty } from './auth/mfa/webauthn.js';
import { loadConfig, readStored } from './config.js';
import { validOrigin } from './realtime/routes.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const guide = readFileSync(join(root, 'CONTRIBUTING.md'), 'utf8');
const shellBlocks = [...guide.matchAll(/```sh\n([\s\S]*?)\n```/g)].map((match) => match[1]!);
const scratchDirectories: string[] = [];

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function documentedEnvironment() {
  const scratch = join(root, 'tools', '.unit-logs');
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, 'front matter '));
  scratchDirectories.push(directory);
  const checkout = join(directory, 'checkout');
  const home = join(directory, 'home');
  mkdirSync(checkout);
  mkdirSync(home);
  const commands = shellBlocks
    .find((block) => block.includes('export RIOSOMA_CONFIG_DIR='))!
    .split('\n')
    .filter((line) => !line.startsWith('node '))
    .join('\n');
  const output = execFileSync('sh', ['-c', `${commands}\nenv -0`], {
    cwd: checkout,
    env: { HOME: home, PATH: process.env.PATH },
    encoding: 'utf8',
  });
  const env = Object.fromEntries(
    output
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf('=');
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
  );
  env.RIOSOMA_DATABASE_URL = env.RIOSOMA_DATABASE_URL!.replace('PASSWORD', randomBytes(24).toString('hex'));
  return { checkout, env };
}

it('keeps the generated instance key outside the documented checkout', () => {
  const { checkout, env } = documentedEnvironment();
  const config = loadConfig(env);
  expect(relative(checkout, config.configDir).startsWith('..')).toBe(true);
  expect(Buffer.from(readStored(config.configDir).secretKey!, 'base64')).toHaveLength(32);
  expect(statSync(config.configDir).mode & 0o777).toBe(0o700);
});

it('accepts the documented web development origin for realtime and passkeys', () => {
  const { env } = documentedEnvironment();
  const serverCommands = shellBlocks.find((block) => block.includes('pnpm --filter @riosoma/server dev'));
  const baseUrl = serverCommands?.match(/^export RIOSOMA_BASE_URL=(\S+)$/m)?.[1];
  if (baseUrl) env.RIOSOMA_BASE_URL = baseUrl;
  const clientCommands = shellBlocks.find((block) => block.includes('pnpm --filter @riosoma/web dev'));
  const host = clientCommands?.match(/--host (\S+)/)?.[1] ?? 'localhost';
  const port = clientCommands?.match(/--port (\d+)/)?.[1] ?? '5173';
  const origin = `http://${host}:${port}`;
  const config = loadConfig(env);
  expect(validOrigin({ headers: { origin } } as FastifyRequest, config.baseUrl)).toBe(true);
  expect(relyingParty({ config } as AppContext)).toMatchObject({ id: host, origin });
  expect(clientCommands).toContain('--strictPort');
});

it('checks release links and production dependency licenses', () => {
  const output = execFileSync(
    process.execPath,
    ['--test', '--test-reporter=tap', 'tools/front_matter.test.mjs', 'tools/licenses.test.mjs'],
    { cwd: root, encoding: 'utf8', timeout: 30_000 },
  );
  expect(output).toContain('# fail 0');
});
