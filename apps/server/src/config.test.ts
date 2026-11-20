import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadConfig,
  parseEnvironment,
  configuredVersion,
  smokeProfile,
  readStored,
  storeDatabaseProfile,
  writeStored,
} from './config.js';
import { ConfigurationError, startupFailure } from './configuration-error.js';
import { profileFromUrl } from './database-url.js';

vi.mock('node:fs', async (original) => ({ ...(await original<typeof fs>()) }));

const dirs: string[] = [];
function environment(extra: NodeJS.ProcessEnv = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'rio-config-test-'));
  dirs.push(dir);
  return { RIOSOMA_CONFIG_DIR: dir, RIOSOMA_SECRET_KEY: randomBytes(32).toString('base64'), ...extra };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('configuration security', () => {
  it('accepts only operator-configured PDF service URLs without credentials, queries, or fragments', () => {
    expect(loadConfig(environment()).pdfRendererUrl).toBeUndefined();
    expect(
      loadConfig(environment({ RIOSOMA_PDF_RENDERER_URL: 'http://gotenberg:3000' })).pdfRendererUrl,
    ).toBe('http://gotenberg:3000');
    for (const value of [
      'file:///tmp/pdf',
      'http://user:secret@renderer:3000',
      'https://renderer/?token=secret',
      'https://renderer/#fragment',
    ])
      expect(() => loadConfig(environment({ RIOSOMA_PDF_RENDERER_URL: value }))).toThrow(
        'RIOSOMA_PDF_RENDERER_URL',
      );
  });
  it.each(['short', 'abcdefghijklmnop+', 'abcdefghijklmnop/', 'abcdefghijklmnop=', 'abcdefghijklmnop\n'])(
    'rejects browser-incompatible setup token %j',
    (token) => {
      expect(() => loadConfig(environment({ RIOSOMA_SETUP_TOKEN: token }))).toThrow(/RIOSOMA_SETUP_TOKEN/);
    },
  );
  it('accepts URL-safe setup tokens', () => {
    const token = 'abcdefghijklMN09-_'; // A made-up token for the format check. gitleaks:allow
    expect(loadConfig(environment({ RIOSOMA_SETUP_TOKEN: token })).setupTokenFromEnv).toBe(token);
  });
  it.each([
    [undefined, '10.1.2.3'],
    ['10.0.0.0/8', '198.51.100.2'],
    ['loopback', '10.1.2.3'],
    ['1', '198.51.100.2'],
  ])('limits forwarded addresses with trust setting %s', async (trust, expected) => {
    const config = loadConfig(environment(trust === undefined ? {} : { RIOSOMA_TRUST_PROXY: trust }));
    const app = Fastify({ trustProxy: config.trustProxy });
    app.get('/', (req) => ({ ip: req.ip }));
    try {
      const res = await app.inject({
        url: '/',
        remoteAddress: '10.1.2.3',
        headers: { 'x-forwarded-for': '198.51.100.2' },
      });
      expect(res.json().ip).toBe(expected);
    } finally {
      await app.close();
    }
  });
  it.each(['verify_full', '', 'secret-mode'])('rejects unknown TLS mode %j without echoing it', (mode) => {
    expect(() => profileFromUrl(`postgres://user:password@localhost/db?sslmode=${mode}`)).toThrow(
      /disable, prefer, require, verify-ca, verify-full/,
    );
  });
  it.each([
    { RIOSOMA_DATABASE_URL: 'postgres://user:synthetic-secret@localhost:invalid/db' },
    { RIOSOMA_DATABASE_PROFILE: '{"password":"synthetic-secret",broken}' },
    { RIOSOMA_DATABASE_PROFILE: JSON.stringify({ auth: { method: 'synthetic-secret' } }) },
  ])('sanitizes parser errors', (settings) => {
    let caught: unknown;
    try {
      loadConfig(environment(settings));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(inspect(caught)).not.toContain('synthetic-secret');
    expect((caught as Error).message).toMatch(/RIOSOMA_DATABASE_(URL|PROFILE)/);
  });
  it('allows 50 custom domains an organization unless told otherwise', () => {
    expect(loadConfig(environment()).customDomainLimit).toBe(50);
    expect(loadConfig(environment({ RIOSOMA_CUSTOM_DOMAIN_LIMIT: '5' })).customDomainLimit).toBe(5);
    for (const value of ['0', '-1', '2.5', 'many'])
      expect(() => loadConfig(environment({ RIOSOMA_CUSTOM_DOMAIN_LIMIT: value })), value).toThrow(
        /RIOSOMA_CUSTOM_DOMAIN_LIMIT/,
      );
  });
  it('accepts Cloud SQL IAM profiles from the environment and sealed storage', () => {
    const profile = {
      ...profileFromUrl('postgres://user:password@localhost/db'),
      auth: { method: 'gcp-cloudsql-iam' as const, instanceConnectionName: 'project:region:instance' },
    };
    const env = environment();
    expect(
      loadConfig({ ...env, RIOSOMA_DATABASE_PROFILE: JSON.stringify(profile) }).database?.auth.method,
    ).toBe('gcp-cloudsql-iam');
    storeDatabaseProfile(env.RIOSOMA_CONFIG_DIR, Buffer.from(env.RIOSOMA_SECRET_KEY, 'base64'), profile);
    expect(loadConfig(env).database?.auth.method).toBe('gcp-cloudsql-iam');
  });
});

describe('test feed keys', () => {
  const key = { id: 'test-2026', publicKey: 'A'.repeat(43) };
  const keysFile = (dir: string, text: string) => {
    const file = join(dir, 'feed-keys.json');
    fs.writeFileSync(file, text);
    return file;
  };

  it('keeps the release’s own keys unless a keys file is named', () => {
    expect(loadConfig(environment())).not.toHaveProperty('updateFeedKeys');
  });

  it('trusts the keys a keys file names, in place of the release’s', () => {
    const env = environment();
    const file = keysFile(env.RIOSOMA_CONFIG_DIR, JSON.stringify([key]));
    expect(loadConfig({ ...env, RIOSOMA_UPDATE_FEED_KEYS_FILE: file }).updateFeedKeys).toEqual([key]);
  });

  it.each([
    ['a missing file', null],
    ['text that is not JSON', 'not json'],
    ['an empty list', '[]'],
    ['a key that is not 32 bytes', JSON.stringify([{ ...key, publicKey: 'short' }])],
    ['a key with no ID', JSON.stringify([{ publicKey: key.publicKey }])],
  ])('refuses to start with %s', (_case, text) => {
    const env = environment();
    const file =
      text === null ? join(env.RIOSOMA_CONFIG_DIR, 'none.json') : keysFile(env.RIOSOMA_CONFIG_DIR, text);
    expect(() => loadConfig({ ...env, RIOSOMA_UPDATE_FEED_KEYS_FILE: file })).toThrow(
      /RIOSOMA_UPDATE_FEED_KEYS_FILE is invalid/,
    );
  });
});

describe('atomic configuration storage', () => {
  it('replaces the file with restricted permissions and preserves unrelated settings', () => {
    const env = environment();
    writeStored(env.RIOSOMA_CONFIG_DIR, { secretKey: 'test-key', setupToken: 'test-token' });
    const path = join(env.RIOSOMA_CONFIG_DIR, 'riosoma.config.json');
    fs.chmodSync(path, 0o644);
    const inode = fs.statSync(path).ino;
    writeStored(env.RIOSOMA_CONFIG_DIR, { setupToken: undefined, baseUrl: 'https://example.test' });
    expect(fs.statSync(path).ino).not.toBe(inode);
    expect(fs.statSync(path).mode & 0o777).toBe(0o600);
    expect(readStored(env.RIOSOMA_CONFIG_DIR)).toEqual({
      secretKey: 'test-key',
      baseUrl: 'https://example.test',
    });
  });
  it.each(['writeFileSync', 'fsyncSync', 'renameSync'] as const)(
    'preserves the original after %s fails',
    (operation) => {
      const env = environment();
      writeStored(env.RIOSOMA_CONFIG_DIR, { secretKey: 'test-key' });
      const before = fs.readFileSync(join(env.RIOSOMA_CONFIG_DIR, 'riosoma.config.json'), 'utf8');
      const failure = vi.spyOn(fs, operation).mockImplementationOnce(() => {
        throw new Error('disk failure');
      });
      expect(() => writeStored(env.RIOSOMA_CONFIG_DIR, { setupToken: 'new-token' })).toThrow('disk failure');
      failure.mockRestore();
      expect(fs.readFileSync(join(env.RIOSOMA_CONFIG_DIR, 'riosoma.config.json'), 'utf8')).toBe(before);
      expect(fs.readdirSync(env.RIOSOMA_CONFIG_DIR)).toEqual(['riosoma.config.json']);
    },
  );
});

it('validates the client query deadline and plaintext SMTP opt-out', () => {
  expect(loadConfig(environment()).dbQueryTimeoutMs).toBe(30000);
  expect(loadConfig(environment({ RIOSOMA_DB_QUERY_TIMEOUT_MS: '1250' })).dbQueryTimeoutMs).toBe(1250);
  for (const value of ['0', '-1', 'NaN', '1.5', '2147483648']) {
    expect(() => loadConfig(environment({ RIOSOMA_DB_QUERY_TIMEOUT_MS: value }))).toThrow(
      'RIOSOMA_DB_QUERY_TIMEOUT_MS',
    );
  }
  expect(loadConfig(environment()).smtpAllowPlaintext).toBe(false);
  expect(loadConfig(environment({ RIOSOMA_SMTP_ALLOW_PLAINTEXT: 'true' })).smtpAllowPlaintext).toBe(true);
  expect(() => loadConfig(environment({ RIOSOMA_SMTP_ALLOW_PLAINTEXT: 'yes' }))).toThrow(
    'RIOSOMA_SMTP_ALLOW_PLAINTEXT',
  );
});

describe('mail transports', () => {
  const sender = 'Riosoma <mail@example.test>';
  const graphSecret = ['stand-in-graph-', 'client-secret'].join('');
  const relaySecret = ['stand-in-relay-', 'signing-secret'].join('');
  const acsKey = Buffer.from('stand-in-acs-access-key', 'utf8').toString('base64');
  const working: Record<string, NodeJS.ProcessEnv> = {
    ses: { RIOSOMA_MAIL_TRANSPORT: 'ses', RIOSOMA_MAIL_FROM: sender, RIOSOMA_SES_REGION: 'eu-west-1' },
    acs: {
      RIOSOMA_MAIL_TRANSPORT: 'acs',
      RIOSOMA_MAIL_FROM: sender,
      RIOSOMA_ACS_ENDPOINT: 'https://resource.eu.communication.azure.com',
    },
    graph: {
      RIOSOMA_MAIL_TRANSPORT: 'graph',
      RIOSOMA_MAIL_FROM: sender,
      RIOSOMA_GRAPH_TENANT_ID: '11111111-2222-3333-4444-555555555555',
      RIOSOMA_GRAPH_CLIENT_ID: '66666666-7777-8888-9999-aaaaaaaaaaaa',
      RIOSOMA_GRAPH_CLIENT_SECRET: graphSecret,
      RIOSOMA_GRAPH_SENDER: 'mailbox@example.test',
    },
    gmail: {
      RIOSOMA_MAIL_TRANSPORT: 'gmail',
      RIOSOMA_MAIL_FROM: sender,
      RIOSOMA_GMAIL_SERVICE_ACCOUNT_JSON: '{"client_email":"mail@stand-in-project.iam.gserviceaccount.com"}',
      RIOSOMA_GMAIL_SENDER: 'mailbox@example.test',
    },
    relay: {
      RIOSOMA_MAIL_TRANSPORT: 'relay',
      RIOSOMA_MAIL_FROM: sender,
      RIOSOMA_MAIL_RELAY_URL: 'https://relay.example.test/outbound/mail',
      RIOSOMA_MAIL_RELAY_SECRET: relaySecret,
    },
  };

  it('sends through SMTP unless another transport is named', () => {
    expect(loadConfig(environment()).mail).toBeNull();
    expect(
      loadConfig(environment({ RIOSOMA_MAIL_TRANSPORT: 'smtp', RIOSOMA_MAIL_FROM: sender })).mail,
    ).toBeNull();
    expect(() => loadConfig(environment({ RIOSOMA_MAIL_TRANSPORT: 'sendgrid' }))).toThrow(
      'RIOSOMA_MAIL_TRANSPORT',
    );
  });

  it.each(Object.keys(working))('reads the %s transport’s own settings', (kind) => {
    const config = loadConfig(environment(working[kind]!));
    expect(config.mail).toMatchObject({ kind, from: sender });
  });

  it.each(Object.keys(working))('names each %s setting that is missing', (kind) => {
    for (const name of Object.keys(working[kind]!)) {
      if (name === 'RIOSOMA_MAIL_TRANSPORT') continue;
      const without: NodeJS.ProcessEnv = { ...working[kind]! };
      delete without[name];
      expect(() => loadConfig(environment(without)), name).toThrow(name);
    }
  });

  it('says which transport needs a missing setting, in plain words', () => {
    const { RIOSOMA_SES_REGION: _region, ...withoutRegion } = working.ses!;
    expect(() => loadConfig(environment(withoutRegion))).toThrow(
      'RIOSOMA_SES_REGION is required by the mail transport RIOSOMA_MAIL_TRANSPORT names (ses)',
    );
    const { RIOSOMA_MAIL_RELAY_SECRET: _secret, ...withoutSecret } = working.relay!;
    let caught: unknown;
    try {
      loadConfig(environment(withoutSecret));
    } catch (error) {
      caught = error;
    }
    expect(startupFailure(caught)).toEqual({
      code: 'configuration_invalid',
      messageKey: 'config.invalid',
      setting: 'RIOSOMA_MAIL_RELAY_SECRET',
      message: 'RIOSOMA_MAIL_RELAY_SECRET is required by the mail transport RIOSOMA_MAIL_TRANSPORT names',
      detail: 'relay',
    });
  });

  it('takes the Azure endpoint only as the resource’s own https address', () => {
    for (const endpoint of [
      'http://resource.eu.communication.azure.com',
      'https://resource.eu.communication.azure.com/emails',
    ]) {
      expect(
        () => loadConfig(environment({ ...working.acs, RIOSOMA_ACS_ENDPOINT: endpoint })),
        endpoint,
      ).toThrow('RIOSOMA_ACS_ENDPOINT is invalid (must be the https address of the resource with no path)');
    }
    for (const endpoint of ['http://resource.eu.communication.azure.com/', 'not an address']) {
      expect(
        () =>
          loadConfig(
            environment({
              RIOSOMA_MAIL_TRANSPORT: 'acs',
              RIOSOMA_MAIL_FROM: sender,
              RIOSOMA_ACS_CONNECTION_STRING: `endpoint=${endpoint};accesskey=${acsKey}`,
            }),
          ),
        endpoint,
      ).toThrow(
        'RIOSOMA_ACS_CONNECTION_STRING is invalid (must be the https address of the resource with no path)',
      );
    }
  });

  it('refuses an Azure access key that is not base64', () => {
    expect(() =>
      loadConfig(
        environment({
          RIOSOMA_MAIL_TRANSPORT: 'acs',
          RIOSOMA_MAIL_FROM: sender,
          RIOSOMA_ACS_CONNECTION_STRING:
            'endpoint=https://resource.eu.communication.azure.com/;accesskey=not base64!',
        }),
      ),
    ).toThrow('RIOSOMA_ACS_CONNECTION_STRING is invalid (holds an accesskey that is not base64)');
  });

  it('signs with the SES keys it was given, or with the instance’s role without them', () => {
    const keys = {
      RIOSOMA_SES_ACCESS_KEY_ID: ['AKIA', 'STANDINKEY'].join(''),
      RIOSOMA_SES_SECRET_ACCESS_KEY: ['stand-in-ses-', 'secret'].join(''),
    };
    expect(loadConfig(environment({ ...working.ses, ...keys })).mail).toMatchObject({
      kind: 'ses',
      region: 'eu-west-1',
      accessKeyId: keys.RIOSOMA_SES_ACCESS_KEY_ID,
      secretAccessKey: keys.RIOSOMA_SES_SECRET_ACCESS_KEY,
    });
    expect(loadConfig(environment(working.ses)).mail).not.toHaveProperty('accessKeyId');
    // With no keys of its own, a task's or instance's role signs, from the AWS variables captured
    // here, since the server reads its environment in the configuration module alone.
    expect(
      loadConfig(
        environment({
          ...working.ses,
          AWS_ACCESS_KEY_ID: 'role-access-key',
          AWS_SESSION_TOKEN: 'role-session-token',
          AWS_EC2_METADATA_DISABLED: 'true',
        }),
      ).mail,
    ).toMatchObject({
      roleEnvironment: {
        AWS_ACCESS_KEY_ID: 'role-access-key',
        AWS_SESSION_TOKEN: 'role-session-token',
        AWS_EC2_METADATA_DISABLED: 'true',
      },
    });
    expect(() =>
      loadConfig(environment({ ...working.ses, RIOSOMA_SES_ACCESS_KEY_ID: keys.RIOSOMA_SES_ACCESS_KEY_ID })),
    ).toThrow('RIOSOMA_SES_SECRET_ACCESS_KEY');
    expect(() =>
      loadConfig(
        environment({ ...working.ses, RIOSOMA_SES_SECRET_ACCESS_KEY: keys.RIOSOMA_SES_SECRET_ACCESS_KEY }),
      ),
    ).toThrow('RIOSOMA_SES_ACCESS_KEY_ID');
  });

  it('reads an Azure connection string, and lets an endpoint of its own win', () => {
    const connection = `accesskey=${acsKey};endpoint=https://resource.eu.communication.azure.com/`;
    expect(
      loadConfig(
        environment({
          RIOSOMA_MAIL_TRANSPORT: 'acs',
          RIOSOMA_MAIL_FROM: sender,
          RIOSOMA_ACS_CONNECTION_STRING: connection,
        }),
      ).mail,
    ).toEqual({
      kind: 'acs',
      from: sender,
      endpoint: 'https://resource.eu.communication.azure.com',
      accessKey: acsKey,
    });
    // No key means the server's own managed identity signs in.
    expect(loadConfig(environment(working.acs)).mail).not.toHaveProperty('accessKey');
    expect(
      loadConfig(
        environment({
          ...working.acs,
          RIOSOMA_ACS_CONNECTION_STRING: connection,
          RIOSOMA_ACS_ENDPOINT: 'https://other.eu.communication.azure.com',
        }),
      ).mail,
    ).toMatchObject({ endpoint: 'https://other.eu.communication.azure.com', accessKey: acsKey });
    expect(() =>
      loadConfig(
        environment({
          RIOSOMA_MAIL_TRANSPORT: 'acs',
          RIOSOMA_MAIL_FROM: sender,
          RIOSOMA_ACS_CONNECTION_STRING: 'endpoint=https://resource.eu.communication.azure.com',
        }),
      ),
    ).toThrow(/RIOSOMA_ACS_CONNECTION_STRING is invalid \(names no accesskey\)/);
  });

  it('needs a bare address for the mailbox a service sends as', () => {
    expect(() => loadConfig(environment({ ...working.graph, RIOSOMA_GRAPH_SENDER: sender }))).toThrow(
      'RIOSOMA_GRAPH_SENDER',
    );
    expect(() =>
      loadConfig(environment({ ...working.gmail, RIOSOMA_GMAIL_SENDER: 'mailbox@example.test\r\nBcc: x' })),
    ).toThrow('RIOSOMA_GMAIL_SENDER');
    expect(loadConfig(environment(working.gmail)).mail).toMatchObject({ sender: 'mailbox@example.test' });
  });

  it('takes a relay address over HTTPS, or over HTTP on this machine', () => {
    expect(loadConfig(environment(working.relay)).mail).toMatchObject({
      kind: 'relay',
      url: 'https://relay.example.test/outbound/mail',
    });
    for (const url of [
      'http://127.0.0.1:9000/outbound/mail',
      'http://localhost:9000/outbound/mail',
      'http://[::1]:9000/outbound/mail',
    ]) {
      expect(
        loadConfig(environment({ ...working.relay, RIOSOMA_MAIL_RELAY_URL: url })).mail,
        url,
      ).toMatchObject({ url });
    }
    // Plain HTTP away from this machine, credentials in the address, and anything that isn't an
    // HTTP address at all are refused, since the post carries a whole message.
    for (const url of [
      'http://relay.example.test/outbound/mail',
      'https://user:stand-in-password@relay.example.test/mail',
      'https://relay.example.test/mail?key=value',
      'smtp://relay.example.test:587',
      'not an address',
    ]) {
      expect(() => loadConfig(environment({ ...working.relay, RIOSOMA_MAIL_RELAY_URL: url })), url).toThrow(
        'RIOSOMA_MAIL_RELAY_URL',
      );
    }
  });

  it('never repeats a secret in a transport’s configuration error', () => {
    let caught: unknown;
    try {
      loadConfig(environment({ ...working.graph, RIOSOMA_GRAPH_SENDER: '' }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(inspect(caught)).not.toContain(graphSecret);
    expect((caught as Error).message).toMatch(/RIOSOMA_GRAPH_SENDER/);
  });
});

it('keeps the original configuration after a partial write', () => {
  const env = environment();
  writeStored(env.RIOSOMA_CONFIG_DIR, { secretKey: 'test-key' });
  const realWrite = fs.writeFileSync;
  vi.spyOn(fs, 'writeFileSync').mockImplementationOnce((file) => {
    realWrite(file, '{');
    throw new Error('disk full');
  });
  expect(() => writeStored(env.RIOSOMA_CONFIG_DIR, { setupToken: 'new-token' })).toThrow('disk full');
  expect(readStored(env.RIOSOMA_CONFIG_DIR)).toEqual({ secretKey: 'test-key' });
});

it('defaults to database file storage and requires a local storage directory', () => {
  expect(loadConfig(environment()).filesStorage).toBe('postgres');
  expect(() => loadConfig(environment({ RIOSOMA_FILES_STORAGE: 'unknown' }))).toThrow(
    'RIOSOMA_FILES_STORAGE',
  );
  expect(() => loadConfig(environment({ RIOSOMA_FILES_STORAGE: 'local' }))).toThrow('RIOSOMA_FILES_DIR');
  expect(() => loadConfig(environment({ RIOSOMA_FILES_STORAGE: 'local', RIOSOMA_FILES_DIR: ' ' }))).toThrow(
    'RIOSOMA_FILES_DIR',
  );
  const config = loadConfig(environment({ RIOSOMA_FILES_STORAGE: 'local', RIOSOMA_FILES_DIR: '/tmp/files' }));
  expect(config.filesStorage).toBe('local');
  expect(config.filesDir).toBe('/tmp/files');
});

const settingNames = Object.keys(parseEnvironment({})).filter((name) => name.startsWith('RIOSOMA_'));
const optionalNames = [
  ...fs
    .readFileSync(new URL('./config.ts', import.meta.url), 'utf8')
    .matchAll(/^ {2}(RIOSOMA_[A-Z0-9_]+): z/gm),
].map((match) => match[1]!);

it.each([...new Set([...settingNames, ...optionalNames])])('treats empty %s as unset', (name) => {
  for (const value of ['', ' ', '\t\r\n']) {
    expect(parseEnvironment({ [name]: value })).toEqual(parseEnvironment({}));
  }
});

it('uses stored credentials and addresses when environment values are blank', () => {
  const env = environment();
  const original = loadConfig(env);
  const profile = profileFromUrl('postgres://user:password@localhost/db');
  writeStored(env.RIOSOMA_CONFIG_DIR, { secretKey: env.RIOSOMA_SECRET_KEY, baseUrl: 'https://example.test' });
  storeDatabaseProfile(env.RIOSOMA_CONFIG_DIR, original.secretKey, profile);
  const config = loadConfig({
    ...env,
    RIOSOMA_SECRET_KEY: ' ',
    RIOSOMA_DATABASE_URL: '',
    RIOSOMA_DATABASE_PROFILE: '\t',
    RIOSOMA_BASE_URL: ' ',
    RIOSOMA_SMTP_URL: ' ',
  });
  expect(config.secretKey).toEqual(original.secretKey);
  expect(config.database).toEqual(profile);
  expect(config.baseUrl).toBe('https://example.test');
  expect(config.smtpUrl).toBeUndefined();
  expect(configuredVersion({ RIOSOMA_VERSION: ' ' })).toBe(
    JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
  );
  expect(() => smokeProfile({ RIOSOMA_SMOKE_PROFILE: ' ' })).toThrow('RIOSOMA_SMOKE_PROFILE');
});

it.each([
  ['RIOSOMA_AUTOMATIONS_SCRIPT_MEMORY_MB', 64, 16, 128],
  ['RIOSOMA_AUTOMATIONS_SCRIPT_TIMEOUT_MS', 5000, 10, 10000],
  ['RIOSOMA_AUTOMATIONS_SCRIPT_OUTPUT_KB', 256, 1, 1024],
  ['RIOSOMA_SCRIPTS_TIMEOUT_MS', 60000, 10, 600000],
] as const)('preserves numeric validation for %s', (name, fallback, minimum, maximum) => {
  for (const value of ['NaN', 'Infinity', '-1', '0', String(minimum - 0.5)]) {
    expect(parseEnvironment({ [name]: value })[name]).toBe(fallback);
  }
  expect(parseEnvironment({ [name]: String(minimum + 0.9) })[name]).toBe(minimum);
  expect(parseEnvironment({ [name]: String(maximum + 1) })[name]).toBe(maximum);
});

it('passes script limits and provider configuration to their consumers', () => {
  const config = loadConfig(
    environment({
      RIOSOMA_AUTOMATIONS_SCRIPT_MEMORY_MB: '32',
      RIOSOMA_AUTOMATIONS_SCRIPT_TIMEOUT_MS: '1500',
      RIOSOMA_AUTOMATIONS_SCRIPT_OUTPUT_KB: '16',
      RIOSOMA_ANTHROPIC_API_KEY: 'synthetic-key',
      RIOSOMA_ANTHROPIC_WORKSPACE_ID: 'workspace',
    }),
  );
  expect(config.scriptLimits).toEqual({
    memoryBytes: 32 * 1024 * 1024,
    timeoutMs: 1500,
    outputBytes: 16 * 1024,
    logBytes: 64 * 1024,
  });
  expect(Object.values(config.providerApiKeys ?? {})).toContain('synthetic-key');
  expect(config.providerWorkspaceId).toBe('workspace');
  expect(config.scriptPanelTimeoutMs).toBe(60000);
  expect(loadConfig(environment({ RIOSOMA_SCRIPTS_TIMEOUT_MS: '120000' })).scriptPanelTimeoutMs).toBe(120000);
});

it('reads the AI electricity zone, the world average by default, in any case, and only a known one', () => {
  expect(loadConfig(environment()).aiElectricityZone).toBe('WOR');
  expect(loadConfig(environment({ RIOSOMA_AI_ELECTRICITY_ZONE: ' fra ' })).aiElectricityZone).toBe('FRA');
  expect(loadConfig(environment({ RIOSOMA_AI_ELECTRICITY_ZONE: 'EEE' })).aiElectricityZone).toBe('EEE');
  expect(() => parseEnvironment({ RIOSOMA_AI_ELECTRICITY_ZONE: 'ATLANTIS' })).toThrow(ConfigurationError);
  expect(() => parseEnvironment({ RIOSOMA_AI_ELECTRICITY_ZONE: 'XXX' })).toThrow(ConfigurationError);
});

it.each([
  ['RIOSOMA_PORT', 'tcp://10.0.0.1:8080'],
  ['RIOSOMA_PORT', 'udp://10.0.0.1:8080'],
  ['RIOSOMA_PORT_8080_TCP', 'tcp://10.0.0.1:8080'],
  ['RIOSOMA_SERVICE_HOST', '10.0.0.1'],
  ['RIOSOMA_SERVICE_PORT', '8080'],
  ['RIOSOMA_SERVICE_PORT_HTTP', '8080'],
  ['RIOSOMA_DATABASE_SERVICE_PORT_SQL', '5432'],
])('ignores service link %s with one safe warning', (name, value) => {
  const warn = vi.fn();
  expect(loadConfig(environment({ [name]: value }), warn).port).toBe(8080);
  expect(warn).toHaveBeenCalledExactlyOnceWith({
    setting: name,
    messageKey: 'config.serviceLinkIgnored',
    message: expect.stringContaining('Kubernetes service-link'),
  });
  expect(JSON.stringify(warn.mock.calls)).not.toContain(value);
});

it.each([
  ['RIOSOMA_PORT', 'not-a-port'],
  ['RIOSOMA_PORT', 'http://10.0.0.1:8080'],
  ['RIOSOMA_SMTP_URL', 'tcp://10.0.0.1:8080'],
])('still rejects a real bad value for %s', (name, value) => {
  const warn = vi.fn();
  expect(() => loadConfig(environment({ [name]: value }), warn)).toThrow(name);
  expect(warn).not.toHaveBeenCalled();
});

it('validates the database wait budget', () => {
  expect(parseEnvironment({}).RIOSOMA_DATABASE_WAIT_SECONDS).toBe(120);
  expect(parseEnvironment({ RIOSOMA_DATABASE_WAIT_SECONDS: '0' }).RIOSOMA_DATABASE_WAIT_SECONDS).toBe(0);
  for (const value of ['-1', '1.5', 'NaN', 'Infinity', '2147484']) {
    expect(() => parseEnvironment({ RIOSOMA_DATABASE_WAIT_SECONDS: value })).toThrow(
      'RIOSOMA_DATABASE_WAIT_SECONDS',
    );
  }
});

it('loads only well-formed operator approvals without enabling scanning', () => {
  const address = `tcp://127.0.0.1:${3300 + Math.floor(Math.random() * 100)}`;
  const socket = 'unix:///run/clamav/clamd.sock';
  const config = loadConfig(environment({ RIOSOMA_CLAMAV_APPROVED_URLS: `${address}, ${socket}` }));
  expect(config.clamavApprovedUrls).toEqual([address, socket]);
  expect(config.clamavUrl).toBeUndefined();
  for (const value of [`${address},`, `${address},http://127.0.0.1:3310`, 'tcp://127.0.0.1:0']) {
    expect(() => loadConfig(environment({ RIOSOMA_CLAMAV_APPROVED_URLS: value }))).toThrow(
      'RIOSOMA_CLAMAV_APPROVED_URLS',
    );
  }
});
